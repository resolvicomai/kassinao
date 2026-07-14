import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { docsPage } from '../src/web/docs';

type Listener = (event?: { key?: string }) => void;

function fakeElement() {
  const attributes = new Map<string, string>();
  const listeners = new Map<string, Listener>();
  return {
    attributes,
    listeners,
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    focus: vi.fn(),
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, listener);
    },
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    removeAttribute(name: string) {
      attributes.delete(name);
    },
    getAttribute(name: string) {
      return attributes.get(name) ?? null;
    },
  };
}

function docsRuntime(writeText: (value: string) => Promise<void>, legacyCopySucceeds = true) {
  const html = docsPage('pt');
  const scripts = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi), (match) => match[1]);
  const script = scripts.at(-1);
  if (!script) throw new Error('Script de interação da documentação não encontrado.');

  const classes = new Set<string>();
  const body = {
    appendChild: vi.fn(),
    classList: {
      contains: (name: string) => classes.has(name),
      remove: (name: string) => classes.delete(name),
      toggle: (name: string, force: boolean) => (force ? classes.add(name) : classes.delete(name)),
    },
  };
  const menuButton = fakeElement();
  const backdrop = fakeElement();
  const sidebar = fakeElement();
  const search = fakeElement();
  const searchStatus = fakeElement();
  const noResults = fakeElement();
  const themeButton = fakeElement();
  const copyButton = fakeElement();
  const copyStatus = fakeElement();
  const code = fakeElement();
  code.textContent = 'docker compose up -d';
  const codeBlock = {
    querySelector(selector: string) {
      if (selector === 'code') return code;
      if (selector === '[data-copy-status]') return copyStatus;
      return null;
    },
  };
  Object.assign(copyButton, { closest: () => codeBlock });

  const elements: Record<string, ReturnType<typeof fakeElement>> = {
    'mobile-menu': menuButton,
    'nav-backdrop': backdrop,
    'docs-sidebar': sidebar,
    'docs-search': search,
    'search-status': searchStatus,
    'no-results': noResults,
    'theme-toggle': themeButton,
  };
  const documentListeners = new Map<string, Listener>();
  const documentElement = fakeElement();
  const fallbackArea = {
    value: '',
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    select: vi.fn(),
    remove: vi.fn(),
  };
  const execCommand = vi.fn(() => legacyCopySucceeds);
  const document = {
    body,
    documentElement,
    createElement: () => fallbackArea,
    execCommand,
    getElementById: (id: string) => elements[id] ?? null,
    querySelector: () => null,
    querySelectorAll: (selector: string) => (selector === '[data-copy]' ? [copyButton] : []),
    addEventListener: (type: string, listener: Listener) => documentListeners.set(type, listener),
  };
  const timers: Array<(() => void) | undefined> = [];
  const windowListeners = new Map<string, Listener>();
  const window = {
    innerWidth: 390,
    addEventListener: (type: string, listener: Listener) => windowListeners.set(type, listener),
    matchMedia: () => ({ matches: true }),
    setTimeout(callback: () => void) {
      timers.push(callback);
      return timers.length - 1;
    },
    clearTimeout(id: number) {
      timers[id] = undefined;
    },
  };

  vm.runInNewContext(script, {
    document,
    window,
    navigator: { clipboard: { writeText } },
    IntersectionObserver: undefined,
  });

  return {
    html,
    body,
    window,
    menuButton,
    backdrop,
    sidebar,
    search,
    copyButton,
    copyStatus,
    execCommand,
    fallbackArea,
    documentListeners,
    windowListeners,
    timers,
  };
}

