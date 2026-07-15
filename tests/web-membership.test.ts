import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import http from 'node:http';
import { cleanInline } from '../src/sanitize';
import type { RecordingMeta } from '../src/store';
import { FreshMembershipBudget, TransientAccessError } from '../src/web/access';
import { OpaqueCursorError } from '../src/web/opaqueCursor';
import {
  collectWebLibraryPage,
  currentGuildMembership,
  encodeWebLibraryCursor,
  httpsRedirectTarget,
  hardenHttpServer,
  isRateLimitedWebPath,
  mcpConnectionCreationRateLimited,
  MAX_WEB_LIBRARY_CANDIDATES_PER_PAGE,
  parseWebLibraryCursor,
  referrerPolicyForWebRequest,
  robotsForRoles,
  shouldNoIndexWebResponse,
  sitemapForRoles,
  WebOrigins,
  webHostRoutingDecision,
} from '../src/web/server';

describe('cursor estável da biblioteca web', () => {
  it('faz round-trip da âncora sem expor o id nem no Base64 decodificado', () => {
    const cursor = { startedAt: 1_720_000_000_123, id: '2026-07-09-call-abc' };
    const encoded = encodeWebLibraryCursor(cursor, 'user-cursor', 'q=&sort=recent', 1_720_000_000_000);

    expect(encoded).not.toContain(cursor.id);
    expect(Buffer.from(encoded, 'base64url').toString('utf8')).not.toContain(cursor.id);
    expect(parseWebLibraryCursor(encoded, 'user-cursor', 'q=&sort=recent', 1_720_000_000_000)).toEqual(cursor);
  });

  it('recusa cursor malformado, de outro usuário ou de outros filtros', () => {
    const encoded = encodeWebLibraryCursor(
      { startedAt: 1_720_000_000_123, id: 'valid-id' },
      'user-cursor',
      'q=&sort=recent',
      1_720_000_000_000,
    );

    expect(() => parseWebLibraryCursor('%%%', 'user-cursor', 'q=&sort=recent')).toThrow(OpaqueCursorError);
    expect(() => parseWebLibraryCursor(encoded, 'other-user', 'q=&sort=recent', 1_720_000_000_000)).toThrow(
      OpaqueCursorError,
    );
    expect(() => parseWebLibraryCursor(encoded, 'user-cursor', 'q=secret&sort=recent', 1_720_000_000_000)).toThrow(
      OpaqueCursorError,
    );
  });
});

