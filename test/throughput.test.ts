import assert from "node:assert/strict";
import test from "node:test";

import {
  getThroughput,
  noteStreamDelta,
  noteStreamEnd,
  noteStreamStart,
  resetThroughput,
} from "../throughput.ts";

test("shows 0/s before any activity", () => {
  resetThroughput();
  const state = getThroughput(10_000);
  assert.equal(state.phase, "settled");
  assert.equal(state.tokensPerSec, 0);
});

test("live estimate stays at 0/s during the first ~300ms", () => {
  resetThroughput();
  noteStreamStart(1_000);
  noteStreamDelta(400);
  assert.equal(getThroughput(1_250).tokensPerSec, 0, "250ms still 0/s");
  assert.equal(getThroughput(1_500).phase, "streaming", "500ms now streams");
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

test("settled rate stays on the line, fresh stream falls back to 0/s", () => {
  resetThroughput();
  noteStreamStart(1_000);
  noteStreamEnd(100, 3_000);
  assert.equal(getThroughput(60_000)?.phase, "settled");
  noteStreamStart(61_000);
  assert.equal(getThroughput(61_500).tokensPerSec, 0, "young charless stream shows 0/s");
  noteStreamEnd(80, 62_000);
  assert.equal(getThroughput(63_000)?.tokensPerSec, 80, "replaced by the new result");
});

test("an unusable response keeps the previous settled rate", () => {
  resetThroughput();
  noteStreamStart(1_000);
  noteStreamEnd(200, 3_000); // 200 tokens over 2s -> 100/s
  assert.equal(getThroughput(3_500)?.tokensPerSec, 100);

  noteStreamStart(4_000);
  noteStreamEnd(0, 6_000); // zero tokens: unusable result
  assert.equal(getThroughput(7_000)?.phase, "settled");
  assert.equal(getThroughput(7_000)?.tokensPerSec, 100, "previous rate kept");

  noteStreamStart(8_000);
  noteStreamEnd(50, 8_100); // 100ms: below the settled floor
  assert.equal(getThroughput(9_000)?.tokensPerSec, 100, "still previous rate");
});

// Existing zero-token / instant cases have no prior rate to fall back to,
// so they still leave nothing to show.
test("zero-token or instant responses fall back to 0/s", () => {
  resetThroughput();
  noteStreamStart(1_000);
  noteStreamEnd(0, 3_000);
  assert.equal(getThroughput(4_000).tokensPerSec, 0);

  noteStreamStart(5_000);
  noteStreamEnd(50, 5_100); // 100ms: below the settled floor
  assert.equal(getThroughput(6_000).tokensPerSec, 0);
});

test("noteStreamEnd without a start is a no-op", () => {
  resetThroughput();
  noteStreamEnd(100, 1_000);
  assert.equal(getThroughput(2_000).tokensPerSec, 0);
});

test("deltas outside a stream window are ignored", () => {
  resetThroughput();
  noteStreamDelta(500);
  assert.equal(getThroughput(10_000).tokensPerSec, 0);
});
