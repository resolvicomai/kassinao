import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Guild } from 'discord.js';
import {
  webhookSignature,
  enqueueMinutesWebhook,
  retryMinutesWebhook,
  pauseMinutesWebhooksForGuild,
} from '../src/minutesWebhook';
import { config } from '../src/config';
import { client } from '../src/discord/client';
import { saveMeta, readMeta, saveMinutes, deleteRecording } from '../src/store';

describe('assinatura do webhook de atas', () => {
  it('assina timestamp e corpo com HMAC-SHA256 v1', () => {
    const secret = '0123456789abcdef0123456789abcdef';
    const timestamp = '1784044800';
    const body = JSON.stringify({ event: 'minutes.ready', recordingId: 'rec' });
    const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    expect(webhookSignature(secret, timestamp, body)).toBe(`v1=${expected}`);
  });

  it('muda quando timestamp ou payload mudam', () => {
    const secret = '0123456789abcdef0123456789abcdef';
    expect(webhookSignature(secret, '1', '{}')).not.toBe(webhookSignature(secret, '2', '{}'));
    expect(webhookSignature(secret, '1', '{}')).not.toBe(webhookSignature(secret, '1', '{"x":1}'));
  });
});

it('para em 403, exige reenvio explícito e preserva deliveryId no retry com Retry-After', async () => {
  const id = `webhook-${crypto.randomUUID()}`;
  const guildId = `guild-${crypto.randomUUID()}`;
  const original = {
    minutesWebhookUrl: config.minutesWebhookUrl,
    minutesWebhookSecret: config.minutesWebhookSecret,
    minutesWebhookGuildIds: config.minutesWebhookGuildIds,
    minutesWebhookChannelIds: config.minutesWebhookChannelIds,
    minutesWebhookPayload: config.minutesWebhookPayload,
  };
  config.minutesWebhookUrl = 'https://webhook.invalid/minutes';
  config.minutesWebhookSecret = 'synthetic-secret';
  config.minutesWebhookPayload = 'minutes';
  client.guilds.cache.set(guildId, { id: guildId, available: true } as Guild);
  saveMeta({
    id,
    guildId,
    guildName: 'Test',
    voiceChannelId: 'voice',
    voiceChannelName: 'Test',
    startedBy: null,
    startedAt: Date.now(),
    status: 'done',
    participants: [],
    notes: [],
    events: [],
    minutes: { status: 'done' },
  });
  saveMinutes(id, {
    resumo: 'Test',
    decisoes: ['Aprovar revisão'],
    decisionSources: [{ startMs: 0, endMs: 1000, quote: 'Transcrição literal da decisão.' }],
    acoes: [{ tarefa: 'Revisar', source: { startMs: 1000, endMs: 2000, quote: 'Transcrição literal da ação.' } }],
    topicos: [],
    porParticipante: [],
  });
  const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response('', { status: 403 }));
  vi.stubGlobal('fetch', fetchMock);
  try {
    enqueueMinutesWebhook(id);
    await vi.waitFor(() => expect(readMeta(id)?.webhookFailureReason).toBe('permanent-http'));
    const minutesPayload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(minutesPayload.minutes.decisoes).toEqual(['Aprovar revisão']);
    expect(minutesPayload.minutes.acoes).toEqual([{ tarefa: 'Revisar' }]);
    expect(minutesPayload.minutes).not.toHaveProperty('decisionSources');
    expect(String(fetchMock.mock.calls[0][1]?.body)).not.toContain('Transcrição literal');
    const deliveryId = readMeta(id)?.webhookDeliveryId;
    enqueueMinutesWebhook(id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '90' } }));
    const before = Date.now();
    expect(retryMinutesWebhook(id)).toBe('queued');
    await vi.waitFor(() => expect(readMeta(id)?.webhookNextRetryAt).toBeGreaterThanOrEqual(before + 90_000));
    expect(readMeta(id)?.webhookDeliveryId).toBe(deliveryId);
    expect(readMeta(id)?.webhookFailedAt).toBeUndefined();
    config.minutesWebhookGuildIds = ['other-guild'];
    expect(retryMinutesWebhook(id)).toBe('unavailable');
    config.minutesWebhookGuildIds = [guildId];
    config.minutesWebhookChannelIds = ['other-channel'];
    expect(retryMinutesWebhook(id)).toBe('unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    config.minutesWebhookChannelIds = ['voice'];
    config.minutesWebhookPayload = 'metadata';
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    expect(retryMinutesWebhook(id)).toBe('queued');
    await vi.waitFor(() => expect(readMeta(id)?.webhookSentAt).toBeTruthy());
    const payload = JSON.parse(String(fetchMock.mock.calls[2][1]?.body));
    expect(payload.deliveryId).toBe(deliveryId);
    expect(payload).not.toHaveProperty('minutes');
    expect(payload).not.toHaveProperty('participants');
    expect(payload).not.toHaveProperty('guildName');
  } finally {
    pauseMinutesWebhooksForGuild(guildId);
    client.guilds.cache.delete(guildId);
    deleteRecording(id);
    Object.assign(config, original);
    vi.unstubAllGlobals();
  }
});
