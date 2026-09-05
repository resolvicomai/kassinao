import crypto from 'node:crypto';
import { config } from './config';
import { client } from './discord/client';
import { operationalInfo, operationalPii, operationalWarn } from './operationalLog';
import {
  listMetas,
  pageUrl,
  readMeta,
  readMinutes,
  readTranscriptBounded,
  saveMeta,
  type RecordingMeta,
} from './store';
import { fetchWithDeadline, parseRetryAfterMs } from './processing/http';

const RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
];
const timers = new Map<string, NodeJS.Timeout>();
const inFlight = new Set<string>();
const abortControllers = new Map<string, AbortController>();
const pausedGuilds = new Set<string>();
const MAX_ATTEMPTS = 8;

export function retryableWebhookStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function dispatch(recordingId: string): void {
  void deliver(recordingId).catch(() => operationalWarn('Não foi possível atualizar a entrega do webhook.'));
}

function guildOperational(guildId: string): boolean {
  const guild = client.guilds.cache.get(guildId);
  return config.guildPolicy.allows(guildId) && !pausedGuilds.has(guildId) && !!guild && guild.available !== false;
}

export function minutesWebhookAllows(meta: Pick<RecordingMeta, 'guildId' | 'voiceChannelId'>): boolean {
  return (
    (config.minutesWebhookGuildIds.length === 0 || config.minutesWebhookGuildIds.includes(meta.guildId)) &&
    (config.minutesWebhookChannelIds.length === 0 || config.minutesWebhookChannelIds.includes(meta.voiceChannelId))
  );
}

