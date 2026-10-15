import { hashString } from '../rng/hash.js';
import { STATE_SCHEMA_VERSION } from '../version.js';
import { WorldStateSchema, type WorldState } from './schema.js';

/**
 * Canonical JSON: object keys sorted lexicographically at every level, no
 * whitespace. Two equal states always produce the same string, regardless of the
 * order in which properties were created. Non-finite numbers are rejected rather
 * than silently turned into `null`.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const v = source[key];
      if (v !== undefined) sorted[key] = sortKeys(v);
    }
    return sorted;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`canonicalStringify: non-finite number ${value}`);
  }
  return value;
}

/** Serialise a world state to canonical JSON. */
export function serializeState(state: WorldState): string {
  return canonicalStringify(state);
}

/** Fingerprint of a world state (hash of its canonical JSON). */
export function hashState(state: WorldState): string {
  return hashString(serializeState(state));
}

export class StateRestoreError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'StateRestoreError';
  }
}

/**
 * Parse and validate serialised state. Rejects unknown schema versions, structurally
 * invalid data and (when `expectedHash` is given) any state whose canonical hash
 * differs from the recorded one.
 */
export function deserializeState(json: string, expectedHash?: string): WorldState {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new StateRestoreError('State is not valid JSON', String(err));
  }
  const version = (raw as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (version !== STATE_SCHEMA_VERSION) {
    throw new StateRestoreError(
      `Unsupported state schema version ${String(version)} (expected ${STATE_SCHEMA_VERSION})`,
    );
  }
  const parsed = WorldStateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StateRestoreError('State failed validation', parsed.error.issues.slice(0, 20));
  }
  const state = parsed.data;
  if (expectedHash !== undefined) {
    const actual = hashState(state);
    if (actual !== expectedHash) {
      throw new StateRestoreError(
        `State hash mismatch: expected ${expectedHash}, computed ${actual}`,
      );
    }
  }
  return state;
}
