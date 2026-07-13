import { describe, expect, it } from 'vitest';
import { revenueLandingPage } from '../src/web/revenueLanding';

describe('landing revenue-centric isolada', () => {
  it('leva do problema à prova, qualificação e ação', () => {
    const html = revenueLandingPage('pt');
    const journey = [
      'A call termina.',
      'O áudio guarda a conversa.',
      'Uma faixa por pessoa transforma gravação em contexto.',
      'Pergunte à reunião e volte ao trecho exato.',
      'Acesso segue o contexto da call.',
      'Foi feito para o seu servidor?',
      'Perguntas antes de subir a instância.',
      'Pare de deixar decisões presas no áudio.',
    ].map((copy) => html.indexOf(copy));

    expect(journey.every((index) => index >= 0)).toBe(true);
    expect(journey).toEqual([...journey].sort((a, b) => a - b));
  });

  it('usa prova concreta e mantém gravações reais fora da vitrine', () => {
    for (const html of [revenueLandingPage('pt'), revenueLandingPage('en')]) {
      expect(html).toContain('https://github.com/resolvicomai/kassinao');
      expect(html).toContain('https://www.npmjs.com/package/kassinao-mcp');
      expect(html).toMatch(/href="\/demo\?lang=(?:pt|en)"/);
      expect(html).not.toContain('href="/app');
      expect(html).not.toContain('/auth/login');
      expect(html).not.toContain('href="/rec/');
      expect(html).not.toContain('100% preciso');
      expect(html).not.toContain('100% accurate');
      expect(html).not.toContain('LGPD compliant');
      expect(html).not.toMatch(/[—–]/u);
    }
  });

  it('entrega identidade própria, imagens originais e acessibilidade básica', () => {
    const html = revenueLandingPage('pt');
    expect(html).toContain('--accent:#c13b25');
    expect(html).toContain("url('/assets/archivo.woff2')");
    expect(html).toContain('/assets/kassinao-revenue-hero.webp');
    expect(html).toContain('/assets/kassinao-revenue-after-call.webp');
    expect(html).toContain('prefers-color-scheme:dark');
    expect(html).toContain('prefers-reduced-motion:reduce');
    expect(html).toContain('IntersectionObserver');
    expect(html).toContain('class="skip"');
    expect(html).toContain('fetchpriority="high"');
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).not.toContain("addEventListener('scroll'");
  });

  it('localiza proposta, metadados e CTAs sem misturar idiomas', () => {
    const pt = revenueLandingPage('pt');
    const en = revenueLandingPage('en');
    expect(pt).toContain('<html lang="pt-BR">');
    expect(pt).toContain('Demo pública com dados fictícios, sem login.');
    expect(pt).toContain('/og-pt.png');
    expect(pt).not.toContain('The call ends.');
    expect(en).toContain('<html lang="en">');
    expect(en).toContain('Public demo with fictional data, no login.');
    expect(en).toContain('/og-en.png');
    expect(en).not.toContain('A call termina.');
  });

  it('expõe limites e custos sem transformar self-hosting em promessa falsa', () => {
    const pt = revenueLandingPage('pt');
    const en = revenueLandingPage('en');
    expect(pt).toContain('Self-hosted não significa que nenhum dado sai do servidor.');
    expect(pt).toContain('Hospedagem, domínio e provedores externos podem gerar custos.');
    expect(pt).toContain('uma gravação por servidor');
    expect(pt).toContain('até 25 faixas');
    expect(en).toContain('Self-hosted does not mean data can never leave the server.');
    expect(en).toContain('Hosting, domains, and external providers may have costs.');
    expect(en).toContain('one recording per server');
    expect(en).toContain('up to 25 participant tracks');
  });
});
