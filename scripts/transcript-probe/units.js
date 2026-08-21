#!/usr/bin/env node
/*
 * Luci transcript TIME-UNITS probe — LOCAL, read-only, prints NO transcript text.
 *
 * Reuses the verified unseal path from probe.js (v10 .dbkey -> 44-byte key ->
 * chacha20) and prints only the numeric timestamp columns so we can pin down
 * whether audio_segments offsets are milliseconds or seconds.
 *
 * Usage:
 *   node units.js --password "$(security find-generic-password -s 'luci-electron Safe Storage' -w)"
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3-multiple-ciphers");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) return true;
  return v;
}

const dbPath = arg("db", path.join(os.homedir(), ".luciMicrosoft/screen-memory/index.db"));
const dbkeyPath = arg("dbkey", path.join(os.homedir(), ".luciMicrosoft/screen-memory/.dbkey"));
const password = arg("password");

function unsealV10(sealed, pw) {
  if (!pw || pw === true) throw new Error(".dbkey is v10-sealed; pass --password '<Safe Storage password>'");
  const material = crypto.pbkdf2Sync(pw, "saltysalt", 1003, 16, "sha1");
  const iv = Buffer.alloc(16, 0x20);
  const decipher = crypto.createDecipheriv("aes-128-cbc", material, iv);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(sealed.subarray(3)), decipher.final()]);
}

function resolveKey() {
  const raw = fs.readFileSync(dbkeyPath);
  if (raw[0] === 0x76 && raw[1] === 0x31 && raw[2] === 0x30) {
    const secret = unsealV10(raw, password);
    return Buffer.from(secret.toString("utf8"), "utf8");
  }
  return raw;
}

function fmt(ms) {
  if (!Number.isFinite(ms)) return String(ms);
  return new Date(ms).toISOString();
}

function main() {
  const db = new Database(dbPath, { readonly: true });
  db.pragma("cipher='chacha20'");
  db.key(resolveKey());

  const sessions = db
    .prepare("SELECT id, started_at, ended_at FROM audio_sessions ORDER BY id LIMIT 5")
    .all();
  console.log("audio_sessions (first 5): id, started_at, ended_at, span=ended-started");
  for (const s of sessions) {
    console.log(
      `  id=${s.id} started_at=${s.started_at} ended_at=${s.ended_at} span=${s.ended_at - s.started_at}`,
    );
  }

  const segMinMax = db
    .prepare(
      "SELECT min(t_start) AS min_start, max(t_start) AS max_start, min(t_end) AS min_end, max(t_end) AS max_end FROM audio_segments",
    )
    .get();
  console.log("\naudio_segments t_start/t_end range (all rows):");
  console.log(`  ${JSON.stringify(segMinMax)}`);

  // Per-session comparison: does max(t_end) match the session wall-clock span in ms or s?
  console.log("\nper-session offset-vs-span (to reveal unit):");
  const perSession = db
    .prepare(
      `SELECT s.id AS sid, s.started_at AS started_at, s.ended_at AS ended_at,
              min(g.t_start) AS min_off, max(g.t_end) AS max_off, count(*) AS n
       FROM audio_sessions s JOIN audio_segments g ON g.session_id = s.id
       GROUP BY s.id ORDER BY s.id LIMIT 8`,
    )
    .all();
  for (const r of perSession) {
    const spanMs = r.ended_at - r.started_at;
    console.log(
      `  sid=${r.sid} n=${r.n} span=${spanMs} maxOff=${r.max_off} minOff=${r.min_off}` +
        `  ratio_span/maxOff=${r.max_off ? (spanMs / r.max_off).toFixed(3) : "n/a"}`,
    );
  }

  // Absolute-time sanity: are session timestamps seconds or ms since epoch?
  const s0 = sessions[0];
  if (s0) {
    console.log("\nsession started_at interpreted as:");
    console.log(`  as-ms:  ${fmt(s0.started_at)}`);
    console.log(`  as-sec: ${fmt(s0.started_at * 1000)}`);
  }

  db.close();
  console.log("\nDone. Paste this block back (no transcript text included).");
}

main();
