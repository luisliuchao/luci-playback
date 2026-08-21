// Reads Luci's encrypted screen-memory/index.db entirely in the browser:
// decrypt with the verified sqleet port, then query with sql.js. All local,
// nothing uploaded. audio_segments.t_start/t_end are absolute Unix epoch
// milliseconds (same basis as capture timestamps), so they map straight onto
// the frame timeline — no session-relative offset math. audio_sessions is not
// needed for timing (and some rows have a corrupt ended_at < started_at).
import initSqlJs, { type SqlJsStatic } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { decryptSqleet } from "./sqleet";

export type TranscriptSegment = {
  day: string;
  absMs: number;
  endMs: number;
  source: string;
  text: string;
  sessionId: number;
};

let sqlPromise: Promise<SqlJsStatic> | null = null;
function getSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({ locateFile: () => wasmUrl });
  }
  return sqlPromise;
}

function localDayKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}

export async function loadTranscript(fileBytes: Uint8Array, secret: Uint8Array): Promise<TranscriptSegment[]> {
  const plain = await decryptSqleet(fileBytes, secret);
  const SQL = await getSql();
  const db = new SQL.Database(plain);
  try {
    const segRes = db.exec("SELECT session_id, source, t_start, t_end, text FROM audio_segments");
    const raw = segRes[0]?.values ?? [];
    const segments: TranscriptSegment[] = [];
    for (const row of raw) {
      const sessionId = Number(row[0]);
      const source = String(row[1] ?? "");
      const absMs = Number(row[2] ?? 0);
      const endMs = Number(row[3] ?? absMs);
      const text = String(row[4] ?? "");
      if (!text.trim() || !Number.isFinite(absMs) || absMs <= 0) {
        continue;
      }
      segments.push({
        day: localDayKey(absMs),
        absMs,
        endMs: Math.max(endMs, absMs),
        source,
        text,
        sessionId
      });
    }
    segments.sort((a, b) => a.absMs - b.absMs);
    return segments;
  } finally {
    db.close();
  }
}
