import crypto from 'node:crypto';
import { config } from './config';
import { client } from './discord/client';
import { operationalInfo, operationalPii, operationalWarn } from './operationalLog';
import { listMetas, pageUrl, readMeta, readMinutes, saveMeta } from './store';

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

function guildOperational(guildId: string): boolean {
  const guild = client.guilds.cache.get(guildId);
  return config.guildPolicy.allows(guildId) && !pausedGuilds.has(guildId) && !!guild && guild.available !== false;
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
      void deliver(recordingId);
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
  if (!meta || !minutes || meta.webhookSentAt || !guildOperational(meta.guildId)) return;
  if (meta.webhookNextRetryAt && meta.webhookNextRetryAt > Date.now()) {
    schedule(recordingId, meta.webhookNextRetryAt);
    return;
  }

  inFlight.add(recordingId);
  const controller = new AbortController();
  abortControllers.set(recordingId, controller);
  try {
    const deliveryId = meta.webhookDeliveryId || crypto.randomUUID();
    if (!meta.webhookDeliveryId) {
      meta.webhookDeliveryId = deliveryId;
      saveMeta(meta);
    }
    const body = JSON.stringify({
      schemaVersion: 1,
      event: 'minutes.ready',
      deliveryId,
      recordingId: meta.id,
      url: pageUrl(meta.id),
      guildName: meta.guildName,
      channelName: meta.voiceChannelName,
      startedAt: meta.startedAt,
      endedAt: meta.endedAt,
      participants: meta.participants.map((participant) => participant.name),
      minutes,
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const response = await fetch(config.minutesWebhookUrl, {
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
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) throw new Error('webhook_failed');

    const fresh = readMeta(recordingId);
    if (!fresh || fresh.webhookSentAt) return;
    fresh.webhookSentAt = Date.now();
    delete fresh.webhookRetryAttempt;
    delete fresh.webhookNextRetryAt;
    saveMeta(fresh);
    operationalInfo(`Webhook da ata entregue recording=${operationalPii(recordingId)}.`);
  } catch {
    const fresh = readMeta(recordingId);
    if (!fresh || fresh.webhookSentAt || !guildOperational(fresh.guildId)) return;
    const attempt = (fresh.webhookRetryAttempt ?? 0) + 1;
    fresh.webhookRetryAttempt = attempt;
    fresh.webhookNextRetryAt = Date.now() + retryDelay(attempt);
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
  if (!meta || meta.webhookSentAt || !guildOperational(meta.guildId)) return;
  if (meta.webhookNextRetryAt && meta.webhookNextRetryAt > Date.now()) schedule(recordingId, meta.webhookNextRetryAt);
  else void deliver(recordingId);
}

export function cancelMinutesWebhook(recordingId: string): void {
  const timer = timers.get(recordingId);
  if (timer) clearTimeout(timer);
  timers.delete(recordingId);
  abortControllers.get(recordingId)?.abort();
}

export function cancelMinutesWebhooksForGuild(guildId: string): void {
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
