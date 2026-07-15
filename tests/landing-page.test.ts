import { describe, expect, it } from 'vitest';
import { landingPage } from '../src/web/landing';

describe('landing page do Kassinão', () => {
  it('conta a história completa do bot, da call à memória pesquisável', () => {
    const html = landingPage('pt');
    const order = [
      'Sua call termina. As decisões não somem.',
      'A voz já chega ligada a uma conta.',
      'Tudo acontece onde a call já está.',
      'Abra uma reunião pronta.',
      'Pergunte depois. Receba a fonte.',
      'Sua instância. Seu histórico. Suas regras.',
      'Rode na sua infraestrutura. Mantenha o controle.',
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
      expect(html).not.toContain('app.example.com');
      expect(html).not.toContain('mcp.example.com');
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
    expect(pt).toContain('Não existe serviço hospedado nem cadastro público.');
    expect(pt).toContain('O operador ativa separadamente transcrição, ata, perguntas e MCP.');
    expect(pt).toContain('/og-pt.png');
    expect(pt).not.toContain('For teams that work on Discord');

    expect(en).toContain('<html lang="en">');
    expect(en).toContain('For teams that work on Discord');
    expect(en).toContain("Your call ends. The decisions don't disappear.");
    expect(en).toContain('Public demo');
    expect(en).toContain('There is no hosted service or public signup.');
    expect(en).toContain('The operator enables transcripts, meeting notes, questions, and MCP separately.');
    expect(en).toContain('Your instance. Your history. Your rules.');
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

  it('separa o núcleo garantido dos recursos opcionais de IA em PT e EN', () => {
    const pt = landingPage('pt');
    const en = landingPage('en');

    expect(pt).toContain('Gravação, faixas, mix e notas funcionam sem provider.');
    expect(pt).toContain('Para IA local, crie uma imagem customizada com o transcritor');
    expect(pt).toContain('1 conta falando = 1 faixa');
    expect(pt).not.toContain('Cada participante recebe uma faixa');
    expect(pt).not.toContain('Use processamento local ou configure um provider.');

    expect(en).toContain('Recording, tracks, mix, and notes work without a provider.');
    expect(en).toContain('For local AI, build a custom image with the transcriber');
    expect(en).toContain('1 speaking account = 1 track');
    expect(en).not.toContain('Each participant gets a separate track');
    expect(en).not.toContain('Use local processing or configure a provider.');
  });
});
