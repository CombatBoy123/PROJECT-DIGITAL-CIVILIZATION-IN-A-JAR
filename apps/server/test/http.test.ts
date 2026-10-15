import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_ROUTES, type ApiErrorBody, type MetaResponse } from '@civ/shared';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { listApiRoutes, redactUrl } from '../src/app.js';
import { requiredAccess } from '../src/auth/auth.js';
import {
  createCivilization,
  createTestPrisma,
  LogCapture,
  startApp,
  truncateAll,
} from './helpers.js';

const OPERATOR = 'operator-token-0123456789abcdef';
const VIEWER = 'viewer-token-0123456789abcdef00';
const MISSING = '00000000-0000-4000-8000-000000000000';

let prisma: PrismaClient;
let app: FastifyInstance | null = null;

beforeAll(() => {
  prisma = createTestPrisma();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await truncateAll(prisma);
});
afterEach(async () => {
  await app?.close();
  app = null;
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Status of a raw HTTP/1.1 request (lets the test send absolute-form targets). */
function rawStatus(port: number, method: string, target: string, body = ''): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n` +
          (body
            ? `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`
            : '') +
          `\r\n${body}`,
      );
    });
    let data = '';
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
      const line = /^HTTP\/1\.1 (\d{3})/.exec(data);
      if (line) {
        resolve(Number(line[1]));
        socket.destroy();
      }
    });
    socket.on('error', reject);
  });
}

/** 101 when a WebSocket upgrade succeeds, else the HTTP status of the refusal. */
function upgradeStatus(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.on('open', () => {
      resolve(101);
      ws.close();
    });
    ws.on('unexpected-response', (req, res) => {
      resolve(res.statusCode ?? 0);
      req.destroy(); // ws requires aborting the upgrade request itself
    });
    ws.on('error', (err) => reject(err));
  });
}

describe('route table', () => {
  it('registers exactly the endpoints of API_ROUTES', async () => {
    app = await startApp(prisma);
    const expected = API_ROUTES.map((r) => `${r.method} ${r.path}`).sort();
    expect([...listApiRoutes(app)].sort()).toEqual(expected);
  });
});

describe('authorization', () => {
  it('in token mode with a viewer token, reads need a token and mutations the operator', async () => {
    app = await startApp(prisma, {
      AUTH_MODE: 'token',
      OPERATOR_TOKEN: OPERATOR,
      VIEWER_TOKEN: VIEWER,
    });
    const list = (headers = {}) => app!.inject({ url: '/api/civilizations', headers });
    expect((await list()).statusCode).toBe(401);
    expect((await list(bearer('wrong-token-0123456789abcdef'))).statusCode).toBe(401);
    expect((await list(bearer(VIEWER))).statusCode).toBe(200);
    expect((await list(bearer(OPERATOR))).statusCode).toBe(200);

    const create = (headers = {}) =>
      app!.inject({
        method: 'POST',
        url: '/api/civilizations',
        headers,
        payload: { name: 'Auth', seed: 'a', config: { population: 10 } },
      });
    const anonymous = await create();
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json<ApiErrorBody>().error.code).toBe('UNAUTHORIZED');
    const viewer = await create(bearer(VIEWER));
    expect(viewer.statusCode).toBe(403);
    expect(viewer.json<ApiErrorBody>().error.code).toBe('FORBIDDEN');
    expect((await create(bearer(OPERATOR))).statusCode).toBe(201);

    // The audit log records the operator as the actor.
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'civilization.created' },
    });
    expect(audit.actor).toBe('operator');
  });

  it('health and meta are public', async () => {
    app = await startApp(prisma, {
      AUTH_MODE: 'token',
      OPERATOR_TOKEN: OPERATOR,
      VIEWER_TOKEN: VIEWER,
    });
    const health = await app.inject({ url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true, database: 'up' });
    const meta = await app.inject({ url: '/api/meta' });
    expect(meta.statusCode).toBe(200);
    expect(meta.json<MetaResponse>()).toMatchObject({
      authMode: 'token',
      readRequiresToken: true,
      frameRate: 5,
      maxStepsPerRequest: 1000,
    });
  });

  it('without a viewer token, anonymous clients may read but not mutate', async () => {
    app = await startApp(prisma, { AUTH_MODE: 'token', OPERATOR_TOKEN: OPERATOR });
    expect((await app.inject({ url: '/api/civilizations' })).statusCode).toBe(200);
    const meta = await app.inject({ url: '/api/meta' });
    expect(meta.json<MetaResponse>().readRequiresToken).toBe(false);
    const res = await app.inject({
      method: 'POST',
      url: '/api/civilizations',
      payload: { name: 'X' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('answers CORS preflights for allowed origins without a token', async () => {
    app = await startApp(prisma, {
      AUTH_MODE: 'token',
      OPERATOR_TOKEN: OPERATOR,
      VIEWER_TOKEN: VIEWER,
      CORS_ORIGINS: 'http://ui.test',
    });
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/civilizations',
      headers: { origin: 'http://ui.test', 'access-control-request-method': 'POST' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://ui.test');
  });

  it('accepts the stream token as a query parameter and redacts it from logs', async () => {
    const logs = new LogCapture();
    app = await startApp(
      prisma,
      { AUTH_MODE: 'token', OPERATOR_TOKEN: OPERATOR, VIEWER_TOKEN: VIEWER, LOG_LEVEL: 'info' },
      { logger: { stream: logs } },
    );
    const civ = await createCivilization(app, {}, bearer(OPERATOR));
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const url = `ws://127.0.0.1:${port}/api/civilizations/${civ.id}/stream`;

    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.on('unexpected-response', (req, res) => {
        resolve(res.statusCode ?? 0);
        req.destroy(); // ws requires aborting the upgrade request itself
      });
      ws.on('open', () => reject(new Error('opened without a token')));
      ws.on('error', () => undefined);
    });
    expect(status).toBe(401);

    const hello = await new Promise<{ type: string }>((resolve, reject) => {
      const ws = new WebSocket(`${url}?token=${VIEWER}`);
      ws.on('message', (data) => {
        resolve(JSON.parse(data.toString()) as { type: string });
        ws.close();
      });
      ws.on('error', reject);
    });
    expect(hello.type).toBe('hello');

    // Header tokens never reach the logs either.
    await app.inject({ url: '/api/civilizations', headers: bearer(OPERATOR) });
    const text = logs.lines.join('\n');
    expect(text).toContain('token=[redacted]');
    expect(text).not.toContain(VIEWER);
    expect(text).not.toContain(OPERATOR);
  });

  it('decides access from the matched route, so encoded or absolute-form paths cannot skip it', async () => {
    app = await startApp(prisma, {
      AUTH_MODE: 'token',
      OPERATOR_TOKEN: OPERATOR,
      VIEWER_TOKEN: VIEWER,
    });
    const civ = await createCivilization(app, { name: 'Guarded' }, bearer(OPERATOR));
    // The router decodes these to /api/... routes.
    const variants = ['/%61pi', '/ap%69', '/%61%70%69'];
    for (const prefix of variants) {
      const cases = [
        { method: 'GET', url: `${prefix}/civilizations` },
        { method: 'GET', url: `${prefix}/civilizations/${civ.id}/events` },
        { method: 'POST', url: `${prefix}/civilizations`, payload: { name: 'Bypass' } },
        {
          method: 'POST',
          url: `${prefix}/civilizations/${civ.id}/control`,
          payload: { action: 'step' },
        },
        {
          method: 'DELETE',
          url: `${prefix}/civilizations/${civ.id}`,
          payload: { confirm: 'Guarded' },
        },
      ] as const;
      for (const c of cases) {
        const res = await app.inject(c);
        expect(res.statusCode, `${c.method} ${c.url}`).toBe(401);
      }
      // A viewer may read through any spelling but not mutate.
      const read = await app.inject({ url: `${prefix}/civilizations`, headers: bearer(VIEWER) });
      expect(read.statusCode).toBe(200);
      const viewerDelete = await app.inject({
        method: 'DELETE',
        url: `${prefix}/civilizations/${civ.id}`,
        headers: bearer(VIEWER),
        payload: { confirm: 'Guarded' },
      });
      expect(viewerDelete.statusCode).toBe(403);
    }
    expect(await prisma.civilization.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { actor: 'anonymous' } })).toBe(0);

    // Absolute-form request targets and the WebSocket stream over a real socket.
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    for (const target of [
      `http://127.0.0.1:${port}/api/civilizations`,
      `http://127.0.0.1:${port}/%61pi/civilizations`,
    ]) {
      expect(await rawStatus(port, 'GET', target), target).toBe(401);
      expect(await rawStatus(port, 'POST', target, '{"name":"Raw"}'), target).toBe(401);
    }
    for (const path of [
      `/%61pi/civilizations/${civ.id}/stream`,
      `/api/civilizations/${civ.id}/stream`,
    ]) {
      expect(await upgradeStatus(`ws://127.0.0.1:${port}${path}`), path).toBe(401);
    }
    expect(await prisma.civilization.count()).toBe(1);
  });

  it('accepts ?token= only on WebSocket upgrades of the stream route', async () => {
    app = await startApp(prisma, {
      AUTH_MODE: 'token',
      OPERATOR_TOKEN: OPERATOR,
      VIEWER_TOKEN: VIEWER,
    });
    const civ = await createCivilization(app, { name: 'Query' }, bearer(OPERATOR));
    const cases = [
      { method: 'GET', url: `/api/civilizations?token=${VIEWER}&x=/stream` },
      { method: 'GET', url: `/api/civilizations/${civ.id}?q=/stream&token=${OPERATOR}` },
      {
        method: 'POST',
        url: `/api/civilizations/${civ.id}/control?token=${OPERATOR}&q=/stream`,
        payload: { action: 'step' },
      },
      {
        method: 'DELETE',
        url: `/api/civilizations/${civ.id}?token=${OPERATOR}&q=/stream`,
        payload: { confirm: 'Query' },
      },
      // The stream route itself without an upgrade.
      { method: 'GET', url: `/api/civilizations/${civ.id}/stream?token=${OPERATOR}` },
    ] as const;
    for (const c of cases) {
      const res = await app.inject(c);
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(401);
    }
    expect(await prisma.civilization.count()).toBe(1);
  });

  it('fails closed for unlisted /api routes and leaves non-API routes public', () => {
    expect(requiredAccess('GET', '/api/civilizations')).toBe('read');
    expect(requiredAccess('HEAD', '/api/civilizations/:id')).toBe('read');
    expect(requiredAccess('DELETE', '/api/civilizations/:id')).toBe('operate');
    expect(requiredAccess('GET', '/api/health')).toBe('public');
    expect(requiredAccess('GET', '/api/debug/:id')).toBe('operate');
    expect(requiredAccess('POST', '/api/health')).toBe('operate');
    expect(requiredAccess('GET', '/*')).toBe('public');
    expect(requiredAccess('GET', undefined)).toBe('public');
  });

  it('redactUrl hides token values only', () => {
    expect(redactUrl('/api/x/stream?token=abc&y=1')).toBe('/api/x/stream?token=[redacted]&y=1');
    expect(redactUrl('/api/x?a=1&token=abc')).toBe('/api/x?a=1&token=[redacted]');
    expect(redactUrl('/api/x?tokens=1')).toBe('/api/x?tokens=1');
  });
});

