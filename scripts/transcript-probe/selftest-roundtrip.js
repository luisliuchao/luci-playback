// Roundtrip: encrypt with the native library (chacha20, kdf_iter default 64007,
// non-legacy skip=24), then decrypt with the BROWSER sqleet.ts port and compare.
// Proves the in-browser decryptor before it ships. Run: node selftest-roundtrip.js
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3-multiple-ciphers");

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "luci-rt-"));
  const enc = path.join(tmp, "enc.db");
  const secret = Buffer.from("A".repeat(44), "utf8"); // 44-byte passphrase like Luci's

  const db = new Database(enc);
  db.pragma("cipher='chacha20'");
  db.key(secret);
  db.exec("CREATE TABLE audio_sessions (id INTEGER PRIMARY KEY, started_at INTEGER, ended_at INTEGER, model_id TEXT, language TEXT)");
  db.exec("CREATE TABLE audio_segments (id INTEGER PRIMARY KEY, session_id INTEGER, source TEXT, t_start INTEGER, t_end INTEGER, text TEXT)");
  const insS = db.prepare("INSERT INTO audio_sessions VALUES (?,?,?,?,?)");
  const insG = db.prepare("INSERT INTO audio_segments VALUES (?,?,?,?,?,?)");
  for (let i = 1; i <= 20; i += 1) insS.run(i, 1_700_000_000_000 + i * 60000, 1_700_000_000_000 + i * 120000, "whisper", "en");
  for (let i = 1; i <= 800; i += 1) {
    insG.run(i, (i % 20) + 1, i % 2 ? "mic" : "system", i * 1000, i * 1000 + 900, `segment text number ${i} lorem ipsum`);
  }
  db.close();

  const truthDb = new Database(enc, { readonly: true });
  truthDb.pragma("cipher='chacha20'");
  truthDb.key(secret);
  const truth = crypto
    .createHash("sha256")
    .update(JSON.stringify(truthDb.prepare("SELECT * FROM audio_segments ORDER BY id").all()))
    .digest("hex");
  truthDb.close();

  const fileBytes = new Uint8Array(fs.readFileSync(enc));
  const { decryptSqleet } = await import("../../src/sqleet.ts");
  const plain = await decryptSqleet(fileBytes, new Uint8Array(secret));
  if (Buffer.from(plain.subarray(0, 16)).toString("latin1") !== "SQLite format 3\0") {
    throw new Error("plaintext header wrong");
  }
  const plainPath = path.join(tmp, "plain.db");
  fs.writeFileSync(plainPath, Buffer.from(plain));
  const pdb = new Database(plainPath, { readonly: true });
  const got = crypto
    .createHash("sha256")
    .update(JSON.stringify(pdb.prepare("SELECT * FROM audio_segments ORDER BY id").all()))
    .digest("hex");
  const count = pdb.prepare("SELECT count(*) n FROM audio_segments").get().n;
  pdb.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log("native checksum:", truth);
  console.log("browser checksum:", got, `(${count} rows)`);
  console.log(got === truth ? "✅ browser sqleet.ts matches native" : "❌ mismatch");
  process.exit(got === truth ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
