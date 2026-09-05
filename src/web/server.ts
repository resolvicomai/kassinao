import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import path from 'node:path';
import express, { Express, NextFunction, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { config } from '../config';
import { freeMB } from '../disk';
import { client } from '../discord/client';
import { isClientReady } from '../discord/ready';
import { Locale } from '../i18n';
import { operationalError, operationalPii } from '../operationalLog';
import { cook, CookBusyError, CookFormat, COOK_FORMATS } from '../processing/cook';
import { isTranscribing, retryMinutes, transcriptToMarkdown } from '../processing/transcribe';
import { minutesToMarkdown } from '../processing/minutes';
import { getProcessingProgress } from '../processing/progress';
import { getRemoteDeletionSummary } from '../processing/remoteDeletion';
import { evaluateBackupHeartbeat, readBackupHeartbeat } from '../backupHeartbeat';
import {
  contextRuntime,
  syncContextMeeting,
  withContextAccess,
  upcomingContextEvents,
  listAuthorizedContextChannels,
  contextDeliveryStatus,
} from '../context';
import {
  CommitmentAccessError,
  CommitmentConflictError,
  CommitmentInputError,
  CommitmentAuthorizationUnavailableError,
  CommitmentStatus,
} from '../commitments';
import { retryMinutesWebhook, enqueueMinutesWebhook } from '../minutesWebhook';
import { sessionManager } from '../recorder/manager';
import { MAX_MINUTES_BYTES } from '../securityLimits';
import { isLoopbackAddress } from '../util';
import {
  audioBytesOf,
  boundMinutesForResponse,
  deleteAudioOnly,
  deleteRecording,
  forgetAudioBytes,
  listMetaIdsPage,
  listMetas,
  MetaTimelineCursor,
  copyMeta,
  peekMeta,
  readMeta,
  saveMeta,
  readMinutes,
  readMinutesBounded,
  readTranscriptBounded,
  RecordingMeta,
  TranscriptSegment,
  MinutesSource,
  transcriptionNeedsAudio,
  transcriptReady,
} from '../store';
import {
  checkAccess,
  createAccessRequestContext,
  currentGuildMembership,
  recordingIdentityGrant,
  TransientAccessError,
} from './access';
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
import {
  applyCspNonce,
  contentSecurityPolicy,
  createCspNonce,
  referrerPolicyForPath,
  WEB_REFERRER_POLICY,
} from './csp';
import {
  consumeStagedExchangeCode,
  createExchangeCode,
  listUserSessions,
  McpExchangeCodeCapacityError,
  revokeUser,
  revokeUserSession,
  stageExchangeCodeForDisplay,
} from './mcpTokens';
import {
  connectPage,
  contextPage,
  operationPage,
  messagePage,
  recordingPage,
  RecordingIndexItem,
  recordingsIndexPage,
  RecordingsSort,
  privateAccessPage,
} from './page';
import { landingPage } from './landing';
import { docsPage } from './docs';
import { privacyPage } from './privacy';
import { searchRecordingsWithCoverage } from './search';
import { localeCookie, localeFromValue, resolveWebLocale } from './site';
import { acquireDownload, hasActiveDownloads } from './tracker';
import { isOpaqueCursorToken, OpaqueCursorError, openOpaqueCursor, sealOpaqueCursor } from './opaqueCursor';
import { revokeWebSessionsForUser } from './webSessions';
import { McpScopeError, normalizeMcpSessionOptions } from './mcpScope';
import { resolveDeadline } from '../deadlines';
import { suggestArtifactLinks } from '../integrations/suggestions';
import { operationsSummaryRows } from '../operationsSummary';
// Re-export usado pelos testes de membership (a API importa direto de ./access).
export { currentGuildMembership } from './access';

const decisionRevision = (text: string, source: MinutesSource): string =>
  createHash('sha256')
    .update(JSON.stringify([text, source.quote, source.startMs, source.endMs]))
    .digest('hex');

const SPACE_GROTESK_FONT =
  require.resolve('@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2');
const BRAND_DIR = path.join(process.cwd(), 'docs', 'brand');
const BRAND_MARK = path.join(BRAND_DIR, 'kassinao-mark-64.png');
const FAVICON = path.join(BRAND_DIR, 'favicon-32.png');
const APPLE_TOUCH_ICON = path.join(BRAND_DIR, 'apple-touch-icon-180.png');
const PUBLIC_VISUALS = [
  ['discord-demo-pt-v2.webm', 'video/webm'],
  ['discord-demo-en-v2.webm', 'video/webm'],
  ['discord-demo-pt-v2.png', 'image/png'],
  ['discord-demo-en-v2.png', 'image/png'],
  ['discord-demo-pt-v2.gif', 'image/gif'],
  ['discord-demo-en-v2.gif', 'image/gif'],
  ['meeting-demo-pt.png', 'image/png'],
  ['meeting-demo-en.png', 'image/png'],
] as const;

const mcpConnectionCreationLimiter = new FixedWindowRateLimiter();
const webHeavyReadLimiters = new ApiRateLimiters();

const WEB_DIRECT_TRANSCRIPT_MAX_BYTES = 5 * 1024 * 1024;
const WEB_DIRECT_TRANSCRIPT_MAX_SEGMENTS = 5_000;
export const MAX_WEB_LIBRARY_CANDIDATES_PER_PAGE = 100;
const MAX_WEB_LIBRARY_GUILDS_PER_PAGE = 25;
const MAX_WEB_LIBRARY_ITEMS_PER_PAGE = 100;

function webHeavyReadRateLimited(userId: string): boolean {
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
  invalidOriginTitle: { pt: 'Não foi possível confirmar a ação', en: 'Could not confirm the action' },
  invalidOrigin: {
    pt: 'A página não conseguiu comprovar que este envio veio do Kassinão. Volte às reuniões, abra a gravação e tente de novo.',
    en: 'The page could not prove that this submission came from Kassinão. Return to meetings, open the recording, and try again.',
  },
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
  freedFlash: {
    pt: '🔇 Espaço liberado — o áudio foi apagado; transcrição, ata e notas continuam.',
    en: '🔇 Space freed — the audio was deleted; transcript, minutes and notes remain.',
  },
  deletedFlash: { pt: '🗑️ Gravação removida do acervo ativo.', en: '🗑️ Recording removed from the active archive.' },
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
  freeErrorTitle: { pt: 'Não foi possível liberar o áudio', en: 'Could not release the audio' },
  freeError: {
    pt: 'A liberação não foi concluída. Reabra a gravação para conferir o estado atual e tente de novo.',
    en: 'The release did not complete. Reopen the recording to check its current state and try again.',
  },
  deleteErrorTitle: { pt: 'Não foi possível apagar a gravação', en: 'Could not delete the recording' },
  deleteError: {
    pt: 'A exclusão não foi concluída. Reabra a gravação para conferir o estado atual e tente de novo.',
    en: 'The deletion did not complete. Reopen the recording to check its current state and try again.',
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
  badRequest: {
    pt: 'A requisição não pôde ser interpretada. Recarregue a página e tente novamente.',
    en: 'The request could not be interpreted. Reload the page and try again.',
  },
  unexpected: {
    pt: 'Não foi possível concluir esta solicitação agora. Tente novamente em instantes.',
    en: 'This request could not be completed right now. Try again shortly.',
  },
  audioPrepareError: { pt: 'Erro ao preparar o áudio.', en: 'Could not prepare the audio.' },
  audioUnavailableTitle: { pt: 'Áudio indisponível', en: 'Audio unavailable' },
  downloadUnavailableTitle: { pt: 'Download indisponível', en: 'Download unavailable' },
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

function recordingMessageOptions(id: string, l: Locale): Parameters<typeof messagePage>[4] {
  return {
    backHref: `/app/rec/${encodeURIComponent(id)}`,
    backLabel: l === 'pt' ? 'Voltar à gravação' : 'Back to recording',
    active: 'rec',
  };
}

function connectMessageOptions(l: Locale): Parameters<typeof messagePage>[4] {
  return {
    backHref: '/app/conectar-ia',
    backLabel: l === 'pt' ? 'Voltar a Conectar IA' : 'Back to Connect AI',
    active: 'ai',
  };
}

function appMessageOptions(req: Request, l: Locale): Parameters<typeof messagePage>[4] | undefined {
  const pathname = req.originalUrl.split('?', 1)[0];
  const recording = /^\/app\/rec\/([a-zA-Z0-9-]+)(?:\/|$)/.exec(pathname);
  if (recording) return recordingMessageOptions(recording[1], l);
  if (pathname.startsWith('/app/conectar-ia')) return connectMessageOptions(l);
  if (pathname === '/app' || pathname.startsWith('/app/')) return { active: 'rec', navAi: true };
  return undefined;
}

export type WebOriginRejectionReason = 'null' | 'missing' | 'mismatch' | 'malformed';
export type WebMutationRouteClass =
  'recording-release' | 'recording-delete' | 'mcp-generate' | 'mcp-revoke' | 'logout' | 'other-app';
export type WebDeliveryErrorClass = 'client-abort' | 'missing' | 'permission' | 'io' | 'other';

const recordingMutationTails = new Map<string, Promise<void>>();

/** Serializa as mutações destrutivas da mesma gravação entre abas/requests. */
async function withRecordingMutationLock<T>(recordingId: string, operation: () => Promise<T>): Promise<T> {
  const previous = recordingMutationTails.get(recordingId) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  recordingMutationTails.set(recordingId, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (recordingMutationTails.get(recordingId) === tail) recordingMutationTails.delete(recordingId);
  }
}

/** Reduz erros de transporte/filesystem a classes fechadas, sem caminho ou identificador. */
export function webDeliveryErrorClass(error: unknown): WebDeliveryErrorClass {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code === 'ECONNABORTED' || code === 'ECONNRESET') return 'client-abort';
  if (code === 'ENOENT') return 'missing';
  if (code === 'EACCES' || code === 'EPERM') return 'permission';
  if (code === 'EIO' || code === 'ENOSPC') return 'io';
  return 'other';
}

/** Classificação segura para observabilidade; nunca devolve o header recebido. */
export function webOriginRejectionReason(
  req: Request,
  expectedBaseUrl = configuredWebOrigins().app,
): WebOriginRejectionReason | undefined {
  const origin = req.get('origin');
  if (!origin) return req.get('sec-fetch-site') === 'cross-site' ? 'missing' : undefined;
  if (origin === 'null') return 'null';
  try {
    return new URL(origin).origin === new URL(expectedBaseUrl).origin ? undefined : 'mismatch';
  } catch {
    return 'malformed';
  }
}

/** Agrupa a rota sem registrar URL, gravação, usuário ou qualquer outro identificador. */
export function webMutationRouteClass(req: Request): WebMutationRouteClass {
  const pathname = req.originalUrl.split('?', 1)[0];
  if (/^\/app\/rec\/[a-zA-Z0-9-]+\/liberar-audio$/.test(pathname)) return 'recording-release';
  if (/^\/app\/rec\/[a-zA-Z0-9-]+\/delete$/.test(pathname)) return 'recording-delete';
  if (pathname === '/app/conectar-ia/gerar') return 'mcp-generate';
  if (pathname === '/app/conectar-ia/revogar' || pathname.startsWith('/app/conectar-ia/revogar/')) {
    return 'mcp-revoke';
  }
  if (pathname === '/app/logout') return 'logout';
  return 'other-app';
}

/**
 * A meta guarda a URL do avatar do momento da gravação, com o hash de então.
 * Quando a pessoa troca de foto no Discord, aquela URL passa a devolver 404.
 * Se o gateway ainda conhece a pessoa, serve a foto ATUAL: custa nada, porque
 * só lê cache local, sem chamada REST. Quem não estiver em cache mantém a URL
 * antiga, e a página cai para a inicial se ela já tiver morrido.
 */
function withFreshAvatars<T extends { guildId: string; participants: { id: string; avatar: string | null }[] }>(
  meta: T,
): T {
  if (!isClientReady()) return meta;
  const guild = client.guilds.cache.get(meta.guildId);
  for (const participant of meta.participants) {
    const atual =
      guild?.members.cache.get(participant.id)?.displayAvatarURL({ size: 128, extension: 'png' }) ??
      client.users.cache.get(participant.id)?.displayAvatarURL({ size: 128, extension: 'png' });
    if (atual) participant.avatar = atual;
  }
  return meta;
}

/**
 * Inexistente e sem acesso são deliberadamente indistinguíveis. `switchAccountFor`
 * vem do caminho PEDIDO, nunca da meta, para que os dois casos gerem o mesmo HTML.
 */
function sendRecordingUnavailable(res: Response, l: Locale, user: WebUser, switchAccountFor = '/app'): void {
  res
    .status(404)
    .type('html')
    .send(messagePage(MSG.notFoundTitle[l], MSG.notFound[l], user, l, { switchAccountFor }));
}

/**
 * O 404 sozinho não diz ao operador que houve negação: uma linha por usuário a
 * cada 10 min basta para ver o padrão sem virar canal de amplificação. A mesma
 * linha vale para "não existe" e "sem acesso", então o log também não carrega o
 * bit de existência, e nunca leva o id da gravação.
 */
const recordingDenialLogLimiter = new FixedWindowRateLimiter();

function logRecordingDenial(userId: string, outcome: 'denied' | 'transient'): void {
  if (recordingDenialLogLimiter.consume(`rec-denied:${userId}`, 1, 600_000)) return;
  console.warn(`Acesso web negado: route_class=recording-view outcome=${outcome} user=${operationalPii(userId)}`);
}

/**
 * Veredito de acesso a UMA gravação. Uma falha transitória do Discord (429/5xx,
 * orçamento de membership saturado) não pode virar "esta gravação não existe":
 * quem está escrito na própria meta recebe 503 retriável. Para terceiros a
 * resposta continua byte-a-byte igual ao 404 de inexistente, então o 503
 * diferenciado nunca revela existência a quem não estava na call.
 */
async function resolveRecordingView(
  res: Response,
  l: Locale,
  user: WebUser,
  meta: RecordingMeta,
  opts?: Parameters<typeof messagePage>[4],
  switchAccountFor?: string,
): Promise<{ view: boolean; delete: boolean } | undefined> {
  try {
    const access = await checkAccess(user, meta, { throwOnTransient: true });
    if (access.view) return access;
    logRecordingDenial(user.id, 'denied');
    sendRecordingUnavailable(res, l, user, switchAccountFor);
    return undefined;
  } catch (err) {
    if (!(err instanceof TransientAccessError)) throw err;
    logRecordingDenial(user.id, 'transient');
    // Só quem está escrito na própria meta recebe o 503 diferenciado: para essa
    // pessoa a existência já é conhecida. Terceiros seguem no 404 idêntico.
    if (recordingIdentityGrant(user.id, meta).view) sendAccessTemporarilyUnavailable(res, l, user, opts);
    else sendRecordingUnavailable(res, l, user, switchAccountFor);
    return undefined;
  }
}

/**
 * Gate de prontidão: enquanto o gateway não está pronto, os caches de guild/canal
 * estão vazios e o checkAccess daria um 403 falso a quem tem direito via "enxerga o
 * canal"/ManageGuild. Responde 503 (retriável) em vez de um veredito de acesso errado.
 * Só entra DEPOIS do login (a rota já resolveu o usuário) — o fluxo OAuth usa REST,
 * não depende do gateway.
 */
function notReady(res: Response, l: Locale, user?: WebUser, opts?: Parameters<typeof messagePage>[4]): boolean {
  if (isClientReady()) return false;
  sendAccessTemporarilyUnavailable(res, l, user, opts);
  return true;
}

function sendAccessTemporarilyUnavailable(
  res: Response,
  l: Locale,
  user?: WebUser,
  opts?: Parameters<typeof messagePage>[4],
): void {
  res
    .status(503)
    .set('Retry-After', '5')
    .type('html')
    .send(messagePage(MSG.startingTitle[l], MSG.starting[l], user, l, opts));
}

function sendPrivateLoginRequired(res: Response, l: Locale, next = '/app'): void {
  res
    .status(200)
    .type('html')
    .send(privateAccessPage({ lang: l, next }));
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
    if (meta.demo || !config.guildPolicy.allows(meta.guildId)) {
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
    // A cópia acontece só aqui: quem passou pela ACL segue para o template como
    // objeto próprio, e o índice em memória não escapa do escopo desta varredura.
    if (access.view) items.push({ meta: withFreshAvatars(copyMeta(meta)), canDelete: access.delete });
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
function configuredWebOrigins(source: DomainConfig = config as DomainConfig): WebOrigins {
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
    pathname === '/health'
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

  if (pathname === '/health' || pathname === '/robots.txt' || pathname === '/sitemap.xml') {
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
    // Nunca encaminhar `code`/`state` recebidos no host errado. Além de vazar a
    // query para logs intermediários, o callback só é válido na origem exata.
    if (canonicalRouteKey(pathname) === '/auth/callback' && !has('app')) {
      return { action: 'reject', roles, status: 404 };
    }
    const canonicalPath = canonicalPrefixPath(pathname, '/auth');
    if (!has('app')) return { action: 'reject', roles, status: 404 };
    if (!isPathPrefix(pathname, '/auth')) return redirect(absoluteTarget(origins.app, req, canonicalPath));
    if (has('app')) return { action: 'pass', roles };
    return { action: 'reject', roles, status: 404 };
  }

  const appPath = isPathPrefixFolded(pathname, '/app');
  if (appPath) {
    if (!has('app')) return { action: 'reject', roles, status: 404 };
    const canonicalPath = canonicalPrefixPath(pathname, '/app');
    if (!isPathPrefix(pathname, '/app') || pathname === '/app/') {
      return redirect(absoluteTarget(origins.app, req, canonicalPath));
    }
    return { action: 'pass', roles };
  }

  const oldAppPath =
    isPathPrefix(pathname, '/gravacoes') || isPathPrefix(pathname, '/rec') || isPathPrefix(pathname, '/conectar-ia');
  if (oldAppPath && !has('app')) {
    return { action: 'reject', roles, status: 404 };
  }

  const routeKey = canonicalRouteKey(pathname);
  const privacyLocale = routeKey === '/privacy' ? 'pt' : routeKey === '/en/privacy' ? 'en' : undefined;
  if (privacyLocale) {
    const canonicalPath = privacyLocale === 'en' ? '/en/privacy' : '/privacy';
    if (has('app')) {
      return pathname === canonicalPath
        ? { action: 'pass', roles }
        : redirect(absoluteTarget(origins.app, req, canonicalPath));
    }
    // A política precisa refletir retenção/providers do processo privado. Hosts
    // públicos nunca mantêm uma cópia que possa divergir; apenas encaminham a
    // navegação para a rota pública, sem login, da origem do app.
    if (has('public') || has('docs')) return redirect(`${origins.app}${canonicalPath}`);
    return { action: 'reject', roles, status: 404 };
  }

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

  // A raiz do host dedicado do app é um alias interno. Não revela o hostname em
  // redirect e não mistura a landing pública com o workspace privado.
  if (has('app') && !has('public') && routeKey === '/') {
    return { action: 'rewrite', roles, path: pathWithOriginalQuery(req, '/app') };
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
    if (has('mcp') && (canonicalPublicPath === '/' || canonicalPublicPath === '/en')) {
      const docsPath = canonicalPublicPath === '/en' ? '/en' : '/';
      return {
        action: 'redirect',
        roles,
        status: 308,
        target: `${origins.docs}${docsPath}#mcp`,
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
  if (has('app') && roles.length === 1) return { action: 'reject', roles, status: 404 };

  return { action: 'pass', roles };
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

export function shouldNoIndexWebResponse(req: Request, origins = configuredWebOrigins()): boolean {
  const pathname = req.path || '/';
  if (
    canonicalRouteKey(pathname) === '/privacy' ||
    canonicalRouteKey(pathname) === '/en/privacy' ||
    isPathPrefixFolded(pathname, '/app') ||
    isPathPrefixFolded(pathname, '/auth') ||
    isPathPrefixFolded(pathname, '/api') ||
    isPathPrefixFolded(pathname, '/health')
  )
    return true;
  const host = requestHost(req);
  if (!host) return false;
  const roles = rolesForHost(host, origins);
  return roles.includes('app') || roles.includes('mcp');
}

/** A raiz do host dedicado do app vira /app; os headers precisam antecipar o rewrite. */
export function referrerPolicyForWebRequest(req: Request, origins = configuredWebOrigins()): string {
  const pathname = req.path || '/';
  const host = requestHost(req);
  if (pathname === '/' && host) {
    const roles = rolesForHost(host, origins);
    if (roles.includes('app') && !roles.includes('public')) return WEB_REFERRER_POLICY;
  }
  return referrerPolicyForPath(pathname);
}

/**
 * Monta a aplicação completa sem abrir socket. O processo de produção usa a
 * mesma factory em `startWebServer`; testes exercitam HTTP real numa porta
 * efêmera, sem outro servidor concorrente nem desvio das guardas de segurança.
 */
export function createWebApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  // O guard de host e o router precisam concordar: variantes como /API ou
  // /App/ não podem cair em handlers case-insensitive depois da classificação.
  app.set('case sensitive routing', true);
  app.set('strict routing', true);
  // Confia apenas na quantidade exata de hops declarada pelo operador. O default
  // zero impede spoof de X-Forwarded-For numa VPS exposta diretamente.
  app.set('trust proxy', config.trustProxyHops);

  // Headers entram antes do guard de Host para também cobrir 404/421 e redirects.
  // Um nonce diferente por resposta libera só scripts marcados pelo template.
  app.use((req, res, next) => {
    const nonce = createCspNonce();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', referrerPolicyForWebRequest(req));
    res.setHeader('Content-Security-Policy', contentSecurityPolicy(nonce));
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (shouldNoIndexWebResponse(req)) res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');

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
    const privateRole = decision.roles.some((role) => role === 'app' || role === 'mcp');
    const publicRole = decision.roles.some((role) => role === 'public' || role === 'docs');
    if (!config.publicSurfacesEnabled && publicRole && !privateRole) {
      res.status(404).set('X-Robots-Tag', 'noindex, nofollow, noarchive').type('text/plain').send('Not found.');
      return;
    }
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
        const l = pageLang(req);
        res.status(429).set('Retry-After', '30');
        if (req.path === '/app' || req.path.startsWith('/app/')) {
          res
            .set('Cache-Control', 'private, no-store, max-age=0')
            .set('Pragma', 'no-cache')
            .set('Content-Language', l === 'pt' ? 'pt-BR' : 'en')
            .type('html')
            .send(
              messagePage(MSG.errorTitle[l], MSG.tooManyRequests[l], getWebUser(req), l, appMessageOptions(req, l)),
            );
          return;
        }
        res.send(MSG.tooManyRequests[l]);
      },
    }),
  );

  // Remove cookies legados e mantém apenas sessões registradas com jti.
  // Tokens antigos sem revogação server-side são encerrados no primeiro acesso.
  app.use('/app', (req, res, next) => {
    const cookies = req.headers.cookie ?? '';
    if (cookies.includes('kassinao_session=') || cookies.includes('__Host-kassinao_session=')) {
      scopeWebSessionToApp(req, res);
    }
    next();
  });

  // Health check público: só disponibilidade. Contagem de calls ativas e disco
  // são metadados operacionais privados (e não são necessários ao healthcheck).
  app.get('/health', (_req, res) => {
    const ready = isClientReady();
    res
      .status(ready ? 200 : 503)
      .set('Cache-Control', 'no-store')
      .json({
        ok: ready,
        ready,
        surface: 'private',
        ...(config.releaseDigest ? { release: config.releaseDigest } : {}),
        ...(config.deploymentFingerprint ? { deployment: config.deploymentFingerprint } : {}),
      });
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

  // Persiste a escolha de idioma (?lang=en|pt) num cookie de 1 ano.
  app.use((req, res, next) => {
    const q = localeFromValue(req.query.lang);
    if (q) res.append('Set-Cookie', localeCookie(q, config.baseUrl.startsWith('https')));
    next();
  });

  // Política específica do operador: pública para cumprir transparência e o
  // Discord Developer Portal, mas servida pelo processo privado para sempre
  // refletir a configuração real de retenção, egress e MCP. Não exige login.
  app.get(['/privacy', '/en/privacy'], (req, res) => {
    const locale: Locale = req.path === '/en/privacy' ? 'en' : 'pt';
    res
      .set('Cache-Control', 'public, max-age=300')
      .set('Content-Language', locale === 'pt' ? 'pt-BR' : 'en')
      .type('html')
      .send(privacyPage(locale));
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
      const l = pageLang(req);
      const reason = webOriginRejectionReason(req) ?? 'malformed';
      console.warn(`Mutação web bloqueada: origin_reason=${reason} route_class=${webMutationRouteClass(req)}`);
      res
        .status(403)
        .type('html')
        .send(
          messagePage(MSG.invalidOriginTitle[l], MSG.invalidOrigin[l], getWebUser(req), l, appMessageOptions(req, l)),
        );
      return;
    }
    next();
  });

  // Sessão de ex-membro existe apenas para ele desligar conectores que já eram
  // seus. O gate vem antes de qualquer handler de gravação ou geração de token.
  app.use('/app', (req, res, next) => {
    const user = getWebUser(req);
    if (!user || user.scope === 'full') {
      next();
      return;
    }
    const pathname = req.originalUrl.split('?', 1)[0];
    const allowed =
      pathname === '/app/logout' ||
      (req.method === 'GET' && pathname === '/app/conectar-ia') ||
      (req.method === 'POST' &&
        (pathname === '/app/conectar-ia/revogar' || /^\/app\/conectar-ia\/revogar\/[A-Za-z0-9-]+$/.test(pathname)));
    if (allowed) {
      next();
      return;
    }
    if (req.method === 'GET' && pathname === '/app') {
      res.redirect(303, '/app/conectar-ia');
      return;
    }
    const l = pageLang(req);
    res
      .status(403)
      .type('html')
      .send(
        messagePage(
          l === 'pt' ? 'Acesso somente para revogação' : 'Revocation-only access',
          l === 'pt'
            ? 'Esta sessão pode apenas listar e revogar suas conexões existentes.'
            : 'This session can only list and revoke your existing connections.',
          user,
          l,
          connectMessageOptions(l),
        ),
      );
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
    app.get('/app/conectar-ia', async (req, res, next) => {
      const l = pageLang(req);
      const user = getWebUser(req);
      if (!user) {
        sendPrivateLoginRequired(res, l, '/app/conectar-ia');
        return;
      }
      let scopeChoices: { guildId: string; channelId: string; label: string }[] = [];
      if (user.scope === 'full' && isClientReady()) {
        try {
          const context = createAccessRequestContext();
          const choices = new Map<string, { guildId: string; channelId: string; label: string }>();
          for (const meta of listMetas()) {
            if (meta.demo || choices.has(meta.voiceChannelId) || !config.guildPolicy.allows(meta.guildId)) continue;
            if ((await checkAccess(user, meta, { requestContext: context, throwOnTransient: true })).view)
              choices.set(meta.voiceChannelId, {
                guildId: meta.guildId,
                channelId: meta.voiceChannelId,
                label: `${meta.guildName} / ${meta.voiceChannelName}`,
              });
          }
          scopeChoices = [...choices.values()];
        } catch (error) {
          if (!(error instanceof TransientAccessError)) {
            next(error);
            return;
          }
        }
      }
      const q = String(req.query.revoked ?? '');
      res.type('html').send(
        connectPage({
          lang: l,
          user,
          sessions: listUserSessions(user.id),
          scopeChoices,
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
          if (notReady(res, l, user, connectMessageOptions(l))) return;
          if (mcpConnectionCreationRateLimited(user.id)) {
            res
              .status(429)
              .set('Retry-After', '30')
              .type('html')
              .send(messagePage(MSG.errorTitle[l], MSG.tooManyRequests[l], user, l, connectMessageOptions(l)));
            return;
          }
          const membership = await currentGuildMembership(user.id);
          if (membership === 'unavailable') {
            res
              .status(503)
              .set('Retry-After', '5')
              .type('html')
              .send(messagePage(MSG.startingTitle[l], MSG.starting[l], user, l, connectMessageOptions(l)));
            return;
          }
          if (membership === 'not-member') {
            res
              .status(403)
              .type('html')
              .send(messagePage(MSG.mcpMembershipTitle[l], MSG.mcpMembership[l], user, l, connectMessageOptions(l)));
            return;
          }
          // apelido opcional ("notebook de trabalho") — só exibição na lista de gestão
          const label = String((req.body as Record<string, unknown>)?.label ?? '')
            .trim()
            .slice(0, 40);
          // O navegador recebe só um código descartável. O refresh token nasce na
          // troca feita pelo conector e vai direto ao cofre local, nunca ao HTML/config.
          let exchangeCode: string;
          try {
            const body = req.body as Record<string, unknown>;
            const selection = String(body.channel ?? 'all');
            if (selection !== 'all' && !/^[a-zA-Z0-9_-]{1,100}:[a-zA-Z0-9_-]{1,100}$/.test(selection))
              throw new McpScopeError();
            const [guildId, channelId] = selection.split(':');
            const from = body.from ? resolveDeadline(String(body.from), Date.now(), config.timezone) : undefined;
            const to = body.to ? resolveDeadline(String(body.to), Date.now(), config.timezone) : undefined;
            if ((from && from.status !== 'resolved') || (to && to.status !== 'resolved')) throw new McpScopeError();
            const days = Number(body.expiryDays ?? '30');
            if (![7, 30, 90].includes(days) || !['minutes', 'all'].includes(String(body.content ?? 'minutes')))
              throw new McpScopeError();
            const options = normalizeMcpSessionOptions({
              scope: {
                ...(selection !== 'all' ? { guildIds: [guildId], channelIds: [channelId] } : {}),
                ...(from?.status === 'resolved' ? { fromMs: from.fromMs } : {}),
                ...(to?.status === 'resolved' ? { toMs: to.toMs } : {}),
                content: body.content === 'all' ? ['minutes', 'transcript'] : ['minutes'],
              },
              absoluteExpiresAt: Date.now() + days * 86400000,
            });
            exchangeCode = createExchangeCode(user.id, user.name, label, options);
          } catch (err) {
            if (err instanceof McpScopeError) {
              res
                .status(400)
                .type('html')
                .send(
                  messagePage(
                    MSG.errorTitle[l],
                    l === 'pt'
                      ? 'Confira o canal, o período e a validade da conexão.'
                      : 'Check the channel, date range and connection expiry.',
                    user,
                    l,
                  ),
                );
              return;
            }
            if (!(err instanceof McpExchangeCodeCapacityError)) throw err;
            res
              .status(503)
              .set('Retry-After', '60')
              .type('html')
              .send(messagePage(MSG.mcpCapacityTitle[l], MSG.mcpCapacity[l], user, l, connectMessageOptions(l)));
            return;
          }
          console.log(
            `MCP: código de conexão criado user_name=${operationalPii(user.name)} user=${operationalPii(user.id)} via web${label ? ` label=${operationalPii(label)}` : ''}.`,
          );
          stageExchangeCodeForDisplay(user.id, exchangeCode, label);
          res.redirect(303, '/app/conectar-ia/codigo');
        } catch (err) {
          next(err);
        }
      },
    );

    app.get('/app/conectar-ia/codigo', (req, res) => {
      const l = pageLang(req);
      const user = getWebUser(req);
      if (!user) {
        sendPrivateLoginRequired(res, l, '/app/conectar-ia/codigo');
        return;
      }
      // A rota consome estado de exibição única. Um subdomínio irmão não pode
      // esgotá-lo com <img> ou navegação forçada, mesmo sem conseguir ler a resposta.
      if (req.get('sec-fetch-site') !== 'same-origin') {
        res.redirect(303, '/app/conectar-ia');
        return;
      }
      const staged = consumeStagedExchangeCode(user.id);
      if (!staged) {
        res.redirect(303, '/app/conectar-ia');
        return;
      }
      res
        .set('Cache-Control', 'no-store')
        .type('html')
        .send(connectPage({ lang: l, user, exchangeCode: staged.exchangeCode, label: staged.label }));
    });

    // revoga UMA conexão — só do próprio usuário (revokeUserSession valida o dono)
    app.post('/app/conectar-ia/revogar/:sid', (req, res) => {
      const user = getWebUser(req);
      if (!user) {
        res.redirect(303, '/app/conectar-ia');
        return;
      }
      const ok = revokeUserSession(user.id, req.params.sid);
      // O sid vem da URL e só entra no log pela política central de PII.
      if (ok)
        console.log(
          `MCP: sessão session=${operationalPii(req.params.sid)} revogada por user_name=${operationalPii(user.name)} user=${operationalPii(user.id)} via web.`,
        );
      res.redirect(303, ok ? '/app/conectar-ia?revoked=one' : '/app/conectar-ia');
    });

    app.post('/app/conectar-ia/revogar', (req, res) => {
      const user = getWebUser(req);
      if (!user) {
        res.redirect(303, '/app/conectar-ia');
        return;
      }
      const n = revokeUser(user.id);
      console.log(
        `MCP: ${n} sessão(ões) revogada(s) por user_name=${operationalPii(user.name)} user=${operationalPii(user.id)} via web.`,
      );
      res.redirect(303, '/app/conectar-ia?revoked=1');
    });

    // Fallbacks GET para URLs que só aceitam POST. A exibição única do código
    // tem sua rota PRG própria acima; os demais caminhos voltam ao painel.
    app.get(['/app/conectar-ia/gerar', '/app/conectar-ia/revogar', '/app/conectar-ia/revogar/:sid'], (_req, res) => {
      res.redirect('/app/conectar-ia');
    });
  }

  if (config.publicSurfacesEnabled) {
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
  }

  app.get('/auth/login', (req, res) => {
    // ?switch=1 é o único caminho que força a tela do Discord (troca de conta).
    // Fica fora do login normal para não pedir consentimento a cada entrada.
    beginLogin(res, String(req.query.next ?? '/app'), { forceAccountChoice: req.query.switch === '1' });
  });

  // Compatibilidade com favoritos antigos: GET nunca muda estado nem encerra a
  // sessão (evita logout CSRF). O controle novo usa POST dentro de /app.
  app.get('/auth/logout', (_req, res) => {
    res.redirect(303, '/app');
  });

  app.get('/auth/callback', async (req, res) => {
    const l = pageLang(req);
    try {
      const result = await finishLogin(req, res, async (identity) => {
        const membership = await currentGuildMembership(identity.id);
        if (membership === 'member') return 'full';
        if (membership === 'unavailable') return 'unavailable';
        const hasMcpConnections = listUserSessions(identity.id).length > 0;
        // Uma conta confirmada fora do perímetro não mantém logins web antigos.
        revokeWebSessionsForUser(identity.id);
        return hasMcpConnections ? 'revoke-only' : 'denied';
      });
      if (result.status === 'invalid') {
        res
          .status(400)
          .type('html')
          .send(messagePage(MSG.loginFailTitle[l], MSG.loginFail[l], undefined, l));
        return;
      }
      if (result.status === 'denied') {
        res
          .status(403)
          .type('html')
          .send(privateAccessPage({ lang: l, state: 'denied' }));
        return;
      }
      if (result.status === 'unavailable') {
        res
          .status(503)
          .set('Retry-After', '5')
          .type('html')
          .send(privateAccessPage({ lang: l, state: 'unavailable' }));
        return;
      }
      res.redirect(result.user.scope === 'revoke-only' ? '/app/conectar-ia' : result.next);
    } catch (err) {
      console.error(`Callback OAuth indisponível: ${operationalError(err)}`);
      res
        .status(503)
        .set('Retry-After', '5')
        .type('html')
        .send(privateAccessPage({ lang: l, state: 'unavailable' }));
    }
  });

  // A rota vive em /app para herdar a proteção de Origin/Sec-Fetch aplicada a
  // todas as mutações privadas.
  app.post('/app/logout', (req, res) => {
    logoutWeb(req, res);
    res.redirect(303, '/');
  });
  // Respostas de erro de um POST ainda exibem o seletor de idioma. O GET salva
  // o locale no middleware e volta ao painel sem tentar repetir o logout.
  app.get('/app/logout', (_req, res) => {
    res.redirect(303, '/app');
  });

  /** Home do app ("minhas gravações"): tudo que ESTA pessoa pode abrir, em todos
   *  os guilds — painel de GESTÃO: totais de disco (só OWNER_IDS), ordenação e ações. */
  app.get('/app/operacao', (req, res) => {
    const user = getWebUser(req);
    if (!user || !config.ownerIds.includes(user.id)) {
      res.status(404).end();
      return;
    }
    const l = pageLang(req);
    if (notReady(res, l, user)) return;
    const metas = listMetas().filter((meta) => !meta.demo && config.guildPolicy.allows(meta.guildId));
    const completed = metas.filter((m) => m.endedAt && m.minutes?.status === 'done' && m.minutes.finishedAt);
    const durations = completed
      .map((m) => Math.max(0, (m.minutes!.finishedAt! - m.endedAt!) / 60000))
      .sort((a, b) => a - b);
    const quantile = (q: number) =>
      durations.length
        ? `${durations[Math.min(durations.length - 1, Math.floor(q * durations.length))].toFixed(1)} min (${durations.length} reuniões)`
        : 'Sem amostra';
    const backup = evaluateBackupHeartbeat(readBackupHeartbeat(config.stateDir), Date.now());
    let deletion = 'Indisponível';
    try {
      const count = getRemoteDeletionSummary();
      deletion = `${count.pending} pendentes; ${count.needsAttention} precisam de atenção; ${count.active} em processamento`;
    } catch {
      /* Surface unavailable, never false zero. */
    }
    res.type('html').send(
      operationPage(user, l, [
        ['Gravações no acervo', String(metas.length)],
        ['Calls em gravação', String(metas.filter((m) => m.status === 'recording').length)],
        [
          'Transcrições na fila ou em processamento',
          String(metas.filter((m) => ['pending', 'running'].includes(m.transcription?.status ?? '')).length),
        ],
        ['Transcrições parciais', String(metas.filter((m) => m.transcription?.status === 'partial').length)],
        ['Atas com erro', String(metas.filter((m) => m.minutes?.status === 'error').length)],
        ['Fim da call até ata, mediana', quantile(0.5)],
        ['Fim da call até ata, p95', quantile(0.95)],
        ['Entregas externas com falha', String(metas.filter((m) => m.webhookFailedAt).length)],
        ['Exclusões no provedor de transcrição', deletion],
        ['Disco livre', `${Math.round(freeMB())} MiB`],
        [
          'Último backup declarado',
          !config.backupEnabled
            ? 'Não habilitado'
            : backup.ok
              ? backup.heartbeat.finishedAt
              : `Sem confirmação recente (${backup.reason})`,
        ],
        ['Restauração do backup', 'Não comprovada por este painel'],
        ['Gasto de IA', 'Não conciliado com as faturas dos provedores'],
        ...operationsSummaryRows(metas.map((meta) => ({ meta, progress: getProcessingProgress(meta.id) }))),
        ...((): [string, string][] => {
          try {
            const feedback = contextRuntime().service.feedbackSummary();
            return [
              [
                'Avaliações do acompanhamento',
                `${feedback.useful} úteis; ${feedback.dismissed} dispensáveis (${feedback.responses} respostas)`,
              ],
            ];
          } catch {
            return [['Avaliações do acompanhamento', 'Indisponível']];
          }
        })(),
      ]),
    );
  });

  app.post('/app/rec/:id/titulo', express.urlencoded({ extended: false, limit: '2kb' }), async (req, res, next) => {
    const user = getWebUser(req);
    if (!user) {
      res.redirect(303, '/app');
      return;
    }
    const l = pageLang(req);
    if (notReady(res, l, user)) return;
    if (
      typeof req.body?.title !== 'string' ||
      req.body.title.length > 120 ||
      Array.from(req.body.title as string).some((character) => character.charCodeAt(0) < 32)
    ) {
      res.status(400).end();
      return;
    }
    try {
      await withRecordingMutationLock(req.params.id, async () => {
        const meta = readMeta(req.params.id);
        if (!meta || !(await checkAccess(user, meta, { freshMember: true, throwOnTransient: true })).delete) {
          sendRecordingUnavailable(res, l, user);
          return;
        }
        const current = readMeta(meta.id);
        if (!current) {
          sendRecordingUnavailable(res, l, user);
          return;
        }
        current.title = req.body.title.trim() || undefined;
        saveMeta(current);
        res.redirect(303, `/app/rec/${encodeURIComponent(current.id)}`);
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/app/contexto', async (req, res, next) => {
    const l = pageLang(req);
    const user = getWebUser(req);
    if (!user) {
      sendPrivateLoginRequired(res, l, req.originalUrl);
      return;
    }
    if (notReady(res, l, user)) return;
    if (webHeavyReadRateLimited(user.id)) {
      res.status(429).set('Retry-After', '30').end();
      return;
    }
    const meetingId =
      typeof req.query.meeting === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(req.query.meeting)
        ? req.query.meeting
        : undefined;
    const channelId =
      typeof req.query.channel === 'string' && /^\d{1,30}$/.test(req.query.channel) ? req.query.channel : undefined;
    const commitmentId =
      typeof req.query.commitment === 'string' && /^[a-f0-9]{32}$/.test(req.query.commitment)
        ? req.query.commitment
        : undefined;
    const groupId =
      !commitmentId && typeof req.query.group === 'string' && /^[a-f0-9]{32}$/.test(req.query.group)
        ? req.query.group
        : undefined;
    const ids = typeof req.query.ids === 'string' ? req.query.ids.split(',') : undefined;
    if (
      req.query.ids !== undefined &&
      (!ids || !ids.length || ids.length > 100 || ids.some((id) => !/^[a-f0-9]{32}$/.test(id)))
    ) {
      res.status(400).end();
      return;
    }
    const decisionMeeting =
      typeof req.query.decisionMeeting === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(req.query.decisionMeeting)
        ? req.query.decisionMeeting
        : undefined;
    if (req.query.decisionMeeting !== undefined && (!decisionMeeting || !commitmentId)) {
      res.status(400).end();
      return;
    }
    const page =
      typeof req.query.page === 'string' && /^(?:[1-9]\d?|100)$/.test(req.query.page) ? Number(req.query.page) : 1;
    try {
      await withContextAccess(async () => {
        const runtime = contextRuntime();
        const candidates = await runtime.service.listForUser(user.id, {
          meetingId,
          channelId,
          ids,
          commitmentId,
          groupOf: groupId,
          includeRelatedMentions: true,
          offset: (page - 1) * 100,
          limit: 101,
        });
        const entries = candidates.slice(0, 100);
        if (decisionMeeting && entries.length !== 1) throw new CommitmentAccessError();
        const suggestions = Object.fromEntries(
          entries.map((entry) => [
            entry.id,
            suggestArtifactLinks(
              {
                context: { guildId: entry.guildId, channelId: entry.channelId },
                actions: [{ tarefa: entry.task, source: entry.source }],
              },
              runtime.configuration,
            ).actionSuggestions[0]?.map((suggestion) => suggestion.reference) ?? [],
          ]),
        );
        const eventResult = await upcomingContextEvents(
          user.id,
          channelId ? new Set([channelId]) : meetingId ? new Set(entries.map((entry) => entry.channelId)) : undefined,
        );
        const channelResult = await listAuthorizedContextChannels(user.id);
        const channelPreferences = await runtime.service.listChannelPreferences(user.id);
        const channels = channelResult.channels.map((channel) => ({
          ...channel,
          followed: channelPreferences.some(
            (pref) =>
              pref.guildId === channel.guildId && pref.channelId === channel.channelId && pref.mode === 'follow',
          ),
        }));
        const decisionCursor =
          typeof req.query.decisionCursor === 'string' && /^\d{1,5}$/.test(req.query.decisionCursor)
            ? Number(req.query.decisionCursor)
            : 0;
        const decisionLibrary =
          commitmentId && entries.length
            ? await collectWebLibraryPage(
                user,
                listMetas().filter((meta) => meta.minutes?.status === 'done'),
                decisionCursor,
              )
            : undefined;
        const decisionMeetings =
          decisionLibrary?.items.map(({ meta }) => ({
            id: meta.id,
            name: meta.title ?? meta.voiceChannelName,
            at: meta.startedAt,
          })) ?? [];
        const decisionMeta = decisionMeeting ? readMeta(decisionMeeting) : undefined;
        if (decisionMeeting && (!decisionMeta || !(await checkAccess(user, decisionMeta)).view))
          throw new CommitmentAccessError();
        const decisionMinutes = decisionMeta ? readMinutes(decisionMeta.id) : null;
        const decisions =
          decisionMinutes?.decisoes.flatMap((text, index) =>
            decisionMinutes.decisionSources?.[index]
              ? [
                  {
                    index,
                    text,
                    source: decisionMinutes.decisionSources[index]!,
                    revision: decisionRevision(text, decisionMinutes.decisionSources[index]!),
                  },
                ]
              : [],
          ) ?? [];
        const upcoming = eventResult.events;
        const upcomingUnavailable = eventResult.incomplete;
        res.type('html').send(
          contextPage({
            user,
            lang: l,
            entries,
            meetingId,
            channelId,
            commitmentId,
            groupId,
            page,
            nextPage: candidates.length > 100 ? page + 1 : undefined,
            suggestions,
            channelLabels: Object.fromEntries(
              entries.map((entry) => [
                `${entry.guildId}:${entry.channelId}`,
                readMeta(entry.meetingId)?.voiceChannelName ?? entry.channelId,
              ]),
            ),
            recipientCredentials: runtime.recipientCredentialsStatus(user.id),
            recipientAccess: runtime.recipientAccessStatus(user.id),
            channels,
            channelsUnavailable: channelResult.incomplete,
            delivery: contextDeliveryStatus(user.id),
            ids,
            decisionMeeting,
            decisions,
            decisionMeetings,
            decisionNextCursor: decisionLibrary?.nextCursor,
            configured: runtime.configuration.scopes.length > 0,
            upcoming: upcoming.sort((a, b) => a.at - b.at),
            upcomingUnavailable,
            flash: req.query.saved === '1' ? (l === 'pt' ? 'Alteração salva.' : 'Change saved.') : undefined,
          }),
        );
      });
    } catch (error) {
      if (error instanceof CommitmentAuthorizationUnavailableError) {
        sendAccessTemporarilyUnavailable(res, l, user);
        return;
      }
      if (error instanceof CommitmentAccessError) {
        res.status(404).end();
        return;
      }
      next(error);
    }
  });

  app.post('/app/contexto/canal', express.urlencoded({ extended: false, limit: '2kb' }), async (req, res, next) => {
    const user = getWebUser(req);
    if (!user) {
      res.redirect(303, '/app/contexto');
      return;
    }
    const l = pageLang(req);
    if (notReady(res, l, user)) return;
    const body = req.body as Record<string, unknown>;
    if (
      typeof body.guild !== 'string' ||
      !/^\d{1,30}$/.test(body.guild) ||
      typeof body.channel !== 'string' ||
      !/^\d{1,30}$/.test(body.channel) ||
      (body.mode !== 'follow' && body.mode !== 'mute') ||
      (body.history !== 'open' && body.history !== 'future')
    ) {
      res.status(400).end();
      return;
    }
    try {
      await withContextAccess(() =>
        contextRuntime().service.setChannelSubscription(
          user.id,
          { guildId: body.guild as string, channelId: body.channel as string },
          body.mode as 'follow' | 'mute',
          { includeExisting: body.history === 'open' },
        ),
      );
      res.redirect(303, '/app/contexto?saved=1');
    } catch (error) {
      if (error instanceof CommitmentAccessError) {
        res.status(404).end();
        return;
      }
      if (error instanceof CommitmentInputError) {
        res.status(400).end();
        return;
      }
      if (error instanceof CommitmentAuthorizationUnavailableError) {
        sendAccessTemporarilyUnavailable(res, l, user);
        return;
      }
      next(error);
    }
  });

  app.post(
    '/app/contexto/:id/:operation',
    express.urlencoded({ extended: false, limit: '48kb' }),
    async (req, res, next) => {
      const user = getWebUser(req);
      const l = pageLang(req);
      if (!user) {
        res.redirect(303, '/app/contexto');
        return;
      }
      if (notReady(res, l, user)) return;
      if (!/^[a-f0-9]{32}$/.test(req.params.id)) {
        res.status(404).end();
        return;
      }
      try {
        await withContextAccess(async () => {
          const service = contextRuntime().service;
          const body = req.body as Record<string, unknown>;
          const relatedIds = typeof body.related === 'string' ? body.related.split(',') : undefined;
          if (relatedIds && (relatedIds.length > 100 || relatedIds.some((id) => !/^[a-f0-9]{32}$/.test(id))))
            throw new CommitmentInputError('Menções inválidas.');
          const sharedOperation = [
            'estado',
            'criterio',
            'vinculos',
            'editar',
            'reparar',
            'decisao',
            'substituir',
            'unificar',
            'separar',
          ].includes(req.params.operation);
          const expectedRevision =
            typeof body.revision === 'string' && /^[a-f0-9]{64}$/.test(body.revision) ? body.revision : undefined;
          if (sharedOperation && !expectedRevision) throw new CommitmentInputError('Recarregue o formulário.');
          let expectedRevisions: Record<string, string> | undefined;
          if (relatedIds?.length && sharedOperation) {
            try {
              const parsed: unknown = JSON.parse(String(body.revisions));
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length > 100)
                throw new Error();
              expectedRevisions = parsed as Record<string, string>;
              if (relatedIds.some((id) => !/^[a-f0-9]{64}$/.test(expectedRevisions![id]))) throw new Error();
            } catch {
              throw new CommitmentInputError('Recarregue as menções relacionadas.');
            }
          }
          const mutationOptions = {
            relatedIds,
            expectedRevision,
            expectedRevisions,
            acknowledgeReview: body.acknowledgeReview === '1',
          };
          if (req.params.operation === 'estado')
            await service.setStatus(user.id, req.params.id, String(body.status) as CommitmentStatus, mutationOptions);
          else if (req.params.operation === 'editar') {
            if (typeof body.task !== 'string' || typeof body.assignee !== 'string' || typeof body.deadline !== 'string')
              throw new CommitmentInputError('Campos inválidos.');
            await service.editForUser(
              user.id,
              req.params.id,
              { task: body.task, assignee: body.assignee, deadline: body.deadline },
              { expectedRevision: expectedRevision! },
            );
          } else if (req.params.operation === 'reparar') {
            if (body.confirm !== '1') throw new CommitmentInputError('Confirme o reparo.');
            await service.repairForUser(user.id, req.params.id, { expectedRevision: expectedRevision! });
          } else if (req.params.operation === 'decisao') {
            if (
              typeof body.sourceMeeting !== 'string' ||
              !/^[a-zA-Z0-9-]{1,100}$/.test(body.sourceMeeting) ||
              typeof body.decisionIndex !== 'string' ||
              !/^\d{1,3}\|[a-f0-9]{64}$/.test(body.decisionIndex) ||
              (body.kind !== 'supersedes' && body.kind !== 'cancels') ||
              body.confirm !== '1'
            )
              throw new CommitmentInputError('Decisão inválida.');
            const sourceMeta = readMeta(body.sourceMeeting);
            if (!sourceMeta || !(await checkAccess(user, sourceMeta)).view) throw new CommitmentAccessError();
            const minutes = readMinutes(sourceMeta.id);
            const [indexText, expectedDecisionRevision] = body.decisionIndex.split('|');
            const index = Number(indexText);
            const source = minutes?.decisionSources?.[index];
            if (!source || !minutes?.decisoes[index]) throw new CommitmentConflictError();
            if (decisionRevision(minutes.decisoes[index], source) !== expectedDecisionRevision)
              throw new CommitmentConflictError();
            await service.recordDecisionForUser(
              user.id,
              req.params.id,
              { meetingId: sourceMeta.id, source, kind: body.kind, note: minutes.decisoes[index].slice(0, 1000) },
              { expectedRevision: expectedRevision! },
            );
          } else if (req.params.operation === 'substituir') {
            if (
              typeof body.other !== 'string' ||
              !/^[a-f0-9]{32}$/.test(body.other) ||
              typeof body.otherRevision !== 'string' ||
              !/^[a-f0-9]{64}$/.test(body.otherRevision) ||
              body.confirm !== '1'
            )
              throw new CommitmentInputError('Substituição inválida.');
            await service.replaceForUser(user.id, req.params.id, body.other, 'supersedes', {
              expectedRevision: expectedRevision!,
              otherExpectedRevision: body.otherRevision,
            });
          } else if (req.params.operation === 'unificar' || req.params.operation === 'separar') {
            if (typeof body.other !== 'string' || !/^[a-f0-9]{32}$/.test(body.other))
              throw new CommitmentInputError('Menção inválida.');
            let otherExpectedRevision = typeof body.otherRevision === 'string' ? body.otherRevision : undefined;
            if (!otherExpectedRevision && typeof body.otherRevisions === 'string') {
              try {
                const revisions: unknown = JSON.parse(body.otherRevisions);
                if (
                  revisions &&
                  typeof revisions === 'object' &&
                  !Array.isArray(revisions) &&
                  Object.keys(revisions).length <= 100
                )
                  otherExpectedRevision = (revisions as Record<string, string>)[body.other];
              } catch {
                /* Invalid form is rejected below. */
              }
            }
            if (!otherExpectedRevision || !/^[a-f0-9]{64}$/.test(otherExpectedRevision))
              throw new CommitmentInputError('Recarregue a outra menção.');
            const options = { expectedRevision, otherExpectedRevision };
            if (req.params.operation === 'unificar')
              await service.mergeForUser(user.id, req.params.id, body.other, options);
            else await service.unlinkForUser(user.id, req.params.id, body.other, options);
          } else if (req.params.operation === 'utilidade') {
            if (body.feedback !== 'useful' && body.feedback !== 'dismissed')
              throw new CommitmentInputError('Avaliação inválida.');
            await service.setFeedback(user.id, req.params.id, body.feedback);
          } else if (req.params.operation === 'canal') {
            if (body.mode !== 'follow' && body.mode !== 'mute')
              throw new CommitmentInputError('Preferência de canal inválida.');
            await service.setChannelPreference(user.id, req.params.id, body.mode);
          } else if (req.params.operation === 'criterio') {
            if (body.rule === 'manual')
              await service.setCompletionRule(user.id, req.params.id, { kind: 'manual' }, mutationOptions);
            else if (typeof body.rule === 'string' && /^(done|merged)\|https:\/\//.test(body.rule)) {
              const separator = body.rule.indexOf('|');
              await service.setCompletionRule(
                user.id,
                req.params.id,
                {
                  kind: 'artifact',
                  url: body.rule.slice(separator + 1),
                  state: body.rule.slice(0, separator) as 'done' | 'merged',
                },
                mutationOptions,
              );
            } else throw new CommitmentInputError('Critério inválido.');
          } else if (req.params.operation === 'vinculos') {
            if (typeof body.urls !== 'string') throw new CommitmentInputError('Links inválidos.');
            await service.setLinks(
              user.id,
              req.params.id,
              body.urls
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter(Boolean),
              { expectedRevision },
            );
          } else if (req.params.operation === 'avisos') {
            if (!['follow', 'mute'].includes(String(body.mode)))
              throw new CommitmentInputError('Preferência inválida.');
            await service.setPreference(
              user.id,
              req.params.id,
              {
                mode: body.snooze === '7' ? 'follow' : (body.mode as 'follow' | 'mute'),
                snoozedUntil: body.snooze === '7' ? Date.now() + 7 * 86400000 : undefined,
              },
              { relatedIds },
            );
          } else {
            res.status(404).end();
            return;
          }
          const meeting =
            typeof body.meeting === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(body.meeting)
              ? `&meeting=${encodeURIComponent(body.meeting)}`
              : '';
          const channel =
            typeof body.channel === 'string' && /^\d{1,30}$/.test(body.channel)
              ? `&channel=${encodeURIComponent(body.channel)}`
              : '';
          const page =
            typeof body.page === 'string' && /^(?:[1-9]\d?|100)$/.test(body.page) ? `&page=${body.page}` : '';
          const commitment =
            typeof body.commitment === 'string' && /^[a-f0-9]{32}$/.test(body.commitment)
              ? `&commitment=${body.commitment}`
              : '';
          const group =
            typeof body.group === 'string' && /^[a-f0-9]{32}$/.test(body.group) ? `&group=${body.group}` : '';
          const batchIds =
            typeof body.ids === 'string' &&
            body.ids.split(',').length <= 100 &&
            body.ids.split(',').every((id) => /^[a-f0-9]{32}$/.test(id))
              ? `&ids=${encodeURIComponent(body.ids)}`
              : '';
          res.redirect(
            303,
            `/app/contexto?saved=1${meeting}${channel}${page}${commitment}${group}${batchIds}#c-${req.params.id}`,
          );
        });
      } catch (error) {
        if (error instanceof CommitmentAuthorizationUnavailableError) {
          sendAccessTemporarilyUnavailable(res, l, user);
          return;
        }
        if (error instanceof CommitmentConflictError) {
          res
            .status(409)
            .type('html')
            .send(
              messagePage(
                MSG.errorTitle[l],
                l === 'pt'
                  ? 'Outra alteração foi salva enquanto este formulário estava aberto. Reabra o combinado, confira a versão atual e aplique sua mudança novamente.'
                  : 'Another change was saved while this form was open. Reopen the commitment, review the current version and apply your change again.',
                user,
                l,
                {
                  backHref: `/app/contexto?commitment=${req.params.id}`,
                  backLabel: l === 'pt' ? 'Reabrir combinado' : 'Reopen commitment',
                },
              ),
            );
          return;
        }
        if (error instanceof CommitmentAccessError || error instanceof CommitmentInputError) {
          res
            .status(error instanceof CommitmentAccessError ? 404 : 400)
            .type('html')
            .send(
              messagePage(
                MSG.errorTitle[l],
                l === 'pt'
                  ? 'Não foi possível salvar. Confira seu acesso e os valores informados.'
                  : 'Could not save. Check your access and the entered values.',
                user,
                l,
              ),
            );
          return;
        }
        next(error);
      }
    },
  );

  app.post('/app/rec/:id/tentar-webhook', async (req, res, next) => {
    const user = getWebUser(req);
    if (!user || !config.ownerIds.includes(user.id)) {
      res.status(404).end();
      return;
    }
    if (notReady(res, pageLang(req), user)) return;
    try {
      const meta = readMeta(req.params.id);
      if (!meta || !(await checkAccess(user, meta, { freshMember: true, throwOnTransient: true })).delete) {
        res.status(404).end();
        return;
      }
      const result = retryMinutesWebhook(meta.id);
      if (result === 'unavailable') {
        res.status(409).end();
        return;
      }
      res.redirect(303, `/app/rec/${encodeURIComponent(meta.id)}`);
    } catch (error) {
      next(error);
    }
  });

  app.post('/app/rec/:id/tentar-ata', async (req, res, next) => {
    const user = getWebUser(req);
    const l = pageLang(req);
    if (!user) {
      res.redirect(303, '/app');
      return;
    }
    if (notReady(res, l, user)) return;
    try {
      await withRecordingMutationLock(req.params.id, async () => {
        const meta = readMeta(req.params.id);
        if (!meta || !(await checkAccess(user, meta, { freshMember: true, throwOnTransient: true })).delete) {
          sendRecordingUnavailable(res, l, user);
          return;
        }
        const result = retryMinutes(meta.id, (fresh) => {
          syncContextMeeting(fresh);
          enqueueMinutesWebhook(fresh.id);
        });
        if (result !== 'queued' && result !== 'busy') {
          res
            .status(409)
            .type('html')
            .send(
              messagePage(
                MSG.errorTitle[l],
                l === 'pt' ? 'Esta ata não pode ser reprocessada agora.' : 'These minutes cannot be retried right now.',
                user,
                l,
              ),
            );
          return;
        }
        res.redirect(303, `/app/rec/${encodeURIComponent(meta.id)}`);
      });
    } catch (error) {
      next(error);
    }
  });

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
      sendPrivateLoginRequired(res, l, next.size ? `/app?${next.toString()}` : '/app');
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
    // Sem cópia: a maioria destas candidatas some no filtro de acesso logo abaixo,
    // e só as aprovadas são copiadas em collectWebLibraryPage.
    const candidates = candidatePage.ids.flatMap((id) => {
      const meta = peekMeta(id);
      if (!meta) return [];
      return [meta];
    });
    let library: WebLibraryPage;
    try {
      library = await collectWebLibraryPage(user, candidates);
    } catch (err) {
      if (!(err instanceof TransientAccessError)) throw err;
      sendAccessTemporarilyUnavailable(res, l, user, { active: 'rec', navAi: true });
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
    const search = q ? searchRecordingsWithCoverage(searchableMetas, q) : undefined;
    const flash = req.query.freed === '1' ? MSG.freedFlash[l] : req.query.deleted === '1' ? MSG.deletedFlash[l] : '';
    res.type('html').send(
      recordingsIndexPage(items, {
        user,
        lang: l,
        q,
        hits: search?.hits,
        searchCoverage: search?.coverage,
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
    const messageOpts = recordingMessageOptions(req.params.id, l);
    const recPath = `/app/rec/${encodeURIComponent(req.params.id)}`;
    // login ANTES de checar existência: não vaza quais IDs existem a quem não logou
    const user = getWebUser(req);
    if (!user) {
      sendPrivateLoginRequired(res, l, `/app/rec/${req.params.id}`);
      return;
    }
    if (notReady(res, l, user, messageOpts)) return;
    const meta = readMeta(req.params.id);
    if (!meta) {
      logRecordingDenial(user.id, 'denied');
      sendRecordingUnavailable(res, l, user, recPath);
      return;
    }
    const access = await resolveRecordingView(res, l, user, meta, messageOpts, recPath);
    if (!access) return;
    // Por id, não por guild: com mais de uma gravação no mesmo servidor, o lookup
    // por guild acharia "uma" delas e deixaria baixar a outra em plena captura.
    const live = meta.status === 'recording' && sessionManager.getById(meta.id) !== undefined;
    let transcript: TranscriptSegment[] | undefined;
    let transcriptNotice: string | undefined;
    if (transcriptReady(meta)) {
      if (webHeavyReadRateLimited(user.id)) {
        res
          .status(429)
          .set('Retry-After', '30')
          .type('html')
          .send(messagePage(MSG.errorTitle[l], MSG.tooManyRequests[l], user, l, messageOpts));
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
      recordingPage(withFreshAvatars(meta), {
        live,
        canDelete: access.delete,
        canRetryWebhook: access.delete && config.ownerIds.includes(user.id),
        user,
        lang: l,
        flash: req.query.freed === '1' ? MSG.freedFlash[l] : undefined,
        transcript,
        transcriptNotice,
        minutes,
        minutesNotice,
        processingNotice: (() => {
          const progress = getProcessingProgress(meta.id);
          if (!progress) return undefined;
          const stage = {
            queued: 'na fila',
            preparing: 'preparando áudio',
            transcribing: 'transcrevendo',
            minutes: 'gerando ata',
            waiting: 'aguardando nova tentativa',
            done: 'concluído',
            error: 'falhou',
            paused: 'pausado',
          }[progress.stage];
          return l === 'pt'
            ? `Processamento: ${stage}.${progress.tracksTotal ? ` Faixas: ${progress.tracksCompleted ?? 0}/${progress.tracksTotal}.` : ''}${progress.reusedBatches ? ` Blocos reutilizados: ${progress.reusedBatches}.` : ''}`
            : `Processing: ${progress.stage}. ${progress.tracksCompleted ?? 0}/${progress.tracksTotal ?? 0} tracks.`;
        })(),
      }),
    );
  });

  app.get('/app/rec/:id/audio', async (req, res, next) => {
    const l = pageLang(req);
    const messageOpts = recordingMessageOptions(req.params.id, l);
    const recPath = `/app/rec/${encodeURIComponent(req.params.id)}`;
    const user = getWebUser(req);
    if (!user) {
      sendPrivateLoginRequired(res, l, `/app/rec/${req.params.id}`);
      return;
    }
    if (notReady(res, l, user, messageOpts)) return;
    const meta = readMeta(req.params.id);
    if (!meta) {
      logRecordingDenial(user.id, 'denied');
      sendRecordingUnavailable(res, l, user, recPath);
      return;
    }
    // checkAccess ANTES de qualquer checagem de estado (ao-vivo) — não vaza a
    // quem não tem acesso se a gravação existe/está ao vivo (oráculo de enumeração).
    const access = await resolveRecordingView(res, l, user, meta, messageOpts, recPath);
    if (!access) return;
    if (meta.participants.length === 0) {
      res
        .status(404)
        .type('html')
        .send(messagePage(MSG.audioUnavailableTitle[l], MSG.noAudio[l], user, l, messageOpts));
      return;
    }
    // ao vivo: o mix seria parcial e não-cacheável (re-cozinha a cada hit) — bloqueia
    // Por id, não por guild: com mais de uma gravação no mesmo servidor, o lookup
    // por guild acharia "uma" delas e deixaria baixar a outra em plena captura.
    const live = meta.status === 'recording' && sessionManager.getById(meta.id) !== undefined;
    if (live) {
      res
        .status(409)
        .type('html')
        .send(messagePage(MSG.audioUnavailableTitle[l], MSG.recordingInProgress[l], user, l, messageOpts));
      return;
    }
    // retenção em camadas: o áudio pode já ter expirado (texto continua na página)
    if (meta.audioDeleted) {
      res
        .status(410)
        .type('html')
        .send(messagePage(MSG.audioUnavailableTitle[l], MSG.audioExpired[l], user, l, messageOpts));
      return;
    }
    // Reserva antes do cook: delete/cleanup não apagam no meio e um membro não
    // consegue prender recursos da VPS com streams simultâneos ilimitados.
    const download = acquireDownload(meta.id, user.id);
    if (!download) {
      res
        .status(429)
        .set('Retry-After', '30')
        .type('html')
        .send(messagePage(MSG.audioUnavailableTitle[l], MSG.tooManyRequests[l], user, l, messageOpts));
      return;
    }
    let cookSettled = false;
    let responseClosed = false;
    res.once('close', () => {
      responseClosed = true;
      if (cookSettled) download.release();
    });
    try {
      const result = await cook(meta, 'mix'); // mp3 único, cacheado após o 1º
      cookSettled = true;
      if (responseClosed) {
        download.release();
        return;
      }
      // sendFile já trata Range (seek do player) e Content-Type por extensão
      res.sendFile(result.filePath, (err?: Error) => {
        download.release();
        if (!err) return;
        const errorClass = webDeliveryErrorClass(err);
        if (errorClass === 'client-abort') return;
        console.error(`Falha no envio de mídia: delivery_error=${errorClass}`);
        if (res.headersSent) {
          next(new Error('media delivery failed'));
          return;
        }
        res
          .status(500)
          .type('html')
          .send(messagePage(MSG.audioUnavailableTitle[l], MSG.audioPrepareError[l], user, l, messageOpts));
      });
    } catch (err) {
      cookSettled = true;
      download.release();
      if (err instanceof CookBusyError) {
        res
          .status(503)
          .set('Retry-After', '20')
          .type('html')
          .send(messagePage(MSG.audioUnavailableTitle[l], MSG.processingBusy[l], user, l, messageOpts));
        return;
      }
      console.error(`Erro servindo áudio recording=${operationalPii(meta.id)}: ${operationalError(err)}`);
      res
        .status(500)
        .type('html')
        .send(messagePage(MSG.audioUnavailableTitle[l], MSG.audioPrepareError[l], user, l, messageOpts));
    }
  });

  app.get('/app/rec/:id/ata.md', async (req, res) => {
    const l = pageLang(req);
    const messageOpts = recordingMessageOptions(req.params.id, l);
    const recPath = `/app/rec/${encodeURIComponent(req.params.id)}`;
    const user = getWebUser(req);
    if (!user) {
      sendPrivateLoginRequired(res, l, `/app/rec/${req.params.id}`);
      return;
    }
    if (notReady(res, l, user, messageOpts)) return;
    const meta = readMeta(req.params.id);
    if (!meta) {
      logRecordingDenial(user.id, 'denied');
      sendRecordingUnavailable(res, l, user, recPath);
      return;
    }
    // checkAccess ANTES de olhar o estado da ata — senão vaza a terceiros se a ata já ficou pronta
    const access = await resolveRecordingView(res, l, user, meta, messageOpts, recPath);
    if (!access) return;
    if (meta.minutes?.status !== 'done') {
      res
        .status(404)
        .type('html')
        .send(messagePage(MSG.downloadUnavailableTitle[l], MSG.notFound[l], user, l, messageOpts));
      return;
    }
    const result = readMinutesBounded(meta.id);
    if (result.status === 'too_large') {
      res
        .status(413)
        .set('X-Kassinao-Max-Bytes', String(MAX_MINUTES_BYTES))
        .type('html')
        .send(messagePage(MSG.downloadUnavailableTitle[l], MSG.minutesTooLarge[l], user, l, messageOpts));
      return;
    }
    if (result.status === 'unavailable') {
      res
        .status(503)
        .set('Retry-After', '30')
        .type('html')
        .send(messagePage(MSG.downloadUnavailableTitle[l], MSG.minutesUnavailable[l], user, l, messageOpts));
      return;
    }
    const bounded = boundMinutesForResponse(result.minutes);
    if (bounded.truncated) {
      res
        .status(413)
        .type('html')
        .send(messagePage(MSG.downloadUnavailableTitle[l], MSG.minutesResponseLimit[l], user, l, messageOpts));
      return;
    }
    res
      .type('text/markdown; charset=utf-8')
      .attachment(`kassinao-${meta.id}-ata.md`)
      .send(minutesToMarkdown(meta, bounded.minutes));
  });

  app.get('/app/rec/:id/transcricao.:ext(md|txt)', async (req, res) => {
    const l = pageLang(req);
    const messageOpts = recordingMessageOptions(req.params.id, l);
    const recPath = `/app/rec/${encodeURIComponent(req.params.id)}`;
    const user = getWebUser(req);
    if (!user) {
      sendPrivateLoginRequired(res, l, `/app/rec/${req.params.id}`);
      return;
    }
    if (notReady(res, l, user, messageOpts)) return;
    const meta = readMeta(req.params.id);
    if (!meta) {
      logRecordingDenial(user.id, 'denied');
      sendRecordingUnavailable(res, l, user, recPath);
      return;
    }
    // checkAccess ANTES do estado da transcrição — não vaza a terceiros se já ficou pronta
    const access = await resolveRecordingView(res, l, user, meta, messageOpts, recPath);
    if (!access) return;
    if (!transcriptReady(meta)) {
      res
        .status(404)
        .type('html')
        .send(messagePage(MSG.downloadUnavailableTitle[l], MSG.notFound[l], user, l, messageOpts));
      return;
    }
    if (webHeavyReadRateLimited(user.id)) {
      res
        .status(429)
        .set('Retry-After', '30')
        .type('html')
        .send(messagePage(MSG.downloadUnavailableTitle[l], MSG.tooManyRequests[l], user, l, messageOpts));
      return;
    }
    const transcript = readTranscriptBounded(meta.id, WEB_DIRECT_TRANSCRIPT_MAX_BYTES);
    if (
      transcript.status === 'too_large' ||
      (transcript.status === 'ok' && transcript.segments.length > WEB_DIRECT_TRANSCRIPT_MAX_SEGMENTS)
    ) {
      res
        .status(413)
        .type('html')
        .send(messagePage(MSG.downloadUnavailableTitle[l], MSG.transcriptTooLarge[l], user, l, messageOpts));
      return;
    }
    if (transcript.status === 'unavailable') {
      res
        .status(503)
        .set('Retry-After', '30')
        .type('html')
        .send(messagePage(MSG.downloadUnavailableTitle[l], MSG.transcriptUnavailable[l], user, l, messageOpts));
      return;
    }
    const markdown = transcriptToMarkdown(meta, transcript.segments);
    const ext = req.params.ext;
    res
      .type(ext === 'md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8')
      .attachment(`kassinao-${meta.id}-transcricao.${ext}`)
      .send(ext === 'md' ? markdown : markdown.replace(/[*#`]/g, ''));
  });

  app.get('/app/rec/:id/download/:format', async (req, res, next) => {
    const l = pageLang(req);
    const messageOpts = recordingMessageOptions(req.params.id, l);
    const recPath = `/app/rec/${encodeURIComponent(req.params.id)}`;
    const user = getWebUser(req);
    if (!user) {
      sendPrivateLoginRequired(res, l, `/app/rec/${req.params.id}`);
      return;
    }
    if (notReady(res, l, user, messageOpts)) return;
    const format = req.params.format as CookFormat;
    if (!COOK_FORMATS.includes(format)) {
      res
        .status(400)
        .type('html')
        .send(messagePage(MSG.downloadUnavailableTitle[l], MSG.invalidFormat[l], user, l, messageOpts));
      return;
    }
    const meta = readMeta(req.params.id);
    if (!meta) {
      logRecordingDenial(user.id, 'denied');
      sendRecordingUnavailable(res, l, user, recPath);
      return;
    }
    const access = await resolveRecordingView(res, l, user, meta, messageOpts, recPath);
    if (!access) return;
    // ao vivo: cada formato cozinharia um snapshot completo dos masters (sem dedupe
    // entre formatos), enchendo o disco. Bloqueia igual à rota /audio até encerrar.
    // Por id, não por guild: com mais de uma gravação no mesmo servidor, o lookup
    // por guild acharia "uma" delas e deixaria baixar a outra em plena captura.
    const live = meta.status === 'recording' && sessionManager.getById(meta.id) !== undefined;
    if (live) {
      res
        .status(409)
        .type('html')
        .send(messagePage(MSG.downloadUnavailableTitle[l], MSG.downloadAfterStop[l], user, l, messageOpts));
      return;
    }
    if (meta.audioDeleted) {
      res
        .status(410)
        .type('html')
        .send(messagePage(MSG.downloadUnavailableTitle[l], MSG.audioExpiredTextKept[l], user, l, messageOpts));
      return;
    }
    // Reserva antes do cook: o processamento já conta como download em andamento
    // e a cota impede streams simultâneos ilimitados por usuário ou globalmente.
    const download = acquireDownload(meta.id, user.id);
    if (!download) {
      res
        .status(429)
        .set('Retry-After', '30')
        .type('html')
        .send(messagePage(MSG.downloadUnavailableTitle[l], MSG.tooManyRequests[l], user, l, messageOpts));
      return;
    }
    let cookSettled = false;
    let responseClosed = false;
    res.once('close', () => {
      responseClosed = true;
      if (cookSettled) download.release();
    });
    try {
      const result = await cook(meta, format);
      cookSettled = true;
      if (responseClosed) {
        download.release();
        return;
      }
      res.download(result.filePath, result.fileName, (err?: Error) => {
        download.release();
        if (!err) return;
        const errorClass = webDeliveryErrorClass(err);
        if (errorClass === 'client-abort') return;
        console.error(`Falha no envio de mídia: delivery_error=${errorClass}`);
        if (res.headersSent) {
          next(new Error('media delivery failed'));
          return;
        }
        res
          .status(500)
          .type('html')
          .send(messagePage(MSG.cookErrorTitle[l], MSG.cookError[l], user, l, messageOpts));
      });
    } catch (err) {
      cookSettled = true;
      download.release();
      if (err instanceof CookBusyError) {
        res
          .status(503)
          .set('Retry-After', '20')
          .type('html')
          .send(messagePage(MSG.cookErrorTitle[l], MSG.cookError[l], user, l, messageOpts));
        return;
      }
      console.error(
        `Erro processando download recording=${operationalPii(meta.id)} format=${format}: ${operationalError(err)}`,
      );
      res
        .status(500)
        .type('html')
        .send(messagePage(MSG.cookErrorTitle[l], MSG.cookError[l], user, l, messageOpts));
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

  app.post('/app/rec/:id/liberar-audio', async (req, res, next) => {
    const l = pageLang(req);
    const messageOpts = recordingMessageOptions(req.params.id, l);
    const recPath = `/app/rec/${encodeURIComponent(req.params.id)}`;
    const user = getWebUser(req);
    if (!user) {
      res.redirect(303, `/app/rec/${encodeURIComponent(req.params.id)}`);
      return;
    }
    if (notReady(res, l, user, messageOpts)) return;
    try {
      await withRecordingMutationLock(req.params.id, async () => {
        const meta = readMeta(req.params.id);
        if (!meta) {
          sendRecordingUnavailable(res, l, user, recPath);
          return;
        }
        // throwOnTransient: falha momentânea do Discord (429/5xx, orçamento de
        // members.fetch) vira 503 com Retry-After, como nas leituras. Sem isso o
        // dono clicava em apagar e lia "gravação não existe" para uma gravação viva.
        let access;
        try {
          access = await checkAccess(user, meta, { freshMember: true, throwOnTransient: true });
        } catch (err) {
          if (!(err instanceof TransientAccessError)) throw err;
          // Mesma regra do GET: só quem já consta na meta recebe o 503 retriável.
          // Para terceiros o 503 seria um oráculo de existência da gravação.
          logRecordingDenial(user.id, 'transient');
          if (recordingIdentityGrant(user.id, meta).view) sendAccessTemporarilyUnavailable(res, l, user, messageOpts);
          else sendRecordingUnavailable(res, l, user, recPath);
          return;
        }
        if (!access.delete) {
          sendRecordingUnavailable(res, l, user, recPath);
          return;
        }
        // checkAccess faz REST e cede o event loop. Cleanup ou outra rotina pode
        // ter removido a gravação nesse intervalo; nunca grave usando a meta stale.
        const current = readMeta(req.params.id);
        if (!current) {
          sendRecordingUnavailable(res, l, user, recPath);
          return;
        }
        if (current.status === 'recording') {
          res
            .status(409)
            .type('html')
            .send(messagePage(MSG.freeLiveTitle[l], MSG.freeLive[l], user, l, messageOpts));
          return;
        }
        if (hasActiveDownloads(current.id) || isTranscribing(current.id) || transcriptionNeedsAudio(current)) {
          res
            .status(409)
            .type('html')
            .send(messagePage(MSG.freeBusyTitle[l], MSG.freeBusy[l], user, l, messageOpts));
          return;
        }
        if (current.audioDeleted) {
          // idempotente: dois cliques/abas não viram erro assustador
          res.type('html').send(messagePage(MSG.freeGoneTitle[l], MSG.freeGone[l], user, l, messageOpts));
          return;
        }
        deleteAudioOnly(current);
        console.log(
          `Áudio da gravação recording=${operationalPii(current.id)} liberado por user_name=${operationalPii(user.name)} user=${operationalPii(user.id)}.`,
        );
        res.redirect(303, req.query.back === 'index' ? '/app?freed=1' : `/app/rec/${current.id}?freed=1#exportar`);
      });
    } catch (error) {
      const errorClass = webDeliveryErrorClass(error);
      console.error(`Falha ao liberar áudio: mutation_error=${errorClass}`);
      if (res.headersSent) {
        next(new Error('recording audio release failed'));
        return;
      }
      res
        .status(500)
        .type('html')
        .send(messagePage(MSG.freeErrorTitle[l], MSG.freeError[l], user, l, messageOpts));
    }
  });

  app.post('/app/rec/:id/delete', async (req, res, next) => {
    const l = pageLang(req);
    const messageOpts = recordingMessageOptions(req.params.id, l);
    const recPath = `/app/rec/${encodeURIComponent(req.params.id)}`;
    const user = getWebUser(req);
    if (!user) {
      res.redirect(303, `/app/rec/${encodeURIComponent(req.params.id)}`);
      return;
    }
    if (notReady(res, l, user, messageOpts)) return;
    try {
      await withRecordingMutationLock(req.params.id, async () => {
        const meta = readMeta(req.params.id);
        if (!meta) {
          sendRecordingUnavailable(res, l, user, recPath);
          return;
        }
        // throwOnTransient: falha momentânea do Discord (429/5xx, orçamento de
        // members.fetch) vira 503 com Retry-After, como nas leituras. Sem isso o
        // dono clicava em apagar e lia "gravação não existe" para uma gravação viva.
        let access;
        try {
          access = await checkAccess(user, meta, { freshMember: true, throwOnTransient: true });
        } catch (err) {
          if (!(err instanceof TransientAccessError)) throw err;
          // Mesma regra do GET: só quem já consta na meta recebe o 503 retriável.
          // Para terceiros o 503 seria um oráculo de existência da gravação.
          logRecordingDenial(user.id, 'transient');
          if (recordingIdentityGrant(user.id, meta).view) sendAccessTemporarilyUnavailable(res, l, user, messageOpts);
          else sendRecordingUnavailable(res, l, user, recPath);
          return;
        }
        if (!access.delete) {
          sendRecordingUnavailable(res, l, user, recPath);
          return;
        }
        const current = readMeta(req.params.id);
        if (!current) {
          sendRecordingUnavailable(res, l, user, recPath);
          return;
        }
        if (current.status === 'recording') {
          res
            .status(409)
            .type('html')
            .send(messagePage(MSG.deleteLiveTitle[l], MSG.deleteLive[l], user, l, messageOpts));
          return;
        }
        if (hasActiveDownloads(current.id) || isTranscribing(current.id)) {
          res
            .status(409)
            .type('html')
            .send(messagePage(MSG.deleteBusyTitle[l], MSG.deleteBusy[l], user, l, messageOpts));
          return;
        }
        deleteRecording(current.id);
        forgetAudioBytes(current.id);
        console.log(
          `Gravação recording=${operationalPii(current.id)} apagada por user_name=${operationalPii(user.name)} user=${operationalPii(user.id)}.`,
        );
        // Post/Redirect/Get: atualizar a página nunca reenvia uma exclusão.
        res.redirect(303, '/app?deleted=1');
      });
    } catch (error) {
      const errorClass = webDeliveryErrorClass(error);
      console.error(`Falha ao apagar gravação: mutation_error=${errorClass}`);
      if (res.headersSent) {
        next(new Error('recording deletion failed'));
        return;
      }
      res
        .status(500)
        .type('html')
        .send(messagePage(MSG.deleteErrorTitle[l], MSG.deleteError[l], user, l, messageOpts));
    }
  });

  // Nunca delega ao error handler de desenvolvimento do Express: bare-node é
  // suportado e não pode vazar stack, versão de dependência ou caminho do host.
  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const candidate = error as { status?: unknown; type?: unknown };
    const rawStatus = typeof candidate?.status === 'number' ? candidate.status : 500;
    const status = rawStatus >= 400 && rawStatus < 500 ? rawStatus : 500;
    const errorClass =
      candidate?.type === 'entity.parse.failed'
        ? 'invalid-body'
        : candidate?.type === 'entity.too.large'
          ? 'body-too-large'
          : status < 500
            ? 'bad-request'
            : 'internal';
    console.error(`Falha HTTP sanitizada: class=${errorClass} status=${status}`);
    res.set('Cache-Control', 'private, no-store, max-age=0').set('Pragma', 'no-cache');
    if (req.path === '/api' || req.path.startsWith('/api/')) {
      const code = status === 413 ? 'payload_too_large' : status < 500 ? 'bad_request' : 'internal';
      res.status(status).json({ error: code });
      return;
    }
    const l = pageLang(req);
    res
      .status(status)
      .type('html')
      .send(messagePage(MSG.errorTitle[l], status < 500 ? MSG.badRequest[l] : MSG.unexpected[l], undefined, l));
  });

  return app;
}

export function startWebServer(): void {
  const server = createWebApp().listen(config.port, config.webBindAddress, () => {
    console.log(
      `Servidor web origin=${operationalPii(config.baseUrl)} (listener ${config.webBindAddress}:${config.port}).`,
    );
  });
  hardenHttpServer(server);
}

/** Limites do listener contra slowloris/churn sem limitar o tempo da resposta de download. */
export function hardenHttpServer(server: HttpServer): void {
  server.requestTimeout = 120_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1_000;
}
