import { describe, expect, it, vi } from 'vitest';
import {
  buildPublicTranscriptionNotice,
  deliverPrivateTranscriptionNotification,
  hasPersistedNotificationWork,
  isPermanentDiscordDmError,
  MAX_PRIVATE_NOTIFICATION_RECIPIENTS,
  MAX_TRANSIENT_NOTIFICATION_RETRY_ATTEMPTS,
  NOTIFICATION_POLICY_VERSION,
  notificationRetryDelayMs,
  shouldRecoverTranscriptionNotification,
  shouldExhaustNotificationRetries,
} from '../src/transcriptionNotification';
import { RecordingMeta } from '../src/store';

function recordingMeta(): RecordingMeta {
  return {
    id: 'meeting-secret-id',
    guildId: 'guild-1',
    guildName: 'Servidor Confidencial',
    voiceChannelId: 'voice-secret-id',
    voiceChannelName: 'Aquisição Secreta',
    startedBy: { id: 'starter', name: 'Mauro' },
    startedAt: Date.now(),
    endedAt: Date.now(),
    status: 'done',
    participants: [
      { id: 'participant', name: 'Ana', avatar: null, trackFile: 'ana.flac', index: 0 },
      { id: 'starter', name: 'Mauro', avatar: null, trackFile: 'mauro.flac', index: 1 },
    ],
    presence: [
      { id: 'participant', name: 'Ana', joinedAtMs: 0 },
      { id: 'silent', name: 'Bruno', joinedAtMs: 0 },
      { id: 'silent', name: 'Bruno de novo', joinedAtMs: 10 },
    ],
    events: [],
    notes: [],
  };
}

describe('notificação pública de transcrição', () => {
  it.each([
    [
      'pt' as const,
      '🔔 O processamento de uma gravação terminou. O bot tenta avisar pessoas autorizadas por DM; os detalhes continuam na área privada.',
    ],
    [
      'en' as const,
      '🔔 A recording finished processing. The bot attempts to notify authorized people by DM; details remain in the private app.',
    ],
  ])('publica somente aviso genérico localizado em %s', (locale, expected) => {
    const payload = buildPublicTranscriptionNotice(locale);

    expect(payload).toEqual({ content: expected, embeds: [] });
    expect(JSON.stringify(payload)).not.toMatch(
      /https?:\/\/|meeting-secret-id|Aquisição Secreta|resumo|decision|action/i,
    );
  });
});

