import { audioBlobFromPlain } from "./audio";

const DAY_RE = /^\d{8}$/;
const MAGIC = new TextEncoder().encode("LUCISS01");
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "Library",
  "Applications",
  "System",
  "bin",
  "logs",
]);
const SKIP_FILES = /\.(json|sqlite|db|wal|log|txt|md|dylib|so|exe)$/i;
const IMAGE_FILES = /\.(jpe?g|png|webp|gif|enc|bin|luci)$/i;
const AUDIO_FILES = /\.(wav|mp3|m4a|aac|ogg|oga|opus|webm|flac|caf|pcm|raw|aiff|aif)$/i;
const AUDIO_DIR =
  /(?:^|\/)(?:audio|audios|audio-chunks|audio_chunks|recordings|mic|microphone|system-audio|system_audio|systemaudio|pcm|wavs?|voice|voices|sound|sounds|speech|meeting|meetings|media)(?:\/|$)/i;
// Luci's capture staging buffer: chunks land here briefly, get transcribed,
// then deleted — playing them yields files that vanish mid-session.
const STAGING_DIR = /(?:^|\/)(?:audio-tmp|audio_tmp|tmp|temp|staging)(?:\/|$)/i;
const HANDLE_DB = "luci-playback";
const HANDLE_STORE = "handles";
const SCREENSHOT_KEY = "screenshotKey";
const DB_SECRET_KEY = "dbSecret";

type SavedScreenshotKey = {
  key: CryptoKey;
  fingerprint: string;
};

export type LocalCapture = {
  day: string;
  timeMs: number;
  label: string;
  captureId?: number;
  relativePath: string;
  read: () => Promise<ArrayBuffer>;
};

export type LocalAudio = {
  day: string;
  timeMs: number;
  timed: boolean;
  relativePath: string;
  read: () => Promise<ArrayBuffer>;
};

export type FolderIndex = {
  name: string;
  days: string[];
  captures: LocalCapture[];
  audios: LocalAudio[];
  dbkey?: ArrayBuffer;
  indexDb?: () => Promise<ArrayBuffer>;
  encrypted: number;
  needPassword: boolean;
};

export type PickedFolder = {
  index: FolderIndex;
  handle?: FileSystemDirectoryHandle;
};

const LUCI_MARKERS = new Set([
  ".dbkey",
  "captures",
  "audio",
  "audios",
  "recordings",
  "media",
  "screen-memory",
  ".luci",
  ".luciMicrosoft",
]);
const NOT_LUCI_FOLDER = "That is not a Luci home folder.";
const MISSING_DBKEY =
  "That folder has encrypted frames but no key file. Choose the Luci home, not the captures folder.";
const NO_LUCI_FRAMES = "No Luci frames found in that folder.";

export function canPickDirectory(): boolean {
  return typeof window.showDirectoryPicker === "function" || "webkitdirectory" in document.createElement("input");
}

export async function pickDirectory(fileInput: HTMLInputElement): Promise<PickedFolder> {
  if (typeof window.showDirectoryPicker === "function") {
    const handle = await window.showDirectoryPicker({
      id: "luci-captures",
      mode: "read",
    });
    await assertLuciDirectory(handle);
    return { index: await indexDirectoryHandle(handle), handle };
  }
  const files = await pickWithInput(fileInput);
  assertLuciFileList(files);
  return { index: await indexFileList(files) };
}

export function luciFolderError(index: FolderIndex, encrypted: number): string | null {
  if (index.captures.length === 0 && !index.dbkey) {
    return NOT_LUCI_FOLDER;
  }
  if (index.captures.length === 0) {
    return NO_LUCI_FRAMES;
  }
  if (encrypted > 0 && !index.dbkey) {
    return MISSING_DBKEY;
  }
  return null;
}

export async function rememberDirectory(handle: FileSystemDirectoryHandle): Promise<void> {
  await saveDirectoryHandle(handle);
}

export async function forgetSavedDirectory(): Promise<void> {
  await clearDirectoryHandle();
  await forgetScreenshotKey();
}

export async function rememberScreenshotKey(dbkey: ArrayBuffer, key: CryptoKey): Promise<void> {
  try {
    const db = await openHandleDb();
    await idbPut(db, SCREENSHOT_KEY, { key, fingerprint: await dbkeyFingerprint(dbkey) });
  } catch {
    return;
  }
}

export async function loadScreenshotKey(dbkey: ArrayBuffer): Promise<CryptoKey | null> {
  const record = await idbGet<SavedScreenshotKey>(SCREENSHOT_KEY);
  if (!record || record.fingerprint !== (await dbkeyFingerprint(dbkey))) {
    return null;
  }
  return record.key;
}

