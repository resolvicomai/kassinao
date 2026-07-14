import crypto from 'node:crypto';
import type {
  DiscordSurfaceAuditEntry,
  DiscordSurfaceAuditOutcome,
  DiscordSurfaceAuditSource,
  DiscordGuildSurfaceMigrationState,
  RecordingMeta,
} from './store';

export const DISCORD_SURFACE_POLICY_VERSION = 1;
export const DISCORD_HISTORY_PAGE_SIZE = 100;
const START_TIME_MARGIN_MS = 5 * 60_000;

export interface DiscordSurfaceMessage {
  id: string;
  channelId: string;
  guildId: string;
  authorId: string;
  createdTimestamp: number;
  content: string;
  embeds?: unknown[];
  components?: unknown[];
}

export type DiscordSurfaceMessageResult = { kind: 'found'; message: DiscordSurfaceMessage } | { kind: 'missing' };

export type DiscordSurfaceHistoryResult =
  { kind: 'found'; guildId: string; messages: DiscordSurfaceMessage[] } | { kind: 'missing' };

export interface DiscordSurfaceClient {
  botUserId: string;
  fetchMessage(channelId: string, messageId: string): Promise<DiscordSurfaceMessageResult>;
  fetchHistory(
    channelId: string,
    options: { beforeMessageId?: string; limit: number },
  ): Promise<DiscordSurfaceHistoryResult>;
  editMessage(
    channelId: string,
    messageId: string,
    payload: { content: string; embeds: []; components: [] },
  ): Promise<void>;
}

export interface DiscordSurfaceInventoryClient extends DiscordSurfaceClient {
  listGuildMessageChannelIds(guildId: string): Promise<string[]>;
}

export interface DiscordGuildSurfaceMigrationStepOptions {
  guildId: string;
  state?: DiscordGuildSurfaceMigrationState;
  safeContent: string;
  client: DiscordSurfaceInventoryClient;
  persist: (state: DiscordGuildSurfaceMigrationState) => void | Promise<void>;
  now?: () => number;
}

export interface DiscordGuildSurfaceMigrationStepResult {
  state: DiscordGuildSurfaceMigrationState;
  complete: boolean;
}

export interface DiscordSurfaceMigrationStepOptions {
  meta: RecordingMeta;
  knownChannelIds: readonly string[];
  safeContent: string;
  client: DiscordSurfaceClient;
  persist: (meta: RecordingMeta) => void | Promise<void>;
  now?: () => number;
}

export interface DiscordSurfaceMigrationStepResult {
  meta: RecordingMeta;
  complete: boolean;
}

/** Persiste só o namespace da migração, sem sobrescrever transcrição/ata/notificações concorrentes. */
export function mergeDiscordSurfaceMigrationCheckpoint(
  latest: RecordingMeta,
  checkpoint: RecordingMeta,
): RecordingMeta {
  if (latest.id !== checkpoint.id || latest.guildId !== checkpoint.guildId) {
    throw new Error('checkpoint de outra gravação');
  }
  const merged = structuredClone(latest);
  if (checkpoint.discordSurfaceMigration) {
    merged.discordSurfaceMigration = structuredClone(checkpoint.discordSurfaceMigration);
  }
  if (checkpoint.discordSurfacePolicyVersion === DISCORD_SURFACE_POLICY_VERSION) {
    merged.discordSurfacePolicyVersion = DISCORD_SURFACE_POLICY_VERSION;
  }
  return merged;
}

function auditOf(
  meta: RecordingMeta,
  channelId: string,
  messageId: string,
  source: DiscordSurfaceAuditSource,
): DiscordSurfaceAuditEntry | undefined {
  return meta.discordSurfaceMigration?.audits.find(
    (entry) => entry.channelId === channelId && entry.messageId === messageId && entry.source === source,
  );
}

function isTerminalAudit(entry: DiscordSurfaceAuditEntry | undefined): boolean {
  return Boolean(entry && entry.outcome !== 'planned');
}

function messageReferencesRecording(message: DiscordSurfaceMessage, recordingId: string): boolean {
  const escapedId = recordingId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const serialized = [message.content, JSON.stringify(message.embeds ?? []), JSON.stringify(message.components ?? [])]
    .join('\n')
    .slice(0, 200_000);
  const recordingUrl = new RegExp(`https?://[^\\s<>"']+/(?:app/)?rec/${escapedId}(?=$|[/?#\\s<>"'\\])}])`, 'i');
  return recordingUrl.test(serialized);
}

