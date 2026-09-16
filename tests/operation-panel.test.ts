import crypto from 'node:crypto';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { client } from '../src/discord/client';
import { markClientReady } from '../src/discord/ready';
import { deleteRecording, readMeta, saveMeta, saveMinutes, saveTranscript, type RecordingMeta } from '../src/store';
import { createWebApp } from '../src/web/server';
import { createWebSession, revokeWebSession } from '../src/web/webSessions';

const ORIGIN = 'http://localhost:8080';
const GUILD = '920000000000000010';
const CHANNEL = '920000000000000011';
const sessions: string[] = [];
const recordings: string[] = [];
let fixtureSequence = 0;

function signedSession(userId: string, scope: 'full' | 'revoke-only' = 'full'): string {
  const exp = Date.now() + 60_000;
  const sid = createWebSession(userId, exp, scope);
  sessions.push(sid);
  const body = Buffer.from(
    JSON.stringify({
      typ: 'session',
      iss: config.instanceId,
      aud: config.appUrl,
      id: userId,
      name: 'Pessoa sintética',
      avatar: null,
      scope,
      exp,
      jti: sid,
    }),
  ).toString('base64url');
  const mac = crypto.createHmac('sha256', config.cookieSecret).update(body).digest('base64url');
  return `kassinao_session=${encodeURIComponent(`${body}.${mac}`)}`;
}

function fixture(initiatorId?: string) {
  const sequence = ++fixtureSequence;
  const id = `operation-http-${sequence}`;
  const initiator = initiatorId ?? String(920000000000001000n + BigInt(sequence));
  const participant = String(920000000000002000n + BigInt(sequence));
  const source = { startMs: 1000, endMs: 3000, quote: `Vamos conferir a entrega sintética ${sequence}.` };
  const now = Date.now();
  const meta: RecordingMeta = {
    id,
    guildId: GUILD,
    guildName: 'Servidor sintético',
    voiceChannelId: CHANNEL,
    voiceChannelName: 'Reunião sintética',
    startedBy: { id: initiator, name: 'Iniciador sintético' },
    startedAt: now - 60_000,
    endedAt: now,
    status: 'done',
    audioDeleted: true,
    participants: [
      { id: participant, name: 'Participante sintético', avatar: null, trackFile: 'fixture.flac', index: 0 },
    ],
    events: [],
    notes: [],
    transcription: { status: 'done', finishedAt: now },
    minutes: { status: 'done', finishedAt: now },
  };
  saveMeta(meta);
  saveTranscript(id, [{ ...source, speaker: 'Participante sintético', text: source.quote }]);
  saveMinutes(id, {
    resumo: 'Resumo sintético.',
    decisoes: [],
    acoes: [{ tarefa: `Tarefa sintética ${sequence}`, prazo: 'amanhã', source }],
    topicos: [],
    porParticipante: [],
  });
  recordings.push(id);
  return { id, initiator, participant };
}

interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe('título da gravação e painel de operação pelo servidor HTTP real', () => {
  let server: http.Server;
  let baseUrl: string;
  const unexpectedFetch = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('HTTP externo proibido neste teste'));

  beforeAll(async () => {
    markClientReady();
    client.guilds.cache.set(GUILD, {
      id: GUILD,
      name: 'Servidor sintético',
      available: true,
      members: {
        cache: new Map(),
        fetch: async () => ({ permissions: { has: () => false } }),
      },
      scheduledEvents: { fetch: async () => new Map() },
      channels: {
        cache: new Map([
          [CHANNEL, { id: CHANNEL, name: 'Reunião sintética', type: 2, permissionsFor: () => ({ has: () => true }) }],
        ]),
      },
    } as never);
    server = http.createServer(createWebApp());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Servidor HTTP sem porta');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    for (const sid of sessions) revokeWebSession(sid);
    for (const id of recordings) deleteRecording(id);
    client.guilds.cache.delete(GUILD);
    server?.closeAllConnections();
    if (server?.listening)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    expect(unexpectedFetch).not.toHaveBeenCalled();
    unexpectedFetch.mockRestore();
  });

  function request(
    method: 'GET' | 'POST',
    pathname: string,
    headers: Record<string, string> = {},
    body?: string,
  ): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}${pathname}`, {
        method,
        headers: { host: 'localhost:8080', 'accept-language': 'pt-BR', ...headers },
      });
      req.setTimeout(5000, () => req.destroy(new Error(`HTTP sintético não respondeu: ${method} ${pathname}`)));
      req.once('error', reject);
      req.once('response', (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.once('error', reject);
        res.once('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      });
      req.end(body);
    });
  }

  const get = (pathname: string, cookie?: string) => request('GET', pathname, cookie ? { cookie } : {});
  const post = (pathname: string, cookie: string, body: Record<string, string>, origin = ORIGIN) =>
    request(
      'POST',
      pathname,
      { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' },
      new URLSearchParams(body).toString(),
    );

  it('iniciador salva título como texto; participante não gerencia e entradas inválidas são recusadas', async () => {
    const f = fixture();
    const cookie = signedSession(f.initiator);
    const title = '<script>alert("fixture")</script> & pauta';
    const response = await post(`/app/rec/${f.id}/titulo`, cookie, { title });
    expect(response.status).toBe(303);
    expect(readMeta(f.id)?.title).toBe(title);
    const page = await get(`/app/rec/${f.id}`, cookie);
    expect(page.status).toBe(200);
    expect(page.body).not.toContain(title);
    expect(page.body).toContain('&lt;script&gt;');
    expect(page.body).toContain('&amp; pauta');
    expect(
      (await post(`/app/rec/${f.id}/titulo`, signedSession(f.participant), { title: 'Sem permissão' })).status,
    ).toBe(404);
    for (const invalid of ['x'.repeat(121), 'Título\nquebrado']) {
      expect((await post(`/app/rec/${f.id}/titulo`, cookie, { title: invalid })).status).toBe(400);
    }
    expect(readMeta(f.id)?.title).toBe(title);
  });

  it('painel de operação só abre para o dono da instância com sessão completa', async () => {
    const owner = config.ownerIds[0];
    expect(owner).toBeTruthy();
    expect((await get('/app/operacao')).status).toBe(404);
    expect((await get('/app/operacao', signedSession('920000000000005001'))).status).toBe(404);
    expect((await get('/app/operacao', signedSession(owner, 'revoke-only'))).status).toBe(403);
    const response = await get('/app/operacao', signedSession(owner));
    expect(response.status).toBe(200);
    expect(response.body).toContain('Gravações no acervo');
    expect(response.body).toContain('Não comprovada por este painel');
    expect(response.body).not.toContain(config.cookieSecret);
  });
});
