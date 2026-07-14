import { describe, expect, it } from 'vitest';
import { ManualRecordingStartLimiter, ManualStartReservation } from '../src/recorder/manualStartLimiter';

function commitStart(
  limiter: ManualRecordingStartLimiter,
  guildId: string,
  userId: string,
  isAdmin: boolean,
  now: number,
): { ok: true } | Exclude<ManualStartReservation, { ok: true }> {
  const reservation = limiter.reserve(guildId, userId, isAdmin, now);
  if (!reservation.ok) return reservation;
  reservation.commit();
  return { ok: true };
}

describe('limites de início manual de gravação', () => {
  it('desfaz a reserva quando a gravação falha e só cobra quando o início confirma', () => {
    const limiter = new ManualRecordingStartLimiter({
      userCooldownMs: 60_000,
      guildCooldownMs: 60_000,
      maxStartsPerGuild24h: 1,
    });

    const failedStart = limiter.reserve('guild-a', 'alice', false, 1_000);
    expect(failedStart).toMatchObject({ ok: true });
    expect(limiter.reserve('guild-a', 'alice', false, 2_000)).toMatchObject({
      ok: false,
      reason: 'user-cooldown',
    });
    if (failedStart.ok) failedStart.rollback();

    const successfulStart = limiter.reserve('guild-a', 'alice', false, 2_000);
    expect(successfulStart).toMatchObject({ ok: true });
    if (successfulStart.ok) successfulStart.commit();

    expect(limiter.reserve('guild-a', 'alice', false, 3_000)).toEqual({
      ok: false,
      reason: 'user-cooldown',
      retryAfterMs: 59_000,
    });
  });

  it('aplica cooldown global por usuário e por servidor', () => {
    const limiter = new ManualRecordingStartLimiter({
      userCooldownMs: 60_000,
      guildCooldownMs: 10_000,
      maxStartsPerGuild24h: 10,
    });

    expect(commitStart(limiter, 'guild-a', 'alice', false, 1_000)).toEqual({ ok: true });
    expect(commitStart(limiter, 'guild-b', 'alice', false, 2_000)).toEqual({
      ok: false,
      reason: 'user-cooldown',
      retryAfterMs: 59_000,
    });
    expect(commitStart(limiter, 'guild-a', 'bob', false, 2_000)).toEqual({
      ok: false,
      reason: 'guild-cooldown',
      retryAfterMs: 9_000,
    });
    expect(commitStart(limiter, 'guild-b', 'alice', false, 61_000)).toEqual({ ok: true });
  });

  it('limita inícios por servidor numa janela móvel de 24 horas', () => {
    const limiter = new ManualRecordingStartLimiter({
      userCooldownMs: 0,
      guildCooldownMs: 0,
      maxStartsPerGuild24h: 2,
    });

    expect(commitStart(limiter, 'guild-a', 'alice', false, 1_000)).toEqual({ ok: true });
    expect(commitStart(limiter, 'guild-a', 'bob', false, 2_000)).toEqual({ ok: true });
    expect(commitStart(limiter, 'guild-a', 'carol', false, 3_000)).toEqual({
      ok: false,
      reason: 'guild-daily-limit',
      retryAfterMs: 86_398_000,
    });
    expect(commitStart(limiter, 'guild-a', 'carol', false, 86_401_000)).toEqual({ ok: true });
  });

  it('administrador ignora apenas cooldowns e continua sujeito à cota dura diária', () => {
    const limiter = new ManualRecordingStartLimiter({
      userCooldownMs: 60_000,
      guildCooldownMs: 60_000,
      maxStartsPerGuild24h: 1,
    });

    expect(commitStart(limiter, 'guild-a', 'admin', true, 1_000)).toEqual({ ok: true });
    expect(commitStart(limiter, 'guild-a', 'admin', true, 2_000)).toEqual({
      ok: false,
      reason: 'guild-daily-limit',
      retryAfterMs: 86_399_000,
    });
    expect(commitStart(limiter, 'guild-b', 'admin', true, 2_000)).toEqual({ ok: true });
  });

  it('mantém o estado em memória limitado e remove a identidade mais antiga', () => {
    const limiter = new ManualRecordingStartLimiter({
      userCooldownMs: 86_400_000,
      guildCooldownMs: 0,
      maxStartsPerGuild24h: 10,
    });

    for (let i = 0; i <= 5_000; i++) {
      expect(commitStart(limiter, `guild-${i}`, `user-${i}`, false, i + 1)).toEqual({ ok: true });
    }

    expect(commitStart(limiter, 'guild-new', 'user-0', false, 6_000)).toEqual({ ok: true });
  });
});
