import type { Locale } from '../i18n';

export type PublicSurface = 'home' | 'docs' | 'demo';

export const PUBLIC_LINKS = {
  github: 'https://github.com/resolvicomai/kassinao',
  /** Pacote do cliente. A entrada pública do produto usa config.mcpUrl. */
  mcp: 'https://www.npmjs.com/package/kassinao-mcp',
} as const;

export interface PublicUrlTopology {
  /** Origem privada: OAuth, gravações e downloads. */
  appUrl?: string;
  /** Alias aceito para objetos config anteriores. */
  baseUrl?: string;
  /** Origem da landing e demo. */
  publicUrl: string;
  /** Origem da documentação. */
  docsUrl?: string;
  /** Origem da API e descoberta MCP. */
  mcpUrl?: string;
}

export interface PublicSiteContext {
  locale: Locale;
  htmlLang: 'pt-BR' | 'en';
  surface: PublicSurface;
  canonicalPath: string;
  canonicalUrl: string;
  alternateLocale: Locale;
  links: {
    home: string;
    docs: string;
    demo: string;
    alternate: string;
    github: string;
    mcp: string;
  };
  cookie(secure: boolean): string;
}

const PUBLIC_PATHS: Record<Locale, Record<PublicSurface, string>> = {
  pt: {
    home: '/',
    docs: '/docs',
    demo: '/demo',
  },
  en: {
    home: '/en',
    docs: '/en/docs',
    demo: '/en/demo',
  },
};

const STANDALONE_DOCS_PATHS: Record<Locale, string> = {
  pt: '/',
  en: '/en',
};

export function publicPath(surface: PublicSurface, locale: Locale): string {
  return PUBLIC_PATHS[locale][surface];
}

interface NormalizedPublicTopology {
  appUrl: string;
  publicUrl: string;
  docsUrl: string;
  mcpUrl: string;
}

function cleanOrigin(value: string | undefined): string {
  return (value ?? '').replace(/\/$/, '');
}

function normalizeTopology(input: string | PublicUrlTopology): NormalizedPublicTopology {
  if (typeof input === 'string') {
    const origin = cleanOrigin(input);
    return { appUrl: origin, publicUrl: origin, docsUrl: origin, mcpUrl: origin };
  }
  const publicUrl = cleanOrigin(input.publicUrl);
  const appUrl = cleanOrigin(input.appUrl ?? input.baseUrl ?? publicUrl);
  return {
    appUrl,
    publicUrl,
    docsUrl: cleanOrigin(input.docsUrl ?? publicUrl),
    mcpUrl: cleanOrigin(input.mcpUrl ?? appUrl),
  };
}

/** Caminho canônico da superfície dentro da origem onde ela é publicada. */
export function publicRoutePath(
  surface: PublicSurface,
  locale: Locale,
  topology: string | PublicUrlTopology = '',
): string {
  const urls = normalizeTopology(topology);
  if (surface === 'docs' && urls.docsUrl !== urls.publicUrl) return STANDALONE_DOCS_PATHS[locale];
  return publicPath(surface, locale);
}

/** URL absoluta da superfície; sem origem, mantém o caminho relativo legado. */
export function publicSurfaceUrl(
  surface: PublicSurface,
  locale: Locale,
  topology: string | PublicUrlTopology = '',
): string {
  const urls = normalizeTopology(topology);
  const origin = surface === 'docs' ? urls.docsUrl : urls.publicUrl;
  return `${origin}${publicRoutePath(surface, locale, topology)}`;
}

/**
 * A origem MCP separada tem uma página de descoberta em /. Em instalações de
 * origem única, o link continua útil levando diretamente à seção MCP dos docs.
 */
export function mcpDiscoveryUrl(topology: string | PublicUrlTopology = '', locale: Locale = 'pt'): string {
  const urls = normalizeTopology(topology);
  if (urls.mcpUrl && urls.mcpUrl !== urls.appUrl) {
    return locale === 'en' ? `${urls.mcpUrl}/en` : `${urls.mcpUrl}/`;
  }
  return `${publicSurfaceUrl('docs', locale, topology)}#mcp`;
}

export function alternateLocale(locale: Locale): Locale {
  return locale === 'pt' ? 'en' : 'pt';
}

export function publicSite(
  surface: PublicSurface,
  locale: Locale,
  topology: string | PublicUrlTopology = '',
): PublicSiteContext {
  const alternate = alternateLocale(locale);
  const canonicalPath = publicRoutePath(surface, locale, topology);
  return {
    locale,
    htmlLang: locale === 'pt' ? 'pt-BR' : 'en',
    surface,
    canonicalPath,
    canonicalUrl: publicSurfaceUrl(surface, locale, topology),
    alternateLocale: alternate,
    links: {
      home: publicSurfaceUrl('home', locale, topology),
      docs: publicSurfaceUrl('docs', locale, topology),
      demo: publicSurfaceUrl('demo', locale, topology),
      alternate: publicSurfaceUrl(surface, alternate, topology),
      github: PUBLIC_LINKS.github,
      mcp: mcpDiscoveryUrl(topology, locale),
    },
    cookie: (secure) => localeCookie(locale, secure),
  };
}

export function localeFromValue(value: unknown): Locale | undefined {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (normalized === 'pt' || normalized.startsWith('pt-')) return 'pt';
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en';
  return undefined;
}

export function localeFromCookie(cookieHeader: string | undefined): Locale | undefined {
  const match = (cookieHeader ?? '').match(/(?:^|;\s*)kassinao_lang=(pt|en)\b/);
  return match?.[1] as Locale | undefined;
}

export function localeFromAcceptLanguage(header: string | undefined): Locale | undefined {
  const candidates = (header ?? '')
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const qParam = params.find((param) => param.trim().toLowerCase().startsWith('q='));
      const parsedQ = qParam ? Number(qParam.trim().slice(2)) : 1;
      return { tag, q: Number.isFinite(parsedQ) ? parsedQ : 0, index };
    })
    .filter((candidate) => candidate.tag && candidate.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const candidate of candidates) {
    const locale = localeFromValue(candidate.tag);
    if (locale) return locale;
  }
  return undefined;
}

export function resolveWebLocale(input: {
  query?: unknown;
  cookie?: string;
  acceptLanguage?: string;
  fallback?: Locale;
}): Locale {
  return (
    localeFromValue(input.query) ??
    localeFromCookie(input.cookie) ??
    localeFromAcceptLanguage(input.acceptLanguage) ??
    input.fallback ??
    'en'
  );
}

export function localeCookie(locale: Locale, secure: boolean): string {
  return `kassinao_lang=${locale}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function withLocale(pathname: string, locale: Locale, params: Record<string, string> = {}): string {
  const query = new URLSearchParams({ ...params, lang: locale });
  return `${pathname}?${query.toString()}`;
}
