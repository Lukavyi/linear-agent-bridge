/**
 * Consecutive-duplicate coalescer for the intermediate-thought stream.
 *
 * Sits between a backend's tool-progress stream and the universal event mapper.
 * Every *distinct* thought is surfaced — so you see every unique tool command —
 * while runs of the *same* thought collapse into one activity with a count
 * (`reading file (×4)`), which is the only thing worth suppressing. There is no
 * time window: nothing distinct is ever dropped or delayed waiting out a clock.
 *
 * Mechanics: a new distinct thought flushes the previous one and becomes the
 * held item; identical repeats just bump its count. The final held thought is
 * released by `flush()`. (So a thought emits when the *next* distinct one
 * arrives, or at flush — a one-step hold, which is what lets repeats coalesce.)
 *
 * Pure logic, no timers — deterministic table-test fodder.
 */

export interface ThrottleEmit {
  /** Render-ready thought body, carrying a `(×N)` suffix when coalesced. */
  body: string;
  /** Number of source events folded into this emission. */
  count: number;
}

interface HeldThought {
  key: string;
  count: number;
}

export class ThoughtThrottler {
  private held: HeldThought | null = null;
  private cancelled = false;

  /**
   * Feed one intermediate thought. Returns the previous distinct thought when
   * this one differs from it (zero or one emission); identical repeats coalesce
   * and return nothing.
   */
  push(body: string): ThrottleEmit[] {
    if (this.cancelled) return [];
    const key = body.trim();
    if (!key) return [];

    if (this.held && this.held.key === key) {
      this.held.count += 1;
      return [];
    }

    const emits: ThrottleEmit[] = [];
    if (this.held) emits.push(render(this.held));
    this.held = { key, count: 1 };
    return emits;
  }

  /** Release the final held thought. No-op when empty or after `cancel()`. */
  flush(): ThrottleEmit[] {
    if (this.cancelled || !this.held) return [];
    const emit = render(this.held);
    this.held = null;
    return [emit];
  }

  /** Drop anything held and emit nothing further (used on abort). */
  cancel(): void {
    this.cancelled = true;
    this.held = null;
  }
}

function render(held: HeldThought): ThrottleEmit {
  const body = held.count > 1 ? `${held.key} (×${held.count})` : held.key;
  return { body, count: held.count };
}
