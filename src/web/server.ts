import fs from 'node:fs';
import path from 'node:path';
import express, { NextFunction, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { config } from '../config';
import { freeMB } from '../disk';
import { client } from '../discord/client';
import { isClientReady } from '../discord/ready';
import { Locale } from '../i18n';
import { cook, CookBusyError, CookFormat, COOK_FORMATS } from '../processing/cook';
import { isTranscribing, transcriptToMarkdown } from '../processing/transcribe';
import { minutesToMarkdown } from '../processing/minutes';
import { sessionManager } from '../recorder/manager';
import { cleanInline } from '../sanitize';
import { MAX_MINUTES_BYTES } from '../securityLimits';
import { isLoopbackAddress } from '../util';
import {
  audioBytesOf,
  boundMinutesForResponse,
  deleteAudioOnly,
  deleteRecording,
  forgetAudioBytes,
  listMetaIdsPage,
  MetaTimelineCursor,
  readMeta,
  readMinutes,
  readMinutesBounded,
  readTranscriptBounded,
  RecordingMeta,
  TranscriptSegment,
  transcriptionNeedsAudio,
  transcriptReady,
} from '../store';
import { checkAccess, createAccessRequestContext, TransientAccessError, withFreshMembershipBudget } from './access';
import { ApiRateLimiters, FixedWindowRateLimiter, mountMcpApi } from './api';
import {
  beginLogin,
  finishLogin,
  getWebUser,
  isAllowedWebMutation,
  logoutWeb,
  scopeWebSessionToApp,
  WebUser,
} from './auth';
import { applyCspNonce, contentSecurityPolicy, createCspNonce } from './csp';
import {
  createExchangeCode,
  listUserSessions,
  McpExchangeCodeCapacityError,
  revokeUser,
  revokeUserSession,
} from './mcpTokens';
import {
  connectPage,
  messagePage,
  recordingPage,
  RecordingIndexItem,
  recordingsIndexPage,
  RecordingsSort,
} from './page';
import { landingPage } from './landing';
import { docsPage } from './docs';
import { searchRecordings } from './search';
import { localeCookie, localeFromValue, resolveWebLocale } from './site';
import { beginDownload, endDownload, hasActiveDownloads } from './tracker';
import { isOpaqueCursorToken, OpaqueCursorError, openOpaqueCursor, sealOpaqueCursor } from './opaqueCursor';

const SPACE_GROTESK_FONT =
  require.resolve('@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2');
const BRAND_DIR = path.join(process.cwd(), 'docs', 'brand');
const BRAND_MARK = path.join(BRAND_DIR, 'kassinao-mark-64.png');
const FAVICON = path.join(BRAND_DIR, 'favicon-32.png');
const APPLE_TOUCH_ICON = path.join(BRAND_DIR, 'apple-touch-icon-180.png');
const PUBLIC_VISUALS = [
  ['discord-demo-pt.webm', 'video/webm'],
  ['discord-demo-en.webm', 'video/webm'],
  ['discord-demo-pt.png', 'image/png'],
  ['discord-demo-en.png', 'image/png'],
  ['discord-demo-pt.gif', 'image/gif'],
  ['discord-demo-en.gif', 'image/gif'],
  ['meeting-demo-pt.png', 'image/png'],
  ['meeting-demo-en.png', 'image/png'],
] as const;

const mcpConnectionCreationLimiter = new FixedWindowRateLimiter();
const webHeavyReadLimiters = new ApiRateLimiters();

export const WEB_DIRECT_TRANSCRIPT_MAX_BYTES = 5 * 1024 * 1024;
export const WEB_DIRECT_TRANSCRIPT_MAX_SEGMENTS = 5_000;
export const MAX_WEB_LIBRARY_CANDIDATES_PER_PAGE = 100;
const MAX_WEB_LIBRARY_GUILDS_PER_PAGE = 25;
const MAX_WEB_LIBRARY_ITEMS_PER_PAGE = 100;
const MAX_MEMBERSHIP_GUILDS_PER_ATTEMPT = 60;

export function webHeavyReadRateLimited(userId: string): boolean {
  return (
    webHeavyReadLimiters.consumeKey(`web-heavy-user:${userId}`, 12, 60_000) ||
    webHeavyReadLimiters.consumeGlobal('web-heavy-global', 30, 60_000)
  );
}

export function encodeWebLibraryCursor(
  cursor: MetaTimelineCursor,
  userId: string,
  context: string,
  nowMs = Date.now(),
): string {
  return sealOpaqueCursor(cursor, {
    secret: config.cookieSecret,
    purpose: 'web-library',
    subject: userId,
    context,
    nowMs,
  });
}

export function parseWebLibraryCursor(
  value: unknown,
  userId: string,
  context: string,
  nowMs = Date.now(),
): MetaTimelineCursor | undefined {
  if (value === undefined) return undefined;
  const parsed = openOpaqueCursor<unknown>(value, {
    secret: config.cookieSecret,
    purpose: 'web-library',
    subject: userId,
    context,
    nowMs,
  });
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Number.isSafeInteger((parsed as MetaTimelineCursor).startedAt) ||
    (parsed as MetaTimelineCursor).startedAt < 0 ||
    typeof (parsed as MetaTimelineCursor).id !== 'string' ||
    (parsed as MetaTimelineCursor).id.length > 200 ||
    !/^[a-zA-Z0-9-]+$/.test((parsed as MetaTimelineCursor).id)
  )
    throw new OpaqueCursorError();
  return parsed as MetaTimelineCursor;
}

export function mcpConnectionCreationRateLimited(userId: string): boolean {
  return mcpConnectionCreationLimiter.consume(`mcp-connect:${userId}`, 5, 60_000);
}

function pageLang(req: Request): Locale {
  return resolveWebLocale({
    query: req.query.lang,
    cookie: req.headers.cookie,
    acceptLanguage: req.headers['accept-language'],
    fallback: config.defaultLocale,
  });
}