describe('AUTH_MODE=disabled and DNS rebinding', () => {
  it('serves only requests addressed to a loopback host', async () => {
    app = await startApp(prisma);
    for (const host of [
      'localhost',
      'localhost:5173',
      '127.0.0.1:3001',
      '[::1]:3001',
      'ui.localhost',
    ]) {
      const res = await app.inject({ url: '/api/civilizations', headers: { host } });
      expect(res.statusCode, host).toBe(200);
    }
    for (const host of [
      'attacker.example:3001',
      'attacker.example',
      '127.0.0.1.attacker.example',
      'localhost.attacker.example',
      'evil.com@127.0.0.1',
      '10.0.0.5:3001',
    ]) {
      const read = await app.inject({ url: '/api/civilizations', headers: { host } });
      expect(read.statusCode, host).toBe(403);
      const create = await app.inject({
        method: 'POST',
        url: '/api/civilizations',
        headers: { host },
        payload: { name: 'Rebound' },
      });
      expect(create.statusCode, host).toBe(403);
      expect(create.json<ApiErrorBody>().error.code).toBe('FORBIDDEN');
    }
    expect(await prisma.civilization.count()).toBe(0);
  });

  it('rejects browser requests and stream upgrades from foreign origins', async () => {
    app = await startApp(prisma, { CORS_ORIGINS: 'http://ui.test:8080' });
    const create = (origin: string, name: string) =>
      app!.inject({
        method: 'POST',
        url: '/api/civilizations',
        headers: { origin },
        payload: { name, config: { population: 10 } },
      });
    expect((await create('http://attacker.example:3001', 'Foreign')).statusCode).toBe(403);
    expect((await create('null', 'Opaque')).statusCode).toBe(403);
    expect((await create('http://localhost:5173', 'Local')).statusCode).toBe(201);
    expect((await create('http://127.0.0.1:4173', 'Loopback')).statusCode).toBe(201);
    expect((await create('http://ui.test:8080', 'Listed')).statusCode).toBe(201);
    expect(await prisma.civilization.count()).toBe(3);

    const civ = await prisma.civilization.findFirstOrThrow({ where: { name: 'Local' } });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const url = `ws://127.0.0.1:${port}/api/civilizations/${civ.id}/stream`;
    expect(await upgradeStatus(url, { origin: 'http://attacker.example' })).toBe(403);
    expect(await upgradeStatus(url, { host: `attacker.example:${port}` })).toBe(403);
    expect(await upgradeStatus(url, { origin: 'http://localhost:5173' })).toBe(101);
  });
});

