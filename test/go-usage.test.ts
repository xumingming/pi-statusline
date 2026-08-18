import assert from "node:assert/strict";
import test from "node:test";

import { parseGoUsagePayload } from "../go-usage.ts";

/** Shape captured from GET https://opencode.ai/zen/go/v1/usage. */
const REAL_PAYLOAD = {
  usage: {
    rolling: { status: "ok", percent: 1, resetsAt: "2030-01-05T08:07:34.520Z" },
    weekly: { status: "ok", percent: 0, resetsAt: "2030-01-12T00:00:00.520Z" },
    monthly: { status: "ok", percent: 0, resetsAt: "2030-02-04T03:05:12.520Z" },
  },
};

test("parseGoUsagePayload extracts rolling, weekly and monthly windows", () => {
  const snapshot = parseGoUsagePayload(REAL_PAYLOAD);

  assert.ok(snapshot);
  assert.deepEqual(snapshot.rolling, {
    label: "5h",
    percent: 1,
    resetsAt: "2030-01-05T08:07:34.520Z",
  });
  assert.deepEqual(snapshot.weekly, {
    label: "wk",
    percent: 0,
    resetsAt: "2030-01-12T00:00:00.520Z",
  });
  assert.deepEqual(snapshot.monthly, {
    label: "mo",
    percent: 0,
    resetsAt: "2030-02-04T03:05:12.520Z",
  });
});

test("parseGoUsagePayload tolerates missing resetsAt", () => {
  const snapshot = parseGoUsagePayload({
    usage: { rolling: { status: "ok", percent: 42 } },
  });

  assert.ok(snapshot);
  assert.deepEqual(snapshot.rolling, { label: "5h", percent: 42 });
  assert.equal(snapshot.weekly, null);
  assert.equal(snapshot.monthly, null);
});

test("parseGoUsagePayload handles percent given as string", () => {
  const snapshot = parseGoUsagePayload({
    usage: { weekly: { status: "ok", percent: "7" } },
  });

  assert.equal(snapshot?.weekly?.percent, 7);
});

test("parseGoUsagePayload returns null for unusable payloads", () => {
  assert.equal(parseGoUsagePayload(null), null);
  assert.equal(parseGoUsagePayload("nope"), null);
  assert.equal(parseGoUsagePayload({}), null);
  assert.equal(parseGoUsagePayload({ usage: { foo: "bar" } }), null);
  assert.equal(parseGoUsagePayload({ usage: null }), null);
});