import express, { Express, NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { isClientReady } from '../discord/ready';
import { minutesToMarkdown } from '../processing/minutes';
import { transcriptToMarkdown } from '../processing/transcribe';
import { cleanInline, cleanText, neutralizeFences } from '../sanitize';
import {
  listMetas,
  MeetingMinutes,
  pageUrl,
  readMeta,
  readMinutes,
  readTranscript,
  RecordingMeta,
  transcriptReady,
  TranscriptSegment,
} from '../store';
import { checkAccessForMcp, TransientAccessError } from './access';
import { getMcpUser, McpToken, signMcpAccess, signMcpRefresh, verifyMcpRefresh } from './auth';
import { consumeExchangeCode, createSession, isActiveSession, rotateSession } from './mcpTokens';
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

// ---------- índice de metas em memória (evita varrer o disco a cada request) ----------

let metaCache: { at: number; metas: RecordingMeta[] } | null = null;
const META_TTL_MS = 10_000;

function allMetas(): RecordingMeta[] {
  if (metaCache && Date.now() - metaCache.at < META_TTL_MS) return metaCache.metas;
  const metas = listMetas().filter((m) => !m.demo);
  metaCache = { at: Date.now(), metas };
  return metas;
}

// ---------- rate limit (janela fixa, por chave) ----------

interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  if (buckets.size > 5000) for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k);
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  b.count++;
  return b.count > max;
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
    textExpiresAtISO: m.textExpiresAt ? formatInTz(m.textExpiresAt) : null,
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

/**
 * Filtra por metadados BARATOS (janela/guild/canal) ANTES de qualquer checkAccess,
 * e só chama checkAccessForMcp depois — que pode lançar TransientAccessError (→503).
 * NENHUM byte de transcript/minutes é lido aqui: isso fica para DEPOIS do view=true.
 */
