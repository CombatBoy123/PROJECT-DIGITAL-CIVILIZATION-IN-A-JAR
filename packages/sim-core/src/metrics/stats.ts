/*
 * Small, exact statistics helpers used by metrics. Inputs are not mutated.
 */

export function sum(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

/** Median (average of the two middle values for even-sized inputs). 0 for empty input. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Gini coefficient of non-negative values:
 *   G = Σ_i (2i − n − 1)·x_(i) / (n · Σ x),  with x sorted ascending and i = 1..n.
 * 0 = perfect equality, (n − 1)/n = one holder owns everything. Defined as 0 when
 * the total is 0 or there are fewer than two values.
 */
export function gini(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  let total = 0;
  let weighted = 0;
  for (let i = 0; i < n; i++) {
    const x = sorted[i] as number;
    if (x < 0) throw new RangeError('gini: negative value');
    total += x;
    weighted += (2 * (i + 1) - n - 1) * x;
  }
  return total === 0 ? 0 : weighted / (n * total);
}
