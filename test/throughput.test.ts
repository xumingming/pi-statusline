import assert from "node:assert/strict";
import test from "node:test";

import {
  getThroughput,
  noteStreamDelta,
  noteStreamEnd,
  noteStreamStart,
  resetThroughput,
} from "../throughput.ts";

test("hidden before any activity", () => {
  resetThroughput();
  assert.equal(getThroughput(10_000), null);
});

test("live estimate stays hidden during the first second", () => {
  resetThroughput();
  noteStreamStart(1_000);
  noteStreamDelta(400);
  assert.equal(getThroughput(1_500), null);
});

test("live estimate uses ~4 chars per token over stream age", () => {
  resetThroughput();
  noteStreamStart(1_000);
  noteStreamDelta(400); // ~100 tokens
  const state = getThroughput(3_000); // 2s elapsed
  assert.equal(state?.phase, "streaming");
  assert.equal(state?.tokensPerSec, 50);
});

test("settled rate uses the real output-token count, not the estimate", () => {
  resetThroughput();
  noteStreamStart(1_000);
  noteStreamDelta(10_000); // estimate would be far off; settled wins
  noteStreamEnd(200, 6_000); // 200 tokens over 5s
  const state = getThroughput(7_000);
  assert.equal(state?.phase, "settled");
  assert.equal(state?.tokensPerSec, 40);
});

test("settled rate persists until the next stream starts", () => {
  resetThroughput();
  noteStreamStart(1_000);
  noteStreamEnd(100, 3_000);
  assert.equal(getThroughput(60_000)?.phase, "settled");
  noteStreamStart(61_000);
  assert.equal(getThroughput(61_500), null); // young stream hides again
});

test("zero-token or instant responses leave nothing to show", () => {
  resetThroughput();
  noteStreamStart(1_000);
  noteStreamEnd(0, 3_000);
  assert.equal(getThroughput(4_000), null);

  noteStreamStart(5_000);
  noteStreamEnd(50, 5_100); // 100ms: below the settled floor
  assert.equal(getThroughput(6_000), null);
});

test("noteStreamEnd without a start is a no-op", () => {
  resetThroughput();
  noteStreamEnd(100, 1_000);
  assert.equal(getThroughput(2_000), null);
});

test("deltas outside a stream window are ignored", () => {
  resetThroughput();
  noteStreamDelta(500);
  assert.equal(getThroughput(10_000), null);
});
