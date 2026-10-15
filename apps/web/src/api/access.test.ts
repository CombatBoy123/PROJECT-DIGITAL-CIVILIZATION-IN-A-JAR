import { afterEach, describe, expect, it } from 'vitest';
import {
  accessFor,
  forgetTokenVerdict,
  getTokenVerdict,
  observeResponse,
  subscribeTokenVerdict,
  tokenFingerprint,
  verdictFromResponse,
} from './access';
import { setToken } from './token';

const tokenMode = { authMode: 'token' } as const;

afterEach(() => {
  forgetTokenVerdict();
  setToken(null);
});

describe('verdictFromResponse', () => {
  it('learns nothing from public routes or unknown paths', () => {
    expect(verdictFromResponse('public', 200)).toBeNull();
    expect(verdictFromResponse(undefined, 403)).toBeNull();
  });

  it('reads 401 as a rejected token and 403 as a viewer token', () => {
    expect(verdictFromResponse('read', 401)).toBe('invalid');
    expect(verdictFromResponse('operate', 401)).toBe('invalid');
    expect(verdictFromResponse('operate', 403)).toBe('viewer');
  });

  it('only an accepted operator route proves the operator token', () => {
    expect(verdictFromResponse('operate', 200)).toBe('operator');
    expect(verdictFromResponse('operate', 204)).toBe('operator');
    expect(verdictFromResponse('read', 200)).toBe('valid');
    // Validation or conflict errors say nothing about the role.
    expect(verdictFromResponse('operate', 400)).toBeNull();
    expect(verdictFromResponse('operate', 409)).toBeNull();
  });
});

describe('accessFor', () => {
  it('restricts nothing without auth (or before the mode is known)', () => {
    expect(accessFor({ authMode: 'disabled' }, null, null).canOperate).toBe(true);
    expect(accessFor({ authMode: 'disabled' }, 'x', 'viewer').canOperate).toBe(true);
    expect(accessFor(undefined, null, null).canOperate).toBe(true);
  });

  it('disables controls without a token, for a viewer and for a rejected token', () => {
    for (const [token, verdict, state] of [
      [null, null, 'no-token'],
      ['v', 'viewer', 'viewer'],
      ['w', 'invalid', 'invalid'],
    ] as const) {
      const access = accessFor(tokenMode, token, verdict);
      expect(access.state).toBe(state);
      expect(access.canOperate).toBe(false);
      expect(access.reason).toMatch(/operator token/);
    }
    expect(accessFor(tokenMode, 'v', 'viewer').label).toBe('Viewer token');
  });

  it('offers controls to the operator and to a token the server has not judged yet', () => {
    expect(accessFor(tokenMode, 'o', 'operator')).toMatchObject({
      canOperate: true,
      label: 'Operator token',
    });
    expect(accessFor(tokenMode, 'o', null)).toMatchObject({
      state: 'unverified',
      canOperate: true,
    });
  });
});

describe('observeResponse', () => {
  it('remembers a 403 as a viewer verdict for that token only', () => {
    let notified = 0;
    const unsubscribe = subscribeTokenVerdict(() => notified++);
    setToken('viewer-token');
    observeResponse('viewer-token', 'operate', 403);
    expect(getTokenVerdict()).toBe('viewer');
    expect(notified).toBeGreaterThan(0);
    setToken('other-token');
    expect(getTokenVerdict()).toBeNull();
    setToken('viewer-token');
    expect(getTokenVerdict()).toBe('viewer');
    unsubscribe();
  });

  it('ignores answers to a token that is no longer current, and to no token', () => {
    setToken('new');
    observeResponse('old', 'operate', 403);
    observeResponse(null, 'operate', 401);
    expect(getTokenVerdict()).toBeNull();
  });

  it('upgrades to operator on success and clears "invalid" after an accepted read', () => {
    setToken('t');
    observeResponse('t', 'read', 401);
    expect(getTokenVerdict()).toBe('invalid');
    observeResponse('t', 'read', 200);
    expect(getTokenVerdict()).toBeNull();
    observeResponse('t', 'operate', 200);
    expect(getTokenVerdict()).toBe('operator');
    // A later read keeps the operator verdict.
    observeResponse('t', 'read', 200);
    expect(getTokenVerdict()).toBe('operator');
    forgetTokenVerdict();
    expect(getTokenVerdict()).toBeNull();
  });

  it('fingerprints tokens stably', () => {
    expect(tokenFingerprint('abc')).toBe(tokenFingerprint('abc'));
    expect(tokenFingerprint('abc')).not.toBe(tokenFingerprint('abd'));
  });
});
