import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alignClipToFrames,
  audioBlobFromPlain,
  clampPlaybackRate,
  clipsCoveringTime,
  seekOffset,
  sniffAudioMime,
  wrapPcmAsWav,
} from "./audio.ts";

test("covers the latest clips that contain the playhead", () => {
  const clips = [
    { timeMs: 1_000, timed: true, durationMs: 10_000 },
    { timeMs: 12_000, timed: true, durationMs: 10_000 },
    { timeMs: 12_100, timed: true, durationMs: 10_000 },
  ];
  const found = clipsCoveringTime(clips, 13_000, 2);
  assert.deepEqual(
    found.map((clip) => clip.timeMs),
    [12_000, 12_100],
  );
});

test("untimed clips cover the whole day until duration is known", () => {
  const clips = [{ timeMs: 1_000, timed: false }];
  assert.equal(clipsCoveringTime(clips, 3_600_000, 2).length, 1);
});

test("does not treat a parallel track as the end of the other clip", () => {
  const clips = [
    { timeMs: 10_000, timed: true },
    { timeMs: 10_200, timed: true },
  ];
  const found = clipsCoveringTime(clips, 60_000, 2);
  assert.equal(found.length, 2);
});

test("seekOffset stays inside the clip", () => {
  assert.equal(seekOffset(5_000, 1_000), 4);
  assert.equal(seekOffset(20_000, 1_000, 10_000), null);
  assert.equal(seekOffset(500, 1_000), 0);
  assert.equal(seekOffset(400, 1_000), null);
});

test("aligns untimed lastModified that sits outside the day to the first frame", () => {
  assert.equal(alignClipToFrames(9_999_999, false, 1_000, 5_000), 1_000);
  assert.equal(alignClipToFrames(2_000, false, 1_000, 5_000), 2_000);
  assert.equal(alignClipToFrames(9_999_999, true, 1_000, 5_000), 9_999_999);
});

test("clamps playback rate to what browsers allow", () => {
  assert.equal(clampPlaybackRate(5), 5);
  assert.equal(clampPlaybackRate(30), 16);
});

test("wraps headerless PCM as WAV so the browser can play it", () => {
  const pcm = new Uint8Array(32);
  const wav = wrapPcmAsWav(pcm);
  assert.equal(sniffAudioMime(wav), "audio/wav");
  assert.equal(audioBlobFromPlain(pcm).type, "audio/wav");
  assert.equal(audioBlobFromPlain(wav).type, "audio/wav");
});
