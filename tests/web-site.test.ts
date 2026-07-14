import { describe, expect, it } from 'vitest';
import {
  alternateLocale,
  localeCookie,
  localeFromAcceptLanguage,
  localeFromCookie,
  mcpDiscoveryUrl,
  publicPath,
  publicRoutePath,
  publicSite,
  publicSurfaceUrl,
  resolveWebLocale,
  withLocale,
} from '../src/web/site';

describe('arquitetura compartilhada de idioma e rotas web', () => {
  it('mapeia cada superfície pública para uma URL canônica em PT e EN', () => {
    expect(publicPath('home', 'pt')).toBe('/');
    expect(publicPath('home', 'en')).toBe('/en');
    expect(publicPath('docs', 'pt')).toBe('/docs');
    expect(publicPath('docs', 'en')).toBe('/en/docs');
    expect(publicPath('demo', 'pt')).toBe('/demo');
    expect(publicPath('demo', 'en')).toBe('/en/demo');
    expect(alternateLocale('pt')).toBe('en');
    expect(alternateLocale('en')).toBe('pt');
  });

  it('entrega um contexto completo para cada renderer público', () => {
    const site = publicSite('demo', 'en', 'https://kassinao.example.com/');
    expect(site.htmlLang).toBe('en');
    expect(site.canonicalPath).toBe('/en/demo');
    expect(site.canonicalUrl).toBe('https://kassinao.example.com/en/demo');
    expect(site.links).toMatchObject({
      home: 'https://kassinao.example.com/en',
      docs: 'https://kassinao.example.com/en/docs',
      demo: 'https://kassinao.example.com/en/demo',
      alternate: 'https://kassinao.example.com/demo',
    });
    expect(site.links.mcp).toBe('https://kassinao.example.com/en/docs#mcp');
    expect(site.cookie(true)).toContain('kassinao_lang=en');
  });

  it('separa landing, docs e MCP sem quebrar a topologia de origem única', () => {
    const topology = {
      appUrl: 'https://app.kassinao.cloud',
      publicUrl: 'https://kassinao.cloud',
      docsUrl: 'https://docs.kassinao.cloud',
      mcpUrl: 'https://mcp.kassinao.cloud',
    };

    expect(publicRoutePath('docs', 'pt', topology)).toBe('/');
    expect(publicRoutePath('docs', 'en', topology)).toBe('/en');
    expect(publicSurfaceUrl('home', 'pt', topology)).toBe('https://kassinao.cloud/');
    expect(publicSurfaceUrl('demo', 'en', topology)).toBe('https://kassinao.cloud/en/demo');
    expect(publicSurfaceUrl('docs', 'pt', topology)).toBe('https://docs.kassinao.cloud/');
    expect(publicSurfaceUrl('docs', 'en', topology)).toBe('https://docs.kassinao.cloud/en');
    expect(mcpDiscoveryUrl(topology, 'pt')).toBe('https://mcp.kassinao.cloud/');
    expect(mcpDiscoveryUrl(topology, 'en')).toBe('https://mcp.kassinao.cloud/en');
    expect(publicSite('home', 'en', topology).links.mcp).toBe('https://mcp.kassinao.cloud/en');
  });

  it('resolve idioma por escolha explícita, cookie, navegador e fallback nessa ordem', () => {
    expect(resolveWebLocale({ query: 'en', cookie: 'kassinao_lang=pt', acceptLanguage: 'pt-BR' })).toBe('en');
    expect(resolveWebLocale({ cookie: 'foo=1; kassinao_lang=pt; bar=2', acceptLanguage: 'en-US' })).toBe('pt');
    expect(resolveWebLocale({ acceptLanguage: 'pt-BR,pt;q=0.9,en;q=0.8' })).toBe('pt');
    expect(resolveWebLocale({ acceptLanguage: 'fr-FR,en-US;q=0.8', fallback: 'pt' })).toBe('en');
    expect(resolveWebLocale({ acceptLanguage: 'fr-FR', fallback: 'pt' })).toBe('pt');
  });

  it('lê cookie e Accept-Language sem confundir valores inválidos', () => {
    expect(localeFromCookie('other=pt; kassinao_lang=en')).toBe('en');
    expect(localeFromCookie('kassinao_lang=es')).toBeUndefined();
    expect(localeFromAcceptLanguage('en-GB,en;q=0.9,pt;q=0.8')).toBe('en');
    expect(localeFromAcceptLanguage('de-DE,pt-BR;q=0.9')).toBe('pt');
    expect(localeFromAcceptLanguage('pt-BR;q=0.1,en-US;q=0.9')).toBe('en');
  });

  it('gera cookie persistente e links privados que preservam parâmetros úteis', () => {
    expect(localeCookie('pt', false)).toBe('kassinao_lang=pt; Path=/; Max-Age=31536000; SameSite=Lax');
    expect(localeCookie('en', true)).toContain('; Secure');
    expect(withLocale('/app', 'en', { q: 'pricing', sort: 'oldest' })).toBe('/app?q=pricing&sort=oldest&lang=en');
  });
});