async function settlePromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

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
    expect(html).toContain('ALLOWED_GUILD_IDS');
    expect(html).toContain('ALLOW_ALL_GUILDS');
    expect(html).toContain('TRUST_PROXY_HOPS');
    expect(html).toContain('Não existe workspace hospedado nem cadastro público.');
    expect(html).toContain('A URL não é segredo.');
    expect(html).toContain('Falha para o lado seguro');
    expect(html).not.toContain('/auth/login');
    expect(html).toContain('href="http://localhost:8080/demo"');
    expect(html).not.toContain('Abrir central');
    expect(html).not.toContain('app.kassinao.cloud');
    expect(html).not.toContain('mcp.kassinao.cloud');
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
    expect(html).toContain('There is no hosted workspace or public signup.');
    expect(html).toContain('The URL is not a secret.');
    expect(html).toContain('TRANSCRIBE_FALLBACK_PROVIDER');
    expect(html).toContain('TRANSCRIBE_SEND_MEETING_CONTEXT');
    expect(html).toContain('MINUTES_WEBHOOK_SECRET');
    expect(html).toContain('RECORDING_MAX_CONCURRENT');
    expect(html).toContain('RECORDING_GUILD_STARTS_PER_24H');
    expect(html).toContain('RECORDING_STARTS_GLOBAL_PER_HOUR');
    expect(html).toContain('RECORDING_STARTS_GLOBAL_PER_24H');
    expect(html).toContain('RECORDING_MAX_PENDING_PROCESSING');
    expect(html).not.toContain('MANUAL_RECORD_GUILD_STARTS_PER_24H');
    expect(html).toContain('kassinao-mcp@1.0.6');
    expect(html).toContain('X-Kassinao-Delivery-Id');
    expect(html).toContain('X-Kassinao-Signature');
    expect(html).toContain('HMAC-SHA256');
    expect(html).toContain('compare in constant time');
    expect(html).toContain('five minutes in the past or future');
    expect(html).toContain('href="http://localhost:8080/en/demo"');
    expect(html).not.toContain('>Copiar</button>');
    expect(html).toContain('>Copy</button>');
    expect(html).toContain('Default: required');
    expect(html).toContain('Default: provider default');
    expect(html).toContain('Default: generated and persisted');
    expect(html).toContain('Default: openrouter or groq');
    expect(html).toContain('Default: disabled');
    expect(html).toContain('Default: false');
    expect(html).toContain('YOUR_APP_ID');
    expect(html).toContain('https://YOUR-KASSINAO');
    expect(html).toContain('PROFILE_PRINTED_BY_THE_COMMAND');
    expect(html).not.toContain('KASSINAO_REFRESH_TOKEN');
    expect(html).not.toContain('SEU_APP_ID');
    expect(html).not.toContain('https://SEU-KASSINAO');
    expect(html).not.toContain('PERFIL_IMPRESSO_PELO_COMANDO');
    expect(html).not.toMatch(/Default: (?:obrigat.ria|vazio|desligado|gerado e persistido)/iu);
    expect(html).not.toContain('Default: padrão do provider');
    expect(html).not.toContain('Default: openrouter ou groq');
    expect(html).not.toContain('app.kassinao.cloud');
    expect(html).not.toContain('mcp.kassinao.cloud');
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

  it('shows accessible progress and failure feedback when copying code fails', async () => {
    let rejectCopy: ((reason?: unknown) => void) | undefined;
    const runtime = docsRuntime(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectCopy = reject;
        }),
      false,
    );

    expect(runtime.html).toContain('data-copy-status role="status" aria-live="polite"');
    runtime.copyButton.listeners.get('click')?.();

    expect(runtime.copyButton.disabled).toBe(true);
    expect(runtime.copyButton.attributes.get('aria-busy')).toBe('true');
    expect(runtime.copyStatus.textContent).toBe('Copiando...');

    await settlePromises();
    rejectCopy?.(new Error('clipboard unavailable'));
    await settlePromises();

    expect(runtime.copyButton.disabled).toBe(false);
    expect(runtime.copyButton.attributes.has('aria-busy')).toBe(false);
    expect(runtime.copyStatus.textContent).toBe('Falha ao copiar');
  });

  it('restores the copy action after a successful attempt', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const runtime = docsRuntime(writeText);

    runtime.copyButton.listeners.get('click')?.();
    expect(runtime.copyButton.disabled).toBe(true);
    expect(runtime.copyStatus.textContent).toBe('Copiando...');
    await settlePromises();

    expect(writeText).toHaveBeenCalledWith('docker compose up -d');
    expect(runtime.copyButton.disabled).toBe(true);
    expect(runtime.copyButton.attributes.has('aria-busy')).toBe(false);
    expect(runtime.copyStatus.textContent).toBe('Copiado');

    runtime.timers.at(-1)?.();
    expect(runtime.copyButton.disabled).toBe(false);
    expect(runtime.copyStatus.textContent).toBe('');
  });

  it('abandons a hung Clipboard API attempt and completes through the legacy fallback', async () => {
    const writeText = vi.fn(() => new Promise<void>(() => undefined));
    const runtime = docsRuntime(writeText);

    runtime.copyButton.listeners.get('click')?.();
    await settlePromises();

    expect(writeText).toHaveBeenCalledWith('docker compose up -d');
    expect(runtime.copyButton.disabled).toBe(true);
    expect(runtime.timers[0]).toBeTypeOf('function');

    runtime.timers[0]?.();
    await settlePromises();

    expect(runtime.execCommand).toHaveBeenCalledWith('copy');
    expect(runtime.fallbackArea.remove).toHaveBeenCalledOnce();
    expect(runtime.copyButton.disabled).toBe(true);
    expect(runtime.copyButton.attributes.has('aria-busy')).toBe(false);
    expect(runtime.copyStatus.textContent).toBe('Copiado');

    runtime.timers.at(-1)?.();
    expect(runtime.copyButton.disabled).toBe(false);
    expect(runtime.copyStatus.textContent).toBe('');
  });

  it('returns focus to the mobile menu button whenever an open menu closes', () => {
    const runtime = docsRuntime(() => Promise.resolve());

    runtime.menuButton.listeners.get('click')?.();
    expect(runtime.body.classList.contains('nav-open')).toBe(true);
    expect(runtime.search.focus).toHaveBeenCalledOnce();

    runtime.backdrop.listeners.get('click')?.();
    expect(runtime.body.classList.contains('nav-open')).toBe(false);
    expect(runtime.menuButton.attributes.get('aria-expanded')).toBe('false');
    expect(runtime.menuButton.focus).not.toHaveBeenCalled();
    runtime.timers[0]?.();
    expect(runtime.menuButton.focus).toHaveBeenCalledOnce();

    runtime.menuButton.listeners.get('click')?.();
    runtime.documentListeners.get('keydown')?.({ key: 'Escape' });
    runtime.timers[1]?.();
    expect(runtime.menuButton.focus).toHaveBeenCalledTimes(2);

    runtime.documentListeners.get('keydown')?.({ key: 'Escape' });
    expect(runtime.timers).toHaveLength(2);
    expect(runtime.menuButton.focus).toHaveBeenCalledTimes(2);
  });

  it('keeps the mobile menu state coherent when the viewport becomes desktop-sized', () => {
    const runtime = docsRuntime(() => Promise.resolve());

    runtime.menuButton.listeners.get('click')?.();
    expect(runtime.menuButton.attributes.get('aria-expanded')).toBe('true');

    runtime.window.innerWidth = 1200;
    runtime.windowListeners.get('resize')?.();

    expect(runtime.body.classList.contains('nav-open')).toBe(false);
    expect(runtime.menuButton.attributes.get('aria-expanded')).toBe('false');
    expect(runtime.sidebar.attributes.has('aria-hidden')).toBe(false);
    expect(runtime.sidebar.attributes.has('inert')).toBe(false);
    expect(runtime.menuButton.focus).not.toHaveBeenCalled();
  });
});