async function visibleInWindow(user: McpToken, range: ResolvedRange, f: MetaFilters): Promise<RecordingMeta[]> {
  const out: RecordingMeta[] = [];
  for (const m of allMetas()) {
    if (m.startedAt < range.fromMs || m.startedAt >= range.toMs) continue;
    if (f.guildId && m.guildId !== f.guildId) continue;
    if (f.channelId && m.voiceChannelId !== f.channelId) continue;
    if (f.status && m.status !== f.status) continue;
    if (
      f.participantId &&
      !m.participants.some((p) => p.id === f.participantId) &&
      m.startedBy?.id !== f.participantId
    ) {
      continue;
    }
    const access = await checkAccessForMcp(user, m);
    if (access.view) out.push(m);
  }
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out;
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

function audit(req: Request, res: Response, next: NextFunction): void {
  res.on('finish', () => {
    const u = res.locals.mcpUser as McpToken | undefined;
    console.log(`[mcp-api] ${req.method} ${req.path} user=${u?.id ?? '-'} sid=${u?.jti ?? '-'} -> ${res.statusCode}`);
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
    res.set('Cache-Control', 'no-store').json(issueTokens(claimed.userId, claimed.name));
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
    handle(async (req, res) => {
      const user = mcpUserOf(res);
      const range = resolveRange(rangeFromQuery(req), Date.now());
      const filters: MetaFilters = {
        guildId: qstr(req, 'guildId'),
        channelId: qstr(req, 'channelId'),
        participantId: qstr(req, 'participantId'),
        status: qstr(req, 'status'),
      };
      const all = await visibleInWindow(user, range, filters);
      const limit = qint(req, 'limit', 20, 100);
      const offset = qint(req, 'cursor', 1, 100000) - 1 || 0;
      const page = all.slice(offset, offset + limit);
      res.json({
        resolvedFrom: range.fromISO,
        resolvedTo: range.toISO,
        label: range.label,
        total: all.length,
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
    handle(async (req, res) => {
      const user = mcpUserOf(res);
      const now = Date.now();
      // janela das REUNIÕES a varrer (onde as ações nasceram); default 60 dias
      const meetingRange = resolveRange({ last: qstr(req, 'meetingsWithin') ?? '60d' }, now);
      const metas = await visibleInWindow(user, meetingRange, { guildId: qstr(req, 'guildId') });
      const withinDays = qint(req, 'withinDays', 7, 365);
      const dueLimit = now + withinDays * 86400000;
      const todayStart = resolveRange({ preset: 'today' }, now).fromMs;
      const assignee = qstr(req, 'assignee');
      const meName = cleanInline(user.name).toLowerCase();

      const buckets = {
        overdue: [] as unknown[],
        dueSoon: [] as unknown[],
        later: [] as unknown[],
        noDeadline: [] as unknown[],
        unparseable: [] as unknown[],
      };
      for (const m of metas) {
        if (m.minutes?.status !== 'done') continue;
        const min = readMinutes(m.id);
        if (!min) continue;
        for (const a of min.acoes) {
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
            buckets.noDeadline.push(item);
            continue;
          }
          const parsed = parseDeadline(a.prazo, now);
          if (parsed === null) {
            buckets.unparseable.push(item);
            continue;
          }
          item.prazoParsedISO = formatInTz(parsed);
          if (parsed < todayStart) buckets.overdue.push(item);
          else if (parsed <= dueLimit) buckets.dueSoon.push(item);
          else buckets.later.push(item);
        }
      }
      res.json({ scannedMeetings: metas.length, withinDays, ...buckets });
    }),
  );

  authed.get(
    '/search',
    handle(async (req, res) => {
      const user = mcpUserOf(res);
      const q = qstr(req, 'query');
      if (!q) {
        res.status(400).json({ error: 'missing_query' });
        return;
      }
      const mode = qstr(req, 'mode') ?? 'all';
      const terms = searchNorm(q).split(/\s+/).filter(Boolean);
      const scope = new Set((qstr(req, 'scope') ?? 'transcript,minutes,notes').split(','));
      const range = resolveRange(rangeFromQuery(req), Date.now());
      const metas = await visibleInWindow(user, range, { guildId: qstr(req, 'guildId') });
      const limit = qint(req, 'limit', 20, 100);

      const results: Record<string, unknown>[] = [];
      for (const m of metas) {
        const hits: SearchHit[] = [];
        if (scope.has('minutes') && m.minutes?.status === 'done') {
          const min = readMinutes(m.id);
          if (min) collectMinutesHits(min, terms, mode, hits);
        }
        if (scope.has('transcript') && transcriptReady(m)) {
          for (const s of readTranscript(m.id) ?? []) {
            if (matchIn(s.text, terms, mode) > 0) {
              const idx = searchNorm(s.text).indexOf(terms[0]);
              hits.push({
                where: 'transcript',
                speaker: cleanInline(s.speaker),
                atMs: s.startMs,
                snippet: neutralizeFences(cleanInline(snippet(s.text, idx < 0 ? 0 : idx, terms[0].length))),
                deepLink: deepLink(m.id, s.startMs),
              });
            }
          }
        }
        if (scope.has('notes')) {
          for (const n of m.notes) {
            if (matchIn(n.text, terms, mode) > 0) {
              hits.push({
                where: 'note',
                atMs: n.atMs,
                snippet: neutralizeFences(cleanInline(n.text)),
                deepLink: deepLink(m.id, n.atMs),
              });
            }
          }
        }
        if (hits.length) results.push({ ...meetingSummary(m), hits: hits.slice(0, 30) });
      }
      results.sort((a, b) => (b.hits as unknown[]).length - (a.hits as unknown[]).length);
      res.json({ resolvedFrom: range.fromISO, resolvedTo: range.toISO, query: q, results: results.slice(0, limit) });
    }),
  );

  authed.get(
    '/said',
    handle(async (req, res) => {
      const user = mcpUserOf(res);
      const q = qstr(req, 'query');
      if (!q) {
        res.status(400).json({ error: 'missing_query' });
        return;
      }
      const terms = searchNorm(q).split(/\s+/).filter(Boolean);
      const speaker = qstr(req, 'speaker') ? searchNorm(qstr(req, 'speaker')!) : undefined;
      const ctx = qint(req, 'contextSegments', 1, 5);
      const scopeId = qstr(req, 'meetingId');
      const range = resolveRange(rangeFromQuery(req), Date.now());
      const metas = scopeId
        ? [await getViewable(user, scopeId)].filter((m): m is RecordingMeta => !!m)
        : await visibleInWindow(user, range, { guildId: qstr(req, 'guildId') });

      const out: Record<string, unknown>[] = [];
      for (const m of metas) {
        if (!transcriptReady(m)) continue;
        const segs = readTranscript(m.id) ?? [];
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i];
          if (speaker && !searchNorm(s.speaker).includes(speaker)) continue;
          if (matchIn(s.text, terms, 'all') === 0) continue;
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
      res.json({ query: q, results: out.slice(0, qint(req, 'limit', 50, 200)) });
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

function collectMinutesHits(min: MeetingMinutes, terms: string[], mode: string, hits: SearchHit[]): void {
  if (matchIn(min.resumo, terms, mode) > 0)
    hits.push({ where: 'summary', snippet: neutralizeFences(cleanInline(min.resumo)).slice(0, 240) });
  for (const d of min.decisoes)
    if (matchIn(d, terms, mode) > 0) hits.push({ where: 'decision', snippet: neutralizeFences(cleanInline(d)) });
  for (const a of min.acoes)
    if (matchIn(a.tarefa, terms, mode) > 0)
      hits.push({ where: 'action', snippet: neutralizeFences(cleanInline(a.tarefa)) });
  for (const t of min.topicos)
    if (matchIn(t.titulo, terms, mode) > 0)
      hits.push({ where: 'topic', snippet: neutralizeFences(cleanInline(t.titulo)), atMs: t.inicioMs });
}
