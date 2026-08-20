// Reads Luci's encrypted screen-memory/index.db entirely in the browser:
// decrypt with the verified sqleet port, then query with sql.js. All local,
// nothing uploaded. Absolute time per line = session start + segment offset,
// with the offset unit auto-calibrated to the session's wall-clock span so we
// don't depend on whether Luci stores offsets in ms or seconds.
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

function normEpochMs(value: number): number {
  return value < 1e12 ? value * 1000 : value;
}

function localDayKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}

type Session = { startMs: number; endMs: number };

export async function loadTranscript(fileBytes: Uint8Array, secret: Uint8Array): Promise<TranscriptSegment[]> {
  const plain = await decryptSqleet(fileBytes, secret);
  const SQL = await getSql();
  const db = new SQL.Database(plain);
  try {
    const sessions = new Map<number, Session>();
    const sessRes = db.exec("SELECT id, started_at, ended_at FROM audio_sessions");
    if (sessRes[0]) {
      for (const row of sessRes[0].values) {
        const id = Number(row[0]);
        const startMs = normEpochMs(Number(row[1]));
        const endMs = normEpochMs(Number(row[2] ?? row[1]));
        sessions.set(id, { startMs, endMs: Math.max(endMs, startMs) });
      }
    }

    // Per-session offset scale: map the max segment offset onto the session's
    // real duration, so ms/seconds/other offset units all resolve correctly.
    const maxOffset = new Map<number, number>();
    const segRes = db.exec("SELECT session_id, source, t_start, t_end, text FROM audio_segments");
    const raw = segRes[0]?.values ?? [];
    for (const row of raw) {
      const sid = Number(row[0]);
      const tEnd = Number(row[3] ?? 0);
      maxOffset.set(sid, Math.max(maxOffset.get(sid) ?? 0, tEnd));
    }
    const scaleFor = (sid: number): number => {
      const session = sessions.get(sid);
      const max = maxOffset.get(sid) ?? 0;
      if (!session || max <= 0) {
        return 1; // assume offsets already in ms
      }
      const span = session.endMs - session.startMs;
      if (span <= 0) {
        return 1;
      }
      return span / max;
    };

    const segments: TranscriptSegment[] = [];
    for (const row of raw) {
      const sessionId = Number(row[0]);
      const source = String(row[1] ?? "");
      const tStart = Number(row[2] ?? 0);
      const tEnd = Number(row[3] ?? tStart);
      const text = String(row[4] ?? "");
      if (!text.trim()) {
        continue;
      }
      const session = sessions.get(sessionId);
      const scale = scaleFor(sessionId);
      const startMs = (session?.startMs ?? 0) + tStart * scale;
      const endMs = (session?.startMs ?? 0) + tEnd * scale;
      segments.push({
        day: localDayKey(startMs),
        absMs: startMs,
        endMs: Math.max(endMs, startMs),
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
