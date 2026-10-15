import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import {
  hashString,
  serializeState,
  Simulation,
  type SimulationOptions,
  type WorldState,
} from '@civ/sim-core';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** A world state ready for storage: canonical JSON, its hash and gzip bytes. */
export interface EncodedState {
  tick: number;
  nextEventSeq: number;
  json: string;
  hash: string;
  sizeBytes: number;
}

/** Synchronous capture (must happen between ticks so the state is consistent). */
export function captureState(state: Readonly<WorldState>): EncodedState {
  const json = serializeState(state as WorldState);
  return {
    tick: state.tick,
    nextEventSeq: state.nextEventSeq,
    json,
    hash: hashString(json),
    sizeBytes: Buffer.byteLength(json),
  };
}

/** Compression runs on the libuv thread pool, off the event loop. */
export async function compress(json: string): Promise<Buffer> {
  return gzipAsync(Buffer.from(json, 'utf8'), { level: 6 });
}

/**
 * Decode a stored blob and rebuild the simulation, verifying the stored hash and
 * re-checking every invariant before the state can be used.
 */
export async function decodeSimulation(
  blob: Uint8Array,
  expectedHash: string,
  options: SimulationOptions,
): Promise<Simulation> {
  const json = (await gunzipAsync(blob)).toString('utf8');
  return Simulation.deserialize(json, expectedHash, options);
}
