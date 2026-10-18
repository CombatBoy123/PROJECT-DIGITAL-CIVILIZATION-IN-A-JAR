/*
 * Leading + trailing throttle: the first call runs immediately, further calls within
 * `intervalMs` are coalesced into one trailing call at the end of the window. Used to
 * refresh projection-backed queries on checkpoint notifications without refetching on
 * every checkpoint of a fast-running simulation.
 */

export interface Throttled {
  (): void;
  cancel(): void;
}

export function throttle(
  fn: () => void,
  intervalMs: number,
  clock: { now: () => number } = { now: () => Date.now() },
): Throttled {
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const run = () => {
    last = clock.now();
    fn();
  };

  const throttled = (() => {
    const elapsed = clock.now() - last;
    if (elapsed >= intervalMs && timer === null) {
      run();
      return;
    }
    if (timer !== null) return;
    timer = setTimeout(
      () => {
        timer = null;
        run();
      },
      Math.max(0, intervalMs - elapsed),
    );
  }) as Throttled;

  throttled.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return throttled;
}
