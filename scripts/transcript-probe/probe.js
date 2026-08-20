#!/usr/bin/env node
/*
 * Luci transcript probe — LOCAL, one-time diagnostic.
 *
 * Finds which key form unlocks Luci's encrypted screen-memory/index.db and
 * prints its schema, so the browser player can gain a transcript timeline.
 *
 * It never uploads anything and, by default, prints NO transcript text —
 * only table/column names, row counts, and which key derivation worked.
 *
 * Usage:
 *   npm install
 *   node probe.js --db ~/.luciMicrosoft/screen-memory/index.db \
 *                 --dbkey ~/.luciMicrosoft/screen-memory/.dbkey \
 *                 [--password 'Safe Storage password']   # only if .dbkey is v10-sealed
 *
 * Add --sample to also print up to 3 rows of the most transcript-like table
 * (only do this if you're comfortable seeing your own transcript text locally).
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Database = require("better-sqlite3-multiple-ciphers");

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) return true; // flag
  return value;
}

function expand(p) {
  if (!p || p === true) return p;
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return p;
}

const dbPath = expand(arg("db"));
const dbkeyPath = expand(arg("dbkey"));
const password = arg("password");
const showSample = Boolean(arg("sample", false));

if (!dbPath || !dbkeyPath) {
  console.error("Usage: node probe.js --db <index.db> --dbkey <.dbkey> [--password <pw>] [--sample]");
  process.exit(2);
}

// ---- Mirror the browser's .dbkey handling (src/browserFolder.ts) ----

function isChromiumSealed(bytes) {
  return bytes[0] === 0x76 && bytes[1] === 0x31 && bytes[2] === 0x30; // "v10"
}

function unsealV10(sealed, pw) {
  if (!pw || pw === true) {
    throw new Error(".dbkey is v10-sealed; pass --password '<Safe Storage password>'");
  }
  const material = crypto.pbkdf2Sync(pw, "saltysalt", 1003, 16, "sha1");
  const iv = Buffer.alloc(16, 0x20);
  const decipher = crypto.createDecipheriv("aes-128-cbc", material, iv);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(sealed.subarray(3)), decipher.final()]);
}

function resolveSecret() {
  const raw = fs.readFileSync(dbkeyPath);
  if (isChromiumSealed(raw)) {
    const secret = unsealV10(raw, password);
    // Browser round-trips through utf-8; replicate.
    return { label: "v10-unsealed", bytes: Buffer.from(secret.toString("utf8"), "utf8") };
  }
  const text = raw.toString("utf8").trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) {
    return { label: "hex64", bytes: Buffer.from(text, "hex") };
  }
  return { label: "raw-bytes", bytes: raw };
}

function hkdf(ikm, info) {
  return Buffer.from(crypto.hkdfSync("sha256", ikm, Buffer.alloc(0), Buffer.from(info, "utf8"), 32));
}

// ---- Build candidate keys ----

function buildCandidates() {
  const secret = resolveSecret();
  const list = [];
  const push = (label, bytes) => list.push({ label, bytes });

  push(`secret:${secret.label}`, secret.bytes);
  // The screenshot key itself (in case the DB shares it).
  push("hkdf:luci-screenshot-v1", hkdf(secret.bytes, "luci-screenshot-v1"));
  for (const info of [
    "luci-db-v1",
    "luci-index-v1",
    "luci-sqlite-v1",
    "luci-database-v1",
    "luci-transcript-v1",
    "luci-audio-v1",
    "luci-memory-v1"
  ]) {
    push(`hkdf:${info}`, hkdf(secret.bytes, info));
  }
  // Also the secret interpreted as a hex string's bytes, if it looks hex.
  const asText = secret.bytes.toString("utf8");
  if (/^[0-9a-fA-F]{64}$/.test(asText.trim())) {
    push("secret-as-hex-decoded", Buffer.from(asText.trim(), "hex"));
  }
  return { secretLabel: secret.label, list };
}

// ---- Try to open the DB with a candidate, several application methods ----

function readSalt() {
  const fd = fs.openSync(dbPath, "r");
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  fs.closeSync(fd);
  return head;
}

function tryOpen(applyKey, cipher) {
  const db = new Database(dbPath, { readonly: true });
  try {
    db.pragma(`cipher='${cipher}'`);
    applyKey(db);
    // This SELECT only succeeds if decryption produced a valid SQLite file.
    const rows = db.prepare("SELECT count(*) AS n FROM sqlite_master").get();
    if (rows && typeof rows.n === "number") {
      return db;
    }
    db.close();
    return null;
  } catch {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    return null;
  }
}

function attemptsFor(cand) {
  const hex = cand.bytes.toString("hex");
  const attempts = [];
  // Binary key via sqlite3_key (KDF applied to raw bytes as passphrase).
  attempts.push({ how: `.key(buffer[${cand.bytes.length}])`, apply: (db) => db.key(cand.bytes) });
  // Hex passphrase (KDF applied to decoded bytes).
  attempts.push({ how: "PRAGMA hexkey", apply: (db) => db.pragma(`hexkey='${hex}'`) });
  // Raw sqleet key (NO KDF) — only meaningful at 32 bytes.
  if (cand.bytes.length === 32) {
    attempts.push({ how: "PRAGMA key raw:", apply: (db) => db.pragma(`key='raw:${hex}'`) });
  }
  // Text passphrase, if printable ASCII.
  const text = cand.bytes.toString("utf8");
  if (/^[\x20-\x7e]+$/.test(text)) {
    const escaped = text.replace(/'/g, "''");
    attempts.push({ how: "PRAGMA key (text)", apply: (db) => db.pragma(`key='${escaped}'`) });
  }
  return attempts;
}

// ---- Reporting ----

function dumpSchema(db) {
  const objects = db
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
    .all();
  console.log(`\n  Schema (${objects.length} tables/views):`);
  const transcriptish = [];
  for (const obj of objects) {
    let count = "?";
    try {
      count = db.prepare(`SELECT count(*) AS n FROM "${obj.name}"`).get().n;
    } catch {
      /* view or virtual */
    }
    let cols = [];
    try {
      cols = db.prepare(`PRAGMA table_info("${obj.name}")`).all().map((c) => `${c.name}:${c.type || "?"}`);
    } catch (e) {
      cols = [`(columns unavailable: ${e.message})`];
    }
    console.log(`\n  • ${obj.name} (${count} rows)`);
    console.log(`      columns: ${cols.join(", ")}`);
    const hay = `${obj.name} ${cols.join(" ")}`.toLowerCase();
    if (/(transcript|text|content|caption|speech|utterance|segment|start|end|ts|time|speaker)/.test(hay)) {
      transcriptish.push(obj.name);
    }
  }
  if (transcriptish.length > 0) {
    console.log(`\n  Likely transcript tables: ${transcriptish.join(", ")}`);
  }
  if (showSample && transcriptish.length > 0) {
    const t = transcriptish[0];
    console.log(`\n  Sample (up to 3 rows of ${t}) — LOCAL ONLY:`);
    try {
      for (const row of db.prepare(`SELECT * FROM "${t}" LIMIT 3`).all()) {
        console.log("   ", JSON.stringify(row).slice(0, 500));
      }
    } catch (e) {
      console.log("    (could not sample:", e.message, ")");
    }
  } else if (transcriptish.length > 0) {
    console.log("  (re-run with --sample to preview a few rows locally)");
  }
}

