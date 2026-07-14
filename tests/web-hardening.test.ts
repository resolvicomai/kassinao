import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  config,
  normalizeBaseUrl,
  normalizeOrigin,
  parseConfiguredNumber,
  resolveConfiguredOrigins,
  validateSecret,
} from '../src/config';
import { beginLogin, getWebUser, isAllowedWebMutation, logoutWeb, WebUser } from '../src/web/auth';
import { discordDemoPage } from '../src/web/discordDemo';
import { landingPage } from '../src/web/landing';
import { connectPage, recordingPage, recordingsIndexPage } from '../src/web/page';
import { normalizedSearchTerms, recordingIncludesUser } from '../src/web/api';
import type { RecordingMeta } from '../src/store';
import { isLoopbackAddress } from '../src/util';
import { createWebSession, isActiveWebSession } from '../src/web/webSessions';

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
  return signedSessionRequest(user);
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

function loginState(cookies: string[]): { cookie: string; next: string } {
  const cookie = cookies.find((value) => value.startsWith('kassinao_state='));
  if (!cookie) throw new Error('cookie OAuth state ausente');
  const token = decodeURIComponent(cookie.slice('kassinao_state='.length).split(';', 1)[0]);
  const body = token.split('.', 1)[0];
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { next: string };
  return { cookie, next: payload.next };
}

