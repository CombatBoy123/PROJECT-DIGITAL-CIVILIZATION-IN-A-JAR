import { useEffect, useState } from 'react';
import type { FrameStore } from './frame-store';

/**
 * Re-render when the FrameStore changes, at most once per animation frame. Returns
 * a counter that changes with every coalesced update. Disabled → no subscription.
 */
export function useFrameVersion(frames: FrameStore, enabled = true): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    const unsubscribe = frames.subscribe(() => {
      if (raf !== 0) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setVersion((v) => v + 1);
      });
    });
    return () => {
      unsubscribe();
      cancelAnimationFrame(raf);
    };
  }, [frames, enabled]);
  return version;
}
