# Luci transcript probe (run locally on your Mac)

One-time diagnostic to find which key form unlocks Luci's encrypted
`screen-memory/index.db`, so the player can add a transcript timeline.

**Privacy:** runs entirely on your machine, uploads nothing, and prints no
transcript text unless you pass `--sample`. By default it prints only the
schema (table/column names, row counts) and which key derivation worked.

## Run

```bash
cd scripts/transcript-probe
npm install        # fetches better-sqlite3-multiple-ciphers (prebuilt binary)
node probe.js \
  --db ~/.luciMicrosoft/screen-memory/index.db \
  --dbkey ~/.luciMicrosoft/screen-memory/.dbkey
```

If `.dbkey` is `v10`-sealed (the same sealed case the web player prompts for),
add your Luci Safe Storage password:

```bash
node probe.js --db ... --dbkey ... --password "$(security find-generic-password -s 'luci-electron Safe Storage' -w)"
```

Add `--sample` to preview up to 3 rows of the most transcript-like table
(local only — do this only if you're fine seeing your own transcript text).

## Step 2: verify the browser decryption path

After the probe unlocks the DB, confirm the pure-JS decryptor (the exact logic
the browser will use) reproduces the native read, on a **copy** of your DB:

```bash
node verify.js \
  --db ~/.luciMicrosoft/screen-memory/index.db \
  --dbkey ~/.luciMicrosoft/screen-memory/.dbkey \
  --password "$(security find-generic-password -s 'luci-electron Safe Storage' -w)"
```

It copies the database to a temp dir, folds in any WAL, reads it with the native
cipher as ground truth, then tries the pure-JS decryptor across candidate
`kdf_iter`/`skip` values and prints which one matches. Send back the final
`✅ ... kdf_iter=... skip=...` line (no transcript content).

## What to send back

Copy the `✅ UNLOCKED` block: the winning **candidate**, **cipher**, **method**,
and the **schema** dump. That's everything needed to implement the in-browser
decryption and the transcript UI. Nothing there contains transcript content.

If it prints `❌`, send the `file salt` and `.dbkey resolved as` lines instead.

## Notes

- Requires Node 20+ (you have 24). If `npm install` fails to find a prebuilt
  binary, install Xcode Command Line Tools (`xcode-select --install`) so it can
  compile, then retry.
- Read-only: the probe opens the database `readonly` and never writes to it.
