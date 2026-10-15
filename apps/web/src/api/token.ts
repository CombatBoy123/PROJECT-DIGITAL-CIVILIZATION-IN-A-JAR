/*
 * Access token entered by the user when the server runs with AUTH_MODE=token.
 * Kept in localStorage when available (private windows or blocked storage fall back
 * to memory for the session) and exposed as a tiny external store for React.
 */

const STORAGE_KEY = 'civ.accessToken';

type Listener = () => void;

function readStored(): string | null {
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

let current: string | null = readStored();
const listeners = new Set<Listener>();

export function getToken(): string | null {
  return current;
}

/** Set (or clear with null) the token and notify subscribers. */
export function setToken(token: string | null): void {
  const next = token?.trim() ? token.trim() : null;
  if (next === current) return;
  current = next;
  try {
    if (next) globalThis.localStorage?.setItem(STORAGE_KEY, next);
    else globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable: the token still works for this page session.
  }
  for (const listener of listeners) listener();
}

export function subscribeToken(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
