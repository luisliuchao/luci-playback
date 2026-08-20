#!/usr/bin/env node
/*
 * Verify the pure-JS sqleet decryptor against the native library, on a COPY of
 * your Luci database (your real file is never modified). Confirms the exact
 * (kdf_iter, page-1 skip) combination the browser must use, before any UI work.
 *
 * Usage (same args as probe.js):
 *   node verify.js --db ~/.luciMicrosoft/screen-memory/index.db \
 *                  --dbkey ~/.luciMicrosoft/screen-memory/.dbkey \
 *                  [--password 'Safe Storage password']
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Database = require("better-sqlite3-multiple-ciphers");
const { decryptSqleet } = require("./sqleet-decrypt");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}
function expand(p) {
  if (!p || p === true) return p;
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

const dbPath = expand(arg("db"));
const dbkeyPath = expand(arg("dbkey"));
const password = arg("password");
if (!dbPath || !dbkeyPath) {
  console.error("Usage: node verify.js --db <index.db> --dbkey <.dbkey> [--password <pw>]");
  process.exit(2);
}

function resolveSecret() {
  const raw = fs.readFileSync(dbkeyPath);
  const sealed = raw[0] === 0x76 && raw[1] === 0x31 && raw[2] === 0x30;
  if (sealed) {
    if (!password || password === true) throw new Error(".dbkey is v10-sealed; pass --password");
    const material = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
    const d = crypto.createDecipheriv("aes-128-cbc", material, Buffer.alloc(16, 0x20));
    const secret = Buffer.concat([d.update(raw.subarray(3)), d.final()]);
    return Buffer.from(secret.toString("utf8"), "utf8");
  }
  const text = raw.toString("utf8").trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, "hex");
  return raw;
}

const TABLES = ["audio_sessions", "audio_segments"];

function checksum(dbFile, isCipher, secret) {
  const db = new Database(dbFile, { readonly: true });
  try {
    if (isCipher) {
      db.pragma("cipher='chacha20'");
      db.key(secret);
    }
    const parts = [];
    for (const t of TABLES) {
      const rows = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
      parts.push(`${t}:${rows.length}`);
      const h = crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
      parts.push(h.slice(0, 16));
    }
    return parts.join("|");
  } finally {
    db.close();
  }
}

function main() {
  const secret = resolveSecret();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "luci-verify-"));
  const copy = path.join(tmp, "index.db");
  // Copy DB + any WAL/SHM so the checkpoint below folds recent writes into main.
  fs.copyFileSync(dbPath, copy);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, copy + suffix);
  }

  // Fold WAL into the main file on the COPY (read-write is fine here).
  {
    const db = new Database(copy);
    db.pragma("cipher='chacha20'");
    db.key(secret);
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
  }

  const truth = checksum(copy, true, secret);
  console.log("native (truth):", truth);

  const fileBytes = fs.readFileSync(copy);
  const iters = [64007, 12345, 256000, 4001];
  const skips = [24, 16, 0];
  let win = null;
  for (const iter of iters) {
    for (const skip of skips) {
      let plain;
      try {
        plain = decryptSqleet(fileBytes, secret, { iter, skip });
      } catch (e) {
        continue;
      }
      if (plain.subarray(0, 16).toString("latin1") !== "SQLite format 3\0") continue;
      const plainFile = path.join(tmp, `plain-${iter}-${skip}.db`);
      fs.writeFileSync(plainFile, plain);
      let got;
      try {
        got = checksum(plainFile, false, null);
      } catch (e) {
        console.log(`  iter=${iter} skip=${skip}: opened but query failed (${e.message})`);
        continue;
      }
      const ok = got === truth;
      console.log(`  iter=${iter} skip=${skip}: ${ok ? "✅ MATCH" : "header ok, data differs"} (${got})`);
      if (ok) {
        win = { iter, skip };
        break;
      }
    }
    if (win) break;
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  if (win) {
    console.log(`\n✅ Pure-JS decryption reproduces the native read.`);
    console.log(`   Use in browser: kdf_iter=${win.iter}, page1 skip=${win.skip}.`);
    console.log(`   Send me this line.`);
  } else {
    console.log("\n❌ No combination matched. Send the 'native (truth)' line and all attempt lines.");
    process.exit(1);
  }
}

main();