function libraryMeta(id: string, guildId: string): RecordingMeta {
  return {
    id,
    guildId,
    guildName: guildId,
    voiceChannelId: 'voice',
    voiceChannelName: 'Call',
    startedBy: null,
    startedAt: Date.now(),
    status: 'done',
    participants: [],
    events: [],
    notes: [],
  };
}

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
  app: 'https://app.example.com',
  mcp: 'https://mcp.example.com',
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
    expect(missing.fetch).toHaveBeenCalledWith({ user: 'user', force: true, cache: false });
    expect(member.fetch).toHaveBeenCalledWith({ user: 'user', force: true, cache: false });

    await expect(currentGuildMembership('user', [guildFetch('missing').guild])).resolves.toBe('not-member');
    await expect(currentGuildMembership('user', [guildFetch('transient').guild])).resolves.toBe('unavailable');
  });

  it('limita tentativas de criação por usuário antes de varrer guilds', () => {
    const userId = 'web-membership-rate-limit-user';
    expect(Array.from({ length: 5 }, () => mcpConnectionCreationRateLimited(userId))).toEqual(
      Array.from({ length: 5 }, () => false),
    );
    expect(mcpConnectionCreationRateLimited(userId)).toBe(true);
  });

  it('retoma a varredura depois do budget sem deixar guilds tardias inacessíveis', async () => {
    let now = 1_000;
    const budget = new FreshMembershipBudget(
      { perUserPerMinute: 2, globalPerMinute: 10, maxConcurrent: 2, maxTrackedUsers: 10 },
      () => now,
    );
    const first = guildFetch('missing');
    const second = guildFetch('missing');
    const third = guildFetch('missing');
    const member = guildFetch('member');
    const runCheck = <T>(userId: string, task: () => Promise<T>) => budget.run(userId, task);

    await expect(
      currentGuildMembership('late-guild-user', [first.guild, second.guild, third.guild, member.guild], runCheck),
    ).resolves.toBe('unavailable');
    expect(first.fetch).toHaveBeenCalledTimes(1);
    expect(second.fetch).toHaveBeenCalledTimes(1);
    expect(third.fetch).not.toHaveBeenCalled();

    now += 60_001;
    await expect(
      currentGuildMembership('late-guild-user', [first.guild, second.guild, third.guild, member.guild], runCheck),
    ).resolves.toBe('member');
    expect(third.fetch).toHaveBeenCalledTimes(1);
    expect(member.fetch).toHaveBeenCalledTimes(1);
  });

  it('não materializa todas as guilds antes de aplicar o teto de varredura', async () => {
    let yielded = 0;
    const guilds = {
      *[Symbol.iterator]() {
        for (let index = 0; index < 10_000; index++) {
          yielded++;
          yield guildFetch(index === 69 ? 'member' : 'missing').guild;
        }
      },
    };
    const runCheck = async <T>(_userId: string, task: () => Promise<T>) => task();

    await expect(currentGuildMembership('bounded-guild-scan', guilds, runCheck)).resolves.toBe('unavailable');
    expect(yielded).toBeLessThanOrEqual(60);

    yielded = 0;
    await expect(currentGuildMembership('bounded-guild-scan', guilds, runCheck)).resolves.toBe('member');
    expect(yielded).toBe(70);
  });

  it('conclui como não membro depois de percorrer mais de uma página de guilds ausentes', async () => {
    const missingGuilds = Array.from({ length: 61 }, () => guildFetch('missing'));
    const runCheck = async <T>(_userId: string, task: () => Promise<T>) => task();

    await expect(
      currentGuildMembership(
        'all-missing-across-membership-pages',
        missingGuilds.map(({ guild }) => guild),
        runCheck,
      ),
    ).resolves.toBe('unavailable');
    await expect(
      currentGuildMembership(
        'all-missing-across-membership-pages',
        missingGuilds.map(({ guild }) => guild),
        runCheck,
      ),
    ).resolves.toBe('not-member');
    expect(missingGuilds.map(({ fetch }) => fetch.mock.calls.length)).toEqual(Array.from({ length: 61 }, () => 1));
  });

  it('preserva indisponibilidade transitória até concluir todas as páginas', async () => {
    const transient = guildFetch('transient');
    const missingGuilds = Array.from({ length: 60 }, () => guildFetch('missing'));
    const guilds = [transient.guild, ...missingGuilds.map(({ guild }) => guild)];
    const runCheck = async <T>(_userId: string, task: () => Promise<T>) => task();

    await expect(currentGuildMembership('transient-across-membership-pages', guilds, runCheck)).resolves.toBe(
      'unavailable',
    );
    await expect(currentGuildMembership('transient-across-membership-pages', guilds, runCheck)).resolves.toBe(
      'unavailable',
    );
    expect(transient.fetch).toHaveBeenCalledTimes(1);
    expect(missingGuilds.map(({ fetch }) => fetch.mock.calls.length)).toEqual(Array.from({ length: 60 }, () => 1));
  });
});

