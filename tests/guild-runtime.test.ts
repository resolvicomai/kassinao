import { describe, expect, it } from 'vitest';
import { GuildRuntimeBoundary } from '../src/discord/guildRuntime';
import type { GuildPolicy } from '../src/guildPolicy';

const ALLOWED = '123456789012345678';
const SECOND = '223456789012345678';
const DENIED = '323456789012345678';

function privatePolicy(): GuildPolicy {
  return {
    mode: 'private',
    allowedGuildIds: [ALLOWED, SECOND],
    allows: (guildId) => guildId === ALLOWED || guildId === SECOND,
  };
}

describe('GuildRuntimeBoundary', () => {
  it('exige allowlist e presença atual no gateway para trabalho operacional', () => {
    const connected = new Set([ALLOWED, DENIED]);
    const boundary = new GuildRuntimeBoundary(privatePolicy(), (guildId) => connected.has(guildId));

    expect(boundary.isOperational(ALLOWED)).toBe(true);
    expect(boundary.isOperational(SECOND)).toBe(false);
    expect(boundary.isOperational(DENIED)).toBe(false);
  });

  it('pausa GuildUnavailable sem retirar a autorização permanente', () => {
    const boundary = new GuildRuntimeBoundary(privatePolicy(), () => true);

    boundary.markUnavailable(ALLOWED);
    expect(boundary.allows(ALLOWED)).toBe(true);
    expect(boundary.isOperational(ALLOWED)).toBe(false);

    boundary.markAvailable(ALLOWED);
    expect(boundary.isOperational(ALLOWED)).toBe(true);
  });

  it('seleciona somente guilds permitidas para comandos e respeita GUILD_ID como filtro', () => {
    const boundary = new GuildRuntimeBoundary(privatePolicy(), () => true);

    expect(boundary.commandTargets([DENIED, SECOND, ALLOWED])).toEqual([SECOND, ALLOWED]);
    expect(boundary.commandTargets([ALLOWED, SECOND], SECOND)).toEqual([SECOND]);
    expect(boundary.commandTargets([ALLOWED, DENIED], DENIED)).toEqual([]);
    expect(boundary.commandTargets([ALLOWED], SECOND)).toEqual([]);
  });
});
