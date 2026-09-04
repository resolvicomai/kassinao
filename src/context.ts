import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PermissionFlagsBits } from 'discord.js';
import { writeJsonStateAtomic } from './stateFile';
import { config } from './config';
import { client } from './discord/client';
import { createCommitmentService } from './commitments';
import { createIntegrationClient } from './integrations/client';
import { jiraOrigin, parseIntegrationConfiguration } from './integrations/config';
import {
  createRecipientArtifactAccess,
  parseContextUserCredentials,
  withRecipientArtifactAccess,
} from './integrations/access';
import type { ArtifactReference } from './integrations/types';
import { checkAccess, createAccessRequestContext } from './web/access';
import { listMetas, readMeta, readMinutes, RecordingMeta } from './store';
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

/** Only explicit Discord scheduled events, checked against current membership and channel access. */
export async function upcomingContextEvents(
  userId: string,
  channelIds?: Set<string>,
  horizonMs = 7 * 86400000,
): Promise<{ events: ContextEvent[]; incomplete: boolean }> {
  const events: ContextEvent[] = [];
  const guilds = [...client.guilds.cache.values()].filter((guild) => config.guildPolicy.allows(guild.id));
  let incomplete = guilds.length > 5;
  for (const guild of guilds.slice(0, 5)) {
    try {
      const member = await guild.members.fetch({ user: userId, force: true, cache: false });
      const scheduled = await guild.scheduledEvents.fetch();
      for (const event of scheduled.values()) {
        const at = event.scheduledStartTimestamp;
        const channel = event.channelId ? guild.channels.cache.get(event.channelId) : undefined;
        if (
          event.status !== 1 ||
          !at ||
          at <= Date.now() ||
          at > Date.now() + horizonMs ||
          !channel ||
          (channelIds && !channelIds.has(channel.id)) ||
          !channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)
        )
          continue;
        events.push({
          id: event.id,
          name: event.name,
          at,
          channelId: channel.id,
          channelName: channel.name,
          url: `https://discord.com/events/${guild.id}/${event.id}`,
        });
      }
    } catch (error) {
      if ((error as { code?: number }).code !== 10007) incomplete = true;
    }
  }
  return { events: events.sort((a, b) => a.at - b.at), incomplete };
}

interface EventNotice {
  key: string;
  expiresAt: number;
}
function eventNotices(): EventNotice[] {
  const file = path.join(config.stateDir, 'context-event-notices.json');
  try {
    if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('event notice capacity');
    const entries = JSON.parse(fs.readFileSync(file, 'utf8')) as EventNotice[];
    if (
      !Array.isArray(entries) ||
      entries.length > 10000 ||
      entries.some((e) => !e || !/^[a-f0-9]{64}$/.test(e.key) || !Number.isFinite(e.expiresAt))
    )
      throw new Error('event notice schema');
    return entries.filter((e) => e.expiresAt > Date.now());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('event notices unavailable', { cause: error });
  }
}

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
    authorizeArtifact: async (userId, reference, context) =>
      readerCanAccessArtifact(grants, userId, reference) && recipientAccess.canRead(userId, reference, context),
  });
  return { service, configuration, recipientCredentialsStatus: recipientAccess.recipientCredentialsStatus };
}
export function contextRuntime() {
  return (runtime ??= createContextRuntime());
}

export function syncContextMeeting(meta: RecordingMeta): void {
  if (meta.demo || !config.guildPolicy.allows(meta.guildId) || meta.minutes?.status !== 'done') return;
  const minutes = readMinutes(meta.id);
  if (minutes) contextRuntime().service.syncMeeting(meta, minutes.acoes);
}

/** One bounded sweep, with private per-recipient delivery after fresh access checks. */
export function startContextMonitor(
  send: (userId: string, content: string, nonce: string) => Promise<void>,
): () => void {
  let busy = false;
  let stopped = false;
  let followerCursor = 0;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const { service } = contextRuntime();
      service.removeMissingMeetings(new Set(listMetas().map((meta) => meta.id)));
      await service.reconcile();
      const followers = service.listFollowers(1000);
      const selected = followers.slice(followerCursor, followerCursor + 100);
      followerCursor = followerCursor + 100 >= followers.length ? 0 : followerCursor + 100;
      for (const userId of selected) {
        if (stopped) break;
        await withContextAccess(async () => {
          const digest = await service.prepareDigest(userId);
          // Private notice contains no meeting/artifact text, so a mid-send permission change cannot leak it.
          if (digest.items.length) {
            const count = new Set(digest.items.map((item) => item.commitment.groupId ?? item.commitment.id)).size;
            await send(
              userId,
              `Você tem ${count} atualização(ões) nos combinados que acompanha. Consulte com seu acesso atual: ${config.appUrl}/app/contexto`,
              digest.id.slice(0, 24),
            );
            await service.acknowledgeDigest(userId, digest);
          }
          const followed = (await service.listForUser(userId)).filter(
            (e) =>
              e.preference.mode === 'follow' &&
              (!e.preference.snoozedUntil || e.preference.snoozedUntil <= Date.now()) &&
              !e.effectiveCompletion &&
              ['mentioned', 'confirmed'].includes(e.status),
          );
          if (!followed.length) return;
          const { events } = await upcomingContextEvents(userId, new Set(followed.map((e) => e.channelId)), 30 * 60000);
          for (const event of events.slice(0, 5)) {
            const key = crypto.createHash('sha256').update(`${userId}:${event.id}:${event.at}`).digest('hex');
            const sent = eventNotices();
            if (sent.some((notice) => notice.key === key)) continue;
            if (sent.length >= 10000) throw new Error('event notice capacity');
            await send(
              userId,
              `Um evento agendado no Discord começa em até 30 minutos em um canal cujos combinados você acompanha. Prepare-se com seu acesso atual: ${config.appUrl}/app/contexto`,
              key.slice(0, 24),
            );
            writeJsonStateAtomic(path.join(config.stateDir, 'context-event-notices.json'), [
              ...sent,
              { key, expiresAt: event.at + 86400000 },
            ]);
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
