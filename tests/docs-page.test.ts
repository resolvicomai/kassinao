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
    expect(html).toContain('<h1>Seu bot. Sua instância. Suas calls.</h1>');
    expect(html).toContain('id="docs-search"');
    expect(html).toContain('id="mobile-menu"');
    expect(html).toContain('prefers-reduced-motion: reduce');

    for (const id of [
      'visao',
      'fluxo',
      'limites',
      'local',
      'producao',
      'discord',
      'comandos',
      'acesso',
      'mcp',
      'operacao',
      'problemas',
      'links',
    ]) {
      expect(html).toContain(`id="${id}" data-doc-section`);
    }

    expect(html).toContain('/gravar [canal]');
    expect(html).toContain('/perguntar &lt;pergunta&gt; [dias]');
    expect(html).toContain('/privacidade');
    expect(html).toContain('MCP_SECRET');
    expect(html).toContain('ALLOWED_GUILD_IDS');
    expect(html).toContain('ALLOW_ALL_GUILDS');
    expect(html).toContain('OPERATOR_NAME');
    expect(html).toContain('OPERATOR_CONTACT_URL');
    expect(html).toContain('PRIVACY_POLICY_URL');
    expect(html).toContain('DATA_DELETION_URL');
    expect(html).toContain('TERMS_OF_SERVICE_URL');
    expect(html).toContain('TRUST_PROXY_HOPS');
    expect(html).toContain('data/{recordings,state,auth,cache}');
    expect(html).toContain('chmod 700 data data/*');
    expect(html).toContain('docker build -t kassinao-local:dev .');
    expect(html).toContain('docker compose up -d --no-build');
    expect(html).not.toContain('docker compose pull');
    expect(html).toContain('bitfield 68242432');
    expect(html).toContain('APP_URL/privacy');
    expect(html).toContain('abre sem login');
    expect(html).toContain('dm-crypt/LUKS');
    expect(html).toContain('topologia split');
    expect(html).toContain('A URL não é segredo');
    expect(html).toContain('Falha fechada');
    expect(html).toContain('Aviso técnico não é consentimento jurídico.');
    expect(html).toContain('uma faixa por conta do Discord que fala');
    expect(html).toContain('apenas um indicador adicional e pode falhar');
    expect(html).not.toMatch(/workspace/iu);
    expect(html).not.toContain('v1.4.5');
    expect(html).not.toContain('ghcr.io/resolvicomai/kassinao');
    expect(html).not.toContain('/auth/login');
    expect(html).toContain('href="http://localhost:8080/demo"');
    expect(html).not.toContain('app.example.com');
    expect(html).not.toContain('mcp.example.com');
  });

  it('renders the entire navigation and content in English', () => {
    const html = docsPage('en');

    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<h1>Your bot. Your instance. Your calls.</h1>');
    expect(html).toContain('Search documentation');
    expect(html).toContain('Test from source');
    expect(html).toContain('Hardened production');
    expect(html).toContain('/record [channel]');
    expect(html).toContain('/ask &lt;question&gt; [days]');
    expect(html).toContain('/privacy');
    expect(html).toContain('Historical meeting ACL');
    expect(html).toContain('The URL is not a secret');
    expect(html).toContain('TRANSCRIBE_FALLBACK_PROVIDER');
    expect(html).toContain('data/{recordings,state,auth,cache}');
    expect(html).toContain('chmod 700 data data/*');
    expect(html).toContain('TRANSCRIBE_SEND_MEETING_CONTEXT');
    expect(html).toContain('MINUTES_WEBHOOK_SECRET');
    expect(html).toContain('OPERATOR_NAME');
    expect(html).toContain('DATA_DELETION_URL');
    expect(html).toContain('TERMS_OF_SERVICE_URL');
    expect(html).toContain('APP_URL/privacy#data-rights');
    expect(html).toContain('opens without login');
    expect(html).toContain('kassinao-mcp@1.0.7');
    expect(html).toContain('one track per Discord account that speaks');
    expect(html).toContain('nickname change is only an extra indicator and may fail');
    expect(html).toContain('The current five tools are read-only.');
    expect(html).toContain('does not mount or directly read server files');
    expect(html).toContain('source-free bundle');
    expect(html).toContain('does not run git clone, npm install, or docker build');
    expect(html).toContain('dm-crypt/LUKS');
    expect(html).toContain('href="http://localhost:8080/en/demo"');
    expect(html).not.toContain('>Copiar</button>');
    expect(html).toContain('>Copy</button>');
    expect(html).toContain('Default: required');
    expect(html).toContain('Default: disabled');
    expect(html).toContain('Default: false');
    expect(html).toContain('YOUR_APP_ID');
    expect(html).toContain('https://YOUR-INSTANCE-MCP');
    expect(html).not.toContain('KASSINAO_REFRESH_TOKEN');
    expect(html).not.toContain('SEU_APP_ID');
    expect(html).not.toMatch(/Default: (?:obrigat.ria|vazio|desligado|gerado e persistido)/iu);
    expect(html).not.toMatch(/workspace/iu);
    expect(html).not.toContain('v1.4.5');
    expect(html).not.toContain('ghcr.io/resolvicomai/kassinao');
    expect(html).not.toContain('app.example.com');
    expect(html).not.toContain('mcp.example.com');
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

  it('pins the production deploy to the extracted release instead of the shell cwd', () => {
    for (const html of [docsPage('pt'), docsPage('en')]) {
      expect(html).toContain('RELEASE_ROOT=/opt/kassinao/releases/kassinao-ops-vX.Y.Z');
      expect(html).toContain('sudo test ! -e &quot;$RELEASE_ROOT&quot;');
      expect(html).toContain('KASSINAO_DEPLOY_DIR=&quot;$RELEASE_ROOT&quot;');
      expect(html).toContain('&quot;$RELEASE_ROOT/scripts/prepare-storage.sh&quot;');
      expect(html).toContain('&quot;$RELEASE_ROOT/scripts/deploy-release.sh&quot;');
      expect(html).not.toContain('sudo &quot;$RELEASE_ROOT/scripts/deploy-release.sh&quot;');
      expect(html).toContain('isDraft,isImmutable');
      expect(html).toContain('gh release verify &quot;$TAG&quot;');
      expect(html).toContain('gh release verify-asset');
      expect(html).toContain('--signer-workflow');
      expect(html).toContain('--source-ref');
      expect(html).toContain('--source-digest');
      expect(html).toContain('--deny-self-hosted-runners');
      expect(html).toContain('http://kassinao:8080');
      expect(html).toContain('http://kassinao-public:8081');
      expect(html).toContain('KASSINAO_HOST_PORT');
      expect(html).toContain('KASSINAO_PUBLIC_HOST_PORT');
    }
    expect(docsPage('pt')).toContain('Audite antes do lançamento');
    expect(docsPage('en')).toContain('Audit before launch');
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
