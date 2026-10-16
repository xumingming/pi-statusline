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

test("parseUsagePayload extracts the monthly window from usages.limit_month_total", () => {
  const snapshot = parseUsagePayload({
    usages: {
      limit_5h: { used_ratio: 0.0494, reset_time: "2026-10-16T10:24:29Z" },
      limit_month_total: { used_ratio: 0.04, reset_time: "2026-11-15T00:00:00Z" },
      limit_month_code: { used_ratio: 0.03, reset_time: "2026-11-15T00:00:00Z" },
    },
  });

  assert.deepEqual(snapshot?.monthly, {
    label: "mo",
    used: 4,
    limit: 100,
    resetTime: "2026-11-15T00:00:00Z",
  });
});

test("parseUsagePayload falls back to limit_month_code when total is absent", () => {
  const snapshot = parseUsagePayload({
    usages: { limit_month_code: { used_ratio: 0.25, reset_time: "2026-11-15T00:00:00Z" } },
  });

  assert.equal(snapshot?.monthly?.used, 25);
});

test("parseUsagePayload returns null when monthly data is unusable", () => {
  assert.equal(
    parseUsagePayload({ usages: { limit_month_total: { used_ratio: "nope" } } }),
    null,
  );
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
