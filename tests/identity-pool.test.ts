import { describe, expect, it } from 'vitest';
import { IdentityPool, VoiceIdentity } from '../src/discord/identityPool';

function fakeIdentity(label: string, opts: { ready?: boolean; guilds?: string[] } = {}): VoiceIdentity {
  const guilds = new Set(opts.guilds ?? ['g1']);
  return {
    label,
    client: {
      isReady: () => opts.ready ?? true,
      guilds: { cache: { has: (id: string) => guilds.has(id) } },
    } as unknown as VoiceIdentity['client'],
  };
}

describe('IdentityPool — escolha da identidade de voz', () => {
  it('sem ajudante, é o comportamento histórico: principal livre grava, ocupado é colisão', () => {
    const pool = new IdentityPool();
    pool.register(fakeIdentity('default'));
    expect(pool.choose('g1', new Set())?.label).toBe('default');
    expect(pool.choose('g1', new Set(['default']))).toBeUndefined();
  });

  it('principal ocupado e ajudante livre: o ajudante assume', () => {
    const pool = new IdentityPool();
    pool.register(fakeIdentity('default'));
    pool.register(fakeIdentity('helper-1'));
    expect(pool.choose('g1', new Set(['default']))?.label).toBe('helper-1');
  });

  it('o principal sempre tem prioridade quando está livre', () => {
    const pool = new IdentityPool();
    pool.register(fakeIdentity('default'));
    pool.register(fakeIdentity('helper-1'));
    expect(pool.choose('g1', new Set())?.label).toBe('default');
  });

  it('ajudante caído nunca é escolhido', () => {
    const pool = new IdentityPool();
    pool.register(fakeIdentity('default'));
    pool.register(fakeIdentity('helper-1', { ready: false }));
    expect(pool.choose('g1', new Set(['default']))).toBeUndefined();
  });

  it('ajudante que não foi convidado para o servidor nunca é escolhido', () => {
    const pool = new IdentityPool();
    pool.register(fakeIdentity('default'));
    pool.register(fakeIdentity('helper-1', { guilds: ['outro-guild'] }));
    expect(pool.choose('g1', new Set(['default']))).toBeUndefined();
    expect(pool.readyCountFor('g1')).toBe(1);
  });

  it('rótulo duplicado é bug de configuração e falha alto', () => {
    const pool = new IdentityPool();
    pool.register(fakeIdentity('helper-1'));
    expect(() => pool.register(fakeIdentity('helper-1'))).toThrow();
  });
});
