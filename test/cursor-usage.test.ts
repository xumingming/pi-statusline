import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePeriodUsagePayload,
  parseUsageSummaryPayload,
} from "../cursor-usage.ts";

/** Shape captured from POST aiserver.v1.DashboardService/GetCurrentPeriodUsage. */
const PERIOD_PAYLOAD = {
  planUsage: {
    totalPercentUsed: 42.5,
    autoPercentUsed: 30,
    apiPercentUsed: 12,
  },
  billingCycleEnd: 1958494112520,
};

test("parsePeriodUsagePayload extracts total, auto and api meters", () => {
  const snapshot = parsePeriodUsagePayload(PERIOD_PAYLOAD);

  assert.ok(snapshot);
  assert.equal(snapshot.total?.label, "cur");
  assert.equal(snapshot.total?.percent, 42.5);
  assert.ok(snapshot.total?.resetsAt); // epoch ms → ISO string
  assert.equal(snapshot.auto?.label, "auto");
  assert.equal(snapshot.auto?.percent, 30);
  assert.equal(snapshot.api?.label, "api");
  assert.equal(snapshot.api?.percent, 12);
});

test("parsePeriodUsagePayload accepts percentUsed alias", () => {
  const snapshot = parsePeriodUsagePayload({
    planUsage: { percentUsed: 7 },
  });

  assert.ok(snapshot);
  assert.equal(snapshot.total?.percent, 7);
  assert.equal(snapshot.auto, null);
  assert.equal(snapshot.api, null);
});

test("parsePeriodUsagePayload keeps teams accounts with pools only", () => {
  const snapshot = parsePeriodUsagePayload({
    planUsage: { autoPercentUsed: 5, apiPercentUsed: 55 },
  });

  assert.ok(snapshot);
  assert.equal(snapshot.total, null);
  assert.equal(snapshot.auto?.percent, 5);
  assert.equal(snapshot.api?.percent, 55);
});

test("parsePeriodUsagePayload clamps out-of-range percents", () => {
  const snapshot = parsePeriodUsagePayload({
    planUsage: { totalPercentUsed: 120 },
  });

  assert.equal(snapshot?.total?.percent, 100);
});

test("parsePeriodUsagePayload returns null for unusable payloads", () => {
  assert.equal(parsePeriodUsagePayload(null), null);
  assert.equal(parsePeriodUsagePayload("nope"), null);
  assert.equal(parsePeriodUsagePayload({}), null);
  assert.equal(parsePeriodUsagePayload({ planUsage: null }), null);
  assert.equal(parsePeriodUsagePayload({ planUsage: { foo: 1 } }), null);
});

/** Shape captured from GET https://api2.cursor.sh/api/usage/summary. */
const SUMMARY_PAYLOAD = {
  individualUsage: {
    plan: { totalPercentUsed: 88 },
  },
  billingCycleEnd: "2030-02-01T00:00:00.000Z",
};

test("parseUsageSummaryPayload maps the plan percent onto total", () => {
  const snapshot = parseUsageSummaryPayload(SUMMARY_PAYLOAD);

  assert.ok(snapshot);
  assert.deepEqual(snapshot.total, {
    label: "cur",
    percent: 88,
    resetsAt: "2030-02-01T00:00:00.000Z",
  });
  assert.equal(snapshot.auto, null);
  assert.equal(snapshot.api, null);
});

test("parseUsageSummaryPayload returns null without a plan percent", () => {
  assert.equal(parseUsageSummaryPayload({ individualUsage: {} }), null);
  assert.equal(parseUsageSummaryPayload({}), null);
});

test("parseCycleReset paths: ISO string, epoch ms and epoch seconds", () => {
  // ISO string / epoch ms are covered above; exercise the seconds path.
  const snapshot = parsePeriodUsagePayload({
    planUsage: { totalPercentUsed: 1 },
    billingCycleEnd: 1958494112,
  });

  const resetsAt = snapshot?.total?.resetsAt;
  assert.ok(resetsAt);
  assert.equal(Number(new Date(resetsAt)), 1958494112000);
});
