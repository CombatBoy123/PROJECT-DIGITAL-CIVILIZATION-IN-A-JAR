import { cyrb128 } from './hash.js';

/** Separator that cannot appear in numeric keys and is unlikely in stream names. */
const KEY_SEPARATOR = '\u001f';

/** Number of initial outputs discarded so that similar seeds produce unrelated streams. */
const WARM_UP_ROUNDS = 8;

/**
 * Small, fast pseudo-random generator (sfc32, public domain) with a serialisable
 * 128-bit state. All arithmetic is 32-bit integer arithmetic, so sequences are
 * identical across platforms.
 *
 * The engine never shares one generator across the whole simulation. Instead,
 * every random decision derives its own stream with {@link rngFor} from the
 * civilization seed plus a key (system, tick, entity id). This "counter-based"
 * approach means:
 *  - no generator state has to be persisted in snapshots;
 *  - a draw for one entity does not shift the draws of any other entity, so the
 *    order in which entities are processed cannot change results, and paired
 *    experiments stay aligned for as long as their execution paths allow.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: readonly [number, number, number, number]) {
    this.a = seed[0] | 0;
    this.b = seed[1] | 0;
    this.c = seed[2] | 0;
    this.d = seed[3] | 0;
    for (let i = 0; i < WARM_UP_ROUNDS; i++) this.nextUint32();
  }

  /** Next unsigned 32-bit integer. */
  nextUint32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Uniform float in [min, max). */
  uniform(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Uniform integer in [min, max] (both inclusive). */
  int(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new RangeError(`Rng.int: invalid range [${min}, ${max}]`);
    }
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability p (p is clamped to [0, 1]). */
  chance(p: number): boolean {
    if (p <= 0) return false;
    if (p >= 1) return true;
    return this.next() < p;
  }

  /** Uniformly chosen element of a non-empty array. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('Rng.pick: empty array');
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /**
   * Index chosen with probability proportional to its weight.
   * Returns -1 when every weight is zero.
   */
  weightedIndex(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) {
      if (!(w >= 0) || !Number.isFinite(w))
        throw new RangeError('Rng.weightedIndex: invalid weight');
      total += w;
    }
    if (total === 0) return -1;
    let target = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      target -= weights[i] as number;
      if (target < 0) return i;
    }
    // Floating-point rounding can leave target marginally ≥ 0; fall back to the last positive weight.
    for (let i = weights.length - 1; i >= 0; i--) if ((weights[i] as number) > 0) return i;
    return -1;
  }

  /**
   * Approximately normal variate using the Irwin–Hall construction
   * (sum of 12 uniforms − 6). Avoids Math.log/Math.cos so results are
   * bit-identical across JavaScript engines. Support is bounded to mean ± 6·sd.
   */
  normal(mean: number, sd: number): number {
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += this.next();
    return mean + (sum - 6) * sd;
  }
}

/** Derive an independent random stream from a seed and a key path. */
export function rngFor(seed: string, ...keys: ReadonlyArray<string | number>): Rng {
  return new Rng(cyrb128(seed + KEY_SEPARATOR + keys.join(KEY_SEPARATOR)));
}