export function webhookSignature(secret: string, timestamp: string, body: string): string {
  return `v1=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

function retryDelay(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(0, attempt - 1), RETRY_DELAYS_MS.length - 1)];
}

function schedule(recordingId: string, at: number): void {
  const existing = timers.get(recordingId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(
    () => {
      timers.delete(recordingId);
      dispatch(recordingId);
    },
    Math.max(0, at - Date.now()),
  );
  timer.unref();
  timers.set(recordingId, timer);
}

async function deliver(recordingId: string): Promise<void> {
  if (!config.minutesWebhookUrl || inFlight.has(recordingId)) return;
  const meta = readMeta(recordingId);
  const minutes = readMinutes(recordingId);
  if (
    !meta ||
    !minutes ||
    meta.webhookSentAt ||
    meta.webhookFailedAt ||
    !guildOperational(meta.guildId) ||
    !minutesWebhookAllows(meta)
  )
    return;
  if ((meta.webhookRetryAttempt ?? 0) >= MAX_ATTEMPTS) {
    meta.webhookFailedAt = Date.now();
    meta.webhookFailureReason = 'attempts-exhausted';
    delete meta.webhookNextRetryAt;
    saveMeta(meta);
    return;
  }
  if (meta.webhookNextRetryAt && meta.webhookNextRetryAt > Date.now()) {
    schedule(recordingId, meta.webhookNextRetryAt);
    return;
  }

  inFlight.add(recordingId);
  const controller = new AbortController();
  abortControllers.set(recordingId, controller);
  let httpStatus: number | undefined;
  let retryAfterMs = 0;
  let payloadUnavailable = false;
  try {
    const deliveryId = meta.webhookDeliveryId || crypto.randomUUID();
    if (!meta.webhookDeliveryId) {
      meta.webhookDeliveryId = deliveryId;
    }
    meta.webhookLastAttemptAt = Date.now();
    meta.webhookRetryAttempt = (meta.webhookRetryAttempt ?? 0) + 1;
    saveMeta(meta);
    const payload: Record<string, unknown> = {
      schemaVersion: 1,
      event: 'minutes.ready',
      deliveryId,
      recordingId: meta.id,
      url: pageUrl(meta.id),
      startedAt: meta.startedAt,
      endedAt: meta.endedAt,
    };
    if (config.minutesWebhookPayload === 'minutes')
      Object.assign(payload, {
        guildName: meta.guildName,
        channelName: meta.voiceChannelName,
        participants: meta.participants.map((participant) => participant.name),
        // A origem contém transcrição literal e não pertence ao escopo de ata.
        minutes: {
          resumo: minutes.resumo,
          decisoes: minutes.decisoes,
          acoes: minutes.acoes.map(({ tarefa, responsavel, prazo }) => ({ tarefa, responsavel, prazo })),
          topicos: minutes.topicos,
          porParticipante: minutes.porParticipante,
        },
      });
    if (config.minutesWebhookPayload === 'transcript') {
      const transcript = readTranscriptBounded(recordingId, 5 * 1024 * 1024);
      if (transcript.status !== 'ok') {
        payloadUnavailable = true;
        throw new Error('webhook payload unavailable');
      }
      payload.transcript = transcript.segments;
    }
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const response = await fetchWithDeadline(
      config.minutesWebhookUrl,
      {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          'X-Kassinao-Event': 'minutes.ready',
          'X-Kassinao-Schema-Version': '1',
          'X-Kassinao-Delivery-Id': deliveryId,
          'X-Kassinao-Timestamp': timestamp,
          'X-Kassinao-Signature': webhookSignature(config.minutesWebhookSecret, timestamp, body),
        },
        body,
        signal: controller.signal,
      },
      { timeoutMs: 10_000, maxResponseBytes: 64 * 1024 },
    );
    httpStatus = response.status;
    retryAfterMs = parseRetryAfterMs(response.headers, '');
    if (!response.ok) throw new Error('webhook_failed');

    const fresh = readMeta(recordingId);
    if (!fresh || fresh.webhookSentAt) return;
    fresh.webhookSentAt = Date.now();
    fresh.webhookLastHttpStatus = response.status;
    delete fresh.webhookRetryAttempt;
    delete fresh.webhookNextRetryAt;
    delete fresh.webhookFailedAt;
    delete fresh.webhookFailureReason;
    saveMeta(fresh);
    operationalInfo(`Webhook da ata entregue recording=${operationalPii(recordingId)}.`);
  } catch {
    const fresh = readMeta(recordingId);
    if (!fresh || fresh.webhookSentAt || !guildOperational(fresh.guildId)) return;
    const attempt = fresh.webhookRetryAttempt ?? 1;
    fresh.webhookLastHttpStatus = httpStatus;
    const permanent = httpStatus !== undefined && !retryableWebhookStatus(httpStatus);
    if (payloadUnavailable || permanent || attempt >= MAX_ATTEMPTS) {
      fresh.webhookFailedAt = Date.now();
      fresh.webhookFailureReason = payloadUnavailable
        ? 'payload-unavailable'
        : permanent
          ? 'permanent-http'
          : 'attempts-exhausted';
      delete fresh.webhookNextRetryAt;
      saveMeta(fresh);
      operationalWarn('Entrega do webhook interrompida; requer revisão e reenvio autorizado.');
      return;
    }
    fresh.webhookNextRetryAt = Date.now() + Math.max(retryDelay(attempt), Math.min(retryAfterMs, 24 * 60 * 60_000));
    saveMeta(fresh);
    operationalWarn(`Webhook da ata falhou recording=${operationalPii(recordingId)}; nova tentativa agendada.`);
    schedule(recordingId, fresh.webhookNextRetryAt);
  } finally {
    inFlight.delete(recordingId);
    abortControllers.delete(recordingId);
  }
}

/** Enfileira entrega nova ou retoma o backoff persistido após restart. */
export function enqueueMinutesWebhook(recordingId: string): void {
  if (!config.minutesWebhookUrl) return;
  const meta = readMeta(recordingId);
  if (
    !meta ||
    meta.webhookSentAt ||
    meta.webhookFailedAt ||
    !guildOperational(meta.guildId) ||
    !minutesWebhookAllows(meta)
  )
    return;
  if (meta.webhookNextRetryAt && meta.webhookNextRetryAt > Date.now()) schedule(recordingId, meta.webhookNextRetryAt);
  else dispatch(recordingId);
}

/** Chamador verifica ACL e confirmação de envio; repete o mesmo ID para dedupe no destino. */
export function retryMinutesWebhook(recordingId: string): 'queued' | 'busy' | 'unavailable' {
  const meta = readMeta(recordingId);
  if (
    !config.minutesWebhookUrl ||
    !meta ||
    meta.minutes?.status !== 'done' ||
    !readMinutes(recordingId) ||
    !guildOperational(meta.guildId) ||
    !minutesWebhookAllows(meta)
  )
    return 'unavailable';
  if (inFlight.has(recordingId)) return 'busy';
  clearTimeout(timers.get(recordingId));
  timers.delete(recordingId);
  delete meta.webhookSentAt;
  delete meta.webhookFailedAt;
  delete meta.webhookNextRetryAt;
  delete meta.webhookFailureReason;
  delete meta.webhookLastHttpStatus;
  meta.webhookRetryAttempt = 0;
  saveMeta(meta);
  enqueueMinutesWebhook(recordingId);
  return 'queued';
}

function cancelMinutesWebhook(recordingId: string): void {
  const timer = timers.get(recordingId);
  if (timer) clearTimeout(timer);
  timers.delete(recordingId);
  abortControllers.get(recordingId)?.abort();
}

function cancelMinutesWebhooksForGuild(guildId: string): void {
  for (const recordingId of new Set([...timers.keys(), ...abortControllers.keys()])) {
    if (readMeta(recordingId)?.guildId === guildId) cancelMinutesWebhook(recordingId);
  }
}

export function pauseMinutesWebhooksForGuild(guildId: string): void {
  pausedGuilds.add(guildId);
  cancelMinutesWebhooksForGuild(guildId);
}

export function resumeMinutesWebhooksForGuild(guildId: string): void {
  pausedGuilds.delete(guildId);
  for (const meta of listMetas()) {
    if (meta.guildId === guildId && !meta.webhookSentAt) enqueueMinutesWebhook(meta.id);
  }
}