describe('cookies e CSRF da superfície web privada', () => {
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
    const acceptedNext = `/${'a'.repeat(2_047)}`;
    const accepted = cookieResponse();
    beginLogin(accepted.res, acceptedNext);
    expect(loginState(accepted.cookies)).toMatchObject({ next: acceptedNext });
    expect(loginState(accepted.cookies).cookie.length).toBeLessThanOrEqual(4_096);

    const oversized = cookieResponse();
    beginLogin(oversized.res, `/${'a'.repeat(2_048)}`);
    expect(loginState(oversized.cookies)).toMatchObject({ next: '/' });
    expect(loginState(oversized.cookies).cookie.length).toBeLessThanOrEqual(4_096);
  });

  it('descarta next cujo escape JSON faria o cookie ultrapassar o limite do navegador', () => {
    const login = cookieResponse();
    beginLogin(login.res, `/${'"'.repeat(2_047)}`);

    expect(loginState(login.cookies)).toMatchObject({ next: '/' });
    expect(loginState(login.cookies).cookie.length).toBeLessThanOrEqual(4_096);
  });

  it('descarta next que o navegador poderia interpretar como redirect externo', () => {
    for (const unsafeNext of ['//evil.example', '/\\evil.example', 'https://evil.example']) {
      const login = cookieResponse();
      beginLogin(login.res, unsafeNext);
      expect(loginState(login.cookies)).toMatchObject({ next: '/' });
    }
  });

  it('logout revoga também uma cópia do cookie no servidor', () => {
    const exp = Date.now() + 60_000;
    const user: WebUser = {
      typ: 'session',
      id: 'web-user',
      name: 'Alice',
      avatar: null,
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

  it('limita sessões web por usuário para a persistência não virar DoS', () => {
    const exp = Date.now() + 60_000;
    const ids = Array.from({ length: 11 }, () => createWebSession('cap-user', exp));
    expect(isActiveWebSession(ids[0], 'cap-user')).toBe(false);
    expect(isActiveWebSession(ids[10], 'cap-user')).toBe(true);
  });

  it('prioriza a origem exata mesmo quando Fetch Metadata classifica a navegação como cross-site', () => {
    const base = 'https://app.kassinao.cloud';
    expect(isAllowedWebMutation(fakeRequest('POST', { origin: base }), base)).toBe(true);
    expect(isAllowedWebMutation(fakeRequest('POST', { origin: base, 'sec-fetch-site': 'cross-site' }), base)).toBe(
      true,
    );
  });

  it('rejeita subdomínio irmão e cross-site sem origem verificável', () => {
    const base = 'https://app.kassinao.cloud';
    expect(isAllowedWebMutation(fakeRequest('POST', { origin: 'https://kassinao.cloud' }), base)).toBe(false);
    expect(isAllowedWebMutation(fakeRequest('POST', { origin: 'https://docs.kassinao.cloud' }), base)).toBe(false);
    expect(isAllowedWebMutation(fakeRequest('POST', { origin: 'https://evil.example.com' }), base)).toBe(false);
    expect(isAllowedWebMutation(fakeRequest('POST', { origin: 'null' }), base)).toBe(false);
    expect(isAllowedWebMutation(fakeRequest('POST', { origin: 'not a url' }), base)).toBe(false);
    expect(isAllowedWebMutation(fakeRequest('POST', { 'sec-fetch-site': 'cross-site' }), base)).toBe(false);
    expect(isAllowedWebMutation(fakeRequest('POST'), base)).toBe(true); // cliente não-browser, sem cookie automático
    expect(isAllowedWebMutation(fakeRequest('GET', { origin: 'https://evil.example.com' }), base)).toBe(true);
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

  it('normaliza só origens HTTP(S), sem caminho/credencial/query', () => {
    expect(normalizeBaseUrl('https://kassinao.example.com/')).toBe('https://kassinao.example.com');
    expect(normalizeOrigin('APP_URL', 'https://app.kassinao.cloud/')).toBe('https://app.kassinao.cloud');
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
  });

  it('resolve a topologia separada com a precedência documentada', () => {
    expect(
      resolveConfiguredOrigins(
        {
          BASE_URL: 'https://fallback.example',
          APP_URL: 'https://app.kassinao.cloud',
          PUBLIC_URL: 'https://kassinao.cloud',
          DOCS_URL: 'https://docs.kassinao.cloud',
          MCP_URL: 'https://mcp.kassinao.cloud',
        },
        'http://localhost:8080',
      ),
    ).toEqual({
      appUrl: 'https://app.kassinao.cloud',
      publicUrl: 'https://kassinao.cloud',
      docsUrl: 'https://docs.kassinao.cloud',
      mcpUrl: 'https://mcp.kassinao.cloud',
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
});

describe('regressões de privacidade e acessibilidade da web', () => {
  it('backup nunca empacota segredos nem registros de sessão', () => {
    const script = fs.readFileSync(path.join(process.cwd(), 'scripts', 'backup.sh'), 'utf8');
    expect(script).toContain("--exclude='*/.cookie-secret'");
    expect(script).toContain("--exclude='*/.web-sessions.json'");
    expect(script).toContain("--exclude='*/.mcp-sessions.json'");
  });

  it('landing pública expõe apenas destinos públicos e rotula o exemplo', () => {
    const html = landingPage('pt');
    expect(html).not.toContain('href="/app');
    expect(html).not.toContain('/app/rec/');
    expect(html).not.toContain('/auth/login');
    expect(html).toContain('href="http://localhost:8080/demo"');
    expect(html).toContain('Demo pública com dados fictícios, sem login.');
    expect(html).not.toContain('Entrar');
    expect(html).toContain('href="http://localhost:8080/docs#mcp"');
    expect(html).toContain('https://github.com/resolvicomai/kassinao');
    expect(html).toContain('/assets/discord-demo-pt.webm');
    expect(html).toContain('/assets/meeting-demo-pt.png');
    expect(html).toContain('--accent: #5865f2');
    expect(html).not.toContain('#c53f28');
    expect(html).toContain('href="http://localhost:8080/en"');
    expect(html).not.toMatch(/[—–]/u);
  });

  it('landing inglesa traduz a jornada inteira sem trocar os destinos públicos', () => {
    const html = landingPage('en');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("Your call ends. The decisions don't disappear.");
    expect(html).toContain('Speaker identity is not a guess.');
    expect(html).toContain('Ask later. Get the source.');
    expect(html).toContain('Your server. Your history. Your rules.');
    expect(html).toContain('Install it on your server. Keep control.');
    expect(html).toContain('/assets/discord-demo-en.webm');
    expect(html).toContain('/assets/meeting-demo-en.png');
    expect(html).not.toContain('Sua call termina. As decisões não somem.');
    expect(html).not.toContain('href="/app');
    expect(html).not.toMatch(/[—–]/u);
  });

  it('demo visual do Discord usa comandos reais e possui versões PT e EN', () => {
    const pt = discordDemoPage('pt', 4);
    const en = discordDemoPage('en', 4);
    expect(pt).toContain('/gravar');
    expect(pt).toContain('/perguntar');
    expect(pt).toContain('demo fictícia');
    expect(en).toContain('/record');
    expect(en).toContain('/ask');
    expect(en).toContain('>general</div>');
    expect(en).toContain('fictional demo');
    expect(en).not.toContain('/gravar');
    expect(en).not.toContain('>geral</div>');
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
      exp: Date.now() + 60_000,
      jti: 'sid-en',
    };
    const html = recordingsIndexPage([], { user, lang: 'en' });
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<h1>My recordings</h1>');
    expect(html).toContain('Search this part of the archive');
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
    expect(html).not.toContain('/app/rec/' + meta.id + '/download/');
    expect(html).not.toContain('action="/app/rec/' + meta.id + '/delete"');
    expect(html).toContain('function check()');
    expect(html).toContain('setTimeout(check,interval)');
    expect(html).toContain('!p.paused&&!p.ended');
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

  it('não oferece troca de idioma no estado que exibe o token MCP uma única vez', () => {
    const user: WebUser = {
      typ: 'session',
      id: 'u-token',
      name: 'Alice',
      avatar: null,
      exp: Date.now() + 60_000,
      jti: 'sid-token',
    };
    const html = connectPage({
      lang: 'pt',
      user,
      refreshToken: 'preview-token',
      label: 'Claude',
    });
    expect(html).toContain('Copie esta configuração agora.');
    expect(html).not.toContain('data-app-locale');
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
