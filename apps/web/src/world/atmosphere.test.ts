import { describe, expect, it } from 'vitest';
import { NIGHT_MAX_ALPHA, hourAt, nightAlpha, weatherOverlay } from './atmosphere';

describe('night tint', () => {
  it('is clear by day and capped at night', () => {
    expect(nightAlpha(12)).toBe(0);
    expect(nightAlpha(8)).toBe(0);
    expect(nightAlpha(0)).toBe(NIGHT_MAX_ALPHA);
    expect(nightAlpha(23)).toBe(NIGHT_MAX_ALPHA);
    expect(nightAlpha(3)).toBe(NIGHT_MAX_ALPHA);
  });

  it('fades in at dusk and out at dawn, monotonically', () => {
    let previous = -1;
    for (let h = 18; h <= 22; h += 0.25) {
      const a = nightAlpha(h);
      expect(a).toBeGreaterThanOrEqual(previous);
      previous = a;
    }
    previous = 2;
    for (let h = 4; h <= 8; h += 0.25) {
      const a = nightAlpha(h);
      expect(a).toBeLessThanOrEqual(previous);
      previous = a;
    }
    expect(nightAlpha(19.5)).toBeGreaterThan(0);
    expect(nightAlpha(19.5)).toBeLessThan(NIGHT_MAX_ALPHA);
  });

  it('advances the hour with the fractional render tick and wraps at midnight', () => {
    expect(hourAt(10, 100, 100.5)).toBe(10.5);
    expect(hourAt(23, 100, 100.5)).toBe(23.5);
    expect(hourAt(23, 100, 101)).toBe(0);
    expect(hourAt(5, 100, 99)).toBe(5);
  });
});

describe('weather overlay', () => {
  it('rains only in rain and storms, storms heavier', () => {
    expect(weatherOverlay('clear').rainAlpha).toBe(0);
    expect(weatherOverlay('cloudy').rainAlpha).toBe(0);
    expect(weatherOverlay('rain').rainAlpha).toBeGreaterThan(0);
    expect(weatherOverlay('storm').rainAlpha).toBeGreaterThan(weatherOverlay('rain').rainAlpha);
    expect(weatherOverlay('storm').darken).toBeGreaterThan(weatherOverlay('rain').darken);
  });

  it('stays subtle', () => {
    for (const w of ['clear', 'cloudy', 'rain', 'storm'] as const) {
      expect(weatherOverlay(w).rainAlpha).toBeLessThanOrEqual(0.4);
      expect(weatherOverlay(w).darken).toBeLessThanOrEqual(0.2);
    }
  });
});
