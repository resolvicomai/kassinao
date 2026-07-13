import { Locale, t } from './i18n';
import type { RecordingMeta } from './store';

export const NOTIFICATION_POLICY_VERSION = 1;
const LEGACY_NOTIFICATION_RECOVERY_WINDOW_MS = 30 * 60_000;

export interface PublicTranscriptionNotice {
  content: string;
  embeds: [];
}

interface AccessChecker {
  (
    identity: { id: string; name: string },
    meta: RecordingMeta,
    options: { freshMember: true },
  ): Promise<{ view: boolean }>;
}

interface PrivateDelivery<Payload> {
  checkAccess: AccessChecker;
  send: (userId: string, payload: Payload) => Promise<unknown>;
  isPermanentFailure?: (error: unknown) => boolean;
}

export const MAX_PRIVATE_NOTIFICATION_RECIPIENTS = 100;

export interface PrivateTranscriptionDeliveryState {
  alreadyDelivered?: ReadonlySet<string>;
  cursor?: number;
  pendingUserIds?: readonly string[];
}

export interface PrivateTranscriptionDeliveryResult {
  completed: boolean;
  deliveredUserIds: string[];
  nextCursor: number;
  pendingUserIds: string[];
  remainingRecipients: number;
}

const FAST_BATCH_RETRY_MS = 1_000;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 60 * 60_000;
export const MAX_TRANSIENT_NOTIFICATION_RETRY_ATTEMPTS = 12;

/** Discord: DM bloqueada e usuário inexistente não melhoram com retry. */
export function isPermanentDiscordDmError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = Number((error as { code?: unknown }).code);
  return code === 50007 || code === 10013;
}

/** Checkpoint introduzido pelo fluxo retomável; metas legadas não têm nenhum destes campos. */
export function hasPersistedNotificationWork(meta: RecordingMeta): boolean {
  return Boolean(
    (Number.isFinite(meta.notificationPolicyVersion) && (meta.notificationPolicyVersion ?? 0) >= 1) ||
    meta.notificationNextRetryAt ||
    meta.publicNotifiedAt ||
    meta.privateNotifiedAt ||
    (meta.privateNotifiedUserIds?.length ?? 0) > 0 ||
    (meta.privateNotificationCursor ?? 0) > 0 ||
    (meta.privateNotificationPendingUserIds?.length ?? 0) > 0,
  );
}

/**
 * Recovery durável para o fluxo atual; metas legadas sem checkpoint conservam
 * a janela curta porque não distinguem "nunca enviado" de "já enviado".
 */
export function shouldRecoverTranscriptionNotification(meta: RecordingMeta, now = Date.now()): boolean {
  if (meta.notifiedAt || meta.notificationRetryExhaustedAt) return false;
  if (hasPersistedNotificationWork(meta)) {
    return !Number.isFinite(meta.notificationNextRetryAt) || (meta.notificationNextRetryAt as number) <= now;
  }
  const finishedAt = meta.minutes?.finishedAt ?? meta.transcription?.finishedAt ?? 0;
  return Number.isFinite(finishedAt) && finishedAt > now - LEGACY_NOTIFICATION_RECOVERY_WINDOW_MS;
}

/** Próximo lote é rápido; falha externa usa backoff exponencial com teto de 1h. */
export function notificationRetryDelayMs(attempt: number, hasMoreRecipients: boolean): number {
  if (hasMoreRecipients) return FAST_BATCH_RETRY_MS;
  const normalizedAttempt = Number.isFinite(attempt) ? Math.max(1, Math.trunc(attempt)) : 1;
  const exponent = Math.max(0, Math.min(20, normalizedAttempt - 1));
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exponent);
}

/** Nunca esgota enquanto ainda houver identidades novas; limita só falhas já tentadas. */
export function shouldExhaustNotificationRetries(attempt: number, hasMoreRecipients: boolean): boolean {
  if (hasMoreRecipients || !Number.isFinite(attempt)) return false;
  return Math.trunc(attempt) >= MAX_TRANSIENT_NOTIFICATION_RETRY_ATTEMPTS;
}

