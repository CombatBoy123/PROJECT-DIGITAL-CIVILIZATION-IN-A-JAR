import { useEffect, useState } from 'react';

/** The value, updated only after it has been stable for `delayMs` (search boxes). */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Width of an element, rounded down to `step` px to avoid churn while resizing. */
export function useElementWidth(element: HTMLElement | null, step = 50): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    if (!element) return;
    const measure = () => {
      const w = element.getBoundingClientRect().width;
      setWidth(Math.max(step, Math.floor(w / step) * step));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, step]);
  return width;
}
