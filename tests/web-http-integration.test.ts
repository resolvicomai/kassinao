import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Request } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { client } from '../src/discord/client';
import { markClientReady } from '../src/discord/ready';
import {
  cacheDir,
  deleteRecording,
  readMeta,
  recordingDir,
  saveMeta,
  tracksDir,
  type RecordingMeta,
} from '../src/store';
import { createWebApp, webMutationRouteClass, webOriginRejectionReason } from '../src/web/server';
import { createWebSession, revokeWebSession } from '../src/web/webSessions';

const APP_ORIGIN = 'http://localhost:8080';
const TEST_USER_ID = 'http-integration-user';
const TEST_GUILD_ID = 'http-integration-guild';

function signedSession(scope: 'full' | 'revoke-only' = 'full'): { cookie: string; sid: string } {
  const exp = Date.now() + 60_000;
  const sid = createWebSession(TEST_USER_ID, exp, scope);
  const body = Buffer.from(
    JSON.stringify({
      typ: 'session',
      iss: config.instanceId,
      aud: config.appUrl,
      id: TEST_USER_ID,
      name: 'Pessoa de teste',
      avatar: null,
      scope,
      exp,
      jti: sid,
    }),
  ).toString('base64url');
  const mac = crypto.createHmac('sha256', config.cookieSecret).update(body).digest('base64url');
  return { cookie: `kassinao_session=${encodeURIComponent(`${body}.${mac}`)}`, sid };
}

function recording(id: string): RecordingMeta {
  return {
    id,
    guildId: TEST_GUILD_ID,
    guildName: 'Servidor de teste',
    voiceChannelId: 'voice-test',
    voiceChannelName: 'Reunião',
    startedBy: { id: TEST_USER_ID, name: 'Pessoa de teste' },
    startedAt: Date.now() - 60_000,
    endedAt: Date.now(),
    status: 'done',
    participants: [],
    events: [],
    notes: [],
  };
}