const MSG = {
  notFoundTitle: { pt: 'Gravação não encontrada', en: 'Recording not found' },
  notFound: {
    pt: 'Esta gravação não existe, expirou ou foi apagada.',
    en: 'This recording does not exist, has expired or was deleted.',
  },
  loginFailTitle: { pt: 'Falha no login', en: 'Login failed' },
  loginFail: {
    pt: 'Não deu para confirmar seu login no Discord. Tente abrir o link da gravação de novo.',
    en: 'Could not confirm your Discord login. Try opening the recording link again.',
  },
  errorTitle: { pt: 'Erro', en: 'Error' },
  loginError: { pt: 'Erro inesperado no login. Tente de novo.', en: 'Unexpected login error. Try again.' },
  cookErrorTitle: { pt: 'Erro no processamento', en: 'Processing error' },
  cookError: {
    pt: 'Não consegui gerar esse formato. Tente de novo em instantes.',
    en: 'Could not generate that format. Try again in a moment.',
  },
  deleteLiveTitle: { pt: 'Gravação em andamento', en: 'Recording in progress' },
  deleteLive: { pt: 'Pare a gravação antes de apagá-la.', en: 'Stop the recording before deleting it.' },
  deleteBusyTitle: { pt: 'Download em andamento', en: 'Download in progress' },
  deleteBusy: {
    pt: 'Alguém está baixando esta gravação agora. Tente apagar de novo em instantes.',
    en: 'Someone is downloading this recording right now. Try deleting again in a moment.',
  },
  deletedTitle: { pt: 'Gravação apagada', en: 'Recording deleted' },
  deleted: {
    pt: 'Pronto — os arquivos foram removidos para sempre. 🗑️',
    en: 'Done — the files were removed forever. 🗑️',
  },
  freedFlash: {
    pt: '🔇 Espaço liberado — o áudio foi apagado; transcrição, ata e notas continuam.',
    en: '🔇 Space freed — the audio was deleted; transcript, minutes and notes remain.',
  },
  deletedFlash: { pt: '🗑️ Gravação apagada para sempre.', en: '🗑️ Recording deleted forever.' },
  freeLiveTitle: { pt: 'Gravação em andamento', en: 'Recording in progress' },
  freeLive: { pt: 'Pare a gravação antes de liberar o espaço.', en: 'Stop the recording before freeing space.' },
  freeBusyTitle: { pt: 'Em uso agora', en: 'Busy right now' },
  freeBusy: {
    pt: 'Alguém está baixando ou a transcrição ainda está rodando. Tente de novo em instantes.',
    en: 'Someone is downloading or the transcription is still running. Try again in a moment.',
  },
  freeGoneTitle: { pt: 'Áudio já liberado', en: 'Audio already released' },
  freeGone: {
    pt: 'O áudio desta gravação já tinha sido liberado — nada a fazer.',
    en: 'The audio of this recording was already released — nothing to do.',
  },
  startingTitle: { pt: 'Iniciando…', en: 'Starting up…' },
  starting: {
    pt: 'O Kassinão está conectando ao Discord. Recarregue em alguns segundos.',
    en: 'Kassinão is connecting to Discord. Reload in a few seconds.',
  },
  tooManyRequests: {
    pt: 'Muitas requisições. Tente de novo em instantes.',
    en: 'Too many requests. Try again shortly.',
  },
  transcriptTooLarge: {
    pt: 'A transcrição excede o limite seguro para abrir inteira nesta página. A ata e o áudio continuam disponíveis.',
    en: 'The transcript exceeds the safe limit for opening it all on this page. Meeting notes and audio remain available.',
  },
  transcriptUnavailable: {
    pt: 'A transcrição está temporariamente indisponível. Recarregue em instantes.',
    en: 'The transcript is temporarily unavailable. Reload shortly.',
  },
  minutesTooLarge: {
    pt: 'A ata excede o limite seguro de 1 MiB e não foi aberta. O áudio e a transcrição continuam disponíveis.',
    en: 'The meeting minutes exceed the safe 1 MiB limit and were not opened. Audio and transcript remain available.',
  },
  minutesUnavailable: {
    pt: 'A ata está temporariamente indisponível. Recarregue em instantes.',
    en: 'The meeting minutes are temporarily unavailable. Reload shortly.',
  },
  minutesResponseLimit: {
    pt: 'A ata tem coleções acima do limite seguro para exportação completa. Abra a página para consultar a versão limitada com aviso.',
    en: 'The meeting minutes contain collections above the safe full-export limit. Open the page for an explicitly limited view.',
  },
  noAudio: { pt: 'Sem áudio disponível.', en: 'No audio available.' },
  recordingInProgress: { pt: 'Gravação em andamento.', en: 'Recording in progress.' },
  audioExpired: { pt: 'O áudio desta gravação expirou.', en: 'This recording audio has expired.' },
  processingBusy: {
    pt: 'Muitas gravações estão sendo processadas agora. Tente de novo em instantes.',
    en: 'Too many recordings are being processed right now. Try again shortly.',
  },
  audioPrepareError: { pt: 'Erro ao preparar o áudio.', en: 'Could not prepare the audio.' },
  invalidFormat: { pt: 'Formato inválido.', en: 'Invalid format.' },
  downloadAfterStop: {
    pt: 'Gravação em andamento. Baixe depois de encerrar.',
    en: 'Recording in progress. Download it after stopping.',
  },
  audioExpiredTextKept: {
    pt: 'O áudio desta gravação expirou. A transcrição e a ata continuam na página.',
    en: 'This recording audio has expired. The transcript and meeting notes remain available.',
  },
  mcpMembershipTitle: { pt: 'Servidor do Discord necessário', en: 'Discord server required' },
  mcpMembership: {
    pt: 'Sua conta precisa ser membro atual de pelo menos um servidor onde o Kassinão está instalado.',
    en: 'Your account must currently belong to at least one server where Kassinão is installed.',
  },
  mcpCapacityTitle: { pt: 'Limite de conexões atingido', en: 'Connection limit reached' },
  mcpCapacity: {
    pt: 'O limite global de conexões foi atingido. Tente novamente mais tarde.',
    en: 'The global connection limit has been reached. Try again later.',
  },
} as const;

/** Inexistente e sem acesso são deliberadamente indistinguíveis. */
function sendRecordingUnavailable(res: Response, l: Locale, user: WebUser): void {
  res
    .status(404)
    .type('html')
    .send(messagePage(MSG.notFoundTitle[l], MSG.notFound[l], user, l));
}

/**
 * Gate de prontidão: enquanto o gateway não está pronto, os caches de guild/canal
 * estão vazios e o checkAccess daria um 403 falso a quem tem direito via "enxerga o
 * canal"/ManageGuild. Responde 503 (retriável) em vez de um veredito de acesso errado.
 * Só entra DEPOIS do login (a rota já resolveu o usuário) — o fluxo OAuth usa REST,
 * não depende do gateway.
 */
function notReady(res: Response, l: Locale, user?: WebUser): boolean {
  if (isClientReady()) return false;
  sendAccessTemporarilyUnavailable(res, l, user);
  return true;
}

function sendAccessTemporarilyUnavailable(res: Response, l: Locale, user?: WebUser): void {
  res
    .status(503)
    .set('Retry-After', '5')
    .type('html')
    .send(messagePage(MSG.startingTitle[l], MSG.starting[l], user, l));
}

interface MembershipGuild {
  members: {
    fetch(options: { user: string; force: true; cache: false }): Promise<unknown>;
  };
}

export type CurrentGuildMembership = 'member' | 'not-member' | 'unavailable';
type FreshMembershipRunner = typeof withFreshMembershipBudget;
interface MembershipScanCursor {
  index: number;
  unavailable: boolean;
}
const membershipScanCursors = new Map<string, MembershipScanCursor>();

function rememberMembershipScanCursor(userId: string, cursor: MembershipScanCursor): void {
  membershipScanCursors.delete(userId);
  membershipScanCursors.set(userId, cursor);
  while (membershipScanCursors.size > 5_000) {
    const oldest = membershipScanCursors.keys().next().value as string | undefined;
    if (!oldest) break;
    membershipScanCursors.delete(oldest);
  }
}

export interface WebLibraryPage {
  items: Array<{ meta: RecordingMeta; canDelete: boolean }>;
  nextCursor?: number;
  candidatesScanned: number;
  guildsChecked: number;
}

/**
 * Página por cursor ANTES da ACL, com continuação explícita. Isso impede que
 * gravações novas e inacessíveis escondam para sempre uma antiga autorizada e
 * mantém cada request abaixo dos orçamentos de membership do Discord.
 */
export async function collectWebLibraryPage(
  user: WebUser,
  metas: RecordingMeta[],
  cursor = 0,
  runCheck: typeof checkAccess = checkAccess,
): Promise<WebLibraryPage> {
  const items: WebLibraryPage['items'] = [];
  const requestContext = createAccessRequestContext();
  const checkedGuilds = new Set<string>();
  let candidatesScanned = 0;
  let index = Number.isSafeInteger(cursor) && cursor >= 0 ? Math.min(cursor, metas.length) : 0;

  while (
    index < metas.length &&
    candidatesScanned < MAX_WEB_LIBRARY_CANDIDATES_PER_PAGE &&
    items.length < MAX_WEB_LIBRARY_ITEMS_PER_PAGE
  ) {
    const meta = metas[index];
    if (meta.demo) {
      index++;
      continue;
    }
    if (!checkedGuilds.has(meta.guildId)) {
      if (checkedGuilds.size >= MAX_WEB_LIBRARY_GUILDS_PER_PAGE) break;
      checkedGuilds.add(meta.guildId);
    }
    const access = await runCheck(user, meta, { requestContext, throwOnTransient: true });
    // Só consome a candidata depois de uma resposta conclusiva. Uma falha
    // transitória aborta a página e a rota não emite cursor além desta meta.
    index++;
    candidatesScanned++;
    if (access.view) items.push({ meta, canDelete: access.delete });
  }

  return {
    items,
    nextCursor: index < metas.length ? index : undefined,
    candidatesScanned,
    guildsChecked: checkedGuilds.size,
  };
}

type DomainConfig = typeof config & {
  appUrl?: string;
  publicUrl?: string;
  docsUrl?: string;
  mcpUrl?: string;
};

export interface WebOrigins {
  app: string;
  public: string;
  docs: string;
  mcp: string;
}

export type WebHostRole = 'app' | 'public' | 'docs' | 'mcp';

export type WebHostRoutingDecision =
  | { action: 'pass'; roles: WebHostRole[] }
  | { action: 'rewrite'; roles: WebHostRole[]; path: string }
  | { action: 'redirect'; roles: WebHostRole[]; status: 308; target: string }
  | { action: 'reject'; roles: WebHostRole[]; status: 404 | 421 };