export async function forgetScreenshotKey(): Promise<void> {
  try {
    const db = await openHandleDb();
    await idbDelete(db, SCREENSHOT_KEY);
    await idbDelete(db, DB_SECRET_KEY);
  } catch {
    return;
  }
}

// The transcript database (index.db) uses the same .dbkey. Resolve the raw
// passphrase the sqleet KDF expects, mirroring the frame-key unseal exactly:
// v10-sealed -> Chromium unseal -> the 44-byte secret; hex64 -> raw bytes.
export async function resolveDbSecret(dbkey: ArrayBuffer, password?: string): Promise<Uint8Array> {
  const sealed = new Uint8Array(dbkey);
  if (!isChromiumSealed(sealed)) {
    const text = new TextDecoder().decode(sealed).trim();
    if (/^[0-9a-fA-F]{64}$/.test(text)) {
      return copyBytes(hexToBytes(text));
    }
    return copyBytes(sealed);
  }
  if (!password) {
    throw new Error("Password required");
  }
  const material = await pbkdf2(password);
  const secret = await aesCbcDecrypt(copyBytes(material), new Uint8Array(16).fill(32), copyBytes(sealed.subarray(3)));
  return new TextEncoder().encode(new TextDecoder().decode(secret));
}

export async function rememberDbSecret(dbkey: ArrayBuffer, secret: Uint8Array): Promise<void> {
  try {
    const db = await openHandleDb();
    await idbPut(db, DB_SECRET_KEY, { secret: copyBytes(secret).buffer, fingerprint: await dbkeyFingerprint(dbkey) });
  } catch {
    return;
  }
}

export async function loadDbSecret(dbkey: ArrayBuffer): Promise<Uint8Array | null> {
  const record = await idbGet<{ secret: ArrayBuffer; fingerprint: string }>(DB_SECRET_KEY);
  if (!record || record.fingerprint !== (await dbkeyFingerprint(dbkey))) {
    return null;
  }
  return new Uint8Array(record.secret);
}

