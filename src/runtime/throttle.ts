/**
 * Activity-stream throttler — pure logic, no timers.
 *
 * Sits between a backend's intermediate-thought stream and the universal event
 * mapper. Hermes can fire dozens of tool-progress signals in a second; posting
 * each as a Linear `thought` would flood the activity feed. This coalesces that
 * burst into a sparse, readable feed:
 *
 *   - Leading edge: the first thought after an idle gap emits immediately, so
 *     the session shows life without waiting out the window.
 *   - Minimum interval: at most one emission per `minIntervalMs` (default
 *     2500ms). Everything that arrives inside an open window is held as a single
 *     `pending` slot and emitted on the next push past the window — or at the
 *     final `flush()`.
 *   - Dedup: adjacent repeats of the same body coalesce into one thought with a
 *     count suffix (`reading file (×4)`).
 *
 * Time is injected as a `now` argument on every call rather than read from the
 * clock, so the whole thing is deterministic table-test fodder. The real
 * gateway passes `Date.now()`.
 */

const DEFAULT_MIN_INTERVAL_MS = 2500;

export interface ThrottleEmit {
  /** Render-ready thought body, carrying a `(×N)` suffix when coalesced. */
  body: string;
  /** Number of source events folded into this emission. */
  count: number;
}

export interface ThoughtThrottlerOptions {
  minIntervalMs?: number;
}

interface PendingThought {
  key: string;
  body: string;
  count: number;
}

export class ThoughtThrottler {
  private readonly minInterval: number;
  private lastEmitAt: number | null = null;
  private pending: PendingThought | null = null;
  private cancelled = false;

  constructor(options: ThoughtThrottlerOptions = {}) {
    this.minInterval = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  }

  /**
   * Feed one intermediate thought. Returns the emissions this push produces —
   * zero (held as pending) or one (leading edge, or a flushed prior pending).
   */
  push(body: string, now: number): ThrottleEmit[] {
    if (this.cancelled) return [];
    const key = body.trim();
    if (!key) return [];

    const emits: ThrottleEmit[] = [];

    // A pending thought whose window has now elapsed flushes before we consider
    // the newcomer — that keeps emissions ordered and ≥minInterval apart.
    if (this.pending && this.windowElapsed(now)) {
      emits.push(render(this.pending));
      this.lastEmitAt = now;
      this.pending = null;
    }

    if (this.pending) {
      // Still inside the window: fold into the single pending slot. Adjacent
      // repeats bump the count; a different thought replaces it (last wins).
      if (this.pending.key === key) {
        this.pending.count += 1;
      } else {
        this.pending = { key, body: key, count: 1 };
      }
      return emits;
    }

    if (this.windowElapsed(now)) {
      // Idle long enough — emit on the leading edge.
      this.lastEmitAt = now;
      emits.push({ body: key, count: 1 });
      return emits;
    }

    // Inside an open window with nothing pending yet — stash it.
    this.pending = { key, body: key, count: 1 };
    return emits;
  }

  /**
   * Flush whatever is held. Always emits the final pending thought (AC: the last
   * event is never dropped). No-op after `cancel()`.
   */
  flush(now?: number): ThrottleEmit[] {
    if (this.cancelled || !this.pending) return [];
    const emit = render(this.pending);
    this.pending = null;
    if (typeof now === "number") this.lastEmitAt = now;
    return [emit];
  }

  /** Drop anything pending and emit nothing further (used on abort). */
  cancel(): void {
    this.cancelled = true;
    this.pending = null;
  }

  private windowElapsed(now: number): boolean {
    return this.lastEmitAt === null || now - this.lastEmitAt >= this.minInterval;
  }
}

function render(pending: PendingThought): ThrottleEmit {
  const body =
    pending.count > 1 ? `${pending.body} (×${pending.count})` : pending.body;
  return { body, count: pending.count };
}
