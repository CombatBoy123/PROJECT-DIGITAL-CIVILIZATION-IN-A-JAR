import type { MetaResponse, RouteInfo } from '@civ/shared';
import { getToken, subscribeToken } from './token';

/*
 * What the current credentials may do, so that operator-only controls can be
 * disabled (with the reason) instead of failing after the click.
 *
 * GET /api/meta reports the auth mode but not the role of a token, so the role of a
 * token is learned from the server's own answers to it (see `verdictFromResponse`):
 *   - 401 to a request carrying the token: the server rejected it ("invalid"),
 *   - 403 to it (only sent to a valid non-operator token): a viewer token,
 *   - success of an operator-only route: the operator token.
 * The verdict is remembered for that token (in localStorage, keyed by a fingerprint
 * of the token, next to the token itself) and forgotten when the token changes or
 * is saved again. Until the server has answered, a token is "unverified" and the
 * controls stay usable; the server is authoritative either way.
 */

export type TokenVerdict = 'operator' | 'viewer' | 'invalid';

const STORAGE_KEY = 'civ.accessVerdict';

/** Short non-cryptographic fingerprint (FNV-1a) tying a stored verdict to its token. */
export function tokenFingerprint(token: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

interface StoredVerdict {
  fingerprint: string;
  verdict: TokenVerdict;
}

function readStored(): StoredVerdict | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredVerdict>;
    const verdicts: readonly string[] = ['operator', 'viewer', 'invalid'];
    return typeof parsed.fingerprint === 'string' &&
      typeof parsed.verdict === 'string' &&
      verdicts.includes(parsed.verdict)
      ? { fingerprint: parsed.fingerprint, verdict: parsed.verdict }
      : null;
  } catch {
    return null;
  }
}

function writeStored(value: StoredVerdict | null): void {
  try {
    if (value) globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(value));
    else globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable: the verdict still applies for this page session.
  }
}

let stored: StoredVerdict | null = readStored();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** The server's verdict on the current token, or null when it is unverified (or absent). */
export function getTokenVerdict(): TokenVerdict | null {
  const token = getToken();
  return token && stored?.fingerprint === tokenFingerprint(token) ? stored.verdict : null;
}

export function subscribeTokenVerdict(listener: () => void): () => void {
  listeners.add(listener);
  const unsubscribeToken = subscribeToken(listener);
  return () => {
    listeners.delete(listener);
    unsubscribeToken();
  };
}

/** Forget what the server said about the current token (it is re-learned on use). */
export function forgetTokenVerdict(): void {
  if (stored === null) return;
  stored = null;
  writeStored(null);
  notify();
}

/**
 * What a response says about the token it was sent with: a verdict, 'valid' (the
 * token was accepted for reading, so it is not invalid) or null (nothing learned).
 */
export function verdictFromResponse(
  routeAuth: RouteInfo['auth'] | undefined,
  status: number,
): TokenVerdict | 'valid' | null {
  if (routeAuth === undefined || routeAuth === 'public') return null;
  if (status === 401) return 'invalid';
  if (status === 403) return 'viewer';
  if (status >= 200 && status < 300) return routeAuth === 'operate' ? 'operator' : 'valid';
  return null;
}

/**
 * Record the server's answer to a request sent with `token` (null: none sent).
 * Called by the API client for every response; ignored once the token has changed.
 */
export function observeResponse(
  token: string | null,
  routeAuth: RouteInfo['auth'] | undefined,
  status: number,
): void {
  if (!token || token !== getToken()) return;
  const learned = verdictFromResponse(routeAuth, status);
  if (learned === null) return;
  const current = getTokenVerdict();
  // A successful read only proves the token is valid: it clears "invalid" (the
  // server's tokens may have changed) but says nothing about operator rights.
  const next = learned === 'valid' ? (current === 'invalid' ? null : current) : learned;
  if (next === current) return;
  stored = next ? { fingerprint: tokenFingerprint(token), verdict: next } : null;
  writeStored(stored);
  notify();
}

export interface Access {
  /**
   * `open`: no token needed (AUTH_MODE=disabled, or the mode is not known yet);
   * `no-token`: the server needs one and none is set; `unverified`: a token the
   * server has not yet judged; otherwise the server's verdict on the token.
   */
  state: 'open' | 'no-token' | 'unverified' | TokenVerdict;
  /** Whether operator-only controls should be offered. */
  canOperate: boolean;
  /** Why they are not (shown next to the disabled controls), or null. */
  reason: string | null;
  /** Short description of the credentials for the header ("Viewer token", …). */
  label: string | null;
}

const OPEN: Access = { state: 'open', canOperate: true, reason: null, label: null };

/**
 * Access for the server's auth mode, the stored token and the server's verdict on it.
 * Before /api/meta has answered nothing is restricted (the server still enforces).
 */
export function accessFor(
  meta: Pick<MetaResponse, 'authMode'> | undefined,
  token: string | null,
  verdict: TokenVerdict | null,
): Access {
  if (!meta || meta.authMode === 'disabled') return OPEN;
  if (!token)
    return {
      state: 'no-token',
      canOperate: false,
      reason:
        'This server requires the operator token for this. Enter it with “Enter access token”.',
      label: null,
    };
  switch (verdict) {
    case 'operator':
      return { state: 'operator', canOperate: true, reason: null, label: 'Operator token' };
    case 'viewer':
      return {
        state: 'viewer',
        canOperate: false,
        reason:
          'Read-only: the access token in use is a viewer token. This needs the operator token.',
        label: 'Viewer token',
      };
    case 'invalid':
      return {
        state: 'invalid',
        canOperate: false,
        reason: 'The server rejected the access token. Enter a valid operator token.',
        label: 'Invalid token',
      };
    case null:
      return {
        state: 'unverified',
        canOperate: true,
        reason: null,
        label: 'Token set (unverified)',
      };
  }
}