function messageReferencesAnyRecording(message: DiscordSurfaceMessage): boolean {
  const serialized = [message.content, JSON.stringify(message.embeds ?? []), JSON.stringify(message.components ?? [])]
    .join('\n')
    .slice(0, 200_000);
  return /https?:\/\/[^\s<>"']+\/(?:app\/)?rec\/\d{4}-\d{2}-\d{2}-[a-f0-9]{10}(?=$|[/?#\s<>"'\])}])/i.test(serialized);
}

function messageSurfaceFingerprint(message: DiscordSurfaceMessage): string {
  const surface = JSON.stringify({
    id: message.id,
    channelId: message.channelId,
    guildId: message.guildId,
    authorId: message.authorId,
    content: message.content,
    embeds: message.embeds ?? [],
    components: message.components ?? [],
  });
  return crypto.createHash('sha256').update(surface).digest('hex');
}

function isAlreadySafe(message: DiscordSurfaceMessage, safeContent: string): boolean {
  return (
    message.content === safeContent && (message.embeds?.length ?? 0) === 0 && (message.components?.length ?? 0) === 0
  );
}

function appendAudit(
  meta: RecordingMeta,
  channelId: string,
  messageId: string,
  source: DiscordSurfaceAuditSource,
  outcome: DiscordSurfaceAuditOutcome,
  now: number,
  plannedFingerprint?: string,
): DiscordSurfaceAuditEntry {
  const entry: DiscordSurfaceAuditEntry = {
    channelId,
    messageId,
    source,
    outcome,
    plannedFingerprint,
    createdAt: now,
    updatedAt: now,
  };
  meta.discordSurfaceMigration!.audits.push(entry);
  return entry;
}

async function persistAuditOutcome(
  meta: RecordingMeta,
  entry: DiscordSurfaceAuditEntry,
  outcome: DiscordSurfaceAuditOutcome,
  now: number,
  persist: (meta: RecordingMeta) => void | Promise<void>,
): Promise<void> {
  entry.outcome = outcome;
  entry.updatedAt = now;
  meta.discordSurfaceMigration!.updatedAt = now;
  await persist(meta);
}

function ownershipOutcome(
  message: DiscordSurfaceMessage,
  meta: RecordingMeta,
  client: DiscordSurfaceClient,
): 'not-owned' | 'wrong-guild' | undefined {
  if (message.guildId !== meta.guildId || message.channelId.length === 0) return 'wrong-guild';
  if (message.authorId !== client.botUserId) return 'not-owned';
  return undefined;
}

async function settleMessage(
  meta: RecordingMeta,
  entry: DiscordSurfaceAuditEntry,
  safeContent: string,
  client: DiscordSurfaceClient,
  persist: (meta: RecordingMeta) => void | Promise<void>,
  now: () => number,
): Promise<void> {
  const fetched = await client.fetchMessage(entry.channelId, entry.messageId);
  if (fetched.kind === 'missing') {
    await persistAuditOutcome(meta, entry, 'missing', now(), persist);
    return;
  }
  if (fetched.message.channelId !== entry.channelId || fetched.message.id !== entry.messageId) {
    await persistAuditOutcome(meta, entry, 'wrong-guild', now(), persist);
    return;
  }
  const invalid = ownershipOutcome(fetched.message, meta, client);
  if (invalid) {
    await persistAuditOutcome(meta, entry, invalid, now(), persist);
    return;
  }
  const stillReferencesRecording = messageReferencesRecording(fetched.message, meta.id);
  const unchangedSincePlan =
    Boolean(entry.plannedFingerprint) && entry.plannedFingerprint === messageSurfaceFingerprint(fetched.message);
  const mayEdit =
    entry.source === 'discovered-url' ? stillReferencesRecording : unchangedSincePlan || stillReferencesRecording;
  // Descoberta por URL perde autoridade quando o link some. Para um painel com
  // ID persistido, o fingerprint ainda permite limpar conteúdo sensível sem URL,
  // mas uma edição concorrente desconhecida nunca é sobrescrita.
  if (isAlreadySafe(fetched.message, safeContent) || !mayEdit) {
    await persistAuditOutcome(meta, entry, 'sanitized', now(), persist);
    return;
  }
  await client.editMessage(entry.channelId, entry.messageId, {
    content: safeContent,
    embeds: [],
    components: [],
  });
  await persistAuditOutcome(meta, entry, 'sanitized', now(), persist);
}

async function auditAndSettleMessage(
  meta: RecordingMeta,
  message: DiscordSurfaceMessage,
  source: DiscordSurfaceAuditSource,
  safeContent: string,
  client: DiscordSurfaceClient,
  persist: (meta: RecordingMeta) => void | Promise<void>,
  now: () => number,
): Promise<void> {
  const invalid = ownershipOutcome(message, meta, client);
  if (invalid) {
    const entry = appendAudit(meta, message.channelId, message.id, source, invalid, now());
    await persistAuditOutcome(meta, entry, invalid, now(), persist);
    return;
  }
  const entry = appendAudit(
    meta,
    message.channelId,
    message.id,
    source,
    'planned',
    now(),
    messageSurfaceFingerprint(message),
  );
  // O plano durável vem antes da edição externa. Se o processo morrer no meio,
  // a próxima rodada reencontra `planned` e conclui a mesma edição idempotente.
  await persist(meta);
  await settleMessage(meta, entry, safeContent, client, persist, now);
}

async function settleGuildMessage(
  state: DiscordGuildSurfaceMigrationState,
  entry: DiscordSurfaceAuditEntry,
  safeContent: string,
  client: DiscordSurfaceInventoryClient,
  persist: (state: DiscordGuildSurfaceMigrationState) => void | Promise<void>,
  now: () => number,
): Promise<void> {
  const fetched = await client.fetchMessage(entry.channelId, entry.messageId);
  if (fetched.kind === 'missing') {
    entry.outcome = 'missing';
  } else if (
    fetched.message.id !== entry.messageId ||
    fetched.message.channelId !== entry.channelId ||
    fetched.message.guildId !== state.guildId
  ) {
    entry.outcome = 'wrong-guild';
  } else if (fetched.message.authorId !== client.botUserId) {
    entry.outcome = 'not-owned';
  } else {
    // A edição pode ter concluído ou a mensagem pode ter mudado depois do
    // checkpoint. Só sobrescreve enquanto uma URL estrita de gravação existir.
    if (!isAlreadySafe(fetched.message, safeContent) && messageReferencesAnyRecording(fetched.message)) {
      await client.editMessage(entry.channelId, entry.messageId, {
        content: safeContent,
        embeds: [],
        components: [],
      });
    }
    entry.outcome = 'sanitized';
  }
  entry.updatedAt = now();
  state.updatedAt = now();
  await persist(state);
}

function directPanelComplete(meta: RecordingMeta): boolean {
  if (!meta.panelChannelId || !meta.panelMessageId) return true;
  return isTerminalAudit(auditOf(meta, meta.panelChannelId, meta.panelMessageId, 'persisted-panel'));
}

function completeMigrationIfPossible(meta: RecordingMeta, now: number): boolean {
  const migration = meta.discordSurfaceMigration!;
  const complete = directPanelComplete(meta) && migration.discovery.every((state) => Boolean(state.completedAt));
  if (complete) {
    meta.discordSurfacePolicyVersion = DISCORD_SURFACE_POLICY_VERSION;
    migration.completedAt ??= now;
  }
  migration.updatedAt = now;
  return complete;
}

/**
 * Executa no máximo uma página de histórico por chamada. Não apaga mensagens e
 * só edita IDs persistidos ou mensagens do próprio bot com URL exata da gravação.
 */
export async function migrateDiscordSurfacesStep(
  options: DiscordSurfaceMigrationStepOptions,
): Promise<DiscordSurfaceMigrationStepResult> {
  const now = options.now ?? Date.now;
  const meta = structuredClone(options.meta);
  if (meta.discordSurfacePolicyVersion === DISCORD_SURFACE_POLICY_VERSION) return { meta, complete: true };

  meta.discordSurfaceMigration ??= { audits: [], discovery: [], updatedAt: now() };
  meta.discordSurfaceMigration.audits ??= [];
  meta.discordSurfaceMigration.discovery ??= [];
  const knownChannelIds = [...new Set(options.knownChannelIds.filter((id) => id.length > 0))];
  for (const channelId of knownChannelIds) {
    if (!meta.discordSurfaceMigration.discovery.some((state) => state.channelId === channelId)) {
      meta.discordSurfaceMigration.discovery.push({
        channelId,
        messagesScanned: 0,
        updatedAt: now(),
      });
    }
  }

  // Primeiro conclui qualquer edição planejada antes de um crash.
  for (const planned of meta.discordSurfaceMigration.audits.filter((entry) => entry.outcome === 'planned')) {
    await settleMessage(meta, planned, options.safeContent, options.client, options.persist, now);
  }

  if (!directPanelComplete(meta) && meta.panelChannelId && meta.panelMessageId) {
    const fetched = await options.client.fetchMessage(meta.panelChannelId, meta.panelMessageId);
    if (fetched.kind === 'missing') {
      const entry = appendAudit(meta, meta.panelChannelId, meta.panelMessageId, 'persisted-panel', 'missing', now());
      await persistAuditOutcome(meta, entry, 'missing', now(), options.persist);
    } else {
      if (fetched.message.channelId !== meta.panelChannelId || fetched.message.id !== meta.panelMessageId) {
        const entry = appendAudit(
          meta,
          meta.panelChannelId,
          meta.panelMessageId,
          'persisted-panel',
          'wrong-guild',
          now(),
        );
        await persistAuditOutcome(meta, entry, 'wrong-guild', now(), options.persist);
      } else {
        await auditAndSettleMessage(
          meta,
          fetched.message,
          'persisted-panel',
          options.safeContent,
          options.client,
          options.persist,
          now,
        );
      }
    }
  }

  const discovery = meta.discordSurfaceMigration.discovery.find((state) => !state.completedAt);
  if (discovery) {
    const page = await options.client.fetchHistory(discovery.channelId, {
      beforeMessageId: discovery.beforeMessageId,
      limit: DISCORD_HISTORY_PAGE_SIZE,
    });
    if (page.kind === 'missing') {
      discovery.completedAt = now();
      discovery.outcome = 'missing';
      discovery.updatedAt = now();
    } else if (page.guildId !== meta.guildId) {
      discovery.completedAt = now();
      discovery.outcome = 'wrong-guild';
      discovery.updatedAt = now();
    } else {
      const messages = [...page.messages].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
      for (const message of messages) {
        if (
          message.guildId !== meta.guildId ||
          message.channelId !== discovery.channelId ||
          message.authorId !== options.client.botUserId ||
          !messageReferencesRecording(message, meta.id) ||
          isTerminalAudit(auditOf(meta, message.channelId, message.id, 'discovered-url'))
        ) {
          continue;
        }
        const existing = auditOf(meta, message.channelId, message.id, 'discovered-url');
        if (existing?.outcome === 'planned') {
          await settleMessage(meta, existing, options.safeContent, options.client, options.persist, now);
        } else {
          await auditAndSettleMessage(
            meta,
            message,
            'discovered-url',
            options.safeContent,
            options.client,
            options.persist,
            now,
          );
        }
      }
      discovery.messagesScanned += messages.length;
      discovery.updatedAt = now();
      const oldest = messages.at(-1);
      const reachedStart = Boolean(oldest && oldest.createdTimestamp <= meta.startedAt - START_TIME_MARGIN_MS);
      if (messages.length < DISCORD_HISTORY_PAGE_SIZE || reachedStart) {
        discovery.completedAt = now();
        discovery.outcome = 'complete';
        delete discovery.beforeMessageId;
      } else if (oldest) {
        discovery.beforeMessageId = oldest.id;
      }
    }
  }

  const complete = completeMigrationIfPossible(meta, now());
  await options.persist(meta);
  return { meta, complete };
}

/**
 * Varre uma página de um canal do servidor sem depender de RecordingMeta. Isso
 * alcança destinos configurados no passado e gravações que já expiraram do disco.
 */
export async function migrateGuildDiscordSurfacesStep(
  options: DiscordGuildSurfaceMigrationStepOptions,
): Promise<DiscordGuildSurfaceMigrationStepResult> {
  const now = options.now ?? Date.now;
  const state: DiscordGuildSurfaceMigrationState = options.state
    ? structuredClone(options.state)
    : { guildId: options.guildId, audits: [], discovery: [], updatedAt: now() };
  if (state.guildId !== options.guildId) throw new Error('inventário de outro servidor');
  if (state.policyVersion === DISCORD_SURFACE_POLICY_VERSION) return { state, complete: true };

  for (const planned of state.audits.filter((entry) => entry.outcome === 'planned')) {
    await settleGuildMessage(state, planned, options.safeContent, options.client, options.persist, now);
  }

  if (!state.channelsInventoriedAt) {
    const channelIds = [...new Set(await options.client.listGuildMessageChannelIds(options.guildId))];
    for (const channelId of channelIds.filter((id) => id.length > 0)) {
      if (!state.discovery.some((entry) => entry.channelId === channelId)) {
        state.discovery.push({ channelId, messagesScanned: 0, updatedAt: now() });
      }
    }
    state.channelsInventoriedAt = now();
  }

  const startIndex = Number.isFinite(state.nextDiscoveryIndex)
    ? Math.max(0, Math.trunc(state.nextDiscoveryIndex ?? 0)) % Math.max(1, state.discovery.length)
    : 0;
  let discoveryIndex = -1;
  for (let offset = 0; offset < state.discovery.length; offset++) {
    const candidateIndex = (startIndex + offset) % state.discovery.length;
    if (!state.discovery[candidateIndex].completedAt) {
      discoveryIndex = candidateIndex;
      break;
    }
  }
  const discovery = discoveryIndex >= 0 ? state.discovery[discoveryIndex] : undefined;
  if (discovery) {
    // O cursor de fairness vem antes do I/O remoto. Um canal revogado não pode
    // prender a fila para sempre e impedir a limpeza dos outros canais do guild.
    state.nextDiscoveryIndex = (discoveryIndex + 1) % Math.max(1, state.discovery.length);
    state.updatedAt = now();
    await options.persist(state);
    const page = await options.client.fetchHistory(discovery.channelId, {
      beforeMessageId: discovery.beforeMessageId,
      limit: DISCORD_HISTORY_PAGE_SIZE,
    });
    if (page.kind === 'missing') {
      // 10003 também pode aparecer quando o bot perdeu acesso. Só trata como
      // apagado depois de confirmar que o guild ainda é acessível e o canal saiu.
      const currentChannelIds = await options.client.listGuildMessageChannelIds(options.guildId);
      if (currentChannelIds.includes(discovery.channelId)) {
        throw new Error('canal inventariado ficou temporariamente indisponível');
      }
      discovery.completedAt = now();
      discovery.outcome = 'missing';
    } else if (page.guildId !== options.guildId) {
      discovery.completedAt = now();
      discovery.outcome = 'wrong-guild';
    } else {
      const messages = [...page.messages].sort((left, right) => right.createdTimestamp - left.createdTimestamp);
      for (const message of messages) {
        if (
          message.guildId !== options.guildId ||
          message.channelId !== discovery.channelId ||
          message.authorId !== options.client.botUserId ||
          !messageReferencesAnyRecording(message) ||
          state.audits.some(
            (entry) =>
              entry.channelId === message.channelId && entry.messageId === message.id && entry.outcome !== 'planned',
          )
        ) {
          continue;
        }
        const entry: DiscordSurfaceAuditEntry = {
          channelId: message.channelId,
          messageId: message.id,
          source: 'discovered-url',
          outcome: 'planned',
          createdAt: now(),
          updatedAt: now(),
        };
        state.audits.push(entry);
        state.updatedAt = now();
        await options.persist(state);
        await settleGuildMessage(state, entry, options.safeContent, options.client, options.persist, now);
      }
      discovery.messagesScanned += messages.length;
      const oldest = messages.at(-1);
      if (messages.length < DISCORD_HISTORY_PAGE_SIZE) {
        discovery.completedAt = now();
        discovery.outcome = 'complete';
        delete discovery.beforeMessageId;
      } else if (oldest) {
        discovery.beforeMessageId = oldest.id;
      }
    }
    discovery.updatedAt = now();
  }

  const complete = state.discovery.every((entry) => Boolean(entry.completedAt));
  if (complete) {
    state.policyVersion = DISCORD_SURFACE_POLICY_VERSION;
    state.completedAt ??= now();
  }
  state.updatedAt = now();
  await options.persist(state);
  return { state, complete };
}