describe('input validation and errors', () => {
  beforeEach(async () => {
    app = await startApp(prisma);
  });

  it('rejects invalid bodies with details and unknown fields', async () => {
    const res = await app!.inject({
      method: 'POST',
      url: '/api/civilizations',
      payload: { name: '', seed: 'bad seed!', extra: 1 },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<ApiErrorBody>();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    const paths = (body.error.details as { path: string }[]).map((d) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['name', 'seed']));
    expect(JSON.stringify(body.error.details)).toContain('extra');

    const config = await app!.inject({
      method: 'POST',
      url: '/api/civilizations',
      payload: { name: 'Ok', config: { population: 3 } },
    });
    expect(config.statusCode).toBe(400);
  });

  it('rejects malformed JSON and invalid control commands', async () => {
    const civ = await createCivilization(app!);
    const malformed = await app!.inject({
      method: 'POST',
      url: `/api/civilizations/${civ.id}/control`,
      headers: { 'content-type': 'application/json' },
      payload: '{"action":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<ApiErrorBody>().error.code).toBe('VALIDATION_ERROR');
    for (const payload of [
      { action: 'fly' },
      { action: 'step', steps: 0 },
      { action: 'step', steps: 1001 },
      { action: 'start', steps: 1 },
    ]) {
      const res = await app!.inject({
        method: 'POST',
        url: `/api/civilizations/${civ.id}/control`,
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const speed = await app!.inject({
      method: 'PUT',
      url: `/api/civilizations/${civ.id}/speed`,
      payload: { ticksPerSecond: 5000 },
    });
    expect(speed.statusCode).toBe(400);
  });

  it('validates path parameters and query strings', async () => {
    const civ = await createCivilization(app!);
    const cases: [string, number][] = [
      ['/api/civilizations/not-a-uuid', 400],
      [`/api/civilizations/${MISSING}`, 404],
      [`/api/civilizations/${MISSING}/citizens`, 404],
      [`/api/civilizations/${MISSING}/events`, 404],
      [`/api/civilizations/${MISSING}/layout`, 404],
      [`/api/civilizations/${civ.id}/citizens/abc`, 400],
      [`/api/civilizations/${civ.id}/citizens/0`, 400],
      [`/api/civilizations/${civ.id}/citizens/99999`, 404],
      [`/api/civilizations/${civ.id}/buildings/99999`, 404],
      [`/api/civilizations/${civ.id}/citizens?limit=1000`, 400],
      [`/api/civilizations/${civ.id}/citizens?sort=height`, 400],
      [`/api/civilizations/${civ.id}/citizens?bogus=1`, 400],
      [`/api/civilizations/${civ.id}/events?types=Nope`, 400],
      [`/api/civilizations/${civ.id}/events?before=5&after=1`, 400],
      [`/api/civilizations/${civ.id}/metrics?keys=nope.key`, 400],
      [`/api/civilizations/${civ.id}/metrics?fromTick=10&toTick=5`, 400],
      [`/api/civilizations/${civ.id}/stream`, 400],
      ['/api/nothing-here', 404],
    ];
    for (const [url, status] of cases) {
      const res = await app!.inject({ url });
      expect(res.statusCode, url).toBe(status);
      expect(res.json<ApiErrorBody>().error.code, url).toBeTypeOf('string');
    }
  });

  it('rejects duplicate names with 409', async () => {
    await createCivilization(app!, { name: 'Twin' });
    const res = await app!.inject({
      method: 'POST',
      url: '/api/civilizations',
      payload: { name: 'Twin' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<ApiErrorBody>().error.code).toBe('CONFLICT');
  });
});

describe('static web app', () => {
  it('serves files and falls back to index.html for client routes, never for /api', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'civ-web-'));
    try {
      mkdirSync(join(dir, 'assets'));
      writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Observatory</title>');
      writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1);');
      app = await startApp(prisma, { WEB_DIST_DIR: dir });
      const root = await app.inject({ url: '/' });
      expect(root.statusCode).toBe(200);
      expect(root.body).toContain('Observatory');
      const asset = await app.inject({ url: '/assets/app.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-type']).toContain('javascript');
      const clientRoute = await app.inject({ url: '/civilizations/123/citizens' });
      expect(clientRoute.statusCode).toBe(200);
      expect(clientRoute.headers['content-type']).toContain('text/html');
      expect(clientRoute.body).toContain('Observatory');
      const api = await app.inject({ url: '/api/unknown' });
      expect(api.statusCode).toBe(404);
      expect(api.json<ApiErrorBody>().error.code).toBe('NOT_FOUND');
      const post = await app.inject({ method: 'POST', url: '/somewhere' });
      expect(post.statusCode).toBe(404);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
