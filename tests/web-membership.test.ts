import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { cleanInline } from '../src/sanitize';
import { currentGuildMembership, httpsRedirectTarget, isRateLimitedWebPath } from '../src/web/server';

function guildFetch(result: 'member' | 'missing' | 'transient') {
  const fetch =
    result === 'member'
      ? vi.fn().mockResolvedValue({ id: 'user' })
      : result === 'missing'
        ? vi.fn().mockRejectedValue(Object.assign(new Error('Unknown Member'), { code: 10007 }))
        : vi.fn().mockRejectedValue(new Error('Discord unavailable'));
  return { guild: { members: { fetch } }, fetch };
}

describe('criação de conexão MCP', () => {
  it('exige membership atual em ao menos uma guild e falha fechada quando o Discord está indisponível', async () => {
    const missing = guildFetch('missing');
    const member = guildFetch('member');
    await expect(currentGuildMembership('user', [missing.guild, member.guild])).resolves.toBe('member');
    expect(missing.fetch).toHaveBeenCalledWith({ user: 'user', force: true, cache: true });
    expect(member.fetch).toHaveBeenCalledWith({ user: 'user', force: true, cache: true });

    await expect(currentGuildMembership('user', [guildFetch('missing').guild])).resolves.toBe('not-member');
    await expect(currentGuildMembership('user', [guildFetch('transient').guild])).resolves.toBe('unavailable');
  });
});

describe('políticas HTTP da superfície web', () => {
  it('redireciona HTTP público para a origem HTTPS configurada sem confiar no Host', () => {
    const req = {
      secure: false,
      originalUrl: '/app?next=1',
      socket: { remoteAddress: '203.0.113.10' },
      headers: { host: 'evil.example' },
    } as unknown as Request;
    expect(httpsRedirectTarget(req, 'https://kassinao.example')).toBe('https://kassinao.example/app?next=1');
  });

  it('não redireciona HTTPS nem healthcheck interno em loopback', () => {
    const request = (secure: boolean, remoteAddress: string) =>
      ({ secure, originalUrl: '/health', socket: { remoteAddress } }) as unknown as Request;
    expect(httpsRedirectTarget(request(true, '203.0.113.10'), 'https://kassinao.example')).toBeUndefined();
    expect(httpsRedirectTarget(request(false, '127.0.0.1'), 'https://kassinao.example')).toBeUndefined();
    expect(httpsRedirectTarget(request(false, '203.0.113.10'), 'http://localhost:8080')).toBeUndefined();
  });

  it('mantém login e callback OAuth dentro do rate limit web', () => {
    expect(isRateLimitedWebPath('/auth/login')).toBe(true);
    expect(isRateLimitedWebPath('/auth/callback')).toBe(true);
    expect(isRateLimitedWebPath('/')).toBe(true);
    expect(isRateLimitedWebPath('/assets/kassinao-mark.png')).toBe(true);
    expect(isRateLimitedWebPath('/og-pt.png')).toBe(true);
    expect(isRateLimitedWebPath('/health')).toBe(false);
    expect(isRateLimitedWebPath('/health/details')).toBe(false);
    expect(isRateLimitedWebPath('/api/meetings')).toBe(false);
  });

  it('neutraliza quebra de linha antes de valores controlados entrarem no log', () => {
    expect(cleanInline('123\nFORGED entry\u001b[31m')).toBe('123 FORGED entry');
  });
});
