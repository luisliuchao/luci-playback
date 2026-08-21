// Minimal, read-only SQLite b-tree reader that pulls rows from specific tables
// without materialising the whole database. Pages are fetched (and decrypted)
// on demand through a callback, so a multi-GB encrypted database costs only the
// few pages that belong to the small tables we actually read.
//
// Supports exactly what the transcript tables need: table b-trees (interior +
// leaf), the record format, and overflow chains. Index b-trees and writes are
// out of scope.

export type PageFetcher = (pageNo: number) => Promise<Uint8Array>;

export type MasterEntry = { type: string; name: string; rootPage: number; sql: string };

type SqliteValue = number | string | Uint8Array | null;

export class SqliteReader {
  private getPage: PageFetcher;
  private usable: number;

  constructor(getPage: PageFetcher, pageSize: number, reservedBytes: number) {
    this.getPage = getPage;
    this.usable = pageSize - reservedBytes;
  }

  async readMaster(): Promise<MasterEntry[]> {
    const rows = await this.readTable(1);
    const entries: MasterEntry[] = [];
    for (const row of rows) {
      // sqlite_master columns: type, name, tbl_name, rootpage, sql
      entries.push({
        type: String(row.values[0] ?? ""),
        name: String(row.values[1] ?? ""),
        rootPage: Number(row.values[3] ?? 0),
        sql: String(row.values[4] ?? "")
      });
    }
    return entries;
  }

  async readTable(rootPage: number): Promise<Array<{ rowid: number; values: SqliteValue[] }>> {
    const out: Array<{ rowid: number; values: SqliteValue[] }> = [];
    const stack = [rootPage];
    const seen = new Set<number>();
    while (stack.length > 0) {
      const pageNo = stack.pop() as number;
      if (seen.has(pageNo)) {
        continue;
      }
      seen.add(pageNo);
      const page = await this.getPage(pageNo);
      const headerOffset = pageNo === 1 ? 100 : 0;
      const type = page[headerOffset];
      const cellCount = (page[headerOffset + 3] << 8) | page[headerOffset + 4];
      if (type === 0x05) {
        // interior table page: collect child pages + rightmost pointer
        const rightChild = readU32(page, headerOffset + 8);
        const ptrBase = headerOffset + 12;
        for (let i = 0; i < cellCount; i += 1) {
          const cellPtr = (page[ptrBase + i * 2] << 8) | page[ptrBase + i * 2 + 1];
          stack.push(readU32(page, cellPtr));
        }
        stack.push(rightChild);
      } else if (type === 0x0d) {
        // leaf table page
        const ptrBase = headerOffset + 8;
        for (let i = 0; i < cellCount; i += 1) {
          const cellPtr = (page[ptrBase + i * 2] << 8) | page[ptrBase + i * 2 + 1];
          out.push(await this.readLeafCell(page, cellPtr));
        }
      }
      // other page types (index b-trees) are not expected for these tables
    }
    return out;
  }

  private async readLeafCell(page: Uint8Array, offset: number): Promise<{ rowid: number; values: SqliteValue[] }> {
    let pos = offset;
    const payloadLen = readVarint(page, pos);
    pos += payloadLen.size;
    const rowid = readVarint(page, pos);
    pos += rowid.size;

    const total = payloadLen.value;
    const maxLocal = this.usable - 35;
    let local = total;
    if (total > maxLocal) {
      const minLocal = Math.floor(((this.usable - 12) * 32) / 255) - 23;
      const surplus = minLocal + ((total - minLocal) % (this.usable - 4));
      local = surplus <= maxLocal ? surplus : minLocal;
    }

    const payload = new Uint8Array(total);
    payload.set(page.subarray(pos, pos + local), 0);
    if (total > local) {
      let next = readU32(page, pos + local);
      let written = local;
      while (next !== 0 && written < total) {
        const overflow = await this.getPage(next);
        next = readU32(overflow, 0);
        const chunk = Math.min(this.usable - 4, total - written);
        payload.set(overflow.subarray(4, 4 + chunk), written);
        written += chunk;
      }
    }

    return { rowid: rowid.value, values: parseRecord(payload, rowid.value) };
  }
}

// Parse a record payload into column values. An INTEGER PRIMARY KEY column is
// stored as NULL in the record; SQLite substitutes the rowid, so we do too.
function parseRecord(payload: Uint8Array, rowid: number): SqliteValue[] {
  const headerLen = readVarint(payload, 0);
  let hp = headerLen.size;
  const serials: number[] = [];
  while (hp < headerLen.value) {
    const s = readVarint(payload, hp);
    serials.push(s.value);
    hp += s.size;
  }
  let dp = headerLen.value;
  const values: SqliteValue[] = [];
  for (const serial of serials) {
    const { value, size } = readColumn(payload, dp, serial);
    values.push(value === undefined ? rowid : value);
    dp += size;
  }
  return values;
}

function readColumn(buf: Uint8Array, pos: number, serial: number): { value: SqliteValue | undefined; size: number } {
  switch (serial) {
    case 0:
      return { value: undefined, size: 0 }; // NULL -> rowid alias substituted by caller
    case 1:
      return { value: signed(buf, pos, 1), size: 1 };
    case 2:
      return { value: signed(buf, pos, 2), size: 2 };
    case 3:
      return { value: signed(buf, pos, 3), size: 3 };
    case 4:
      return { value: signed(buf, pos, 4), size: 4 };
    case 5:
      return { value: signed(buf, pos, 6), size: 6 };
    case 6:
      return { value: Number(new DataView(buf.buffer, buf.byteOffset + pos, 8).getBigInt64(0)), size: 8 };
    case 7:
      return { value: new DataView(buf.buffer, buf.byteOffset + pos, 8).getFloat64(0), size: 8 };
    case 8:
      return { value: 0, size: 0 };
    case 9:
      return { value: 1, size: 0 };
    default: {
      if (serial >= 12 && serial % 2 === 0) {
        const len = (serial - 12) / 2;
        return { value: buf.slice(pos, pos + len), size: len };
      }
      const len = (serial - 13) / 2;
      return { value: new TextDecoder().decode(buf.subarray(pos, pos + len)), size: len };
    }
  }
}

function signed(buf: Uint8Array, pos: number, bytes: number): number {
  let value = 0;
  for (let i = 0; i < bytes; i += 1) {
    value = value * 256 + buf[pos + i];
  }
  const max = 2 ** (bytes * 8);
  return value >= max / 2 ? value - max : value;
}

function readU32(buf: Uint8Array, pos: number): number {
  return ((buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]) >>> 0;
}

// SQLite varint: up to 9 bytes, big-endian, high bit is continuation.
function readVarint(buf: Uint8Array, pos: number): { value: number; size: number } {
  let value = 0;
  for (let i = 0; i < 8; i += 1) {
    const byte = buf[pos + i];
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      return { value, size: i + 1 };
    }
  }
  value = value * 256 + buf[pos + 8];
  return { value, size: 9 };
}
