import { useSyncExternalStore } from 'react';
import { accessFor, getTokenVerdict, subscribeTokenVerdict, type Access } from './access';
import { useMeta } from './queries';
import { useToken } from './useCivilizationStream';

/** What the current credentials may do (see access.ts); re-renders when that changes. */
export function useAccess(): Access {
  const meta = useMeta();
  const token = useToken();
  const verdict = useSyncExternalStore(subscribeTokenVerdict, getTokenVerdict, getTokenVerdict);
  return accessFor(meta.data, token, verdict);
}
