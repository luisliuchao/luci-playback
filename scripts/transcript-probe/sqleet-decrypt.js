/*
 * Pure-JS decryptor for the sqleet / SQLite3MultipleCiphers "chacha20" scheme.
 * Read-only: decrypts pages with ChaCha20 and does NOT verify the Poly1305 tag
 * (authenticity isn't a concern for reading our own local database). The exact
 * same logic is ported to the browser once verify.js confirms it byte-for-byte.
 *
 * Page format (reserved = 32 bytes at end of each page):
 *   [ encrypted data | 16-byte nonce | 16-byte tag ]
 * Page 1's first 16 bytes are the KDF salt; SQLite3MultipleCiphers (non-legacy)
 * also keeps bytes 16..skip plaintext. Master key = PBKDF2-HMAC-SHA256(secret,
 * salt, iter, 32). Per page: counter = LE32(nonce[12..16]) ^ pageNo; a 64-byte
 * one-time block gives the data key (bytes 32..64); data is ChaCha20 with that
 * key, nonce[0..12], counter+1.
 */
const crypto = require("crypto");

function leU32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function chachaXor(key, nonce12, counter, data) {
  const iv = Buffer.concat([leU32(counter), nonce12]);
  const cipher = crypto.createCipheriv("chacha20", key, iv);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function selfTest() {
  // RFC 8439 §2.4.2 sanity check on the IV/counter layout.
  const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const nonce = Buffer.from("000000000000004a00000000", "hex");
  const out = chachaXor(
    key,
    nonce,
    1,
    Buffer.from("Ladies and Gentlemen of the class of 99: If I could offer you only one tip for the future, sunscreen would be it.")
  );
  if (out.subarray(0, 16).toString("hex") !== "6e2e359a2568f98041ba0728dd0d6981") {
    throw new Error("ChaCha20 self-test failed — IV/counter layout is wrong");
  }
}

function pageSizeOf(file) {
  const raw = (file[16] << 8) | file[17];
  return raw === 1 ? 65536 : raw;
}

/**
 * @param {Buffer} file       full encrypted database bytes
 * @param {Buffer} secret     passphrase bytes (the 44-byte unsealed .dbkey secret)
 * @param {{iter:number, skip:number}} opts
 * @returns {Buffer} plaintext SQLite database bytes
 */
function decryptSqleet(file, secret, opts) {
  selfTest();
  const { iter, skip } = opts;
  const salt = file.subarray(0, 16);
  const masterKey = crypto.pbkdf2Sync(secret, salt, iter, 32, "sha256");
  const pageSize = pageSizeOf(file);
  const reserved = 32;
  const n = pageSize - reserved;
  const pageCount = Math.floor(file.length / pageSize);
  const out = Buffer.from(file); // copy; reserved regions kept as-is

  for (let page = 1; page <= pageCount; page += 1) {
    const base = (page - 1) * pageSize;
    const pageBuf = file.subarray(base, base + pageSize);
    const nonce = pageBuf.subarray(n, n + 16);
    const nonce12 = nonce.subarray(0, 12);
    const counter = (nonce.readUInt32LE(12) ^ page) >>> 0;
    const otk = chachaXor(masterKey, nonce12, counter, Buffer.alloc(64));
    const dataKey = otk.subarray(32, 64);
    const pageSkip = page === 1 ? skip : 0;
    const encrypted = pageBuf.subarray(pageSkip, n);
    const decrypted = chachaXor(dataKey, nonce12, (counter + 1) >>> 0, encrypted);
    decrypted.copy(out, base + pageSkip);
    if (page === 1) {
      out.write("SQLite format 3\0", base, 16, "latin1");
    }
  }
  return out;
}

module.exports = { decryptSqleet, pageSizeOf, selfTest };
