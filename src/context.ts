import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import crypto from 'node:crypto';
import { ChannelType, PermissionFlagsBits, type GuildMember } from 'discord.js';
import { readPrivateFileBounded, writeJsonStateAtomic } from './stateFile';
import { config } from './config';
import { t } from './i18n';
import { client } from './discord/client';
import { isClientReady } from './discord/ready';
import { CommitmentCapacityError, createCommitmentService } from './commitments';
import { createIntegrationClient } from './integrations/client';
import { jiraOrigin, parseIntegrationConfiguration } from './integrations/config';
import {
  createRecipientArtifactAccess,
  parseContextUserCredentials,
  withRecipientArtifactAccess,
} from './integrations/access';
import type { ArtifactReference } from './integrations/types';
import { checkAccess, createAccessRequestContext, withFreshMembershipBudget } from './web/access';
import { listMetas, readMeta, readMinutes, readTranscriptBounded, RecordingMeta } from './store';
import { verifiedMinutesSource } from './processing/minutes';
import { operationalWarn } from './operationalLog';

interface ReaderGrant {
  userId: string;
  expiresAt: number;
  githubRepositories: string[];
  jiraProjects: { site: string; projects: string[] }[];
  documentOrigins: string[];
}

/** Explicit operator grants; technical-account access alone never authorizes a recipient. */
export function parseContextReaderGrants(raw = '[]'): ReaderGrant[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid context reader grants');
  }
  if (!Array.isArray(parsed) || parsed.length > 1000) throw new Error('Invalid context reader grants');
  const strings = (value: unknown): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 100 || value.some((x) => typeof x !== 'string' || x.length > 500))
      throw new Error('Invalid context reader grants');
    return value;
  };
  return parsed.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid context reader grants');
    const e = entry as Record<string, unknown>;
    if (typeof e.userId !== 'string' || !/^\d{1,30}$/.test(e.userId) || typeof e.expiresAt !== 'string')
      throw new Error('Invalid context reader grants');
    const expiresAt = Date.parse(e.expiresAt);
    if (!Number.isFinite(expiresAt)) throw new Error('Invalid context reader expiry');
    const githubRepositories = strings(e.githubRepositories).map((x) => x.toLowerCase());
    if (githubRepositories.some((x) => !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(x)))
      throw new Error('Invalid context repository grant');
    const projects = e.jiraProjects ?? [];
    if (!Array.isArray(projects) || projects.length > 30) throw new Error('Invalid context Jira grants');
    const jiraProjects = projects.map((p: unknown) => {
      if (!p || typeof p !== 'object') throw new Error('Invalid context Jira grant');
      const v = p as Record<string, unknown>;
      if (typeof v.site !== 'string') throw new Error('Invalid context Jira grant');
      const keys = strings(v.projects);
      if (keys.some((key) => !/^[A-Z][A-Z0-9_]{0,39}$/.test(key))) throw new Error('Invalid context Jira project');
      return { site: jiraOrigin(v.site), projects: keys };
    });
    const documentOrigins = strings(e.documentOrigins).map((origin) => {
      const url = new URL(origin);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        throw new Error('Invalid context document origin');
      return url.origin;
    });
    return { userId: e.userId, expiresAt, githubRepositories, jiraProjects, documentOrigins };
  });
}

export function readerCanAccessArtifact(
  grants: ReaderGrant[],
  userId: string,
  ref: ArtifactReference,
  now = Date.now(),
): boolean {
  return grants.some(
    (grant) =>
      grant.userId === userId &&
      grant.expiresAt > now &&
      (((ref.kind === 'github-issue' || ref.kind === 'github-pull') &&
        ref.origin === 'https://github.com' &&
        ref.repository &&
        grant.githubRepositories.includes(ref.repository.toLowerCase())) ||
        (ref.kind === 'jira-issue' &&
          grant.jiraProjects.some(
            (p) => p.site === ref.origin && p.projects.includes(ref.issueKey?.split('-')[0] ?? ''),
          )) ||
        (ref.kind === 'document' && grant.documentOrigins.includes(ref.origin))),
  );
}

export interface ContextEvent {
  id: string;
  name: string;
  at: number;
  channelId: string;
  channelName: string;
  url: string;
}
interface EventSnapshot extends ContextEvent {
  guildId: string;
  status: number;
}

