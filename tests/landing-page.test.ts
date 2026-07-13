import { describe, expect, it } from 'vitest';
import { landingPage } from '../src/web/landing';

describe('landing page do Kassinão', () => {
  it('conta a história completa do bot, da call à memória pesquisável', () => {
    const html = landingPage('pt');
    const order = [
      'Sua call termina. As decisões não somem.',
      'A identidade não vem de um palpite.',
      'Tudo acontece onde a call já está.',
      'Abra uma reunião pronta.',
      'Pergunte depois. Receba a fonte.',
      'Seu servidor. Seu histórico. Suas regras.',
      'Instale no seu servidor. Mantenha o controle.',
    ].map((copy) => html.indexOf(copy));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html.match(/<section/g)).toHaveLength(7);
  });

  it('mantém somente os destinos públicos pedidos', () => {
    for (const html of [landingPage('pt'), landingPage('en')]) {
      expect(html).toContain('https://github.com/resolvicomai/kassinao');
      expect(html).toMatch(/href="http:\/\/localhost:8080\/(?:en\/)?docs#mcp"/);
      expect(html).toMatch(/href="http:\/\/localhost:8080\/(?:en\/)?docs"/);
      expect(html).toMatch(/href="http:\/\/localhost:8080\/(?:en\/)?demo"/);
      expect(html).not.toContain('href="/app');
      expect(html).not.toContain('/auth/login');
      expect(html).not.toContain('Entrar');
    }
  });

  it('usa a identidade visual do Discord sem resíduos da versão conflitante', () => {
    for (const html of [landingPage('pt'), landingPage('en')]) {
      expect(html).toContain('--accent: #5865f2');
      expect(html).toContain('color-scheme: dark');
      expect(html).toContain("url('/assets/space-grotesk.woff2')");
      expect(html).toContain('/assets/discord-demo-');
      expect(html).toContain('/assets/meeting-demo-');
      expect(html).toContain('prefers-reduced-motion: reduce');
      expect(html).toContain('IntersectionObserver');
      expect(html).not.toContain('#c53f28');
      expect(html).not.toContain('hero-conversation-2026.webp');
      expect(html).not.toMatch(/[—–]/u);
    }
  });

  it('traduz toda a proposta de valor e mantém o conteúdo original da reunião explícito', () => {
    const pt = landingPage('pt');
    const en = landingPage('en');

    expect(pt).toContain('<html lang="pt-BR">');
    expect(pt).toContain('Para equipes que trabalham no Discord');
    expect(pt).toContain('Demo pública');
    expect(pt).toContain('/og-pt.png');
    expect(pt).not.toContain('For teams that work on Discord');

    expect(en).toContain('<html lang="en">');
    expect(en).toContain('For teams that work on Discord');
    expect(en).toContain("Your call ends. The decisions don't disappear.");
    expect(en).toContain('Public demo');
    expect(en).toContain('Your server. Your history. Your rules.');
    expect(en).toContain('/og-en.png');
    expect(en).not.toContain('Sua call termina. As decisões não somem.');
  });

  it('preserva a logo simples, motion e navegação completa no mobile', () => {
    const html = landingPage('pt');

    expect(html).toContain('<span class="brand-mark" aria-hidden="true">k/</span>');
    expect(html).toContain('<video class="motion-video" autoplay muted loop playsinline');
    expect(html).not.toContain('.nav-links a:nth-child(2)');
    expect(html).toContain('white-space: nowrap;');
  });
});
