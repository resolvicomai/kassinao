import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { contextRuntime, syncContextMeeting } from '../src/context';
import { createCommitmentService } from '../src/commitments';
import { client } from '../src/discord/client';
import { markClientReady } from '../src/discord/ready';
import { deleteRecording, readMeta, saveMeta, saveMinutes, saveTranscript, type RecordingMeta } from '../src/store';
import { createWebApp } from '../src/web/server';
import { createWebSession, revokeWebSession } from '../src/web/webSessions';

const ORIGIN = 'http://localhost:8080';
const GUILD = 'context-http-guild';
const sessions: string[] = [];
const recordings: string[] = [];
const membership = new Map<string, 'revoked' | 'unavailable'>();
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

/** Separate service instance reads the persisted result without changing the HTTP ACL double. */
const persisted = () => createCommitmentService({ stateDir: config.stateDir, authorize: async () => true });

async function fixture(initiatorId?: string) {
  const sequence = ++fixtureSequence;
  const id = `context-http-${sequence}`;
  const initiator = initiatorId ?? `context-owner-${sequence}`;
  const participant = `context-participant-${sequence}`;
  const task = `Conteúdo reservado sintético ${sequence}`;
  const source = { startMs: 1000, endMs: 3000, quote: `Vamos conferir a entrega sintética ${sequence}.` };
  const now = Date.now();
  const meta: RecordingMeta = {
    id,
    guildId: GUILD,
    guildName: 'Servidor sintético',
    voiceChannelId: 'context-http-channel',
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
    acoes: [{ tarefa: task, prazo: 'amanhã', source }],
    topicos: [],
    porParticipante: [],
  });
  recordings.push(id);
  syncContextMeeting(meta);
  const [entry] = await persisted().listForUser(initiator, { meetingId: id });
  if (!entry) throw new Error('Compromisso da fixture não foi persistido');
  return { id, initiator, participant, task, source, entry };
}

interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe('contexto e operação pelo servidor HTTP real', () => {
  let server: http.Server;
  let baseUrl: string;
  const unexpectedFetch = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('HTTP externo proibido neste teste'));

  beforeAll(async () => {
    markClientReady();
    client.guilds.cache.set(GUILD, {
      id: GUILD,
      available: true,
      members: {
        cache: new Map(),
        fetch: async ({ user }: { user: string }) => {
          if (membership.get(user) === 'revoked') throw Object.assign(new Error('Unknown Member'), { code: 10007 });
          if (membership.get(user) === 'unavailable')
            throw Object.assign(new Error('Falha transitória sintética'), { status: 429 });
          return { permissions: { has: () => false } };
        },
      },
      scheduledEvents: { fetch: async () => new Map() },
      channels: { cache: new Map() },
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

  it('exige login e bloqueia sessão restrita à revogação antes de ler ou alterar compromissos', async () => {
    const f = await fixture();
    const anonymous = await get(`/app/contexto?meeting=${f.id}`);
    expect(anonymous.status).toBe(200);
    expect(anonymous.body).toContain('/auth/login');
    expect(anonymous.body).not.toContain(f.task);
    const cookie = signedSession(f.participant, 'revoke-only');
    expect((await get(`/app/contexto?meeting=${f.id}`, cookie)).status).toBe(403);
    expect((await post(`/app/contexto/${f.entry.id}/estado`, cookie, { status: 'completed' })).status).toBe(403);
    expect((await persisted().listForUser(f.participant, { meetingId: f.id }))[0].status).toBe('mentioned');
  });

  it('participante abre a origem e muda estado persistido com autoria', async () => {
    const f = await fixture();
    const cookie = signedSession(f.participant);
    const page = await get(`/app/contexto?meeting=${f.id}`, cookie);
    expect(page.status).toBe(200);
    expect(page.body).toContain(f.task);
    expect(page.body).toContain(f.source.quote);
    const changed = await post(`/app/contexto/${f.entry.id}/estado`, cookie, { status: 'confirmed', meeting: f.id });
    expect(changed.status).toBe(303);
    expect(changed.headers.location).toBe(`/app/contexto?saved=1&meeting=${f.id}#c-${f.entry.id}`);
    expect((await persisted().listForUser(f.participant, { meetingId: f.id }))[0]).toMatchObject({
      status: 'confirmed',
      lastStatusBy: f.participant,
    });
    const saved = await get(changed.headers.location!, cookie);
    expect(saved.body).toContain('Alteração salva.');
    expect(saved.body).toContain(f.participant);
  });

  it('seguir, adiar por sete dias e silenciar persistem apenas para a conta atual', async () => {
    const f = await fixture();
    const cookie = signedSession(f.participant);
    const route = `/app/contexto/${f.entry.id}/avisos`;
    expect((await post(route, cookie, { mode: 'follow' })).status).toBe(303);
    expect((await persisted().listForUser(f.participant, { meetingId: f.id }))[0].preference).toEqual({
      mode: 'follow',
    });
    const before = Date.now();
    expect((await post(route, cookie, { mode: 'mute', snooze: '7' })).status).toBe(303);
    const preference = (await persisted().listForUser(f.participant, { meetingId: f.id }))[0].preference;
    expect(preference.mode).toBe('follow');
    expect(preference.snoozedUntil).toBeGreaterThanOrEqual(before + 7 * 86400000);
    expect(preference.snoozedUntil).toBeLessThanOrEqual(Date.now() + 7 * 86400000);
    expect(await contextRuntime().service.prepareDigest(f.participant)).toMatchObject({ items: [] });
    expect((await persisted().listForUser(f.initiator, { meetingId: f.id }))[0].preference).toEqual({ mode: 'mute' });
    expect((await post(route, cookie, { mode: 'mute' })).status).toBe(303);
    expect((await persisted().listForUser(f.participant, { meetingId: f.id }))[0].preference).toEqual({ mode: 'mute' });
    expect((await post(route, cookie, { mode: 'invalid' })).status).toBe(400);
  });

  it('unifica menções visíveis, aplica estado atomicamente, registra utilidade pessoal e permite separar', async () => {
    const owner = `context-group-owner-${crypto.randomUUID()}`;
    const first = await fixture(owner);
    const second = await fixture(owner);
    const cookie = signedSession(owner);
    const route = `/app/contexto/${first.entry.id}`;
    const entries = () => persisted().listForUser(owner, { meetingIds: [first.id, second.id] });

    expect((await post(`${route}/unificar`, cookie, { other: second.entry.id })).status).toBe(303);
    const grouped = await entries();
    expect(grouped).toHaveLength(2);
    expect(grouped[0].groupId).toBe(grouped[1].groupId);
    expect(grouped[0].directRelatedIds).toEqual([second.entry.id]);
    expect(grouped[1].directRelatedIds).toEqual([first.entry.id]);
    expect(grouped.map((entry) => entry.status)).toEqual(['mentioned', 'mentioned']);
    const page = await get('/app/contexto', cookie);
    expect(page.status).toBe(200);
    expect(page.body).toContain(first.task);
    expect(page.body).toContain(second.task);
    expect(page.body).toContain('menções reunidas');

    expect((await post(`${route}/estado`, cookie, { status: 'confirmed', related: second.entry.id })).status).toBe(303);
    expect((await entries()).map((entry) => [entry.status, entry.lastStatusBy])).toEqual([
      ['confirmed', owner],
      ['confirmed', owner],
    ]);

    // Losing access to one explicit target must leave every target unchanged.
    const original = readMeta(second.id)!;
    const beforeDenied = fs.readFileSync(path.join(config.stateDir, 'commitments.json'), 'utf8');
    saveMeta({ ...original, startedBy: { id: 'another-owner', name: 'Outra pessoa sintética' } });
    try {
      const denied = await post(`${route}/estado`, cookie, { status: 'completed', related: second.entry.id });
      expect(denied.status).toBe(404);
      expect(fs.readFileSync(path.join(config.stateDir, 'commitments.json'), 'utf8')).toBe(beforeDenied);
      const restricted = await get('/app/contexto', cookie);
      expect(restricted.body).toContain(first.task);
      expect(restricted.body).not.toContain(second.task);
      expect(restricted.body).not.toContain(second.source.quote);
      expect(restricted.body).not.toContain(second.entry.id);
    } finally {
      saveMeta(original);
    }
    expect((await entries()).map((entry) => entry.status)).toEqual(['confirmed', 'confirmed']);

    const beforeFeedback = Date.now();
    expect((await post(`${route}/utilidade`, cookie, { feedback: 'useful' })).status).toBe(303);
    const rated = await entries();
    expect(rated[0].preference).toMatchObject({ mode: 'mute', feedback: 'useful' });
    expect(rated[0].preference.feedbackAt).toBeGreaterThanOrEqual(beforeFeedback);
    expect(rated[1].preference.feedback).toBeUndefined();
    expect(
      (await persisted().listForUser(first.participant, { meetingId: first.id }))[0].preference.feedback,
    ).toBeUndefined();
    expect(persisted().feedbackSummary()).toMatchObject({ useful: 1, dismissed: 0, responses: 1 });

    expect((await post(`${route}/separar`, cookie, { other: second.entry.id })).status).toBe(303);
    const separated = await entries();
    expect(separated[0].groupId).not.toBe(separated[1].groupId);
    expect(separated.every((entry) => entry.directRelatedIds?.length === 0 && entry.relatedIds?.length === 0)).toBe(
      true,
    );
    expect(separated.map((entry) => entry.status)).toEqual(['confirmed', 'confirmed']);
    expect(separated[0].preference.feedback).toBe('useful');
    expect((await post(`${route}/estado`, cookie, { status: 'completed', related: second.entry.id })).status).toBe(400);
    expect((await entries()).map((entry) => entry.status)).toEqual(['confirmed', 'confirmed']);
  });

  it('rejeita Origin divergente ou null sem alterar o compromisso', async () => {
    const f = await fixture();
    const cookie = signedSession(f.participant);
    for (const origin of ['https://evil.example', 'null']) {
      const response = await post(`/app/contexto/${f.entry.id}/estado`, cookie, { status: 'completed' }, origin);
      expect(response.status).toBe(403);
      expect(response.body).not.toContain(f.task);
    }
    expect((await persisted().listForUser(f.participant, { meetingId: f.id }))[0].status).toBe('mentioned');
  });

  it('terceiro e participante revogado não leem nem alteram o conteúdo', async () => {
    const f = await fixture();
    for (const user of [`context-outsider-${fixtureSequence}`, f.participant]) {
      if (user === f.participant) membership.set(user, 'revoked');
      const cookie = signedSession(user);
      const page = await get(`/app/contexto?meeting=${f.id}`, cookie);
      expect(page.status).toBe(200);
      expect(page.body).not.toContain(f.task);
      expect(page.body).not.toContain(f.source.quote);
      expect((await post(`/app/contexto/${f.entry.id}/estado`, cookie, { status: 'completed' })).status).toBe(404);
      expect((await post(`/app/contexto/${f.entry.id}/avisos`, cookie, { mode: 'follow' })).status).toBe(404);
    }
    expect((await persisted().listForUser(f.initiator, { meetingId: f.id }))[0].status).toBe('mentioned');
  });

  it('falha transitória da ACL retorna 503 com retry e não vira lista vazia ou alteração', async () => {
    const f = await fixture();
    membership.set(f.participant, 'unavailable');
    const cookie = signedSession(f.participant);
    for (const response of [
      await get(`/app/contexto?meeting=${f.id}`, cookie),
      await post(`/app/contexto/${f.entry.id}/estado`, cookie, { status: 'completed' }),
    ]) {
      expect(response.status).toBe(503);
      expect(response.headers['retry-after']).toBe('5');
      expect(response.body).not.toContain(f.task);
      expect(response.body).not.toContain('Falha transitória sintética');
    }
    expect((await persisted().listForUser(f.initiator, { meetingId: f.id }))[0].status).toBe('mentioned');
  });

  it('iniciador salva título como texto; participante não gerencia e entradas inválidas são recusadas', async () => {
    const f = await fixture();
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
    expect((await get('/app/operacao', signedSession('context-ordinary-member'))).status).toBe(404);
    expect((await get('/app/operacao', signedSession(owner, 'revoke-only'))).status).toBe(403);
    const response = await get('/app/operacao', signedSession(owner));
    expect(response.status).toBe(200);
    expect(response.body).toContain('Gravações no acervo');
    expect(response.body).toContain('Não comprovada por este painel');
    expect(response.body).not.toContain(config.cookieSecret);
  });

  it('assina próximas atas do canal pelo formulário e mantém o silêncio individual', async () => {
    const f = await fixture();
    const cookie = signedSession(f.initiator);
    expect((await post(`/app/contexto/${f.entry.id}/canal`, cookie, { mode: 'follow' })).status).toBe(303);
    expect((await get(`/app/contexto?meeting=${f.id}`, cookie)).body).toContain(
      'Parar acompanhamento automático do canal',
    );
    const next = await fixture(f.initiator);
    expect((await persisted().listForUser(f.initiator, { meetingId: next.id }))[0].preference.mode).toBe('follow');
    expect((await post(`/app/contexto/${next.entry.id}/avisos`, cookie, { mode: 'mute' })).status).toBe(303);
    expect((await persisted().listForUser(f.initiator, { meetingId: next.id }))[0].preference.mode).toBe('mute');
    expect((await post(`/app/contexto/${f.entry.id}/canal`, cookie, { mode: 'mute' })).status).toBe(303);
    expect((await persisted().listForUser(f.initiator, { meetingId: f.id }))[0].preference.mode).toBe('mute');
  });

  it('exclusão HTTP remove compromisso e preferências imediatamente, antes de qualquer sweep', async () => {
    const f = await fixture();
    const cookie = signedSession(f.initiator);
    expect((await post(`/app/contexto/${f.entry.id}/avisos`, cookie, { mode: 'follow' })).status).toBe(303);
    expect(contextRuntime().service.listFollowers()).toContain(f.initiator);
    const response = await post(`/app/rec/${f.id}/delete`, cookie, {});
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe('/app?deleted=1');
    expect(readMeta(f.id)).toBeUndefined();
    expect(await persisted().listForUser(f.initiator, { meetingId: f.id })).toEqual([]);
    expect(contextRuntime().service.listFollowers()).not.toContain(f.initiator);
    const state = fs.readFileSync(path.join(config.stateDir, 'commitments.json'), 'utf8');
    expect(state).not.toContain(f.entry.id);
    expect(state).not.toContain(f.task);
    expect((await get(`/app/contexto?meeting=${f.id}`, cookie)).body).not.toContain(f.task);
  });
});