export async function keyUnlocksCaptures(key: CryptoKey, captures: LocalCapture[]): Promise<boolean> {
  for (const capture of captures.slice(0, 8)) {
    const bytes = await capture.read();
    if (!startsWith(new Uint8Array(bytes), MAGIC)) {
      continue;
    }
    try {
      await decodeCapture(bytes, key);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export async function restoreDirectory(): Promise<FolderIndex | null> {
  const handle = await loadDirectoryHandle();
  if (!handle) {
    return null;
  }
  const permission = await handle.queryPermission({ mode: "read" });
  if (permission !== "granted") {
    return null;
  }
  return indexDirectoryHandle(handle);
}

export async function requestSavedDirectory(): Promise<FolderIndex | null> {
  const handle = await loadDirectoryHandle();
  if (!handle) {
    return null;
  }
  const permission = await handle.requestPermission({ mode: "read" });
  if (permission !== "granted") {
    return null;
  }
  return indexDirectoryHandle(handle);
}

async function assertLuciDirectory(root: FileSystemDirectoryHandle): Promise<void> {
  if (isLuciMarker(root.name)) {
    return;
  }
  for await (const [name] of root.entries()) {
    if (isLuciMarker(name)) {
      return;
    }
  }
  throw new Error(NOT_LUCI_FOLDER);
}

function assertLuciFileList(files: File[]): void {
  const found = files.some((file) => {
    const parts = (file.webkitRelativePath || file.name).split("/");
    return parts.some((part) => isLuciMarker(part));
  });
  if (!found) {
    throw new Error(NOT_LUCI_FOLDER);
  }
}

function isLuciMarker(name: string): boolean {
  return LUCI_MARKERS.has(name) || DAY_RE.test(name);
}

function pickWithInput(input: HTMLInputElement): Promise<File[]> {
  return new Promise((resolve, reject) => {
    const onChange = () => {
      input.removeEventListener("change", onChange);
      const files = [...(input.files ?? [])];
      input.value = "";
      if (files.length === 0) {
        reject(new Error("No folder selected"));
        return;
      }
      resolve(files);
    };
    input.addEventListener("change", onChange, { once: true });
    input.click();
  });
}

async function indexDirectoryHandle(root: FileSystemDirectoryHandle): Promise<FolderIndex> {
  const files: Array<{ relativePath: string; lastModified: number; read: () => Promise<ArrayBuffer> }> = [];
  let dbkey: ArrayBuffer | undefined;
  let indexDb: (() => Promise<ArrayBuffer>) | undefined;
  const walk = async (dir: FileSystemDirectoryHandle, prefix: string, depth: number): Promise<void> => {
    if (depth > 8) {
      return;
    }
    for await (const [name, entry] of dir.entries()) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (entry.kind === "directory") {
        if (SKIP_DIRS.has(name) || (name.startsWith(".") && name !== ".luci" && name !== ".luciMicrosoft")) {
          continue;
        }
        await walk(entry, relativePath, depth + 1);
        continue;
      }
      if (name === ".dbkey") {
        dbkey = await (await entry.getFile()).arrayBuffer();
        continue;
      }
      if (name === "index.db" && entry.kind === "file") {
        indexDb = () => entry.getFile().then((next) => next.arrayBuffer());
        continue;
      }
      if (!isCaptureName(name, relativePath) && !isAudioName(name, relativePath)) {
        continue;
      }
      const file = await entry.getFile();
      files.push({
        relativePath,
        lastModified: file.lastModified,
        read: () => entry.getFile().then((next) => next.arrayBuffer()),
      });
    }
  };
  await walk(root, "", 0);
  return buildIndex(root.name, files, dbkey, indexDb);
}

async function indexFileList(list: File[]): Promise<FolderIndex> {
  let dbkey: ArrayBuffer | undefined;
  let indexDb: (() => Promise<ArrayBuffer>) | undefined;
  const files: Array<{ relativePath: string; lastModified: number; read: () => Promise<ArrayBuffer> }> = [];
  for (const file of list) {
    const relativePath = file.webkitRelativePath || file.name;
    const name = relativePath.split("/").pop() ?? file.name;
    if (name === ".dbkey") {
      dbkey = await file.arrayBuffer();
      continue;
    }
    if (name === "index.db") {
      indexDb = () => file.arrayBuffer();
      continue;
    }
    if (!isCaptureName(name, relativePath) && !isAudioName(name, relativePath)) {
      continue;
    }
    files.push({
      relativePath,
      lastModified: file.lastModified,
      read: () => file.arrayBuffer(),
    });
  }
  const name = list[0]?.webkitRelativePath.split("/")[0] ?? "folder";
  return buildIndex(name, files, dbkey, indexDb);
}

function isCaptureName(name: string, relativePath = name): boolean {
  if (name.startsWith(".") || SKIP_FILES.test(name) || isAudioName(name, relativePath)) {
    return false;
  }
  return IMAGE_FILES.test(name) || !name.includes(".");
}

function isAudioName(name: string, relativePath = name): boolean {
  if (name.startsWith(".") || SKIP_FILES.test(name)) {
    return false;
  }
  if (AUDIO_FILES.test(name)) {
    return true;
  }
  return AUDIO_DIR.test(relativePath) && !IMAGE_FILES.test(name);
}

function buildIndex(
  name: string,
  files: Array<{ relativePath: string; lastModified: number; read: () => Promise<ArrayBuffer> }>,
  dbkey?: ArrayBuffer,
  indexDb?: () => Promise<ArrayBuffer>,
): FolderIndex {
  const paths = files.map((file) => file.relativePath);
  const capturesRoot = detectCapturesPrefix(paths);
  const audioRoot = detectAudioPrefix(paths);
  const captures: LocalCapture[] = [];
  const audios: LocalAudio[] = [];
  for (const file of files) {
    if (STAGING_DIR.test(file.relativePath)) {
      continue;
    }
    const base = file.relativePath.split("/").pop() ?? file.relativePath;
    if (isAudioName(base, file.relativePath)) {
      const relative = stripPrefix(file.relativePath, audioRoot || capturesRoot);
      const day = dayFromPath(relative, file.lastModified);
      if (!day) {
        continue;
      }
      const stamp = guessAudioTime(relative, file.lastModified, day);
      audios.push({
        day,
        timeMs: stamp.timeMs,
        timed: stamp.timed,
        relativePath: file.relativePath,
        read: file.read,
      });
      continue;
    }
    const relative = stripPrefix(file.relativePath, capturesRoot);
    const day = dayFromPath(relative, file.lastModified);
    if (!day) {
      continue;
    }
    const timeMs = guessTime(relative, file.lastModified);
    captures.push({
      day,
      timeMs,
      label: formatLabel(timeMs),
      captureId: idFromName(relative),
      relativePath: file.relativePath,
      read: file.read,
    });
  }
  captures.sort((a, b) => a.timeMs - b.timeMs || a.relativePath.localeCompare(b.relativePath));
  audios.sort((a, b) => a.timeMs - b.timeMs || a.relativePath.localeCompare(b.relativePath));
  const days = [...new Set([...captures.map((capture) => capture.day), ...audios.map((clip) => clip.day)])].sort();
  const needPassword = Boolean(dbkey && isChromiumSealed(dbkey));
  return {
    name,
    days,
    captures,
    audios,
    dbkey,
    indexDb,
    encrypted: 0,
    needPassword,
  };
}

function detectAudioPrefix(paths: string[]): string {
  const hits = paths
    .map((path) => {
      const match = path.match(
        /^(.*(?:^|\/)(?:screen-memory\/)?(?:audio|audios|audio-chunks|audio_chunks|recordings|mic|microphone|system-audio|system_audio|systemaudio|pcm|wavs?|voice|voices|sound|sounds|speech|meeting|meetings|media))\//,
      );
      return match?.[1] ?? "";
    })
    .filter(Boolean);
  return hits.length > 0 ? mostCommon(hits) : "";
}

function detectCapturesPrefix(paths: string[]): string {
  const hits = paths
    .map((path) => {
      const match = path.match(/^(.*(?:^|\/)(?:screen-memory\/)?captures)\//);
      return match?.[1] ?? "";
    })
    .filter(Boolean);
  if (hits.length > 0) {
    return mostCommon(hits);
  }
  const days = paths
    .map((path) => {
      const match = path.match(/^(.*(?:^|\/)\d{8})\//);
      return match?.[1]?.replace(/\/\d{8}$/, "") ?? "";
    })
    .filter((value) => value.length > 0);
  return days.length > 0 ? mostCommon(days) : "";
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

function stripPrefix(path: string, prefix: string): string {
  if (prefix && path.startsWith(`${prefix}/`)) {
    return path.slice(prefix.length + 1);
  }
  return path;
}

function dayFromPath(relative: string, lastModified: number): string | null {
  const fromPath = relative.split("/").find((part) => DAY_RE.test(part));
  if (fromPath) {
    return fromPath;
  }
  const fromName = relative.match(/(?:^|\/|_)(\d{8})(?:_|-|\.|$)/);
  if (fromName) {
    return fromName[1];
  }
  if (lastModified > 0) {
    const date = new Date(lastModified);
    return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  }
  return null;
}

function guessAudioTime(relative: string, lastModified: number, day: string): { timeMs: number; timed: boolean } {
  const name = (relative.split("/").pop() ?? relative).replace(/\.[^.]+$/, "");
  if (DAY_RE.test(name)) {
    return {
      timeMs: new Date(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8))).getTime(),
      timed: false,
    };
  }
  const stamped = stampFromPath(relative);
  if (stamped !== null) {
    return { timeMs: stamped, timed: true };
  }
  return { timeMs: lastModified || Date.now(), timed: false };
}

function guessTime(relative: string, lastModified: number): number {
  return stampFromPath(relative) ?? (lastModified || Date.now());
}

function stampFromPath(relative: string): number | null {
  const ms = relative.match(/(?:^|\/|_|-)(\d{13})(?:\D|$)/);
  if (ms) {
    return Number(ms[1]);
  }
  const stamp = relative.match(/(?:^|\/|_|-)(\d{8})[_-]?(\d{6})(?:\D|$)/);
  if (stamp) {
    const day = stamp[1];
    const clock = stamp[2];
    return new Date(
      Number(day.slice(0, 4)),
      Number(day.slice(4, 6)) - 1,
      Number(day.slice(6, 8)),
      Number(clock.slice(0, 2)),
      Number(clock.slice(2, 4)),
      Number(clock.slice(4, 6)),
    ).getTime();
  }
  const sec = relative.match(/(?:^|\/|_|-)(\d{10})(?:\D|$)/);
  if (sec) {
    const value = Number(sec[1]);
    if (value > 1_000_000_000 && value < 2_000_000_000) {
      return value * 1000;
    }
  }
  return null;
}

function idFromName(relative: string): number | undefined {
  const name = relative.split("/").pop() ?? "";
  const match = name.match(/(\d{3,})/);
  return match ? Number(match[1]) : undefined;
}

function formatLabel(timeMs: number): string {
  const date = new Date(timeMs);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function isChromiumSealed(dbkey: ArrayBuffer | Uint8Array): boolean {
  const bytes = dbkey instanceof Uint8Array ? dbkey : new Uint8Array(dbkey);
  return bytes[0] === 0x76 && bytes[1] === 0x31 && bytes[2] === 0x30;
}

function copyBytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(data.byteLength);
  out.set(data);
  return out;
}

export async function unlockScreenshotKey(dbkey: ArrayBuffer, password?: string): Promise<CryptoKey> {
  const sealed = new Uint8Array(dbkey);
  if (!isChromiumSealed(sealed)) {
    const text = new TextDecoder().decode(sealed).trim();
    if (/^[0-9a-fA-F]{64}$/.test(text)) {
      return importAesKey(copyBytes(hexToBytes(text)));
    }
    return deriveScreenshotKey(copyBytes(sealed));
  }
  if (!password) {
    throw new Error("Password required");
  }
  const material = await pbkdf2(password);
  const secret = await aesCbcDecrypt(copyBytes(material), new Uint8Array(16).fill(32), copyBytes(sealed.subarray(3)));
  return deriveScreenshotKey(copyBytes(new TextEncoder().encode(new TextDecoder().decode(secret))));
}

export async function decodeCapture(bytes: ArrayBuffer, key: CryptoKey | null): Promise<Blob> {
  const plain = await decryptLuci(bytes, key);
  return new Blob([plain], { type: sniffImage(new Uint8Array(plain)) });
}

export async function decodeAudio(bytes: ArrayBuffer, key: CryptoKey | null): Promise<Blob> {
  return audioBlobFromPlain(new Uint8Array(await decryptLuci(bytes, key)));
}

async function decryptLuci(bytes: ArrayBuffer, key: CryptoKey | null): Promise<ArrayBuffer> {
  const data = new Uint8Array(bytes);
  if (!startsWith(data, MAGIC)) {
    return bytes;
  }
  if (!key) {
    throw new Error("Encrypted Luci media");
  }
  const nonce = data.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = data.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const payload = data.subarray(MAGIC.length + 28);
  const combined = new Uint8Array(payload.length + tag.length);
  combined.set(payload);
  combined.set(tag, payload.length);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: copyBytes(nonce) }, key, copyBytes(combined));
}

export async function countEncrypted(captures: LocalCapture[], limit = 8): Promise<number> {
  let count = 0;
  for (const capture of captures.slice(0, limit)) {
    const bytes = new Uint8Array(await capture.read());
    if (startsWith(bytes, MAGIC)) {
      count += 1;
    }
  }
  return count;
}

async function deriveScreenshotKey(secret: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", copyBytes(secret), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: new TextEncoder().encode("luci-screenshot-v1") },
    base,
    256,
  );
  return importAesKey(copyBytes(new Uint8Array(bits)));
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", copyBytes(raw), "AES-GCM", false, ["decrypt"]);
}

