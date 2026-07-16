import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  config,
  normalizeBaseUrl,
  normalizeOrigin,
  normalizeWebBindAddress,
  parseConfiguredNumber,
  resolveConfiguredOrigins,
  validateDedicatedSecret,
  validateDeploymentAppOrigin,
  validateSecret,
} from '../src/config';
import {
  beginLogin,
  finishLogin,
  getWebUser,
  isAllowedWebMutation,
  logoutWeb,
  serializeWebCookie,
  webCookieSettings,
  WebUser,
} from '../src/web/auth';
import { discordDemoPage } from '../src/web/discordDemo';
import { landingPage } from '../src/web/landing';
import { connectPage, messagePage, recordingPage, recordingsIndexPage } from '../src/web/page';
import { normalizedSearchTerms, recordingIncludesUser } from '../src/web/api';
import type { RecordingMeta } from '../src/store';
import { isLoopbackAddress } from '../src/util';
import { webDeliveryErrorClass } from '../src/web/server';
import {
  createWebSession,
  isActiveWebSession,
  revokeWebSessionsForUser,
  webSessionScope,
} from '../src/web/webSessions';

function fakeRequest(method: string, headers: Record<string, string> = {}): Request {
  return {
    method,
    headers,
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  } as unknown as Request;
}

function sessionRequest(user: WebUser): Request {
  return signedSessionRequest({ ...user, iss: config.instanceId, aud: config.appUrl });
}

function signedSessionRequest(payload: object): Request {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', config.cookieSecret).update(body).digest('base64url');
  return {
    method: 'POST',
    headers: { cookie: `kassinao_session=${encodeURIComponent(`${body}.${mac}`)}` },
    get() {
      return undefined;
    },
  } as unknown as Request;
}

function cookieResponse(): { res: Response; cookies: string[] } {
  const cookies: string[] = [];
  const res = {
    append(name: string, value: string) {
      if (name === 'Set-Cookie') cookies.push(value);
      return res;
    },
    redirect() {
      return res;
    },
  } as unknown as Response;
  return { res, cookies };
}

function loginState(cookies: string[]): { cookie: string; next: string; state: string } {
  const cookie = cookies.find((value) => value.startsWith('kassinao_state='));
  if (!cookie) throw new Error('cookie OAuth state ausente');
  const token = decodeURIComponent(cookie.slice('kassinao_state='.length).split(';', 1)[0]);
  const body = token.split('.', 1)[0];
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { next: string; state: string };
  return { cookie, next: payload.next, state: payload.state };
}

function callbackRequest(saved: ReturnType<typeof loginState>): Request {
  return {
    method: 'GET',
    query: { code: 'oauth-code', state: saved.state },
    headers: { cookie: saved.cookie.split(';', 1)[0] },
    get() {
      return undefined;
    },
  } as unknown as Request;
}

