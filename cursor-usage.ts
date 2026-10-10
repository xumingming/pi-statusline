/**
 * cursor-usage.ts — Cursor subscription usage meters.
 *
 * Fetches the current billing-cycle snapshot from Cursor's dashboard
 * API and exposes up to three windows the statusline renders as
 * progress bars (same percent-driven shape as `go-usage.ts`):
 *
 *   - `total` — the whole billing cycle (included spend / cap).
 *   - `auto`  — the "Auto + Composer" model pool.
 *   - `api`   — the API model pool.
 *
 * Teams plans without a structured total expose only the two pools;
 * missing windows render as null and their blocks stay hidden.
 *
 * Endpoint chain (unofficial, reverse-engineered by community quota
 * tools; cents fields are dollars * 100):
 *
 *   1. POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage
 *      (Connect-RPC JSON: `{}` body, `Connect-Protocol-Version: 1`)
 *   2. GET  https://api2.cursor.sh/api/usage/summary
 *
 * Auth: the credential pi stores for the `cursor-opencode` bridge
 * provider in `~/.pi/agent/auth.json` (OAuth `access` token from the
 * browser PKCE login, or an API `key`). The file is re-read on every
 * fetch so pi's token refreshes are picked up automatically.
 * `CURSOR_API_KEY` is accepted as a fallback.
 *
 * Fetching follows the same stale-while-revalidate pattern as
 * `go-usage.ts`: `getCursorUsage()` is synchronous, returns the cached
 * snapshot (or null before the first successful fetch), and kicks off
 * a background refresh when the cache is stale. When fresh data lands
 * the registered update listener fires so the widget can re-render.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CursorWindowUsage {
  /** Short display label, e.g. "cur", "auto" or "api". */
  label: string;
  /** Fill percentage (0-100) of the meter. */
  percent: number;
  /** Billing-cycle end (ISO string) — when usage resets. */
  resetsAt?: string;
}

export interface CursorUsageSnapshot {
  total: CursorWindowUsage | null;
  auto: CursorWindowUsage | null;
  api: CursorWindowUsage | null;
}

const USAGE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

const PERIOD_USAGE_URL =
  "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const USAGE_SUMMARY_URL = "https://api2.cursor.sh/api/usage/summary";

let cached: { snapshot: CursorUsageSnapshot; timestamp: number } | null = null;
let pending: Promise<void> | null = null;
let listener: (() => void) | null = null;

/** Register a callback fired whenever a fresh snapshot arrives. */
export function onCursorUsageUpdate(cb: () => void): void {
  listener = cb;
}

function toNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read the bridge's stored credential. Prefer `cursor-opencode` (the
 * name pi-bridge registers under) over `cursor`, which a native
 * provider login could also occupy. Tokens may expire between pi's
 * refreshes; a 401 from the API simply leaves the snapshot unset.
 */
function readToken(): string | null {
  try {
    const path = join(process.env.HOME || homedir(), ".pi", "agent", "auth.json");
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    for (const providerId of ["cursor-opencode", "cursor"]) {
      const entry = raw?.[providerId];
      if (!entry || typeof entry !== "object") continue;
      const token =
        entry.type === "oauth" && typeof entry.access === "string"
          ? entry.access
          : typeof entry.key === "string"
          ? entry.key
          : null;
      if (token) return token;
    }
  } catch {
    // Missing or malformed auth.json — fall through to the env key.
  }
  return process.env.CURSOR_API_KEY?.trim() || null;
}

/** Clamp a percent to 0-100; null passes through. */
function clampPct(value: unknown): number | null {
  const n = toNumber(value);
  return n === null ? null : Math.min(100, Math.max(0, n));
}

/** Milliseconds epoch for cycle end; Cursor sends numbers (and some
 *  ISO strings) for billingCycleEnd. */
function parseCycleReset(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  }
  const n = toNumber(value);
  if (n !== null && n > 0) {
    // Heuristic for the two unit conventions seen in the wild: seconds
    // vs milliseconds timestamps.
    const ms = n < 10_000_000_000 ? n * 1000 : n;
    return new Date(ms).toISOString();
  }
  return undefined;
}

/**
 * Parse the GetCurrentPeriodUsage Connect-RPC payload (`planUsage`
 * plus `billingCycleEnd`). Returns null when it carries no windows.
 */
export function parsePeriodUsagePayload(data: unknown): CursorUsageSnapshot | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const plan = record.planUsage;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return null;
  const p = plan as Record<string, unknown>;

  const resetsAt = parseCycleReset(record.billingCycleEnd ?? p.billingCycleEnd);
  const total = clampPct(p.totalPercentUsed ?? p.percentUsed);
  const auto = clampPct(p.autoPercentUsed);
  const api = clampPct(p.apiPercentUsed);

  if (total === null && auto === null && api === null) return null;
  return {
    total: total === null ? null : { label: "cur", percent: total, ...(resetsAt ? { resetsAt } : {}) },
    auto: auto === null ? null : { label: "auto", percent: auto, ...(resetsAt ? { resetsAt } : {}) },
    api: api === null ? null : { label: "api", percent: api, ...(resetsAt ? { resetsAt } : {}) },
  };
}

/**
 * Parse the `/api/usage/summary` fallback
 * (`individualUsage.plan.totalPercentUsed`).
 */
export function parseUsageSummaryPayload(data: unknown): CursorUsageSnapshot | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const individual = (data as Record<string, unknown>).individualUsage;
  if (typeof individual !== "object" || individual === null || Array.isArray(individual)) {
    return null;
  }
  const plan = (individual as Record<string, unknown>).plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return null;
  const percent = clampPct((plan as Record<string, unknown>).totalPercentUsed);
  if (percent === null) return null;
  const resetsAt = parseCycleReset((data as Record<string, unknown>).billingCycleEnd);
  return {
    total: { label: "cur", percent, ...(resetsAt ? { resetsAt } : {}) },
    auto: null,
    api: null,
  };
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) return null;
    return (await response.json().catch(() => null)) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUsage(): Promise<void> {
  const token = readToken();
  if (!token) return;
  const bearer = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "pi-statusline/1.0",
  };

  const period = await fetchJson(PERIOD_USAGE_URL, {
    method: "POST",
    headers: { ...bearer, "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
    body: "{}",
  });
  let snapshot = period ? parsePeriodUsagePayload(period) : null;

  if (!snapshot) {
    const summary = await fetchJson(USAGE_SUMMARY_URL, { method: "GET", headers: bearer });
    snapshot = summary ? parseUsageSummaryPayload(summary) : null;
  }

  if (snapshot) {
    cached = { snapshot, timestamp: Date.now() };
    listener?.();
  }
  // Both endpoints unusable: keep serving the previous snapshot.
}

/**
 * Return the cached snapshot, refreshing in the background when stale.
 * Returns null until the first successful fetch completes.
 */
export function getCursorUsage(): CursorUsageSnapshot | null {
  if (!cached || Date.now() - cached.timestamp >= USAGE_TTL_MS) {
    if (!pending) {
      pending = fetchUsage().finally(() => {
        pending = null;
      });
    }
  }
  return cached?.snapshot ?? null;
}
