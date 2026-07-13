import { describe, expect, it } from 'vitest';
import { docsPage } from '../src/web/docs';

describe('documentation page', () => {
  it('renders complete Portuguese documentation by default', () => {
    const html = docsPage();

    expect(html).toContain('<html lang="pt-BR">');
    expect(html).toContain('<h1>Coloque o Kassinão no seu Discord.</h1>');
    expect(html).toContain('id="docs-search"');
    expect(html).toContain('id="mobile-menu"');
    expect(html).toContain('prefers-reduced-motion: reduce');

    for (const id of [
      'inicio',
      'requisitos',
      'docker',
      'configuracao',
      'comandos',
      'fluxo',
      'transcricao',
      'privacidade',
      'mcp',
      'problemas',
      'links',
    ]) {
      expect(html).toContain(`id="${id}" data-doc-section`);
    }

    expect(html).toContain('/gravar [canal]');
    expect(html).toContain('/perguntar &lt;pergunta&gt; [dias]');
    expect(html).toContain('MCP_SECRET');
    expect(html).toContain('Falha para o lado seguro');
    expect(html).not.toContain('/auth/login');
    expect(html).toContain('href="http://localhost:8080/demo"');
    expect(html).not.toContain('Abrir central');
  });

  it('renders the entire navigation and content in English', () => {
    const html = docsPage('en');

    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<h1>Bring Kassinão into your Discord.</h1>');
    expect(html).toContain('Search documentation');
    expect(html).toContain('Docker installation');
    expect(html).toContain('/record [channel]');
    expect(html).toContain('/ask &lt;question&gt; [days]');
    expect(html).toContain('Recording history');
    expect(html).toContain('MANUAL_RECORD_GUILD_STARTS_PER_24H');
    expect(html).toContain('href="http://localhost:8080/en/demo"');
    expect(html).not.toContain('>Copiar</button>');
    expect(html).toContain('>Copy</button>');
    expect(html).toContain('Default: required');
    expect(html).toContain('Default: provider default');
    expect(html).toContain('Default: generated and persisted');
    expect(html).toContain('Default: openrouter or groq');
    expect(html).toContain('Default: disabled');
    expect(html).toContain('YOUR_APP_ID');
    expect(html).toContain('https://YOUR-KASSINAO');
    expect(html).toContain('PASTE_THE_TOKEN');
    expect(html).not.toContain('SEU_APP_ID');
    expect(html).not.toContain('https://SEU-KASSINAO');
    expect(html).not.toContain('COLE_O_TOKEN');
    expect(html).not.toMatch(/Default: (?:obrigat.ria|vazio|desligado|gerado e persistido)/iu);
    expect(html).not.toContain('Default: padrão do provider');
    expect(html).not.toContain('Default: openrouter ou groq');
  });

  it('keeps the page self-contained and free of banned typography', () => {
    for (const html of [docsPage('pt'), docsPage('en')]) {
      expect(html).not.toMatch(/[—–]/u);
      expect(html).not.toContain('fonts.googleapis.com');
      expect(html).not.toContain("addEventListener('scroll'");
      expect(html).not.toContain('addEventListener("scroll"');
      expect(html).toContain("url('/assets/space-grotesk.woff2')");
      expect(html).toContain('aria-live="polite"');
    }
  });
});
