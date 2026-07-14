import { describe, expect, it } from 'vitest';
import { DmMessageLimiter } from '../src/dmMessageLimiter';

describe('limite das DMs do bot', () => {
  it('admite só duas mensagens por pessoa a cada minuto', () => {
    let now = 1_000;
    const limiter = new DmMessageLimiter(
      { maxPerUser: 2, maxGlobal: 60, windowMs: 60_000, maxTrackedUsers: 128 },
      () => now,
    );

    expect(limiter.admit('user-a')).toBe(true);
    expect(limiter.admit('user-a')).toBe(true);
    expect(limiter.admit('user-a')).toBe(false);

    now += 60_000;
    expect(limiter.admit('user-a')).toBe(true);
  });

  it('mantém o teto global apesar de churn e não cobra recusas individuais', () => {
    const limiter = new DmMessageLimiter(
      { maxPerUser: 2, maxGlobal: 60, windowMs: 60_000, maxTrackedUsers: 128 },
      () => 1_000,
    );

    expect(limiter.admit('spammer')).toBe(true);
    expect(limiter.admit('spammer')).toBe(true);
    for (let attempt = 0; attempt < 100; attempt++) expect(limiter.admit('spammer')).toBe(false);

    for (let user = 0; user < 58; user++) expect(limiter.admit(`user-${user}`)).toBe(true);
    expect(limiter.admit('user-59')).toBe(false);
  });

  it('limita cardinalidade, falha fechado e remove chaves expiradas', () => {
    let now = 1_000;
    const limiter = new DmMessageLimiter(
      { maxPerUser: 2, maxGlobal: 100, windowMs: 60_000, maxTrackedUsers: 2 },
      () => now,
    );

    expect(limiter.admit('user-a')).toBe(true);
    expect(limiter.admit('user-b')).toBe(true);
    expect(limiter.admit('user-c')).toBe(false);
    expect(limiter.trackedUsers).toBe(2);

    now += 60_000;
    expect(limiter.admit('user-c')).toBe(true);
    expect(limiter.trackedUsers).toBe(1);
    expect(limiter.admit('')).toBe(false);
  });
});
