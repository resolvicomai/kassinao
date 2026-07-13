import type { Locale } from '../i18n';

export type PublicSurface = 'home' | 'docs' | 'demo';

export const PUBLIC_LINKS = {
  github: 'https://github.com/resolvicomai/kassinao',
  mcp: 'https://www.npmjs.com/package/kassinao-mcp',
} as const;

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

export function publicPath(surface: PublicSurface, locale: Locale): string {
  return PUBLIC_PATHS[locale][surface];
}

export function alternateLocale(locale: Locale): Locale {
  return locale === 'pt' ? 'en' : 'pt';
}

export function publicSite(surface: PublicSurface, locale: Locale, baseUrl = ''): PublicSiteContext {
  const alternate = alternateLocale(locale);
  const canonicalPath = publicPath(surface, locale);
  return {
    locale,
    htmlLang: locale === 'pt' ? 'pt-BR' : 'en',
    surface,
    canonicalPath,
    canonicalUrl: `${baseUrl.replace(/\/$/, '')}${canonicalPath}`,
    alternateLocale: alternate,
    links: {
      home: publicPath('home', locale),
      docs: publicPath('docs', locale),
      demo: publicPath('demo', locale),
      alternate: publicPath(surface, alternate),
      github: PUBLIC_LINKS.github,
      mcp: PUBLIC_LINKS.mcp,
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
