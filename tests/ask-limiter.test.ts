import { describe, expect, it } from 'vitest';
import { AskLimiter } from '../src/askLimiter';

function limiter(overrides: Partial<ConstructorParameters<typeof AskLimiter>[0]> = {}): AskLimiter {
  return new AskLimiter({
    maxConcurrent: 2,
    maxPerUser: 2,
    maxGlobal: 4,
    windowMs: 60_000,
    ...overrides,
  });
}

describe('AskLimiter', () => {
  it('reserva a vaga imediatamente e bloqueia a corrida por pessoa/global', () => {
    const gate = limiter();
    expect(gate.acquire('ana', 1_000)).toBe('accepted');
    expect(gate.acquire('ana', 1_000)).toBe('busy-user');
    expect(gate.acquire('bruno', 1_000)).toBe('accepted');
    expect(gate.acquire('carla', 1_000)).toBe('busy-global');
    gate.release('ana');
    expect(gate.acquire('carla', 1_000)).toBe('accepted');
  });

  it('aplica orçamento por pessoa e global sem contar tentativas ocupadas', () => {
    const gate = limiter();
    expect(gate.acquire('ana', 1_000)).toBe('accepted');
    gate.release('ana');
    expect(gate.acquire('ana', 2_000)).toBe('accepted');
    gate.release('ana');
    expect(gate.acquire('ana', 3_000)).toBe('rate-user');

    expect(gate.acquire('bruno', 3_000)).toBe('accepted');
    gate.release('bruno');
    expect(gate.acquire('carla', 4_000)).toBe('accepted');
    gate.release('carla');
    expect(gate.acquire('diego', 5_000)).toBe('rate-global');
  });

  it('libera o orçamento quando a janela expira', () => {
    const gate = limiter({ maxPerUser: 1, maxGlobal: 1 });
    expect(gate.acquire('ana', 1_000)).toBe('accepted');
    gate.release('ana');
    expect(gate.acquire('ana', 30_000)).toBe('rate-user');
    expect(gate.acquire('ana', 61_001)).toBe('accepted');
  });
});