async function contextMember(userId: string, guildId: string): Promise<GuildMember | null> {
  if (!/^\d{1,30}$/.test(userId) || !config.guildPolicy.allows(guildId)) return null;
  const guild = client.guilds.cache.get(guildId);
  if (!guild || guild.available === false) return null;
  const key = `${guildId}:${userId}`;
  const checks = accessContexts.getStore()?.memberChecks;
  const existing = checks?.get(key);
  if (existing) return existing;
  const check = withFreshMembershipBudget(userId, () =>
    guild.members.fetch({ user: userId, force: true, cache: false }),
  ).catch((error) => {
    if ([10007, 10013].includes((error as { code?: number }).code ?? 0)) return null;
    throw error;
  });
  checks?.set(key, check);
  return check;
}

/** The channel list authorizes future subscriptions; it does not grant access to recording history. */
export async function listAuthorizedContextChannels(userId: string): Promise<{
  channels: { guildId: string; guildName: string; channelId: string; channelName: string }[];
  incomplete: boolean;
}> {
  const channels: { guildId: string; guildName: string; channelId: string; channelName: string }[] = [];
  const guilds = [...client.guilds.cache.values()].filter((g) => config.guildPolicy.allows(g.id));
  let incomplete = guilds.length > 50;
  for (const guild of guilds.slice(0, 50)) {
    try {
      const member = await contextMember(userId, guild.id);
      if (!member) continue;
      for (const channel of guild.channels.cache.values()) {
        if (
          ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type) ||
          !channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)
        )
          continue;
        if (channels.length >= 1000) {
          incomplete = true;
          break;
        }
        channels.push({ guildId: guild.id, guildName: guild.name, channelId: channel.id, channelName: channel.name });
      }
    } catch {
      incomplete = true;
    }
  }
  return { channels, incomplete };
}

async function authorizeContextChannel(userId: string, guildId: string, channelId: string): Promise<boolean> {
  const member = await contextMember(userId, guildId);
  const channel = client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
  return (
    !!member &&
    !!channel &&
    [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type) &&
    !!channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)
  );
}

async function inspectContextEvents(userId: string, guildIds?: Set<string>, offset = 0) {
  const events: EventSnapshot[] = [];
  const checkedGuilds = new Set<string>();
  const observedIds = new Set<string>();
  const visibleChannels = new Set<string>();
  const guilds = [...client.guilds.cache.values()].filter(
    (g) => config.guildPolicy.allows(g.id) && (!guildIds || guildIds.has(g.id)),
  );
  const start = offset >= guilds.length ? 0 : offset;
  const selected = guilds.slice(start, start + 5);
  let incomplete = guilds.length > selected.length;
  for (const guild of selected) {
    try {
      const member = await contextMember(userId, guild.id);
      if (!member) continue;
      const scheduled = await guild.scheduledEvents.fetch();
      checkedGuilds.add(guild.id);
      for (const channel of guild.channels.cache.values())
        if (channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) visibleChannels.add(channel.id);
      for (const event of scheduled.values()) {
        observedIds.add(event.id);
        const at = event.scheduledStartTimestamp;
        const channel = event.channelId ? guild.channels.cache.get(event.channelId) : undefined;
        if (!at || !channel || !visibleChannels.has(channel.id)) continue;
        events.push({
          id: event.id,
          guildId: guild.id,
          name: event.name,
          at,
          channelId: channel.id,
          channelName: channel.name,
          status: event.status,
          url: `https://discord.com/events/${guild.id}/${event.id}`,
        });
      }
    } catch {
      incomplete = true;
    }
  }
  return {
    events,
    observedIds,
    checkedGuilds,
    visibleChannels,
    incomplete,
    nextOffset: start + 5 >= guilds.length ? 0 : start + 5,
  };
}

/** Only explicit Discord scheduled events, checked against current membership and channel access. */
export async function upcomingContextEvents(
  userId: string,
  channelIds?: Set<string>,
  horizonMs = 7 * 86400000,
): Promise<{ events: ContextEvent[]; incomplete: boolean }> {
  const result = await inspectContextEvents(userId);
  return {
    events: result.events
      .filter(
        (event) =>
          event.status === 1 &&
          event.at > Date.now() &&
          event.at <= Date.now() + horizonMs &&
          (!channelIds || channelIds.has(event.channelId)),
      )
      .sort((a, b) => a.at - b.at),
    incomplete: result.incomplete,
  };
}

