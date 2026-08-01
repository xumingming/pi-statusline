import assert from "node:assert/strict";
import test from "node:test";

import { parseUsagePayload } from "../kimi-usage.ts";

/** Shape captured from GET https://api.kimi.com/coding/v1/usages. */
const REAL_PAYLOAD = {
  user: { userId: "u1", region: "REGION_CN" },
  usage: { limit: "100", used: "9", remaining: "91", resetTime: "2026-08-08T07:01:18.219288Z" },
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", used: "43", remaining: "57", resetTime: "2026-08-01T16:01:18.219288Z" },
    },
  ],
};

test("parseUsagePayload extracts weekly and 5h windows", () => {
  const snapshot = parseUsagePayload(REAL_PAYLOAD);

  assert.ok(snapshot);
  assert.deepEqual(snapshot.weekly, {
    label: "wk",
    used: 9,
    limit: 100,
    resetTime: "2026-08-08T07:01:18.219288Z",
  });
  assert.deepEqual(snapshot.fiveHour, {
    label: "5h",
    used: 43,
    limit: 100,
    resetTime: "2026-08-01T16:01:18.219288Z",
  });
});

test("parseUsagePayload derives used from limit - remaining", () => {
  const snapshot = parseUsagePayload({
    usage: { limit: 100, remaining: 91 },
    limits: [{ window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" }, detail: { limit: 50, used: 10 } }],
  });

  assert.equal(snapshot?.weekly?.used, 9);
  assert.equal(snapshot?.fiveHour?.label, "5h");
  assert.equal(snapshot?.fiveHour?.used, 10);
});

test("parseUsagePayload labels non-hour-aligned windows in minutes", () => {
  const snapshot = parseUsagePayload({
    limits: [{ window: { duration: 45, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: 10, used: 1 } }],
  });

  assert.equal(snapshot?.fiveHour?.label, "45m");
  assert.equal(snapshot?.weekly, null);
});

test("parseUsagePayload returns null for unusable payloads", () => {
  assert.equal(parseUsagePayload(null), null);
  assert.equal(parseUsagePayload("nope"), null);
  assert.equal(parseUsagePayload({}), null);
  assert.equal(parseUsagePayload({ usage: { foo: "bar" } }), null);
});
