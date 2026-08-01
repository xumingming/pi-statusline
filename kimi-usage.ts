/**
 * kimi-usage.ts — Kimi Coding subscription usage windows.
 *
 * Fetches the quota snapshot from the Kimi Coding API
 * (`GET {baseUrl}/usages`) and exposes the two windows the statusline
 * renders as progress bars:
 *
 *   - `weekly`   — the rolling weekly window (`usage` in the payload).
 *   - `fiveHour` — the short rate-limit window (`limits[0]`, normally
 *                  300 minutes, labelled from the payload's window
 *                  duration so a different window still reads right).
 *
 * Auth: the OAuth access token pi's `kimi-coding` provider stores in
 * `~/.pi/agent/auth.json`. The file is re-read on every fetch so token
 * refreshes performed by the provider are picked up automatically.
 * `KIMI_API_KEY` is accepted as a fallback. The base URL honors the
 * same env overrides as the provider (`KIMI_CODE_BASE_URL`,
 * `KIMI_BASE_URL`).
 *
 * Fetching follows the same stale-while-revalidate pattern as
 * `git-status.ts`: `getKimiUsage()` is synchronous, returns the cached
 * snapshot (or null before the first successful fetch), and kicks off
 * a background refresh when the cache is stale. When fresh data lands
 * the registered update listener fires so the widget can re-render.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface KimiWindowUsage {
  /** Short display label, e.g. "wk" or "5h". */
  label: string;
  used: number;
  limit: number;
  resetTime?: string;
}

export interface KimiUsageSnapshot {
  weekly: KimiWindowUsage | null;
  fiveHour: KimiWindowUsage | null;
}

const USAGE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
const USER_AGENT = "kimi-code-cli/0.29.1";

const RESET_TIME_KEYS = ["resetTime", "reset_time", "resetsAt", "resets_at"] as const;

let cached: { snapshot: KimiUsageSnapshot; timestamp: number } | null = null;
let pending: Promise<void> | null = null;
let listener: (() => void) | null = null;

/** Register a callback fired whenever a fresh snapshot arrives. */
export function onKimiUsageUpdate(cb: () => void): void {
  listener = cb;
}

function readToken(): string | null {
  try {
    const path = join(process.env.HOME || homedir(), ".pi", "agent", "auth.json");
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    const access = raw?.["kimi-coding"]?.access;
    if (typeof access === "string" && access) return access;
  } catch {
    // Missing or malformed auth.json — fall through to the env key.
  }
  const apiKey = process.env.KIMI_API_KEY?.trim();
  return apiKey || null;
}

function buildUsageUrl(): string {
  const base = (
    process.env.KIMI_CODE_BASE_URL ||
    process.env.KIMI_BASE_URL ||
    DEFAULT_BASE_URL
  )
    .trim()
    .replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/usages` : `${base}/v1/usages`;
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

function parseRow(value: unknown, label: string): KimiWindowUsage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const limit = toNumber(record.limit);
  const usedValue = toNumber(record.used);
  const remaining = toNumber(record.remaining);
  const used = usedValue ?? (limit !== null && remaining !== null ? limit - remaining : null);
  if (limit === null && used === null) return null;
  const resetTime = getResetTime(record);
  return {
    label,
    used: used ?? 0,
    limit: limit ?? 0,
    ...(resetTime ? { resetTime } : {}),
  };
}

/** Derive a compact label like "5h" / "45m" from a window descriptor. */
function windowLabel(value: unknown): string {
  const fallback = "5h";
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
  const record = value as Record<string, unknown>;
  const duration = toNumber(record.duration);
  const unit = String(record.timeUnit ?? record.time_unit ?? "").toUpperCase();
  if (!duration || !unit) return fallback;
  const minutes = unit.includes("HOUR")
    ? duration * 60
    : unit.includes("MINUTE")
      ? duration
      : null;
  if (!minutes) return fallback;
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

/** Parse the `/usages` payload into a snapshot; null when unusable. */
export function parseUsagePayload(payload: unknown): KimiUsageSnapshot | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;

  const weekly = parseRow(record.usage, "wk");

  let fiveHour: KimiWindowUsage | null = null;
  if (Array.isArray(record.limits)) {
    for (const item of record.limits) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      const row = parseRow(entry.detail ?? entry, windowLabel(entry.window));
      if (row) {
        fiveHour = row;
        break;
      }
    }
  }

  if (!weekly && !fiveHour) return null;
  return { weekly, fiveHour };
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
    const snapshot = parseUsagePayload(await response.json());
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
export function getKimiUsage(): KimiUsageSnapshot | null {
  if (!cached || Date.now() - cached.timestamp >= USAGE_TTL_MS) {
    if (!pending) {
      pending = fetchUsage().finally(() => {
        pending = null;
      });
    }
  }
  return cached?.snapshot ?? null;
}