describe('cookies e CSRF da superfície web privada', () => {
  it('usa cookies __Host- em HTTPS sem Domain e com Path=/ + Secure', () => {
    const settings = webCookieSettings('https://app.example.com');
    expect(settings).toEqual({
      sessionName: '__Host-kassinao_session',
      stateName: '__Host-kassinao_state',
      sessionPath: '/',
      statePath: '/',
    });
    const serialized = serializeWebCookie(
      'https://app.example.com',
      settings.sessionName,
      'token',
      60_000,
      settings.sessionPath,
    );
    expect(serialized).toContain('Path=/;');
    expect(serialized).toContain('; Secure');
    expect(serialized).not.toContain('Domain=');
  });

  it('state fica em /auth e logout apaga sessão nova + legado', () => {
    const login = cookieResponse();
    beginLogin(login.res, '/app');
    expect(login.cookies.some((c) => c.includes('kassinao_state=') && c.includes('Path=/auth;'))).toBe(true);

    const logout = cookieResponse();
    logoutWeb(fakeRequest('POST'), logout.res);
    expect(logout.cookies.some((c) => c.includes('kassinao_session=') && c.includes('Path=/app;'))).toBe(true);
    expect(logout.cookies.some((c) => c.includes('kassinao_session=') && c.includes('Path=/;'))).toBe(true);
  });

  it('mantém next local no limite e descarta o primeiro byte excedente sem criar cookie grande', () => {
    const acceptedNext = `/app?${'a'.repeat(2_043)}`;
    const accepted = cookieResponse();
    beginLogin(accepted.res, acceptedNext);
    expect(loginState(accepted.cookies)).toMatchObject({ next: acceptedNext });
    expect(loginState(accepted.cookies).cookie.length).toBeLessThanOrEqual(4_096);

    const oversized = cookieResponse();
    beginLogin(oversized.res, `/app?${'a'.repeat(2_044)}`);
    expect(loginState(oversized.cookies)).toMatchObject({ next: '/app' });
    expect(loginState(oversized.cookies).cookie.length).toBeLessThanOrEqual(4_096);
  });

  it('descarta next cujo escape JSON faria o cookie ultrapassar o limite do navegador', () => {
    const login = cookieResponse();
    beginLogin(login.res, `/app?${'"'.repeat(2_043)}`);

    expect(loginState(login.cookies)).toMatchObject({ next: '/app' });
    expect(loginState(login.cookies).cookie.length).toBeLessThanOrEqual(4_096);
  });

  it('descarta next que o navegador poderia interpretar como redirect externo', () => {
    for (const unsafeNext of ['//evil.example', '/\\evil.example', 'https://evil.example', '/docs']) {
      const login = cookieResponse();
      beginLogin(login.res, unsafeNext);
      expect(loginState(login.cookies)).toMatchObject({ next: '/app' });
    }
  });

  it('só emite sessão depois da autorização de guild e preserva escopo limitado', async () => {
    const login = cookieResponse();
    beginLogin(login.res, '/app/conectar-ia');
    const saved = loginState(login.cookies);
    const response = cookieResponse();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'discord-access' }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'oauth-user', username: 'alice', global_name: 'Alice', avatar: null }), {
          status: 200,
        }),
      );
    try {
      const result = await finishLogin(callbackRequest(saved), response.res, async () => 'revoke-only');
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error('login não emitido');
      expect(result.user.scope).toBe('revoke-only');
      expect(webSessionScope(result.user.jti, result.user.id)).toBe('revoke-only');
      expect(
        response.cookies.some((cookie) => cookie.startsWith('kassinao_session=') && !cookie.includes('Max-Age=0')),
      ).toBe(true);
      revokeWebSessionsForUser(result.user.id);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('nega outsider sem criar cookie de sessão', async () => {
    const login = cookieResponse();
    beginLogin(login.res, '/app');
    const saved = loginState(login.cookies);
    const response = cookieResponse();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'discord-access' }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'outsider', username: 'outsider', global_name: null, avatar: null }), {
          status: 200,
        }),
      );
    try {
      await expect(finishLogin(callbackRequest(saved), response.res, async () => 'denied')).resolves.toEqual({
        status: 'denied',
      });
      expect(
        response.cookies.some((cookie) => cookie.startsWith('kassinao_session=') && !cookie.includes('Max-Age=0')),
      ).toBe(false);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('trata rate limit ou falha do Discord como indisponibilidade, nunca como negação', async () => {
    const login = cookieResponse();
    beginLogin(login.res, '/app');
    const saved = loginState(login.cookies);
    const response = cookieResponse();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 429 }));
    try {
      await expect(finishLogin(callbackRequest(saved), response.res, async () => 'denied')).resolves.toEqual({
        status: 'unavailable',
      });
      expect(
        response.cookies.some((cookie) => cookie.startsWith('kassinao_session=') && !cookie.includes('Max-Age=0')),
      ).toBe(false);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('logout revoga também uma cópia do cookie no servidor', () => {
    const exp = Date.now() + 60_000;
    const user: WebUser = {
      typ: 'session',
      id: 'web-user',
      name: 'Alice',
      avatar: null,
      scope: 'full',
      exp,
      jti: createWebSession('web-user', exp),
    };
    const req = sessionRequest(user);
    expect(getWebUser(req)?.id).toBe('web-user');

    const logout = cookieResponse();
    logoutWeb(req, logout.res);
    expect(getWebUser(req)).toBeUndefined();
  });

  it('cookie HMAC antigo sem jti não sobrevive ao upgrade', () => {
    const req = signedSessionRequest({
      typ: 'session',
      id: 'legacy-user',
      name: 'Legacy',
      avatar: null,
      exp: Date.now() + 60_000,
    });
    expect(getWebUser(req)).toBeUndefined();
  });

  it('cookie assinado não atravessa identidade nem origem da instância', () => {
    const exp = Date.now() + 60_000;
    const jti = createWebSession('bound-user', exp);
    const base = {
      typ: 'session',
      id: 'bound-user',
      name: 'Bound',
      avatar: null,
      scope: 'full',
      exp,
      jti,
    };
    expect(getWebUser(signedSessionRequest({ ...base, iss: crypto.randomUUID(), aud: config.appUrl }))).toBeUndefined();
    expect(
      getWebUser(signedSessionRequest({ ...base, iss: config.instanceId, aud: 'https://other.example' })),
    ).toBeUndefined();
  });

  it('limita sessões web por usuário para a persistência não virar DoS', () => {
    const exp = Date.now() + 60_000;
    const ids = Array.from({ length: 11 }, () => createWebSession('cap-user', exp));
    expect(isActiveWebSession(ids[0], 'cap-user')).toBe(false);
    expect(isActiveWebSession(ids[10], 'cap-user')).toBe(true);
  });

  it('persiste o escopo da sessão e permite revogar todos os logins de uma conta', () => {
    const exp = Date.now() + 60_000;
    const userId = `scoped-user-${crypto.randomUUID()}`;
    const limited = createWebSession(userId, exp, 'revoke-only');
    const full = createWebSession(userId, exp, 'full');
    expect(webSessionScope(limited, userId)).toBe('revoke-only');
    expect(webSessionScope(full, userId)).toBe('full');
    expect(revokeWebSessionsForUser(userId)).toBe(2);
    expect(isActiveWebSession(limited, userId)).toBe(false);
    expect(isActiveWebSession(full, userId)).toBe(false);
  });

  it('prioriza a origem exata mesmo quando Fetch Metadata classifica a navegação como cross-site', () => {
    const base = 'https://app.example.com';
    expect(isAllowedWebMutation(fakeRequest('POST', { origin: base }), base)).toBe(true);
    expect(isAllowedWebMutation(fakeRequest('POST', { origin: base, 'sec-fetch-site': 'cross-site' }), base)).toBe(
      true,
    );
  });

  it('rejeita subdomínio irmão e cross-site sem origem verificável', () => {
    const base = 'https://app.example.com';
    expect(isAllowedWebMutation(fakeRequest('POST', { origin: 'https://kassinao.cloud' }), base)).toBe(false);
    expect(isAllowedWebMutation(fakeRequest('POST', { origin: 'https://docs.kassinao.cloud' }), base)).toBe(false);
    expect(isAllowedWebMutation(fakeRequest('POST', { origin: 'https://evil.example.com' }), base)).toBe(false);
    expect(isAllowedWebMutation(fakeRequest('POST', { origin: 'null' }), base)).toBe(false);
    expect(isAllowedWebMutation(fakeRequest('POST', { origin: 'not a url' }), base)).toBe(false);
    expect(isAllowedWebMutation(fakeRequest('POST', { 'sec-fetch-site': 'cross-site' }), base)).toBe(false);
    expect(isAllowedWebMutation(fakeRequest('POST'), base)).toBe(true); // cliente não-browser, sem cookie automático
    expect(isAllowedWebMutation(fakeRequest('GET', { origin: 'https://evil.example.com' }), base)).toBe(true);
  });

  it('classifica falhas de entrega sem registrar mensagem, caminho ou identificador', () => {
    expect(webDeliveryErrorClass({ code: 'ECONNABORTED', message: '/private/recording.mp3' })).toBe('client-abort');
    expect(webDeliveryErrorClass({ code: 'ECONNRESET' })).toBe('client-abort');
    expect(webDeliveryErrorClass({ code: 'ENOENT' })).toBe('missing');
    expect(webDeliveryErrorClass({ code: 'EACCES' })).toBe('permission');
    expect(webDeliveryErrorClass({ code: 'ENOSPC' })).toBe('io');
    expect(webDeliveryErrorClass(new Error('/private/recording.mp3'))).toBe('other');
  });

  it('detalhes de health reconhecem somente socket loopback', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('172.18.0.2')).toBe(false);
    expect(isLoopbackAddress('203.0.113.10')).toBe(false);
  });
});