describe('paginação ACL da biblioteca web', () => {
  const user = { id: 'library-user', name: 'Pessoa', avatar: null };

  it('alcança guilds depois do teto sem repetir sempre as primeiras', async () => {
    const metas = Array.from({ length: 70 }, (_, index) => libraryMeta(`library-${index}`, `guild-${index}`));
    const runCheck = vi.fn(async (_user, meta: RecordingMeta) => ({
      view: meta.guildId === 'guild-69',
      delete: false,
    }));

    const first = await collectWebLibraryPage(user, metas, 0, runCheck);
    const second = await collectWebLibraryPage(user, metas, first.nextCursor, runCheck);
    const third = await collectWebLibraryPage(user, metas, second.nextCursor, runCheck);

    expect(first).toMatchObject({ nextCursor: 25, guildsChecked: 25 });
    expect(second).toMatchObject({ nextCursor: 50, guildsChecked: 25 });
    expect(third.items.map((item) => item.meta.id)).toEqual(['library-69']);
    expect(third.nextCursor).toBeUndefined();
  });

  it('não deixa uma página cheia de candidatas inacessíveis esconder uma antiga autorizada', async () => {
    const metas = [
      ...Array.from({ length: MAX_WEB_LIBRARY_CANDIDATES_PER_PAGE }, (_, index) =>
        libraryMeta(`noise-${index}`, 'noise-guild'),
      ),
      libraryMeta('authorized-old', 'noise-guild'),
    ];
    const runCheck = vi.fn(async (_user, meta: RecordingMeta) => ({
      view: meta.id === 'authorized-old',
      delete: false,
    }));

    const first = await collectWebLibraryPage(user, metas, 0, runCheck);
    const second = await collectWebLibraryPage(user, metas, first.nextCursor, runCheck);

    expect(first).toMatchObject({
      nextCursor: MAX_WEB_LIBRARY_CANDIDATES_PER_PAGE,
      candidatesScanned: MAX_WEB_LIBRARY_CANDIDATES_PER_PAGE,
    });
    expect(second.items.map((item) => item.meta.id)).toEqual(['authorized-old']);
  });

  it('não transforma falha transitória em negação nem avalia candidatas posteriores', async () => {
    const metas = [
      libraryMeta('conclusive-denial', 'guild-a'),
      libraryMeta('discord-unavailable', 'guild-b'),
      libraryMeta('must-not-be-skipped', 'guild-c'),
    ];
    const runCheck = vi.fn(async (_user, meta: RecordingMeta) => {
      if (meta.id === 'discord-unavailable') throw new TransientAccessError('Discord timeout');
      return { view: false, delete: false };
    });

    await expect(collectWebLibraryPage(user, metas, 0, runCheck)).rejects.toBeInstanceOf(TransientAccessError);
    expect(runCheck.mock.calls.map(([, meta]) => meta.id)).toEqual(['conclusive-denial', 'discord-unavailable']);
    expect(runCheck.mock.calls[0]?.[2]).toMatchObject({ throwOnTransient: true });
  });
});

