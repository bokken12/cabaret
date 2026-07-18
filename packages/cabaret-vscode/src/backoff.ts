/** What one run of a `BackoffLoop` produced. */
export type BackoffResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown; readonly backingOff: boolean };

export interface BackoffLoopOptions<T> {
  readonly run: () => Promise<T>;
  /** Delay between runs while things are going well. */
  readonly baseIntervalMs: number;
  /** Ceiling the delay backs off to after repeated transient failures. */
  readonly maxIntervalMs: number;
  /** Whether `error` is worth backing off for quietly (offline, say) rather than a real failure. */
  readonly isTransient: (error: unknown) => boolean;
  readonly onSettled?: (result: BackoffResult<T>) => void;
  /**
   * Consulted before each scheduled tick, not before `runNow` — a setting
   * that turns the loop off should not also disable an explicit, one-off
   * request for the same work. Defaults to always running.
   */
  readonly shouldRun?: () => boolean;
}

/**
 * Runs `run` on a repeating timer, doubling the delay (capped at
 * `maxIntervalMs`) after each transient failure and resetting to
 * `baseIntervalMs` the moment a run succeeds. A non-transient failure is
 * reported but does not change the delay: backing off would not fix a real
 * error, so the next run stays on schedule.
 *
 * `runNow` triggers a run outside the schedule, joining one already in
 * flight rather than starting a second — the same run a scheduled tick
 * started can be observed by a caller that asks for it before it finishes.
 */
export class BackoffLoop<T> {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<T> | undefined;
  private interval: number;
  private disposed = false;

  constructor(private readonly options: BackoffLoopOptions<T>) {
    this.interval = options.baseIntervalMs;
  }

  /** Start ticking, with the first run immediate. */
  start(): void {
    this.scheduleNext(0);
  }

  /** Stop ticking; a run already in flight still completes. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Run now instead of waiting for the next tick, joining one already in flight. */
  runNow(): Promise<T> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    return this.tick();
  }

  private scheduleNext(delay: number): void {
    if (this.disposed) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.options.shouldRun?.() ?? true) {
        void this.tick();
      } else {
        this.scheduleNext(this.interval);
      }
    }, delay);
  }

  private tick(): Promise<T> {
    if (this.inFlight !== undefined) {
      return this.inFlight;
    }
    const attempt = this.options.run().then(
      (value) => {
        this.interval = this.options.baseIntervalMs;
        this.options.onSettled?.({ ok: true, value });
        return value;
      },
      (error: unknown) => {
        const backingOff = this.options.isTransient(error);
        if (backingOff) {
          this.interval = Math.min(this.interval * 2, this.options.maxIntervalMs);
        }
        this.options.onSettled?.({ ok: false, error, backingOff });
        throw error;
      },
    );
    this.inFlight = attempt;
    // Scheduling off a `finally` (rather than inside each branch above) keeps
    // the reschedule delay reading whichever `this.interval` those branches
    // just settled on.
    void attempt
      .catch(() => undefined)
      .finally(() => {
        this.inFlight = undefined;
        this.scheduleNext(this.interval);
      });
    return attempt;
  }
}
