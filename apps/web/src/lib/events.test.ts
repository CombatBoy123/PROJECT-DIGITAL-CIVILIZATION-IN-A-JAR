import type { EventDto } from '@civ/shared';
import { describe, expect, it } from 'vitest';
import {
  capEvents,
  eventInfo,
  matchesCategory,
  mergeEvents,
  summarizeEvent,
  typesInCategory,
} from './events';

function ev(seq: number, type: EventDto['type'] = 'WeatherChanged', payload = {}): EventDto {
  return { seq, tick: seq * 10, type, payload, refs: [], causeSeq: null };
}

describe('summarizeEvent', () => {
  it('summarises every catalogued event type', () => {
    expect(
      summarizeEvent({
        type: 'CivilizationFounded',
        payload: {
          seed: 'abc',
          population: 100,
          households: 40,
          buildings: 52,
          mapWidth: 64,
          mapHeight: 48,
        },
      }),
    ).toBe('Seed "abc": 100 citizens in 40 households, 52 buildings on a 64×48 map');
    expect(
      summarizeEvent({
        type: 'CitizenCreated',
        payload: {
          firstName: 'Ada',
          lastName: 'Byron',
          ageYears: 34,
          lifeStage: 'adult',
          householdId: 3,
          homeId: 9,
        },
      }),
    ).toBe('Ada Byron, age 34 (adult), household #3');
    expect(
      summarizeEvent({
        type: 'MoneyIssued',
        payload: { amountCents: 50_000, reason: 'initial_endowment' },
      }),
    ).toBe('$500.00 issued (initial endowment)');
    expect(summarizeEvent({ type: 'SeasonStarted', payload: { season: 'summer', year: 2 } })).toBe(
      'Summer of year 2 began',
    );
    expect(
      summarizeEvent({
        type: 'WeatherChanged',
        payload: { from: 'clear', to: 'rain', dailyMeanTempC: 11.26 },
      }),
    ).toBe('clear → rain, daily mean 11.3 °C');
    expect(
      summarizeEvent({
        type: 'LifeStageChanged',
        payload: { from: 'child', to: 'adult', ageYears: 18 },
      }),
    ).toBe('child → adult at age 18');
  });

  it('falls back to a generic summary for malformed or unknown payloads', () => {
    expect(summarizeEvent({ type: 'MoneyIssued', payload: { amountCents: 'lots' } })).toBe(
      'amount cents: lots',
    );
    expect(
      summarizeEvent({
        type: 'FutureEvent' as EventDto['type'],
        payload: { price: 3, nested: { x: 1 } },
      }),
    ).toBe('price: 3');
  });
});

describe('mergeEvents', () => {
  it('merges lists newest first and deduplicates by seq', () => {
    const live = [ev(12), ev(11)];
    const history = [ev(11), ev(10), ev(9)];
    expect(mergeEvents(live, history).map((e) => e.seq)).toEqual([12, 11, 10, 9]);
  });

  it('keeps the first occurrence when duplicates differ', () => {
    const a = { ...ev(5), tick: 1 };
    const b = { ...ev(5), tick: 2 };
    expect(mergeEvents([a], [b])[0]?.tick).toBe(1);
  });

  it('sorts unordered input', () => {
    expect(mergeEvents([ev(1), ev(3)], [ev(2)]).map((e) => e.seq)).toEqual([3, 2, 1]);
  });

  it('caps to the newest events', () => {
    expect(capEvents([ev(3), ev(2), ev(1)], 2).map((e) => e.seq)).toEqual([3, 2]);
  });
});

describe('categories', () => {
  it('maps types to catalogue categories', () => {
    expect(typesInCategory('environment').sort()).toEqual(['SeasonStarted', 'WeatherChanged']);
    expect(matchesCategory(ev(1, 'MoneyIssued'), 'economy')).toBe(true);
    expect(matchesCategory(ev(1, 'MoneyIssued'), 'environment')).toBe(false);
    expect(matchesCategory(ev(1, 'MoneyIssued'), null)).toBe(true);
  });

  it('describes unknown types generically', () => {
    expect(eventInfo('BusinessOpened').label).toBe('Business opened');
  });
});