async function pbkdf2(password: string): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-1", salt: new TextEncoder().encode("saltysalt"), iterations: 1003 },
    base,
    128,
  );
  return new Uint8Array(bits);
}

async function aesCbcDecrypt(keyBytes: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", copyBytes(keyBytes), "AES-CBC", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: copyBytes(iv) }, key, copyBytes(data)));
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
  return prefix.every((byte, index) => data[index] === byte);
}

function sniffImage(data: Uint8Array): string {
  if (data[0] === 0xff && data[1] === 0xd8) {
    return "image/jpeg";
  }
  if (data[0] === 0x89 && data[1] === 0x50) {
    return "image/png";
  }
  if (data[0] === 0x52 && data[1] === 0x49) {
    return "image/webp";
  }
  return "image/jpeg";
}

async function dbkeyFingerprint(dbkey: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", dbkey));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(HANDLE_STORE);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB failed"));
    };
  });
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, "readwrite");
    tx.objectStore(HANDLE_STORE).put(value, key);
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error("Could not save"));
    };
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  try {
    const db = await openHandleDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, "readonly");
      const request = tx.objectStore(HANDLE_STORE).get(key);
      request.onsuccess = () => {
        resolve((request.result as T | undefined) ?? null);
      };
      request.onerror = () => {
        reject(request.error ?? new Error("Could not read"));
      };
    });
  } catch {
    return null;
  }
}

function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, "readwrite");
    tx.objectStore(HANDLE_STORE).delete(key);
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error("Could not delete"));
    };
  });
}

async function clearDirectoryHandle(): Promise<void> {
  try {
    const db = await openHandleDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, "readwrite");
      tx.objectStore(HANDLE_STORE).delete("root");
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error("Could not clear folder"));
      };
    });
  } catch {
    return;
  }
}

async function saveDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openHandleDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, "readwrite");
    tx.objectStore(HANDLE_STORE).put(handle, "root");
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error("Could not save folder"));
    };
  });
}

async function loadDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openHandleDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, "readonly");
      const request = tx.objectStore(HANDLE_STORE).get("root");
      request.onsuccess = () => {
        resolve((request.result as FileSystemDirectoryHandle | undefined) ?? null);
      };
      request.onerror = () => {
        reject(request.error ?? new Error("Could not read saved folder"));
      };
    });
  } catch {
    return null;
  }
}