/**
 * Topologia pública do deploy. Os fallbacks mantêm instalações self-hosted de
 * origem única compatíveis: sem as novas variáveis, todas as superfícies seguem
 * vivendo sob BASE_URL, exatamente como antes.
 */
export function configuredWebOrigins(source: DomainConfig = config as DomainConfig): WebOrigins {
  const app = source.appUrl ?? source.baseUrl;
  const publicUrl = source.publicUrl ?? source.baseUrl;
  return {
    app,
    public: publicUrl,
    docs: source.docsUrl ?? publicUrl,
    mcp: source.mcpUrl ?? app,
  };
}

function requestHost(req: Request): string | undefined {
  const header = req.get?.('host') ?? req.headers.host;
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw || /[\s/\\]/.test(raw)) return undefined;
  try {
    return new URL(`http://${raw}`).host.toLowerCase();
  } catch {
    return undefined;
  }
}

function hostOf(origin: string): string {
  return new URL(origin).host.toLowerCase();
}

function isNavigation(req: Request): boolean {
  return req.method === 'GET' || req.method === 'HEAD';
}

function pathWithOriginalQuery(req: Request, pathname: string): string {
  const q = req.originalUrl.indexOf('?');
  return `${pathname}${q >= 0 ? req.originalUrl.slice(q) : ''}`;
}

function absoluteTarget(origin: string, req: Request, pathname = req.path): string {
  return `${origin}${pathWithOriginalQuery(req, pathname)}`;
}

function rolesForHost(host: string, origins: WebOrigins): WebHostRole[] {
  const entries: Array<[WebHostRole, string | undefined]> = [
    ['app', origins.app],
    ['public', origins.public],
    ['docs', origins.docs],
    ['mcp', origins.mcp],
  ];
  return entries.filter(([, origin]) => origin && hostOf(origin) === host).map(([role]) => role);
}

function wwwHost(origins: WebOrigins): string | undefined {
  const url = new URL(origins.public);
  if (url.hostname === 'localhost' || url.hostname.startsWith('www.') || /^[\d.:]+$/.test(url.hostname)) {
    return undefined;
  }
  const port = url.port ? `:${url.port}` : '';
  return `www.${url.hostname.toLowerCase()}${port}`;
}

function isSharedStaticPath(pathname: string): boolean {
  return (
    pathname === '/favicon-32.png' ||
    pathname === '/og.png' ||
    pathname === '/og-pt.png' ||
    pathname === '/og-en.png' ||
    pathname.startsWith('/assets/')
  );
}

function isPathPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isPathPrefixFolded(pathname: string, prefix: string): boolean {
  return isPathPrefix(pathname.toLowerCase(), prefix.toLowerCase());
}

function canonicalPrefixPath(pathname: string, prefix: string): string {
  const canonical = `${prefix}${pathname.slice(prefix.length)}`;
  return canonical === `${prefix}/` ? prefix : canonical;
}

function canonicalRouteKey(pathname: string): string {
  if (pathname === '/') return pathname;
  return pathname.replace(/\/+$/, '').toLowerCase() || '/';
}

/**
 * Decide a superfície ANTES de qualquer handler. Nenhum destino é montado a
 * partir do Host recebido: redirects usam somente origens já validadas em config.
 */
export function webHostRoutingDecision(req: Request, origins = configuredWebOrigins()): WebHostRoutingDecision {
  const host = requestHost(req);
  const pathname = req.path || '/';
  const apiPath = isPathPrefixFolded(pathname, '/api');

  // Probes internos do container não dependem do domínio público e nunca ganham
  // acesso às superfícies privadas por causa dessa exceção.
  if (
    (!host || rolesForHost(host, origins).length === 0) &&
    isLoopbackAddress(req.socket.remoteAddress) &&
    isPathPrefix(pathname, '/health')
  ) {
    return { action: 'pass', roles: [] };
  }

  if (!host) return { action: 'reject', roles: [], status: 421 };

  if (host === wwwHost(origins)) {
    // API nunca muda de origem por redirect, nem em GET/HEAD: isso evita perda
    // ou encaminhamento acidental do header Authorization.
    if (apiPath) return { action: 'reject', roles: [], status: 404 };
    if (!isNavigation(req)) return { action: 'reject', roles: [], status: 421 };
    return { action: 'redirect', roles: [], status: 308, target: absoluteTarget(origins.public, req) };
  }

  const roles = rolesForHost(host, origins);
  if (roles.length === 0) return { action: 'reject', roles, status: 421 };

  const has = (role: WebHostRole): boolean => roles.includes(role);
  const redirect = (target: string): WebHostRoutingDecision =>
    isNavigation(req) ? { action: 'redirect', roles, status: 308, target } : { action: 'reject', roles, status: 404 };

  if (isPathPrefix(pathname, '/health') || pathname === '/robots.txt' || pathname === '/sitemap.xml') {
    return { action: 'pass', roles };
  }
  if (isSharedStaticPath(pathname)) return { action: 'pass', roles };

  if (apiPath) {
    // Não canoniza API por redirect. Variante de caixa é rejeitada antes do
    // router para nunca mover bearer tokens entre URLs/origens.
    if (!isPathPrefix(pathname, '/api')) return { action: 'reject', roles, status: 404 };
    // Em origem única, o mesmo host acumula os papéis app+mcp. Em topologia
    // dividida, o host privado do app não aceita bearer da API MCP.
    return has('mcp') ? { action: 'pass', roles } : { action: 'reject', roles, status: 404 };
  }

  const authPath = isPathPrefixFolded(pathname, '/auth');
  if (authPath) {
    const canonicalPath = canonicalPrefixPath(pathname, '/auth');
    if (!isPathPrefix(pathname, '/auth')) return redirect(absoluteTarget(origins.app, req, canonicalPath));
    if (has('app')) return { action: 'pass', roles };
    return redirect(absoluteTarget(origins.app, req));
  }

  const appPath = isPathPrefixFolded(pathname, '/app');
  if (appPath) {
    const canonicalPath = canonicalPrefixPath(pathname, '/app');
    if (!isPathPrefix(pathname, '/app') || pathname === '/app/') {
      return redirect(absoluteTarget(origins.app, req, canonicalPath));
    }
    return has('app') ? { action: 'pass', roles } : redirect(absoluteTarget(origins.app, req));
  }

  const oldAppPath =
    isPathPrefix(pathname, '/gravacoes') || isPathPrefix(pathname, '/rec') || isPathPrefix(pathname, '/conectar-ia');
  if (oldAppPath && !has('app')) {
    const mapped = pathname.startsWith('/gravacoes')
      ? pathname.replace(/^\/gravacoes/, '/app')
      : pathname.startsWith('/rec')
        ? pathname.replace(/^\/rec/, '/app/rec')
        : pathname.replace(/^\/conectar-ia/, '/app/conectar-ia');
    return redirect(absoluteTarget(origins.app, req, mapped));
  }

  const routeKey = canonicalRouteKey(pathname);
  const docsPt = routeKey === '/docs';
  const docsEn = routeKey === '/en/docs';
  if (docsPt || docsEn) {
    const publicDocsPath = docsEn ? '/en/docs' : '/docs';
    if (has('docs') && has('public')) {
      return pathname === publicDocsPath
        ? { action: 'pass', roles }
        : redirect(absoluteTarget(origins.public, req, publicDocsPath));
    }
    const canonicalPath = docsEn ? '/en' : '/';
    return redirect(absoluteTarget(origins.docs, req, canonicalPath));
  }

  // Num host dedicado de docs, / e /en são aliases internos das rotas antigas.
  // Isso evita duplicar handlers e mantém self-hosters de origem única intactos.
  if (has('docs') && !has('public') && (routeKey === '/' || routeKey === '/en')) {
    const canonicalPath = routeKey === '/en' ? '/en' : '/';
    if (pathname !== canonicalPath) return redirect(absoluteTarget(origins.docs, req, canonicalPath));
    return {
      action: 'rewrite',
      roles,
      path: pathWithOriginalQuery(req, routeKey === '/en' ? '/en/docs' : '/docs'),
    };
  }

  const canonicalPublicPath = new Map<string, string>([
    ['/', '/'],
    ['/en', '/en'],
    ['/demo', '/demo'],
    ['/en/demo', '/en/demo'],
    ['/demo/audio', '/demo/audio'],
  ]).get(routeKey);
  if (canonicalPublicPath) {
    if (has('public')) {
      return pathname === canonicalPublicPath
        ? { action: 'pass', roles }
        : redirect(absoluteTarget(origins.public, req, canonicalPublicPath));
    }
    if (has('mcp') && canonicalPublicPath === '/') {
      return {
        action: 'redirect',
        roles,
        status: 308,
        target: `${origins.docs}/#mcp`,
      };
    }
    if (has('docs') && (canonicalPublicPath === '/' || canonicalPublicPath === '/en')) {
      // Coberto pelo rewrite acima; mantém o narrowing explícito para configs
      // incomuns onde a mesma origem acumule papéis adicionais.
      return { action: 'pass', roles };
    }
    if (has('mcp')) return { action: 'reject', roles, status: 404 };
    return redirect(absoluteTarget(origins.public, req, canonicalPublicPath));
  }

  // O host do MCP é uma superfície mínima: API + descoberta na raiz. Não deixa
  // handlers públicos/privados futuros vazarem por acidente.
  if (has('mcp') && roles.length === 1) return { action: 'reject', roles, status: 404 };

  return { action: 'pass', roles };
}