describe('entrega privada de transcrição', () => {
  it('deduplica identidades históricas e envia só a quem passa acesso fresh', async () => {
    const checked: Array<{ id: string; freshMember?: boolean }> = [];
    const sent: string[] = [];
    const payload = { content: 'detalhes privados', embeds: [{ title: 'Ata' }] };

    const result = await deliverPrivateTranscriptionNotification(
      recordingMeta(),
      payload,
      {
        checkAccess: vi.fn(async (identity, _meta, options) => {
          checked.push({ id: identity.id, freshMember: options.freshMember });
          return { view: identity.id !== 'participant', delete: false };
        }),
        send: vi.fn(async (id) => {
          sent.push(id);
        }),
      },
      {
        alreadyDelivered: new Set(['silent']),
        cursor: 0,
        pendingUserIds: [],
      },
    );

    expect(checked).toEqual([
      { id: 'starter', freshMember: true },
      { id: 'participant', freshMember: true },
    ]);
    expect(sent).toEqual(['starter']);
    expect(result).toEqual({
      completed: true,
      deliveredUserIds: ['starter'],
      nextCursor: 3,
      pendingUserIds: [],
      remainingRecipients: 0,
    });
  });

  it('falha fechado por identidade e continua as demais DMs', async () => {
    const sent: string[] = [];

    const result = await deliverPrivateTranscriptionNotification(
      recordingMeta(),
      { content: 'privado', embeds: [] },
      {
        checkAccess: async (identity) => {
          if (identity.id === 'starter') throw new Error('Discord indisponível');
          return { view: true, delete: false };
        },
        send: async (id) => {
          sent.push(id);
          if (id === 'participant') throw new Error('DM fechada');
        },
      },
    );

    expect(sent).toEqual(['participant', 'silent']);
    expect(result).toEqual({
      completed: false,
      deliveredUserIds: ['silent'],
      nextCursor: 3,
      pendingUserIds: ['starter', 'participant'],
      remainingRecipients: 0,
    });
  });

  it('processa fanout grande em lotes retomáveis sem abandonar destinatários após o teto', async () => {
    const meta = recordingMeta();
    meta.presence = Array.from({ length: MAX_PRIVATE_NOTIFICATION_RECIPIENTS + 30 }, (_, index) => ({
      id: `presence-${index}`,
      name: `Pessoa ${index}`,
      joinedAtMs: index,
    }));
    const checked: string[] = [];

    const first = await deliverPrivateTranscriptionNotification(
      meta,
      { content: 'privado' },
      {
        checkAccess: async (identity) => {
          checked.push(identity.id);
          return { view: true };
        },
        send: async () => {},
      },
    );

    expect(checked).toHaveLength(MAX_PRIVATE_NOTIFICATION_RECIPIENTS);
    expect(checked.slice(0, 2)).toEqual(['starter', 'participant']);
    expect(first.completed).toBe(false);
    expect(first.nextCursor).toBe(MAX_PRIVATE_NOTIFICATION_RECIPIENTS);
    expect(first.remainingRecipients).toBe(32);

    const second = await deliverPrivateTranscriptionNotification(
      meta,
      { content: 'privado' },
      {
        checkAccess: async (identity) => {
          checked.push(identity.id);
          return { view: true };
        },
        send: async () => {},
      },
      { cursor: first.nextCursor, pendingUserIds: first.pendingUserIds },
    );

    expect(second.completed).toBe(true);
    expect(second.nextCursor).toBe(MAX_PRIVATE_NOTIFICATION_RECIPIENTS + 32);
    expect(second.remainingRecipients).toBe(0);
    expect(new Set(checked).size).toBe(MAX_PRIVATE_NOTIFICATION_RECIPIENTS + 32);
  });

  it('persiste falhas pendentes, avança o cursor e retoma sem duplicar quem já recebeu', async () => {
    const sent: string[] = [];
    const first = await deliverPrivateTranscriptionNotification(
      recordingMeta(),
      { content: 'privado' },
      {
        checkAccess: async (identity) => {
          if (identity.id === 'participant') throw new Error('Discord 503');
          return { view: true };
        },
        send: async (id) => {
          sent.push(id);
        },
      },
    );

    expect(first).toEqual({
      completed: false,
      deliveredUserIds: ['starter', 'silent'],
      nextCursor: 3,
      pendingUserIds: ['participant'],
      remainingRecipients: 0,
    });

    const second = await deliverPrivateTranscriptionNotification(
      recordingMeta(),
      { content: 'privado' },
      {
        checkAccess: async () => ({ view: true }),
        send: async (id) => {
          sent.push(id);
        },
      },
      {
        alreadyDelivered: new Set(first.deliveredUserIds),
        cursor: first.nextCursor,
        pendingUserIds: first.pendingUserIds,
      },
    );

    expect(second).toEqual({
      completed: true,
      deliveredUserIds: ['participant'],
      nextCursor: 3,
      pendingUserIds: [],
      remainingRecipients: 0,
    });
    expect(sent).toEqual(['starter', 'silent', 'participant']);
  });

  it('encerra falhas permanentes de DM sem criar retry infinito', async () => {
    const result = await deliverPrivateTranscriptionNotification(
      recordingMeta(),
      { content: 'privado' },
      {
        checkAccess: async () => ({ view: true }),
        send: async () => {
          throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
        },
        isPermanentFailure: isPermanentDiscordDmError,
      },
    );

    expect(result.completed).toBe(true);
    expect(result.pendingUserIds).toEqual([]);
    expect(isPermanentDiscordDmError({ code: '10013' })).toBe(true);
    expect(isPermanentDiscordDmError({ code: 429 })).toBe(false);
    expect(isPermanentDiscordDmError(new Error('rede'))).toBe(false);
  });

  it('aplica backoff exponencial limitado e mantém lote seguinte rápido', () => {
    expect(notificationRetryDelayMs(1, true)).toBe(1_000);
    expect(notificationRetryDelayMs(1, false)).toBe(30_000);
    expect(notificationRetryDelayMs(2, false)).toBe(60_000);
    expect(notificationRetryDelayMs(99, false)).toBe(3_600_000);
    expect(notificationRetryDelayMs(Number.NaN, false)).toBe(30_000);
    expect(notificationRetryDelayMs(Number.POSITIVE_INFINITY, false)).toBe(30_000);
    expect(shouldExhaustNotificationRetries(MAX_TRANSIENT_NOTIFICATION_RETRY_ATTEMPTS, true)).toBe(false);
    expect(shouldExhaustNotificationRetries(MAX_TRANSIENT_NOTIFICATION_RETRY_ATTEMPTS - 1, false)).toBe(false);
    expect(shouldExhaustNotificationRetries(MAX_TRANSIENT_NOTIFICATION_RETRY_ATTEMPTS, false)).toBe(true);
  });

  it('distingue checkpoint novo de meta legado sem estado de notificação', () => {
    const legacy = recordingMeta();
    expect(hasPersistedNotificationWork(legacy)).toBe(false);
    expect(hasPersistedNotificationWork({ ...legacy, privateNotificationCursor: 1 })).toBe(true);
    expect(hasPersistedNotificationWork({ ...legacy, privateNotificationPendingUserIds: ['u1'] })).toBe(true);
    expect(hasPersistedNotificationWork({ ...legacy, publicNotifiedAt: Date.now() })).toBe(true);
    expect(hasPersistedNotificationWork({ ...legacy, notificationNextRetryAt: Date.now() })).toBe(true);
  });

  it('retoma meta nova antiga sem campos de entrega e mantém meta legada antiga silenciosa', () => {
    const now = Date.parse('2026-07-13T18:00:00.000Z');
    const finishedAt = now - 2 * 60 * 60_000;
    const legacy: RecordingMeta = {
      ...recordingMeta(),
      endedAt: finishedAt,
      transcription: { status: 'done' as const, finishedAt },
    };
    const current: RecordingMeta = { ...legacy, notificationPolicyVersion: NOTIFICATION_POLICY_VERSION };

    expect(current.publicNotifiedAt).toBeUndefined();
    expect(current.privateNotifiedAt).toBeUndefined();
    expect(current.notificationNextRetryAt).toBeUndefined();
    expect(shouldRecoverTranscriptionNotification(current, now)).toBe(true);
    expect(shouldRecoverTranscriptionNotification(legacy, now)).toBe(false);
    expect(
      shouldRecoverTranscriptionNotification(
        { ...legacy, transcription: { status: 'done', finishedAt: now - 5 * 60_000 } },
        now,
      ),
    ).toBe(true);
  });
});
