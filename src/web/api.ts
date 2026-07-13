import express, { Express, NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { isClientReady } from '../discord/ready';
import { minutesToMarkdown } from '../processing/minutes';
import { transcriptToMarkdown } from '../processing/transcribe';
import { cleanInline, cleanText, neutralizeFences } from '../sanitize';
import {
  listGuildMetasInRange,
  listMetasInRange,
  MeetingMinutes,
  pageUrl,
  readMeta,
  readMinutes,
  readTranscript,
  readTranscriptForSearch,
  RecordingMeta,
  textExpiryOf,
  transcriptReady,
  TranscriptSegment,
} from '../store';
import { checkAccessForMcp, createAccessRequestContext, TransientAccessError } from './access';
import { getMcpUser, McpToken, signMcpAccess, signMcpRefresh, verifyMcpRefresh } from './auth';
import {
  consumeExchangeCode,
  createSession,
  isActiveSession,
  McpSessionCapacityError,
  rotateSession,
} from './mcpTokens';
import { formatInTz, RangeError as WindowError, RangeInput, resolveRange, ResolvedRange } from './range';

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
const MAX_LIST_MEETINGS = 1_000;
const MAX_CANDIDATE_METAS_PER_REQUEST = 1_000;
const MAX_ACCESS_GUILDS_PER_REQUEST = 25;
const MAX_SCAN_REQUESTS_PER_MINUTE = 12;
const MAX_ACTIONS_PER_MEETING = 200;
const MAX_TRANSCRIPT_SEARCH_BYTES = 5 * 1024 * 1024;
const MAX_SEARCH_SEGMENTS_PER_MEETING = 5_000;
const MAX_SEARCH_HITS_PER_MEETING = 30;
const MAX_NOTES_PER_MEETING = 500;
const MAX_TRANSCRIPT_BYTES_PER_REQUEST = 25 * 1024 * 1024;
const MAX_SEARCH_SEGMENTS_PER_REQUEST = 25_000;

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

  consume(key: string, max: number, windowMs: number): boolean {
    const now = this.now();
    const current = this.buckets.get(key);
    if (current && current.resetAt > now) {
      current.count++;
      return current.count > max;
    }
    if (current) this.buckets.delete(key);

    // Chave nova é o caminho usado num ataque distribuído. Remove expiradas e,
    // se todas ainda estiverem vivas, sacrifica a janela inserida há mais tempo.
    // Map preserva ordem de inserção, então a expulsão continua O(1) sob ataque.
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

const rateLimiter = new FixedWindowRateLimiter();

function rateLimited(key: string, max: number, windowMs: number): boolean {
  return rateLimiter.consume(key, max, windowMs);
}

function clientIp(req: Request): string {
  // NUNCA ler X-Forwarded-For[0] (o cliente forja e rotaciona, furando o rate-limit).
  // Com `trust proxy=1` (definido no server), req.ip é o hop confiável atrás do Cloudflare.
  return req.ip ?? 'unknown';
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

// ---------- serializadores (limpam conteúdo de terceiros) ----------

function deepLink(id: string, ms: number): string {
  return `${pageUrl(id)}#t=${Math.floor(ms / 1000)}`;
}

function meetingSummary(m: RecordingMeta): Record<string, unknown> {
  // presença ≠ participante: quem esteve na call sem falar também conta —
  // sem isso a IA responde "quem estava na call?" factualmente errado
  const spoke = new Set(m.participants.map((p) => p.id));
  const silent = (m.presence ?? []).filter((p) => !spoke.has(p.id)).map((p) => cleanInline(p.name));
  return {
    id: m.id,
    url: pageUrl(m.id),
    guildName: cleanInline(m.guildName),
    channel: cleanInline(m.voiceChannelName),
    startedAtISO: formatInTz(m.startedAt),
    endedAtISO: m.endedAt ? formatInTz(m.endedAt) : null,
    durationMin: m.endedAt ? Math.round((m.endedAt - m.startedAt) / 60000) : null,
    participants: m.participants.map((p) => cleanInline(p.name)),
    participantCount: m.participants.length,
    /** Presentes que NÃO falaram (mutados/só ouvindo). */
    presentSilent: silent,
    presentCount: (m.presence?.length ?? 0) || m.participants.length,
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
  return {
    resumo: neutralizeFences(cleanText(m.resumo)),
    decisoes: m.decisoes.map((d) => neutralizeFences(cleanInline(d))),
    acoes: m.acoes.map((a) => ({
      tarefa: neutralizeFences(cleanInline(a.tarefa)),
      responsavel: a.responsavel ? cleanInline(a.responsavel) : null,
      prazo: a.prazo ? cleanInline(a.prazo) : null,
    })),
    topicos: m.topicos.map((t) => ({ titulo: neutralizeFences(cleanInline(t.titulo)), inicioMs: t.inicioMs })),
    porParticipante: m.porParticipante.map((p) => ({
      nome: cleanInline(p.nome),
      pontos: p.pontos.map((x) => neutralizeFences(cleanInline(x))),
    })),
  };
}

// ---------- acesso: metas visíveis dentro de uma janela ----------

interface MetaFilters {
  guildId?: string;
  channelId?: string;
  participantId?: string;
  status?: string;
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
  maxVisible = MAX_LIST_MEETINGS,
): Promise<{ metas: RecordingMeta[]; truncated: boolean }> {
  const out: RecordingMeta[] = [];
  const candidates: RecordingMeta[] = [];
  const boundedWindow = f.guildId
    ? (() => {
        const guildMetas = listGuildMetasInRange(f.guildId, range.fromMs, range.toMs, {
          limit: MAX_CANDIDATE_METAS_PER_REQUEST + 1,
        });
        return {
          metas: guildMetas.slice(0, MAX_CANDIDATE_METAS_PER_REQUEST),
          truncated: guildMetas.length > MAX_CANDIDATE_METAS_PER_REQUEST,
        };
      })()
    : listMetasInRange(range.fromMs, range.toMs, MAX_CANDIDATE_METAS_PER_REQUEST);
  let truncated = boundedWindow.truncated;
  for (const m of boundedWindow.metas) {
    if (m.demo) continue;
    if (f.guildId && m.guildId !== f.guildId) continue;
    if (f.channelId && m.voiceChannelId !== f.channelId) continue;
    if (f.status && m.status !== f.status) continue;
    if (f.participantId && !recordingIncludesUser(m, f.participantId)) continue;
    candidates.push(m);
  }
  const requestContext = createAccessRequestContext();
  const checkedGuilds = new Set<string>();
  for (const m of candidates) {
    if (!checkedGuilds.has(m.guildId)) {
      if (checkedGuilds.size >= MAX_ACCESS_GUILDS_PER_REQUEST) {
        truncated = true;
        continue;
      }
      checkedGuilds.add(m.guildId);
    }
    const access = await checkAccessForMcp(user, m, { requestContext });
    if (!access.view) continue;
    out.push(m);
    // Lê uma autorizada além do teto para poder declarar truncamento em vez de
    // fazer reuniões antigas sumirem silenciosamente do contrato MCP.
    if (out.length > maxVisible) {
      out.length = maxVisible;
      return { metas: out, truncated: true };
    }
  }
  return { metas: out, truncated };
}

/** Resolve uma gravação SÓ se o usuário pode vê-la; senão 404 (igual a inexistente). */
async function getViewable(user: McpToken, id: string): Promise<RecordingMeta | undefined> {
  const meta = readMeta(id);
  if (!meta || meta.demo) return undefined;
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

/** Normaliza pra busca: minúsculas + sem acentos ("orcamento" acha "orçamento"). */
function searchNorm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
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
  if (rateLimited(`scan:${token.jti}`, MAX_SCAN_REQUESTS_PER_MINUTE, 60_000)) {
    res.status(429).set('Retry-After', '30').json({ error: 'rate_limited' });
    return;
  }
  next();
}

/** `/said?meetingId=` lê uma gravação por id; só a variante por janela consome scan. */
function saidScanRateGate(req: Request, res: Response, next: NextFunction): void {
  if (qstr(req, 'meetingId')) {
    next();
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

/** Envolve handler async: RangeError→400, TransientAccessError→503, resto→500. */
function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    fn(req, res).catch((err: unknown) => {
      if (err instanceof WindowError) {
        res.status(400).json({ error: 'bad_range', message: err.message });
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
  api.use(express.json({ limit: '32kb' }));

  // ----- lifecycle de token (sem auth Bearer; protegido por rate-limit de IP) -----

  api.post('/mcp/exchange', (req, res) => {
    if (rateLimited(`ip:${clientIp(req)}`, 20, 60_000)) {
      res.status(429).set('Retry-After', '30').json({ error: 'rate_limited' });
      return;
    }
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    const claimed = consumeExchangeCode(code);
    if (!claimed) {
      res.status(400).json({ error: 'invalid_code' });
      return;
    }
    try {
      res.set('Cache-Control', 'no-store').json(issueTokens(claimed.userId, claimed.name));
    } catch (err) {
      if (!(err instanceof McpSessionCapacityError)) throw err;
      res.status(503).set('Retry-After', '60').json({ error: 'session_capacity' });
    }
  });

  api.post('/mcp/refresh', (req, res) => {
    if (rateLimited(`ip:${clientIp(req)}`, 30, 60_000)) {
      res.status(429).set('Retry-After', '30').json({ error: 'rate_limited' });
      return;
    }
    const rt = typeof req.body?.refresh_token === 'string' ? req.body.refresh_token : undefined;
    const parsed = verifyMcpRefresh(rt);
    if (!parsed) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const rot = rotateSession(parsed.jti, parsed.gen);
    if (!rot.ok) {
      // 'reuse' já matou a sessão; 'unknown' = revogada/expirada. Ambos → 401 uniforme.
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.set('Cache-Control', 'no-store').json(signPair(rot.userId, rot.name, parsed.jti, rot.gen, rot.exp));
  });

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
      const range = resolveRange(rangeFromQuery(req), Date.now());
      const filters: MetaFilters = {
        guildId: qstr(req, 'guildId'),
        channelId: qstr(req, 'channelId'),
        participantId: qstr(req, 'participantId'),
        status: qstr(req, 'status'),
      };
      const { metas: all, truncated: meetingsTruncated } = await visibleInWindow(
        user,
        range,
        filters,
        MAX_LIST_MEETINGS,
      );
      const limit = qint(req, 'limit', 20, 100);
      const offset = qint(req, 'cursor', 1, 100000) - 1 || 0;
      const page = all.slice(offset, offset + limit);
      res.json({
        resolvedFrom: range.fromISO,
        resolvedTo: range.toISO,
        label: range.label,
        total: all.length,
        meetingsTruncated,
        meetingScanLimit: MAX_LIST_MEETINGS,
        candidateScanLimit: MAX_CANDIDATE_METAS_PER_REQUEST,
        guildScanLimit: MAX_ACCESS_GUILDS_PER_REQUEST,
        meetings: page.map(meetingSummary),
        nextCursor: offset + limit < all.length ? String(offset + limit + 1) : null,
      });
    }),
  );

  authed.get(
    '/meetings/:id',
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
        const min = readMinutes(meta.id);
        if (min) body.minutes = cleanMinutes(min);
      }
      if (include.has('transcript') && transcriptReady(meta)) {
        const segs = readTranscript(meta.id) ?? [];
        const limit = qint(req, 'transcriptLimit', 500, 5000);
        body.transcript = cleanSegments(meta.id, segs.slice(0, limit));
        body.transcriptTruncated = segs.length > limit;
      }
      if (include.has('notes')) {
        body.notes = meta.notes.map((n) => ({
          atMs: n.atMs,
          author: cleanInline(n.author),
          text: neutralizeFences(cleanInline(n.text)),
          deepLink: deepLink(meta.id, n.atMs),
        }));
      }
      if (include.has('timeline')) body.timeline = buildTimeline(meta);
      res.json(body);
    }),
  );

  authed.get(
    '/meetings/:id/transcript',
    handle(async (req, res) => {
      const user = mcpUserOf(res);
      const meta = await getViewable(user, req.params.id);
      if (!meta) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (!transcriptReady(meta)) {
        res.json({ id: meta.id, status: meta.transcription?.status ?? 'none', segments: [] });
        return;
      }
      res.json({
        id: meta.id,
        status: meta.transcription?.status ?? 'done',
        segments: cleanSegments(meta.id, readTranscript(meta.id) ?? []),
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
      const min = meta.minutes?.status === 'done' ? readMinutes(meta.id) : undefined;
      if (!min) {
        res.json({ id: meta.id, status: meta.minutes?.status ?? 'none', minutes: null });
        return;
      }
      res.json({ id: meta.id, status: 'done', minutes: cleanMinutes(min) });
    }),
  );

  authed.get(
    '/meetings/:id/export',
    handle(async (req, res) => {
      const user = mcpUserOf(res);
      const meta = await getViewable(user, req.params.id);
      if (!meta) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const format = qstr(req, 'format') ?? 'ata.md';
      if (format === 'ata.md') {
        const min = meta.minutes?.status === 'done' ? readMinutes(meta.id) : undefined;
        if (!min) {
          res.status(404).json({ error: 'no_minutes' });
          return;
        }
        res.json({
          id: meta.id,
          format,
          filename: `kassinao-${meta.id}-ata.md`,
          content: minutesToMarkdown(meta, min),
        });
        return;
      }
      if (format === 'transcricao.md' || format === 'transcricao.txt') {
        if (!transcriptReady(meta)) {
          res.status(404).json({ error: 'no_transcript' });
          return;
        }
        const md = transcriptToMarkdown(meta, readTranscript(meta.id) ?? []);
        const content = format === 'transcricao.txt' ? md.replace(/[*#`]/g, '') : md;
        res.json({
          id: meta.id,
          format,
          filename: `kassinao-${meta.id}-${format}`,
          transcriptStatus: meta.transcription?.status ?? 'none',
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
      const meetingRange = resolveRange({ last: qstr(req, 'meetingsWithin') ?? '60d' }, now);
      const { metas, truncated: meetingsTruncated } = await visibleInWindow(
        user,
        meetingRange,
        { guildId: qstr(req, 'guildId') },
        MAX_AGGREGATE_MEETINGS,
      );
      const withinDays = qint(req, 'withinDays', 7, 365);
      const dueLimit = now + withinDays * 86400000;
      const todayStart = resolveRange({ preset: 'today' }, now).fromMs;
      const assignee = qstr(req, 'assignee');
      const meName = cleanInline(user.name).toLowerCase();
      const limit = qint(req, 'limit', 100, 500);
      const offset = qint(req, 'cursor', 1, 10_000) - 1;
      let total = 0;
      let returned = 0;

      const buckets = {
        overdue: [] as unknown[],
        dueSoon: [] as unknown[],
        later: [] as unknown[],
        noDeadline: [] as unknown[],
        unparseable: [] as unknown[],
      };
      type ActionBucket = keyof typeof buckets;
      const add = (bucket: ActionBucket, item: unknown): void => {
        const index = total++;
        if (index < offset || returned >= limit) return;
        buckets[bucket].push(item);
        returned++;
      };
      for (const m of metas) {
        if (m.minutes?.status !== 'done') continue;
        const min = readMinutes(m.id);
        if (!min) continue;
        for (const a of min.acoes.slice(0, MAX_ACTIONS_PER_MEETING)) {
          const resp = a.responsavel ? cleanInline(a.responsavel) : '';
          if (assignee) {
            const want = assignee === 'me' ? meName : assignee.toLowerCase();
            if (!resp.toLowerCase().includes(want)) continue;
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
      }
      res.json({
        scannedMeetings: metas.length,
        meetingsTruncated,
        meetingScanLimit: MAX_AGGREGATE_MEETINGS,
        candidateScanLimit: MAX_CANDIDATE_METAS_PER_REQUEST,
        guildScanLimit: MAX_ACCESS_GUILDS_PER_REQUEST,
        withinDays,
        total,
        returned,
        nextCursor: offset + returned < total ? String(offset + returned + 1) : null,
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
      const range = resolveRange(rangeFromQuery(req), Date.now());
      const { metas, truncated: meetingsTruncated } = await visibleInWindow(
        user,
        range,
        { guildId: qstr(req, 'guildId') },
        MAX_AGGREGATE_MEETINGS,
      );
      const limit = qint(req, 'limit', 20, 100);
      const offset = qint(req, 'cursor', 1, 10_000) - 1;

      const results: Record<string, unknown>[] = [];
      let skippedTranscripts = 0;
      let transcriptBytesScanned = 0;
      let transcriptSegmentsScanned = 0;
      let transcriptBudgetExhausted = false;
      for (const m of metas) {
        const hits: SearchHit[] = [];
        if (scope.has('minutes') && m.minutes?.status === 'done') {
          const min = readMinutes(m.id);
          if (min) collectMinutesHits(min, terms, mode, hits, MAX_SEARCH_HITS_PER_MEETING);
        }
        if (scope.has('transcript') && transcriptReady(m) && hits.length < MAX_SEARCH_HITS_PER_MEETING) {
          const transcript = transcriptBudgetExhausted
            ? undefined
            : readTranscriptForSearch(m.id, MAX_TRANSCRIPT_SEARCH_BYTES);
          if (!transcript && !transcriptBudgetExhausted) skippedTranscripts++;
          const remainingSegments = MAX_SEARCH_SEGMENTS_PER_REQUEST - transcriptSegmentsScanned;
          if (
            transcript &&
            (transcriptBytesScanned + transcript.bytes > MAX_TRANSCRIPT_BYTES_PER_REQUEST || remainingSegments <= 0)
          ) {
            transcriptBudgetExhausted = true;
          }
          const segments = transcriptBudgetExhausted
            ? []
            : (transcript?.segments.slice(0, Math.min(MAX_SEARCH_SEGMENTS_PER_MEETING, remainingSegments)) ?? []);
          if (transcript && !transcriptBudgetExhausted) {
            transcriptBytesScanned += transcript.bytes;
            transcriptSegmentsScanned += segments.length;
            if (
              segments.length < transcript.segments.length &&
              transcriptSegmentsScanned >= MAX_SEARCH_SEGMENTS_PER_REQUEST
            )
              transcriptBudgetExhausted = true;
          }
          for (const s of segments) {
            if (matchIn(s.text, terms, mode) > 0) {
              const idx = searchNorm(s.text).indexOf(terms[0]);
              hits.push({
                where: 'transcript',
                speaker: cleanInline(s.speaker),
                atMs: s.startMs,
                snippet: neutralizeFences(cleanInline(snippet(s.text, idx < 0 ? 0 : idx, terms[0].length))),
                deepLink: deepLink(m.id, s.startMs),
              });
              if (hits.length >= MAX_SEARCH_HITS_PER_MEETING) break;
            }
          }
        }
        if (scope.has('notes') && hits.length < MAX_SEARCH_HITS_PER_MEETING) {
          for (const n of m.notes.slice(0, MAX_NOTES_PER_MEETING)) {
            if (matchIn(n.text, terms, mode) > 0) {
              hits.push({
                where: 'note',
                atMs: n.atMs,
                snippet: neutralizeFences(cleanInline(n.text)),
                deepLink: deepLink(m.id, n.atMs),
              });
              if (hits.length >= MAX_SEARCH_HITS_PER_MEETING) break;
            }
          }
        }
        if (hits.length) results.push({ ...meetingSummary(m), hits });
      }
      results.sort((a, b) => (b.hits as unknown[]).length - (a.hits as unknown[]).length);
      const page = results.slice(offset, offset + limit);
      res.json({
        resolvedFrom: range.fromISO,
        resolvedTo: range.toISO,
        query: q,
        scannedMeetings: metas.length,
        meetingsTruncated,
        meetingScanLimit: MAX_AGGREGATE_MEETINGS,
        candidateScanLimit: MAX_CANDIDATE_METAS_PER_REQUEST,
        guildScanLimit: MAX_ACCESS_GUILDS_PER_REQUEST,
        skippedTranscripts,
        transcriptBytesScanned,
        transcriptSegmentsScanned,
        transcriptBudgetExhausted,
        total: results.length,
        results: page,
        nextCursor: offset + page.length < results.length ? String(offset + page.length + 1) : null,
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
      const range = resolveRange(rangeFromQuery(req), Date.now());
      const visible = scopeId
        ? {
            metas: [await getViewable(user, scopeId)].filter((m): m is RecordingMeta => !!m),
            truncated: false,
          }
        : await visibleInWindow(user, range, { guildId: qstr(req, 'guildId') }, MAX_AGGREGATE_MEETINGS);
      const metas = visible.metas;

      const limit = qint(req, 'limit', 50, 200);
      const offset = qint(req, 'cursor', 1, 10_000) - 1;
      const out: Record<string, unknown>[] = [];
      let matched = 0;
      let hasMore = false;
      let skippedTranscripts = 0;
      let transcriptBytesScanned = 0;
      let transcriptSegmentsScanned = 0;
      let transcriptBudgetExhausted = false;
      outer: for (const m of metas) {
        if (!transcriptReady(m)) continue;
        const transcript = readTranscriptForSearch(m.id, MAX_TRANSCRIPT_SEARCH_BYTES);
        if (!transcript) {
          skippedTranscripts++;
          continue;
        }
        const remainingSegments = MAX_SEARCH_SEGMENTS_PER_REQUEST - transcriptSegmentsScanned;
        if (transcriptBytesScanned + transcript.bytes > MAX_TRANSCRIPT_BYTES_PER_REQUEST || remainingSegments <= 0) {
          transcriptBudgetExhausted = true;
          break;
        }
        const segs = transcript.segments.slice(0, Math.min(MAX_SEARCH_SEGMENTS_PER_MEETING, remainingSegments));
        transcriptBytesScanned += transcript.bytes;
        transcriptSegmentsScanned += segs.length;
        if (segs.length < transcript.segments.length && transcriptSegmentsScanned >= MAX_SEARCH_SEGMENTS_PER_REQUEST)
          transcriptBudgetExhausted = true;
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i];
          if (speaker && !searchNorm(s.speaker).includes(speaker)) continue;
          if (matchIn(s.text, terms, 'all') === 0) continue;
          if (matched++ < offset) continue;
          if (out.length >= limit) {
            hasMore = true;
            break outer;
          }
          out.push({
            meetingId: m.id,
            url: pageUrl(m.id),
            /** 'partial' = a faixa desta pessoa pode nem ter sido transcrita ainda. */
            transcriptStatus: m.transcription?.status ?? 'none',
            speaker: cleanInline(s.speaker),
            startMs: s.startMs,
            text: neutralizeFences(cleanInline(s.text)),
            contextBefore: segs.slice(Math.max(0, i - ctx), i).map((x) => neutralizeFences(cleanInline(x.text))),
            contextAfter: segs.slice(i + 1, i + 1 + ctx).map((x) => neutralizeFences(cleanInline(x.text))),
            deepLink: deepLink(m.id, s.startMs),
          });
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
        nextCursor: hasMore ? String(offset + out.length + 1) : null,
      });
    }),
  );

  api.use(authed);
  app.use('/api', api);
  console.log('API do MCP montada em /api (MCP habilitado).');
}

// ---------- auxiliares fora do closure ----------

function issueTokens(userId: string, name: string): Record<string, unknown> {
  const s = createSession(userId, name);
  return signPair(userId, name, s.sid, s.gen, s.exp);
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

function buildTimeline(meta: RecordingMeta): Record<string, unknown>[] {
  const items: { atMs: number; type: string; text: string }[] = [];
  for (const e of meta.events) items.push({ atMs: e.atMs, type: 'event', text: cleanInline(e.text) });
  for (const n of meta.notes)
    items.push({ atMs: n.atMs, type: 'note', text: `${cleanInline(n.author)}: ${cleanInline(n.text)}` });
  if (meta.minutes?.status === 'done') {
    const min = readMinutes(meta.id);
    if (min) for (const t of min.topicos) items.push({ atMs: t.inicioMs, type: 'topic', text: cleanInline(t.titulo) });
  }
  items.sort((a, b) => a.atMs - b.atMs);
  return items.map((it) => ({ ...it, deepLink: deepLink(meta.id, it.atMs) }));
}

function collectMinutesHits(
  min: MeetingMinutes,
  terms: string[],
  mode: string,
  hits: SearchHit[],
  maxHits: number,
): void {
  const add = (hit: SearchHit): void => {
    if (hits.length < maxHits) hits.push(hit);
  };
  if (matchIn(min.resumo, terms, mode) > 0)
    add({ where: 'summary', snippet: neutralizeFences(cleanInline(min.resumo)).slice(0, 240) });
  for (const d of min.decisoes.slice(0, maxHits)) {
    if (hits.length >= maxHits) return;
    if (matchIn(d, terms, mode) > 0) add({ where: 'decision', snippet: neutralizeFences(cleanInline(d)) });
  }
  for (const a of min.acoes.slice(0, maxHits)) {
    if (hits.length >= maxHits) return;
    if (matchIn(a.tarefa, terms, mode) > 0) add({ where: 'action', snippet: neutralizeFences(cleanInline(a.tarefa)) });
  }
  for (const t of min.topicos.slice(0, maxHits)) {
    if (hits.length >= maxHits) return;
    if (matchIn(t.titulo, terms, mode) > 0)
      add({ where: 'topic', snippet: neutralizeFences(cleanInline(t.titulo)), atMs: t.inicioMs });
  }
}