describe('políticas HTTP da superfície web', () => {
  it('preserva Origin nos formulários servidos pela raiz dedicada do app', () => {
    expect(referrerPolicyForWebRequest(webRequest('app.example.com', '/'), splitOrigins)).toBe('same-origin');
    expect(referrerPolicyForWebRequest(webRequest('kassinao.cloud', '/'), splitOrigins)).toBe('no-referrer');
    expect(referrerPolicyForWebRequest(webRequest('docs.kassinao.cloud', '/'), splitOrigins)).toBe('no-referrer');
  });

  it('aplica limites do listener contra slowloris e churn de keep-alive', () => {
    const server = http.createServer();
    hardenHttpServer(server);
    expect(server.requestTimeout).toBe(120_000);
    expect(server.headersTimeout).toBe(10_000);
    expect(server.keepAliveTimeout).toBe(5_000);
    expect(server.maxRequestsPerSocket).toBe(1_000);
  });

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
    expect(webHostRoutingDecision(webRequest('app.example.com', '/app/rec/abc'), splitOrigins)).toMatchObject({
      action: 'pass',
    });
    expect(webHostRoutingDecision(webRequest('app.example.com', '/?lang=pt'), splitOrigins)).toEqual({
      action: 'rewrite',
      roles: ['app'],
      path: '/app?lang=pt',
    });
    expect(webHostRoutingDecision(webRequest('app.example.com', '/privacy'), splitOrigins)).toMatchObject({
      action: 'pass',
      roles: ['app'],
    });
    expect(webHostRoutingDecision(webRequest('kassinao.cloud', '/privacy'), splitOrigins)).toMatchObject({
      action: 'redirect',
      target: 'https://app.example.com/privacy',
    });
    expect(webHostRoutingDecision(webRequest('docs.kassinao.cloud', '/en/privacy'), splitOrigins)).toMatchObject({
      action: 'redirect',
      target: 'https://app.example.com/en/privacy',
    });
    expect(webHostRoutingDecision(webRequest('mcp.example.com', '/api/meetings', 'POST'), splitOrigins)).toMatchObject({
      action: 'pass',
    });
    expect(webHostRoutingDecision(webRequest('mcp.example.com', '/'), splitOrigins)).toMatchObject({
      action: 'redirect',
      status: 308,
      target: 'https://docs.kassinao.cloud/#mcp',
    });
    expect(webHostRoutingDecision(webRequest('mcp.example.com', '/en'), splitOrigins)).toMatchObject({
      action: 'redirect',
      status: 308,
      target: 'https://docs.kassinao.cloud/en#mcp',
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
    expect(webHostRoutingDecision(webRequest('app.example.com', '/api/meetings'), splitOrigins)).toEqual({
      action: 'reject',
      roles: ['app'],
      status: 404,
    });
    expect(webHostRoutingDecision(webRequest('kassinao.cloud', '/App/rec/abc'), splitOrigins)).toEqual({
      action: 'reject',
      roles: ['public'],
      status: 404,
    });
    expect(webHostRoutingDecision(webRequest('kassinao.cloud', '/demo/'), splitOrigins)).toMatchObject({
      action: 'redirect',
      target: 'https://kassinao.cloud/demo',
    });
    expect(webHostRoutingDecision(webRequest('app.example.com', '/PRIVACY/'), splitOrigins)).toMatchObject({
      action: 'redirect',
      target: 'https://app.example.com/privacy',
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

  it('rejeita Host desconhecido sem refletir seu valor', () => {
    expect(webHostRoutingDecision(webRequest('evil.example', '/app'), splitOrigins)).toEqual({
      action: 'reject',
      roles: [],
      status: 421,
    });
    expect(webHostRoutingDecision(webRequest('retired.example', '/api/mcp/refresh', 'POST'), splitOrigins)).toEqual({
      action: 'reject',
      roles: [],
      status: 421,
    });
    expect(webHostRoutingDecision(webRequest('retired.example', '/auth/callback?code=x'), splitOrigins)).toEqual({
      action: 'reject',
      roles: [],
      status: 421,
    });
    expect(webHostRoutingDecision(webRequest('kassinao.cloud', '/auth/callback?code=x'), splitOrigins)).toEqual({
      action: 'reject',
      roles: ['public'],
      status: 404,
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

  it('marca toda superfície privada e health como não indexável', () => {
    expect(shouldNoIndexWebResponse(webRequest('app.example.com', '/assets/kassinao-mark.png'), splitOrigins)).toBe(
      true,
    );
    expect(shouldNoIndexWebResponse(webRequest('mcp.example.com', '/'), splitOrigins)).toBe(true);
    expect(shouldNoIndexWebResponse(webRequest('kassinao.cloud', '/health'), splitOrigins)).toBe(true);
    expect(shouldNoIndexWebResponse(webRequest('app.example.com', '/privacy'), splitOrigins)).toBe(true);
    expect(shouldNoIndexWebResponse(webRequest('kassinao.cloud', '/privacy'), splitOrigins)).toBe(true);
    expect(shouldNoIndexWebResponse(webRequest('kassinao.cloud', '/demo'), splitOrigins)).toBe(false);
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
