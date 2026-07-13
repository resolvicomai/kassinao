import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import { Collection, type Guild, type GuildMember } from 'discord.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { client } from '../src/discord/client';
import { markClientReady } from '../src/discord/ready';
import {
  deleteRecording,
  readMeta,
  saveMeta,
  saveMinutes,
  saveTranscript,
  transcriptPath,
  type RecordingMeta,
} from '../src/store';
import { ApiRateLimiters, FixedWindowRateLimiter, MCP_DIRECT_TRANSCRIPT_MAX_BYTES, mountMcpApi } from '../src/web/api';
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

  it('pagina ações sem acumular todas no payload', async () => {
    const response = await fetch(`${baseUrl}/api/actions?guildId=${encodeURIComponent(guildId)}&limit=2`, {
      headers: { authorization },
    });
    const body = (await response.json()) as {
      returned: number;
      total: number;
      nextCursor: string | null;
      noDeadline: unknown[];
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ returned: 2, total: 5, nextCursor: '3' });
    expect(body.noDeadline).toHaveLength(2);
  });

  it('pagina falas por cursor estável sem montar todos os resultados em memória', async () => {
    const first = await fetch(`${baseUrl}/api/said?meetingId=${encodeURIComponent(recordingId)}&query=needle&limit=2`, {
      headers: { authorization },
    });
    const firstBody = (await first.json()) as {
      results: { text: string }[];
      nextCursor: string | null;
    };
    expect(firstBody.results.map((result) => result.text)).toEqual(['needle 0', 'needle 1']);
    expect(firstBody.nextCursor).toBe('3');

    const second = await fetch(
      `${baseUrl}/api/said?meetingId=${encodeURIComponent(recordingId)}&query=needle&limit=2&cursor=3`,
      { headers: { authorization } },
    );
    const secondBody = (await second.json()) as typeof firstBody;
    expect(secondBody.results.map((result) => result.text)).toEqual(['needle 2', 'needle 3']);
    expect(secondBody.nextCursor).toBe('5');
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
        presentSilent: unknown[];
        presentSilentTruncated: boolean;
      };

      expect(response.status).toBe(200);
      expect(body.notes).toHaveLength(500);
      expect(body.notesTruncated).toBe(true);
      expect(body.timelineTruncated).toBe(true);
      expect(body.presentSilent).toHaveLength(100);
      expect(body.presentSilentTruncated).toBe(true);
    } finally {
      candidate.notes = [];
      candidate.presence = [];
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

  it('não perde falas autorizadas antigas quando candidatas recentes são inacessíveis', async () => {
    const response = await fetch(`${baseUrl}/api/said?guildId=${encodeURIComponent(guildId)}&query=needle&limit=1`, {
      headers: { authorization },
    });
    const body = (await response.json()) as { results: { meetingId: string }[] };

    expect(response.status).toBe(200);
    expect(body.results).toHaveLength(1);
    expect([recordingId, secondRecordingId]).toContain(body.results[0].meetingId);
  });

  it('pagina resultados de busca depois de ordenar a janela limitada', async () => {
    const url = `${baseUrl}/api/search?guildId=${encodeURIComponent(guildId)}&query=needle&limit=1`;
    const first = await fetch(url, { headers: { authorization } });
    const firstBody = (await first.json()) as {
      results: { id: string }[];
      nextCursor: string | null;
      total: number;
    };
    expect(firstBody.results.map((result) => result.id)).toEqual([recordingId]);
    expect(firstBody).toMatchObject({ total: 2, nextCursor: '2' });

    const second = await fetch(`${url}&cursor=2`, { headers: { authorization } });
    const secondBody = (await second.json()) as typeof firstBody;
    expect(secondBody.results.map((result) => result.id)).toEqual([secondRecordingId]);
    expect(secondBody.nextCursor).toBeNull();
  });

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
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ meetingsTruncated: true, meetingScanLimit: 300 });
  });
});