/** Confirma membership pela REST do Discord; cache local nunca autoriza a criação. */
export async function currentGuildMembership(
  userId: string,
  guilds: Iterable<MembershipGuild> = client.guilds.cache.values(),
  runCheck: FreshMembershipRunner = withFreshMembershipBudget,
): Promise<CurrentGuildMembership> {
  const savedCursor = membershipScanCursors.get(userId);
  const start = savedCursor?.index ?? 0;
  let unavailable = savedCursor?.unavailable ?? false;
  const iterator = guilds[Symbol.iterator]();
  let index = 0;
  while (index < start) {
    const skipped = iterator.next();
    if (skipped.done) {
      membershipScanCursors.delete(userId);
      return unavailable ? 'unavailable' : 'not-member';
    }
    index++;
  }
  while (index < start + MAX_MEMBERSHIP_GUILDS_PER_ATTEMPT) {
    const candidate = iterator.next();
    if (candidate.done) {
      membershipScanCursors.delete(userId);
      return unavailable ? 'unavailable' : 'not-member';
    }
    const guild = candidate.value;
    index++;
    try {
      await runCheck(userId, () => guild.members.fetch({ user: userId, force: true, cache: false }));
      membershipScanCursors.delete(userId);
      return 'member';
    } catch (err) {
      // O orçamento acabou antes deste fetch. Retoma exatamente daqui na
      // próxima janela em vez de condenar guilds depois da 60ª à fome eterna.
      if (err instanceof TransientAccessError) {
        rememberMembershipScanCursor(userId, { index: index - 1, unavailable });
        return 'unavailable';
      }
      const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
      if (code !== 10007 && code !== 10013) unavailable = true;
      rememberMembershipScanCursor(userId, { index, unavailable });
    }
  }
  rememberMembershipScanCursor(userId, { index, unavailable });
  return 'unavailable';
}

function configuredOriginForRequest(req: Request, origins = configuredWebOrigins()): string | undefined {
  const host = requestHost(req);
  if (!host) return undefined;
  if (host === wwwHost(origins)) return origins.public;
  const candidates = [origins.app, origins.public, origins.docs, origins.mcp];
  return candidates.find((origin) => hostOf(origin) === host);
}

/** Destino canônico para HTTP público; undefined mantém HTTPS e probes locais. */
export function httpsRedirectTarget(
  req: Request,
  baseUrl?: string,
  origins = configuredWebOrigins(),
): string | undefined {
  const canonicalOrigin = baseUrl ?? configuredOriginForRequest(req, origins);
  if (!canonicalOrigin?.startsWith('https://') || req.secure || isLoopbackAddress(req.socket.remoteAddress))
    return undefined;
  const requestPath = req.originalUrl.startsWith('/') ? req.originalUrl : '/';
  return `${canonicalOrigin}${requestPath}`;
}

export function isRateLimitedWebPath(pathname: string): boolean {
  return !/^\/(?:health|api)(?:\/|$)/i.test(pathname);
}

export function robotsForRoles(roles: WebHostRole[], origins = configuredWebOrigins()): string {
  if (roles.includes('public')) {
    return [
      'User-agent: *',
      'Allow: /',
      'Disallow: /app',
      'Disallow: /auth',
      'Disallow: /api',
      `Sitemap: ${origins.public}/sitemap.xml`,
      '',
    ].join('\n');
  }
  if (roles.includes('docs')) {
    return ['User-agent: *', 'Allow: /', `Sitemap: ${origins.docs}/sitemap.xml`, ''].join('\n');
  }
  return ['User-agent: *', 'Disallow: /', ''].join('\n');
}

