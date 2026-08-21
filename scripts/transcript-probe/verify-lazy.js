// Verify the lazy pager (src/sqlitePager.ts + src/transcript.ts) against the
// native library, on the REAL index.db. Reads pages via fs at offsets (like
// Blob.slice in the browser) so it never loads the multi-GB file into memory.
// Prints a no-content comparison: row count + checksum of (session_id, source,
// t_start, t_end, text) from both paths must match.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3-multiple-ciphers");

const dbPath = process.env.LUCI_DB || path.join(os.homedir(), ".luciMicrosoft/screen-memory/index.db");
const dbkeyPath = process.env.LUCI_DBKEY || path.join(os.homedir(), ".luciMicrosoft/screen-memory/.dbkey");
const password = process.env.LUCI_PW;

function resolveSecret() {
  const raw = fs.readFileSync(dbkeyPath);
  const mat = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const dc = crypto.createDecipheriv("aes-128-cbc", mat, Buffer.alloc(16, 0x20));
  const secret = Buffer.concat([dc.update(raw.subarray(3)), dc.final()]);
  return Buffer.from(secret.toString("utf8"), "utf8");
}

function checksum(list) {
  return crypto.createHash("sha256").update(JSON.stringify(list)).digest("hex");
}

async function main() {
  const secret = resolveSecret();

  // Native truth.
  const db = new Database(dbPath, { readonly: true });
  db.pragma("cipher='chacha20'");
  db.key(secret);
  const nativeRows = db
    .prepare("SELECT session_id, source, t_start, t_end, text FROM audio_segments")
    .all()
    .map((r) => [r.session_id, r.source, r.t_start, r.t_end, r.text]);
  db.close();
  nativeRows.sort((a, b) => a[2] - b[2] || String(a[4]).localeCompare(String(b[4])));

  // Lazy path: mimic Blob with an fs-backed slice reader.
  const stat = fs.statSync(dbPath);
  const fd = fs.openSync(dbPath, "r");
  const blob = {
    slice(start, end) {
      return {
        async arrayBuffer() {
          const len = Math.min(end, stat.size) - start;
          const buf = Buffer.alloc(Math.max(0, len));
          if (len > 0) fs.readSync(fd, buf, 0, len, start);
          return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        }
      };
    }
  };

  const bundle = process.env.TR_BUNDLE || "/tmp/tr.mjs";
  const { loadTranscript } = await import(bundle);
  const segments = await loadTranscript(blob, new Uint8Array(secret));
  fs.closeSync(fd);
  const lazyRows = segments.map((s) => [s.sessionId, s.source, s.absMs, s.endMs, s.text]);
  lazyRows.sort((a, b) => a[2] - b[2] || String(a[4]).localeCompare(String(b[4])));

  // Native includes empty-text rows the transcript path drops; filter to match.
  const nativeFiltered = nativeRows.filter((r) => String(r[4]).trim() && Number(r[2]) > 0);

  console.log("native rows (usable):", nativeFiltered.length);
  console.log("lazy rows           :", lazyRows.length);
  const nc = checksum(nativeFiltered);
  const lc = checksum(lazyRows);
  console.log("native checksum:", nc);
  console.log("lazy   checksum:", lc);
  console.log(nc === lc ? "✅ lazy pager matches native (no full decrypt needed)" : "❌ mismatch");
  process.exit(nc === lc ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
