import { describe, expect, it, vi } from 'vitest';
import { buildQuery, errorFromResponse, fieldIssues, ApiError } from '../api/client';
import { filenameFromDisposition } from './download';
import { shortcutFor } from './keyboard';
import { maxPointsFor, resolveRange, seriesFor, groupDefinitions } from './metrics';
import { observatoryHref, parseSelection, withSelection } from './selection';
import { throttle } from './throttle';

const key = (k: string, target: unknown = {}, extra: object = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  target,
  ...extra,
});

describe('keyboard shortcuts', () => {
  it('maps space and period', () => {
    expect(shortcutFor(key(' '))).toBe('togglePlay');
    expect(shortcutFor(key('.'))).toBe('step');
    expect(shortcutFor(key('x'))).toBeNull();
  });

  it('never fires while typing or with modifiers', () => {
    expect(shortcutFor(key(' ', { tagName: 'INPUT' }))).toBeNull();
    expect(shortcutFor(key('.', { tagName: 'textarea' }))).toBeNull();
    expect(shortcutFor(key('.', { isContentEditable: true }))).toBeNull();
    expect(shortcutFor(key('.', {}, { ctrlKey: true }))).toBeNull();
    expect(
      shortcutFor(key('.', { closest: (s: string) => (s === 'dialog[open]' ? {} : null) })),
    ).toBeNull();
  });

  it('leaves space to focused buttons but still steps with "."', () => {
    const button = { tagName: 'BUTTON' };
    expect(shortcutFor(key(' ', button))).toBeNull();
    expect(shortcutFor(key('.', button))).toBe('step');
    expect(shortcutFor(key(' ', { tagName: 'DIV', getAttribute: () => 'tab' }))).toBeNull();
  });
});

describe('selection in the URL', () => {
  it('parses and writes selections', () => {
    expect(parseSelection(new URLSearchParams('citizen=12'))).toEqual({ kind: 'citizen', id: 12 });
    expect(parseSelection(new URLSearchParams('building=3'))).toEqual({ kind: 'building', id: 3 });
    expect(parseSelection(new URLSearchParams('citizen=-1'))).toBeNull();
    expect(parseSelection(new URLSearchParams('citizen=abc'))).toBeNull();
    const next = withSelection(new URLSearchParams('citizen=1&x=y'), { kind: 'building', id: 4 });
    expect(next.toString()).toBe('x=y&building=4');
    expect(withSelection(next, null).toString()).toBe('x=y');
    expect(observatoryHref('id-1', { kind: 'citizen', id: 2 })).toBe('/civ/id-1?citizen=2');
  });
});

describe('metrics helpers', () => {
  it('extracts a series by key and skips non-finite values', () => {
    const response = {
      keys: ['population.total', 'money.supply'] as never,
      rows: [
        [0, 100, 5000],
        [1, 100, Number.NaN],
        [2, 101, 5100],
      ],
      bucketTicks: 1,
      fromTick: 0,
      toTick: 2,
    };
    expect(seriesFor(response, 'money.supply')).toEqual([
      { tick: 0, value: 5000 },
      { tick: 2, value: 5100 },
    ]);
    expect(seriesFor(response, 'wealth.giniAdult')).toEqual([]);
    expect(seriesFor(undefined, 'money.supply')).toEqual([]);
  });

  it('resolves time ranges against the durable tick', () => {
    expect(resolveRange('day', 100, { from: '', to: '' })).toEqual({ fromTick: 76, toTick: 100 });
    expect(resolveRange('week', 100, { from: '', to: '' })).toEqual({ fromTick: 0, toTick: 100 });
    expect(resolveRange('all', 100, { from: '', to: '' })).toEqual({});
    expect(resolveRange('custom', 100, { from: '10', to: '20' })).toEqual({
      fromTick: 10,
      toTick: 20,
    });
    expect(resolveRange('custom', 100, { from: '30', to: '20' })).toBeNull();
    expect(resolveRange('custom', 100, { from: '1.5', to: '' })).toBeNull();
  });

  it('clamps max points to the API bounds', () => {
    expect(maxPointsFor(null)).toBe(600);
    expect(maxPointsFor(3)).toBe(10);
    expect(maxPointsFor(420.4)).toBe(420);
    expect(maxPointsFor(99999)).toBe(5000);
  });

  it('groups every definition by category', () => {
    const groups = groupDefinitions();
    expect(groups.map((g) => g.category)).toEqual([
      'population',
      'activity',
      'needs',
      'money',
      'wealth',
      'environment',
    ]);
  });
});

describe('api client helpers', () => {
  it('builds query strings, skipping empty values', () => {
    expect(buildQuery({ a: 1, b: undefined, c: '', d: ['x', 'y'], e: [] })).toBe('?a=1&d=x%2Cy');
    expect(buildQuery(undefined)).toBe('');
  });

  it('parses error bodies into ApiError', async () => {
    const body = {
      error: {
        code: 'CONFIRMATION_REQUIRED',
        message: 'Type the name',
        details: [{ path: 'confirm', message: 'mismatch' }],
      },
    };
    const err = await errorFromResponse(new Response(JSON.stringify(body), { status: 400 }));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('CONFIRMATION_REQUIRED');
    expect(err.status).toBe(400);
    expect(fieldIssues(err)).toEqual([{ path: 'confirm', message: 'mismatch' }]);
  });

  it('falls back on non-JSON error bodies', async () => {
    const err = await errorFromResponse(
      new Response('nope', { status: 403, statusText: 'Forbidden' }),
    );
    expect(err.code).toBe('FORBIDDEN');
    expect(err.isAuthError).toBe(true);
  });

  it('reads download filenames', () => {
    expect(filenameFromDisposition('attachment; filename="metrics.csv"', 'x')).toBe('metrics.csv');
    expect(filenameFromDisposition("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.json", 'x')).toBe(
      'résumé.json',
    );
    expect(filenameFromDisposition(null, 'fallback.txt')).toBe('fallback.txt');
  });
});

describe('throttle', () => {
  it('runs immediately, then coalesces calls into one trailing run', () => {
    vi.useFakeTimers();
    let now = 0;
    const fn = vi.fn();
    const t = throttle(fn, 1000, { now: () => now });
    t();
    expect(fn).toHaveBeenCalledTimes(1);
    now = 100;
    t();
    t();
    expect(fn).toHaveBeenCalledTimes(1);
    now = 1000;
    vi.advanceTimersByTime(900);
    expect(fn).toHaveBeenCalledTimes(2);
    t.cancel();
    vi.useRealTimers();
  });
});
