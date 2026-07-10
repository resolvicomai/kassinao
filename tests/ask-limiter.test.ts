import { describe, expect, it } from 'vitest';
import { AskLimiter } from '../src/askLimiter';

function limiter(overrides: Partial<ConstructorParameters<typeof AskLimiter>[0]> = {}): AskLimiter {
  return new AskLimiter({
    maxConcurrent: 2,
    maxAttemptsPerUser: 5,
    maxAttemptsPerGuild: 10,
    maxPerUser: 2,
    maxPerGuild: 3,
    maxGlobal: 4,
    windowMs: 60_000,
    ...overrides,
  });
}

describe('AskLimiter', () => {
  it('reserva a vaga imediatamente e bloqueia a corrida por pessoa/global', () => {
    const gate = limiter();
    expect(gate.reserve('ana', 'guild-a')).toBe('accepted');
    expect(gate.reserve('ana', 'guild-a')).toBe('busy-user');
    expect(gate.reserve('bruno', 'guild-a')).toBe('accepted');
    expect(gate.reserve('carla', 'guild-a')).toBe('busy-global');
    gate.release('ana');
    expect(gate.reserve('carla', 'guild-a')).toBe('accepted');
  });

  it('cobra orçamento só quando charge é chamado', () => {
    const gate = limiter();
    expect(gate.reserve('ana', 'guild-a')).toBe('accepted');
    gate.release('ana');
    expect(gate.reserve('ana', 'guild-a')).toBe('accepted'); // data/ACL/evidência podem falhar sem custo de LLM
    expect(gate.charge('ana', 'guild-a', 1_000)).toBe('accepted');
    expect(gate.charge('ana', 'guild-a', 2_000)).toBe('accepted');
    expect(gate.charge('ana', 'guild-a', 3_000)).toBe('rate-user');
  });

  it('isola abuso de uma guild antes do teto global', () => {
    const gate = limiter({ maxPerUser: 10, maxPerGuild: 2, maxGlobal: 4 });
    expect(gate.charge('a1', 'guild-a', 1_000)).toBe('accepted');
    expect(gate.charge('a2', 'guild-a', 2_000)).toBe('accepted');
    expect(gate.charge('a3', 'guild-a', 3_000)).toBe('rate-guild');
    expect(gate.charge('b1', 'guild-b', 3_000)).toBe('accepted');
    expect(gate.charge('b2', 'guild-b', 4_000)).toBe('accepted');
    expect(gate.charge('c1', 'guild-c', 5_000)).toBe('rate-global');
  });

  it('limita tentativas baratas por usuário/guild sem queimar a cota global do LLM', () => {
    const gate = limiter({ maxAttemptsPerUser: 2, maxAttemptsPerGuild: 3, maxPerUser: 10, maxGlobal: 10 });
    expect(gate.reserve('ana', 'guild-a', 1_000)).toBe('accepted');
    gate.release('ana');
    expect(gate.reserve('ana', 'guild-a', 2_000)).toBe('accepted');
    gate.release('ana');
    expect(gate.reserve('ana', 'guild-a', 3_000)).toBe('rate-attempt-user');
    expect(gate.reserve('bruno', 'guild-a', 3_000)).toBe('accepted');
    gate.release('bruno');
    expect(gate.reserve('carla', 'guild-a', 4_000)).toBe('rate-attempt-guild');
    expect(gate.charge('carla', 'guild-b', 4_000)).toBe('accepted');
  });

  it('não esquece a cota antiga quando o mapa de identidades enche', () => {
    const gate = limiter({ maxAttemptsPerUser: 1, maxTrackedUsers: 2 });
    expect(gate.reserve('ana', 'guild-a', 1_000)).toBe('accepted');
    gate.release('ana');
    expect(gate.reserve('bruno', 'guild-a', 2_000)).toBe('accepted');
    gate.release('bruno');
    expect(gate.reserve('carla', 'guild-a', 3_000)).toBe('rate-attempt-user');
    expect(gate.reserve('ana', 'guild-a', 4_000)).toBe('rate-attempt-user');
  });

  it('libera o orçamento quando a janela expira', () => {
    const gate = limiter({ maxPerUser: 1, maxPerGuild: 1, maxGlobal: 1 });
    expect(gate.charge('ana', 'guild-a', 1_000)).toBe('accepted');
    expect(gate.charge('ana', 'guild-a', 30_000)).toBe('rate-user');
    expect(gate.charge('ana', 'guild-a', 61_001)).toBe('accepted');
  });
});
