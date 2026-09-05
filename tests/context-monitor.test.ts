import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ChannelType, Collection, type Guild, type GuildMember } from 'discord.js';
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
    vi.stubEnv('DEFAULT_LOCALE', 'pt');
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
    send.mockReset().mockResolvedValue(undefined);
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
          [
            channelId,
            {
              id: channelId,
              type: ChannelType.GuildVoice,
              name: 'Canal privado',
              permissionsFor: () => ({ has: () => channelVisible }),
            },
          ],
          [
            'other-channel',
            {
              id: 'other-channel',
              type: ChannelType.GuildVoice,
              name: 'Outro canal privado',
              permissionsFor: () => ({ has: () => true }),
            },
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
    fs.rmSync(path.join(stateDir, 'context-delivery.json'), { force: true });
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
    expect(checkedCredentials[0]).toBe('Bearer synthetic-test-credential');
    expect(checkedCredentials.length).toBeGreaterThan(1);
    expect(checkedCredentials.slice(1).every((value) => value === 'Bearer synthetic-recipient-credential')).toBe(true);
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
      .update(`${userId}:synthetic-event:${startAt + 40 * 60_000}:${channelId}:1`)
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

  it.each(['symlink', 'hardlink', 'oversize'] as const)(
    'does not replace an unsafe %s event ledger with a sent notice',
    async (kind) => {
      addEvent();
      await follow();
      const service = context.contextRuntime().service;
      await service.acknowledgeDigest(userId, await service.prepareDigest(userId));
      const original = path.join(stateDir, 'event-notices-fixture.json');
      const file = path.join(stateDir, 'context-event-notices.json');
      fs.writeFileSync(original, '[]');
      if (kind === 'symlink') fs.symlinkSync(original, file);
      else if (kind === 'hardlink') fs.linkSync(original, file);
      else fs.writeFileSync(file, `${' '.repeat(2 * 1024 * 1024)}[]`);
      await tick();
      expect(send).not.toHaveBeenCalled();
      expect(fs.readFileSync(original, 'utf8')).toBe('[]');
      if (kind === 'symlink') expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
      if (kind === 'hardlink') expect(fs.statSync(file).nlink).toBe(2);
      fs.unlinkSync(original);
    },
  );

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
  it('links a single changed item directly and reports confirmed delivery only to its recipient', async () => {
    await follow();
    expect(context.contextDeliveryStatus(userId).state).toBe('never');
    await tick();
    expect(send.mock.calls[0][1]).toContain(`?commitment=${commitmentId}`);
    expect(context.contextDeliveryStatus(userId)).toEqual({
      state: 'delivered',
      lastAttemptAt: startAt + interval,
      lastDeliveredAt: startAt + interval,
      nextAttemptAt: undefined,
    });
    expect(context.contextDeliveryStatus('930000000000000009').state).toBe('never');
  });

  it('records blocked DMs with backoff instead of retrying every sweep', async () => {
    await follow();
    send.mockRejectedValueOnce(Object.assign(new Error('private Discord response'), { code: 50007 }));
    await tick();
    expect(context.contextDeliveryStatus(userId)).toMatchObject({
      state: 'blocked',
      nextAttemptAt: startAt + interval + 86400000,
    });
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect((await context.contextRuntime().service.prepareDigest(userId)).items).toHaveLength(1);
    expect(JSON.stringify(context.contextDeliveryStatus(userId))).not.toContain('private Discord response');
  });

  it('keeps a timed-out delivery single-flight and acknowledges a later confirmed success', async () => {
    await follow();
    let resolve!: () => void;
    send.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    await tick();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(context.contextDeliveryStatus(userId)).toMatchObject({
      state: 'uncertain',
      nextAttemptAt: startAt + interval + 86400000,
    });
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(context.contextDeliveryStatus(userId).state).toBe('delivered');
    expect((await context.contextRuntime().service.prepareDigest(userId)).items).toEqual([]);
  });

  it('follows an authorized empty voice channel and sends its scheduled reminder', async () => {
    const empty = '930000000000000008';
    client.guilds.cache.get(guildId)!.channels.cache.set(empty, {
      id: empty,
      name: 'Empty private channel',
      type: ChannelType.GuildVoice,
      permissionsFor: () => ({ has: () => true }),
    } as never);
    const inventory = await context.listAuthorizedContextChannels(userId);
    expect(inventory.channels.some((c) => c.channelId === empty)).toBe(true);
    await context.contextRuntime().service.setChannelSubscription(userId, { guildId, channelId: empty }, 'follow');
    addEvent('empty-event', empty);
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toContain(`?channel=${empty}`);
    client.guilds.cache.get(guildId)!.channels.cache.delete(empty);
  });

  it('notifies rescheduling and cancellation once, without repeating ordinary event progression', async () => {
    addEvent();
    await follow();
    const service = context.contextRuntime().service;
    await service.acknowledgeDigest(userId, await service.prepareDigest(userId));
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    scheduled.get('synthetic-event')!.scheduledStartTimestamp = startAt + 120 * 60000;
    await tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1]).toContain('mudou de horário ou canal');
    scheduled.get('synthetic-event')!.status = 4;
    await tick();
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2][1]).toContain('cancelado ou removido');
    await tick();
    expect(send).toHaveBeenCalledTimes(3);
    assertPrivate();
  });

  it('notifies deletion only after a successful event fetch, not after access loss or provider failure', async () => {
    addEvent();
    await follow();
    const service = context.contextRuntime().service;
    await service.acknowledgeDigest(userId, await service.prepareDigest(userId));
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    eventFetch.mockRejectedValueOnce(new Error('synthetic unavailable'));
    scheduled.clear();
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    channelVisible = false;
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    channelVisible = true;
    await tick();
    // Its start time has passed during the outage: disappearance no longer proves cancellation.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('updates the channel of an already announced event only with current destination access', async () => {
    const destination = '930000000000000008';
    let visible = false;
    client.guilds.cache.get(guildId)!.channels.cache.set(destination, {
      id: destination,
      name: 'Private destination',
      type: ChannelType.GuildVoice,
      permissionsFor: () => ({ has: () => visible }),
    } as never);
    addEvent();
    await follow();
    const service = context.contextRuntime().service;
    await service.acknowledgeDigest(userId, await service.prepareDigest(userId));
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    scheduled.get('synthetic-event')!.channelId = destination;
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    visible = true;
    await tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1]).toContain(`?channel=${destination}`);
    scheduled.get('synthetic-event')!.status = 4;
    await tick();
    expect(send).toHaveBeenCalledTimes(3);
    client.guilds.cache.get(guildId)!.channels.cache.delete(destination);
  });

  it('migrates a legacy reminder nonce without sending the same event again', async () => {
    addEvent();
    await follow();
    const service = context.contextRuntime().service;
    await service.acknowledgeDigest(userId, await service.prepareDigest(userId));
    const key = crypto
      .createHash('sha256')
      .update(`${userId}:synthetic-event:${startAt + 40 * 60000}`)
      .digest('hex');
    fs.writeFileSync(
      path.join(stateDir, 'context-event-notices.json'),
      JSON.stringify([{ key, expiresAt: startAt + 86400000 }]),
    );
    await tick();
    expect(send).not.toHaveBeenCalled();
    scheduled.get('synthetic-event')!.status = 4;
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('does not let 100 followed completed items hide an older open event channel', async () => {
    const recentId = `newer-${crypto.randomUUID()}`;
    const other = '930000000000000008';
    const meta = { ...store.readMeta(meetingId)!, id: recentId, voiceChannelId: other, startedAt: startAt - 600000 };
    store.saveMeta(meta);
    const { createCommitmentService } = await import('../src/commitments');
    const seed = createCommitmentService({ stateDir, authorize: async () => true });
    const recent = seed.syncMeeting(
      meta,
      Array.from({ length: 100 }, (_, i) => ({ tarefa: `Completed fixture ${i}` })),
    );
    try {
      for (const item of recent) {
        await seed.setPreference(userId, item.id, { mode: 'follow' });
        await seed.setStatus(userId, item.id, 'completed', { acknowledgeReview: true });
      }
      await follow();
      const service = context.contextRuntime().service;
      for (let i = 0; i < 3; i++)
        await context.withContextAccess(() =>
          service.prepareDigest(userId).then((d) => service.acknowledgeDigest(userId, d)),
        );
      addEvent();
      await tick();
      expect(eventFetch).toHaveBeenCalledTimes(1);
      expect(send.mock.calls.some(([, content]) => content.includes('começa em até 30 minutos'))).toBe(true);
    } finally {
      store.deleteRecording(recentId);
    }
  });

  it('links every changed item in bounded batch messages without exceeding Discord content limits', async () => {
    const service = context.contextRuntime().service;
    const meta = store.readMeta(meetingId)!;
    const actions = Array.from({ length: 45 }, (_, i) => ({
      tarefa: `Private batch fixture ${i}`,
      source: { startMs: 1000, endMs: 3000, quote: 'citação secreta' },
    }));
    const items = service.syncMeeting(meta, actions);
    await context.withContextAccess(async () => {
      for (const item of items) await service.setPreference(userId, item.id, { mode: 'follow' });
    });
    await tick();
    expect(send).toHaveBeenCalledTimes(2);
    const ids = send.mock.calls.flatMap(([, content]) => {
      expect(content.length).toBeLessThanOrEqual(2000);
      return new URL(content.match(/http:\/\/\S+/)![0]).searchParams.get('ids')!.split(',');
    });
    expect(new Set(ids)).toEqual(new Set(items.map((item) => item.id)));
    expect((await service.prepareDigest(userId)).items).toEqual([]);
  });
  it('revalidates a prepared digest after a concurrent mute before handing anything to Discord', async () => {
    await follow();
    const service = context.contextRuntime().service;
    const prepare = service.prepareDigest.bind(service);
    vi.spyOn(service, 'prepareDigest').mockImplementationOnce(async (recipient) => {
      const digest = await prepare(recipient);
      await service.setPreference(userId, commitmentId, { mode: 'mute' });
      return digest;
    });
    await tick();
    expect(send).not.toHaveBeenCalled();
  });

  it('honors mute while the scheduled-events request is in flight', async () => {
    addEvent();
    await follow();
    const service = context.contextRuntime().service;
    await service.acknowledgeDigest(userId, await service.prepareDigest(userId));
    eventFetch.mockImplementationOnce(async () => {
      await service.setPreference(userId, commitmentId, { mode: 'mute' });
      return scheduled;
    });
    await tick();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not label normal start, completion, and later disappearance as a cancellation', async () => {
    addEvent();
    await follow();
    const service = context.contextRuntime().service;
    await service.acknowledgeDigest(userId, await service.prepareDigest(userId));
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    scheduled.get('synthetic-event')!.status = 2;
    await tick();
    scheduled.get('synthetic-event')!.status = 3;
    await tick();
    scheduled.clear();
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('bounds a permanently pending send and ignores success from an obsolete attempt', async () => {
    await follow();
    let resolveOld!: () => void;
    send.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveOld = resolve;
        }),
    );
    await tick();
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(86400000 + interval);
    expect(send).toHaveBeenCalledTimes(2);
    const delivered = context.contextDeliveryStatus(userId).lastDeliveredAt;
    resolveOld();
    await vi.advanceTimersByTimeAsync(1);
    expect(context.contextDeliveryStatus(userId).lastDeliveredAt).toBe(delivered);
  });

  it('keeps the event ledger readable when a new richer notice would exceed its byte limit', async () => {
    addEvent();
    await follow();
    const service = context.contextRuntime().service;
    await service.acknowledgeDigest(userId, await service.prepareDigest(userId));
    const base = { key: 'f'.repeat(64), expiresAt: startAt + 86400000, padding: '' };
    base.padding = 'x'.repeat(2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify([base])));
    const raw = JSON.stringify([base]);
    const file = path.join(stateDir, 'context-event-notices.json');
    fs.writeFileSync(file, raw);
    await tick();
    expect(send).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);
  });

  it.each(['symlink', 'hardlink'] as const)(
    'does not deliver through an unsafe %s delivery-status file',
    async (kind) => {
      await follow();
      const original = path.join(stateDir, 'delivery-fixture.json');
      const file = path.join(stateDir, 'context-delivery.json');
      fs.writeFileSync(original, '[]');
      if (kind === 'symlink') fs.symlinkSync(original, file);
      else fs.linkSync(original, file);
      try {
        await tick();
        expect(send).not.toHaveBeenCalled();
        expect(fs.readFileSync(original, 'utf8')).toBe('[]');
      } finally {
        fs.unlinkSync(original);
      }
    },
  );

  it('propagates incomplete audio and partial transcription into the source review requirement', async () => {
    const meta = {
      ...store.readMeta(meetingId)!,
      audioIncomplete: true,
      transcription: { status: 'partial' as const },
    };
    store.saveMeta(meta);
    context.syncContextMeeting(meta);
    const [view] = await context.contextRuntime().service.listForUser(userId, { commitmentId });
    expect(view.sourceQuality).toEqual({ audioIncomplete: true, transcriptionPartial: true });
    expect(view.reviewRequired).toBe(true);
  });
  it('announces a confirmed deletion before the scheduled start', async () => {
    addEvent();
    await follow();
    const service = context.contextRuntime().service;
    await service.acknowledgeDigest(userId, await service.prepareDigest(userId));
    await tick();
    scheduled.clear();
    await tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1]).toContain('cancelado ou removido');
  });

  it('does not infer cancellation when a short event completes entirely between sweeps', async () => {
    addEvent('synthetic-event', channelId, 20);
    await follow();
    const service = context.contextRuntime().service;
    await service.acknowledgeDigest(userId, await service.prepareDigest(userId));
    await tick();
    scheduled.clear();
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
