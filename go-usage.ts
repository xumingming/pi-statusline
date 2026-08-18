/**
 * go-usage.ts — OpenCode Go subscription usage windows.
 *
 * Fetches the quota snapshot from the OpenCode Go API
 * (`GET {baseUrl}/usage`) and exposes the three windows the
 * statusline renders as progress bars:
 *
 *   - `rolling` — the rolling 5-hour window.
 *   - `weekly`  — the rolling weekly window.
 *   - `monthly` — the rolling monthly window.
 *
 * Go limits are dollar-based (5h $12 / weekly $30 / monthly $60) and
 * the API only exposes the fill as a `percent` (0-100) plus a
 * `resetsAt` timestamp, so unlike Kimi the windows are percent-driven.
 *
 * Auth: the API key pi's `opencode-go` provider stores in
 * `~/.pi/agent/auth.json`. The file is re-read on every fetch so key
 * rotation is picked up automatically. `OPENCODE_GO_API_KEY` /
 * `OPENCODE_API_KEY` are accepted as fallbacks. The base URL honors
 * the same env override as the provider (`OPENCODE_GO_BASE_URL`).
 *
 * Fetching follows the same stale-while-revalidate pattern as
 * `kimi-usage.ts`: `getGoUsage()` is synchronous, returns the cached
 * snapshot (or null before the first successful fetch), and kicks off
 * a background refresh when the cache is stale. When fresh data lands
 * the registered update listener fires so the widget can re-render.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GoWindowUsage {
  /** Short display label, e.g. "5h", "wk" or "mo". */
  label: string;
  /** Fill percentage (0-100) of the plan limit. */
  percent: number;
  resetsAt?: string;
}

export interface GoUsageSnapshot {
  rolling: GoWindowUsage | null;
  weekly: GoWindowUsage | null;
  monthly: GoWindowUsage | null;
}

const USAGE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1";
const USER_AGENT = "pi-statusline/1.0";

const RESET_TIME_KEYS = ["resetsAt", "resetTime", "reset_time", "resets_at"] as const;

let cached: { snapshot: GoUsageSnapshot; timestamp: number } | null = null;
let pending: Promise<void> | null = null;
let listener: (() => void) | null = null;

/** Register a callback fired whenever a fresh snapshot arrives. */
export function onGoUsageUpdate(cb: () => void): void {
  listener = cb;
}

function readToken(): string | null {
  try {
    const path = join(process.env.HOME || homedir(), ".pi", "agent", "auth.json");
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    const key = raw?.["opencode-go"]?.key;
    if (typeof key === "string" && key) return key;
  } catch {
    // Missing or malformed auth.json — fall through to the env key.
  }
  const envKey = process.env.OPENCODE_GO_API_KEY?.trim() || process.env.OPENCODE_API_KEY?.trim();
  return envKey || null;
}

function buildUsageUrl(): string {
  const base = (process.env.OPENCODE_GO_BASE_URL || DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/usage` : `${base}/v1/usage`;
}

function toNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getResetTime(record: Record<string, unknown>): string | undefined {
  for (const key of RESET_TIME_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function parseWindow(value: unknown, label: string): GoWindowUsage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const percent = toNumber(record.percent);
  if (percent === null) return null;
  const resetsAt = getResetTime(record);
  return {
    label,
    percent,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/** Parse the `/usage` payload into a snapshot; null when unusable. */
export function parseGoUsagePayload(payload: unknown): GoUsageSnapshot | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const usage = (payload as Record<string, unknown>).usage;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return null;
  const record = usage as Record<string, unknown>;

  const rolling = parseWindow(record.rolling, "5h");
  const weekly = parseWindow(record.weekly, "wk");
  const monthly = parseWindow(record.monthly, "mo");

  if (!rolling && !weekly && !monthly) return null;
  return { rolling, weekly, monthly };
}

async function fetchUsage(): Promise<void> {
  const token = readToken();
  if (!token) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(buildUsageUrl(), {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
    });
    if (!response.ok) return;
    const snapshot = parseGoUsagePayload(await response.json());
    if (snapshot) {
      cached = { snapshot, timestamp: Date.now() };
      listener?.();
    }
  } catch {
    // Network or abort error: keep serving the previous snapshot.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Return the cached snapshot, refreshing in the background when stale.
 * Returns null until the first successful fetch completes.
 */
export function getGoUsage(): GoUsageSnapshot | null {
  if (!cached || Date.now() - cached.timestamp >= USAGE_TTL_MS) {
    if (!pending) {
      pending = fetchUsage().finally(() => {
        pending = null;
      });
    }
  }
  return cached?.snapshot ?? null;
}