export function sitemapForRoles(roles: WebHostRole[], origins = configuredWebOrigins()): string | undefined {
  let urls: string[] | undefined;
  if (roles.includes('public')) {
    urls = [`${origins.public}/`, `${origins.public}/en`, `${origins.public}/demo`, `${origins.public}/en/demo`];
    if (roles.includes('docs')) urls.push(`${origins.public}/docs`, `${origins.public}/en/docs`);
  } else if (roles.includes('docs')) {
    urls = [`${origins.docs}/`, `${origins.docs}/en`];
  }
  if (!urls) return undefined;
  const entries = urls.map((url) => `  <url><loc>${url}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

export function startWebServer(): void {
  const app = express();
  app.disable('x-powered-by');
  // O guard de host e o router precisam concordar: variantes como /API ou
  // /App/ não podem cair em handlers case-insensitive depois da classificação.
  app.set('case sensitive routing', true);
  app.set('strict routing', true);
  // Atrás do Cloudflare Tunnel (1 proxy): faz req.ip refletir o IP real do cliente,
  // pra o rate-limit por IP não ser burlado forjando X-Forwarded-For.
  app.set('trust proxy', 1);

  // A mesma aplicação atende quatro origens canônicas (e o alias www da landing),
  // mas cada uma expõe só sua superfície. A decisão acontece antes de rate-limit,
  // cookies e handlers para que Host desconhecido e chamadas no subdomínio errado
  // falhem fechados.
  app.use((req, res, next) => {
    const decision = webHostRoutingDecision(req);
    if (decision.action === 'reject') {
      res
        .status(decision.status)
        .type('text/plain')
        .send(decision.status === 421 ? 'Host não reconhecido.' : 'Not found.');
      return;
    }
    if (decision.action === 'redirect') {
      res.redirect(decision.status, decision.target);
      return;
    }
    if (decision.action === 'rewrite') req.url = decision.path;
    res.locals.webHostRoles = decision.roles;
    next();
  });

  // Cloudflare pode aceitar HTTP mesmo quando a origem canônica é HTTPS. O
  // destino é escolhido apenas entre as origens configuradas, nunca é montado a
  // partir do Host controlado pelo cliente; probes locais seguem em HTTP.
  app.use((req, res, next) => {
    const target = httpsRedirectTarget(req);
    if (target) {
      res.redirect(308, target);
      return;
    }
    next();
  });

  // Um nonce diferente por resposta libera apenas os scripts que os templates
  // marcaram deliberadamente. Conteúdo injetado com <script> não recebe nonce.
  app.use((_req, res, next) => {
    const nonce = createCspNonce();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', contentSecurityPolicy(nonce));
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (config.baseUrl.startsWith('https')) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    const originalSend = res.send;
    res.send = function (this: Response, body: Parameters<Response['send']>[0]): Response {
      const contentType = String(res.getHeader('Content-Type') ?? '');
      const securedBody =
        typeof body === 'string' && contentType.toLowerCase().startsWith('text/html')
          ? applyCspNonce(body, nonce)
          : body;
      return originalSend.call(this, securedBody);
    } as Response['send'];
    next();
  });

  // Limite global reconhecido pelo ecossistema Express/CodeQL. A API tem um
  // limiter próprio e os healthchecks precisam permanecer disponíveis para o
  // Docker; todas as demais rotas, inclusive landing, assets e OAuth, entram.
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      skip: (req) => !isRateLimitedWebPath(req.path),
      handler: (req, res) => {
        res.status(429).set('Retry-After', '30').send(MSG.tooManyRequests[pageLang(req)]);
      },
    }),
  );

  // Remove o cookie legado Path=/ e mantém apenas sessões registradas com jti.
  // Tokens antigos sem revogação server-side são encerrados no primeiro acesso.
  app.use('/app', (req, res, next) => {
    if ((req.headers.cookie ?? '').includes('kassinao_session=')) scopeWebSessionToApp(req, res);
    next();
  });

  // Health check público: só disponibilidade. Contagem de calls ativas e disco
  // são metadados operacionais privados (e não são necessários ao healthcheck).
  app.get('/health', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ ok: true, ready: isClientReady() });
  });

  app.get('/robots.txt', (_req, res) => {
    const roles = (res.locals.webHostRoles ?? []) as WebHostRole[];
    res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(robotsForRoles(roles));
  });

  app.get('/sitemap.xml', (_req, res) => {
    const roles = (res.locals.webHostRoles ?? []) as WebHostRole[];
    const sitemap = sitemapForRoles(roles);
    if (!sitemap) {
      res.status(404).end();
      return;
    }
    res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(sitemap);
  });

  // Fonte da interface servida localmente. Mantém a página independente de CDN
  // e permite cache imutável porque a versão do arquivo acompanha o lockfile.
  app.get('/assets/space-grotesk.woff2', (_req, res) => {
    res.type('font/woff2').set('Cache-Control', 'public, max-age=31536000, immutable').sendFile(SPACE_GROTESK_FONT);
  });
  app.get('/assets/kassinao-mark.png', (_req, res) => {
    res.type('png').set('Cache-Control', 'public, max-age=31536000, immutable').sendFile(BRAND_MARK);
  });
  app.get('/favicon-32.png', (_req, res) => {
    res.type('png').set('Cache-Control', 'public, max-age=86400').sendFile(FAVICON);
  });
  app.get('/assets/apple-touch-icon.png', (_req, res) => {
    res.type('png').set('Cache-Control', 'public, max-age=86400').sendFile(APPLE_TOUCH_ICON);
  });
  for (const [fileName, contentType] of PUBLIC_VISUALS) {
    app.get(`/assets/${fileName}`, (_req, res) => {
      const file = path.join(BRAND_DIR, fileName);
      if (!fs.existsSync(file)) {
        res.status(404).end();
        return;
      }
      res.type(contentType).set('Cache-Control', 'public, max-age=31536000, immutable').sendFile(file);
    });
  }

  // Diagnóstico usado antes de deploy/restart, acessível só DENTRO do container
  // (`docker exec ... fetch(localhost/health/details)`). Mantém o stop seguro sem
  // anunciar ao mundo se há uma call ativa nem quanto disco resta.
  app.get('/health/details', (req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.status(404).end();
      return;
    }
    res
      .set('Cache-Control', 'no-store')
      .json({ ok: true, ready: isClientReady(), freeMB: freeMB(), activeRecordings: sessionManager.all().length });
  });

  // Persiste a escolha de idioma (?lang=en|pt) num cookie de 1 ano.
  app.use((req, res, next) => {
    const q = localeFromValue(req.query.lang);
    if (q) res.append('Set-Cookie', localeCookie(q, config.baseUrl.startsWith('https')));
    next();
  });

  // A superfície privada nunca deve ficar no cache do navegador/proxy. Isso
  // inclui HTML, áudio, downloads e OAuth: sair e apertar "voltar" não pode
  // ressuscitar transcrição/ata de uma página cacheada.
  const privateNoStore = (_req: Request, res: Response, next: NextFunction): void => {
    res.set('Cache-Control', 'private, no-store, max-age=0').set('Pragma', 'no-cache');
    next();
  };
  app.use('/app', privateNoStore);
  app.use('/auth', privateNoStore);
  app.use('/app', (req, res, next) => {
    const locale = pageLang(req);
    res.set('Content-Language', locale === 'pt' ? 'pt-BR' : 'en');
    next();
  });

  // SameSite=Lax não basta contra um subdomínio irmão comprometido (same-site).
  // Toda mutação web autenticada exige o Origin exato do Kassinão quando o
  // navegador o envia; requests cross-site são recusados antes do handler.
  app.use('/app', (req: Request, res: Response, next: NextFunction) => {
    if (!isAllowedWebMutation(req)) {
      res.status(403).type('text/plain').send('Origem inválida / invalid origin.');
      return;
    }
    next();
  });

  // API do MCP (/api/*) — só monta quando MCP_SECRET está definido (opt-in).
  mountMcpApi(app);

  // ---------- separação site × app ----------
  // Tudo que é PRIVADO (gravações, conector, gestão) vive sob /app/* — um
  // namespace só, nunca linkado do markup público. Os caminhos ANTIGOS
  // (/gravacoes, /rec/:id, /conectar-ia) já foram enviados em mensagens do
  // Discord e salvos em favoritos: redirect PERMANENTE (308 preserva o método),
  // a proteção continua sendo login+checkAccess no destino.
  const legacyRedirect = (from: string, to: string) => {
    app.use(from, (req: Request, res: Response) => {
      res.redirect(308, to + (req.url === '/' ? '' : req.url));
    });
  };
  legacyRedirect('/gravacoes', '/app');
  legacyRedirect('/rec', '/app/rec');
  legacyRedirect('/conectar-ia', '/app/conectar-ia');

  // Página de onboarding do conector MCP (self-serve por usuário logado).
  if (config.mcpEnabled) {
    app.get('/app/conectar-ia', (req, res) => {
      const l = pageLang(req);
      const user = getWebUser(req);
      const q = String(req.query.revoked ?? '');
      res.type('html').send(
        connectPage({
          lang: l,
          user,
          sessions: user ? listUserSessions(user.id) : undefined,
          revoked: q === '1' ? 'all' : q === 'one' ? 'one' : undefined,
        }),
      );
    });

    app.post(
      '/app/conectar-ia/gerar',
      express.urlencoded({ extended: false, limit: '2kb' }),
      async (req, res, next) => {
        try {
          const l = pageLang(req);
          const user = getWebUser(req);
          if (!user) {
            // POST sem sessão (expirada/adulterada) volta para a tela canônica;
            // o GET oferece o login sem iniciar OAuth a partir de uma mutação.
            res.redirect(303, '/app/conectar-ia');
            return;
          }
          if (notReady(res, l, user)) return;
          if (mcpConnectionCreationRateLimited(user.id)) {
            res
              .status(429)
              .set('Retry-After', '30')
              .type('html')
              .send(messagePage(MSG.errorTitle[l], MSG.tooManyRequests[l], user, l));
            return;
          }
          const membership = await currentGuildMembership(user.id);
          if (membership === 'unavailable') {
            res
              .status(503)
              .set('Retry-After', '5')
              .type('html')
              .send(messagePage(MSG.startingTitle[l], MSG.starting[l], user, l));
            return;
          }
          if (membership === 'not-member') {
            res
              .status(403)
              .type('html')
              .send(messagePage(MSG.mcpMembershipTitle[l], MSG.mcpMembership[l], user, l));
            return;
          }
          // apelido opcional ("Claude do notebook") — só exibição na lista de gestão
          const label = String((req.body as Record<string, unknown>)?.label ?? '')
            .trim()
            .slice(0, 40);
          // O navegador recebe só um código descartável. O refresh token nasce na
          // troca feita pelo conector e vai direto ao cofre local, nunca ao HTML/config.
          let exchangeCode: string;
          try {
            exchangeCode = createExchangeCode(user.id, user.name, label);
          } catch (err) {
            if (!(err instanceof McpExchangeCodeCapacityError)) throw err;
            res
              .status(503)
              .set('Retry-After', '60')
              .type('html')
              .send(messagePage(MSG.mcpCapacityTitle[l], MSG.mcpCapacity[l], user, l));
            return;
          }
          console.log(
            `MCP: código de conexão criado para ${cleanInline(user.name)} (${cleanInline(user.id)}) via web${label ? ` — "${cleanInline(label)}"` : ''}.`,
          );
          res
            .set('Cache-Control', 'no-store')
            .type('html')
            .send(connectPage({ lang: l, user, exchangeCode, label }));
        } catch (err) {
          next(err);
        }
      },
    );

    // revoga UMA conexão — só do próprio usuário (revokeUserSession valida o dono)
    app.post('/app/conectar-ia/revogar/:sid', (req, res) => {
      const user = getWebUser(req);
      if (!user) {
        beginLogin(res, '/app/conectar-ia');
        return;
      }
      const ok = revokeUserSession(user.id, req.params.sid);
      // cleanInline também no sid: vem da URL (controlado pelo cliente) — mesmo
      // sendo logado só quando pertence ao usuário, não entra cru no log
      if (ok)
        console.log(
          `MCP: sessão ${cleanInline(req.params.sid)} revogada por ${cleanInline(user.name)} (${cleanInline(user.id)}) via web.`,
        );
      res.redirect(ok ? '/app/conectar-ia?revoked=one' : '/app/conectar-ia');
    });

    app.post('/app/conectar-ia/revogar', (req, res) => {
      const user = getWebUser(req);
      if (!user) {
        beginLogin(res, '/app/conectar-ia');
        return;
      }
      const n = revokeUser(user.id);
      console.log(`MCP: ${n} sessão(ões) revogada(s) por ${cleanInline(user.name)} (${cleanInline(user.id)}) via web.`);
      res.redirect('/app/conectar-ia?revoked=1');
    });

    // A página do token é resposta direta de POST; o toggle EN/PT do topo faz
    // GET ?lang=… na MESMA URL. Sem este fallback seria um 404 cru do Express —
    // e a página de exibição única sumiria. O cookie de idioma já foi salvo
    // pelo middleware; volta pra página canônica (novo token = gerar de novo).
    app.get(['/app/conectar-ia/gerar', '/app/conectar-ia/revogar', '/app/conectar-ia/revogar/:sid'], (_req, res) => {
      res.redirect('/app/conectar-ia');
    });
  }

  const sendPublicPage = (res: Response, locale: Locale, html: string): void => {
    res
      .append('Set-Cookie', localeCookie(locale, config.baseUrl.startsWith('https')))
      .set('Content-Language', locale === 'pt' ? 'pt-BR' : 'en')
      .type('html')
      .send(html);
  };

  app.get('/', (req, res) => {
    if (localeFromValue(req.query.lang) === 'en') {
      res.redirect(302, '/en');
      return;
    }
    sendPublicPage(res, 'pt', landingPage('pt'));
  });

  app.get('/en', (_req, res) => {
    sendPublicPage(res, 'en', landingPage('en'));
  });

  app.get('/docs', (req, res) => {
    if (localeFromValue(req.query.lang) === 'en') {
      res.redirect(302, '/en/docs');
      return;
    }
    sendPublicPage(res, 'pt', docsPage('pt'));
  });

  app.get('/en/docs', (_req, res) => {
    sendPublicPage(res, 'en', docsPage('en'));
  });

  // A demo pública usa somente o fixture fictício versionado em docs/example.
  // Gravações reais continuam exclusivamente sob /app/*, com login e checkAccess.
  const demoDir = path.join(process.cwd(), 'docs', 'example');
  const readDemo = (
    locale: Locale,
  ): {
    meta: RecordingMeta;
    transcript: TranscriptSegment[];
    minutes: ReturnType<typeof readMinutes>;
  } | null => {
    try {
      return {
        meta: JSON.parse(fs.readFileSync(path.join(demoDir, 'meta.json'), 'utf8')) as RecordingMeta,
        transcript: JSON.parse(
          fs.readFileSync(path.join(demoDir, locale === 'pt' ? 'transcript.pt.json' : 'transcript.json'), 'utf8'),
        ),
        minutes: JSON.parse(
          fs.readFileSync(path.join(demoDir, locale === 'pt' ? 'minutes.pt.json' : 'minutes.json'), 'utf8'),
        ),
      };
    } catch {
      return null;
    }
  };

  const sendDemo = (res: Response, locale: Locale): void => {
    const demo = readDemo(locale);
    if (!demo) {
      res
        .status(404)
        .type('html')
        .send(messagePage(MSG.notFoundTitle[locale], MSG.notFound[locale], undefined, locale));
      return;
    }
    sendPublicPage(
      res,
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
  };

  app.get('/demo', (req, res) => {
    if (localeFromValue(req.query.lang) === 'en') {
      res.redirect(302, '/en/demo');
      return;
    }
    sendDemo(res, 'pt');
  });

  app.get('/en/demo', (_req, res) => {
    sendDemo(res, 'en');
  });

  app.get('/demo/audio', (_req, res) => {
    const sample = path.join(demoDir, 'sample-audio.mp3');
    if (!fs.existsSync(sample)) {
      res.status(404).send('sem áudio de amostra');
      return;
    }
    res.type('audio/mpeg').set('Cache-Control', 'public, max-age=86400').sendFile(sample);
  });

  // Cartão de social share (Open Graph / Twitter) da landing.
  app.get('/og.png', (_req, res) => {
    const f = path.join(process.cwd(), 'docs', 'og.png');
    if (!fs.existsSync(f)) {
      res.status(404).send('sem og');
      return;
    }
    res.type('png').set('Cache-Control', 'public, max-age=86400').sendFile(f);
  });
  const sendLocalizedOpenGraph = (res: Response, locale: Locale): void => {
    const f = path.join(process.cwd(), 'docs', locale === 'pt' ? 'og-pt.png' : 'og-en.png');
    if (!fs.existsSync(f)) {
      res.status(404).send(locale === 'pt' ? 'imagem social indisponível' : 'social image unavailable');
      return;
    }
    res.type('png').set('Cache-Control', 'public, max-age=86400').sendFile(f);
  };
  app.get('/og-pt.png', (_req, res) => {
    sendLocalizedOpenGraph(res, 'pt');
  });
  app.get('/og-en.png', (_req, res) => {
    sendLocalizedOpenGraph(res, 'en');
  });

  app.get('/auth/login', (req, res) => {
    beginLogin(res, String(req.query.next ?? '/'));
  });

  // Compatibilidade com favoritos antigos: GET nunca muda estado nem encerra a
  // sessão (evita logout CSRF). O controle novo usa POST dentro de /app.
  app.get('/auth/logout', (_req, res) => {
    res.redirect(303, '/app');
  });

  app.get('/auth/callback', async (req, res) => {
    const l = pageLang(req);
    try {
      const next = await finishLogin(req, res);
      if (!next) {
        res
          .status(400)
          .type('html')
          .send(messagePage(MSG.loginFailTitle[l], MSG.loginFail[l], undefined, l));
        return;
      }
      res.redirect(next);
    } catch (err) {
      console.error('Erro no callback OAuth:', err);
      res
        .status(500)
        .type('html')
        .send(messagePage(MSG.errorTitle[l], MSG.loginError[l], undefined, l));
    }
  });

  // A rota vive em /app para o cookie Path=/app viajar na requisição e para
  // herdar a proteção de Origin/Sec-Fetch aplicada a todas as mutações privadas.
  app.post('/app/logout', (req, res) => {
    logoutWeb(req, res);
    res.redirect(303, '/');
  });

  /** Home do app ("minhas gravações"): tudo que ESTA pessoa pode abrir, em todos
   *  os guilds — painel de GESTÃO: totais de disco (só OWNER_IDS), ordenação e ações. */
  app.get('/app', async (req, res) => {
    const l = pageLang(req);
    const q = String(req.query.q ?? '')
      .trim()
      .slice(0, 100);
    const rawCursor = req.query.cursor;
    const requestedSort = String(req.query.sort ?? 'recent');
    if (rawCursor !== undefined && !isOpaqueCursorToken(rawCursor)) {
      res
        .status(400)
        .type('html')
        .send(
          messagePage(
            MSG.errorTitle[l],
            l === 'pt'
              ? 'Esta continuação é inválida ou expirou. Volte ao início do arquivo.'
              : 'This continuation is invalid or expired. Return to the start of the archive.',
            undefined,
            l,
          ),
        );
      return;
    }
    const user = getWebUser(req);
    if (!user) {
      // next reconstruído de partes VALIDADAS (nunca originalUrl cru).
      const next = new URLSearchParams();
      if (q) next.set('q', q);
      if (['recent', 'oldest', 'largest'].includes(requestedSort) && requestedSort !== 'recent')
        next.set('sort', requestedSort);
      if (rawCursor) next.set('cursor', rawCursor);
      beginLogin(res, next.size ? `/app?${next.toString()}` : '/app');
      return;
    }
    if (notReady(res, l, user)) return;
    if (q && webHeavyReadRateLimited(user.id)) {
      res
        .status(429)
        .set('Retry-After', '30')
        .type('html')
        .send(messagePage(MSG.errorTitle[l], MSG.tooManyRequests[l], user, l));
      return;
    }
    // O cursor é cifrado e autenticado com o usuário e a consulta efetiva como
    // AAD. Reutilização entre contas/filtros e adulteração falham com 400.
    const owner = config.ownerIds.includes(user.id);
    const sort: RecordingsSort =
      requestedSort === 'oldest' ? 'oldest' : requestedSort === 'largest' && owner ? 'largest' : 'recent';
    const cursorContext = JSON.stringify({ q, sort });
    let cursor: MetaTimelineCursor | undefined;
    try {
      cursor = parseWebLibraryCursor(rawCursor, user.id, cursorContext);
    } catch (err) {
      if (!(err instanceof OpaqueCursorError)) throw err;
      res
        .status(400)
        .type('html')
        .send(
          messagePage(
            MSG.errorTitle[l],
            l === 'pt'
              ? 'Esta continuação é inválida ou expirou. Volte ao início do arquivo.'
              : 'This continuation is invalid or expired. Return to the start of the archive.',
            user,
            l,
          ),
        );
      return;
    }
    // mesma regra da página individual (checkAccess) aplicada meta a meta. A
    // confirmação REST é deduplicada só durante este request. O cursor avança
    // pelas candidatas, não só pelas autorizadas, para nenhuma faixa do arquivo
    // ficar permanentemente escondida atrás de ruído recente.
    const candidatePage = listMetaIdsPage(cursor, MAX_WEB_LIBRARY_CANDIDATES_PER_PAGE);
    const candidates = candidatePage.ids.flatMap((id) => {
      const meta = readMeta(id);
      if (!meta) return [];
      return [meta];
    });
    let library: WebLibraryPage;
    try {
      library = await collectWebLibraryPage(user, candidates);
    } catch (err) {
      if (!(err instanceof TransientAccessError)) throw err;
      sendAccessTemporarilyUnavailable(res, l, user);
      return;
    }
    const lastProcessed =
      library.nextCursor !== undefined && library.nextCursor > 0 ? candidates[library.nextCursor - 1] : undefined;
    const nextTimelineCursor = lastProcessed
      ? { startedAt: lastProcessed.startedAt, id: lastProcessed.id }
      : candidatePage.nextCursor;
    const nextCursor = nextTimelineCursor
      ? encodeWebLibraryCursor(nextTimelineCursor, user.id, cursorContext)
      : undefined;
    const items: RecordingIndexItem[] = library.items.map(({ meta, canDelete }) => ({
      meta,
      canDelete,
      audioBytes: owner ? audioBytesOf(meta.id) : undefined,
    }));
    // A busca usa sempre as 100 mais recentes, independentemente da ordenação
    // escolhida para a biblioteca. Ordenar por antigas/tamanho não pode mudar
    // silenciosamente o universo pesquisado.
    const searchableMetas = items.slice(0, 100).map((item) => item.meta);
    // ordenação server-side; "maiores" precisa dos bytes, então é só pro dono
    if (sort === 'oldest') items.sort((a, b) => a.meta.startedAt - b.meta.startedAt);
    else if (sort === 'largest') items.sort((a, b) => (b.audioBytes ?? 0) - (a.audioBytes ?? 0));
    // busca lê transcript.json (síncrono) — limita às 100 mais recentes pra não
    // segurar o event loop (que também recebe o áudio das gravações ao vivo)
    const hits = q ? searchRecordings(searchableMetas, q) : undefined;
    const flash = req.query.freed === '1' ? MSG.freedFlash[l] : req.query.deleted === '1' ? MSG.deletedFlash[l] : '';
    res.type('html').send(
      recordingsIndexPage(items, {
        user,
        lang: l,
        q,
        hits,
        owner,
        freeDiskMB: owner ? freeMB() : undefined,
        sort,
        flash,
        nextCursor,
        hasPreviousPage: !!cursor,
      }),
    );
  });

  app.get('/app/rec/:id', async (req, res) => {
    const l = pageLang(req);
    // login ANTES de checar existência: não vaza quais IDs existem a quem não logou
    const user = getWebUser(req);
    if (!user) {
      beginLogin(res, `/app/rec/${req.params.id}`);
      return;
    }
    if (notReady(res, l, user)) return;
    const meta = readMeta(req.params.id);
    if (!meta) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    const access = await checkAccess(user, meta);
    if (!access.view) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    const live = meta.status === 'recording' && sessionManager.get(meta.guildId)?.id === meta.id;
    let transcript: TranscriptSegment[] | undefined;
    let transcriptNotice: string | undefined;
    if (transcriptReady(meta)) {
      if (webHeavyReadRateLimited(user.id)) {
        res
          .status(429)
          .set('Retry-After', '30')
          .type('html')
          .send(messagePage(MSG.errorTitle[l], MSG.tooManyRequests[l], user, l));
        return;
      }
      const bounded = readTranscriptBounded(meta.id, WEB_DIRECT_TRANSCRIPT_MAX_BYTES);
      if (bounded.status === 'ok' && bounded.segments.length <= WEB_DIRECT_TRANSCRIPT_MAX_SEGMENTS) {
        transcript = bounded.segments;
      } else {
        transcriptNotice = bounded.status === 'unavailable' ? MSG.transcriptUnavailable[l] : MSG.transcriptTooLarge[l];
      }
    }
    let minutes: ReturnType<typeof readMinutes>;
    let minutesNotice: string | undefined;
    if (meta.minutes?.status === 'done') {
      const result = readMinutesBounded(meta.id);
      if (result.status === 'ok') minutes = result.minutes;
      else minutesNotice = result.status === 'too_large' ? MSG.minutesTooLarge[l] : MSG.minutesUnavailable[l];
    }
    res.type('html').send(
      recordingPage(meta, {
        live,
        canDelete: access.delete,
        user,
        lang: l,
        transcript,
        transcriptNotice,
        minutes,
        minutesNotice,
      }),
    );
  });

  app.get('/app/rec/:id/audio', async (req, res) => {
    const l = pageLang(req);
    const user = getWebUser(req);
    if (!user) {
      beginLogin(res, `/app/rec/${req.params.id}`);
      return;
    }
    if (notReady(res, l, user)) return;
    const meta = readMeta(req.params.id);
    if (!meta) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    // checkAccess ANTES de qualquer checagem de estado (ao-vivo) — não vaza a
    // quem não tem acesso se a gravação existe/está ao vivo (oráculo de enumeração).
    const access = await checkAccess(user, meta);
    if (!access.view) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    if (meta.participants.length === 0) {
      res.status(404).send(MSG.noAudio[l]);
      return;
    }
    // ao vivo: o mix seria parcial e não-cacheável (re-cozinha a cada hit) — bloqueia
    const live = meta.status === 'recording' && sessionManager.get(meta.guildId)?.id === meta.id;
    if (live) {
      res.status(409).send(MSG.recordingInProgress[l]);
      return;
    }
    // retenção em camadas: o áudio pode já ter expirado (texto continua na página)
    if (meta.audioDeleted) {
      res.status(410).send(MSG.audioExpired[l]);
      return;
    }
    // marca ANTES do cook (que pode levar minutos): delete/cleanup não apagam no meio
    beginDownload(meta.id);
    try {
      const result = await cook(meta, 'mix'); // mp3 único, cacheado após o 1º
      // sendFile já trata Range (seek do player) e Content-Type por extensão
      res.sendFile(result.filePath, (err?: Error) => {
        endDownload(meta.id);
        if (err && !res.headersSent) res.status(500).end();
      });
    } catch (err) {
      endDownload(meta.id);
      if (err instanceof CookBusyError) {
        res.status(503).set('Retry-After', '20').send(MSG.processingBusy[l]);
        return;
      }
      console.error(`Erro servindo áudio ${meta.id}:`, err);
      res.status(500).send(MSG.audioPrepareError[l]);
    }
  });

  app.get('/app/rec/:id/ata.md', async (req, res) => {
    const l = pageLang(req);
    const user = getWebUser(req);
    if (!user) {
      beginLogin(res, `/app/rec/${req.params.id}`);
      return;
    }
    if (notReady(res, l, user)) return;
    const meta = readMeta(req.params.id);
    if (!meta) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    // checkAccess ANTES de olhar o estado da ata — senão vaza a terceiros se a ata já ficou pronta
    const access = await checkAccess(user, meta);
    if (!access.view) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    if (meta.minutes?.status !== 'done') {
      res
        .status(404)
        .type('html')
        .send(messagePage(MSG.notFoundTitle[l], MSG.notFound[l], user, l));
      return;
    }
    const result = readMinutesBounded(meta.id);
    if (result.status === 'too_large') {
      res.status(413).set('X-Kassinao-Max-Bytes', String(MAX_MINUTES_BYTES)).send(MSG.minutesTooLarge[l]);
      return;
    }
    if (result.status === 'unavailable') {
      res.status(503).set('Retry-After', '30').send(MSG.minutesUnavailable[l]);
      return;
    }
    const bounded = boundMinutesForResponse(result.minutes);
    if (bounded.truncated) {
      res.status(413).send(MSG.minutesResponseLimit[l]);
      return;
    }
    res
      .type('text/markdown; charset=utf-8')
      .attachment(`kassinao-${meta.id}-ata.md`)
      .send(minutesToMarkdown(meta, bounded.minutes));
  });

  app.get('/app/rec/:id/transcricao.:ext(md|txt)', async (req, res) => {
    const l = pageLang(req);
    const user = getWebUser(req);
    if (!user) {
      beginLogin(res, `/app/rec/${req.params.id}`);
      return;
    }
    if (notReady(res, l, user)) return;
    const meta = readMeta(req.params.id);
    if (!meta) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    // checkAccess ANTES do estado da transcrição — não vaza a terceiros se já ficou pronta
    const access = await checkAccess(user, meta);
    if (!access.view) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    if (!transcriptReady(meta)) {
      res
        .status(404)
        .type('html')
        .send(messagePage(MSG.notFoundTitle[l], MSG.notFound[l], user, l));
      return;
    }
    if (webHeavyReadRateLimited(user.id)) {
      res.status(429).set('Retry-After', '30').send(MSG.tooManyRequests[l]);
      return;
    }
    const transcript = readTranscriptBounded(meta.id, WEB_DIRECT_TRANSCRIPT_MAX_BYTES);
    if (
      transcript.status === 'too_large' ||
      (transcript.status === 'ok' && transcript.segments.length > WEB_DIRECT_TRANSCRIPT_MAX_SEGMENTS)
    ) {
      res.status(413).send(MSG.transcriptTooLarge[l]);
      return;
    }
    if (transcript.status === 'unavailable') {
      res.status(503).set('Retry-After', '30').send(MSG.transcriptUnavailable[l]);
      return;
    }
    const markdown = transcriptToMarkdown(meta, transcript.segments);
    const ext = req.params.ext;
    res
      .type(ext === 'md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8')
      .attachment(`kassinao-${meta.id}-transcricao.${ext}`)
      .send(ext === 'md' ? markdown : markdown.replace(/[*#`]/g, ''));
  });

  app.get('/app/rec/:id/download/:format', async (req, res) => {
    const l = pageLang(req);
    const user = getWebUser(req);
    if (!user) {
      beginLogin(res, `/app/rec/${req.params.id}`);
      return;
    }
    if (notReady(res, l, user)) return;
    const format = req.params.format as CookFormat;
    if (!COOK_FORMATS.includes(format)) {
      res.status(400).send(MSG.invalidFormat[l]);
      return;
    }
    const meta = readMeta(req.params.id);
    if (!meta) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    const access = await checkAccess(user, meta);
    if (!access.view) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    // ao vivo: cada formato cozinharia um snapshot completo dos masters (sem dedupe
    // entre formatos), enchendo o disco. Bloqueia igual à rota /audio até encerrar.
    const live = meta.status === 'recording' && sessionManager.get(meta.guildId)?.id === meta.id;
    if (live) {
      res.status(409).send(MSG.downloadAfterStop[l]);
      return;
    }
    if (meta.audioDeleted) {
      res.status(410).send(MSG.audioExpiredTextKept[l]);
      return;
    }
    // marca ANTES do cook: o processamento (minutos, em gravações longas) já
    // conta como download em andamento, então delete/cleanup não apagam no meio
    beginDownload(meta.id);
    try {
      const result = await cook(meta, format);
      res.download(result.filePath, result.fileName, () => endDownload(meta.id));
    } catch (err) {
      endDownload(meta.id);
      if (err instanceof CookBusyError) {
        res
          .status(503)
          .set('Retry-After', '20')
          .type('html')
          .send(messagePage(MSG.cookErrorTitle[l], MSG.cookError[l], user, l));
        return;
      }
      console.error(`Erro processando download ${meta.id}/${format}:`, err);
      res
        .status(500)
        .type('html')
        .send(messagePage(MSG.cookErrorTitle[l], MSG.cookError[l], user, l));
    }
  });

  /**
   * "Liberar espaço": apaga SÓ o áudio (tracks + cache), mantém transcrição/ata/notas.
   * O par da retenção ilimitada — a memória fica, os gigas voltam. Mesmas guardas do
   * delete (permissão, ao-vivo, download/transcrição em andamento).
   */
  // Mesmo caso do /gerar: as respostas de POST (delete/liberar e seus 403/409)
  // exibem o toggle EN/PT, que faz GET ?lang=… na URL do POST. Fallback: volta
  // pra página da gravação (ou pro índice, se ela já não existir).
  app.get(['/app/rec/:id/delete', '/app/rec/:id/liberar-audio'], (req, res) => {
    res.redirect(`/app/rec/${encodeURIComponent(req.params.id)}`);
  });

  app.post('/app/rec/:id/liberar-audio', async (req, res) => {
    const l = pageLang(req);
    const user = getWebUser(req);
    if (!user) {
      beginLogin(res, `/app/rec/${req.params.id}`);
      return;
    }
    if (notReady(res, l, user)) return;
    const meta = readMeta(req.params.id);
    if (!meta) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    const access = await checkAccess(user, meta, { freshMember: true });
    if (!access.delete) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    if (meta.status === 'recording') {
      res
        .status(409)
        .type('html')
        .send(messagePage(MSG.freeLiveTitle[l], MSG.freeLive[l], user, l));
      return;
    }
    if (hasActiveDownloads(meta.id) || isTranscribing(meta.id) || transcriptionNeedsAudio(meta)) {
      res
        .status(409)
        .type('html')
        .send(messagePage(MSG.freeBusyTitle[l], MSG.freeBusy[l], user, l));
      return;
    }
    if (meta.audioDeleted) {
      // idempotente: dois cliques/abas não viram erro assustador
      res.type('html').send(messagePage(MSG.freeGoneTitle[l], MSG.freeGone[l], user, l));
      return;
    }
    deleteAudioOnly(meta);
    // cleanInline: nome vem do Discord (controlado pelo usuário) — sem quebra de
    // linha/ANSI forjando entradas de log (log injection)
    console.log(`Áudio da gravação ${meta.id} liberado por ${cleanInline(user.name)} (${cleanInline(user.id)}).`);
    res.redirect(req.query.back === 'index' ? '/app?freed=1' : `/app/rec/${meta.id}`);
  });

  app.post('/app/rec/:id/delete', async (req, res) => {
    const l = pageLang(req);
    const user = getWebUser(req);
    if (!user) {
      beginLogin(res, `/app/rec/${req.params.id}`);
      return;
    }
    if (notReady(res, l, user)) return;
    const meta = readMeta(req.params.id);
    if (!meta) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    const access = await checkAccess(user, meta, { freshMember: true });
    if (!access.delete) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    if (meta.status === 'recording') {
      res
        .status(409)
        .type('html')
        .send(messagePage(MSG.deleteLiveTitle[l], MSG.deleteLive[l], user, l));
      return;
    }
    if (hasActiveDownloads(meta.id) || isTranscribing(meta.id)) {
      res
        .status(409)
        .type('html')
        .send(messagePage(MSG.deleteBusyTitle[l], MSG.deleteBusy[l], user, l));
      return;
    }
    deleteRecording(meta.id);
    forgetAudioBytes(meta.id);
    console.log(`Gravação ${meta.id} apagada por ${cleanInline(user.name)} (${cleanInline(user.id)}).`);
    // veio do índice de gestão → volta pra lá (com flash); da página → mensagem clássica
    if (req.query.back === 'index') {
      res.redirect('/app?deleted=1');
      return;
    }
    res.type('html').send(messagePage(MSG.deletedTitle[l], MSG.deleted[l], user, l));
  });

  app.listen(config.port, () => {
    console.log(`Servidor web em ${config.baseUrl} (porta ${config.port})`);
  });
}
