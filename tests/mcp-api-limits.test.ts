import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import { Collection, type Guild, type GuildMember } from 'discord.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { client } from '../src/discord/client';
import { markClientReady } from '../src/discord/ready';
import {
  MAX_MINUTES_BYTES,
  MAX_MINUTES_ITEMS_PER_COLLECTION,
  MAX_MINUTES_PARTICIPANTS_PER_RESPONSE,
  MAX_MINUTES_POINTS_PER_PARTICIPANT,
} from '../src/securityLimits';
import {
  deleteRecording,
  minutesPath,
  readMeta,
  saveMeta,
  saveMinutes,
  saveTranscript,
  transcriptPath,
  type RecordingMeta,
} from '../src/store';
import {
  ApiRateLimiters,
  FixedWindowRateLimiter,
  MCP_DIRECT_TRANSCRIPT_MAX_BYTES,
  mountMcpApi,
  resetMcpApiRateLimitsForTests,
  scanVisibleCandidates,
} from '../src/web/api';
import { signMcpAccess } from '../src/web/auth';
import { createSession, revokeUser } from '../src/web/mcpTokens';

describe('limites de disponibilidade da API MCP', () => {
  it('mantém o registro do rate limit dentro do teto mesmo com chaves distribuídas', () => {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter(2, () => now);

    expect(limiter.consume('ip:a', 10, 60_000)).toBe(false);
    expect(limiter.consume('ip:b', 10, 60_000)).toBe(false);
    expect(limiter.consume('ip:c', 10, 60_000)).toBe(false);
    expect(limiter.trackedKeys).toBe(2);

    now += 60_001;
    expect(limiter.consume('ip:d', 10, 60_000)).toBe(false);
    expect(limiter.trackedKeys).toBe(1);
  });

  it('não deixa churn de chaves controláveis reiniciar uma cota global', () => {
    const limiters = new ApiRateLimiters(2, 2, () => 1_000);

    expect(limiters.consumeGlobal('scan-global', 1, 60_000)).toBe(false);
    expect(limiters.consumeGlobal('scan-global', 1, 60_000)).toBe(true);
    for (let index = 0; index < 100; index++) {
      expect(limiters.consumeKey(`ip:${index}`, 10, 60_000)).toBe(false);
    }
    expect(limiters.consumeGlobal('scan-global', 1, 60_000)).toBe(true);
  });

  it('para antes do 26º guild e retoma a candidata autorizada sem pular', async () => {
    const candidates = Array.from({ length: 26 }, (_, index) => ({
      id: `candidate-${index}`,
      startedAt: 10_000 - index,
    }));
    const metas = new Map(
      candidates.map((candidate, index) => [
        candidate.id,
        { id: candidate.id, guildId: `guild-${index}`, allowed: index === 25 },
      ]),
    );
    const authorize = vi.fn(async (meta: { allowed: boolean }) => meta.allowed);

    const first = await scanVisibleCandidates(candidates, {
      maxVisible: 300,
      maxGuilds: 25,
      load: (id) => metas.get(id),
      matches: () => true,
      authorize,
    });
    expect(first).toMatchObject({ metas: [], limitReached: true, lastProcessed: candidates[24] });
    expect(authorize).toHaveBeenCalledTimes(25);

    const second = await scanVisibleCandidates(candidates.slice(25), {
      maxVisible: 300,
      maxGuilds: 25,
      load: (id) => metas.get(id),
      matches: () => true,
      authorize,
    });
    expect(second.metas.map((meta) => meta.id)).toEqual(['candidate-25']);
  });

  it('ancora antes da 301ª meta visível para reavaliá-la na continuação', async () => {
    const candidates = Array.from({ length: 301 }, (_, index) => ({
      id: `visible-${index}`,
      startedAt: 1_000 - index,
    }));
    const result = await scanVisibleCandidates(candidates, {
      maxVisible: 300,
      maxGuilds: 25,
      load: (id) => ({ id, guildId: 'one-guild' }),
      matches: () => true,
      authorize: async () => true,
    });

    expect(result.metas).toHaveLength(300);
    expect(result.limitReached).toBe(true);
    expect(result.lastProcessed).toEqual(candidates[299]);
  });
});

