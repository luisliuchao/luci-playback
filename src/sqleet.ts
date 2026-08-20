// Browser port of the sqleet / SQLite3MultipleCiphers "chacha20" read path,
// verified against the native library (kdf_iter=64007, page-1 skip=24).
// Read-only: decrypts pages with ChaCha20 and does not verify the Poly1305 tag
// (authenticity is not a concern for reading the user's own local database).
// WebCrypto has no ChaCha20, so the block function is implemented here; it is
// checked against an RFC 8439 vector before first use.

const CHACHA_ITER = 64007;
const PAGE1_SKIP = 24;
const RESERVED = 32;

function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function chacha20Block(key: Uint32Array, counter: number, nonce: Uint32Array, out: Uint8Array): void {
  const s = new Uint32Array(16);
  s[0] = 0x61707865;
  s[1] = 0x3320646e;
  s[2] = 0x79622d32;
  s[3] = 0x6b206574;
  s.set(key, 4);
  s[12] = counter >>> 0;
  s[13] = nonce[0];
  s[14] = nonce[1];
  s[15] = nonce[2];
  const x = Uint32Array.from(s);
  for (let i = 0; i < 10; i += 1) {
    qr(x, 0, 4, 8, 12);
    qr(x, 1, 5, 9, 13);
    qr(x, 2, 6, 10, 14);
    qr(x, 3, 7, 11, 15);
    qr(x, 0, 5, 10, 15);
    qr(x, 1, 6, 11, 12);
    qr(x, 2, 7, 8, 13);
    qr(x, 3, 4, 9, 14);
  }
  for (let i = 0; i < 16; i += 1) {
    const v = (x[i] + s[i]) >>> 0;
    out[i * 4] = v & 0xff;
    out[i * 4 + 1] = (v >>> 8) & 0xff;
    out[i * 4 + 2] = (v >>> 16) & 0xff;
    out[i * 4 + 3] = (v >>> 24) & 0xff;
  }
}

function qr(x: Uint32Array, a: number, b: number, c: number, d: number): void {
  x[a] = (x[a] + x[b]) >>> 0;
  x[d] = rotl(x[d] ^ x[a], 16);
  x[c] = (x[c] + x[d]) >>> 0;
  x[b] = rotl(x[b] ^ x[c], 12);
  x[a] = (x[a] + x[b]) >>> 0;
  x[d] = rotl(x[d] ^ x[a], 8);
  x[c] = (x[c] + x[d]) >>> 0;
  x[b] = rotl(x[b] ^ x[c], 7);
}

// XOR ChaCha20 keystream into data in place, starting at the given block counter.
function chacha20Xor(keyBytes: Uint8Array, nonce12: Uint8Array, counter: number, data: Uint8Array): void {
  const key = new Uint32Array(8);
  for (let i = 0; i < 8; i += 1) {
    key[i] =
      (nonceByte(keyBytes, i * 4) |
        (nonceByte(keyBytes, i * 4 + 1) << 8) |
        (nonceByte(keyBytes, i * 4 + 2) << 16) |
        (nonceByte(keyBytes, i * 4 + 3) << 24)) >>>
      0;
  }
  const nonce = new Uint32Array(3);
  for (let i = 0; i < 3; i += 1) {
    nonce[i] =
      (nonce12[i * 4] | (nonce12[i * 4 + 1] << 8) | (nonce12[i * 4 + 2] << 16) | (nonce12[i * 4 + 3] << 24)) >>> 0;
  }
  const block = new Uint8Array(64);
  let ctr = counter >>> 0;
  for (let offset = 0; offset < data.length; offset += 64) {
    chacha20Block(key, ctr, nonce, block);
    const end = Math.min(64, data.length - offset);
    for (let i = 0; i < end; i += 1) {
      data[offset + i] ^= block[i];
    }
    ctr = (ctr + 1) >>> 0;
  }
}

function nonceByte(arr: Uint8Array, i: number): number {
  return arr[i] ?? 0;
}

let selfTested = false;
export function selfTest(): void {
  if (selfTested) return;
  const key = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
  const nonce = hexToBytes("000000000000004a00000000");
  const data = new TextEncoder().encode(
    "Ladies and Gentlemen of the class of 99: If I could offer you only one tip for the future, sunscreen would be it."
  );
  chacha20Xor(key, nonce, 1, data);
  const got = bytesToHex(data.subarray(0, 16));
  if (got !== "6e2e359a2568f98041ba0728dd0d6981") {
    throw new Error("ChaCha20 self-test failed");
  }
  selfTested = true;
}

async function pbkdf2Sha256(secret: Uint8Array, salt: Uint8Array, iterations: number, length: number): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", copy(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: copy(salt), iterations }, base, length * 8);
  return new Uint8Array(bits);
}

function pageSizeOf(file: Uint8Array): number {
  const raw = (file[16] << 8) | file[17];
  return raw === 1 ? 65536 : raw;
}

// Decrypt a sqleet/SQLite3MultipleCiphers chacha20 database to plaintext bytes.
export async function decryptSqleet(file: Uint8Array, secret: Uint8Array): Promise<Uint8Array> {
  selfTest();
  const salt = file.subarray(0, 16);
  const masterKey = await pbkdf2Sha256(secret, salt, CHACHA_ITER, 32);
  const pageSize = pageSizeOf(file);
  const n = pageSize - RESERVED;
  const pageCount = Math.floor(file.length / pageSize);
  const out = file.slice(0);

  for (let page = 1; page <= pageCount; page += 1) {
    const base = (page - 1) * pageSize;
    const nonce = out.subarray(base + n, base + n + 16);
    const nonce12 = nonce.subarray(0, 12);
    const nonceCtr = (nonce[12] | (nonce[13] << 8) | (nonce[14] << 16) | (nonce[15] << 24)) >>> 0;
    const counter = (nonceCtr ^ page) >>> 0;
    const otk = new Uint8Array(64);
    chacha20Xor(masterKey, nonce12, counter, otk);
    const dataKey = otk.subarray(32, 64);
    const skip = page === 1 ? PAGE1_SKIP : 0;
    const region = out.subarray(base + skip, base + n);
    chacha20Xor(dataKey, nonce12, (counter + 1) >>> 0, region);
    if (page === 1) {
      out.set(new TextEncoder().encode("SQLite format 3\0"), base);
    }
  }
  return out;
}

function copy(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(data.byteLength));
  out.set(data);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