/**
 * O canal só recebe um sinal de conclusão sem URL, ID, nomes ou conteúdo da reunião.
 * A função nem aceita `meta`, impedindo interpolação acidental de dados sensíveis.
 */
export function buildPublicTranscriptionNotice(locale: Locale): PublicTranscriptionNotice {
  return { content: t(locale, 'transcript.private-notice'), embeds: [] };
}

function historicalRecipientIds(meta: RecordingMeta): string[] {
  const ids = [
    meta.startedBy?.id,
    ...meta.participants.map((participant) => participant.id),
    ...(meta.presence ?? []).map((entry) => entry.id),
  ];
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

/**
 * Entrega detalhes somente às identidades históricas da reunião que ainda passam
 * a checagem autoritativa de membership/acesso. Uma falha individual nega aquela
 * identidade e não bloqueia as demais.
 */
export async function deliverPrivateTranscriptionNotification<Payload>(
  meta: RecordingMeta,
  payload: Payload,
  delivery: PrivateDelivery<Payload>,
  state: PrivateTranscriptionDeliveryState = {},
): Promise<PrivateTranscriptionDeliveryResult> {
  const allRecipients = historicalRecipientIds(meta);
  const recipientSet = new Set(allRecipients);
  const alreadyDelivered = state.alreadyDelivered ?? new Set<string>();
  const cursor = Math.max(0, Math.min(allRecipients.length, Math.trunc(state.cursor ?? 0)));
  const pending = [
    ...new Set((state.pendingUserIds ?? []).filter((id) => recipientSet.has(id) && !alreadyDelivered.has(id))),
  ];

  // Enquanto ainda há destinatários novos, reserva ao menos metade do lote para
  // avançar o cursor. Falhas antigas continuam sendo tentadas sem bloquear todos
  // que vêm depois delas.
  const pendingBudget =
    cursor < allRecipients.length
      ? Math.min(pending.length, Math.floor(MAX_PRIVATE_NOTIFICATION_RECIPIENTS / 2))
      : Math.min(pending.length, MAX_PRIVATE_NOTIFICATION_RECIPIENTS);
  const pendingBatch = pending.slice(0, pendingBudget);
  const newBudget = MAX_PRIVATE_NOTIFICATION_RECIPIENTS - pendingBatch.length;
  const newBatch = allRecipients.slice(cursor, cursor + newBudget);
  const nextCursor = cursor + newBatch.length;
  const attemptedPending = new Set(pendingBatch);
  const queue = [...pendingBatch, ...newBatch.filter((id) => !attemptedPending.has(id))];

  const deliveredUserIds: string[] = [];
  const failed = new Set<string>();
  const resolved = new Set<string>();
  for (const userId of queue) {
    if (alreadyDelivered.has(userId)) continue;
    try {
      const access = await delivery.checkAccess({ id: userId, name: '' }, meta, { freshMember: true });
      if (!access.view) {
        resolved.add(userId); // não-membro/sem grant é resultado terminal desta rodada
        continue;
      }
      await delivery.send(userId, payload);
      deliveredUserIds.push(userId);
      resolved.add(userId);
    } catch (error) {
      if (delivery.isPermanentFailure?.(error)) {
        // DM bloqueada/usuário removido é terminal: insistir por meses vira amplificação.
        resolved.add(userId);
      } else {
        // Membership incerto, 429/5xx ou rede: falha fechado e persiste para retry.
        failed.add(userId);
      }
    }
  }

  const pendingUserIds = [
    ...new Set([
      ...pending.filter((id) => !resolved.has(id) && !attemptedPending.has(id)),
      ...pendingBatch.filter((id) => !resolved.has(id)),
      ...newBatch.filter((id) => failed.has(id)),
    ]),
  ];
  const remainingRecipients = allRecipients.length - nextCursor;
  return {
    completed: remainingRecipients === 0 && pendingUserIds.length === 0,
    deliveredUserIds,
    nextCursor,
    pendingUserIds,
    remainingRecipients,
  };
}
