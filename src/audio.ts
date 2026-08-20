export type TimedClip = {
  timeMs: number;
  durationMs?: number;
  timed: boolean;
  stream?: string;
};

// Chunks of one recording stream (e.g. a rotating mic capture) share a path
// shape where only the digits vary; different streams (mic vs system) differ
// in the rest of the path.
export function streamKey(relativePath: string): string {
  return relativePath.replace(/\d+/g, "#");
}

// Duration of a chunk may only be inferred from the next chunk of the SAME
// stream — using the merged timeline would let a parallel track (mic vs
// system) truncate the other stream's clip. Returns at most one covering
// clip per stream, newest first within the stream.
export function clipsCoveringTime<T extends TimedClip>(clips: T[], timeMs: number, limit: number): T[] {
  const streams = new Map<string, T[]>();
  for (const [index, clip] of clips.entries()) {
    const key = clip.stream ?? `#anon-${index}`;
    const list = streams.get(key);
    if (list) {
      list.push(clip);
    } else {
      streams.set(key, [clip]);
    }
  }
  const covering: T[] = [];
  for (const list of streams.values()) {
    const sorted = [...list].sort((a, b) => a.timeMs - b.timeMs);
    let latest: T | undefined;
    for (let index = 0; index < sorted.length; index += 1) {
      const clip = sorted[index];
      const next = sorted[index + 1];
      const nextGap = next ? next.timeMs - clip.timeMs : undefined;
      const fromNext = nextGap !== undefined && nextGap > 2000 ? nextGap : undefined;
      const durationMs = clip.durationMs ?? fromNext;
      const estimated = durationMs ?? (clip.timed ? 5 * 60_000 : Number.POSITIVE_INFINITY);
      if (timeMs < clip.timeMs) {
        continue;
      }
      if (timeMs >= clip.timeMs + estimated) {
        continue;
      }
      latest = clip;
    }
    if (latest) {
      covering.push(latest);
    }
  }
  covering.sort((a, b) => a.timeMs - b.timeMs);
  return covering.slice(-limit);
}

export function seekOffset(frameMs: number, startMs: number, durationMs?: number): number | null {
  const offsetMs = frameMs - startMs;
  if (offsetMs < -500) {
    return null;
  }
  if (durationMs !== undefined && Number.isFinite(durationMs) && durationMs > 0 && offsetMs >= durationMs) {
    return null;
  }
  return Math.max(0, offsetMs / 1000);
}

export function alignClipToFrames(timeMs: number, timed: boolean, firstFrameMs?: number, lastFrameMs?: number): number {
  if (timed || firstFrameMs === undefined || lastFrameMs === undefined) {
    return timeMs;
  }
  if (timeMs < firstFrameMs || timeMs > lastFrameMs + 60_000) {
    return firstFrameMs;
  }
  return timeMs;
}

export function clampPlaybackRate(speed: number): number {
  return Math.min(16, Math.max(0.25, speed));
}

export function sniffAudioMime(data: Uint8Array): string {
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) {
    return "audio/wav";
  }
  if (data[0] === 0x4f && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53) {
    return "audio/ogg";
  }
  if (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) {
    return "audio/mpeg";
  }
  if (data[0] === 0xff && (data[1] & 0xe0) === 0xe0) {
    return "audio/mpeg";
  }
  if (data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70) {
    return "audio/mp4";
  }
  if (data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) {
    return "audio/webm";
  }
  if (data[0] === 0x66 && data[1] === 0x4c && data[2] === 0x61 && data[3] === 0x43) {
    return "audio/flac";
  }
  return "";
}

export function wrapPcmAsWav(pcm: Uint8Array, sampleRate = 16_000, channels = 1, bits = 16): Uint8Array {
  const blockAlign = (channels * bits) / 8;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const write = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  write(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  const out = new Uint8Array(44 + pcm.byteLength);
  out.set(new Uint8Array(header));
  out.set(pcm, 44);
  return out;
}

export function audioBlobFromPlain(plain: Uint8Array): Blob {
  const mime = sniffAudioMime(plain);
  if (mime) {
    return new Blob([copyBytes(plain)], { type: mime });
  }
  return new Blob([copyBytes(wrapPcmAsWav(plain))], { type: "audio/wav" });
}

function copyBytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(data.byteLength);
  out.set(data);
  return out;
}