describe('configuração fail-fast', () => {
  it('rejeita NaN/Infinity/fora da faixa e aceita o fallback', () => {
    expect(parseConfiguredNumber('PORT', undefined, 8080, { min: 1, max: 65535, integer: true })).toBe(8080);
    expect(() => parseConfiguredNumber('PORT', 'abc', 8080, { min: 1 })).toThrow(/número finito/);
    expect(() => parseConfiguredNumber('PORT', 'Infinity', 8080, { min: 1 })).toThrow(/número finito/);
    expect(() => parseConfiguredNumber('PORT', '1.5', 8080, { integer: true })).toThrow(/inteiro/);
    expect(() => parseConfiguredNumber('PORT', '70000', 8080, { max: 65535 })).toThrow(/<= 65535/);
  });

  it('mantém bare-node em loopback e exige wildcard explícito', () => {
    expect(normalizeWebBindAddress(undefined)).toBe('127.0.0.1');
    expect(normalizeWebBindAddress('localhost')).toBe('localhost');
    expect(normalizeWebBindAddress('0.0.0.0')).toBe('0.0.0.0');
    expect(() => normalizeWebBindAddress('web.internal')).toThrow(/WEB_BIND_ADDRESS/);
  });

  it('recusa localhost na imagem de produção sem opt-in local explícito', () => {
    expect(() => validateDeploymentAppOrigin('http://localhost:8080', 'production', false)).toThrow(
      /ALLOW_LOCAL_APP_URL/,
    );
    expect(() => validateDeploymentAppOrigin('http://localhost:8080', 'production', true)).not.toThrow();
    expect(() => validateDeploymentAppOrigin('https://app.example.com', 'production', false)).not.toThrow();
    expect(() => validateDeploymentAppOrigin('http://localhost:8080', 'test', false)).not.toThrow();
  });

  it('normaliza só origens HTTP(S), sem caminho/credencial/query', () => {
    expect(normalizeBaseUrl('https://kassinao.example.com/')).toBe('https://kassinao.example.com');
    expect(normalizeOrigin('APP_URL', 'https://app.example.com/')).toBe('https://app.example.com');
    expect(() => normalizeBaseUrl('javascript:alert(1)')).toThrow(/http/);
    expect(() => normalizeBaseUrl('https://u:p@example.com')).toThrow(/credenciais/);
    expect(() => normalizeBaseUrl('https://example.com/sub')).toThrow(/caminho/);
  });

  it('preserva a instalação de origem única quando as novas URLs não são definidas', () => {
    expect(config.appUrl).toBe('http://localhost:8080');
    expect(config.baseUrl).toBe(config.appUrl);
    expect(config.publicUrl).toBe(config.appUrl);
    expect(config.docsUrl).toBe(config.appUrl);
    expect(config.mcpUrl).toBe(config.appUrl);
    expect(config.trustProxyHops).toBe(0);
    expect(config.transcribeFallbackProvider).toBe('none');
    expect(config.transcribeSendMeetingContext).toBe(false);
    expect(config.minutesEnabled).toBe('false');
    expect(config.openrouterSiteUrl).toBe('');
  });

  it('resolve a topologia separada com a precedência documentada', () => {
    expect(() =>
      resolveConfiguredOrigins(
        { BASE_URL: 'https://fallback.example', APP_URL: 'https://app.example.com' },
        'http://localhost:8080',
      ),
    ).toThrow(/origens diferentes/);

    expect(
      resolveConfiguredOrigins(
        {
          APP_URL: 'https://app.example.com',
          PUBLIC_URL: 'https://kassinao.cloud',
          DOCS_URL: 'https://docs.kassinao.cloud',
          MCP_URL: 'https://mcp.example.com',
        },
        'http://localhost:8080',
      ),
    ).toEqual({
      appUrl: 'https://app.example.com',
      publicUrl: 'https://kassinao.cloud',
      docsUrl: 'https://docs.kassinao.cloud',
      mcpUrl: 'https://mcp.example.com',
    });

    expect(
      resolveConfiguredOrigins(
        { BASE_URL: 'https://single.example', PUBLIC_URL: 'https://site.example' },
        'http://localhost:8080',
      ),
    ).toEqual({
      appUrl: 'https://single.example',
      publicUrl: 'https://site.example',
      docsUrl: 'https://site.example',
      mcpUrl: 'https://single.example',
    });
  });

  it('rejeita segredos HMAC curtos', () => {
    expect(() => validateSecret('COOKIE_SECRET', 'curto')).toThrow(/ao menos 32 bytes/);
    expect(validateSecret('COOKIE_SECRET', '0123456789abcdef0123456789abcdef')).toHaveLength(32);
  });

  it('rejeita segredo de webhook reutilizado de outra credencial', () => {
    const shared = '0123456789abcdef0123456789abcdef';
    expect(() => validateDedicatedSecret('MINUTES_WEBHOOK_SECRET', shared, [['COOKIE_SECRET', shared]])).toThrow(
      /não pode ser igual a COOKIE_SECRET/,
    );
    expect(validateDedicatedSecret('MINUTES_WEBHOOK_SECRET', `${shared}-dedicado`, [['COOKIE_SECRET', shared]])).toBe(
      `${shared}-dedicado`,
    );
  });
});

