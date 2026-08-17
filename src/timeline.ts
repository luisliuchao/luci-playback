export type TimedFrame = {
  timeMs: number;
};

export const SCRUB_STEPS = 10_000;
const MINUTE_MS = 60_000;
const TEN_SECONDS_MS = 10_000;

export function daySpan(frames: TimedFrame[]): { start: number; end: number; duration: number } {
  const start = frames[0]?.timeMs ?? 0;
  const end = frames[frames.length - 1]?.timeMs ?? start;
  return { start, end, duration: Math.max(1, end - start) };
}

export function progressForIndex(frames: TimedFrame[], index: number): number {
  const frame = frames[index];
  if (!frame) {
    return 0;
  }
  const { start, duration } = daySpan(frames);
  return (frame.timeMs - start) / duration;
}

export function scrubValueForIndex(frames: TimedFrame[], index: number): number {
  return Math.round(progressForIndex(frames, index) * SCRUB_STEPS);
}

export function progressForTime(frames: TimedFrame[], timeMs: number): number {
  if (frames.length === 0) {
    return 0;
  }
  const { start, duration } = daySpan(frames);
  return Math.min(1, Math.max(0, (timeMs - start) / duration));
}

export function scrubValueForTime(frames: TimedFrame[], timeMs: number): number {
  return Math.round(progressForTime(frames, timeMs) * SCRUB_STEPS);
}

export function timeForScrubValue(frames: TimedFrame[], value: number): number | null {
  return timeAtProgress(frames, value / SCRUB_STEPS);
}

export function clampTime(frames: TimedFrame[], timeMs: number): number {
  const { start, end } = daySpan(frames);
  return Math.min(end, Math.max(start, timeMs));
}

export function indexForProgress(frames: TimedFrame[], progress: number): number {
  if (frames.length === 0) {
    return 0;
  }
  const clamped = Math.min(1, Math.max(0, progress));
  const { start, duration } = daySpan(frames);
  return indexAtOrBefore(frames, start + clamped * duration);
}

export function indexForScrubValue(frames: TimedFrame[], value: number): number {
  return indexForProgress(frames, value / SCRUB_STEPS);
}

export function indexAtOrBefore(frames: TimedFrame[], timeMs: number): number {
  if (frames.length === 0) {
    return 0;
  }
  let low = 0;
  let high = frames.length - 1;
  if (timeMs <= frames[0].timeMs) {
    return 0;
  }
  if (timeMs >= frames[high].timeMs) {
    return high;
  }
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (frames[mid].timeMs === timeMs) {
      return mid;
    }
    if (frames[mid].timeMs < timeMs) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return high;
}

export function indexAfterJump(frames: TimedFrame[], index: number, deltaMs: number): number {
  const current = frames[index];
  if (!current) {
    return 0;
  }
  const target = current.timeMs + deltaMs;
  if (deltaMs >= 0) {
    const found = frames.findIndex((frame) => frame.timeMs >= target);
    return found === -1 ? frames.length - 1 : found;
  }
  return indexAtOrBefore(frames, target);
}

export function formatWallClock(timeMs: number): string {
  const date = new Date(timeMs);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function timeAtProgress(frames: TimedFrame[], progress: number): number | null {
  if (frames.length === 0) {
    return null;
  }
  const { start, duration } = daySpan(frames);
  return start + Math.min(1, Math.max(0, progress)) * duration;
}

export const JUMP_MS = {
  tenSeconds: TEN_SECONDS_MS,
  minute: MINUTE_MS,
} as const;
