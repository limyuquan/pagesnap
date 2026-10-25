/**
 * `captureVisibleTab` pacing (owner: A). Chrome allows `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`
 * (2) calls per second and rejects the rest, so calls start at least `minGapMs` apart and quota
 * errors are retried. Pure apart from the injected clock, so it is unit-tested with a fake one.
 */

export interface ShooterDeps {
  /** Takes the screenshot (a PNG data URL). */
  capture: () => Promise<string>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  minGapMs: number;
  /** Retries after a quota rejection. */
  maxRetries?: number;
  /**
   * Retries after any other error. `captureVisibleTab` fails transiently ("Failed to capture
   * tab") while the compositor is busy, e.g. right after a heavy page settles.
   */
  otherRetries?: number;
}

export interface Shooter {
  /** Wait for the next free slot, then capture. Resolves with the data URL. */
  shoot(signal?: AbortSignal): Promise<string>;
  /** Time until the next capture may start, ms (0 if now). */
  waitTime(): number;
  /** Start times of every capture call, for timing reports. */
  readonly starts: readonly number[];
}

export function isQuotaError(err: unknown): boolean {
  return /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(String(err));
}

export function createShooter(deps: ShooterDeps): Shooter {
  const maxRetries = deps.maxRetries ?? 4;
  const otherRetries = deps.otherRetries ?? 2;
  let lastStart = Number.NEGATIVE_INFINITY;
  const starts: number[] = [];
  const waitTime = () => Math.max(0, lastStart + deps.minGapMs - deps.now());
  return {
    starts,
    waitTime,
    async shoot(signal) {
      let others = 0;
      for (let attempt = 0; ; attempt++) {
        const wait = waitTime();
        if (wait > 0) await deps.sleep(wait);
        signal?.throwIfAborted();
        lastStart = deps.now();
        starts.push(lastStart);
        try {
          return await deps.capture();
        } catch (err) {
          if (attempt < maxRetries && isQuotaError(err)) {
            // The quota window is per second; one extra short wait is enough to land in the next one.
            await deps.sleep(60 * (attempt + 1));
            continue;
          }
          if (!isQuotaError(err) && others < otherRetries) {
            others++;
            await deps.sleep(150 * others);
            continue;
          }
          throw err;
        }
      }
    },
  };
}
