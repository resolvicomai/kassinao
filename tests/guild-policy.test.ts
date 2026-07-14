import { describe, expect, it } from 'vitest';
import { createGuildPolicy } from '../src/guildPolicy';

const A = '123456789012345678';
const B = '223456789012345678';

describe('GuildPolicy', () => {
  it('falha fechado sem allowlist nem opt-in público', () => {
    expect(() => createGuildPolicy({})).toThrow(/ALLOWED_GUILD_IDS/);
  });

  it('aceita e deduplica uma allowlist estrita', () => {
    const policy = createGuildPolicy({ ALLOWED_GUILD_IDS: `${A}, ${B}, ${A}` });
    expect(policy.mode).toBe('private');
    expect(policy.allowedGuildIds).toEqual([A, B]);
    expect(policy.allows(A)).toBe(true);
    expect(policy.allows('323456789012345678')).toBe(false);
    expect(policy.allows(undefined)).toBe(false);
  });

  it('mantém GUILD_ID como filtro e exige que esteja dentro da allowlist', () => {
    expect(() => createGuildPolicy({ ALLOWED_GUILD_IDS: A, GUILD_ID: B })).toThrow(/não concede acesso/);
    expect(createGuildPolicy({ ALLOWED_GUILD_IDS: `${A},${B}`, GUILD_ID: B }).allows(B)).toBe(true);
  });

  it('exige opt-in inequívoco para aceitar qualquer guild', () => {
    const policy = createGuildPolicy({ ALLOW_ALL_GUILDS: 'true' });
    expect(policy.mode).toBe('all');
    expect(policy.allows('qualquer-id-runtime')).toBe(true);
    expect(() => createGuildPolicy({ ALLOW_ALL_GUILDS: 'true', ALLOWED_GUILD_IDS: A })).toThrow(/não pode/);
    expect(() => createGuildPolicy({ ALLOW_ALL_GUILDS: 'sim' })).toThrow(/true ou false/);
  });

  it('rejeita snowflakes malformados', () => {
    expect(() => createGuildPolicy({ ALLOWED_GUILD_IDS: 'guild-de-teste' })).toThrow(/ID Discord inválido/);
  });
});
