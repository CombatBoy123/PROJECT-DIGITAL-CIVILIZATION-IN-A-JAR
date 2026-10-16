import { config } from 'zod';

/*
 * The published demo page forbids `eval`/`new Function` (Content-Security-Policy).
 * Zod's JIT probes `new Function` when an object schema is constructed, which a
 * strict CSP reports as a violation even though Zod catches the error. Turning the
 * JIT off avoids the probe; validation results are identical.
 *
 * This module must be imported before anything that defines Zod schemas (the engine),
 * so it is the first import of the demo entry.
 */
config({ jitless: true });
