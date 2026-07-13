import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { cleanInline } from '../src/sanitize';
import {
  currentGuildMembership,
  httpsRedirectTarget,
  isRateLimitedWebPath,
  robotsForRoles,
  sitemapForRoles,
  WebOrigins,
  webHostRoutingDecision,
} from '../src/web/server';

function guildFetch(result: 'member' | 'missing' | 'transient') {
  const fetch =
    result === 'member'
      ? vi.fn().mockResolvedValue({ id: 'user' })
      : result === 'missing'
        ? vi.fn().mockRejectedValue(Object.assign(new Error('Unknown Member'), { code: 10007 }))
        : vi.fn().mockRejectedValue(new Error('Discord unavailable'));
  return { guild: { members: { fetch } }, fetch };
}

const splitOrigins: WebOrigins = {
  public: 'https://kassinao.cloud',
  docs: 'https://docs.kassinao.cloud',
  app: 'https://app.kassinao.cloud',
  mcp: 'https://mcp.kassinao.cloud',
  legacy: 'https://kassinao.resolvicomai.app',
};

function webRequest(host: string, originalUrl: string, method = 'GET'): Request {
  const pathname = originalUrl.split('?')[0] || '/';
  return {
    method,
    path: pathname,
    originalUrl,
    secure: true,
    headers: { host },
    socket: { remoteAddress: '203.0.113.10' },
    get(name: string) {
      return name.toLowerCase() === 'host' ? host : undefined;
    },
  } as unknown as Request;
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
  it('isola landing, docs, app e MCP pelo host configurado', () => {
    expect(webHostRoutingDecision(webRequest('kassinao.cloud', '/'), splitOrigins)).toMatchObject({ action: 'pass' });
    expect(webHostRoutingDecision(webRequest('docs.kassinao.cloud', '/?lang=pt'), splitOrigins)).toMatchObject({
      action: 'rewrite',
      path: '/docs?lang=pt',
    });
    expect(webHostRoutingDecision(webRequest('docs.kassinao.cloud', '/en'), splitOrigins)).toMatchObject({
      action: 'rewrite',
      path: '/en/docs',
    });
    expect(webHostRoutingDecision(webRequest('app.kassinao.cloud', '/app/rec/abc'), splitOrigins)).toMatchObject({
      action: 'pass',
    });
    expect(
      webHostRoutingDecision(webRequest('mcp.kassinao.cloud', '/api/meetings', 'POST'), splitOrigins),
    ).toMatchObject({ action: 'pass' });
    expect(webHostRoutingDecision(webRequest('mcp.kassinao.cloud', '/'), splitOrigins)).toMatchObject({
      action: 'redirect',
      status: 308,
      target: 'https://docs.kassinao.cloud/#mcp',
    });
  });

  it('faz redirects canônicos só em navegação e nunca encaminha mutações entre origens', () => {
    expect(webHostRoutingDecision(webRequest('www.kassinao.cloud', '/demo?lang=en'), splitOrigins)).toMatchObject({
      action: 'redirect',
      status: 308,
      target: 'https://kassinao.cloud/demo?lang=en',
    });
    expect(webHostRoutingDecision(webRequest('kassinao.cloud', '/docs?ref=nav'), splitOrigins)).toMatchObject({
      action: 'redirect',
      target: 'https://docs.kassinao.cloud/?ref=nav',
    });
    expect(webHostRoutingDecision(webRequest('docs.kassinao.cloud', '/demo?lang=en'), splitOrigins)).toMatchObject({
      action: 'redirect',
      target: 'https://kassinao.cloud/demo?lang=en',
    });
    expect(webHostRoutingDecision(webRequest('kassinao.cloud', '/app/logout', 'POST'), splitOrigins)).toEqual({
      action: 'reject',
      roles: ['public'],
      status: 404,
    });
    expect(webHostRoutingDecision(webRequest('www.kassinao.cloud', '/api/mcp/refresh', 'POST'), splitOrigins)).toEqual({
      action: 'reject',
      roles: [],
      status: 404,
    });
    expect(webHostRoutingDecision(webRequest('www.kassinao.cloud', '/api/meetings'), splitOrigins)).toEqual({
      action: 'reject',
      roles: [],
      status: 404,
    });
  });

  it('fecha variantes de caixa, canoniza barras públicas e não expõe API no host privado', () => {
    expect(webHostRoutingDecision(webRequest('kassinao.cloud', '/API/meetings'), splitOrigins)).toEqual({
      action: 'reject',
      roles: ['public'],
      status: 404,
    });
    expect(webHostRoutingDecision(webRequest('app.kassinao.cloud', '/api/meetings'), splitOrigins)).toEqual({
      action: 'reject',
      roles: ['app'],
      status: 404,
    });
    expect(webHostRoutingDecision(webRequest('kassinao.cloud', '/App/rec/abc'), splitOrigins)).toMatchObject({
      action: 'redirect',
      target: 'https://app.kassinao.cloud/app/rec/abc',
    });
    expect(webHostRoutingDecision(webRequest('kassinao.cloud', '/demo/'), splitOrigins)).toMatchObject({
      action: 'redirect',
      target: 'https://kassinao.cloud/demo',
    });
    expect(webHostRoutingDecision(webRequest('docs.kassinao.cloud', '/EN/'), splitOrigins)).toMatchObject({
      action: 'redirect',
      target: 'https://docs.kassinao.cloud/en',
    });

    const singleOrigin: WebOrigins = {
      app: 'https://single.example',
      public: 'https://single.example',
      docs: 'https://single.example',
      mcp: 'https://single.example',
    };
    expect(webHostRoutingDecision(webRequest('single.example', '/api/meetings'), singleOrigin)).toMatchObject({
      action: 'pass',
      roles: ['app', 'public', 'docs', 'mcp'],
    });
  });

  it('mantém API e callback OAuth legados, mas migra navegações antigas para o app novo', () => {
    expect(
      webHostRoutingDecision(webRequest('kassinao.resolvicomai.app', '/api/mcp/refresh', 'POST'), splitOrigins),
    ).toMatchObject({ action: 'pass' });
    expect(
      webHostRoutingDecision(webRequest('kassinao.resolvicomai.app', '/auth/callback?code=x'), splitOrigins),
    ).toMatchObject({ action: 'pass' });
    expect(
      webHostRoutingDecision(webRequest('kassinao.resolvicomai.app', '/app/rec/abc?lang=pt'), splitOrigins),
    ).toMatchObject({
      action: 'redirect',
      target: 'https://app.kassinao.cloud/app/rec/abc?lang=pt',
    });
    expect(
      webHostRoutingDecision(webRequest('kassinao.resolvicomai.app', '/app/rec/abc/delete', 'POST'), splitOrigins),
    ).toMatchObject({ action: 'reject', status: 404 });
  });

  it('rejeita Host desconhecido sem refletir seu valor', () => {
    expect(webHostRoutingDecision(webRequest('evil.example', '/app'), splitOrigins)).toEqual({
      action: 'reject',
      roles: [],
      status: 421,
    });
  });

  it('publica robots e sitemaps próprios para site e docs e bloqueia app/MCP', () => {
    expect(robotsForRoles(['public'], splitOrigins)).toContain('Sitemap: https://kassinao.cloud/sitemap.xml');
    expect(robotsForRoles(['public'], splitOrigins)).toContain('Disallow: /app');
    expect(robotsForRoles(['docs'], splitOrigins)).toContain('Sitemap: https://docs.kassinao.cloud/sitemap.xml');
    expect(robotsForRoles(['app'], splitOrigins)).toBe('User-agent: *\nDisallow: /\n');
    expect(sitemapForRoles(['public'], splitOrigins)).toContain('<loc>https://kassinao.cloud/en/demo</loc>');
    expect(sitemapForRoles(['docs'], splitOrigins)).toContain('<loc>https://docs.kassinao.cloud/en</loc>');
    expect(sitemapForRoles(['mcp'], splitOrigins)).toBeUndefined();
  });

  it('redireciona HTTP público para a origem HTTPS configurada sem confiar no Host', () => {
    const req = {
      secure: false,
      originalUrl: '/app?next=1',
      socket: { remoteAddress: '203.0.113.10' },
      headers: { host: 'evil.example' },
    } as unknown as Request;
    expect(httpsRedirectTarget(req, 'https://kassinao.example')).toBe('https://kassinao.example/app?next=1');
  });

  it('preserva a origem canônica de cada host ao subir HTTP para HTTPS', () => {
    const docsRequest = webRequest('docs.kassinao.cloud', '/en?ref=old');
    Object.assign(docsRequest, { secure: false });
    expect(httpsRedirectTarget(docsRequest, undefined, splitOrigins)).toBe('https://docs.kassinao.cloud/en?ref=old');

    const unknown = webRequest('evil.example', '/en');
    Object.assign(unknown, { secure: false });
    expect(httpsRedirectTarget(unknown, undefined, splitOrigins)).toBeUndefined();
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
