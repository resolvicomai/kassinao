import fs from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import path from 'node:path';
import express, { type Express, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { config } from '../config';
import type { Locale } from '../i18n';
import type { RecordingMeta, TranscriptSegment } from '../store';
import { isLoopbackAddress } from '../util';
import { applyCspNonce, contentSecurityPolicy, createCspNonce } from './csp';
import { docsPage } from './docs';
import { landingPage } from './landing';
import { recordingPage } from './page';
import { localeCookie, localeFromValue } from './site';

type PublicRole = 'site' | 'docs';

const SPACE_GROTESK_FONT =
  require.resolve('@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2');
const BRAND_DIR = path.join(process.cwd(), 'docs', 'brand');
const DEMO_DIR = path.join(process.cwd(), 'docs', 'example');
const PUBLIC_VISUALS = [
  ['discord-demo-pt-v2.webm', 'video/webm'],
  ['discord-demo-en-v2.webm', 'video/webm'],
  ['discord-demo-pt-v2.png', 'image/png'],
  ['discord-demo-en-v2.png', 'image/png'],
  ['discord-demo-pt-v2.gif', 'image/gif'],
  ['discord-demo-en-v2.gif', 'image/gif'],
  ['meeting-demo-pt.png', 'image/png'],
  ['meeting-demo-en.png', 'image/png'],
  ['producthunt.svg', 'image/svg+xml'],
] as const;

function requestHost(req: Request): string {
  try {
    return new URL(`http://${req.get('host') ?? ''}`).host.toLowerCase();
  } catch {
    return '';
  }
}

function requestHostname(req: Request): string {
  try {
    return new URL(`http://${req.get('host') ?? ''}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function wwwPublicHost(): string | undefined {
  const url = new URL(config.publicUrl);
  const hostname = url.hostname.toLowerCase();
  if (hostname.startsWith('www.')) return undefined;
  return `www.${hostname}${url.port ? `:${url.port}` : ''}`;
}

function roleForRequest(req: Request): PublicRole | undefined {
  const host = requestHost(req);
  const publicHost = new URL(config.publicUrl).host.toLowerCase();
  const docsHost = new URL(config.docsUrl).host.toLowerCase();
  if (host === docsHost && docsHost !== publicHost) return 'docs';
  if (host === publicHost || host === wwwPublicHost()) return 'site';
  if (
    req.path === '/health' &&
    isLoopbackAddress(req.socket.remoteAddress) &&
    ['localhost', '127.0.0.1', '[::1]'].includes(requestHostname(req))
  )
    return 'site';
  return undefined;
}

function secureForRole(role: PublicRole): boolean {
  return (role === 'docs' ? config.docsUrl : config.publicUrl).startsWith('https://');
}

function sendPublicPage(res: Response, role: PublicRole, locale: Locale, html: string): void {
  res
    .append('Set-Cookie', localeCookie(locale, secureForRole(role)))
    .set('Content-Language', locale === 'pt' ? 'pt-BR' : 'en')
    .type('html')
    .send(html);
}

function sendPublicNotFound(res: Response): void {
  res
    .status(404)
    .set('Cache-Control', 'no-store')
    .set('X-Robots-Tag', 'noindex, nofollow, noarchive')
    .type('text/plain')
    .send('Not found.');
}

function readDemo(locale: Locale): {
  meta: RecordingMeta;
  transcript: TranscriptSegment[];
  minutes: Parameters<typeof recordingPage>[1]['minutes'];
} | null {
  try {
    return {
      meta: JSON.parse(fs.readFileSync(path.join(DEMO_DIR, 'meta.json'), 'utf8')) as RecordingMeta,
      transcript: JSON.parse(
        fs.readFileSync(path.join(DEMO_DIR, locale === 'pt' ? 'transcript.pt.json' : 'transcript.json'), 'utf8'),
      ) as TranscriptSegment[],
      minutes: JSON.parse(
        fs.readFileSync(path.join(DEMO_DIR, locale === 'pt' ? 'minutes.pt.json' : 'minutes.json'), 'utf8'),
      ) as Parameters<typeof recordingPage>[1]['minutes'],
    };
  } catch {
    return null;
  }
}

function harden(server: HttpServer): void {
  server.requestTimeout = 120_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1_000;
}

export function createPublicApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('case sensitive routing', true);
  app.set('strict routing', true);
  app.set('trust proxy', config.trustProxyHops);

  app.use((req, res, next) => {
    const nonce = createCspNonce();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', contentSecurityPolicy(nonce));
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const originalSend = res.send;
    res.send = function (this: Response, body: Parameters<Response['send']>[0]): Response {
      const contentType = String(res.getHeader('Content-Type') ?? '');
      return originalSend.call(
        this,
        typeof body === 'string' && contentType.toLowerCase().startsWith('text/html')
          ? applyCspNonce(body, nonce)
          : body,
      );
    } as Response['send'];
    next();
  });

  app.use((req, res, next) => {
    const role = roleForRequest(req);
    if (!role) {
      res
        .status(421)
        .set('X-Robots-Tag', 'noindex, nofollow, noarchive')
        .type('text/plain')
        .send('Host não reconhecido.');
      return;
    }
    res.locals.publicRole = role;
    const alternatePublicHost = wwwPublicHost();
    if (alternatePublicHost && requestHost(req) === alternatePublicHost) {
      res.redirect(301, `${config.publicUrl}${req.originalUrl.startsWith('/') ? req.originalUrl : '/'}`);
      return;
    }
    const canonical = role === 'docs' ? config.docsUrl : config.publicUrl;
    const internalHealth = req.path === '/health' && isLoopbackAddress(req.socket.remoteAddress);
    if (canonical.startsWith('https://') && !req.secure && !internalHealth) {
      res.redirect(308, `${canonical}${req.originalUrl.startsWith('/') ? req.originalUrl : '/'}`);
      return;
    }
    next();
  });

  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      skip: (req) => req.path === '/health',
    }),
  );

  app.get('/health', (_req, res) =>
    res
      .set('Cache-Control', 'no-store')
      .set('X-Robots-Tag', 'noindex, nofollow, noarchive')
      .json({
        ok: true,
        surface: 'public',
        ...(config.releaseDigest ? { release: config.releaseDigest } : {}),
        ...(config.deploymentFingerprint ? { deployment: config.deploymentFingerprint } : {}),
      }),
  );
  app.get('/robots.txt', (_req, res) => {
    const role = res.locals.publicRole as PublicRole;
    const origin = role === 'docs' ? config.docsUrl : config.publicUrl;
    res
      .type('text/plain')
      .set('Cache-Control', 'public, max-age=3600')
      .send(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
  });
  app.get('/sitemap.xml', (_req, res) => {
    const role = res.locals.publicRole as PublicRole;
    const urls =
      role === 'docs'
        ? [`${config.docsUrl}/`, `${config.docsUrl}/en`]
        : [`${config.publicUrl}/`, `${config.publicUrl}/en`, `${config.publicUrl}/demo`, `${config.publicUrl}/en/demo`];
    const entries = urls.map((url) => `  <url><loc>${url}</loc></url>`).join('\n');
    res
      .type('application/xml')
      .set('Cache-Control', 'public, max-age=3600')
      .send(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`,
      );
  });

  app.get('/assets/space-grotesk.woff2', (_req, res) => {
    res.type('font/woff2').set('Cache-Control', 'public, max-age=31536000, immutable').sendFile(SPACE_GROTESK_FONT);
  });
  app.get('/assets/kassinao-mark.png', (_req, res) => {
    res
      .type('png')
      .set('Cache-Control', 'public, max-age=31536000, immutable')
      .sendFile(path.join(BRAND_DIR, 'kassinao-mark-64.png'));
  });
  app.get('/favicon-32.png', (_req, res) => {
    res.type('png').set('Cache-Control', 'public, max-age=86400').sendFile(path.join(BRAND_DIR, 'favicon-32.png'));
  });
  app.get('/assets/apple-touch-icon.png', (_req, res) => {
    res
      .type('png')
      .set('Cache-Control', 'public, max-age=86400')
      .sendFile(path.join(BRAND_DIR, 'apple-touch-icon-180.png'));
  });
  for (const [fileName, contentType] of PUBLIC_VISUALS) {
    app.get(`/assets/${fileName}`, (_req, res) => {
      res
        .type(contentType)
        .set('Cache-Control', 'public, max-age=31536000, immutable')
        .sendFile(path.join(BRAND_DIR, fileName));
    });
  }
  for (const locale of ['pt', 'en'] as const) {
    app.get(`/og-${locale}.png`, (_req, res) => {
      res
        .type('png')
        .set('Cache-Control', 'public, max-age=86400')
        .sendFile(path.join(process.cwd(), 'docs', `og-${locale}.png`));
    });
  }
  app.get('/og.png', (_req, res) => {
    res
      .type('png')
      .set('Cache-Control', 'public, max-age=86400')
      .sendFile(path.join(process.cwd(), 'docs', 'og.png'));
  });

  app.all(/^\/(?:app|auth|api)(?:\/|$)/i, (_req, res) => {
    sendPublicNotFound(res);
  });

  app.get('*', (req, res) => {
    const role = res.locals.publicRole as PublicRole;
    const locale: Locale =
      req.path === '/en' || req.path === '/en/docs' || localeFromValue(req.query.lang) === 'en' ? 'en' : 'pt';
    if (role === 'docs') {
      if (req.path === '/' || req.path === '/en') {
        sendPublicPage(res, role, locale, docsPage(locale));
        return;
      }
      if (req.path === '/docs' || req.path === '/en/docs') {
        res.redirect(301, locale === 'en' ? '/en' : '/');
        return;
      }
      sendPublicNotFound(res);
      return;
    }

    if (req.path === '/' || req.path === '/en') {
      sendPublicPage(res, role, locale, landingPage(locale));
      return;
    }
    if (req.path === '/docs' || req.path === '/en/docs') {
      res.redirect(301, locale === 'en' ? `${config.docsUrl}/en` : `${config.docsUrl}/`);
      return;
    }
    if (req.path === '/demo' || req.path === '/en/demo') {
      const demo = readDemo(locale);
      if (!demo) {
        sendPublicNotFound(res);
        return;
      }
      sendPublicPage(
        res,
        role,
        locale,
        recordingPage(demo.meta, {
          live: false,
          canDelete: false,
          lang: locale,
          transcript: demo.transcript,
          minutes: demo.minutes,
          demo: true,
        }),
      );
      return;
    }
    if (req.path === '/demo/audio') {
      res
        .type('audio/mpeg')
        .set('Cache-Control', 'public, max-age=86400')
        .sendFile(path.join(DEMO_DIR, 'sample-audio.mp3'));
      return;
    }
    sendPublicNotFound(res);
  });

  app.use((_req, res) => sendPublicNotFound(res));

  return app;
}

export function startPublicServer(): void {
  const server = createPublicApp().listen(config.port, config.webBindAddress, () => {
    console.log(`Superfícies públicas em ${config.webBindAddress}:${config.port}; processo sem configuração privada.`);
  });
  harden(server);
}
