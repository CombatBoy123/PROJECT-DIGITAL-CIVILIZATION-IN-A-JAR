import { describe, expect, it } from 'vitest';
import { EnvError, loadEnv } from '../src/config/env.js';

const base = { DATABASE_URL: 'postgresql://x/y' };
const TOKEN = 'o'.repeat(32);

describe('environment validation', () => {
  it('applies defaults for local development', () => {
    const env = loadEnv(base);
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.AUTH_MODE).toBe('disabled');
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173']);
    expect(env.RESUME_RUNNING_ON_START).toBe(false);
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadEnv({})).toThrow(EnvError);
  });

  it('rejects disabled auth on a non-loopback address', () => {
    expect(() => loadEnv({ ...base, HOST: '0.0.0.0' })).toThrow(/loopback/);
  });

  it('requires OPERATOR_TOKEN in token mode', () => {
    expect(() => loadEnv({ ...base, AUTH_MODE: 'token' })).toThrow(/OPERATOR_TOKEN/);
    expect(loadEnv({ ...base, AUTH_MODE: 'token', OPERATOR_TOKEN: TOKEN }).AUTH_MODE).toBe('token');
  });

  it('allows token mode on any address and rejects short or equal tokens', () => {
    expect(
      loadEnv({ ...base, HOST: '0.0.0.0', AUTH_MODE: 'token', OPERATOR_TOKEN: TOKEN }).HOST,
    ).toBe('0.0.0.0');
    expect(() => loadEnv({ ...base, AUTH_MODE: 'token', OPERATOR_TOKEN: 'short' })).toThrow(
      /24 characters/,
    );
    expect(() =>
      loadEnv({ ...base, AUTH_MODE: 'token', OPERATOR_TOKEN: TOKEN, VIEWER_TOKEN: TOKEN }),
    ).toThrow(/differ/);
  });

  it('parses numbers, lists and booleans', () => {
    const env = loadEnv({
      ...base,
      PORT: '8080',
      CORS_ORIGINS: 'http://a.test, http://b.test',
      RESUME_RUNNING_ON_START: 'true',
    });
    expect(env.PORT).toBe(8080);
    expect(env.CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
    expect(env.RESUME_RUNNING_ON_START).toBe(true);
    expect(() => loadEnv({ ...base, FRAME_RATE: '100' })).toThrow(EnvError);
  });
});
