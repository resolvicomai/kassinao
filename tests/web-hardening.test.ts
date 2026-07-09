import type { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeBaseUrl, parseConfiguredNumber, validateSecret } from '../src/config';
import { beginLogin, isAllowedWebMutation, logoutWeb } from '../src/web/auth';
import { landingPage } from '../src/web/landing';
import { recordingPage } from '../src/web/page';
import { normalizedSearchTerms, recordingIncludesUser } from '../src/web/api';
import type { RecordingMeta } from '../src/store';
import { isLoopbackAddress } from '../src/util';

function fakeRequest(method: string, headers: Record<string, string> = {}): Request {
  return {
    method,
    get(name: string) {
      return headers[name.toLowerCase()];
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

describe('cookies e CSRF da superfície web privada', () => {
  it('state fica em /auth e logout apaga sessão nova + legado', () => {
    const login = cookieResponse();
    beginLogin(login.res, '/app');
    expect(login.cookies.some((c) => c.includes('kassinao_state=') && c.includes('Path=/auth;'))).toBe(true);

    const logout = cookieResponse();
    logoutWeb(logout.res);
    expect(logout.cookies.some((c) => c.includes('kassinao_session=') && c.includes('Path=/app;'))).toBe(true);
    expect(logout.cookies.some((c) => c.includes('kassinao_session=') && c.includes('Path=/;'))).toBe(true);
  });

  it('aceita a origem exata e rejeita subdomínio irmão/cross-site', () => {
    const base = 'https://kassinao.example.com';
    expect(isAllowedWebMutation(fakeRequest('POST', { origin: base }), base)).toBe(true);
    expect(isAllowedWebMutation(fakeRequest('POST', { origin: 'https://evil.example.com' }), base)).toBe(false);
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
    expect(() => normalizeBaseUrl('javascript:alert(1)')).toThrow(/http/);
    expect(() => normalizeBaseUrl('https://u:p@example.com')).toThrow(/credenciais/);
    expect(() => normalizeBaseUrl('https://example.com/sub')).toThrow(/caminho/);
  });

  it('rejeita segredos HMAC curtos', () => {
    expect(() => validateSecret('COOKIE_SECRET', 'curto')).toThrow(/ao menos 32 bytes/);
    expect(validateSecret('COOKIE_SECRET', '0123456789abcdef0123456789abcdef')).toHaveLength(32);
  });
});

describe('regressões de privacidade e acessibilidade da web', () => {
  it('landing pública não contém URL privada e rotula os fixtures', () => {
    const html = landingPage('pt');
    expect(html).not.toContain('href="/app');
    expect(html).not.toContain('/app/rec/');
    expect(html).toContain('/auth/login?next=%2Fapp');
    expect((html.match(/exemplo fictício/g) ?? []).length).toBeGreaterThanOrEqual(4);
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