function main() {
  console.log("Luci transcript probe");
  console.log("  db:   ", dbPath);
  console.log("  dbkey:", dbkeyPath);
  const salt = readSalt();
  console.log("  file salt (first 16 bytes):", salt.toString("hex"));

  const { secretLabel, list } = buildCandidates();
  console.log(`  .dbkey resolved as: ${secretLabel}; trying ${list.length} key candidates\n`);

  const ciphers = ["chacha20", "sqlcipher", "aes256cbc"];
  for (const cand of list) {
    for (const cipher of ciphers) {
      for (const attempt of attemptsFor(cand)) {
        const db = tryOpen(attempt.apply, cipher);
        if (db) {
          console.log("✅ UNLOCKED");
          console.log(`   candidate: ${cand.label}`);
          console.log(`   cipher:    ${cipher}`);
          console.log(`   method:    ${attempt.how}`);
          dumpSchema(db);
          db.close();
          console.log("\nSend the block above (schema + which candidate/cipher/method) back to the agent.");
          return;
        }
      }
    }
  }

  console.log("❌ No candidate unlocked the database.");
  console.log("   Next: re-run with --sample removed and share the file-salt line +");
  console.log("   the '.dbkey resolved as' line. If .dbkey is v10-sealed, confirm --password is set.");
  process.exit(1);
}

main();
