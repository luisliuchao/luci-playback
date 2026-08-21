#!/usr/bin/env node
/*
 * No-content sanity check of the transcript data path against the REAL index.db.
 * Mirrors src/transcript.ts exactly (t_start/t_end are absolute epoch ms; day is
 * bucketed from t_start local date). Prints per-day line counts, time ranges,
 * and mic/system split — NEVER any transcript text. Runs locally, no uploads.
 *
 * Usage:
 *   node transcript-stats.js --db <index.db> --dbkey <.dbkey> [--password <pw>]
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
  return v === undefined || v.startsWith("--") ? true : v;
}
function expand(p) {
  if (!p || p === true) return p;
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}
const dbPath = expand(arg("db", path.join(os.homedir(), ".luciMicrosoft/screen-memory/index.db")));
const dbkeyPath = expand(arg("dbkey", path.join(os.homedir(), ".luciMicrosoft/screen-memory/.dbkey")));
const password = arg("password");

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

function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}
function hms(ms) {
  const d = new Date(ms);
  return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function main() {
  const secret = resolveSecret();
  const db = new Database(dbPath, { readonly: true });
  db.pragma("cipher='chacha20'");
  db.key(secret);

  const total = db.prepare("SELECT count(*) n FROM audio_segments").get().n;
  const rows = db.prepare("SELECT source, t_start, t_end, length(text) AS len FROM audio_segments").all();
  db.close();

  const byDay = new Map();
  const bySource = new Map();
  let dropped = 0;
  let minMs = Infinity;
  let maxMs = -Infinity;
  for (const r of rows) {
    const absMs = Number(r.t_start);
    if (!Number.isFinite(absMs) || absMs <= 0 || !r.len) {
      dropped += 1;
      continue;
    }
    minMs = Math.min(minMs, absMs);
    maxMs = Math.max(maxMs, absMs);
    const day = dayKey(absMs);
    const d = byDay.get(day) ?? { count: 0, min: Infinity, max: -Infinity };
    d.count += 1;
    d.min = Math.min(d.min, absMs);
    d.max = Math.max(d.max, Number(r.t_end) || absMs);
    byDay.set(day, d);
    bySource.set(r.source || "(none)", (bySource.get(r.source || "(none)") ?? 0) + 1);
  }

  console.log(`Total segments: ${total}  (usable: ${total - dropped}, dropped: ${dropped})`);
  console.log(`Overall range: ${hms(minMs)}  ->  ${hms(maxMs)}`);
  console.log(`\nSources: ${[...bySource.entries()].map(([s, n]) => `${s}=${n}`).join("  ")}`);
  console.log(`\nPer day (${byDay.size} days):`);
  for (const day of [...byDay.keys()].sort()) {
    const d = byDay.get(day);
    const spanMin = ((d.max - d.min) / 60000).toFixed(0);
    console.log(`  ${day}: ${String(d.count).padStart(5)} lines   ${hms(d.min).slice(11)}–${hms(d.max).slice(11)}  (${spanMin} min span)`);
  }
  console.log("\nSanity: days should match calendar days you used Luci; spans should look like real usage windows.");
}

main();