describe('app privado por HTTP real', () => {
  let server: http.Server;
  let baseUrl: string;
  const createdRecordingIds = new Set<string>();

  beforeAll(async () => {
    markClientReady();
    client.guilds.cache.set(TEST_GUILD_ID, {
      members: {
        fetch: async () => ({ permissions: { has: () => false } }),
      },
    } as never);

    server = http.createServer(createWebApp());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('servidor HTTP de teste sem porta');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    client.guilds.cache.delete(TEST_GUILD_ID);
    for (const id of createdRecordingIds) deleteRecording(id);
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  interface HttpResponse {
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
  }

  async function request(
    method: 'GET' | 'POST',
    pathname: string,
    headers: Record<string, string> = {},
    body?: string,
  ): Promise<HttpResponse> {
    return new Promise<HttpResponse>((resolve, reject) => {
      const req = http.request(`${baseUrl}${pathname}`, {
        method,
        headers: { host: 'localhost:8080', 'accept-language': 'pt-BR', ...headers },
      });
      req.once('error', reject);
      req.once('response', (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.once('error', reject);
        res.once('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      });
      req.end(body);
    });
  }

  const post = (pathname: string, headers: Record<string, string> = {}) => request('POST', pathname, headers);

  function classifiedRequest(pathname: string, headers: Record<string, string>): Request {
    return {
      method: 'POST',
      originalUrl: pathname,
      get(name: string) {
        return headers[name.toLowerCase()];
      },
    } as unknown as Request;
  }

  it('aceita a origem canônica e rejeita Origin null ou divergente antes da rota', async () => {
    const accepted = await post('/app/logout', { origin: APP_ORIGIN });
    expect(accepted.status).toBe(303);
    expect(accepted.headers.location).toBe('/');
    expect(accepted.headers['referrer-policy']).toBe('same-origin');

    for (const origin of ['null', 'https://kassinao.cloud', 'https://evil.example']) {
      const rejected = await post('/app/logout', { origin });
      expect(rejected.status).toBe(403);
      expect(rejected.headers['content-type']).toContain('text/html');
      expect(rejected.body).toContain('Não foi possível confirmar a ação');
      expect(rejected.body).toContain('Volte às reuniões');
    }
    const logoutLocaleFallback = await request('GET', '/app/logout?lang=en');
    expect(logoutLocaleFallback.status).toBe(303);
    expect(logoutLocaleFallback.headers.location).toBe('/app');

    const oauthError = await request('GET', '/auth/callback?code=sensitive-code&state=invalid');
    expect(oauthError.status).toBe(400);
    expect(oauthError.headers['referrer-policy']).toBe('no-referrer');

    const session = signedSession();
    const contextual = await post('/app/rec/origin-context/liberar-audio', {
      origin: 'null',
      cookie: session.cookie,
    });
    expect(contextual.status).toBe(403);
    expect(contextual.body).toContain('href="/app/rec/origin-context"');
    expect(contextual.body).toContain('Voltar à gravação');
    revokeWebSession(session.sid);
  });

  it('mostra a fronteira privada sem iniciar OAuth e não publica detalhes de health', async () => {
    const boundary = await request('GET', '/app');
    expect(boundary.status).toBe(200);
    expect(boundary.body).toContain('Instância privada');
    expect(boundary.body).toContain('/auth/login?next=%2Fapp');
    expect(boundary.body).not.toContain('discord.com/oauth2/authorize');
    expect(boundary.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');

    const details = await request('GET', '/health/details');
    expect(details.status).toBe(404);
    expect(details.body).not.toContain('freeMB');
    expect(details.body).not.toContain('activeRecordings');

    const internal = await request('GET', '/health/internal');
    expect(internal.status).toBe(404);
    expect(internal.body).not.toContain('activeRecordings');

    const badHost = await request('GET', '/app', { host: 'evil.example' });
    expect(badHost.status).toBe(421);
    expect(badHost.headers['x-content-type-options']).toBe('nosniff');
    expect(badHost.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('publica a política dinâmica da instância sem login e mantém o app fora de índice', async () => {
    const policy = await request('GET', '/privacy');
    expect(policy.status).toBe(200);
    expect(policy.headers['content-type']).toContain('text/html');
    expect(policy.headers['content-language']).toBe('pt-BR');
    expect(policy.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
    expect(policy.body).toContain('Política de privacidade da instância');
    expect(policy.body).toContain(config.operatorName);
    expect(policy.body).toContain('O Kassinão não criptografa o volume ativo');
    expect(policy.body).toContain(`Áudio: ${config.retentionDays} dias.`);
    expect(policy.body).not.toContain(config.cookieSecret);
    expect(policy.body).not.toContain(config.mcpSecret);

    const english = await request('GET', '/en/privacy');
    expect(english.status).toBe(200);
    expect(english.headers['content-language']).toBe('en');
    expect(english.body).toContain('Instance Privacy Policy');
    expect(english.body).toContain('does not encrypt the active volume at the application layer');
  });

  it('sanitiza erros do parser em bare-node sem devolver stack ou caminho local', async () => {
    const malformed = await request('POST', '/api/mcp/exchange', { 'content-type': 'application/json' }, '{"code":');
    expect(malformed.status).toBe(400);
    expect(malformed.headers['content-type']).toContain('application/json');
    expect(JSON.parse(malformed.body)).toEqual({ error: 'bad_request' });
    expect(malformed.body).not.toContain('node_modules');
    expect(malformed.body).not.toContain('/Users/');
    expect(malformed.body).not.toContain('at ');
  });

  it('limita sessão de ex-membro a gestão e revogação das próprias conexões', async () => {
    const session = signedSession('revoke-only');
    const connections = await request('GET', '/app/conectar-ia', { cookie: session.cookie });
    expect(connections.status).toBe(200);
    expect(connections.body).toContain('Acesso somente para revogação');
    expect(connections.body).not.toContain('action="/app/conectar-ia/gerar"');
    expect(connections.body).not.toContain('href="/app" aria-current');

    const recording = await request('GET', '/app/rec/qualquer', { cookie: session.cookie });
    expect(recording.status).toBe(403);
    expect(recording.body).not.toContain('Gravação não encontrada');
    revokeWebSession(session.sid);
  });

  it('classifica bloqueios de origem e rotas sem expor valores nem identificadores', () => {
    const cases = [
      {
        req: classifiedRequest('/app/rec/private-recording-id/liberar-audio', { origin: 'null' }),
        reason: 'null',
        route: 'recording-release',
      },
      {
        req: classifiedRequest('/app/rec/another-private-id/delete', { 'sec-fetch-site': 'cross-site' }),
        reason: 'missing',
        route: 'recording-delete',
      },
      {
        req: classifiedRequest('/app/conectar-ia/gerar', { origin: 'https://secret-sibling.example' }),
        reason: 'mismatch',
        route: 'mcp-generate',
      },
      {
        req: classifiedRequest('/app/conectar-ia/revogar/private-session-id', { origin: 'not a url' }),
        reason: 'malformed',
        route: 'mcp-revoke',
      },
    ] as const;

    for (const example of cases) {
      expect(webOriginRejectionReason(example.req, APP_ORIGIN)).toBe(example.reason);
      const route = webMutationRouteClass(example.req);
      expect(route).toBe(example.route);
      expect(route).not.toContain('private');
      expect(route).not.toContain('secret');
    }
    expect(webOriginRejectionReason(classifiedRequest('/app/logout', { origin: APP_ORIGIN }), APP_ORIGIN)).toBe(
      undefined,
    );
    expect(webMutationRouteClass(classifiedRequest('/app/logout', {}))).toBe('logout');
  });

  it('libera somente o áudio, redireciona e mostra o estado final na gravação', async () => {
    const id = `http-free-${crypto.randomUUID()}`;
    createdRecordingIds.add(id);
    saveMeta(recording(id));
    fs.mkdirSync(tracksDir(id), { recursive: true });
    fs.mkdirSync(cacheDir(id), { recursive: true });
    fs.writeFileSync(path.join(tracksDir(id), 'speaker.opus'), 'audio');
    fs.writeFileSync(path.join(cacheDir(id), 'mix.mp3'), 'cache');
    const session = signedSession();

    const response = await post(`/app/rec/${id}/liberar-audio`, {
      origin: APP_ORIGIN,
      cookie: session.cookie,
    });

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(`/app/rec/${id}?freed=1#exportar`);
    expect(readMeta(id)?.audioDeleted).toBe(true);
    expect(fs.existsSync(tracksDir(id))).toBe(false);
    expect(fs.existsSync(cacheDir(id))).toBe(false);
    expect(fs.existsSync(recordingDir(id))).toBe(true);

    const finalPage = await request('GET', `/app/rec/${id}?freed=1`, { cookie: session.cookie });
    expect(finalPage.status).toBe(200);
    expect(finalPage.body).toContain('Espaço liberado');
    expect(finalPage.body).toContain('O áudio já foi liberado');
    expect(finalPage.body).not.toContain(`action="/app/rec/${id}/liberar-audio"`);
    revokeWebSession(session.sid);
  });

  it('apaga a gravação, redireciona e não deixa estado residual acessível', async () => {
    const id = `http-delete-${crypto.randomUUID()}`;
    createdRecordingIds.add(id);
    saveMeta(recording(id));
    fs.mkdirSync(tracksDir(id), { recursive: true });
    fs.writeFileSync(path.join(tracksDir(id), 'speaker.opus'), 'audio');
    const session = signedSession();

    const response = await post(`/app/rec/${id}/delete`, {
      origin: APP_ORIGIN,
      cookie: session.cookie,
    });

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe('/app?deleted=1');
    expect(readMeta(id)).toBeUndefined();
    expect(fs.existsSync(recordingDir(id))).toBe(false);

    const gone = await request('GET', `/app/rec/${id}`, { cookie: session.cookie });
    expect(gone.status).toBe(404);
    expect(gone.body).toContain('Gravação não encontrada');
    revokeWebSession(session.sid);
  });

  it('serializa liberar e apagar em abas concorrentes sem ressuscitar a gravação', async () => {
    const id = `http-race-${crypto.randomUUID()}`;
    createdRecordingIds.add(id);
    saveMeta(recording(id));
    fs.mkdirSync(tracksDir(id), { recursive: true });
    fs.writeFileSync(path.join(tracksDir(id), 'speaker.opus'), 'audio');
    const session = signedSession();
    const originalGuild = client.guilds.cache.get(TEST_GUILD_ID);
    let fetchCalls = 0;
    let releaseFirstFetch = (): void => undefined;
    let firstFetchStarted = (): void => undefined;
    const firstFetchGate = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstFetchStarted = resolve;
    });

    client.guilds.cache.set(TEST_GUILD_ID, {
      members: {
        fetch: async () => {
          fetchCalls++;
          if (fetchCalls === 1) {
            firstFetchStarted();
            await firstFetchGate;
          }
          return { permissions: { has: () => false } };
        },
      },
    } as never);

    try {
      const release = post(`/app/rec/${id}/liberar-audio`, {
        origin: APP_ORIGIN,
        cookie: session.cookie,
      });
      await started;
      const remove = post(`/app/rec/${id}/delete`, {
        origin: APP_ORIGIN,
        cookie: session.cookie,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(fetchCalls).toBe(1);

      releaseFirstFetch();
      const [released, deleted] = await Promise.all([release, remove]);
      expect(released.status).toBe(303);
      expect(deleted.status).toBe(303);
      expect(readMeta(id)).toBeUndefined();
      expect(fs.existsSync(recordingDir(id))).toBe(false);
    } finally {
      releaseFirstFetch();
      if (originalGuild) client.guilds.cache.set(TEST_GUILD_ID, originalGuild);
      revokeWebSession(session.sid);
    }
  });

  it('revalida a gravação depois do await de acesso para não desfazer o cleanup', async () => {
    const id = `http-cleanup-race-${crypto.randomUUID()}`;
    createdRecordingIds.add(id);
    saveMeta(recording(id));
    fs.mkdirSync(tracksDir(id), { recursive: true });
    fs.writeFileSync(path.join(tracksDir(id), 'speaker.opus'), 'audio');
    const session = signedSession();
    const originalGuild = client.guilds.cache.get(TEST_GUILD_ID);
    let releaseFetch = (): void => undefined;
    let fetchStarted = (): void => undefined;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });

    client.guilds.cache.set(TEST_GUILD_ID, {
      members: {
        fetch: async () => {
          fetchStarted();
          await fetchGate;
          return { permissions: { has: () => false } };
        },
      },
    } as never);

    try {
      const release = post(`/app/rec/${id}/liberar-audio`, {
        origin: APP_ORIGIN,
        cookie: session.cookie,
      });
      await started;
      deleteRecording(id);
      releaseFetch();

      const response = await release;
      expect(response.status).toBe(404);
      expect(readMeta(id)).toBeUndefined();
      expect(fs.existsSync(recordingDir(id))).toBe(false);
    } finally {
      releaseFetch();
      if (originalGuild) client.guilds.cache.set(TEST_GUILD_ID, originalGuild);
      revokeWebSession(session.sid);
    }
  });

  it('mantém erros de player e downloads dentro do app com volta para a gravação', async () => {
    const id = `http-errors-${crypto.randomUUID()}`;
    createdRecordingIds.add(id);
    saveMeta(recording(id));
    const session = signedSession();

    for (const pathname of [`/app/rec/${id}/audio`, `/app/rec/${id}/ata.md`, `/app/rec/${id}/transcricao.md`]) {
      const response = await request('GET', pathname, { cookie: session.cookie });
      expect(response.status).toBe(404);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain(`href="/app/rec/${id}"`);
      expect(response.body).toContain('Voltar à gravação');
    }

    const withoutAudio = recording(id);
    withoutAudio.audioDeleted = true;
    withoutAudio.participants = [
      {
        id: TEST_USER_ID,
        name: 'Pessoa de teste',
        avatar: null,
        trackFile: 'speaker.opus',
        index: 0,
      },
    ];
    saveMeta(withoutAudio);

    const expiredDownload = await request('GET', `/app/rec/${id}/download/mp3`, { cookie: session.cookie });
    expect(expiredDownload.status).toBe(410);
    expect(expiredDownload.headers['content-type']).toContain('text/html');
    expect(expiredDownload.body).toContain(`href="/app/rec/${id}"`);
    expect(expiredDownload.body).toContain('A transcrição e a ata continuam na página');

    const alreadyFreed = await post(`/app/rec/${id}/liberar-audio`, {
      origin: APP_ORIGIN,
      cookie: session.cookie,
    });
    expect(alreadyFreed.status).toBe(200);
    expect(alreadyFreed.body).toContain(`href="/app/rec/${id}"`);
    expect(alreadyFreed.body).toContain('Áudio já liberado');
    revokeWebSession(session.sid);
  });

  it('responde dentro do app quando o disco falha ao liberar o áudio, sem vazar detalhes no log', async () => {
    const id = `http-free-failure-${crypto.randomUUID()}`;
    createdRecordingIds.add(id);
    saveMeta(recording(id));
    fs.mkdirSync(tracksDir(id), { recursive: true });
    fs.writeFileSync(path.join(tracksDir(id), 'speaker.opus'), 'audio');
    const session = signedSession();
    const realRmSync = fs.rmSync;
    const target = path.resolve(tracksDir(id));
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation((entry, options) => {
      if (path.resolve(String(entry)) === target) {
        throw Object.assign(new Error(`disk full at ${target}`), { code: 'ENOSPC' });
      }
      realRmSync(entry, options);
    });
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await post(`/app/rec/${id}/liberar-audio`, {
        origin: APP_ORIGIN,
        cookie: session.cookie,
      });

      expect(response.status).toBe(500);
      expect(response.body).toContain('Não foi possível liberar o áudio');
      expect(response.body).toContain(`href="/app/rec/${id}"`);
      expect(readMeta(id)?.audioDeleted).not.toBe(true);
      const logged = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(logged).toContain('mutation_error=io');
      expect(logged).not.toContain(id);
      expect(logged).not.toContain(config.recordingsDir);
    } finally {
      rmSpy.mockRestore();
      logSpy.mockRestore();
      revokeWebSession(session.sid);
    }
  });

  it('responde dentro do app quando o disco falha ao apagar, sem perder a gravação nem vazar detalhes', async () => {
    const id = `http-delete-failure-${crypto.randomUUID()}`;
    createdRecordingIds.add(id);
    saveMeta(recording(id));
    const session = signedSession();
    const realRmSync = fs.rmSync;
    const target = path.resolve(recordingDir(id));
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation((entry, options) => {
      if (path.resolve(String(entry)) === target) {
        throw Object.assign(new Error(`permission denied at ${target}`), { code: 'EACCES' });
      }
      realRmSync(entry, options);
    });
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await post(`/app/rec/${id}/delete`, {
        origin: APP_ORIGIN,
        cookie: session.cookie,
      });

      expect(response.status).toBe(500);
      expect(response.body).toContain('Não foi possível apagar a gravação');
      expect(response.body).toContain(`href="/app/rec/${id}"`);
      expect(readMeta(id)).toBeDefined();
      expect(fs.existsSync(recordingDir(id))).toBe(true);
      const logged = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(logged).toContain('mutation_error=permission');
      expect(logged).not.toContain(id);
      expect(logged).not.toContain(config.recordingsDir);
    } finally {
      rmSpy.mockRestore();
      logSpy.mockRestore();
      revokeWebSession(session.sid);
    }
  });

  it('gera o código MCP com PRG sem colocar o segredo na URL e o exibe uma vez', async () => {
    const session = signedSession();
    const generated = await request(
      'POST',
      '/app/conectar-ia/gerar',
      {
        origin: APP_ORIGIN,
        cookie: session.cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      'label=Notebook',
    );

    expect(generated.status).toBe(303);
    expect(generated.headers.location).toBe('/app/conectar-ia/codigo');

    const crossSite = await request('GET', '/app/conectar-ia/codigo', {
      cookie: session.cookie,
      'sec-fetch-site': 'same-site',
    });
    expect(crossSite.status).toBe(303);
    expect(crossSite.headers.location).toBe('/app/conectar-ia');

    const display = await request('GET', '/app/conectar-ia/codigo', {
      cookie: session.cookie,
      'sec-fetch-site': 'same-origin',
    });
    expect(display.status).toBe(200);
    expect(display.body).toContain('Use este código agora.');
    expect(display.body).toContain('Notebook');
    const code = /<pre id="kcode"[^>]*>([^<]+)<\/pre>/.exec(display.body)?.[1];
    expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(generated.headers.location).not.toContain(code!);

    const replay = await request('GET', '/app/conectar-ia/codigo', {
      cookie: session.cookie,
      'sec-fetch-site': 'same-origin',
    });
    expect(replay.status).toBe(303);
    expect(replay.headers.location).toBe('/app/conectar-ia');
    revokeWebSession(session.sid);
  });

  it('renderiza o rate limit global do app dentro da interface e sem cache privado', async () => {
    const session = signedSession();
    let limited: HttpResponse | undefined;
    for (let attempt = 0; attempt < 140; attempt++) {
      const response = await request('GET', '/app/rec/rate-limit-missing', { cookie: session.cookie });
      if (response.status === 429) {
        limited = response;
        break;
      }
    }

    expect(limited?.headers['content-type']).toContain('text/html');
    expect(limited?.headers['cache-control']).toContain('private, no-store');
    expect(limited?.headers['content-language']).toBe('pt-BR');
    expect(limited?.body).toContain('Muitas requisições');
    expect(limited?.body).toContain('Voltar à gravação');
    expect(limited?.body).toContain('href="/app/rec/rate-limit-missing"');
    revokeWebSession(session.sid);
  });
});
