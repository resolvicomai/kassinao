import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Collection, type Guild, type GuildMember } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordingMeta } from '../src/store';

const userId = '930000000000000001';
const guildId = '930000000000000002';
const channelId = '930000000000000003';
const sourceUrl = 'https://github.com/example/private-project/pull/17';
const privateValues = [
  'Pessoa privada',
  'Canal privado',
  'Evento privado',
  'Tarefa confidencial',
  'citação secreta',
  'private-project',
  'Título privado',
];
const startAt = Date.parse('2026-09-04T12:00:00Z');
const interval = 15 * 60_000;

describe('context monitor with synthetic Discord and source data', () => {
  let context: typeof import('../src/context');
  let store: typeof import('../src/store');
  let client: (typeof import('../src/discord/client'))['client'];
  let stateDir: string;
  let stop: (() => void) | undefined;
  let meetingId: string;
  let commitmentId: string;
  let memberPresent: boolean;
  let channelVisible: boolean;
  const scheduled = new Map<
    string,
    { id: string; name: string; status: number; channelId: string; scheduledStartTimestamp: number }
  >();
  const eventFetch = vi.fn(async () => scheduled);
  const send = vi.fn<(userId: string, content: string, nonce: string) => Promise<void>>(async () => undefined);
  const sourceFetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          number: 17,
          state: 'closed',
          merged: true,
          merged_at: '2026-09-04T11:00:00Z',
          title: 'Título privado',
          updated_at: '2026-09-04T11:00:00Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(startAt);
    vi.stubGlobal('fetch', sourceFetch);
    vi.stubEnv(
      'KASSINAO_CONTEXT_SCOPES',
      JSON.stringify([{ guildId, channelId, githubRepositories: ['example/private-project'] }]),
    );
    vi.stubEnv(
      'KASSINAO_CONTEXT_READERS',
      JSON.stringify([{ userId, expiresAt: '2026-10-01T00:00:00Z', githubRepositories: ['example/private-project'] }]),
    );
    vi.stubEnv('GITHUB_CONTEXT_TOKEN', 'synthetic-test-credential');
    vi.stubEnv(
      'KASSINAO_CONTEXT_USER_CREDENTIALS',
      JSON.stringify({
        [userId]: { githubToken: 'synthetic-recipient-credential' },
      }),
    );
    send.mockClear();
    sourceFetch.mockClear();
    eventFetch.mockClear();
    scheduled.clear();
    memberPresent = true;
    channelVisible = true;
    context = await import('../src/context');
    store = await import('../src/store');
    ({ client } = await import('../src/discord/client'));
    stateDir = (await import('../src/config')).config.stateDir;
    (await import('../src/discord/ready')).markClientReady();
    client.guilds.cache.set(guildId, {
      id: guildId,
      members: {
        fetch: vi.fn(async () => {
          if (!memberPresent) throw Object.assign(new Error('Synthetic missing member'), { code: 10007 });
          return { id: userId, permissions: { has: () => false } } as unknown as GuildMember;
        }),
      },
      channels: {
        cache: new Collection([
          [channelId, { id: channelId, name: 'Canal privado', permissionsFor: () => ({ has: () => channelVisible }) }],
          [
            'other-channel',
            { id: 'other-channel', name: 'Outro canal privado', permissionsFor: () => ({ has: () => true }) },
          ],
        ]),
        fetch: async () => null,
      },
      scheduledEvents: { fetch: eventFetch },
    } as unknown as Guild);
    meetingId = `monitor-${crypto.randomUUID()}`;
    const meta: RecordingMeta = {
      id: meetingId,
      guildId,
      guildName: 'Servidor privado',
      voiceChannelId: channelId,
      voiceChannelName: 'Canal privado',
      sourceEveryoneViewable: false,
      startedBy: { id: userId, name: 'Pessoa privada' },
      startedAt: startAt - 3_600_000,
      endedAt: startAt - 1_800_000,
      status: 'done',
      participants: [],
      presence: [],
      notes: [],
      events: [],
      minutes: { status: 'done' },
    };
    store.saveMeta(meta);
    store.saveMinutes(meetingId, {
      resumo: 'Resumo privado',
      decisoes: [],
      topicos: [],
      porParticipante: [],
      acoes: [
        {
          tarefa: 'Tarefa confidencial',
          responsavel: 'Pessoa privada',
          prazo: 'amanhã',
          source: { startMs: 1000, endMs: 3000, quote: 'citação secreta' },
        },
      ],
    });
    stop = context.startContextMonitor(send);
    [commitmentId] = (await context.contextRuntime().service.listForUser(userId)).map((entry) => entry.id);
    expect(commitmentId).toBeTruthy();
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    store.deleteRecording(meetingId);
    client.guilds.cache.delete(guildId);
    fs.rmSync(path.join(stateDir, 'context-event-notices.json'), { force: true });
    // Every provider request was intercepted; no fallback to the real fetch exists.
    for (const [url, options] of sourceFetch.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(String(url)).toBe('https://api.github.com/repos/example/private-project/pulls/17');
      expect(options.method).toBe('GET');
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const tick = () => vi.advanceTimersByTimeAsync(interval);
  const follow = () => context.contextRuntime().service.setPreference(userId, commitmentId, { mode: 'follow' });
  const addEvent = (id = 'synthetic-event', channel = channelId, afterMinutes = 40) => {
    scheduled.set(id, {
      id,
      name: 'Evento privado',
      channelId: channel,
      status: 1,
      scheduledStartTimestamp: startAt + afterMinutes * 60_000,
    });
  };
  const assertPrivate = () => {
    for (const [recipient, content, nonce] of send.mock.calls) {
      expect(recipient).toBe(userId);
      expect(nonce).toMatch(/^[a-f0-9]{24}$/);
      expect(content).toContain('/app/contexto');
      for (const secret of privateValues) expect(content).not.toContain(secret);
      expect(content).not.toContain(sourceUrl);
      expect(content).not.toContain('https://discord.com/events/');
      expect(content).not.toContain('synthetic-test-credential');
      expect(content).not.toContain('synthetic-recipient-credential');
    }
  };

  it('sends nothing and does not consult events without an explicit follow', async () => {
    addEvent();
    await tick();
    expect(send).not.toHaveBeenCalled();
    expect(eventFetch).not.toHaveBeenCalled();
    expect(sourceFetch).not.toHaveBeenCalled();
  });

  it('sends a generic digest with nonce, acknowledges only delivery, and stays quiet without changes', async () => {
    const service = context.contextRuntime().service;
    await service.setLinks(userId, commitmentId, [sourceUrl]);
    await follow();
    sourceFetch.mockClear();
    await tick();
    const checkedCredentials = (sourceFetch.mock.calls as unknown as Array<[string, RequestInit]>).map(([, options]) =>
      new Headers(options.headers).get('authorization'),
    );
    expect(checkedCredentials).toEqual(['Bearer synthetic-test-credential', 'Bearer synthetic-recipient-credential']);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toContain('1 atualização');
    expect((await service.prepareDigest(userId)).items).toEqual([]);
    const [view] = await service.listForUser(userId);
    expect(view.links[0].snapshot).toMatchObject({ state: 'merged', title: 'Título privado', deployed: null });
    expect(view.lastNotice?.at).toBe(startAt + interval);
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    assertPrivate();
  });

  it('leaves failed delivery pending and retries the same generic nonce before acknowledging', async () => {
    await follow();
    send.mockRejectedValueOnce(new Error('synthetic delivery failure'));
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect((await context.contextRuntime().service.prepareDigest(userId)).items).toHaveLength(1);
    await tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][2]).toBe(send.mock.calls[1][2]);
    expect((await context.contextRuntime().service.prepareDigest(userId)).items).toEqual([]);
    assertPrivate();
  });

  it('reminds only within 30 minutes for a followed channel and persists deduplication across restart', async () => {
    addEvent();
    addEvent('other-channel-event', 'other-channel');
    addEvent('later-event', channelId, 90);
    await follow();
    const service = context.contextRuntime().service;
    await service.acknowledgeDigest(userId, await service.prepareDigest(userId));
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toContain('começa em até 30 minutos');
    const expectedNonce = crypto
      .createHash('sha256')
      .update(`${userId}:synthetic-event:${startAt + 40 * 60_000}`)
      .digest('hex')
      .slice(0, 24);
    expect(send.mock.calls[0][2]).toBe(expectedNonce);
    stop?.();
    stop = context.startContextMonitor(send);
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(eventFetch).toHaveBeenCalledTimes(2);
    assertPrivate();
  });

  it.each(['mute', 'membership', 'channel'] as const)('blocks reminders after %s revocation', async (mode) => {
    addEvent();
    await follow();
    const service = context.contextRuntime().service;
    if (mode === 'mute') await service.setPreference(userId, commitmentId, { mode: 'mute' });
    if (mode === 'membership') memberPresent = false;
    if (mode === 'channel') {
      await service.acknowledgeDigest(userId, await service.prepareDigest(userId));
      channelVisible = false;
    }
    await tick();
    expect(send).not.toHaveBeenCalled();
  });
});