interface EventNotice {
  key: string;
  expiresAt: number;
  userId?: string;
  eventId?: string;
  guildId?: string;
  channelId?: string;
  at?: number;
  status?: number;
  scopeChannelId?: string;
}
function eventNotices(): EventNotice[] {
  const file = path.join(config.stateDir, 'context-event-notices.json');
  try {
    const entries = JSON.parse(readPrivateFileBounded(file, 2 * 1024 * 1024)) as EventNotice[];
    if (
      !Array.isArray(entries) ||
      entries.length > 10000 ||
      entries.some(
        (e) =>
          !e ||
          !/^[a-f0-9]{64}$/.test(e.key) ||
          !Number.isFinite(e.expiresAt) ||
          (e.userId !== undefined &&
            (!/^\d{1,30}$/.test(e.userId) ||
              typeof e.eventId !== 'string' ||
              e.eventId.length > 100 ||
              !/^\d{1,30}$/.test(e.guildId ?? '') ||
              !/^\d{1,30}$/.test(e.channelId ?? '') ||
              !Number.isFinite(e.at) ||
              (e.scopeChannelId !== undefined && !/^\d{1,30}$/.test(e.scopeChannelId)) ||
              ![1, 2, 3, 4].includes(e.status ?? 0))),
      )
    )
      throw new Error('event notice schema');
    return entries.filter((e) => e.expiresAt > Date.now());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('event notices unavailable', { cause: error });
  }
}
function assertEventNoticeCapacity(entries: EventNotice[]): void {
  if (entries.length > 10000 || Buffer.byteLength(JSON.stringify(entries)) > 2 * 1024 * 1024)
    throw new Error('event notice capacity');
}
function saveEventNotices(entries: EventNotice[]): void {
  assertEventNoticeCapacity(entries);
  writeJsonStateAtomic(path.join(config.stateDir, 'context-event-notices.json'), entries);
}

export interface ContextDeliveryStatus {
  state: 'never' | 'delivered' | 'blocked' | 'retrying' | 'uncertain';
  lastAttemptAt?: number;
  lastDeliveredAt?: number;
  nextAttemptAt?: number;
}
interface DeliveryRecord extends ContextDeliveryStatus {
  userId: string;
  failures: number;
}
function deliveryRecords(): DeliveryRecord[] {
  try {
    const entries = JSON.parse(
      readPrivateFileBounded(path.join(config.stateDir, 'context-delivery.json'), 512 * 1024),
    ) as DeliveryRecord[];
    if (
      !Array.isArray(entries) ||
      entries.length > 1000 ||
      entries.some(
        (e) =>
          !e ||
          !/^\d{1,30}$/.test(e.userId) ||
          !['delivered', 'blocked', 'retrying', 'uncertain'].includes(e.state) ||
          !Number.isInteger(e.failures) ||
          e.failures < 0 ||
          [e.lastAttemptAt, e.lastDeliveredAt, e.nextAttemptAt].some((at) => at !== undefined && !Number.isFinite(at)),
      )
    )
      throw new Error('delivery status schema');
    return entries.filter((e) => (e.lastAttemptAt ?? 0) > Date.now() - 90 * 86400000);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('delivery status unavailable', { cause: error });
  }
}
export function contextDeliveryStatus(userId: string): ContextDeliveryStatus {
  if (!/^\d{1,30}$/.test(userId)) throw new Error('invalid recipient');
  const record = deliveryRecords().find((e) => e.userId === userId);
  if (!record) return { state: 'never' };
  const { state, lastAttemptAt, lastDeliveredAt, nextAttemptAt } = record;
  return { state, lastAttemptAt, lastDeliveredAt, nextAttemptAt };
}
function saveDelivery(userId: string, state: ContextDeliveryStatus['state'], lastAttemptAt: number): void {
  const entries = deliveryRecords();
  const previous = entries.find((e) => e.userId === userId);
  const failures = state === 'delivered' ? 0 : Math.min(20, (previous?.failures ?? 0) + 1);
  const retry = state === 'blocked' ? 86400000 : Math.min(6 * 3600000, 15 * 60000 * 2 ** Math.max(0, failures - 1));
  const remaining = entries.filter((e) => e.userId !== userId);
  if (remaining.length >= 1000) throw new Error('delivery status capacity');
  writeJsonStateAtomic(path.join(config.stateDir, 'context-delivery.json'), [
    ...remaining,
    {
      userId,
      state,
      failures,
      lastAttemptAt,
      lastDeliveredAt: state === 'delivered' ? Date.now() : previous?.lastDeliveredAt,
      nextAttemptAt:
        state === 'delivered' ? undefined : state === 'uncertain' ? lastAttemptAt + 86400000 : Date.now() + retry,
    },
  ]);
}
const pendingDeliveries = new Map<string, { at: number; token: symbol }>();

