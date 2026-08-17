import assert from "node:assert/strict";
import { test } from "node:test";
import {
  JUMP_MS,
  SCRUB_STEPS,
  clampTime,
  formatWallClock,
  indexAfterJump,
  indexAtOrBefore,
  indexForProgress,
  indexForScrubValue,
  progressForIndex,
  progressForTime,
  scrubValueForIndex,
  scrubValueForTime,
  timeAtProgress,
  timeForScrubValue,
} from "./timeline.ts";

const frames = [{ timeMs: 1_000 }, { timeMs: 3_000 }, { timeMs: 11_000 }];

test("progress follows capture time, not frame count", () => {
  assert.equal(progressForIndex(frames, 0), 0);
  assert.equal(progressForIndex(frames, 1), 0.2);
  assert.equal(progressForIndex(frames, 2), 1);
});

test("scrub value maps back to the same frame", () => {
  for (const index of [0, 1, 2]) {
    const value = scrubValueForIndex(frames, index);
    assert.equal(indexForScrubValue(frames, value), index);
  }
  assert.equal(indexForProgress(frames, 0.19), 0);
  assert.equal(indexForProgress(frames, 0.2), 1);
  assert.equal(indexForProgress(frames, 0.21), 1);
  assert.equal(SCRUB_STEPS, 10_000);
});

test("indexAtOrBefore lands on the latest frame at or before the time", () => {
  assert.equal(indexAtOrBefore(frames, 0), 0);
  assert.equal(indexAtOrBefore(frames, 3_000), 1);
  assert.equal(indexAtOrBefore(frames, 3_500), 1);
  assert.equal(indexAtOrBefore(frames, 20_000), 2);
});

test("jumps land on the next or previous frame by real time", () => {
  assert.equal(indexAfterJump(frames, 0, JUMP_MS.tenSeconds), 2);
  assert.equal(indexAfterJump(frames, 2, -JUMP_MS.tenSeconds), 0);
  assert.equal(indexAfterJump(frames, 0, 1_500), 1);
  assert.equal(indexAfterJump(frames, 1, -1), 0);
});

test("formats the capture clock in local time", () => {
  const stamp = new Date(2026, 7, 16, 14, 3, 8).getTime();
  assert.equal(formatWallClock(stamp), "14:03:08");
  assert.equal(timeAtProgress(frames, 0), 1_000);
  assert.equal(timeAtProgress(frames, 1), 11_000);
  assert.equal(timeAtProgress([], 0.5), null);
});

test("scrub position in a gap stays at the clicked time", () => {
  assert.equal(progressForTime(frames, 5_000), 0.4);
  assert.equal(scrubValueForTime(frames, 5_000), 4_000);
  assert.equal(indexAtOrBefore(frames, 5_000), 1);
  assert.notEqual(scrubValueForTime(frames, 5_000), scrubValueForIndex(frames, 1));
  assert.equal(timeForScrubValue(frames, 4_000), 5_000);
  assert.equal(clampTime(frames, 0), 1_000);
  assert.equal(clampTime(frames, 20_000), 11_000);
});