describe('paginação das consultas agregadas MCP', () => {
  const userId = `api-user-${crypto.randomUUID()}`;
  const guildId = `api-guild-${crypto.randomUUID()}`;
  const recordingId = `api-recording-${crypto.randomUUID()}`;
  const secondRecordingId = `api-recording-${crypto.randomUUID()}`;
  const inaccessibleRecordingIds: string[] = [];
  let server: http.Server;
  let baseUrl: string;
  let authorization: string;
  let fetchMember: ReturnType<typeof vi.fn>;

  beforeEach(() => resetMcpApiRateLimitsForTests());

  beforeAll(async () => {
    markClientReady();
    const member = {
      id: userId,
      permissions: { has: () => false },
    } as unknown as GuildMember;
    fetchMember = vi.fn(async () => member);
    const guild = {
      id: guildId,
      members: { fetch: fetchMember },
      channels: { cache: new Collection(), fetch: async () => null },
    } as unknown as Guild;
    client.guilds.cache.set(guildId, guild);

    const now = Date.now();
    const meta: RecordingMeta = {
      id: recordingId,
      guildId,
      guildName: 'Guild',
      voiceChannelId: 'voice',
      voiceChannelName: 'Call',
      sourceEveryoneViewable: false,
      startedBy: { id: userId, name: 'Lia' },
      startedAt: now - 60_000,
      endedAt: now - 30_000,
      status: 'done',
      participants: [{ id: userId, name: 'Lia', avatar: null, trackFile: 'lia.flac', index: 0 }],
      presence: [],
      events: [],
      notes: [],
      transcription: { status: 'done' },
      minutes: { status: 'done' },
    };
    saveMeta(meta);
    saveMinutes(recordingId, {
      resumo: 'Resumo',
      decisoes: [],
      acoes: Array.from({ length: 5 }, (_, index) => ({ tarefa: `Ação ${index}`, responsavel: 'Lia' })),
      topicos: [],
      porParticipante: [],
    });
    saveTranscript(
      recordingId,
      Array.from({ length: 5 }, (_, index) => ({
        startMs: index * 1_000,
        endMs: index * 1_000 + 500,
        speaker: 'Lia',
        text: `needle ${index}`,
      })),
    );
    saveMeta({
      ...meta,
      id: secondRecordingId,
      startedAt: now - 120_000,
      endedAt: now - 90_000,
      notes: [],
    });
    saveMinutes(secondRecordingId, {
      resumo: 'needle no resumo',
      decisoes: [],
      acoes: [],
      topicos: [],
      porParticipante: [],
    });
    saveTranscript(secondRecordingId, [{ startMs: 0, endMs: 500, speaker: 'Lia', text: 'needle secundário' }]);

    // Mais de 300 candidatas recentes sem grant não podem expulsar da janela
    // agregada as reuniões antigas que esta pessoa realmente pode consultar.
    for (let index = 0; index < 301; index++) {
      const id = `api-inaccessible-${crypto.randomUUID()}`;
      inaccessibleRecordingIds.push(id);
      saveMeta({
        ...meta,
        id,
        startedBy: { id: 'another-user', name: 'Outra pessoa' },
        startedAt: now - index * 100,
        endedAt: now - index * 100 + 50,
        participants: [],
        transcription: undefined,
        minutes: undefined,
      });
    }

    const session = createSession(userId, 'Lia');
    authorization = `Bearer ${signMcpAccess({ id: userId, name: 'Lia', exp: now + 60_000, jti: session.sid })}`;
    const app = express();
    mountMcpApi(app);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('servidor de teste sem porta');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    client.guilds.cache.delete(guildId);
    deleteRecording(recordingId);
    deleteRecording(secondRecordingId);
    for (const id of inaccessibleRecordingIds) deleteRecording(id);
    revokeUser(userId);
  });

  it('confirma membership uma vez por guild em cada request de listagem, sem reutilizar entre requests', async () => {
    const url = `${baseUrl}/api/meetings?guildId=${encodeURIComponent(guildId)}&limit=1`;
    fetchMember.mockClear();
    expect((await fetch(url, { headers: { authorization } })).status).toBe(200);
    expect(fetchMember).toHaveBeenCalledTimes(1);
    expect(fetchMember).toHaveBeenCalledWith({ user: userId, force: true, cache: false });

    fetchMember.mockClear();
    expect((await fetch(url, { headers: { authorization } })).status).toBe(200);
    expect(fetchMember).toHaveBeenCalledTimes(1);
  });

  it('pagina /meetings sem duplicar ou pular após inserir e apagar antes da continuação', async () => {
    const pagingUserId = `api-paging-user-${crypto.randomUUID()}`;
    const firstId = `api-paging-first-${crypto.randomUUID()}`;
    const secondId = `api-paging-second-${crypto.randomUUID()}`;
    const insertedId = `api-paging-inserted-${crypto.randomUUID()}`;
    const base = readMeta(recordingId);
    if (!base) throw new Error('meta-base ausente');
    const startedAt = Date.now() + 5_000;
    saveMeta({
      ...base,
      id: firstId,
      startedAt,
      presence: [{ id: pagingUserId, name: 'Pessoa paginação', joinedAtMs: 0 }],
    });
    saveMeta({
      ...base,
      id: secondId,
      startedAt: startedAt - 1_000,
      presence: [{ id: pagingUserId, name: 'Pessoa paginação', joinedAtMs: 0 }],
    });
    const session = createSession(pagingUserId, 'Pessoa paginação');
    const pagingAuthorization = `Bearer ${signMcpAccess({
      id: pagingUserId,
      name: 'Pessoa paginação',
      exp: Date.now() + 60_000,
      jti: session.sid,
    })}`;
    const url = `${baseUrl}/api/meetings?guildId=${encodeURIComponent(guildId)}&limit=1`;
    try {
      const first = await fetch(url, { headers: { authorization: pagingAuthorization } });
      const firstBody = (await first.json()) as {
        meetings: Array<{ id: string }>;
        nextCursor: string | null;
        nextScanCursor: string | null;
      };
      expect(first.status).toBe(200);
      expect(firstBody.meetings.map((meeting) => meeting.id)).toEqual([firstId]);
      expect(firstBody.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(firstBody.nextScanCursor).toBeNull();

      saveMeta({
        ...base,
        id: insertedId,
        startedAt: startedAt + 1_000,
        presence: [{ id: pagingUserId, name: 'Pessoa paginação', joinedAtMs: 0 }],
      });
      deleteRecording(firstId);

      const second = await fetch(`${url}&cursor=${encodeURIComponent(firstBody.nextCursor!)}`, {
        headers: { authorization: pagingAuthorization },
      });
      const secondBody = (await second.json()) as typeof firstBody;
      expect(second.status).toBe(200);
      expect(secondBody.meetings.map((meeting) => meeting.id)).toEqual([secondId]);
      expect(secondBody.meetings.map((meeting) => meeting.id)).not.toContain(insertedId);
    } finally {
      deleteRecording(firstId);
      deleteRecording(secondId);
      deleteRecording(insertedId);
      revokeUser(pagingUserId);
    }
  });

  it('pagina ações sem acumular todas no payload', async () => {
    const response = await fetch(`${baseUrl}/api/actions?guildId=${encodeURIComponent(guildId)}&limit=2`, {
      headers: { authorization },
    });
    const body = (await response.json()) as {
      returned: number;
      nextCursor: string | null;
      noDeadline: unknown[];
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ returned: 2 });
    expect(body.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.noDeadline).toHaveLength(2);

    const second = await fetch(
      `${baseUrl}/api/actions?guildId=${encodeURIComponent(guildId)}&limit=2&cursor=${encodeURIComponent(body.nextCursor!)}`,
      { headers: { authorization } },
    );
    const secondBody = (await second.json()) as typeof body;
    expect(second.status).toBe(200);
    expect(secondBody).toMatchObject({ returned: 2 });
    expect(secondBody.noDeadline).toHaveLength(2);
  });

  it('continua ações depois da 200ª e invalida offset se a ata mudar', async () => {
    const actionUserId = `api-action-user-${crypto.randomUUID()}`;
    const actionRecordingId = `api-action-recording-${crypto.randomUUID()}`;
    const base = readMeta(recordingId);
    if (!base) throw new Error('meta-base ausente');
    const actions = Array.from({ length: 205 }, (_, index) => ({
      tarefa: `Tarefa paginada ${index}`,
      responsavel: 'Pessoa ação',
    }));
    saveMeta({
      ...base,
      id: actionRecordingId,
      startedAt: Date.now() - 1_000,
      participants: [{ id: actionUserId, name: 'Pessoa ação', avatar: null, trackFile: 'action-user.flac', index: 0 }],
      presence: [],
      minutes: { status: 'done' },
      transcription: undefined,
    });
    saveMinutes(actionRecordingId, {
      resumo: 'Ações paginadas',
      decisoes: [],
      acoes: actions,
      topicos: [],
      porParticipante: [],
    });
    const session = createSession(actionUserId, 'Pessoa ação');
    const actionAuthorization = `Bearer ${signMcpAccess({
      id: actionUserId,
      name: 'Pessoa ação',
      exp: Date.now() + 60_000,
      jti: session.sid,
    })}`;
    const url = `${baseUrl}/api/actions?guildId=${encodeURIComponent(guildId)}&limit=500`;
    try {
      const first = await fetch(url, { headers: { authorization: actionAuthorization } });
      const firstBody = (await first.json()) as {
        returned: number;
        noDeadline: Array<{ tarefa: string }>;
        nextCursor: string | null;
        nextScanCursor: string | null;
      };
      expect(first.status).toBe(200);
      expect(firstBody.returned).toBe(200);
      expect(firstBody.noDeadline.at(-1)?.tarefa).toBe('Tarefa paginada 199');
      expect(firstBody.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(firstBody.nextScanCursor).toBeNull();

      const second = await fetch(`${url}&cursor=${encodeURIComponent(firstBody.nextCursor!)}`, {
        headers: { authorization: actionAuthorization },
      });
      const secondBody = (await second.json()) as typeof firstBody;
      expect(second.status).toBe(200);
      expect(secondBody.returned).toBe(5);
      expect(secondBody.noDeadline.map((item) => item.tarefa)).toEqual([
        'Tarefa paginada 200',
        'Tarefa paginada 201',
        'Tarefa paginada 202',
        'Tarefa paginada 203',
        'Tarefa paginada 204',
      ]);

      saveMinutes(actionRecordingId, {
        resumo: 'Ações regeneradas',
        decisoes: [],
        acoes: [{ tarefa: 'Inserida antes', responsavel: 'Pessoa ação' }, ...actions],
        topicos: [],
        porParticipante: [],
      });
      const stale = await fetch(`${url}&cursor=${encodeURIComponent(firstBody.nextCursor!)}`, {
        headers: { authorization: actionAuthorization },
      });
      expect(stale.status).toBe(400);
      await expect(stale.json()).resolves.toEqual({ error: 'bad_cursor' });
    } finally {
      deleteRecording(actionRecordingId);
      revokeUser(actionUserId);
    }
  });

  it('pagina falas por cursor estável sem montar todos os resultados em memória', async () => {
    const original = Array.from({ length: 5 }, (_, index) => ({
      startMs: index * 1_000,
      endMs: index * 1_000 + 500,
      speaker: 'Lia',
      text: `needle ${index}`,
    }));
    try {
      const first = await fetch(
        `${baseUrl}/api/said?meetingId=${encodeURIComponent(recordingId)}&query=needle&limit=2`,
        { headers: { authorization } },
      );
      const firstBody = (await first.json()) as {
        results: { text: string }[];
        nextCursor: string | null;
      };
      expect(firstBody.results.map((result) => result.text)).toEqual(['needle 0', 'needle 1']);
      expect(firstBody.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);

      const second = await fetch(
        `${baseUrl}/api/said?meetingId=${encodeURIComponent(recordingId)}&query=needle&limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
        { headers: { authorization } },
      );
      const secondBody = (await second.json()) as typeof firstBody;
      expect(secondBody.results.map((result) => result.text)).toEqual(['needle 2', 'needle 3']);
      expect(secondBody.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);

      saveTranscript(recordingId, [
        { startMs: 0, endMs: 1, speaker: 'Regenerada', text: 'needle inserido' },
        ...original,
      ]);
      const stale = await fetch(
        `${baseUrl}/api/said?meetingId=${encodeURIComponent(recordingId)}&query=needle&limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
        { headers: { authorization } },
      );
      expect(stale.status).toBe(400);
      await expect(stale.json()).resolves.toEqual({ error: 'bad_cursor' });
    } finally {
      saveTranscript(recordingId, original);
    }
  });

  it('interrompe /said pelo tamanho antes de parsear a reunião que excede os 25 MB agregados', async () => {
    const budgetUserId = `api-said-byte-budget-${crypto.randomUUID()}`;
    const createdIds: string[] = [];
    const base = readMeta(recordingId);
    if (!base) throw new Error('meta-base ausente');
    const newest = Date.now() - 1_000;
    const largeText = 'x'.repeat(4_999_800);
    for (let meeting = 0; meeting < 6; meeting++) {
      const id = `api-said-byte-budget-${crypto.randomUUID()}`;
      createdIds.push(id);
      saveMeta({
        ...base,
        id,
        startedAt: newest - meeting * 1_000,
        startedBy: { id: budgetUserId, name: 'Pessoa orçamento de bytes' },
        participants: [
          {
            id: budgetUserId,
            name: 'Pessoa orçamento de bytes',
            avatar: null,
            trackFile: `said-byte-budget-${meeting}.flac`,
            index: 0,
          },
        ],
        presence: [],
        minutes: undefined,
        transcription: { status: 'done' },
      });
      if (meeting < 5) {
        saveTranscript(id, [{ startMs: 0, endMs: 1, speaker: 'Pessoa orçamento de bytes', text: largeText }]);
      } else {
        // Cabe no teto de 5 MB da reunião, mas não no saldo agregado. Se for
        // lido/parseado antes do stat bounded, vira "unavailable" por ser inválido.
        fs.writeFileSync(transcriptPath(id), `[${'JSON inválido'.repeat(150_000)}`, 'utf8');
      }
    }
    const session = createSession(budgetUserId, 'Pessoa orçamento de bytes');
    const budgetAuthorization = `Bearer ${signMcpAccess({
      id: budgetUserId,
      name: 'Pessoa orçamento de bytes',
      exp: Date.now() + 300_000,
      jti: session.sid,
    })}`;
    try {
      const response = await fetch(
        `${baseUrl}/api/said?guildId=${encodeURIComponent(guildId)}&query=ausente-no-transcript`,
        { headers: { authorization: budgetAuthorization } },
      );
      const body = (await response.json()) as {
        skippedTranscripts: number;
        transcriptBudgetExhausted: boolean;
        nextCursor: string | null;
        nextScanCursor: string | null;
      };

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        skippedTranscripts: 0,
        transcriptBudgetExhausted: true,
        nextScanCursor: null,
      });
      expect(body.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    } finally {
      for (const id of createdIds) deleteRecording(id);
      revokeUser(budgetUserId);
    }
  }, 30_000);

  it('pré-valida guild explícita em /said antes de cursor e meetingId', async () => {
    const scopedUserId = `api-said-scope-${crypto.randomUUID()}`;
    const transientGuildId = `api-said-transient-${crypto.randomUUID()}`;
    const candidate = readMeta(recordingId);
    if (!candidate) throw new Error('meta-base ausente');
    candidate.presence = [{ id: scopedUserId, name: 'Pessoa escopo said', joinedAtMs: 0 }];
    saveMeta(candidate);
    const session = createSession(scopedUserId, 'Pessoa escopo said');
    const scopedAuthorization = `Bearer ${signMcpAccess({
      id: scopedUserId,
      name: 'Pessoa escopo said',
      exp: Date.now() + 60_000,
      jti: session.sid,
    })}`;
    const transientGuild = {
      id: transientGuildId,
      members: { fetch: vi.fn().mockRejectedValue(new Error('Discord timeout')) },
      channels: { cache: new Collection(), fetch: async () => null },
    } as unknown as Guild;
    client.guilds.cache.set(transientGuildId, transientGuild);
    try {
      const denied = await fetch(
        `${baseUrl}/api/said?meetingId=${encodeURIComponent(recordingId)}&guildId=guild-fora-do-gateway&query=needle&cursor=invalido`,
        { headers: { authorization: scopedAuthorization } },
      );
      const deniedBody = (await denied.json()) as {
        results: unknown[];
        nextCursor: string | null;
        nextScanCursor: string | null;
      };
      expect(denied.status).toBe(200);
      expect(deniedBody).toMatchObject({ results: [], nextCursor: null, nextScanCursor: null });

      const transient = await fetch(
        `${baseUrl}/api/said?meetingId=${encodeURIComponent(recordingId)}&guildId=${encodeURIComponent(transientGuildId)}&query=needle`,
        { headers: { authorization: scopedAuthorization } },
      );
      expect(transient.status).toBe(503);

      const allowed = await fetch(
        `${baseUrl}/api/said?meetingId=${encodeURIComponent(recordingId)}&guildId=${encodeURIComponent(guildId)}&query=needle&limit=1`,
        { headers: { authorization: scopedAuthorization } },
      );
      const allowedBody = (await allowed.json()) as { results: unknown[] };
      expect(allowed.status).toBe(200);
      expect(allowedBody.results).toHaveLength(1);
    } finally {
      candidate.presence = [];
      saveMeta(candidate);
      client.guilds.cache.delete(transientGuildId);
      revokeUser(scopedUserId);
    }
  });

  it('aplica o orçamento de transcript também a /said com meetingId', async () => {
    const directUserId = `api-said-budget-${crypto.randomUUID()}`;
    const candidate = readMeta(recordingId);
    if (!candidate) throw new Error('meta-base ausente');
    candidate.presence = [{ id: directUserId, name: 'Pessoa said', joinedAtMs: 0 }];
    saveMeta(candidate);
    const directSession = createSession(directUserId, 'Pessoa said');
    const directAuthorization = `Bearer ${signMcpAccess({
      id: directUserId,
      name: 'Pessoa said',
      exp: Date.now() + 60_000,
      jti: directSession.sid,
    })}`;
    try {
      const statuses: number[] = [];
      for (let request = 0; request < 13; request++) {
        const response = await fetch(
          `${baseUrl}/api/said?meetingId=${encodeURIComponent(recordingId)}&query=needle&limit=1`,
          { headers: { authorization: directAuthorization } },
        );
        statuses.push(response.status);
      }

      expect(statuses).toEqual([...Array.from({ length: 12 }, () => 200), 429]);
      const directTranscript = await fetch(
        `${baseUrl}/api/meetings/${encodeURIComponent(recordingId)}/transcript?limit=1`,
        { headers: { authorization: directAuthorization } },
      );
      expect(directTranscript.status).toBe(429);
    } finally {
      candidate.presence = [];
      saveMeta(candidate);
      revokeUser(directUserId);
    }
  });

  it('pagina a rota direta de transcrição e informa continuação', async () => {
    const first = await fetch(`${baseUrl}/api/meetings/${encodeURIComponent(recordingId)}/transcript?limit=2`, {
      headers: { authorization },
    });
    const firstBody = (await first.json()) as {
      segments: { text: string }[];
      totalSegments: number;
      truncated: boolean;
      nextCursor: string | null;
    };
    expect(first.status).toBe(200);
    expect(firstBody).toMatchObject({ totalSegments: 5, truncated: true, nextCursor: '3' });
    expect(firstBody.segments.map((segment) => segment.text)).toEqual(['needle 0', 'needle 1']);

    const second = await fetch(
      `${baseUrl}/api/meetings/${encodeURIComponent(recordingId)}/transcript?limit=2&cursor=3`,
      { headers: { authorization } },
    );
    const secondBody = (await second.json()) as typeof firstBody;
    expect(second.status).toBe(200);
    expect(secondBody).toMatchObject({ totalSegments: 5, truncated: true, nextCursor: '5' });
    expect(secondBody.segments.map((segment) => segment.text)).toEqual(['needle 2', 'needle 3']);
  });

  it('limita notas e presença legadas também nas respostas diretas', async () => {
    const candidate = readMeta(recordingId);
    if (!candidate) throw new Error('meta-base ausente');
    candidate.notes = Array.from({ length: 501 }, (_, index) => ({
      atMs: index,
      author: 'Lia',
      text: `nota ${index}`,
    }));
    candidate.presence = Array.from({ length: 101 }, (_, index) => ({
      id: `legacy-presence-${index}`,
      name: `Pessoa ${index}`,
      joinedAtMs: index,
    }));
    saveMeta(candidate);
    try {
      const response = await fetch(
        `${baseUrl}/api/meetings/${encodeURIComponent(recordingId)}?include=notes,timeline`,
        { headers: { authorization } },
      );
      const body = (await response.json()) as {
        notes: unknown[];
        notesTruncated: boolean;
        timelineTruncated: boolean;
        participants: unknown[];
        participantsTruncated: boolean;
        participantLimit: number;
        presentSilent: unknown[];
        presentSilentTruncated: boolean;
        presentSilentLimit: number;
      };

      expect(response.status).toBe(200);
      expect(body.notes).toHaveLength(500);
      expect(body.notesTruncated).toBe(true);
      expect(body.timelineTruncated).toBe(true);
      expect(body.participants).toHaveLength(1);
      expect(body.participantsTruncated).toBe(false);
      expect(body.participantLimit).toBe(100);
      expect(body.presentSilent).toHaveLength(99);
      expect(body.presentSilentTruncated).toBe(true);
      expect(body.presentSilentLimit).toBe(99);
    } finally {
      candidate.notes = [];
      candidate.presence = [];
      saveMeta(candidate);
    }
  });

  it('limita participantes e presenças silenciosas no mesmo orçamento de identidade', async () => {
    const candidate = readMeta(recordingId);
    if (!candidate) throw new Error('meta-base ausente');
    const originalParticipants = candidate.participants;
    const originalPresence = candidate.presence;
    candidate.participants = Array.from({ length: 101 }, (_, index) => ({
      id: `legacy-participant-${index}`,
      name: `Participante ${index}`,
      avatar: null,
      trackFile: `p-${index}.flac`,
      index,
    }));
    candidate.presence = [{ id: 'silent-over-budget', name: 'Silenciosa', joinedAtMs: 0 }];
    saveMeta(candidate);
    try {
      const response = await fetch(`${baseUrl}/api/meetings/${encodeURIComponent(recordingId)}?include=meta`, {
        headers: { authorization },
      });
      const body = (await response.json()) as {
        participants: unknown[];
        participantCount: number;
        participantsTruncated: boolean;
        presentSilent: unknown[];
        presentSilentTruncated: boolean;
      };
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        participantCount: 101,
        participantsTruncated: true,
        presentSilent: [],
        presentSilentTruncated: true,
      });
      expect(body.participants).toHaveLength(100);
    } finally {
      candidate.participants = originalParticipants;
      candidate.presence = originalPresence;
      saveMeta(candidate);
    }
  });

  it('recusa transcript acima do teto antes de montar dossier, rota direta ou export', async () => {
    const original = Array.from({ length: 5 }, (_, index) => ({
      startMs: index * 1_000,
      endMs: index * 1_000 + 500,
      speaker: 'Lia',
      text: `needle ${index}`,
    }));
    try {
      fs.writeFileSync(
        transcriptPath(recordingId),
        JSON.stringify([{ startMs: 0, endMs: 1, speaker: 'Lia', text: 'x'.repeat(MCP_DIRECT_TRANSCRIPT_MAX_BYTES) }]),
      );

      const dossier = await fetch(
        `${baseUrl}/api/meetings/${encodeURIComponent(recordingId)}?include=transcript&transcriptLimit=2`,
        { headers: { authorization } },
      );
      expect(dossier.status).toBe(200);
      await expect(dossier.json()).resolves.toMatchObject({
        transcript: [],
        transcriptTruncated: true,
        transcriptUnavailableReason: 'too_large',
        transcriptByteLimit: MCP_DIRECT_TRANSCRIPT_MAX_BYTES,
      });

      const direct = await fetch(`${baseUrl}/api/meetings/${encodeURIComponent(recordingId)}/transcript`, {
        headers: { authorization },
      });
      expect(direct.status).toBe(413);
      await expect(direct.json()).resolves.toMatchObject({
        error: 'transcript_too_large',
        maxBytes: MCP_DIRECT_TRANSCRIPT_MAX_BYTES,
      });

      const exported = await fetch(
        `${baseUrl}/api/meetings/${encodeURIComponent(recordingId)}/export?format=transcricao.md`,
        { headers: { authorization } },
      );
      expect(exported.status).toBe(413);
      await expect(exported.json()).resolves.toMatchObject({
        error: 'transcript_too_large',
        maxBytes: MCP_DIRECT_TRANSCRIPT_MAX_BYTES,
      });
    } finally {
      saveTranscript(recordingId, original);
    }
  });

  it('recusa ata acima do teto antes de montar dossier, rota direta ou export', async () => {
    const original = {
      resumo: 'Resumo',
      decisoes: [],
      acoes: Array.from({ length: 5 }, (_, index) => ({ tarefa: `Ação ${index}`, responsavel: 'Lia' })),
      topicos: [],
      porParticipante: [],
    };
    try {
      fs.writeFileSync(
        minutesPath(recordingId),
        JSON.stringify({ ...original, resumo: 'x'.repeat(MAX_MINUTES_BYTES) }),
      );

      const dossier = await fetch(`${baseUrl}/api/meetings/${encodeURIComponent(recordingId)}?include=minutes`, {
        headers: { authorization },
      });
      expect(dossier.status).toBe(200);
      await expect(dossier.json()).resolves.toMatchObject({
        minutes: null,
        minutesTruncated: true,
        minutesUnavailableReason: 'too_large',
        minutesByteLimit: MAX_MINUTES_BYTES,
      });

      const direct = await fetch(`${baseUrl}/api/meetings/${encodeURIComponent(recordingId)}/minutes`, {
        headers: { authorization },
      });
      expect(direct.status).toBe(413);
      await expect(direct.json()).resolves.toMatchObject({
        error: 'minutes_too_large',
        maxBytes: MAX_MINUTES_BYTES,
      });

      const exported = await fetch(`${baseUrl}/api/meetings/${encodeURIComponent(recordingId)}/export?format=ata.md`, {
        headers: { authorization },
      });
      expect(exported.status).toBe(413);
      await expect(exported.json()).resolves.toMatchObject({
        error: 'minutes_too_large',
        maxBytes: MAX_MINUTES_BYTES,
      });
    } finally {
      saveMinutes(recordingId, original);
    }
  });

  it('limita coleções da ata e informa exatamente os tetos da resposta', async () => {
    const original = {
      resumo: 'Resumo',
      decisoes: [],
      acoes: Array.from({ length: 5 }, (_, index) => ({ tarefa: `Ação ${index}`, responsavel: 'Lia' })),
      topicos: [],
      porParticipante: [],
    };
    saveMinutes(recordingId, {
      resumo: 'Resumo limitado',
      decisoes: Array.from({ length: MAX_MINUTES_ITEMS_PER_COLLECTION + 1 }, (_, index) => `Decisão ${index}`),
      acoes: [],
      topicos: Array.from({ length: MAX_MINUTES_ITEMS_PER_COLLECTION + 1 }, (_, index) => ({
        titulo: `Tópico ${index}`,
        inicioMs: index,
      })),
      porParticipante: Array.from({ length: MAX_MINUTES_PARTICIPANTS_PER_RESPONSE + 1 }, (_, index) => ({
        nome: `Pessoa ${index}`,
        pontos: Array.from(
          { length: index === 0 ? MAX_MINUTES_POINTS_PER_PARTICIPANT + 1 : 1 },
          (__, point) => `Ponto ${point}`,
        ),
      })),
    });
    try {
      const response = await fetch(`${baseUrl}/api/meetings/${encodeURIComponent(recordingId)}/minutes`, {
        headers: { authorization },
      });
      const body = (await response.json()) as {
        minutesTruncated: boolean;
        minutesLimits: Record<string, number>;
        minutes: { decisoes: unknown[]; porParticipante: Array<{ pontos: unknown[] }> };
      };

      expect(response.status).toBe(200);
      expect(body.minutesTruncated).toBe(true);
      expect(body.minutesLimits).toEqual({
        itemsPerCollection: MAX_MINUTES_ITEMS_PER_COLLECTION,
        participants: MAX_MINUTES_PARTICIPANTS_PER_RESPONSE,
        pointsPerParticipant: MAX_MINUTES_POINTS_PER_PARTICIPANT,
      });
      expect(body.minutes.decisoes).toHaveLength(MAX_MINUTES_ITEMS_PER_COLLECTION);
      expect(body.minutes.porParticipante).toHaveLength(MAX_MINUTES_PARTICIPANTS_PER_RESPONSE);
      expect(body.minutes.porParticipante[0].pontos).toHaveLength(MAX_MINUTES_POINTS_PER_PARTICIPANT);

      const dossier = await fetch(`${baseUrl}/api/meetings/${encodeURIComponent(recordingId)}?include=timeline`, {
        headers: { authorization },
      });
      const dossierBody = (await dossier.json()) as { timeline: unknown[]; timelineTruncated: boolean };
      expect(dossier.status).toBe(200);
      expect(dossierBody.timeline).toHaveLength(MAX_MINUTES_ITEMS_PER_COLLECTION);
      expect(dossierBody.timelineTruncated).toBe(true);
    } finally {
      saveMinutes(recordingId, original);
    }
  });

  it('não perde falas autorizadas antigas quando candidatas recentes são inacessíveis', async () => {
    const response = await fetch(`${baseUrl}/api/said?guildId=${encodeURIComponent(guildId)}&query=needle&limit=1`, {
      headers: { authorization },
    });
    const body = (await response.json()) as { results: { meetingId: string }[] };

    expect(response.status).toBe(200);
    expect(body.results).toHaveLength(1);
    expect([recordingId, secondRecordingId]).toContain(body.results[0].meetingId);
  });

  it('pagina busca por âncora estável mesmo com inserção antes do cursor', async () => {
    const url = `${baseUrl}/api/search?guildId=${encodeURIComponent(guildId)}&query=needle&limit=1`;
    const first = await fetch(url, { headers: { authorization } });
    const firstBody = (await first.json()) as {
      results: { id: string }[];
      nextCursor: string | null;
      returned: number;
    };
    expect(firstBody.results.map((result) => result.id)).toEqual([recordingId]);
    expect(firstBody.returned).toBe(1);
    expect(firstBody.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);

    const insertedId = `api-search-newer-${crypto.randomUUID()}`;
    const base = readMeta(recordingId);
    if (!base) throw new Error('meta-base ausente');
    saveMeta({ ...base, id: insertedId, startedAt: Date.now() + 1_000 });
    saveMinutes(insertedId, {
      resumo: 'needle inserido depois da primeira página',
      decisoes: [],
      acoes: [],
      topicos: [],
      porParticipante: [],
    });
    try {
      const second = await fetch(`${url}&cursor=${encodeURIComponent(firstBody.nextCursor!)}`, {
        headers: { authorization },
      });
      const secondBody = (await second.json()) as typeof firstBody;
      expect(secondBody.results.map((result) => result.id)).toEqual([secondRecordingId]);
      expect(secondBody.nextCursor).toBeNull();
    } finally {
      deleteRecording(insertedId);
    }
  });

  it('retoma /search depois de 5 mil segmentos e encontra hit posterior sem repetir o início', async () => {
    const searchUserId = `api-search-segment-user-${crypto.randomUUID()}`;
    const longRecordingId = `api-search-segment-${crypto.randomUUID()}`;
    const base = readMeta(recordingId);
    if (!base) throw new Error('meta-base ausente');
    saveMeta({
      ...base,
      id: longRecordingId,
      startedAt: Date.now() + 4_000,
      participants: [{ id: searchUserId, name: 'Busca longa', avatar: null, trackFile: 'search-long.flac', index: 0 }],
      presence: [],
      notes: [{ atMs: 1, author: 'Busca longa', text: 'hit-profundo-depois-do-teto na nota' }],
      minutes: { status: 'done' },
      transcription: { status: 'done' },
    });
    saveMinutes(longRecordingId, {
      resumo: 'hit-profundo-depois-do-teto no resumo',
      decisoes: [],
      acoes: [],
      topicos: [],
      porParticipante: [],
    });
    const longSegments = Array.from({ length: 5_001 }, (_, index) => ({
      startMs: index * 10,
      endMs: index * 10 + 5,
      speaker: 'Busca longa',
      text: index === 5_000 ? 'hit-profundo-depois-do-teto' : `ruído ${index}`,
    }));
    saveTranscript(longRecordingId, longSegments);
    const session = createSession(searchUserId, 'Busca longa');
    const searchAuthorization = `Bearer ${signMcpAccess({
      id: searchUserId,
      name: 'Busca longa',
      exp: Date.now() + 60_000,
      jti: session.sid,
    })}`;
    const url = `${baseUrl}/api/search?guildId=${encodeURIComponent(guildId)}&query=hit-profundo-depois-do-teto`;
    try {
      const first = await fetch(url, { headers: { authorization: searchAuthorization } });
      const firstBody = (await first.json()) as {
        results: Array<{ id: string; hits: Array<{ where: string }> }>;
        nextCursor: string | null;
        nextScanCursor: string | null;
      };
      expect(first.status).toBe(200);
      expect(firstBody.results).toHaveLength(1);
      expect(firstBody.results[0].hits.map((hit) => hit.where)).toEqual(['summary']);
      expect(firstBody.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(firstBody.nextScanCursor).toBeNull();

      const second = await fetch(`${url}&cursor=${encodeURIComponent(firstBody.nextCursor!)}`, {
        headers: { authorization: searchAuthorization },
      });
      const secondBody = (await second.json()) as typeof firstBody;
      expect(second.status).toBe(200);
      expect(secondBody.results.map((result) => result.id)).toEqual([longRecordingId]);
      expect(secondBody.results[0].hits.map((hit) => hit.where)).toEqual(['transcript', 'note']);

      saveTranscript(longRecordingId, [
        { startMs: 0, endMs: 1, speaker: 'Regenerada', text: 'segmento inserido' },
        ...longSegments,
      ]);
      const stale = await fetch(`${url}&cursor=${encodeURIComponent(firstBody.nextCursor!)}`, {
        headers: { authorization: searchAuthorization },
      });
      expect(stale.status).toBe(400);
      await expect(stale.json()).resolves.toEqual({ error: 'bad_cursor' });
    } finally {
      deleteRecording(longRecordingId);
      revokeUser(searchUserId);
    }
  }, 30_000);

  it('retoma /search no próximo segmento bruto quando a reunião atinge 30 hits', async () => {
    const searchUserId = `api-search-hit-cap-user-${crypto.randomUUID()}`;
    const hitCapRecordingId = `api-search-hit-cap-${crypto.randomUUID()}`;
    const base = readMeta(recordingId);
    if (!base) throw new Error('meta-base ausente');
    saveMeta({
      ...base,
      id: hitCapRecordingId,
      startedAt: Date.now() + 5_000,
      participants: [
        { id: searchUserId, name: 'Busca por hits', avatar: null, trackFile: 'search-hit-cap.flac', index: 0 },
      ],
      presence: [],
      notes: [],
      minutes: undefined,
      transcription: { status: 'done' },
    });
    saveTranscript(
      hitCapRecordingId,
      Array.from({ length: 31 }, (_, index) => ({
        startMs: index * 10,
        endMs: index * 10 + 5,
        speaker: 'Busca por hits',
        text: `hit-teto-trinta ${index}`,
      })),
    );
    const session = createSession(searchUserId, 'Busca por hits');
    const searchAuthorization = `Bearer ${signMcpAccess({
      id: searchUserId,
      name: 'Busca por hits',
      exp: Date.now() + 60_000,
      jti: session.sid,
    })}`;
    const url = `${baseUrl}/api/search?guildId=${encodeURIComponent(guildId)}&scope=transcript&query=hit-teto-trinta`;
    try {
      const first = await fetch(url, { headers: { authorization: searchAuthorization } });
      const firstBody = (await first.json()) as {
        results: Array<{ id: string; hits: Array<{ atMs: number }> }>;
        nextCursor: string | null;
        nextScanCursor: string | null;
      };
      expect(first.status).toBe(200);
      expect(firstBody.results[0].hits.map((hit) => hit.atMs)).toEqual(
        Array.from({ length: 30 }, (_, index) => index * 10),
      );
      expect(firstBody.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(firstBody.nextScanCursor).toBeNull();

      const second = await fetch(`${url}&cursor=${encodeURIComponent(firstBody.nextCursor!)}`, {
        headers: { authorization: searchAuthorization },
      });
      const secondBody = (await second.json()) as typeof firstBody;
      expect(second.status).toBe(200);
      expect(secondBody.results).toEqual([
        expect.objectContaining({
          id: hitCapRecordingId,
          hits: [expect.objectContaining({ atMs: 300 })],
        }),
      ]);
      expect(secondBody.nextCursor).toBeNull();
    } finally {
      deleteRecording(hitCapRecordingId);
      revokeUser(searchUserId);
    }
  });

  it('pagina /search sem perder o 31º hit ao atravessar minutes, transcript e notes', async () => {
    const searchUserId = `api-search-phases-user-${crypto.randomUUID()}`;
    const phasedRecordingId = `api-search-phases-${crypto.randomUUID()}`;
    const base = readMeta(recordingId);
    if (!base) throw new Error('meta-base ausente');
    saveMeta({
      ...base,
      id: phasedRecordingId,
      startedAt: Date.now() + 6_000,
      participants: [
        { id: searchUserId, name: 'Busca por fases', avatar: null, trackFile: 'search-phases.flac', index: 0 },
      ],
      presence: [],
      notes: Array.from({ length: 31 }, (_, index) => ({
        atMs: 20_000 + index,
        author: 'Busca por fases',
        text: `hit-fases note-${index}`,
      })),
      minutes: { status: 'done' },
      transcription: { status: 'done' },
    });
    saveMinutes(phasedRecordingId, {
      resumo: 'sem correspondência',
      decisoes: Array.from({ length: 31 }, (_, index) => `hit-fases decision-${index}`),
      acoes: [],
      topicos: [],
      porParticipante: [],
    });
    saveTranscript(
      phasedRecordingId,
      Array.from({ length: 30 }, (_, index) => ({
        startMs: 10_000 + index,
        endMs: 10_001 + index,
        speaker: 'Busca por fases',
        text: `hit-fases transcript-${index}`,
      })),
    );
    const session = createSession(searchUserId, 'Busca por fases');
    const searchAuthorization = `Bearer ${signMcpAccess({
      id: searchUserId,
      name: 'Busca por fases',
      exp: Date.now() + 60_000,
      jti: session.sid,
    })}`;
    const url = `${baseUrl}/api/search?guildId=${encodeURIComponent(guildId)}&query=hit-fases`;
    try {
      const pages: Array<Array<{ where: string; snippet: string; atMs?: number }>> = [];
      let cursor: string | null = null;
      for (let page = 0; page < 4; page++) {
        const response = await fetch(`${url}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, {
          headers: { authorization: searchAuthorization },
        });
        const body = (await response.json()) as {
          results: Array<{ id: string; hits: Array<{ where: string; snippet: string; atMs?: number }> }>;
          nextCursor: string | null;
          nextScanCursor: string | null;
        };
        expect(response.status).toBe(200);
        expect(body.results.map((result) => result.id)).toEqual([phasedRecordingId]);
        pages.push(body.results[0].hits);
        cursor = body.nextCursor;
        expect(body.nextScanCursor).toBeNull();
        if (page < 3) expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      }

      expect(pages.map((hits) => hits.map((hit) => hit.where))).toEqual([
        Array(30).fill('decision'),
        ['decision', ...Array(29).fill('transcript')],
        ['transcript', ...Array(29).fill('note')],
        Array(2).fill('note'),
      ]);
      expect(pages[1][0].snippet).toContain('decision-30');
      expect(
        pages
          .flat()
          .filter((hit) => hit.where === 'transcript')
          .map((hit) => hit.atMs),
      ).toEqual(Array.from({ length: 30 }, (_, index) => 10_000 + index));
      expect(
        pages
          .flat()
          .filter((hit) => hit.where === 'note')
          .map((hit) => hit.atMs),
      ).toEqual(Array.from({ length: 31 }, (_, index) => 20_000 + index));
      expect(cursor).toBeNull();
    } finally {
      deleteRecording(phasedRecordingId);
      revokeUser(searchUserId);
    }
  });

  it('para antes da reunião quando 25 mil segmentos se esgotam e a retoma completa', async () => {
    const searchUserId = `api-search-budget-user-${crypto.randomUUID()}`;
    const createdIds: string[] = [];
    const base = readMeta(recordingId);
    if (!base) throw new Error('meta-base ausente');
    const newest = Date.now() + 20_000;
    for (let meeting = 0; meeting < 6; meeting++) {
      const id = `api-search-budget-${crypto.randomUUID()}`;
      createdIds.push(id);
      saveMeta({
        ...base,
        id,
        startedAt: newest - meeting * 1_000,
        participants: [
          { id: searchUserId, name: 'Busca orçamento', avatar: null, trackFile: `budget-${meeting}.flac`, index: 0 },
        ],
        presence: [],
        minutes: undefined,
        transcription: { status: 'done' },
      });
      saveTranscript(
        id,
        Array.from({ length: 5_000 }, (_, index) => ({
          startMs: index * 10,
          endMs: index * 10 + 5,
          speaker: 'Busca orçamento',
          text: meeting === 5 && index === 0 ? 'hit-na-reuniao-depois-do-orcamento' : `ruído ${meeting}-${index}`,
        })),
      );
    }
    const session = createSession(searchUserId, 'Busca orçamento');
    const searchAuthorization = `Bearer ${signMcpAccess({
      id: searchUserId,
      name: 'Busca orçamento',
      exp: Date.now() + 60_000,
      jti: session.sid,
    })}`;
    const url = `${baseUrl}/api/search?guildId=${encodeURIComponent(guildId)}&scope=transcript&query=hit-na-reuniao-depois-do-orcamento`;
    try {
      const first = await fetch(url, { headers: { authorization: searchAuthorization } });
      const firstBody = (await first.json()) as {
        results: Array<{ id: string }>;
        nextCursor: string | null;
        nextScanCursor: string | null;
        transcriptSegmentsScanned: number;
      };
      expect(first.status).toBe(200);
      expect(firstBody).toMatchObject({ results: [], transcriptSegmentsScanned: 25_000, nextScanCursor: null });
      expect(firstBody.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);

      const second = await fetch(`${url}&cursor=${encodeURIComponent(firstBody.nextCursor!)}`, {
        headers: { authorization: searchAuthorization },
      });
      const secondBody = (await second.json()) as typeof firstBody;
      expect(second.status).toBe(200);
      expect(secondBody.results.map((result) => result.id)).toEqual([createdIds[5]]);
    } finally {
      for (const id of createdIds) deleteRecording(id);
      revokeUser(searchUserId);
    }
  }, 30_000);

  it('usa o índice da guild antes do teto global de candidatas', async () => {
    const base = readMeta(recordingId);
    if (!base) throw new Error('meta-base ausente');
    const noisyIds: string[] = [];
    try {
      const now = Date.now();
      for (let index = 0; index < 501; index++) {
        const id = `api-noisy-${crypto.randomUUID()}`;
        noisyIds.push(id);
        saveMeta({
          ...base,
          id,
          guildId: 'another-noisy-guild',
          startedBy: { id: 'another-user', name: 'Outra pessoa' },
          startedAt: now - index,
          endedAt: now - index + 1,
          participants: [],
          presence: [],
          transcription: undefined,
          minutes: undefined,
        });
      }

      const response = await fetch(`${baseUrl}/api/meetings?guildId=${encodeURIComponent(guildId)}&limit=100`, {
        headers: { authorization },
      });
      const body = (await response.json()) as { meetings: Array<{ id: string }> };

      expect(response.status).toBe(200);
      expect(body.meetings.map((meeting) => meeting.id)).toEqual(
        expect.arrayContaining([recordingId, secondRecordingId]),
      );
    } finally {
      for (const id of noisyIds) deleteRecording(id);
    }
  }, 30_000);

  it('alcança reuniões autorizadas depois de mais de 500 ruídos via nextScanCursor', async () => {
    const base = readMeta(recordingId);
    if (!base) throw new Error('meta-base ausente');
    const extraNoise: string[] = [];
    try {
      for (let index = 0; index < 205; index++) {
        const id = `api-scan-noise-${crypto.randomUUID()}`;
        extraNoise.push(id);
        saveMeta({
          ...base,
          id,
          startedBy: { id: 'another-user', name: 'Outra pessoa' },
          startedAt: base.startedAt + 10_000 + index,
          endedAt: base.startedAt + 10_001 + index,
          participants: [],
          presence: [],
          transcription: undefined,
          minutes: undefined,
        });
      }

      const url = `${baseUrl}/api/meetings?guildId=${encodeURIComponent(guildId)}&limit=100`;
      const first = await fetch(url, { headers: { authorization } });
      const firstBody = (await first.json()) as {
        meetings: Array<{ id: string }>;
        nextCursor: string | null;
        nextScanCursor: string | null;
      };
      expect(first.status).toBe(200);
      expect(firstBody.meetings).toEqual([]);
      expect(firstBody.nextCursor).toBeNull();
      expect(firstBody.nextScanCursor).toMatch(/^[A-Za-z0-9_-]+$/);

      const second = await fetch(`${url}&scanCursor=${encodeURIComponent(firstBody.nextScanCursor!)}`, {
        headers: { authorization },
      });
      const secondBody = (await second.json()) as typeof firstBody;
      expect(second.status).toBe(200);
      expect(secondBody.meetings.map((meeting) => meeting.id)).toEqual(
        expect.arrayContaining([recordingId, secondRecordingId]),
      );
    } finally {
      for (const id of extraNoise) deleteRecording(id);
    }
  }, 30_000);

  it('nega escopo desconhecido sem oráculo, rejeita cursor inválido para membro e ignora meta órfã', async () => {
    const scopedUserId = `api-scope-user-${crypto.randomUUID()}`;
    const orphanId = `api-orphan-${crypto.randomUUID()}`;
    const targetId = `api-orphan-target-${crypto.randomUUID()}`;
    const base = readMeta(recordingId);
    if (!base) throw new Error('meta-base ausente');
    const session = createSession(scopedUserId, 'Pessoa escopo');
    const scopedAuthorization = `Bearer ${signMcpAccess({
      id: scopedUserId,
      name: 'Pessoa escopo',
      exp: Date.now() + 60_000,
      jti: session.sid,
    })}`;
    try {
      const denied = await fetch(`${baseUrl}/api/meetings?guildId=guild-ausente&scanCursor=nao-e-cursor`, {
        headers: { authorization: scopedAuthorization },
      });
      const deniedBody = (await denied.json()) as Record<string, unknown>;
      expect(denied.status).toBe(200);
      expect(deniedBody).toMatchObject({
        total: 0,
        meetings: [],
        meetingsTruncated: false,
        nextCursor: null,
        nextScanCursor: null,
      });
      expect(deniedBody).not.toHaveProperty('candidateCount');

      const invalid = await fetch(`${baseUrl}/api/meetings?guildId=${encodeURIComponent(guildId)}&cursor=invalido`, {
        headers: { authorization: scopedAuthorization },
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toEqual({ error: 'bad_cursor' });

      saveMeta({
        ...base,
        id: orphanId,
        guildId: 'guild-removida-do-bot',
        startedAt: Date.now() + 2_000,
        participants: [{ id: scopedUserId, name: 'Pessoa escopo', avatar: null, trackFile: 'scope.flac', index: 0 }],
      });
      saveMeta({
        ...base,
        id: targetId,
        startedAt: Date.now() + 1_000,
        participants: [{ id: scopedUserId, name: 'Pessoa escopo', avatar: null, trackFile: 'scope.flac', index: 0 }],
      });
      const global = await fetch(
        `${baseUrl}/api/meetings?participantId=${encodeURIComponent(scopedUserId)}&limit=100`,
        { headers: { authorization: scopedAuthorization } },
      );
      const globalBody = (await global.json()) as { meetings: Array<{ id: string }> };
      expect(global.status).toBe(200);
      expect(globalBody.meetings.map((meeting) => meeting.id)).toEqual([targetId]);
    } finally {
      deleteRecording(orphanId);
      deleteRecording(targetId);
      revokeUser(scopedUserId);
    }
  });

  it('sinaliza quando o teto agregado deixa reuniões autorizadas fora da varredura', async () => {
    for (const id of inaccessibleRecordingIds) {
      const candidate = readMeta(id);
      if (!candidate) throw new Error(`meta de teste ausente: ${id}`);
      candidate.presence = [{ id: userId, name: 'Lia', joinedAtMs: 0 }];
      saveMeta(candidate);
    }

    const response = await fetch(`${baseUrl}/api/search?guildId=${encodeURIComponent(guildId)}&query=needle`, {
      headers: { authorization },
    });
    const body = (await response.json()) as {
      meetingsTruncated?: boolean;
      meetingScanLimit?: number;
      nextCursor?: string | null;
      nextScanCursor?: string | null;
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ meetingsTruncated: true, meetingScanLimit: 300 });
    expect(body.nextCursor).toBeNull();
    expect(body.nextScanCursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
