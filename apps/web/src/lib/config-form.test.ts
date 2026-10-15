import { describe, expect, it } from 'vitest';
import {
  CONFIG_DEFAULTS,
  FIELD_BOUNDS,
  initialFormValues,
  toRequest,
  validateRequest,
} from './config-form';

describe('config form', () => {
  it('reads defaults and bounds from the engine schema', () => {
    expect(FIELD_BOUNDS.population).toEqual({ min: 10, max: 5000, integer: true });
    expect(FIELD_BOUNDS['initialWealth.spread']).toEqual({ min: 0, max: 0.9, integer: false });
    const values = initialFormValues();
    expect(values.numbers.population).toBe(String(CONFIG_DEFAULTS.population));
    expect(values.numbers['lifeStages.elderAge']).toBe(String(CONFIG_DEFAULTS.lifeStages.elderAge));
    expect(values.stochasticWeather).toBe(true);
  });

  it('builds a valid request from defaults and omits an empty seed', () => {
    const values = { ...initialFormValues(), name: 'Test world' };
    const request = toRequest(values);
    expect(request.seed).toBeUndefined();
    expect(request.config).toEqual(CONFIG_DEFAULTS);
    expect(validateRequest(request)).toEqual({});
  });

  it('reports field errors by request path', () => {
    const values = initialFormValues();
    values.name = '';
    values.seed = 'bad seed!';
    values.numbers.population = '3';
    values.numbers['initialWealth.spread'] = '';
    const errors = validateRequest(toRequest(values));
    expect(Object.keys(errors).sort()).toEqual([
      'config.initialWealth.spread',
      'config.population',
      'name',
      'seed',
    ]);
    expect(errors['config.initialWealth.spread']).toBe('Enter a number.');
  });
});
