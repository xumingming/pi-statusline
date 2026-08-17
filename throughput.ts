/**
 * throughput.ts — output-token throughput tracker.
 *
 * Estimates the assistant's token generation rate for the statusline:
 *
 *   - While a response streams, providers do not report usage yet (it
 *     arrives with the final stream chunk on most APIs), so the live
 *     rate is estimated from streamed text length (~4 chars/token) and
 *     marked with a "~" prefix by the block renderer.
 *   - When the response finishes, the real `usage.output` count over
 *     the streaming wall-clock time replaces the estimate and stays on
 *     the line until the next response starts.
 *
 * Tool-execution gaps between responses are excluded on purpose: the
 * window opens at assistant `message_start` and closes at
 * `message_end`, so the number reflects pure model generation speed.
 *
 * All clock reads go through an injectable `now` parameter (default
 * `Date.now()`) so tests can drive the timeline deterministically.
 */

/** Rough chars-per-token divisor for live estimates. */
const CHARS_PER_TOKEN = 4;
/** Minimum stream age before a live estimate is shown, so the first
 *  few deltas do not produce wild spikes. */
const MIN_STREAM_AGE_MS = 1000;
/** Minimum stream duration for a settled rate to count; instant
 *  cache-hit / aborted responses carry no meaningful rate. */
const MIN_SETTLED_MS = 500;

export interface ThroughputState {
  /** "streaming" = live estimate; "settled" = usage-derived final. */
  phase: "streaming" | "settled";
  tokensPerSec: number;
}

let startedAt = 0;
let streamedChars = 0;
let settled: ThroughputState | null = null;

/** Open a streaming window. Called on assistant `message_start`. */
export function noteStreamStart(now: number = Date.now()): void {
  startedAt = now;
  streamedChars = 0;
  settled = null;
}

/** Accumulate streamed text. Called with stream delta lengths. */
export function noteStreamDelta(chars: number): void {
  if (startedAt === 0 || chars <= 0) return;
  streamedChars += chars;
}

/**
 * Close the streaming window with the final output-token count.
 * Called on assistant `message_end`. No-op without an open window.
 */
export function noteStreamEnd(outputTokens: number, now: number = Date.now()): void {
  if (startedAt === 0) return;
  const elapsedMs = now - startedAt;
  settled =
    elapsedMs >= MIN_SETTLED_MS && outputTokens > 0
      ? { phase: "settled", tokensPerSec: outputTokens / (elapsedMs / 1000) }
      : null;
  startedAt = 0;
  streamedChars = 0;
}

/** Clear all state. Called on `session_start`. */
export function resetThroughput(): void {
  startedAt = 0;
  streamedChars = 0;
  settled = null;
}

/**
 * Current throughput for the statusline; null when there is nothing
 * meaningful to show (idle before the first response, a stream younger
 * than MIN_STREAM_AGE_MS, or a response with no countable output).
 */
export function getThroughput(now: number = Date.now()): ThroughputState | null {
  if (startedAt !== 0) {
    const ageMs = now - startedAt;
    if (ageMs < MIN_STREAM_AGE_MS || streamedChars <= 0) return null;
    return {
      phase: "streaming",
      tokensPerSec: streamedChars / CHARS_PER_TOKEN / (ageMs / 1000),
    };
  }
  return settled;
}