const accessContexts = new AsyncLocalStorage<ReturnType<typeof createAccessRequestContext>>();
export function withContextAccess<T>(fn: () => Promise<T>): Promise<T> {
  return accessContexts.run(createAccessRequestContext(), () => withRecipientArtifactAccess(fn));
}

let runtime: ReturnType<typeof createContextRuntime> | undefined;
function createContextRuntime() {
  const configuration = parseIntegrationConfiguration(process.env);
  const grants = parseContextReaderGrants(process.env.KASSINAO_CONTEXT_READERS);
  const recipientAccess = createRecipientArtifactAccess(
    configuration,
    parseContextUserCredentials(process.env.KASSINAO_CONTEXT_USER_CREDENTIALS),
  );
  const service = createCommitmentService({
    stateDir: config.stateDir,
    revisionSecret: config.cookieSecret,
    timezone: config.timezone,
    isMeetingActive: (id) => {
      const meta = readMeta(id);
      return !!meta && !meta.demo && config.guildPolicy.allows(meta.guildId) && client.guilds.cache.has(meta.guildId);
    },
    integrations: configuration.scopes.length ? createIntegrationClient(configuration) : undefined,
    maxRequestsPerReconcile: configuration.maxRequestsPerReconcile,
    authorize: async (userId, meetingId) => {
      const meta = readMeta(meetingId);
      return (
        !!meta &&
        !meta.demo &&
        (
          await checkAccess({ id: userId, name: '' }, meta, {
            requestContext: accessContexts.getStore(),
            throwOnTransient: true,
          })
        ).view
      );
    },
    authorizeChannel: authorizeContextChannel,
    authorizeRepair: async (userId, meetingId, options = {}) => {
      const meta = readMeta(meetingId);
      return (
        !!meta &&
        !meta.demo &&
        (
          await checkAccess({ id: userId, name: '' }, meta, {
            requestContext: accessContexts.getStore(),
            freshMember: options.fresh,
            throwOnTransient: true,
          })
        ).delete
      );
    },
    authorizeSource: async (userId, meetingId, source) => {
      const meta = readMeta(meetingId);
      if (
        !meta ||
        meta.demo ||
        !(
          await checkAccess({ id: userId, name: '' }, meta, {
            requestContext: accessContexts.getStore(),
            throwOnTransient: true,
          })
        ).view
      )
        return false;
      const transcript = readTranscriptBounded(meetingId, 8 * 1024 * 1024);
      return transcript.status === 'ok' && !!verifiedMinutesSource(source, transcript.segments);
    },
    authorizeArtifact: async (userId, reference, context) =>
      readerCanAccessArtifact(grants, userId, reference) && recipientAccess.canRead(userId, reference, context),
  });
  return {
    service,
    configuration,
    recipientCredentialsStatus: recipientAccess.recipientCredentialsStatus,
    recipientAccessStatus: (userId: string) => recipientAccess.recipientAccessStatus(userId, grants),
  };
}
export function contextRuntime() {
  return (runtime ??= createContextRuntime());
}

export function syncContextMeeting(meta: RecordingMeta): void {
  if (meta.demo || !config.guildPolicy.allows(meta.guildId) || meta.minutes?.status !== 'done') return;
  const minutes = readMinutes(meta.id);
  if (minutes) {
    try {
      contextRuntime().service.syncMeeting(
        {
          ...meta,
          sourceQuality: {
            audioIncomplete: !!meta.audioIncomplete,
            transcriptionPartial: meta.transcription?.status === 'partial',
          },
        },
        minutes.acoes,
      );
    } catch (error) {
      if (!(error instanceof CommitmentCapacityError)) throw error;
      operationalWarn(
        'Combinados não sincronizados: limite de armazenamento atingido; o acervo anterior foi preservado.',
      );
    }
  }
}