describe('regressões de privacidade e acessibilidade da web', () => {
  it('backup nunca empacota segredos nem registros de sessão', () => {
    const script = fs.readFileSync(path.join(process.cwd(), 'scripts', 'backup.sh'), 'utf8');
    expect(script).toContain("--exclude='*/.cookie-secret'");
    expect(script).toContain("--exclude='*/.instance-id'");
    expect(script).toContain("--exclude='*/.web-sessions.json'");
    expect(script).toContain("--exclude='*/.mcp-sessions.json'");
    expect(script).toContain("--exclude='*/web-sessions.json'");
    expect(script).toContain("--exclude='*/mcp-sessions.json'");
    expect(script).toContain('AUTH_STATE_DIR precisa ser exatamente KASSINAO_DATA_ROOT/auth');
    expect(script).toContain('-C "$DATA_REAL" ./recordings ./state');
  });

  it('landing pública expõe apenas destinos públicos e rotula o exemplo', () => {
    const html = landingPage('pt');
    expect(html).not.toContain('href="/app');
    expect(html).not.toContain('/app/rec/');
    expect(html).not.toContain('/auth/login');
    expect(html).toContain('href="http://localhost:8080/demo"');
    expect(html).toContain('Demo pública com dados fictícios e IA habilitada, sem login.');
    expect(html).not.toContain('Entrar');
    expect(html).toContain('href="http://localhost:8080/docs#mcp"');
    expect(html).toContain('https://github.com/resolvicomai/kassinao');
    expect(html).toContain('/assets/discord-demo-pt-v2.webm');
    expect(html).toContain('/assets/meeting-demo-pt.png');
    expect(html).toContain('/assets/producthunt.svg');
    expect(html).toContain(
      'href="https://www.producthunt.com/products/kassinao?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-kassinao"',
    );
    expect(html).toContain('--accent: #5865f2');
    expect(html).not.toContain('#c53f28');
    expect(html).toContain('href="http://localhost:8080/en"');
    expect(html).not.toMatch(/[—–]/u);
  });

  it('landing inglesa traduz a jornada inteira sem trocar os destinos públicos', () => {
    const html = landingPage('en');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("Your call ends. The decisions don't disappear.");
    expect(html).toContain('The voice stream already has an account.');
    expect(html).toContain('Ask later. Get the source.');
    expect(html).toContain('Your instance. Your history. Your rules.');
    expect(html).toContain('Run it on your infrastructure. Keep control.');
    expect(html).toContain('/assets/discord-demo-en-v2.webm');
    expect(html).toContain('/assets/meeting-demo-en.png');
    expect(html).not.toContain('Sua call termina. As decisões não somem.');
    expect(html).not.toContain('href="/app');
    expect(html).not.toMatch(/[—–]/u);
  });

  it('demo visual do Discord usa comandos reais e possui versões PT e EN', () => {
    const pt = discordDemoPage('pt', 4);
    const en = discordDemoPage('en', 4);
    expect(pt).toContain('/gravar');
    expect(pt).toContain('/parar');
    expect(pt).toContain('/perguntar');
    expect(pt).toContain('Nebula Lab');
    expect(pt).toContain('demo fictícia');
    expect(en).toContain('/record');
    expect(en).toContain('/stop');
    expect(en).toContain('/ask');
    expect(en).toContain('Nebula Lab');
    expect(en).toContain('>general</div>');
    expect(en).toContain('fictional demo');
    expect(en).not.toContain('/gravar');
    expect(en).not.toContain('>geral</div>');
    expect(en).not.toContain('Produto &amp; IA');
    expect(pt).not.toContain('Mauro');
    expect(pt).not.toContain('R$ 49');
    expect(pt).toContain('aviso genérico no canal');
    expect(pt).toContain('DM autorizada · só você');
    expect(pt).toContain('pergunta e resposta efêmeras · só você');
    expect(pt).not.toContain('Kassinão <strong>[GRAVANDO]</strong>');
    expect(pt).not.toContain('Transcrição com nomes, ata, 3 decisões e 4 tarefas.');
    expect(pt).not.toContain('Abrir reunião');
    expect(en).toContain('generic channel notice');
    expect(en).toContain('authorized DM · only you');
    expect(en).toContain('ephemeral question and reply · only you');
    expect(en).not.toContain('Kassinão <strong>[RECORDING]</strong>');
    expect(en).not.toContain('Named transcript, meeting notes, 3 decisions, and 4 action items.');
    expect(en).not.toContain('Open meeting');
  });

  it('demo pública traduz eventos automáticos e volta para a home do idioma atual', () => {
    const dir = path.join(process.cwd(), 'docs', 'example');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as RecordingMeta;
    const transcript = JSON.parse(fs.readFileSync(path.join(dir, 'transcript.json'), 'utf8'));
    const minutes = JSON.parse(fs.readFileSync(path.join(dir, 'minutes.json'), 'utf8'));
    const pt = recordingPage(meta, { live: false, canDelete: false, lang: 'pt', transcript, minutes, demo: true });
    const en = recordingPage(meta, { live: false, canDelete: false, lang: 'en', transcript, minutes, demo: true });
    expect(pt).toContain('Gravação iniciada por Priya');
    expect(pt).not.toContain('Recording started by Priya');
    expect(en).toContain('Recording started by Priya');
    expect(en).toContain('href="http://localhost:8080/en">Back home</a>');
  });

  it('app privado renderiza EN completo e preserva query ao trocar idioma', () => {
    const user: WebUser = {
      typ: 'session',
      id: 'u-en',
      name: 'English user',
      avatar: null,
      scope: 'full',
      exp: Date.now() + 60_000,
      jti: 'sid-en',
    };
    const html = recordingsIndexPage([], { user, lang: 'en' });
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<h1>My recordings</h1>');
    expect(html).toContain('<div class="sidebar-label">Private app</div>');
    expect(html).not.toContain('<div class="sidebar-label">Workspace</div>');
    expect(html).toContain('Search this part of the archive');
    expect(html).toContain('the app organizes tracks, mix, notes, and timeline events');
    expect(html).toContain('appear only if the operator enables AI');
    expect(html).toContain('data-app-locale="en"');
    expect(html).toContain('new URL(location.href)');
    expect(html).not.toContain('<h1>Minhas gravações</h1>');
  });

  it('expõe continuação explícita quando a biblioteca foi limitada por cursor', () => {
    const user: WebUser = {
      typ: 'session',
      id: 'u-page',
      name: 'Pessoa',
      avatar: null,
      scope: 'full',
      exp: Date.now() + 60_000,
      jti: 'sid-page',
    };
    const html = recordingsIndexPage([], { user, lang: 'pt', q: 'decisão', nextCursor: 'stable-token' });
    expect(html).toContain('Ver mais reuniões');
    expect(html).toContain('cursor=stable-token');
    expect(html).toContain('q=decis%C3%A3o');
  });

  it('avisa quando a transcrição não pode ser materializada com segurança', () => {
    const dir = path.join(process.cwd(), 'docs', 'example');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as RecordingMeta;
    const html = recordingPage(meta, {
      live: false,
      canDelete: false,
      lang: 'pt',
      transcriptNotice: 'A transcrição excede o limite seguro.',
    });
    expect(html).toContain('A transcrição excede o limite seguro.');
    expect(html).not.toContain(`/app/rec/${meta.id}/transcricao.md`);
  });

  it('limita nomes de participantes e silenciosos a um orçamento compartilhado', () => {
    const base = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'docs', 'example', 'meta.json'), 'utf8'),
    ) as RecordingMeta;
    const meta: RecordingMeta = {
      ...base,
      participants: Array.from({ length: 110 }, (_, index) => ({
        id: `speaker-${index}`,
        name: `Falante ${index}`,
        avatar: null,
        trackFile: `${index}.flac`,
        index,
      })),
      presence: Array.from({ length: 110 }, (_, index) => ({
        id: `silent-${index}`,
        name: `Ouvinte ${index}`,
        joinedAtMs: index,
      })),
    };

    const html = recordingPage(meta, { live: false, canDelete: false, lang: 'pt' });

    expect(html).toContain('110 participantes');
    expect(html).toContain('Falante 99');
    expect(html).not.toContain('Falante 100');
    expect(html).not.toContain('Ouvinte 0');
    expect(html).toContain('Parte do conteúdo histórico foi limitada');
  });

  it('limita coleções e pessoas da ata com aviso explícito', () => {
    const meta = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'docs', 'example', 'meta.json'), 'utf8'),
    ) as RecordingMeta;
    meta.minutes = { status: 'done' };
    const minutes = {
      resumo: 'Resumo',
      decisoes: Array.from({ length: 201 }, (_, index) => `Decisão ${index}`),
      acoes: [],
      topicos: [],
      porParticipante: Array.from({ length: 101 }, (_, index) => ({
        nome: `Pessoa da ata ${index}`,
        pontos: Array.from({ length: index === 0 ? 101 : 1 }, (__, point) => `Ponto ${index}-${point}`),
      })),
    };

    const html = recordingPage(meta, { live: false, canDelete: false, lang: 'pt', minutes });

    expect(html).toContain('Decisão 199');
    expect(html).not.toContain('Decisão 200');
    expect(html).toContain('Pessoa da ata 99');
    expect(html).not.toContain('Pessoa da ata 100');
    expect(html).toContain('Ponto 0-99');
    expect(html).not.toContain('Ponto 0-100');
    expect(html).toContain('Parte da ata foi limitada');
  });

  it('abas associam controles/painéis e implementam teclado', () => {
    const dir = path.join(process.cwd(), 'docs', 'example');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as RecordingMeta;
    const transcript = JSON.parse(fs.readFileSync(path.join(dir, 'transcript.json'), 'utf8'));
    const minutes = JSON.parse(fs.readFileSync(path.join(dir, 'minutes.json'), 'utf8'));
    const html = recordingPage(meta, { live: false, canDelete: false, lang: 'pt', transcript, minutes, demo: true });
    expect(html).toContain('id="tab-ata"');
    expect(html).toContain('aria-controls="ata"');
    expect(html).toContain('aria-labelledby="tab-ata"');
    expect(html).toContain("e.key === 'ArrowRight'");
    expect(html).toContain('tabindex="-1"');
  });

  it('estado ao vivo mantém o mapa da reunião e não oferece downloads bloqueados pelo servidor', () => {
    const dir = path.join(process.cwd(), 'docs', 'example');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as RecordingMeta;
    meta.status = 'recording';
    delete meta.endedAt;
    meta.transcription = { status: 'running' };
    meta.minutes = { status: 'pending' };
    const html = recordingPage(meta, { live: true, canDelete: true, lang: 'pt' });
    expect(html).toContain('id="tab-ata"');
    expect(html).toContain('id="tab-transcricao"');
    expect(html).toContain('id="tab-timeline"');
    expect(html).toContain('id="tab-notas"');
    expect(html).toContain('id="tab-exportar"');
    expect(html).toContain('Arquivos disponíveis ao encerrar');
    expect(html).toContain('Notas e linha do tempo já ficam registradas');
    expect(html).toContain('a transcrição e a ata entram no mesmo lugar');
    expect(html).not.toContain('O áudio, a transcrição e a ata aparecem aqui depois que a call terminar.');
    expect(html).not.toContain('/app/rec/' + meta.id + '/download/');
    expect(html).not.toContain('action="/app/rec/' + meta.id + '/delete"');
    expect(html).toContain('function check()');
    expect(html).toContain('setTimeout(check,interval)');
    expect(html).toContain('!p.paused&&!p.ended');
  });

  it('ações POST mostram estado de envio e bloqueiam clique duplo depois da confirmação', () => {
    const dir = path.join(process.cwd(), 'docs', 'example');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as RecordingMeta;
    const html = recordingPage(meta, { live: false, canDelete: true, lang: 'pt' });

    expect(html).toContain(`action="/app/rec/${meta.id}/liberar-audio"`);
    expect(html).toContain('e.submitter');
    expect(html).toContain("button.setAttribute('aria-busy','true')");
    expect(html).toContain('button.disabled=true');
    expect(html).toContain("window.addEventListener('pageshow'");
    expect(html).toContain('if(event.persisted)');
    expect(html).toContain('location.replace(restore)');
    expect(html).toContain('else location.reload()');
    expect(html).toContain('data-submit-busy');
  });

  it('depois de liberar o áudio confirma o sucesso, mantém a memória e remove a ação repetida', () => {
    const dir = path.join(process.cwd(), 'docs', 'example');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as RecordingMeta;
    meta.audioDeleted = true;
    const html = recordingPage(meta, {
      live: false,
      canDelete: true,
      lang: 'pt',
      flash: 'Espaço liberado — o áudio foi apagado; transcrição, ata e notas continuam.',
    });

    expect(html).toContain('role="status"');
    expect(html).toContain('Espaço liberado');
    expect(html).toContain('O áudio já foi liberado');
    expect(html).not.toContain(`action="/app/rec/${meta.id}/liberar-audio"`);
    expect(html).toContain(`action="/app/rec/${meta.id}/delete"`);
  });

  it('player e downloads expõem progresso e erro sem deixar a pessoa numa ação muda', () => {
    const dir = path.join(process.cwd(), 'docs', 'example');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as RecordingMeta;
    const html = recordingPage(meta, { live: false, canDelete: true, lang: 'pt' });

    expect(html).toContain('id="kplayer-status"');
    expect(html).toContain('data-loading="Carregando áudio…"');
    expect(html).toContain('data-error="Não foi possível carregar o áudio.');
    expect(html).not.toContain("player.addEventListener('loadstart'");
    expect(html).toContain("player.addEventListener('play'");
    expect(html).toContain("player.addEventListener('waiting'");
    expect(html).toContain("player.addEventListener('error'");
    expect(html).toContain("error.name === 'NotAllowedError'");
    expect(html).toContain("error.name === 'AbortError'");
    expect(html).toContain('data-download');
    expect(html).toContain('data-download-heavy');
    expect(html).toContain('id="kdownload-status"');
    expect(html).toContain('Preparando o download…');
    expect(html).toContain("if(link.getAttribute('aria-busy')==='true'){event.preventDefault();return;}");
    expect(html).toContain('token!==downloadFeedback');
    expect(html).toContain('O download foi solicitado e pode continuar sendo preparado.');
  });

  it('atualiza e expira o feedback de cada tentativa de copiar o código MCP', () => {
    const html = connectPage({
      lang: 'pt',
      user: {
        typ: 'session',
        id: 'copy-user',
        name: 'Pessoa',
        avatar: null,
        scope: 'full',
        exp: Date.now() + 60_000,
        jti: 'copy-user-session',
      },
      exchangeCode: 'codigo-descartavel',
      label: 'Notebook',
    });

    expect(html).toContain('var copyFeedback=0');
    expect(html).toContain("status.textContent='Copiando…'");
    expect(html).toContain('token===copyFeedback');
    expect(html).toContain('var stateTimer=null');
    expect(html).toContain('delete b.dataset.copyState');
    expect(html).toContain("status.textContent=''");
  });

  it('só mostra o repositório configurado na sidebar privada quando REPO_PUBLIC está ligado', () => {
    const originalRepoPublic = config.repoPublic;
    const originalSourceUrl = config.sourceUrl;
    const user: WebUser = {
      typ: 'session',
      id: 'source-link-user',
      name: 'Pessoa',
      avatar: null,
      scope: 'full',
      exp: Date.now() + 60_000,
      jti: 'source-link-session',
    };

    try {
      config.repoPublic = false;
      config.sourceUrl = 'https://github.com/example/private-fork';
      expect(connectPage({ lang: 'pt', user, sessions: [] })).not.toContain(
        'href="https://github.com/example/private-fork"',
      );

      config.repoPublic = true;
      const visible = connectPage({ lang: 'pt', user, sessions: [] });
      expect(visible).toContain('href="https://github.com/example/private-fork"');
      expect(visible).not.toContain('href="https://github.com/resolvicomai/kassinao"');
    } finally {
      config.repoPublic = originalRepoPublic;
      config.sourceUrl = originalSourceUrl;
    }
  });

  it('isola retry, feedback e reset dos dois botões de cópia MCP em runtime', async () => {
    const html = connectPage({
      lang: 'pt',
      user: {
        typ: 'session',
        id: 'copy-runtime-user',
        name: 'Pessoa',
        avatar: null,
        scope: 'full',
        exp: Date.now() + 60_000,
        jti: 'copy-runtime-session',
      },
      exchangeCode: 'codigo-descartavel',
      label: 'Notebook',
    });
    const script = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi), (match) => match[1]).find(
      (candidate) => candidate.includes("wire('kcopycode','kcode')"),
    );
    if (!script) throw new Error('Script de cópia MCP não encontrado.');

    type RuntimeListener = () => void;
    function runtimeElement(textContent = '') {
      const attributes = new Map<string, string>();
      const listeners = new Map<string, RuntimeListener>();
      return {
        attributes,
        listeners,
        dataset: {} as Record<string, string>,
        disabled: false,
        textContent,
        focus: vi.fn(),
        addEventListener(type: string, listener: RuntimeListener) {
          listeners.set(type, listener);
        },
        setAttribute(name: string, value: string) {
          attributes.set(name, value);
        },
        removeAttribute(name: string) {
          attributes.delete(name);
        },
      };
    }

    const copyCode = runtimeElement('Copiar código');
    const copyCommand = runtimeElement('Copiar comando');
    const code = runtimeElement('codigo-descartavel');
    const command = runtimeElement('npx kassinao-mcp connect');
    const status = runtimeElement();
    const elements: Record<string, ReturnType<typeof runtimeElement>> = {
      kcopycode: copyCode,
      kcopy: copyCommand,
      kcode: code,
      kcfg: command,
      'kcopy-status': status,
    };
    const fallbackArea = {
      value: '',
      style: {} as Record<string, string>,
      setAttribute: vi.fn(),
      select: vi.fn(),
      remove: vi.fn(),
    };
    const execCommand = vi.fn(() => false);
    const timers = new Map<number, { callback: () => void; delay: number }>();
    const scheduledTimerIds: number[] = [];
    let nextTimerId = 1;
    const setTimeout = (callback: () => void, delay: number) => {
      const id = nextTimerId++;
      timers.set(id, { callback, delay });
      scheduledTimerIds.push(id);
      return id;
    };
    const clearTimeout = (id: number | null) => {
      if (id !== null) timers.delete(id);
    };
    const writeText = vi
      .fn<(value: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('clipboard indisponível'))
      .mockResolvedValue(undefined);
    const selection = { removeAllRanges: vi.fn(), addRange: vi.fn() };
    const document = {
      body: { appendChild: vi.fn() },
      createElement: () => fallbackArea,
      createRange: () => ({ selectNodeContents: vi.fn() }),
      execCommand,
      getElementById: (id: string) => elements[id] ?? null,
    };
    const window = {
      addEventListener: vi.fn(),
      getSelection: () => selection,
    };

    vm.runInNewContext(script, {
      clearTimeout,
      document,
      navigator: { clipboard: { writeText } },
      setTimeout,
      window,
    });

    const settle = async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    const clickCode = copyCode.listeners.get('click');
    const clickCommand = copyCommand.listeners.get('click');
    if (!clickCode || !clickCommand) throw new Error('Listeners de cópia MCP não instalados.');

    clickCode();
    await settle();
    expect(copyCode.dataset.copyState).toBe('error');
    expect(copyCode.disabled).toBe(false);

    clickCode();
    expect(copyCode.dataset.copyState).toBeUndefined();
    expect(copyCode.attributes.get('aria-busy')).toBe('true');
    expect(status.textContent).toBe('Copiando…');
    await settle();
    expect(copyCode.dataset.copyState).toBe('done');
    expect(copyCode.textContent).toBe('Copiado');
    expect(copyCode.disabled).toBe(true);

    const [firstStateTimer, firstStatusTimer] = scheduledTimerIds.slice(-2);
    expect(timers.get(firstStateTimer)?.delay).toBe(2_000);
    expect(timers.get(firstStatusTimer)?.delay).toBe(2_000);

    clickCommand();
    expect(timers.has(firstStateTimer)).toBe(true);
    expect(timers.has(firstStatusTimer)).toBe(false);
    await settle();
    expect(copyCommand.dataset.copyState).toBe('done');
    expect(copyCommand.textContent).toBe('Copiado');

    timers.get(firstStateTimer)?.callback();
    expect(copyCode.textContent).toBe('Copiar código');
    expect(copyCode.dataset.copyState).toBeUndefined();
    expect(copyCode.disabled).toBe(false);

    const [secondStateTimer, secondStatusTimer] = scheduledTimerIds.slice(-2);
    timers.get(secondStateTimer)?.callback();
    timers.get(secondStatusTimer)?.callback();
    expect(copyCommand.textContent).toBe('Copiar comando');
    expect(copyCommand.dataset.copyState).toBeUndefined();
    expect(copyCommand.disabled).toBe(false);
    expect(status.textContent).toBe('');
    expect(writeText).toHaveBeenCalledTimes(3);
  });

  it('preserva busca e falantes desligados quando o processamento recarrega a gravação', () => {
    const dir = path.join(process.cwd(), 'docs', 'example');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as RecordingMeta;
    const transcript = [
      { speaker: 'Alice', startMs: 0, endMs: 1_000, text: 'Primeiro trecho' },
      { speaker: 'Bob', startMs: 1_100, endMs: 2_000, text: 'Segundo trecho' },
    ];
    const html = recordingPage(meta, { live: false, canDelete: false, lang: 'pt', transcript });

    expect(html).toContain('sessionStorage.setItem(filterKey');
    expect(html).toContain('sessionStorage.getItem(filterKey)');
    expect(html).toContain('state.off.indexOf(c.dataset.sp)');
    expect(html).toContain('input.value=state.q');
  });

  it('falha de cópia oferece fallback e feedback visível no app e no conector', () => {
    const dir = path.join(process.cwd(), 'docs', 'example');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as RecordingMeta;
    const minutes = {
      resumo: 'Resumo',
      decisoes: [],
      acoes: [{ tarefa: 'Enviar proposta' }],
      topicos: [],
      porParticipante: [],
    };
    meta.minutes = { status: 'done' };
    const recording = recordingPage(meta, { live: false, canDelete: false, lang: 'pt', minutes });
    expect(recording).toContain("document.execCommand('copy')");
    expect(recording).toContain('var timer=setTimeout(function()');
    expect(recording).toContain('clearTimeout(timer)');
    expect(recording).toContain('legacyCopy(value).then(resolve,reject)');
    expect(recording).toContain('Não foi possível copiar');
    expect(recording).toContain('delete cp.dataset.copyState;cp.disabled=false;');

    const user: WebUser = {
      typ: 'session',
      id: 'copy-user',
      name: 'Alice',
      avatar: null,
      scope: 'full',
      exp: Date.now() + 60_000,
      jti: 'copy-session',
    };
    const connector = connectPage({ lang: 'pt', user, exchangeCode: 'one-time-code' });
    expect(connector).toContain("document.execCommand('copy')");
    expect(connector).toContain('var timer=setTimeout(function()');
    expect(connector).toContain('clearTimeout(timer)');
    expect(connector).toContain('legacyCopy(value).then(resolve,reject)');
    expect(connector).toContain('Não consegui copiar. Selecione o texto manualmente.');
    expect(connector).toContain('aria-live="polite"');
    expect(connector).toContain('delete b.dataset.copyState;b.disabled=false;');
  });

  it('página de erro pode voltar ao contexto da ação sem aceitar URL externa', () => {
    const user: WebUser = {
      typ: 'session',
      id: 'context-user',
      name: 'Alice',
      avatar: null,
      scope: 'full',
      exp: Date.now() + 60_000,
      jti: 'context-session',
    };
    const contextual = messagePage('Erro', 'Falhou', user, 'pt', {
      backHref: '/app/rec/meeting-1#exportar',
      backLabel: 'Voltar à gravação',
      active: 'rec',
    });
    expect(contextual).toContain('href="/app/rec/meeting-1#exportar"');
    expect(contextual).toContain('data-restore-href="/app/rec/meeting-1#exportar"');
    expect(contextual).toContain('Voltar à gravação');

    const unsafe = messagePage('Erro', 'Falhou', user, 'pt', { backHref: 'https://evil.example' });
    expect(unsafe).toContain('href="/app"');
    expect(unsafe).not.toContain('evil.example');
  });

  it('não revela corpo, credenciais ou detalhes crus do provedor na página da gravação', () => {
    const dir = path.join(process.cwd(), 'docs', 'example');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as RecordingMeta;
    const providerError = 'HTTP 500: upstream failed at /internal/provider?api_key=sk-super-secret';
    meta.transcription = { status: 'error', error: providerError };
    meta.minutes = { status: 'error', error: providerError };

    const html = recordingPage(meta, { live: false, canDelete: false, lang: 'pt' });

    expect(html).not.toContain(providerError);
    expect(html).not.toContain('sk-super-secret');
    expect(html).not.toContain('detalhes técnicos');
    expect(html).toContain('o serviço de IA encontrou um erro interno');
  });

  it('canais com o mesmo nome em servidores diferentes têm filtros independentes', () => {
    const dir = path.join(process.cwd(), 'docs', 'example');
    const base = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as RecordingMeta;
    const first = structuredClone(base);
    first.id = 'same-name-a';
    first.guildId = 'guild-a';
    first.guildName = 'Servidor A';
    first.voiceChannelId = 'channel-a';
    first.voiceChannelName = 'geral';
    const second = structuredClone(base);
    second.id = 'same-name-b';
    second.guildId = 'guild-b';
    second.guildName = 'Servidor B';
    second.voiceChannelId = 'channel-b';
    second.voiceChannelName = 'geral';
    const user: WebUser = {
      typ: 'session',
      id: 'u-filter',
      name: 'Alice',
      avatar: null,
      scope: 'full',
      exp: Date.now() + 60_000,
      jti: 'sid-filter',
    };
    const html = recordingsIndexPage(
      [
        { meta: first, canDelete: false },
        { meta: second, canDelete: false },
      ],
      { user, lang: 'pt' },
    );
    expect(html).toContain('data-ch="guild-a:channel-a"');
    expect(html).toContain('data-ch="guild-b:channel-b"');
    expect(html).toContain('#geral · Servidor A');
    expect(html).toContain('#geral · Servidor B');
  });

  it('não oferece troca de idioma nem põe refresh token no estado do código MCP', () => {
    const user: WebUser = {
      typ: 'session',
      id: 'u-token',
      name: 'Alice',
      avatar: null,
      scope: 'full',
      exp: Date.now() + 60_000,
      jti: 'sid-token',
    };
    const html = connectPage({
      lang: 'pt',
      user,
      exchangeCode: 'preview-one-time-code',
      label: 'Assistente local',
    });
    expect(html).toContain('Use este código agora.');
    expect(html).toContain('preview-one-time-code');
    expect(html).toContain('exchange --stdin --url');
    expect(html).not.toContain('exchange preview-one-time-code');
    expect(html).not.toContain('KASSINAO_REFRESH_TOKEN');
    expect(html).not.toContain('data-app-locale');
    expect(html).toContain('data-restore-href="/app/conectar-ia"');
    expect(html).toContain("window.addEventListener('pagehide'");
    expect(html).toContain("['kcode','kcfg']");
  });

  it('logout do app é POST protegido, nunca link GET mutável', () => {
    const dir = path.join(process.cwd(), 'docs', 'example');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as RecordingMeta;
    const html = recordingPage(meta, {
      live: false,
      canDelete: false,
      lang: 'pt',
      user: {
        typ: 'session',
        id: 'u1',
        name: 'Alice',
        avatar: null,
        scope: 'full',
        exp: Date.now() + 60_000,
        jti: 'sid',
      },
    });
    expect(html).toContain('method="post" action="/app/logout"');
    expect(html).toContain('<span class="mobile-logout"><form class="logout-form"');
    expect(html).not.toContain('href="/auth/logout"');
  });
});

describe('filtro de participante da API MCP', () => {
  const meta = {
    startedBy: { id: 'starter', name: 'S' },
    participants: [{ id: 'speaker', name: 'P' }],
    presence: [{ id: 'silent', name: 'M' }],
  } as RecordingMeta;

  it('inclui quem iniciou, falou ou esteve mutado; exclui estranho', () => {
    expect(recordingIncludesUser(meta, 'starter')).toBe(true);
    expect(recordingIncludesUser(meta, 'speaker')).toBe(true);
    expect(recordingIncludesUser(meta, 'silent')).toBe(true);
    expect(recordingIncludesUser(meta, 'other')).toBe(false);
  });

  it('normaliza busca e elimina consultas vazias depois de remover acentos', () => {
    expect(normalizedSearchTerms('  Orçamento   Q3 ')).toEqual(['orcamento', 'q3']);
    expect(normalizedSearchTerms('\u0301')).toEqual([]);
  });
});
