import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { Collection, type Guild, type GuildMember } from 'discord.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { CommitmentAuthorizationUnavailableError, createCommitmentService } from '../src/commitments';
import { contextRuntime } from '../src/context';
import { client } from '../src/discord/client';
import { markClientReady } from '../src/discord/ready';
import { deleteRecording, readMeta, saveMeta, type RecordingMeta } from '../src/store';
import { mountMcpApi, resetMcpApiRateLimitsForTests } from '../src/web/api';
import { signMcpAccess } from '../src/web/auth';
import { createSession, revokeUser, type McpContent } from '../src/web/mcpTokens';

const recipientAccess = vi.hoisted(() => ({ allowed: true, unavailable: false }));
vi.mock('../src/integrations/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/integrations/access')>()),
  createRecipientArtifactAccess: () => ({
    canRead: async () => {
      if (recipientAccess.unavailable) throw new Error('synthetic private upstream detail');
      return recipientAccess.allowed;
    },
    recipientCredentialsStatus: () => ({ github: true, jira: true }),
  }),
}));

describe('read-only commitment lifecycle through MCP', () => {
  const userId = '920000000000000001';
  const guildId = '920000000000000002';
  const channelId = '920000000000000003';
  const callAt = Date.now() - 60_000;
  const ids = Array.from({ length: 4 }, () => `commitment-api-${crypto.randomUUID()}`);
  let server: http.Server;
  let baseUrl: string;
  let authorization: string;
  let orderedIds: string[];
  const fetchMember = vi.fn(async () => ({ id: userId, permissions: { has: () => false } }) as unknown as GuildMember);
  const service = createCommitmentService({
    stateDir: config.stateDir,
    authorize: async () => true,
    authorizeArtifact: async () => true,
    integrations: {
      resolve(url) {
        if (url.startsWith('https://example.atlassian.net/browse/'))
          return {
            kind: 'jira-issue',
            url,
            origin: 'https://example.atlassian.net',
            issueKey: 'WORK-7',
          };
        return {
          kind: 'github-pull',
          url,
          origin: 'https://github.com',
          repository: url.includes('/visible/') ? 'example/visible' : 'example/hidden',
          number: 1,
        };
      },
      async lookup(ref) {
        if (ref.kind === 'jira-issue')
          return {
            state: 'done',
            label: 'Concluído',
            title: 'Título Jira reservado',
            checkedAt: Date.now(),
            deployed: null,
          };
        return { state: 'merged', label: 'merged', title: ref.repository!, checkedAt: Date.now(), deployed: null };
      },
    },
  });
  const token = (content: McpContent[] = ['minutes'], id = userId) => {
    const session = createSession(id, 'Pessoa', undefined, {
      scope: { guildIds: [guildId], channelIds: [channelId], fromMs: callAt - 1000, toMs: callAt + 1000, content },
    });
    return `Bearer ${signMcpAccess({ id, name: 'Pessoa', exp: Date.now() + 3_600_000, jti: session.sid })}`;
  };
  const get = (query = '', auth = authorization) =>
    fetch(`${baseUrl}/api/commitments${query}`, { headers: { authorization: auth } });
  type Page = {
    commitments: Array<{
      id: string;
      meetingId: string;
      status: string;
      source?: unknown;
      links: unknown[];
      completionRule?: unknown;
      effectiveCompletion?: unknown;
    }>;
    returned: number;
    nextCursor: string | null;
    nextScanCursor: string | null;
  };

  beforeAll(async () => {
    vi.stubEnv('KASSINAO_CONTEXT_SCOPES', '[]');
    vi.stubEnv('KASSINAO_CONTEXT_USER_CREDENTIALS', '{}');
    vi.stubEnv(
      'KASSINAO_CONTEXT_READERS',
      JSON.stringify([
        {
          userId,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          githubRepositories: ['example/visible'],
          jiraProjects: [{ site: 'https://example.atlassian.net', projects: ['WORK'] }],
        },
      ]),
    );
    markClientReady();
    client.guilds.cache.set(guildId, {
      id: guildId,
      members: { fetch: fetchMember },
      channels: { cache: new Collection(), fetch: async () => null },
    } as unknown as Guild);
    for (const [index, id] of ids.entries()) {
      const meta: RecordingMeta = {
        id,
        guildId,
        guildName: 'Fixture',
        voiceChannelId: index === 1 ? 'other-channel' : channelId,
        voiceChannelName: 'Call',
        sourceEveryoneViewable: false,
        startedAt: index === 2 ? callAt - 50 * 86400000 : callAt,
        endedAt: callAt + 30_000,
        status: 'done',
        startedBy: { id: index === 3 ? 'someone-else' : userId, name: 'Pessoa' },
        participants: [],
        presence: [],
        notes: [],
        events: [],
        minutes: { status: 'done' },
      };
      saveMeta(meta);
      const entries = service.syncMeeting(
        meta,
        Array.from({ length: index === 0 ? 103 : 1 }, (_, n) => ({
          tarefa: `task-${index}-${n}`,
          prazo: 'amanhã',
          source: { startMs: n * 1000, endMs: n * 1000 + 500, quote: 'raw-source-quote' },
        })),
      );
      if (index === 0) {
        orderedIds = entries.map((entry) => entry.id).sort();
        await service.setStatus(userId, orderedIds[0], 'confirmed');
        await service.setStatus(userId, orderedIds[102], 'completed');
        await service.setLinks(userId, orderedIds[0], [
          'https://github.com/example/visible/pull/1',
          'https://github.com/example/hidden/pull/1',
        ]);
      }
    }
    await service.reconcile();
    authorization = token();
    const app = express();
    mountMcpApi(app);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(() => {
    resetMcpApiRateLimitsForTests();
    recipientAccess.allowed = true;
    recipientAccess.unavailable = false;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    for (const id of ids) deleteRecording(id);
    client.guilds.cache.delete(guildId);
    revokeUser(userId);
    revokeUser('920000000000000004');
    vi.unstubAllEnvs();
  });

  it('caps each page at 100 and continues without duplicate or missing items', async () => {
    const first = await get('?last=60d&limit=500');
    expect(first.status).toBe(200);
    const a = (await first.json()) as Page;
    expect(a.returned).toBe(100);
    expect(a.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.nextScanCursor).toBeNull();
    expect(a.commitments.every((entry) => entry.meetingId === ids[0])).toBe(true);
    const second = await get(`?last=60d&limit=500&cursor=${a.nextCursor}`);
    expect(second.status).toBe(200);
    const b = (await second.json()) as Page;
    expect(b.returned).toBe(3);
    expect(b.nextCursor).toBeNull();
    expect([...a.commitments, ...b.commitments].map((entry) => entry.id)).toEqual(orderedIds);
    expect(b.commitments.at(-1)?.status).toBe('completed');
  });

  it('returns recorded lifecycle and only currently authorized artifacts; a merge stays distinct from completion', async () => {
    const response = await get('?status=confirmed');
    expect(response.status).toBe(200);
    const page = (await response.json()) as Page;
    expect(page.commitments).toHaveLength(1);
    expect(page.commitments[0]).toMatchObject({
      id: orderedIds[0],
      status: 'confirmed',
      links: [{ snapshot: { state: 'merged', deployed: null } }],
    });
    expect(page.commitments[0].source).toBeUndefined();
    const serialized = JSON.stringify(page);
    expect(serialized).toContain('example/visible');
    expect(serialized).not.toContain('example/hidden');
    expect(serialized).not.toContain('raw-source-quote');
    const full = await get('?status=confirmed', token(['minutes', 'transcript']));
    expect(JSON.stringify(await full.json())).toContain('raw-source-quote');
    expect((await get('', token(['transcript']))).status).toBe(403);
  });

  it('reports unavailable source checks without exposing links or presenting missing evidence as complete data', async () => {
    recipientAccess.unavailable = true;
    const response = await get('?status=confirmed');
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page).toMatchObject({
      sourceAccessIncomplete: true,
      commitments: [{ id: orderedIds[0], sourceAccessIncomplete: true, links: [], effectiveCompletion: null }],
    });
    expect(page.commitments[0].contextUrl).toContain(`?commitment=${orderedIds[0]}`);
    expect(JSON.stringify(page)).not.toContain('example/visible');
    expect(JSON.stringify(page)).not.toContain('synthetic private upstream detail');
  });

  it('binds cursors to user, session/scope and filters but allows lifecycle changes during pagination', async () => {
    const first = await get('?limit=1');
    const page = (await first.json()) as Page;
    expect(page.nextCursor).toBeTruthy();
    await service.setStatus(userId, orderedIds[1], 'cancelled');
    try {
      const next = await get(`?limit=1&cursor=${page.nextCursor}`);
      expect(next.status).toBe(200);
      expect(await next.json()).toMatchObject({ commitments: [{ id: orderedIds[1], status: 'cancelled' }] });
      for (const auth of [token(['minutes', 'transcript']), token(['minutes'], '920000000000000004')])
        expect((await get(`?limit=1&cursor=${page.nextCursor}`, auth)).status).toBe(400);
      expect((await get(`?limit=1&status=mentioned&cursor=${page.nextCursor}`)).status).toBe(400);
      expect((await get(`?limit=1&cursor=x${page.nextCursor}`)).status).toBe(400);
    } finally {
      await service.setStatus(userId, orderedIds[1], 'mentioned');
    }
  });

  it('projects explicit source completion only while current artifact access permits it, without transcript quotes', async () => {
    const id = orderedIds[2];
    const url = 'https://example.atlassian.net/browse/WORK-7';
    await service.setLinks(userId, id, [url]);
    await service.reconcile();
    await service.setCompletionRule(userId, id, { kind: 'artifact', url, state: 'done' });
    try {
      const response = await get('?limit=5');
      expect(response.status).toBe(200);
      const item = ((await response.json()) as Page).commitments.find((entry) => entry.id === id);
      expect(item).toMatchObject({
        status: 'mentioned',
        completionRule: { kind: 'artifact', url, state: 'done' },
        effectiveCompletion: { url, state: 'done', checkedAt: expect.any(Number) },
        links: [{ snapshot: { state: 'done', title: 'Título Jira reservado', deployed: null } }],
      });
      expect(item?.source).toBeUndefined();
      expect(JSON.stringify(item)).not.toContain('raw-source-quote');

      recipientAccess.allowed = false;
      const denied = await get('?limit=5');
      expect(denied.status).toBe(200);
      const hidden = ((await denied.json()) as Page).commitments.find((entry) => entry.id === id);
      expect(hidden).toMatchObject({
        status: 'mentioned',
        links: [],
        completionRule: null,
        effectiveCompletion: null,
        deadlineState: 'unknown',
      });
      expect(JSON.stringify(hidden)).not.toContain(url);
      expect(JSON.stringify(hidden)).not.toContain('Título Jira reservado');
      expect(JSON.stringify(hidden)).not.toContain('raw-source-quote');
      // Lack of source evidence never writes a pending/completed status back to the record.
      const stored = (await service.listForUser(userId, { meetingId: ids[0] })).find((entry) => entry.id === id);
      expect(stored).toMatchObject({ status: 'mentioned', completionRule: { kind: 'artifact', url, state: 'done' } });
    } finally {
      recipientAccess.allowed = true;
      await service.setCompletionRule(userId, id, { kind: 'manual' });
      await service.setLinks(userId, id, []);
    }
  });

  it('rechecks meeting ACL on continuation and omits recordings outside guild/channel/date scope', async () => {
    const first = await get('?limit=1');
    const page = (await first.json()) as Page;
    const original = readMeta(ids[0])!;
    saveMeta({ ...original, startedBy: { id: 'someone-else', name: 'Outra pessoa' } });
    try {
      const next = await get(`?limit=1&cursor=${page.nextCursor}`);
      expect(next.status).toBe(200);
      expect(await next.json()).toMatchObject({ commitments: [], returned: 0 });
    } finally {
      saveMeta(original);
    }
    expect(await (await get('?guildId=excluded')).json()).toMatchObject({ commitments: [] });
    expect(await (await get('?channelId=excluded')).json()).toMatchObject({ commitments: [] });
  });

  it('surfaces transient context authorization as 503, validates state and exposes no writes', async () => {
    const spy = vi
      .spyOn(contextRuntime().service, 'listForUser')
      .mockRejectedValueOnce(new CommitmentAuthorizationUnavailableError());
    try {
      expect((await get()).status).toBe(503);
    } finally {
      spy.mockRestore();
    }
    expect((await get('?status=not-a-state')).status).toBe(400);
    const post = await fetch(`${baseUrl}/api/commitments`, { method: 'POST', headers: { authorization } });
    expect(post.status).toBe(404);
  });

  it('uses the existing aggregate read budget', async () => {
    for (let n = 0; n < 12; n++) expect((await get('?limit=1')).status).toBe(200);
    expect((await get('?limit=1')).status).toBe(429);
  });
});