/** One bounded sweep, with private per-recipient delivery after fresh access checks. */
export function startContextMonitor(
  send: (userId: string, content: string, nonce: string) => Promise<void>,
): () => void {
  let busy = false;
  let stopped = false;
  let followerCursor = 0;
  const eventCursors = new Map<string, number>();
  const deliver = async (userId: string, content: string, nonce: string, ack: () => Promise<void>): Promise<void> => {
    const previous = pendingDeliveries.get(userId);
    // A timed-out request may still complete. Keep it single-flight for a bounded day, including monitor restarts.
    if (previous && previous.at > Date.now() - 86400000) throw new Error('delivery still pending');
    const entries = deliveryRecords();
    if (!entries.some((e) => e.userId === userId) && entries.length >= 1000)
      throw new Error('delivery status capacity');
    const attempt = { at: Date.now(), token: Symbol() };
    pendingDeliveries.set(userId, attempt);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const active = () => pendingDeliveries.get(userId)?.token === attempt.token;
    const work = Promise.resolve()
      .then(() => send(userId, content, nonce))
      .then(
        async () => {
          if (!active()) return;
          saveDelivery(userId, 'delivered', attempt.at);
          if (!stopped && isClientReady()) await withContextAccess(ack);
        },
        (error) => {
          if (active())
            saveDelivery(
              userId,
              (error as { code?: number; status?: number }).code === 50007 ||
                (error as { status?: number }).status === 403
                ? 'blocked'
                : 'retrying',
              attempt.at,
            );
          throw error;
        },
      )
      .finally(() => {
        if (active()) pendingDeliveries.delete(userId);
      });
    try {
      await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            try {
              if (active()) saveDelivery(userId, 'uncertain', attempt.at);
              reject(new Error('delivery confirmation timeout'));
            } catch (error) {
              reject(error);
            }
          }, 15_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      for (const [userId, pending] of pendingDeliveries)
        if (pending.at <= Date.now() - 86400000) pendingDeliveries.delete(userId);
      const { service } = contextRuntime();
      service.removeMissingMeetings(new Set(listMetas().map((meta) => meta.id)));
      await service.reconcile();
      const followers = service.listFollowers(1000);
      const selected = followers.slice(followerCursor, followerCursor + 100);
      followerCursor = followerCursor + 100 >= followers.length ? 0 : followerCursor + 100;
      for (const userId of selected) {
        if (stopped) break;
        await withContextAccess(async () => {
          const pending = pendingDeliveries.get(userId);
          if (pending && pending.at > Date.now() - 86400000) return;
          if ((contextDeliveryStatus(userId).nextAttemptAt ?? 0) > Date.now()) return;
          const prepared = await service.prepareDigest(userId);
          // Forty IDs keep even a batch link below Discord's message length limit.
          for (let offset = 0; offset < prepared.items.length; offset += 40) {
            const digest = await withContextAccess(() =>
              service.revalidateDigest(userId, {
                ...prepared,
                items: prepared.items.slice(offset, offset + 40),
              }),
            );
            if (!digest.items.length || stopped) continue;
            const ids = digest.items.map((item) => item.commitment.id);
            const query = ids.length === 1 ? `commitment=${ids[0]}` : `ids=${ids.join(',')}`;
            const count = new Set(digest.items.map((item) => item.commitment.groupId ?? item.commitment.id)).size;
            await deliver(
              userId,
              t(config.defaultLocale, 'context.digest', { count, url: `${config.appUrl}/app/contexto?${query}` }),
              digest.id.slice(0, 24),
              () => service.acknowledgeDigest(userId, digest),
            );
          }
          // Eligibility precedes limits, so closed history never hides a later open channel.
          const inventory = await withContextAccess(() => service.listEventChannels(userId));
          const channelIds = new Set(inventory.channels.map((e) => e.channelId));
          const subscriptions = await service.listChannelPreferences(userId);
          for (const subscription of subscriptions)
            if (subscription.mode === 'follow') channelIds.add(subscription.channelId);
          const prior = eventNotices().filter((e) => e.userId === userId);
          if (!channelIds.size && !prior.length) return;
          const guildIds = new Set([
            ...inventory.channels.map((e) => e.guildId),
            ...subscriptions.filter((e) => e.mode === 'follow').map((e) => e.guildId),
            ...prior.map((e) => e.guildId!),
          ]);
          const observed = await inspectContextEvents(userId, guildIds, eventCursors.get(userId) ?? 0);
          eventCursors.set(userId, observed.nextOffset);
          if (eventCursors.size > 1000) eventCursors.delete(eventCursors.keys().next().value!);
          const candidates: {
            event: EventSnapshot;
            kind: 'context.event' | 'context.eventChanged' | 'context.eventCanceled';
          }[] = [];
          for (const notice of prior) {
            const current = observed.events.find((e) => e.id === notice.eventId);
            if (current) {
              if ([2, 3].includes(current.status) && notice.status !== current.status) {
                // Starting/finishing an event is normal progression, not a cancellation alert.
                saveEventNotices(
                  eventNotices().map((entry) =>
                    entry.key === notice.key ? { ...entry, status: current.status } : entry,
                  ),
                );
              }
              if (current.status === 4 && notice.status !== 4)
                candidates.push({ event: current, kind: 'context.eventCanceled' });
              else if (
                current.status === 1 &&
                (current.at !== notice.at || current.channelId !== notice.channelId || notice.status === 4)
              )
                candidates.push({ event: current, kind: 'context.eventChanged' });
            } else if (
              notice.status === 1 &&
              notice.at! > Date.now() &&
              !observed.observedIds.has(notice.eventId!) &&
              observed.checkedGuilds.has(notice.guildId!) &&
              observed.visibleChannels.has(notice.channelId!)
            ) {
              candidates.push({
                event: {
                  id: notice.eventId!,
                  guildId: notice.guildId!,
                  channelId: notice.channelId!,
                  at: notice.at!,
                  status: 4,
                  name: '',
                  channelName: '',
                  url: '',
                },
                kind: 'context.eventCanceled',
              });
            }
          }
          for (const event of observed.events.filter(
            (e) =>
              e.status === 1 && e.at > Date.now() && e.at <= Date.now() + 30 * 60000 && channelIds.has(e.channelId),
          ))
            if (!prior.some((e) => e.eventId === event.id)) candidates.push({ event, kind: 'context.event' });
          for (const { event, kind } of candidates.slice(0, 5)) {
            if (stopped) break;
            const sent = eventNotices();
            const legacyKey = crypto.createHash('sha256').update(`${userId}:${event.id}:${event.at}`).digest('hex');
            const key = crypto
              .createHash('sha256')
              .update(`${userId}:${event.id}:${event.at}:${event.channelId}:${event.status}`)
              .digest('hex');
            const scopeChannelId =
              prior.find((e) => e.eventId === event.id)?.scopeChannelId ??
              prior.find((e) => e.eventId === event.id)?.channelId ??
              event.channelId;
            const next = {
              key,
              userId,
              eventId: event.id,
              guildId: event.guildId,
              channelId: event.channelId,
              scopeChannelId,
              at: event.at,
              status: event.status,
              expiresAt: Math.min(Date.now() + 30 * 86400000, Math.max(Date.now() + 86400000, event.at + 86400000)),
            };
            if (sent.some((e) => e.key === key)) continue;
            const remaining = sent.filter(
              (e) => !(e.userId === userId && e.eventId === event.id) && e.key !== legacyKey,
            );
            assertEventNoticeCapacity([...remaining, next]);
            const persist = async () => {
              const current = eventNotices().filter(
                (e) => !(e.userId === userId && e.eventId === event.id) && e.key !== legacyKey,
              );
              saveEventNotices([...current, next]);
            };
            // Upgrade legacy dedup entries without resending their original reminder.
            if (kind === 'context.event' && sent.some((e) => e.key === legacyKey)) {
              await persist();
              continue;
            }
            const stillFollowing = await withContextAccess(async () => {
              if (!(await authorizeContextChannel(userId, event.guildId, event.channelId))) return false;
              const current = await service.listChannelPreferences(userId);
              if (current.some((e) => e.mode === 'follow' && [scopeChannelId, event.channelId].includes(e.channelId)))
                return true;
              return (
                (
                  await service.listForUser(userId, {
                    followedOnly: true,
                    openOnly: true,
                    channelId: scopeChannelId,
                    limit: 1,
                  })
                ).length > 0
              );
            });
            if (!stillFollowing) continue;
            await deliver(
              userId,
              t(config.defaultLocale, kind, { url: `${config.appUrl}/app/contexto?channel=${event.channelId}` }),
              key.slice(0, 24),
              persist,
            );
          }
        }).catch(() => operationalWarn('Informativo de combinados não entregue; será tentado novamente.'));
      }
    } catch {
      operationalWarn('Acompanhamento de combinados indisponível nesta rodada.');
    } finally {
      busy = false;
    }
  };
  for (const meta of listMetas()) syncContextMeeting(meta);
  const timer = setInterval(() => {
    void tick();
  }, 15 * 60_000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
