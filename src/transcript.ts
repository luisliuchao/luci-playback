// Reads Luci's encrypted screen-memory/index.db in the browser without loading
// or decrypting the whole file: only the pages of audio_segments are fetched
// (via Blob.slice) and decrypted on demand. Luci's index.db is multi-GB
// (OCR blocks + vector embeddings dominate), while the transcript is tiny, so
// full decryption is neither necessary nor feasible. All local, nothing uploaded.
//
// audio_segments.t_start/t_end are absolute Unix epoch milliseconds (same basis
// as capture timestamps), so they map straight onto the frame timeline.
import { decryptPage, deriveMasterKey, pageSizeOf, RESERVED_BYTES } from "./sqleet";
import { SqliteReader, type PageFetcher } from "./sqlitePager";

export type TranscriptSegment = {
  day: string;
  absMs: number;
  endMs: number;
  source: string;
  text: string;
  sessionId: number;
};

function localDayKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}

// Column names in declaration order from a CREATE TABLE statement.
function parseColumns(sql: string): string[] {
  const open = sql.indexOf("(");
  const close = sql.lastIndexOf(")");
  if (open === -1 || close <= open) {
    return [];
  }
  const body = sql.slice(open + 1, close);
  const columns: string[] = [];
  let depth = 0;
  let token = "";
  const flush = (): void => {
    const name = token.trim().split(/\s+/)[0]?.replace(/["'`[\]]/g, "");
    if (name) {
      columns.push(name.toLowerCase());
    }
    token = "";
  };
  for (const ch of body) {
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
    }
    if (ch === "," && depth === 0) {
      flush();
    } else {
      token += ch;
    }
  }
  flush();
  return columns;
}

export async function loadTranscript(blob: Blob, secret: Uint8Array): Promise<TranscriptSegment[]> {
  const head = new Uint8Array(await blob.slice(0, 100).arrayBuffer());
  const pageSize = pageSizeOf(head);
  const masterKey = await deriveMasterKey(head.subarray(0, 16), secret);

  const getPage: PageFetcher = async (pageNo) => {
    const start = (pageNo - 1) * pageSize;
    const enc = new Uint8Array(await blob.slice(start, start + pageSize).arrayBuffer());
    return decryptPage(masterKey, enc, pageNo);
  };

  const reader = new SqliteReader(getPage, pageSize, RESERVED_BYTES);
  const master = await reader.readMaster();
  const table = master.find((entry) => entry.type === "table" && entry.name === "audio_segments");
  if (!table || !table.rootPage) {
    return [];
  }

  const cols = parseColumns(table.sql);
  const col = (name: string, fallback: number): number => {
    const index = cols.indexOf(name);
    return index === -1 ? fallback : index;
  };
  const iSession = col("session_id", 1);
  const iSource = col("source", 2);
  const iStart = col("t_start", 3);
  const iEnd = col("t_end", 4);
  const iText = col("text", 5);

  const rows = await reader.readTable(table.rootPage);
  const segments: TranscriptSegment[] = [];
  for (const row of rows) {
    const absMs = Number(row.values[iStart] ?? 0);
    const endMs = Number(row.values[iEnd] ?? absMs);
    const text = String(row.values[iText] ?? "");
    if (!text.trim() || !Number.isFinite(absMs) || absMs <= 0) {
      continue;
    }
    segments.push({
      day: localDayKey(absMs),
      absMs,
      endMs: Math.max(endMs, absMs),
      source: String(row.values[iSource] ?? ""),
      text,
      sessionId: Number(row.values[iSession] ?? 0)
    });
  }
  segments.sort((a, b) => a.absMs - b.absMs);
  return segments;
}
