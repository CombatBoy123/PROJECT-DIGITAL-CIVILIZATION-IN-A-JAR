import type { Selection } from '../world/types';

/*
 * The observatory's selection lives in the URL (?citizen=12 or ?building=3) so that
 * links from the dashboard, the event log and other entities can open an inspector
 * directly, and the browser's back button walks the inspection history.
 */

const POSITIVE_INT = /^[1-9]\d{0,9}$/;

/** Read the selection from URL search parameters; invalid values are ignored. */
export function parseSelection(params: URLSearchParams): Selection | null {
  const citizen = params.get('citizen');
  if (citizen && POSITIVE_INT.test(citizen)) return { kind: 'citizen', id: Number(citizen) };
  const building = params.get('building');
  if (building && POSITIVE_INT.test(building)) return { kind: 'building', id: Number(building) };
  return null;
}

/** Return new search parameters with the selection applied (other parameters kept). */
export function withSelection(
  params: URLSearchParams,
  selection: Selection | null,
): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete('citizen');
  next.delete('building');
  if (selection) next.set(selection.kind, String(selection.id));
  return next;
}

/** Link to the observatory of a civilization with an entity selected. */
export function observatoryHref(civilizationId: string, selection?: Selection | null): string {
  const base = `/civ/${encodeURIComponent(civilizationId)}`;
  return selection ? `${base}?${selection.kind}=${selection.id}` : base;
}
