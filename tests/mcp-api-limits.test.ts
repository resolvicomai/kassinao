import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { Collection, type Guild, type GuildMember } from 'discord.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client } from '../src/discord/client';
import { markClientReady } from '../src/discord/ready';
import { deleteRecording, saveMeta, saveMinutes, saveTranscript, type RecordingMeta } from '../src/store';
import { forgetMember } from '../src/web/access';
import { FixedWindowRateLimiter, mountMcpApi } from '../src/web/api';
import { signMcpAccess, signMcpRefresh } from '../src/web/auth';
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
});

describe('paginação das consultas agregadas MCP', () => {
  const userId = `api-user-${crypto.randomUUID()}`;
  const guildId = `api-guild-${crypto.randomUUID()}`;
  const recordingId = `api-recording-${crypto.randomUUID()}`;
  const secondRecordingId = `api-recording-${crypto.randomUUID()}`;
  let server: http.Server;
  let baseUrl: string;
  let authorization: string;
  let initialRefreshToken: string;

  beforeAll(async () => {
    markClientReady();
    const member = {
      id: userId,
      permissions: { has: () => false },
    } as unknown as GuildMember;
    const guild = {
      id: guildId,
      members: { fetch: async () => member },
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

    const session = createSession(userId, 'Lia');
    authorization = `Bearer ${signMcpAccess({ id: userId, name: 'Lia', exp: now + 60_000, jti: session.sid })}`;
    initialRefreshToken = signMcpRefresh({
      id: userId,
      name: 'Lia',
      exp: session.exp,
      jti: session.sid,
      gen: session.gen,
    });
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
    forgetMember(guildId, userId);
    client.guilds.cache.delete(guildId);
    deleteRecording(recordingId);
    deleteRecording(secondRecordingId);
    revokeUser(userId);
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

  it('reemite a rotação após resposta perdida e avança normalmente depois', async () => {
    const firstAttempt = '0123456789abcdef0123456789abcdef';
    const rotate = (refreshToken: string, attemptId: string) =>
      fetch(`${baseUrl}/api/mcp/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken, attempt_id: attemptId }),
      });

    const malformed = await rotate(initialRefreshToken, 'not-valid');
    expect(malformed.status).toBe(400);

    const first = await rotate(initialRefreshToken, firstAttempt);
    const firstBody = (await first.json()) as { refresh_token: string };
    const retry = await rotate(initialRefreshToken, firstAttempt);
    const retryBody = (await retry.json()) as { refresh_token: string };

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retryBody.refresh_token).toBe(firstBody.refresh_token);

    const next = await rotate(firstBody.refresh_token, 'fedcba9876543210fedcba9876543210');
    expect(next.status).toBe(200);
    const nextBody = (await next.json()) as { refresh_token: string };

    const legacyClient = await fetch(`${baseUrl}/api/mcp/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: nextBody.refresh_token }),
    });
    expect(legacyClient.status).toBe(200);
  });
});
