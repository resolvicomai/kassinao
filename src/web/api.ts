import crypto from 'node:crypto';
import express, { Express, NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { isClientReady } from '../discord/ready';
import { minutesToMarkdown } from '../processing/minutes';
import { transcriptToMarkdown } from '../processing/transcribe';
import { cleanInline, cleanText, neutralizeFences } from '../sanitize';
import {
  MAX_MINUTES_BYTES,
  MAX_MINUTES_ITEMS_PER_COLLECTION,
  MAX_MINUTES_PARTICIPANTS_PER_RESPONSE,
  MAX_MINUTES_POINTS_PER_PARTICIPANT,
  MAX_NOTES_PER_RECORDING,
  MAX_PRESENCE_IDENTITIES,
  MAX_PRESENCE_IDENTITIES_PER_RESPONSE,
} from '../securityLimits';
import {
  boundMinutesForResponse,
  listGuildMetaScanPageInRange,
  listMetaScanPageInRange,
  MeetingMinutes,
  MetaTimelineCursor,
  pageUrl,
  readMeta,
  readMinutes,
  readMinutesBounded,
  readTranscriptBounded,
  readTranscriptForAggregateSearch,
  RecordingMeta,
  textExpiryOf,
  transcriptReady,
  TranscriptSegment,
} from '../store';
import {
  checkAccessForMcp,
  createAccessRequestContext,
  currentGuildMembership,
  prevalidateGuildMembershipForMcp,
  TransientAccessError,
} from './access';
import { getMcpUser, McpToken, signMcpAccess, signMcpRefresh, verifyMcpRefresh } from './auth';
import {
  claimExchangeCode,
  commitExchangeCode,
  createSession,
  isRefreshAttemptId,
  isActiveSession,
  McpSessionCapacityError,
  revokeUser,
  revokeUserSession,
  releaseExchangeCode,
  rotateSession,
} from './mcpTokens';
import { OpaqueCursorError, openOpaqueCursor, sealOpaqueCursor } from './opaqueCursor';
import { formatInTz, RangeError as WindowError, RangeInput, resolveRange, ResolvedRange } from './range';
import { revokeWebSessionsForUser } from './webSessions';

/**
 * API /api/* que o conector MCP consome. É a ÚNICA porta dos dados de reunião para
 * um assistente de IA, e delega TODO o acesso ao checkAccessForMcp (fonte única).
 *
 * Invariantes de segurança (mapeadas aos achados do adversário):
 *  - middleware em ordem: readiness → rate-limit → auth (401 uniforme) → sessão ativa
 *    (revogação) → auditoria.
 *  - em TODA rota: checkAccess ANTES de ler transcript/minutes de uma gravação.
 *  - "não existe" e "sem acesso" colapsam no MESMO 404 (sem oráculo de enumeração).
 *  - nada de cook()/áudio; nada de escrita.
 *  - conteúdo de terceiros é limpo na saída (cleanText/cleanInline/neutralizeFences).
 */

const ACCESS_TTL_MS = config.mcpAccessTtlMin * 60000;
const MAX_AGGREGATE_MEETINGS = 300;
const MAX_LIST_MEETINGS = 300;
const MAX_CANDIDATE_METAS_PER_REQUEST = 500;
const MAX_ACCESS_GUILDS_PER_REQUEST = 25;
const MAX_SCAN_REQUESTS_PER_MINUTE = 12;
const MAX_GLOBAL_SCAN_REQUESTS_PER_MINUTE = 30;
const MAX_ACTIONS_PER_MEETING = 200;
const MAX_TRANSCRIPT_SEARCH_BYTES = 5 * 1024 * 1024;
const MAX_SEARCH_SEGMENTS_PER_MEETING = 5_000;
const MAX_SEARCH_HITS_PER_MEETING = 30;
const MAX_NOTES_PER_MEETING = MAX_NOTES_PER_RECORDING;
const MAX_TRANSCRIPT_BYTES_PER_REQUEST = 25 * 1024 * 1024;
const MAX_SEARCH_SEGMENTS_PER_REQUEST = 25_000;
export const MCP_DIRECT_TRANSCRIPT_MAX_BYTES = 5 * 1024 * 1024;
export const MCP_DIRECT_TRANSCRIPT_MAX_SEGMENTS = 5_000;
const MAX_DIRECT_TRANSCRIPT_REQUESTS_PER_MINUTE = 12;
const MAX_GLOBAL_DIRECT_TRANSCRIPT_REQUESTS_PER_MINUTE = 30;

// ---------- rate limit (janela fixa, por chave) ----------

interface Bucket {
  count: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private nextSweepAt = 0;

  constructor(
    private readonly maxKeys = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  get trackedKeys(): number {
    return this.buckets.size;
  }

  reset(): void {
    this.buckets.clear();
    this.nextSweepAt = 0;
  }

  consume(key: string, max: number, windowMs: number): boolean {
    const now = this.now();
    const current = this.buckets.get(key);
    if (current && current.resetAt > now) {
      current.count++;
      // Mantém chaves globais/quentes fora da expulsão por cardinalidade.
      this.buckets.delete(key);
      this.buckets.set(key, current);
      return current.count > max;
    }
    if (current) this.buckets.delete(key);

    // Chave nova é o caminho usado num ataque distribuído. Remove expiradas e,
    // se todas ainda estiverem vivas, sacrifica a chave menos usada recentemente.
    // Map preserva ordem de inserção e acessos vivos a renovam, mantendo O(1).
    if (now >= this.nextSweepAt) {
      for (const [candidate, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(candidate);
      this.nextSweepAt = now + Math.min(windowMs, 1_000);
    }
    if (this.buckets.size >= this.maxKeys) {
      const oldestKey = this.buckets.keys().next().value as string | undefined;
      if (oldestKey) this.buckets.delete(oldestKey);
    }
    this.buckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
}

/**
 * Mantém chaves controláveis pelo cliente e cotas globais em mapas distintos.
 * Assim, cardinalidade de IP/JTI/userId nunca consegue expulsar e reiniciar um
 * bucket global ainda ativo.
 */
export class ApiRateLimiters {
  private readonly keyed: FixedWindowRateLimiter;
  private readonly global: FixedWindowRateLimiter;

  constructor(maxKeyedKeys = 5_000, maxGlobalKeys = 16, now: () => number = Date.now) {
    this.keyed = new FixedWindowRateLimiter(maxKeyedKeys, now);
    this.global = new FixedWindowRateLimiter(maxGlobalKeys, now);
  }

  consumeKey(key: string, max: number, windowMs: number): boolean {
    return this.keyed.consume(key, max, windowMs);
  }

  consumeGlobal(key: string, max: number, windowMs: number): boolean {
    return this.global.consume(key, max, windowMs);
  }

  reset(): void {
    this.keyed.reset();
    this.global.reset();
  }
}

const rateLimiters = new ApiRateLimiters();

export function resetMcpApiRateLimitsForTests(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('test_only');
  rateLimiters.reset();
}

function rateLimited(key: string, max: number, windowMs: number): boolean {
  return rateLimiters.consumeKey(key, max, windowMs);
}

function globalRateLimited(key: string, max: number, windowMs: number): boolean {
  return rateLimiters.consumeGlobal(key, max, windowMs);
}

function clientIp(req: Request): string {
  // NUNCA ler X-Forwarded-For[0] (o cliente forja e rotaciona, furando o rate-limit).
  // Com `trust proxy=1` (definido no server), req.ip é o hop confiável atrás do Cloudflare.
  return req.ip ?? 'unknown';
}

/**
 * Gate barato que roda ANTES do parser JSON. Sem ele, um atacante anônimo pode
 * obrigar o processo a ler/alocar corpos em /api sem consumir limite algum.
 * Os limites específicos de exchange/refresh e das rotas autenticadas seguem
 * existindo depois deste teto de borda.
 */
export function preBodyApiRateGate(req: Request, res: Response, next: NextFunction): void {
  if (
    rateLimited(`api-prebody-ip:${clientIp(req)}`, 180, 60_000) ||
    globalRateLimited('api-prebody-global', 900, 60_000)
  ) {
    res.status(429).set('Retry-After', '30').json({ error: 'rate_limited' });
    return;
  }
  next();
}

// ---------- helpers de query ----------

function qstr(req: Request, name: string): string | undefined {
  const v = req.query[name];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function qint(req: Request, name: string, def: number, max: number): number {
  const v = Number(qstr(req, name));
  return Number.isFinite(v) ? Math.min(Math.max(1, Math.trunc(v)), max) : def;
}

function rangeFromQuery(req: Request): RangeInput {
  return { from: qstr(req, 'from'), to: qstr(req, 'to'), preset: qstr(req, 'preset'), last: qstr(req, 'last') };
}

function rangeFingerprint(input: RangeInput): readonly unknown[] {
  return [input.from ?? null, input.to ?? null, input.preset ?? null, input.last ?? null];
}

// ---------- serializadores (limpam conteúdo de terceiros) ----------

function deepLink(id: string, ms: number): string {
  return `${pageUrl(id)}#t=${Math.floor(ms / 1000)}`;
}

function meetingSummary(m: RecordingMeta): Record<string, unknown> {
  // presença ≠ participante: quem esteve na call sem falar também conta —
  // sem isso a IA responde "quem estava na call?" factualmente errado
  const spoke = new Set(m.participants.map((p) => p.id));
  const presence = m.presence ?? [];
  const silentPresence = presence.filter((p) => !spoke.has(p.id));
  const participants = m.participants.slice(0, MAX_PRESENCE_IDENTITIES_PER_RESPONSE).map((p) => cleanInline(p.name));
  const silentLimit = Math.max(0, MAX_PRESENCE_IDENTITIES_PER_RESPONSE - participants.length);
  const silent = silentPresence.slice(0, silentLimit).map((p) => cleanInline(p.name));
  return {
    id: m.id,
    url: pageUrl(m.id),
    guildName: cleanInline(m.guildName),
    channel: cleanInline(m.voiceChannelName),
    startedAtISO: formatInTz(m.startedAt),
    endedAtISO: m.endedAt ? formatInTz(m.endedAt) : null,
    durationMin: m.endedAt ? Math.round((m.endedAt - m.startedAt) / 60000) : null,
    participants,
    participantCount: m.participants.length,
    participantsTruncated: m.participants.length > participants.length,
    participantLimit: MAX_PRESENCE_IDENTITIES_PER_RESPONSE,
    /** Presentes que NÃO falaram (mutados/só ouvindo). */
    presentSilent: silent,
    presentSilentTruncated: silentPresence.length > silent.length,
    presentSilentLimit: silentLimit,
    presenceLimit: MAX_PRESENCE_IDENTITIES,
    presentCount: presence.length || m.participants.length,
    startedByName: m.startedBy ? cleanInline(m.startedBy.name) : null,
    status: m.status,
    hasTranscript: transcriptReady(m),
    /** 'partial' = faltam faixas (o cliente deve tratar o transcript como incompleto). */
    transcriptStatus: m.transcription?.status ?? 'none',
    hasMinutes: m.minutes?.status === 'done',
    /** Retenção em camadas: áudio pode já ter expirado (texto continua). */
    audioDeleted: m.audioDeleted ?? false,
    /** null = nunca expira (retenção ilimitada ou config atual sem data). */
    textExpiresAtISO: (() => {
      const exp = textExpiryOf(m);
      return exp ? formatInTz(exp) : null;
    })(),
    noteCount: m.notes.length,
  };
}

function cleanSegments(id: string, segs: TranscriptSegment[]): Record<string, unknown>[] {
  return segs.map((s) => ({
    speaker: cleanInline(s.speaker),
    startMs: s.startMs,
    endMs: s.endMs,
    text: neutralizeFences(cleanText(s.text)),
    deepLink: deepLink(id, s.startMs),
  }));
}

function cleanMinutes(m: MeetingMinutes): Record<string, unknown> {
  const { minutes } = boundMinutesForResponse(m);
  return {
    resumo: neutralizeFences(cleanText(minutes.resumo)),
    decisoes: minutes.decisoes.map((d) => neutralizeFences(cleanInline(d))),
    acoes: minutes.acoes.map((a) => ({
      tarefa: neutralizeFences(cleanInline(a.tarefa)),
      responsavel: a.responsavel ? cleanInline(a.responsavel) : null,
      prazo: a.prazo ? cleanInline(a.prazo) : null,
    })),
    topicos: minutes.topicos.map((t) => ({
      titulo: neutralizeFences(cleanInline(t.titulo)),
      inicioMs: t.inicioMs,
    })),
    porParticipante: minutes.porParticipante.map((p) => ({
      nome: cleanInline(p.nome),
      pontos: p.pontos.map((x) => neutralizeFences(cleanInline(x))),
    })),
  };
}

const MINUTES_RESPONSE_LIMITS = {
  itemsPerCollection: MAX_MINUTES_ITEMS_PER_COLLECTION,
  participants: MAX_MINUTES_PARTICIPANTS_PER_RESPONSE,
  pointsPerParticipant: MAX_MINUTES_POINTS_PER_PARTICIPANT,
} as const;

// ---------- acesso: metas visíveis dentro de uma janela ----------

interface MetaFilters {
  guildId?: string;
  channelId?: string;
  participantId?: string;
  status?: string;
}

interface ScanCursorOptions {
  rawCursor?: string;
  rawResultCursor?: string;
  resultKind?: AggregateCursorKind;
  context: string;
}

interface VisibleWindowResult {
  metas: RecordingMeta[];
  anchors: MetaTimelineCursor[];
  truncated: boolean;
  nextScanCursor: string | null;
  stopReason: 'visible' | 'guild' | 'candidate' | null;
  range: ResolvedRange;
  resume?: AggregateCursorPayload;
}

interface CandidateForScan {
  id: string;
  guildId: string;
}

export interface VisibleCandidateScanResult<T> {
  metas: T[];
  anchors: MetaTimelineCursor[];
  /** Última candidata consumida; a candidata que bateu no teto fica para a próxima página. */
  lastProcessed?: MetaTimelineCursor;
  limitReached: boolean;
  stopReason: 'visible' | 'guild' | null;
}

/**
 * Núcleo isolável do scanner. O 26º guild não é consumido e a 301ª meta
 * visível é autorizada, mas fica ancorada para a próxima requisição. Assim
 * nenhum item some entre páginas e nenhuma meta devolvida escapa da ACL.
 */
export async function scanVisibleCandidates<T extends CandidateForScan>(
  candidates: readonly MetaTimelineCursor[],
  options: {
    maxVisible: number;
    maxGuilds: number;
    load: (id: string) => T | undefined;
    matches: (meta: T, candidate: MetaTimelineCursor) => boolean;
    authorize: (meta: T) => Promise<boolean>;
  },
): Promise<VisibleCandidateScanResult<T>> {
  const metas: T[] = [];
  const anchors: MetaTimelineCursor[] = [];
  const checkedGuilds = new Set<string>();
  let lastProcessed: MetaTimelineCursor | undefined;

  for (const candidate of candidates) {
    const meta = options.load(candidate.id);
    if (!meta || !options.matches(meta, candidate)) {
      lastProcessed = candidate;
      continue;
    }
    if (!checkedGuilds.has(meta.guildId)) {
      if (checkedGuilds.size >= options.maxGuilds)
        return { metas, anchors, lastProcessed, limitReached: true, stopReason: 'guild' };
      checkedGuilds.add(meta.guildId);
    }

    const allowed = await options.authorize(meta);
    if (allowed && metas.length >= options.maxVisible)
      return { metas, anchors, lastProcessed, limitReached: true, stopReason: 'visible' };
    if (allowed) {
      metas.push(meta);
      anchors.push(candidate);
    }
    lastProcessed = candidate;
  }
  return { metas, anchors, lastProcessed, limitReached: false, stopReason: null };
}

interface ScanCursorPayload {
  anchor: MetaTimelineCursor;
  fromMs: number;
  toMs: number;
}

type AggregateCursorKind = 'actions' | 'search' | 'said';
type AggregateCursorPhase = 'search-minutes' | 'search-transcript' | 'search-notes';

interface AggregateCursorPayload extends ScanCursorPayload {
  kind: AggregateCursorKind;
  /** Índice bruto da próxima ação/segmento na mesma reunião. */
  suboffset?: number;
  /** Evita repetir minutes/notes ao retomar um pedaço posterior do transcript. */
  phase?: AggregateCursorPhase;
  /** SHA-256 sem segredo do conteúdo posicional; o token inteiro é AEAD. */
  version?: string;
}

function scanContext(route: string, rangeInput: readonly unknown[], filters: readonly unknown[]): string {
  const canonical = JSON.stringify([1, route, ...rangeInput, ...filters]);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

function cursorOptions(user: McpToken, context: string) {
  return {
    secret: config.mcpAccessSecret,
    purpose: 'mcp-scan',
    subject: user.id,
    context,
  } as const;
}

function resultCursorOptions(user: McpToken, context: string, kind: AggregateCursorKind) {
  return {
    secret: config.mcpAccessSecret,
    purpose: `mcp-result-${kind}`,
    subject: user.id,
    context,
  } as const;
}

function validTimelineCursor(cursor: unknown): cursor is MetaTimelineCursor {
  if (!cursor || typeof cursor !== 'object') return false;
  const candidate = cursor as Partial<MetaTimelineCursor>;
  return (
    Number.isSafeInteger(candidate.startedAt) &&
    (candidate.startedAt as number) >= 0 &&
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    candidate.id.length <= 256 &&
    /^[a-zA-Z0-9-]+$/.test(candidate.id)
  );
}

function openScanCursor(user: McpToken, raw: string | undefined, context: string): ScanCursorPayload | undefined {
  if (!raw) return undefined;
  const cursor = openOpaqueCursor<ScanCursorPayload>(raw, cursorOptions(user, context));
  if (
    !cursor ||
    !validTimelineCursor(cursor.anchor) ||
    !Number.isSafeInteger(cursor.fromMs) ||
    !Number.isSafeInteger(cursor.toMs) ||
    cursor.fromMs < 0 ||
    cursor.fromMs >= cursor.toMs
  )
    throw new OpaqueCursorError();
  return cursor;
}

function sealScanCursor(user: McpToken, cursor: MetaTimelineCursor, range: ResolvedRange, context: string): string {
  return sealOpaqueCursor(
    { anchor: cursor, fromMs: range.fromMs, toMs: range.toMs } satisfies ScanCursorPayload,
    cursorOptions(user, context),
  );
}

function openResultCursor(
  user: McpToken,
  raw: string,
  context: string,
  expectedKind: AggregateCursorKind,
): AggregateCursorPayload {
  const cursor = openOpaqueCursor<AggregateCursorPayload>(raw, resultCursorOptions(user, context, expectedKind));
  if (
    !cursor ||
    cursor.kind !== expectedKind ||
    !validTimelineCursor(cursor.anchor) ||
    !Number.isSafeInteger(cursor.fromMs) ||
    !Number.isSafeInteger(cursor.toMs) ||
    cursor.fromMs < 0 ||
    cursor.fromMs >= cursor.toMs ||
    (cursor.suboffset !== undefined &&
      (!Number.isSafeInteger(cursor.suboffset) || cursor.suboffset < 0 || cursor.suboffset > 1_000_000)) ||
    (cursor.phase !== undefined &&
      (cursor.kind !== 'search' || !['search-minutes', 'search-transcript', 'search-notes'].includes(cursor.phase))) ||
    (cursor.version !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(cursor.version)) ||
    (cursor.kind === 'search' && cursor.suboffset !== undefined && cursor.phase === undefined) ||
    (cursor.phase !== undefined && (cursor.suboffset ?? 0) > 0 && cursor.version === undefined)
  )
    throw new OpaqueCursorError();
  return cursor;
}

function sealResultCursor(
  user: McpToken,
  kind: AggregateCursorKind,
  anchor: MetaTimelineCursor,
  range: ResolvedRange,
  context: string,
  suboffset?: number,
  phase?: AggregateCursorPhase,
  version?: string,
): string {
  return sealOpaqueCursor(
    {
      kind,
      anchor,
      fromMs: range.fromMs,
      toMs: range.toMs,
      ...(suboffset === undefined ? {} : { suboffset }),
      ...(phase === undefined ? {} : { phase }),
      ...(version === undefined ? {} : { version }),
    } satisfies AggregateCursorPayload,
    resultCursorOptions(user, context, kind),
  );
}

/** Participou = falou, esteve presente sem falar, ou iniciou a gravação. */
export function recordingIncludesUser(meta: RecordingMeta, userId: string): boolean {
  return (
    meta.startedBy?.id === userId ||
    meta.participants.some((p) => p.id === userId) ||
    (meta.presence?.some((p) => p.id === userId) ?? false)
  );
}

/**
 * Filtra por metadados BARATOS (janela/guild/canal) ANTES de qualquer checkAccess,
 * e só chama checkAccessForMcp depois — que pode lançar TransientAccessError (→503).
 * NENHUM byte de transcript/minutes é lido aqui: isso fica para DEPOIS do view=true.
 */
async function visibleInWindow(
  user: McpToken,
  range: ResolvedRange,
  f: MetaFilters,
  cursorOptionsForRequest: ScanCursorOptions,
  maxVisible = MAX_LIST_MEETINGS,
): Promise<VisibleWindowResult> {
  const requestContext = createAccessRequestContext();
  // O escopo explícito é confirmado ANTES de abrir cursor ou consultar índice.
  // Quem não é membro recebe a mesma página vazia, sem oráculo de cardinalidade.
  if (f.guildId && !(await prevalidateGuildMembershipForMcp(user, f.guildId, requestContext))) {
    return { metas: [], anchors: [], truncated: false, nextScanCursor: null, stopReason: null, range };
  }

  if (cursorOptionsForRequest.rawCursor && cursorOptionsForRequest.rawResultCursor) throw new OpaqueCursorError();
  const resume = cursorOptionsForRequest.rawResultCursor
    ? openResultCursor(
        user,
        cursorOptionsForRequest.rawResultCursor,
        cursorOptionsForRequest.context,
        cursorOptionsForRequest.resultKind ?? 'search',
      )
    : undefined;
  if (cursorOptionsForRequest.rawResultCursor && !cursorOptionsForRequest.resultKind) throw new OpaqueCursorError();
  const scanCursor = resume ?? openScanCursor(user, cursorOptionsForRequest.rawCursor, cursorOptionsForRequest.context);
  const effectiveRange: ResolvedRange = scanCursor
    ? {
        ...range,
        fromMs: scanCursor.fromMs,
        toMs: scanCursor.toMs,
        fromISO: formatInTz(scanCursor.fromMs),
        toISO: formatInTz(scanCursor.toMs),
      }
    : range;
  const includeResumeAnchor = resume?.suboffset !== undefined;
  const pageLimit = MAX_CANDIDATE_METAS_PER_REQUEST - (includeResumeAnchor ? 1 : 0);
  const page = f.guildId
    ? listGuildMetaScanPageInRange(f.guildId, effectiveRange.fromMs, effectiveRange.toMs, scanCursor?.anchor, pageLimit)
    : listMetaScanPageInRange(effectiveRange.fromMs, effectiveRange.toMs, scanCursor?.anchor, pageLimit);
  const candidates = includeResumeAnchor ? [resume!.anchor, ...page.candidates] : page.candidates;
  const scan = await scanVisibleCandidates(candidates, {
    maxVisible,
    maxGuilds: MAX_ACCESS_GUILDS_PER_REQUEST,
    load: readMeta,
    matches: (m, candidate) =>
      m.startedAt === candidate.startedAt &&
      (m.id !== scanCursor?.anchor.id ||
        (includeResumeAnchor &&
          candidate.id === resume?.anchor.id &&
          candidate.startedAt === resume?.anchor.startedAt)) &&
      !m.demo &&
      config.guildPolicy.allows(m.guildId) &&
      (!f.guildId || m.guildId === f.guildId) &&
      (!f.channelId || m.voiceChannelId === f.channelId) &&
      (!f.status || m.status === f.status) &&
      (!f.participantId || recordingIncludesUser(m, f.participantId)),
    authorize: async (m) => (await checkAccessForMcp(user, m, { requestContext })).view,
  });

  // Exatamente 500 também devolve continuação. Isso pode gerar uma página
  // vazia final, mas não consulta a 501ª candidata nem revela cardinalidade bruta.
  const budgetReached = scan.limitReached || candidates.length >= MAX_CANDIDATE_METAS_PER_REQUEST;
  const stopReason = scan.stopReason ?? (budgetReached ? 'candidate' : null);
  const nextScanCursor =
    budgetReached && scan.lastProcessed
      ? sealScanCursor(user, scan.lastProcessed, effectiveRange, cursorOptionsForRequest.context)
      : null;
  return {
    metas: scan.metas,
    anchors: scan.anchors,
    truncated: nextScanCursor !== null,
    nextScanCursor,
    stopReason,
    range: effectiveRange,
    resume,
  };
}

/** Resolve uma gravação SÓ se o usuário pode vê-la; senão 404 (igual a inexistente). */
async function getViewable(user: McpToken, id: string): Promise<RecordingMeta | undefined> {
  const meta = readMeta(id);
  if (!meta || meta.demo || !config.guildPolicy.allows(meta.guildId)) return undefined;
  const access = await checkAccessForMcp(user, meta); // pode lançar → 503
  return access.view ? meta : undefined;
}

// ---------- busca ----------

function snippet(text: string, idx: number, len: number): string {
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + len + 60);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

interface SearchHit {
  where: string;
  snippet: string;
  speaker?: string;
  atMs?: number;
  deepLink?: string;
}

interface SearchSourceItem {
  text: string;
  hit: SearchHit;
}

const SEARCH_PHASES: readonly AggregateCursorPhase[] = ['search-minutes', 'search-transcript', 'search-notes'];

function minutesSearchItems(minutes: MeetingMinutes): SearchSourceItem[] {
  return [
    {
      text: minutes.resumo,
      hit: { where: 'summary', snippet: neutralizeFences(cleanInline(minutes.resumo)).slice(0, 240) },
    },
    ...minutes.decisoes.map((decision) => ({
      text: decision,
      hit: { where: 'decision', snippet: neutralizeFences(cleanInline(decision)) },
    })),
    ...minutes.acoes.map((action) => ({
      text: action.tarefa,
      hit: { where: 'action', snippet: neutralizeFences(cleanInline(action.tarefa)) },
    })),
    ...minutes.topicos.map((topic) => ({
      text: topic.titulo,
      hit: {
        where: 'topic',
        snippet: neutralizeFences(cleanInline(topic.titulo)),
        atMs: topic.inicioMs,
      },
    })),
  ];
}

function noteSearchItems(meta: RecordingMeta): SearchSourceItem[] {
  return meta.notes.slice(0, MAX_NOTES_PER_MEETING).map((note) => ({
    text: note.text,
    hit: {
      where: 'note',
      atMs: note.atMs,
      snippet: neutralizeFences(cleanInline(note.text)),
      deepLink: deepLink(meta.id, note.atMs),
    },
  }));
}

/** Normaliza pra busca: minúsculas + sem acentos ("orcamento" acha "orçamento"). */
function searchNorm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function positionalContentVersion(domain: string, value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(domain, 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify(value), 'utf8')
    .digest('base64url');
}

export function normalizedSearchTerms(query: string): string[] {
  return searchNorm(query).split(/\s+/).filter(Boolean);
}

function matchIn(haystack: string, terms: string[], mode: string): number {
  const h = searchNorm(haystack);
  if (mode === 'phrase') return h.includes(terms.join(' ')) ? 1 : 0;
  const hits = terms.filter((t) => h.includes(t));
  if (mode === 'all') return hits.length === terms.length ? hits.length : 0;
  return hits.length; // any
}

// ---------- prazos (parse best-effort, só datas absolutas) ----------

const ABS_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const BR_DATE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/;

function parseDeadline(prazo: string, nowMs: number): number | null {
  const iso = ABS_DATE.exec(prazo);
  if (iso) {
    const t = Date.parse(`${iso[1]}-${iso[2]}-${iso[3]}T12:00:00${tzOffsetSuffix(nowMs)}`);
    return Number.isFinite(t) ? t : null;
  }
  const br = BR_DATE.exec(prazo);
  if (br) {
    const y = br[3] ? (br[3].length === 2 ? 2000 + Number(br[3]) : Number(br[3])) : new Date(nowMs).getUTCFullYear();
    const t = Date.parse(
      `${y}-${String(Number(br[2])).padStart(2, '0')}-${String(Number(br[1])).padStart(2, '0')}T12:00:00${tzOffsetSuffix(nowMs)}`,
    );
    return Number.isFinite(t) ? t : null;
  }
  return null; // "Wed", "próxima sprint", "asap"... → inparseável (bucket próprio)
}

function tzOffsetSuffix(atMs: number): string {
  // reaproveita o formatInTz para pegar o offset ("...-03:00") do fuso do config
  const iso = formatInTz(atMs);
  return iso.slice(-6);
}

// ---------- middlewares ----------

function readinessGate(_req: Request, res: Response, next: NextFunction): void {
  if (!isClientReady()) {
    res.status(503).set('Retry-After', '5').json({ error: 'starting' });
    return;
  }
  next();
}

function ipRateGate(req: Request, res: Response, next: NextFunction): void {
  if (rateLimited(`ip:${clientIp(req)}`, 120, 60_000)) {
    res.status(429).set('Retry-After', '30').json({ error: 'rate_limited' });
    return;
  }
  next();
}

// 401 SEMPRE idêntico: ausente/malformado/HMAC-inválido/typ-errado/exp-vencido/revogado.
function authGate(req: Request, res: Response, next: NextFunction): void {
  const token = getMcpUser(req);
  if (!token || !isActiveSession(token.jti)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (rateLimited(`jti:${token.jti}`, 60, 60_000)) {
    res.status(429).set('Retry-After', '30').json({ error: 'rate_limited' });
    return;
  }
  res.locals.mcpUser = token;
  next();
}

/** Consultas que varrem janelas têm um orçamento menor que leituras por id. */
function scanRateGate(_req: Request, res: Response, next: NextFunction): void {
  const token = mcpUserOf(res);
  if (
    rateLimited(`scan-user:${token.id}`, MAX_SCAN_REQUESTS_PER_MINUTE, 60_000) ||
    globalRateLimited('scan-global', MAX_GLOBAL_SCAN_REQUESTS_PER_MINUTE, 60_000)
  ) {
    res.status(429).set('Retry-After', '30').json({ error: 'rate_limited' });
    return;
  }
  next();
}

/** Leituras que alocam/serializam transcript têm orçamento próprio por sessão. */
function transcriptReadRateGate(_req: Request, res: Response, next: NextFunction): void {
  const token = mcpUserOf(res);
  if (
    rateLimited(`transcript-user:${token.id}`, MAX_DIRECT_TRANSCRIPT_REQUESTS_PER_MINUTE, 60_000) ||
    globalRateLimited('transcript-global', MAX_GLOBAL_DIRECT_TRANSCRIPT_REQUESTS_PER_MINUTE, 60_000)
  ) {
    res.status(429).set('Retry-After', '30').json({ error: 'rate_limited' });
    return;
  }
  next();
}

function dossierTranscriptRateGate(req: Request, res: Response, next: NextFunction): void {
  const include = new Set((qstr(req, 'include') ?? 'meta,minutes,transcript,notes,timeline').split(','));
  if (!include.has('transcript')) {
    next();
    return;
  }
  transcriptReadRateGate(req, res, next);
}

function exportTranscriptRateGate(req: Request, res: Response, next: NextFunction): void {
  const format = qstr(req, 'format') ?? 'ata.md';
  if (format !== 'transcricao.md' && format !== 'transcricao.txt') {
    next();
    return;
  }
  transcriptReadRateGate(req, res, next);
}

/** `/said?meetingId=` lê transcript; a variante por janela consome scan. */
function saidScanRateGate(req: Request, res: Response, next: NextFunction): void {
  if (qstr(req, 'meetingId')) {
    transcriptReadRateGate(req, res, next);
    return;
  }
  scanRateGate(req, res, next);
}

function audit(req: Request, res: Response, next: NextFunction): void {
  res.on('finish', () => {
    const u = res.locals.mcpUser as McpToken | undefined;
    console.log(
      `[mcp-api] ${cleanInline(req.method)} ${cleanInline(req.path)} user=${cleanInline(u?.id ?? '-')} sid=${cleanInline(u?.jti ?? '-')} -> ${res.statusCode}`,
    );
  });
  next();
}

function mcpUserOf(res: Response): McpToken {
  return res.locals.mcpUser as McpToken;
}

/** Envolve handler async: input inválido→400, acesso transitório→503, resto→500. */
function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    fn(req, res).catch((err: unknown) => {
      if (err instanceof WindowError) {
        res.status(400).json({ error: 'bad_range', message: err.message });
        return;
      }
      if (err instanceof OpaqueCursorError) {
        res.status(400).json({ error: 'bad_cursor' });
        return;
      }
      if (err instanceof TransientAccessError) {
        res.status(503).set('Retry-After', '3').json({ error: 'starting' });
        return;
      }
      console.error('[mcp-api] erro:', err);
      if (!res.headersSent) res.status(500).json({ error: 'internal' });
    });
  };
}

// ---------- montagem ----------

export function mountMcpApi(app: Express): void {
  if (!config.mcpEnabled) return;

  const api = express.Router();
  // Tokens, atas e transcrições nunca devem ser armazenados por browser/proxy.
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store, max-age=0').set('Pragma', 'no-cache');
    next();
  });
  // Precisa vir antes de express.json: o corpo hostil ainda não foi lido.
  api.use(preBodyApiRateGate);
  api.use(express.json({ limit: '32kb' }));

  // ----- lifecycle de token (sem auth Bearer; protegido por rate-limit de IP) -----

  api.post(
    '/mcp/exchange',
    handle(async (req, res) => {
      if (rateLimited(`ip:${clientIp(req)}`, 20, 60_000)) {
        res.status(429).set('Retry-After', '30').json({ error: 'rate_limited' });
        return;
      }
      if (!isClientReady()) {
        res.status(503).set('Retry-After', '5').json({ error: 'starting' });
        return;
      }
      const code = typeof req.body?.code === 'string' ? req.body.code : '';
      const claimed = claimExchangeCode(code);
      if (!claimed) {
        res.status(400).json({ error: 'invalid_code' });
        return;
      }
      const membership = await currentGuildMembership(claimed.userId);
      if (membership === 'unavailable') {
        releaseExchangeCode(claimed);
        res.status(503).set('Retry-After', '5').json({ error: 'discord_unavailable' });
        return;
      }
      if (membership === 'not-member') {
        commitExchangeCode(claimed);
        // A negação é global (nenhuma guild permitida), não a saída de uma guild
        // isolada. Um código antigo não cria sessão e também encerra credenciais
        // remanescentes sem depender do intent privilegiado GuildMembers.
        revokeUser(claimed.userId);
        revokeWebSessionsForUser(claimed.userId);
        res.status(403).json({ error: 'not_authorized' });
        return;
      }
      try {
        const issued = issueTokens(claimed.userId, claimed.name, claimed.label);
        if (!commitExchangeCode(claimed)) {
          revokeUserSession(claimed.userId, issued.sid);
          throw new Error('reserva do código MCP foi perdida antes do commit');
        }
        res.set('Cache-Control', 'no-store').json(issued.body);
      } catch (err) {
        if (err instanceof McpSessionCapacityError) {
          releaseExchangeCode(claimed);
          res.status(503).set('Retry-After', '60').json({ error: 'session_capacity' });
          return;
        }
        throw err;
      }
    }),
  );

  api.post(
    '/mcp/refresh',
    handle(async (req, res) => {
      if (rateLimited(`ip:${clientIp(req)}`, 30, 60_000)) {
        res.status(429).set('Retry-After', '30').json({ error: 'rate_limited' });
        return;
      }
      if (!isClientReady()) {
        res.status(503).set('Retry-After', '5').json({ error: 'starting' });
        return;
      }
      const rt = typeof req.body?.refresh_token === 'string' ? req.body.refresh_token : undefined;
      const rawAttempt = req.body?.attempt_id as unknown;
      const attemptId = rawAttempt === undefined ? undefined : isRefreshAttemptId(rawAttempt) ? rawAttempt : null;
      if (attemptId === null) {
        res.status(400).json({ error: 'invalid_attempt' });
        return;
      }
      const parsed = verifyMcpRefresh(rt);
      if (!parsed) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const membership = await currentGuildMembership(parsed.id);
      if (membership === 'unavailable') {
        res.status(503).set('Retry-After', '5').json({ error: 'discord_unavailable' });
        return;
      }
      if (membership === 'not-member') {
        // Suspensão por saída vira revogação definitiva no primeiro refresh.
        // `currentGuildMembership` só chega aqui após verificar todas as guilds
        // permitidas, então o bug multi-guild de revogar cedo não reaparece.
        revokeUser(parsed.id);
        revokeWebSessionsForUser(parsed.id);
        res.status(403).json({ error: 'not_authorized' });
        return;
      }
      const rot = rotateSession(parsed.jti, parsed.gen, attemptId);
      if (!rot.ok) {
        // 'reuse' já matou a sessão; 'unknown' = revogada/expirada. Ambos → 401 uniforme.
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      res.set('Cache-Control', 'no-store').json(signPair(rot.userId, rot.name, parsed.jti, rot.gen, rot.exp));
    }),
  );

  // ----- rotas autenticadas de dados -----

  const authed = express.Router();
  authed.use(readinessGate);
  authed.use(ipRateGate);
  authed.use(authGate);
  authed.use(audit);

  authed.get(
    '/meetings',
    scanRateGate,
    handle(async (req, res) => {
      const user = mcpUserOf(res);
      const rangeInput = rangeFromQuery(req);
      const range = resolveRange(rangeInput, Date.now());
      const filters: MetaFilters = {
        guildId: qstr(req, 'guildId'),
        channelId: qstr(req, 'channelId'),
        participantId: qstr(req, 'participantId'),
        status: qstr(req, 'status'),
      };
      const limit = qint(req, 'limit', 20, 100);
      const resultCursor = qstr(req, 'cursor');
      const scanCursor = qstr(req, 'scanCursor');
      if (resultCursor && scanCursor) throw new OpaqueCursorError();
      const visible = await visibleInWindow(
        user,
        range,
        filters,
        {
          rawCursor: resultCursor ?? scanCursor,
          context: scanContext('meetings', rangeFingerprint(rangeInput), [
            filters.guildId ?? null,
            filters.channelId ?? null,
            filters.participantId ?? null,
            filters.status ?? null,
          ]),
        },
        limit,
      );
      const all = visible.metas;
      const nextCursor = visible.stopReason === 'visible' ? visible.nextScanCursor : null;
      const nextScanCursor = visible.stopReason === 'visible' ? null : visible.nextScanCursor;
      res.json({
        resolvedFrom: visible.range.fromISO,
        resolvedTo: visible.range.toISO,
        label: visible.range.label,
        total: all.length,
        meetingsTruncated: visible.truncated,
        meetingScanLimit: MAX_LIST_MEETINGS,
        candidateScanLimit: MAX_CANDIDATE_METAS_PER_REQUEST,
        guildScanLimit: MAX_ACCESS_GUILDS_PER_REQUEST,
        meetings: all.map(meetingSummary),
        nextCursor,
        nextScanCursor,
      });
    }),
  );

  authed.get(
    '/meetings/:id',
    dossierTranscriptRateGate,
    handle(async (req, res) => {
      const user = mcpUserOf(res);
      const meta = await getViewable(user, req.params.id);
      if (!meta) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const include = new Set((qstr(req, 'include') ?? 'meta,minutes,transcript,notes,timeline').split(','));
      const body: Record<string, unknown> = { ...meetingSummary(meta) };
      if (include.has('minutes') && meta.minutes?.status === 'done') {
        const result = readMinutesBounded(meta.id);
        body.minutesByteLimit = MAX_MINUTES_BYTES;
        body.minutesLimits = MINUTES_RESPONSE_LIMITS;
        if (result.status === 'ok') {
          const bounded = boundMinutesForResponse(result.minutes);
          body.minutes = cleanMinutes(bounded.minutes);
          body.minutesBytes = result.bytes;
          body.minutesTruncated = bounded.truncated;
        } else {
          body.minutes = null;
          body.minutesTruncated = true;
          body.minutesUnavailableReason = result.status;
          if (result.status === 'too_large') body.minutesBytes = result.bytes;
        }
      }
      if (include.has('transcript') && transcriptReady(meta)) {
        const transcript = readTranscriptBounded(meta.id, MCP_DIRECT_TRANSCRIPT_MAX_BYTES);
        body.transcriptByteLimit = MCP_DIRECT_TRANSCRIPT_MAX_BYTES;
        body.transcriptSegmentLimit = MCP_DIRECT_TRANSCRIPT_MAX_SEGMENTS;
        if (transcript.status === 'ok') {
          const limit = qint(req, 'transcriptLimit', 500, MCP_DIRECT_TRANSCRIPT_MAX_SEGMENTS);
          body.transcript = cleanSegments(meta.id, transcript.segments.slice(0, limit));
          body.transcriptBytes = transcript.bytes;
          body.transcriptTotalSegments = transcript.segments.length;
          body.transcriptTruncated = transcript.segments.length > limit;
        } else {
          body.transcript = [];
          body.transcriptTruncated = true;
          body.transcriptUnavailableReason = transcript.status;
          if (transcript.status === 'too_large') body.transcriptBytes = transcript.bytes;
        }
      }
      if (include.has('notes')) {
        body.notes = meta.notes.slice(0, MAX_NOTES_PER_MEETING).map((n) => ({
          atMs: n.atMs,
          author: cleanInline(n.author),
          text: neutralizeFences(cleanInline(n.text)),
          deepLink: deepLink(meta.id, n.atMs),
        }));
        body.notesTruncated = meta.notes.length > MAX_NOTES_PER_MEETING;
        body.noteLimit = MAX_NOTES_PER_MEETING;
      }
      if (include.has('timeline')) {
        const timeline = buildTimeline(meta);
        body.timeline = timeline.items;
        body.timelineTruncated = timeline.truncated;
        body.timelineEventLimit = 500;
        body.timelineNoteLimit = MAX_NOTES_PER_MEETING;
      }
      res.json(body);
    }),
  );

  authed.get(
    '/meetings/:id/transcript',
    transcriptReadRateGate,
    handle(async (req, res) => {
      const user = mcpUserOf(res);
      const meta = await getViewable(user, req.params.id);
      if (!meta) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (!transcriptReady(meta)) {
        res.json({
          id: meta.id,
          status: meta.transcription?.status ?? 'none',
          segments: [],
          truncated: false,
          nextCursor: null,
        });
        return;
      }
      const transcript = readTranscriptBounded(meta.id, MCP_DIRECT_TRANSCRIPT_MAX_BYTES);
      if (transcript.status === 'too_large') {
        res.status(413).json({
          error: 'transcript_too_large',
          maxBytes: MCP_DIRECT_TRANSCRIPT_MAX_BYTES,
          bytes: transcript.bytes,
          use: 'search_or_export_in_smaller_source_chunks',
        });
        return;
      }
      if (transcript.status === 'unavailable') {
        res.status(503).set('Retry-After', '30').json({ error: 'transcript_unavailable' });
        return;
      }
      const limit = qint(req, 'limit', 500, MCP_DIRECT_TRANSCRIPT_MAX_SEGMENTS);
      const offset = qint(req, 'cursor', 1, 1_000_000) - 1;
      const segments = transcript.segments.slice(offset, offset + limit);
      res.json({
        id: meta.id,
        status: meta.transcription?.status ?? 'done',
        bytes: transcript.bytes,
        maxBytes: MCP_DIRECT_TRANSCRIPT_MAX_BYTES,
        totalSegments: transcript.segments.length,
        segments: cleanSegments(meta.id, segments),
        truncated: offset + segments.length < transcript.segments.length,
        nextCursor: offset + segments.length < transcript.segments.length ? String(offset + segments.length + 1) : null,
      });
    }),
  );

  authed.get(
    '/meetings/:id/minutes',
    handle(async (req, res) => {
      const user = mcpUserOf(res);
      const meta = await getViewable(user, req.params.id);
      if (!meta) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (meta.minutes?.status !== 'done') {
        res.json({ id: meta.id, status: meta.minutes?.status ?? 'none', minutes: null });
        return;
      }
      const result = readMinutesBounded(meta.id);
      if (result.status === 'too_large') {
        res.status(413).json({
          error: 'minutes_too_large',
          maxBytes: MAX_MINUTES_BYTES,
          bytes: result.bytes,
        });
        return;
      }
      if (result.status === 'unavailable') {
        res.status(503).set('Retry-After', '30').json({ error: 'minutes_unavailable' });
        return;
      }
      const bounded = boundMinutesForResponse(result.minutes);
      res.json({
        id: meta.id,
        status: 'done',
        bytes: result.bytes,
        maxBytes: MAX_MINUTES_BYTES,
        minutes: cleanMinutes(bounded.minutes),
        minutesTruncated: bounded.truncated,
        minutesLimits: MINUTES_RESPONSE_LIMITS,
      });
    }),
  );

  authed.get(
    '/meetings/:id/export',
    exportTranscriptRateGate,
    handle(async (req, res) => {
      const user = mcpUserOf(res);
      const meta = await getViewable(user, req.params.id);
      if (!meta) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const format = qstr(req, 'format') ?? 'ata.md';
      if (format === 'ata.md') {
        if (meta.minutes?.status !== 'done') {
          res.status(404).json({ error: 'no_minutes' });
          return;
        }
        const result = readMinutesBounded(meta.id);
        if (result.status === 'too_large') {
          res.status(413).json({
            error: 'minutes_too_large',
            maxBytes: MAX_MINUTES_BYTES,
            bytes: result.bytes,
          });
          return;
        }
        if (result.status === 'unavailable') {
          res.status(503).set('Retry-After', '30').json({ error: 'minutes_unavailable' });
          return;
        }
        const bounded = boundMinutesForResponse(result.minutes);
        if (bounded.truncated) {
          res.status(413).json({
            error: 'minutes_response_limit',
            limits: MINUTES_RESPONSE_LIMITS,
            use: 'minutes_endpoint_with_truncation_metadata',
          });
          return;
        }
        res.json({
          id: meta.id,
          format,
          filename: `kassinao-${meta.id}-ata.md`,
          content: minutesToMarkdown(meta, bounded.minutes),
        });
        return;
      }
      if (format === 'transcricao.md' || format === 'transcricao.txt') {
        if (!transcriptReady(meta)) {
          res.status(404).json({ error: 'no_transcript' });
          return;
        }
        const transcript = readTranscriptBounded(meta.id, MCP_DIRECT_TRANSCRIPT_MAX_BYTES);
        if (
          transcript.status === 'too_large' ||
          (transcript.status === 'ok' && transcript.segments.length > MCP_DIRECT_TRANSCRIPT_MAX_SEGMENTS)
        ) {
          res.status(413).json({
            error: 'transcript_too_large',
            maxBytes: MCP_DIRECT_TRANSCRIPT_MAX_BYTES,
            maxSegments: MCP_DIRECT_TRANSCRIPT_MAX_SEGMENTS,
            bytes: transcript.bytes,
            segments: transcript.status === 'ok' ? transcript.segments.length : undefined,
          });
          return;
        }
        if (transcript.status === 'unavailable') {
          res.status(503).set('Retry-After', '30').json({ error: 'transcript_unavailable' });
          return;
        }
        const md = transcriptToMarkdown(meta, transcript.segments);
        const content = format === 'transcricao.txt' ? md.replace(/[*#`]/g, '') : md;
        res.json({
          id: meta.id,
          format,
          filename: `kassinao-${meta.id}-${format}`,
          transcriptStatus: meta.transcription?.status ?? 'none',
          transcriptBytes: transcript.bytes,
          transcriptSegments: transcript.segments.length,
          content,
        });
        return;
      }
      res.status(400).json({ error: 'bad_format', allowed: ['ata.md', 'transcricao.md', 'transcricao.txt'] });
    }),
  );

  authed.get(
    '/actions',
    scanRateGate,
    handle(async (req, res) => {
      const user = mcpUserOf(res);
      const now = Date.now();
      // janela das REUNIÕES a varrer (onde as ações nasceram); default 60 dias
      const meetingsWithin = qstr(req, 'meetingsWithin') ?? '60d';
      const meetingRangeInput: RangeInput = { last: meetingsWithin };
      const meetingRange = resolveRange(meetingRangeInput, now);
      const withinDays = qint(req, 'withinDays', 7, 365);
      const assignee = qstr(req, 'assignee');
      const meName = cleanInline(user.name).toLowerCase();
      const assigneeFilter = assignee === 'me' ? meName : assignee?.toLowerCase();
      const guildId = qstr(req, 'guildId');
      const actionContext = scanContext('actions', rangeFingerprint(meetingRangeInput), [
        guildId ?? null,
        withinDays,
        assigneeFilter ?? null,
      ]);
      const visible = await visibleInWindow(
        user,
        meetingRange,
        { guildId },
        {
          rawCursor: qstr(req, 'scanCursor'),
          rawResultCursor: qstr(req, 'cursor'),
          resultKind: 'actions',
          context: actionContext,
        },
        MAX_AGGREGATE_MEETINGS,
      );
      const metas = visible.metas;
      const dueLimit = now + withinDays * 86400000;
      const todayStart = resolveRange({ preset: 'today' }, now).fromMs;
      const limit = qint(req, 'limit', 100, 500);
      let returned = 0;
      let nextCursor: string | null = null;

      const buckets = {
        overdue: [] as unknown[],
        dueSoon: [] as unknown[],
        later: [] as unknown[],
        noDeadline: [] as unknown[],
        unparseable: [] as unknown[],
      };
      type ActionBucket = keyof typeof buckets;
      const add = (bucket: ActionBucket, item: unknown): void => {
        buckets[bucket].push(item);
        returned++;
      };
      actions: for (let metaIndex = 0; metaIndex < metas.length; metaIndex++) {
        const m = metas[metaIndex];
        const anchor = visible.anchors[metaIndex];
        const resumesThisMeeting =
          visible.resume?.kind === 'actions' &&
          visible.resume.anchor.id === anchor.id &&
          visible.resume.anchor.startedAt === anchor.startedAt;
        if (m.minutes?.status !== 'done') {
          if (resumesThisMeeting) throw new OpaqueCursorError();
          continue;
        }
        const min = readMinutes(m.id);
        if (!min) {
          if (resumesThisMeeting) throw new OpaqueCursorError();
          continue;
        }
        const actionsVersion = positionalContentVersion('actions', min.acoes);
        if (resumesThisMeeting && visible.resume?.version !== actionsVersion) throw new OpaqueCursorError();
        const resumeAt = resumesThisMeeting ? (visible.resume?.suboffset ?? 0) : 0;
        const chunkEnd = Math.min(resumeAt + MAX_ACTIONS_PER_MEETING, min.acoes.length);
        for (let actionIndex = resumeAt; actionIndex < chunkEnd; actionIndex++) {
          const a = min.acoes[actionIndex];
          const resp = a.responsavel ? cleanInline(a.responsavel) : '';
          if (assigneeFilter && !resp.toLowerCase().includes(assigneeFilter)) continue;
          if (returned >= limit) {
            nextCursor = sealResultCursor(
              user,
              'actions',
              anchor,
              visible.range,
              actionContext,
              actionIndex,
              undefined,
              actionsVersion,
            );
            break actions;
          }
          const item = {
            tarefa: neutralizeFences(cleanInline(a.tarefa)),
            responsavel: resp || null,
            prazoRaw: a.prazo ? cleanInline(a.prazo) : null,
            prazoParsedISO: null as string | null,
            meetingId: m.id,
            meetingUrl: pageUrl(m.id),
            meetingStartedAtISO: formatInTz(m.startedAt),
            /** ata gerada de transcrição parcial pode ter ações faltando */
            transcriptStatus: m.transcription?.status ?? 'none',
          };
          if (!a.prazo) {
            add('noDeadline', item);
            continue;
          }
          const parsed = parseDeadline(a.prazo, now);
          if (parsed === null) {
            add('unparseable', item);
            continue;
          }
          item.prazoParsedISO = formatInTz(parsed);
          if (parsed < todayStart) add('overdue', item);
          else if (parsed <= dueLimit) add('dueSoon', item);
          else add('later', item);
        }
        if (chunkEnd < min.acoes.length) {
          nextCursor = sealResultCursor(
            user,
            'actions',
            anchor,
            visible.range,
            actionContext,
            chunkEnd,
            undefined,
            actionsVersion,
          );
          break actions;
        }
      }
      res.json({
        scannedMeetings: metas.length,
        meetingsTruncated: visible.truncated,
        meetingScanLimit: MAX_AGGREGATE_MEETINGS,
        candidateScanLimit: MAX_CANDIDATE_METAS_PER_REQUEST,
        guildScanLimit: MAX_ACCESS_GUILDS_PER_REQUEST,
        withinDays,
        returned,
        nextCursor,
        nextScanCursor: nextCursor ? null : visible.nextScanCursor,
        ...buckets,
      });
    }),
  );

  authed.get(
    '/search',
    scanRateGate,
    handle(async (req, res) => {
      const user = mcpUserOf(res);
      const q = qstr(req, 'query');
      if (!q) {
        res.status(400).json({ error: 'missing_query' });
        return;
      }
      const mode = qstr(req, 'mode') ?? 'all';
      const terms = normalizedSearchTerms(q);
      if (q.length > 200 || terms.length === 0 || !['all', 'any', 'phrase'].includes(mode)) {
        res.status(400).json({ error: 'bad_query' });
        return;
      }
      const scope = new Set((qstr(req, 'scope') ?? 'transcript,minutes,notes').split(','));
      const rangeInput = rangeFromQuery(req);
      const range = resolveRange(rangeInput, Date.now());
      const guildId = qstr(req, 'guildId');
      const searchContext = scanContext('search', rangeFingerprint(rangeInput), [
        guildId ?? null,
        q,
        mode,
        [...scope].sort(),
      ]);
      const visible = await visibleInWindow(
        user,
        range,
        { guildId },
        {
          rawCursor: qstr(req, 'scanCursor'),
          rawResultCursor: qstr(req, 'cursor'),
          resultKind: 'search',
          context: searchContext,
        },
        MAX_AGGREGATE_MEETINGS,
      );
      const metas = visible.metas;
      const limit = qint(req, 'limit', 20, 100);

      const results: Record<string, unknown>[] = [];
      let nextCursor: string | null = null;
      let lastReturnedAnchor: MetaTimelineCursor | undefined;
      let skippedTranscripts = 0;
      let transcriptBytesScanned = 0;
      let transcriptSegmentsScanned = 0;
      let transcriptBudgetExhausted = false;
      searchMeetings: for (let metaIndex = 0; metaIndex < metas.length; metaIndex++) {
        const m = metas[metaIndex];
        const anchor = visible.anchors[metaIndex];
        const hits: SearchHit[] = [];
        let meetingCursor: string | null = null;
        const resumesThisMeeting =
          visible.resume?.kind === 'search' &&
          visible.resume.anchor.id === anchor.id &&
          visible.resume.anchor.startedAt === anchor.startedAt;
        const resumePhase = resumesThisMeeting ? visible.resume?.phase : undefined;
        if (resumesThisMeeting && !resumePhase) throw new OpaqueCursorError();
        const startPhaseIndex = resumePhase ? SEARCH_PHASES.indexOf(resumePhase) : 0;
        if (startPhaseIndex < 0) throw new OpaqueCursorError();

        const phaseHasContent = (phase: AggregateCursorPhase): boolean => {
          if (phase === 'search-minutes') return scope.has('minutes') && m.minutes?.status === 'done';
          if (phase === 'search-transcript') return scope.has('transcript') && transcriptReady(m);
          return scope.has('notes') && m.notes.length > 0;
        };
        const hasLaterPhase = (phaseIndex: number): boolean =>
          SEARCH_PHASES.slice(phaseIndex + 1).some(phaseHasContent);
        const sealMeetingCursor = (phase: AggregateCursorPhase, suboffset: number, version?: string): void => {
          meetingCursor = sealResultCursor(
            user,
            'search',
            anchor,
            visible.range,
            searchContext,
            suboffset,
            phase,
            version,
          );
        };

        searchPhases: for (let phaseIndex = startPhaseIndex; phaseIndex < SEARCH_PHASES.length; phaseIndex++) {
          const phase = SEARCH_PHASES[phaseIndex];
          const resumesThisPhase = resumesThisMeeting && phase === resumePhase;
          const phaseOffset = resumesThisPhase ? (visible.resume?.suboffset ?? 0) : 0;

          if (phase === 'search-minutes') {
            if (!phaseHasContent(phase)) {
              if (resumesThisPhase) throw new OpaqueCursorError();
              continue;
            }
            const read = readMinutesBounded(m.id, MAX_MINUTES_BYTES);
            if (read.status !== 'ok') {
              if (resumesThisPhase) throw new OpaqueCursorError();
              continue;
            }
            const version = positionalContentVersion('search-minutes', read.minutes);
            if (resumesThisPhase && visible.resume?.version !== version) throw new OpaqueCursorError();
            const items = minutesSearchItems(read.minutes);
            if (phaseOffset > items.length) throw new OpaqueCursorError();
            for (let itemIndex = phaseOffset; itemIndex < items.length; itemIndex++) {
              const item = items[itemIndex];
              if (matchIn(item.text, terms, mode) <= 0) continue;
              hits.push(item.hit);
              if (hits.length >= MAX_SEARCH_HITS_PER_MEETING) {
                const nextOffset = itemIndex + 1;
                if (nextOffset < items.length || hasLaterPhase(phaseIndex)) {
                  sealMeetingCursor(phase, nextOffset, version);
                }
                break searchPhases;
              }
            }
            continue;
          }

          if (phase === 'search-transcript') {
            if (!phaseHasContent(phase)) {
              if (resumesThisPhase && phaseOffset > 0) throw new OpaqueCursorError();
              continue;
            }
            const remainingSegments = MAX_SEARCH_SEGMENTS_PER_REQUEST - transcriptSegmentsScanned;
            const remainingBytes = MAX_TRANSCRIPT_BYTES_PER_REQUEST - transcriptBytesScanned;
            if (remainingSegments <= 0 || remainingBytes <= 0) {
              transcriptBudgetExhausted = true;
              sealMeetingCursor(phase, phaseOffset, resumesThisPhase ? visible.resume?.version : undefined);
              break searchPhases;
            }
            const transcriptRead = readTranscriptForAggregateSearch(m.id, MAX_TRANSCRIPT_SEARCH_BYTES, remainingBytes);
            if (transcriptRead.status === 'request_budget_exhausted') {
              transcriptBudgetExhausted = true;
              sealMeetingCursor(phase, phaseOffset, resumesThisPhase ? visible.resume?.version : undefined);
              break searchPhases;
            }
            if (transcriptRead.status !== 'ok') {
              skippedTranscripts++;
              if (resumesThisPhase && phaseOffset > 0) throw new OpaqueCursorError();
              continue;
            }
            const version = positionalContentVersion('search-transcript', transcriptRead.segments);
            if (resumesThisPhase && visible.resume?.version !== undefined && visible.resume.version !== version) {
              throw new OpaqueCursorError();
            }
            if (phaseOffset > transcriptRead.segments.length) throw new OpaqueCursorError();
            transcriptBytesScanned += transcriptRead.bytes;
            const segmentEnd = Math.min(
              phaseOffset + MAX_SEARCH_SEGMENTS_PER_MEETING,
              phaseOffset + remainingSegments,
              transcriptRead.segments.length,
            );
            let processedSegments = 0;
            for (let segmentIndex = phaseOffset; segmentIndex < segmentEnd; segmentIndex++) {
              const segment = transcriptRead.segments[segmentIndex];
              processedSegments++;
              if (matchIn(segment.text, terms, mode) <= 0) continue;
              const idx = searchNorm(segment.text).indexOf(terms[0]);
              hits.push({
                where: 'transcript',
                speaker: cleanInline(segment.speaker),
                atMs: segment.startMs,
                snippet: neutralizeFences(cleanInline(snippet(segment.text, idx < 0 ? 0 : idx, terms[0].length))),
                deepLink: deepLink(m.id, segment.startMs),
              });
              if (hits.length >= MAX_SEARCH_HITS_PER_MEETING) {
                const nextOffset = segmentIndex + 1;
                if (nextOffset < transcriptRead.segments.length || hasLaterPhase(phaseIndex)) {
                  sealMeetingCursor(phase, nextOffset, version);
                }
                break;
              }
            }
            transcriptSegmentsScanned += processedSegments;
            if (hits.length >= MAX_SEARCH_HITS_PER_MEETING) break searchPhases;
            if (segmentEnd < transcriptRead.segments.length) {
              transcriptBudgetExhausted = true;
              sealMeetingCursor(phase, segmentEnd, version);
              break searchPhases;
            }
            continue;
          }

          if (!phaseHasContent(phase)) {
            if (resumesThisPhase) throw new OpaqueCursorError();
            continue;
          }
          const items = noteSearchItems(m);
          const version = positionalContentVersion(
            'search-notes',
            items.map((item) => item.text),
          );
          if (resumesThisPhase && visible.resume?.version !== version) throw new OpaqueCursorError();
          if (phaseOffset > items.length) throw new OpaqueCursorError();
          for (let itemIndex = phaseOffset; itemIndex < items.length; itemIndex++) {
            const item = items[itemIndex];
            if (matchIn(item.text, terms, mode) <= 0) continue;
            hits.push(item.hit);
            if (hits.length >= MAX_SEARCH_HITS_PER_MEETING) {
              const nextOffset = itemIndex + 1;
              if (nextOffset < items.length) sealMeetingCursor(phase, nextOffset, version);
              break searchPhases;
            }
          }
        }
        if (hits.length) {
          if (results.length >= limit && lastReturnedAnchor) {
            nextCursor = sealResultCursor(user, 'search', lastReturnedAnchor, visible.range, searchContext);
            break searchMeetings;
          }
          results.push({ ...meetingSummary(m), hits });
          lastReturnedAnchor = anchor;
        }
        if (meetingCursor) {
          nextCursor = meetingCursor;
          break searchMeetings;
        }
      }
      res.json({
        resolvedFrom: visible.range.fromISO,
        resolvedTo: visible.range.toISO,
        query: q,
        scannedMeetings: metas.length,
        meetingsTruncated: visible.truncated,
        meetingScanLimit: MAX_AGGREGATE_MEETINGS,
        candidateScanLimit: MAX_CANDIDATE_METAS_PER_REQUEST,
        guildScanLimit: MAX_ACCESS_GUILDS_PER_REQUEST,
        skippedTranscripts,
        transcriptBytesScanned,
        transcriptSegmentsScanned,
        transcriptBudgetExhausted,
        returned: results.length,
        results,
        nextCursor,
        nextScanCursor: nextCursor ? null : visible.nextScanCursor,
      });
    }),
  );

  authed.get(
    '/said',
    saidScanRateGate,
    handle(async (req, res) => {
      const user = mcpUserOf(res);
      const q = qstr(req, 'query');
      if (!q) {
        res.status(400).json({ error: 'missing_query' });
        return;
      }
      const terms = normalizedSearchTerms(q);
      if (q.length > 200 || terms.length === 0) {
        res.status(400).json({ error: 'bad_query' });
        return;
      }
      const speaker = qstr(req, 'speaker') ? searchNorm(qstr(req, 'speaker')!) : undefined;
      const ctx = qint(req, 'contextSegments', 1, 5);
      const scopeId = qstr(req, 'meetingId');
      const rangeInput = rangeFromQuery(req);
      const range = resolveRange(rangeInput, Date.now());
      const guildId = qstr(req, 'guildId');
      const saidContext = scanContext('said', rangeFingerprint(rangeInput), [
        guildId ?? null,
        scopeId ?? null,
        q,
        speaker ?? null,
        ctx,
      ]);
      let visible: VisibleWindowResult;
      if (scopeId) {
        let meta: RecordingMeta | undefined;
        if (guildId) {
          const requestContext = createAccessRequestContext();
          // O escopo declarado vem antes de cursor e disco. Ausente/Unknown
          // Member permanece uma busca vazia; falha REST conhecida sobe 503.
          if (await prevalidateGuildMembershipForMcp(user, guildId, requestContext)) {
            const candidate = readMeta(scopeId);
            if (candidate && !candidate.demo && candidate.guildId === guildId) {
              const access = await checkAccessForMcp(user, candidate, { requestContext });
              if (access.view) meta = candidate;
            }
          }
        } else {
          meta = await getViewable(user, scopeId);
        }
        if (meta && qstr(req, 'scanCursor')) throw new OpaqueCursorError();
        const rawResultCursor = qstr(req, 'cursor');
        // Não abre o cursor antes de confirmar acesso ao meetingId: inexistente e
        // sem acesso continuam produzindo a mesma resposta vazia.
        const resume =
          meta && rawResultCursor ? openResultCursor(user, rawResultCursor, saidContext, 'said') : undefined;
        if (meta && resume && (resume.anchor.id !== meta.id || resume.anchor.startedAt !== meta.startedAt))
          throw new OpaqueCursorError();
        const directRange = resume
          ? {
              ...range,
              fromMs: resume.fromMs,
              toMs: resume.toMs,
              fromISO: formatInTz(resume.fromMs),
              toISO: formatInTz(resume.toMs),
            }
          : range;
        visible = {
          metas: meta ? [meta] : [],
          anchors: meta ? [{ id: meta.id, startedAt: meta.startedAt }] : [],
          truncated: false,
          nextScanCursor: null,
          stopReason: null,
          range: directRange,
          resume,
        };
      } else {
        visible = await visibleInWindow(
          user,
          range,
          { guildId },
          {
            rawCursor: qstr(req, 'scanCursor'),
            rawResultCursor: qstr(req, 'cursor'),
            resultKind: 'said',
            context: saidContext,
          },
          MAX_AGGREGATE_MEETINGS,
        );
      }
      const metas = visible.metas;

      const limit = qint(req, 'limit', 50, 200);
      const out: Record<string, unknown>[] = [];
      let nextCursor: string | null = null;
      let skippedTranscripts = 0;
      let transcriptBytesScanned = 0;
      let transcriptSegmentsScanned = 0;
      let transcriptBudgetExhausted = false;
      outer: for (let metaIndex = 0; metaIndex < metas.length; metaIndex++) {
        const m = metas[metaIndex];
        const anchor = visible.anchors[metaIndex];
        const resumesThisMeeting =
          visible.resume?.kind === 'said' &&
          visible.resume.anchor.id === anchor.id &&
          visible.resume.anchor.startedAt === anchor.startedAt;
        if (!transcriptReady(m)) {
          if (resumesThisMeeting) throw new OpaqueCursorError();
          continue;
        }
        const resumeAt = resumesThisMeeting ? (visible.resume?.suboffset ?? 0) : 0;
        const remainingSegments = MAX_SEARCH_SEGMENTS_PER_REQUEST - transcriptSegmentsScanned;
        const remainingBytes = MAX_TRANSCRIPT_BYTES_PER_REQUEST - transcriptBytesScanned;
        if (remainingSegments <= 0 || remainingBytes <= 0) {
          transcriptBudgetExhausted = true;
          nextCursor = sealResultCursor(user, 'said', anchor, visible.range, saidContext, resumeAt);
          break;
        }
        const transcriptRead = readTranscriptForAggregateSearch(m.id, MAX_TRANSCRIPT_SEARCH_BYTES, remainingBytes);
        if (transcriptRead.status === 'request_budget_exhausted') {
          transcriptBudgetExhausted = true;
          nextCursor = sealResultCursor(user, 'said', anchor, visible.range, saidContext, resumeAt);
          break;
        }
        if (transcriptRead.status !== 'ok') {
          if (resumesThisMeeting) throw new OpaqueCursorError();
          skippedTranscripts++;
          continue;
        }
        const transcript = transcriptRead;
        const transcriptVersion = positionalContentVersion('said-transcript', transcript.segments);
        if (
          resumesThisMeeting &&
          (resumeAt > 0 || visible.resume?.version !== undefined) &&
          visible.resume?.version !== transcriptVersion
        )
          throw new OpaqueCursorError();
        const segmentLimit = Math.min(MAX_SEARCH_SEGMENTS_PER_MEETING, remainingSegments);
        const segs = transcript.segments.slice(resumeAt, resumeAt + segmentLimit);
        transcriptBytesScanned += transcript.bytes;
        transcriptSegmentsScanned += segs.length;
        if (
          resumeAt + segs.length < transcript.segments.length &&
          transcriptSegmentsScanned >= MAX_SEARCH_SEGMENTS_PER_REQUEST
        )
          transcriptBudgetExhausted = true;
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i];
          if (speaker && !searchNorm(s.speaker).includes(speaker)) continue;
          if (matchIn(s.text, terms, 'all') === 0) continue;
          if (out.length >= limit) {
            nextCursor = sealResultCursor(
              user,
              'said',
              anchor,
              visible.range,
              saidContext,
              resumeAt + i,
              undefined,
              transcriptVersion,
            );
            break outer;
          }
          const absoluteIndex = resumeAt + i;
          out.push({
            meetingId: m.id,
            url: pageUrl(m.id),
            /** 'partial' = a faixa desta pessoa pode nem ter sido transcrita ainda. */
            transcriptStatus: m.transcription?.status ?? 'none',
            speaker: cleanInline(s.speaker),
            startMs: s.startMs,
            text: neutralizeFences(cleanInline(s.text)),
            contextBefore: transcript.segments
              .slice(Math.max(0, absoluteIndex - ctx), absoluteIndex)
              .map((x) => neutralizeFences(cleanInline(x.text))),
            contextAfter: transcript.segments
              .slice(absoluteIndex + 1, absoluteIndex + 1 + ctx)
              .map((x) => neutralizeFences(cleanInline(x.text))),
            deepLink: deepLink(m.id, s.startMs),
          });
        }
        if (resumeAt + segs.length < transcript.segments.length) {
          nextCursor = sealResultCursor(
            user,
            'said',
            anchor,
            visible.range,
            saidContext,
            resumeAt + segs.length,
            undefined,
            transcriptVersion,
          );
          break;
        }
      }
      res.json({
        query: q,
        scannedMeetings: metas.length,
        meetingsTruncated: visible.truncated,
        meetingScanLimit: scopeId ? 1 : MAX_AGGREGATE_MEETINGS,
        candidateScanLimit: scopeId ? 1 : MAX_CANDIDATE_METAS_PER_REQUEST,
        guildScanLimit: scopeId ? 1 : MAX_ACCESS_GUILDS_PER_REQUEST,
        skippedTranscripts,
        transcriptBytesScanned,
        transcriptSegmentsScanned,
        transcriptBudgetExhausted,
        results: out,
        nextCursor,
        nextScanCursor: nextCursor ? null : visible.nextScanCursor,
      });
    }),
  );

  api.use(authed);
  app.use('/api', api);
  console.log('API do MCP montada em /api (MCP habilitado).');
}

// ---------- auxiliares fora do closure ----------

function issueTokens(userId: string, name: string, label?: string): { sid: string; body: Record<string, unknown> } {
  const s = createSession(userId, name, label);
  return { sid: s.sid, body: signPair(userId, name, s.sid, s.gen, s.exp) };
}

function signPair(userId: string, name: string, sid: string, gen: number, refreshExp: number): Record<string, unknown> {
  const accessExp = Date.now() + ACCESS_TTL_MS;
  return {
    access_token: signMcpAccess({ id: userId, name, exp: accessExp, jti: sid }),
    access_expires_at: formatInTz(accessExp),
    refresh_token: signMcpRefresh({ id: userId, name, exp: refreshExp, jti: sid, gen }),
    refresh_expires_at: formatInTz(refreshExp),
    user: { id: userId, name: cleanInline(name) },
  };
}

function buildTimeline(meta: RecordingMeta): { items: Record<string, unknown>[]; truncated: boolean } {
  const items: { atMs: number; type: string; text: string }[] = [];
  let truncated = meta.events.length > 500 || meta.notes.length > MAX_NOTES_PER_MEETING;
  for (const e of meta.events.slice(0, 500)) items.push({ atMs: e.atMs, type: 'event', text: cleanInline(e.text) });
  for (const n of meta.notes.slice(0, MAX_NOTES_PER_MEETING))
    items.push({ atMs: n.atMs, type: 'note', text: `${cleanInline(n.author)}: ${cleanInline(n.text)}` });
  if (meta.minutes?.status === 'done') {
    const result = readMinutesBounded(meta.id);
    if (result.status === 'ok') {
      truncated ||= result.minutes.topicos.length > MAX_MINUTES_ITEMS_PER_COLLECTION;
      for (const t of result.minutes.topicos.slice(0, MAX_MINUTES_ITEMS_PER_COLLECTION))
        items.push({ atMs: t.inicioMs, type: 'topic', text: cleanInline(t.titulo) });
    } else {
      truncated = true;
    }
  }
  items.sort((a, b) => a.atMs - b.atMs);
  return {
    items: items.map((it) => ({ ...it, deepLink: deepLink(meta.id, it.atMs) })),
    truncated,
  };
}
