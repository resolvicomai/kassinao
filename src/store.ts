import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { t } from './i18n';

export interface Participant {
  id: string;
  name: string;
  /** URL do avatar no CDN do Discord (para a página web). */
  avatar: string | null;
  /** Nome do arquivo master FLAC dentro de tracks/. */
  trackFile: string;
  index: number;
}

export interface RecordingEvent {
  /** Offset em ms desde o início da gravação. */
  atMs: number;
  text: string;
}

export interface RecordingNote {
  atMs: number;
  author: string;
  text: string;
}

/** Presença na call (mesmo sem falar) — dá acesso à gravação e aparece na página. */
export interface PresenceEntry {
  id: string;
  name: string;
  /** Offset em ms desde o início da gravação em que a pessoa entrou. */
  joinedAtMs: number;
  /** Offset em ms em que saiu (ausente = ficou até o fim). */
  leftAtMs?: number;
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  speaker: string;
  text: string;
}

export interface TranscriptionState {
  /** 'partial' = algumas faixas prontas, outras aguardando nova rodada (rate limit por hora). */
  status: 'pending' | 'running' | 'done' | 'partial' | 'error' | 'disabled';
  provider?: string;
  error?: string;
  finishedAt?: number;
  /** Tentativas já feitas — evita re-travar a fila no mesmo áudio após reinícios. */
  attempts?: number;
  /** Ids de participantes cujas faixas JÁ foram transcritas — a retomada pula essas (não regasta cota). */
  doneTrackIds?: string[];
  /** Nomes das faixas que AINDA faltam (exibição) — estruturado, nada de parsear string de erro. */
  pendingTracks?: string[];
  /** true = outra rodada automática está agendada; false/ausente com status 'partial' = resultado final. */
  retryScheduled?: boolean;
}

export interface MinutesAction {
  tarefa: string;
  responsavel?: string;
  prazo?: string;
}

export interface MinutesTopic {
  titulo: string;
  inicioMs: number;
}

/** O que cada participante trouxe/decidiu — a ata organizada por pessoa. */
export interface MinutesPerson {
  nome: string;
  pontos: string[];
}

/** Ata gerada por IA a partir da transcrição. */
export interface MeetingMinutes {
  resumo: string;
  decisoes: string[];
  acoes: MinutesAction[];
  topicos: MinutesTopic[];
  porParticipante: MinutesPerson[];
}

export interface MinutesState {
  status: 'pending' | 'running' | 'done' | 'error' | 'disabled';
  model?: string;
  error?: string;
  finishedAt?: number;
}

export type DiscordSurfaceAuditSource = 'persisted-panel' | 'discovered-url';
export type DiscordSurfaceAuditOutcome = 'planned' | 'sanitized' | 'missing' | 'not-owned' | 'wrong-guild';

export interface DiscordSurfaceAuditEntry {
  channelId: string;
  messageId: string;
  source: DiscordSurfaceAuditSource;
  outcome: DiscordSurfaceAuditOutcome;
  /** Hash do conteúdo/componentes no checkpoint; evita sobrescrever edição concorrente. */
  plannedFingerprint?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DiscordSurfaceDiscoveryState {
  channelId: string;
  beforeMessageId?: string;
  messagesScanned: number;
  updatedAt: number;
  completedAt?: number;
  outcome?: 'complete' | 'missing' | 'wrong-guild';
}

export interface DiscordSurfaceMigrationState {
  audits: DiscordSurfaceAuditEntry[];
  discovery: DiscordSurfaceDiscoveryState[];
  updatedAt: number;
  completedAt?: number;
  retryAttempt?: number;
  nextRetryAt?: number;
}

/** Inventário por servidor: independe das metas, que podem já ter expirado. */
export interface DiscordGuildSurfaceMigrationState {
  guildId: string;
  policyVersion?: number;
  audits: DiscordSurfaceAuditEntry[];
  discovery: DiscordSurfaceDiscoveryState[];
  /** Próximo canal da rotação; evita starvation por histórico muito grande. */
  nextDiscoveryIndex?: number;
  channelsInventoriedAt?: number;
  updatedAt: number;
  completedAt?: number;
  retryAttempt?: number;
  nextRetryAt?: number;
}

export interface DiscordGuildSurfaceMigrationStore {
  guilds: Record<string, DiscordGuildSurfaceMigrationState>;
}

export interface RecordingMeta {
  id: string;
  guildId: string;
  guildName: string;
  voiceChannelId: string;
  voiceChannelName: string;
  /** Painel do Discord, persistido para neutralização após crash/restart. */
  panelChannelId?: string;
  panelMessageId?: string;
  /** Campo legado; preservado ao ler metas antigas, mas nunca concede acesso nem autoriza broadcast. */
  sourceEveryoneViewable?: boolean;
  /** Quem iniciou; null quando iniciada pelo auto-record. */
  startedBy: { id: string; name: string } | null;
  /** Idioma da sessão ('pt'|'en') — usado pelas notificações mesmo após reinício. */
  locale?: string;
  startedAt: number;
  endedAt?: number;
  status: 'recording' | 'done';
  participants: Participant[];
  /** Quem esteve na call (falando ou não). Gravações antigas não têm este campo. */
  presence?: PresenceEntry[];
  events: RecordingEvent[];
  notes: RecordingNote[];
  /** Pelo menos um encoder não fechou limpo; conteúdo parcial pode existir. */
  audioIncomplete?: boolean;
  transcription?: TranscriptionState;
  minutes?: MinutesState;
  /** Quando o ÁUDIO expira (faixas + cache). Texto vive até textExpiresAt. */
  expiresAt?: number;
  /** Quando transcrição/ata/metadados expiram (gravação some por completo). */
  textExpiresAt?: number;
  /** true depois que a retenção apagou as faixas de áudio (página esconde player/downloads). */
  audioDeleted?: boolean;
  /** Quando o webhook da ata foi disparado (dedupe entre reinícios). */
  webhookSentAt?: number;
  /** Fluxo de notificação durável; presente desde a criação nas gravações novas. */
  notificationPolicyVersion?: number;
  /** Quando o aviso genérico no canal foi confirmado. */
  publicNotifiedAt?: number;
  /** DMs privadas confirmadas; permite retomar falhas sem duplicar as já entregues. */
  privateNotifiedUserIds?: string[];
  /** Próxima identidade histórica ainda não percorrida pelo fanout privado. */
  privateNotificationCursor?: number;
  /** Identidades cuja confirmação autoritativa ou DM falhou e precisa de retry. */
  privateNotificationPendingUserIds?: string[];
  /** Quando todos os destinatários privados elegíveis foram avaliados sem falha transitória. */
  privateNotifiedAt?: number;
  /** Backoff persistido do aviso final; o sweep em processo retoma quando vencer. */
  notificationRetryAttempt?: number;
  notificationNextRetryAt?: number;
  /** Falhas transitórias já foram tentadas até o orçamento; preserva estado sem retry infinito. */
  notificationRetryExhaustedAt?: number;
  /** Versão da política que garante ausência de detalhes/links em canais do Discord. */
  discordSurfacePolicyVersion?: number;
  /** Cursor e trilha de auditoria da neutralização das mensagens históricas do bot. */
  discordSurfaceMigration?: DiscordSurfaceMigrationState;
  /** Quando o aviso final (canal/DM) foi enviado — o boot re-notifica se o processo morreu antes. */
  notifiedAt?: number;
  /** true apenas para a gravação de exemplo servida publicamente em /demo. */
  demo?: boolean;
}

export function recordingDir(id: string): string {
  return path.join(config.recordingsDir, id);
}

export function tracksDir(id: string): string {
  return path.join(recordingDir(id), 'tracks');
}

export function cacheDir(id: string): string {
  return path.join(recordingDir(id), 'cache');
}

function metaPath(id: string): string {
  return path.join(recordingDir(id), 'meta.json');
}

const VALID_ID = /^[a-zA-Z0-9-]+$/;
let metaCache: Map<string, RecordingMeta> | undefined;
/** IDs por guild, já ordenados por startedAt desc. */
let guildMetaTimelineIds: Map<string, string[]> | undefined;
/** IDs ordenados por startedAt desc; permite janelas limitadas sem varrer o arquivo inteiro. */
let metaTimelineIds: string[] | undefined;

function cloneMeta(meta: RecordingMeta): RecordingMeta {
  return structuredClone(meta);
}

function compareMetaIds(leftId: string, rightId: string): number {
  const left = metaCache?.get(leftId);
  const right = metaCache?.get(rightId);
  const byTime = (right?.startedAt ?? 0) - (left?.startedAt ?? 0);
  return byTime || leftId.localeCompare(rightId);
}

function removeTimelineId(timeline: string[] | undefined, id: string): void {
  const index = timeline?.indexOf(id) ?? -1;
  if (index >= 0) timeline?.splice(index, 1);
}

/** Insere sem reordenar o índice inteiro a cada saveMeta. */
function insertTimelineId(timeline: string[], id: string): void {
  let low = 0;
  let high = timeline.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareMetaIds(id, timeline[middle]) < 0) high = middle;
    else low = middle + 1;
  }
  timeline.splice(low, 0, id);
}

function cacheMeta(meta: RecordingMeta): void {
  if (!metaCache || !guildMetaTimelineIds || !metaTimelineIds) return;
  const previous = metaCache.get(meta.id);
  const guildPositionChanged = !previous || previous.guildId !== meta.guildId || previous.startedAt !== meta.startedAt;
  const globalPositionChanged = !previous || previous.startedAt !== meta.startedAt;

  if (guildPositionChanged && previous) {
    const previousTimeline = guildMetaTimelineIds.get(previous.guildId);
    removeTimelineId(previousTimeline, meta.id);
    if (previousTimeline?.length === 0) guildMetaTimelineIds.delete(previous.guildId);
  }
  if (globalPositionChanged && previous) removeTimelineId(metaTimelineIds, meta.id);

  metaCache.set(meta.id, cloneMeta(meta));

  if (guildPositionChanged) {
    const guildTimeline = guildMetaTimelineIds.get(meta.guildId) ?? [];
    insertTimelineId(guildTimeline, meta.id);
    guildMetaTimelineIds.set(meta.guildId, guildTimeline);
  }
  if (globalPositionChanged) insertTimelineId(metaTimelineIds, meta.id);
}

function sortMetaTimeline(): void {
  metaTimelineIds?.sort(compareMetaIds);
}

function ensureMetaCache(): void {
  if (metaCache && guildMetaTimelineIds && metaTimelineIds) return;
  const cache = new Map<string, RecordingMeta>();
  const byGuild = new Map<string, string[]>();
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(config.recordingsDir, { withFileTypes: true });
  } catch {
    // Diretório ainda inexistente = arquivo vazio; saveMeta o criará depois.
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !VALID_ID.test(entry.name)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath(entry.name), 'utf8')) as RecordingMeta;
      if (meta.id !== entry.name || !VALID_ID.test(meta.id)) continue;
      meta.notes ??= [];
      cache.set(meta.id, meta);
      const ids = byGuild.get(meta.guildId) ?? [];
      ids.push(meta.id);
      byGuild.set(meta.guildId, ids);
    } catch {
      // Diretório incompleto/corrompido não entra no índice.
    }
  }
  metaCache = cache;
  guildMetaTimelineIds = byGuild;
  metaTimelineIds = [...cache.keys()];
  sortMetaTimeline();
  for (const timeline of guildMetaTimelineIds.values()) timeline.sort(compareMetaIds);
}

// Fail-closed: os writes recebem ids gerados pelo servidor, então um id fora do
// padrão é bug/ataque (path traversal) — barramos antes de tocar o filesystem.
// Espelha a validação que os reads já fazem (retornam undefined).
function assertValidId(id: string): void {
  if (!VALID_ID.test(id)) throw new Error(`store: id de gravação inválido: ${JSON.stringify(id)}`);
}

function ensurePrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
}

function writePrivateJsonAtomic(file: string, value: unknown, pretty = false): void {
  ensurePrivateDirectory(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, pretty ? 2 : undefined));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

const discordSurfaceInventoryPath = (): string => path.join(config.recordingsDir, '.discord-surface-inventory.json');

export function readDiscordSurfaceInventory(): DiscordGuildSurfaceMigrationStore {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(discordSurfaceInventoryPath(), 'utf8'),
    ) as Partial<DiscordGuildSurfaceMigrationStore>;
    if (!parsed.guilds || typeof parsed.guilds !== 'object' || Array.isArray(parsed.guilds)) return { guilds: {} };
    return structuredClone({ guilds: parsed.guilds });
  } catch {
    return { guilds: {} };
  }
}

export function saveDiscordSurfaceInventory(state: DiscordGuildSurfaceMigrationStore): void {
  writePrivateJsonAtomic(discordSurfaceInventoryPath(), state, true);
}

export function saveMeta(meta: RecordingMeta): void {
  assertValidId(meta.id);
  writePrivateJsonAtomic(metaPath(meta.id), meta, true);
  cacheMeta(meta);
}

export function readMeta(id: string): RecordingMeta | undefined {
  if (!VALID_ID.test(id)) return undefined;
  if (metaCache) {
    const cached = metaCache.get(id);
    return cached ? cloneMeta(cached) : undefined;
  }
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath(id), 'utf8')) as RecordingMeta;
    meta.notes ??= []; // gravações de versões antigas
    return meta;
  } catch {
    return undefined;
  }
}

export function transcriptPath(id: string): string {
  return path.join(recordingDir(id), 'transcript.json');
}

export function readTranscript(id: string): TranscriptSegment[] | undefined {
  if (!VALID_ID.test(id)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(transcriptPath(id), 'utf8')) as TranscriptSegment[];
  } catch {
    return undefined;
  }
}

export interface SearchTranscriptRead {
  segments: TranscriptSegment[];
  bytes: number;
}

export type BoundedTranscriptRead =
  | { status: 'ok'; segments: TranscriptSegment[]; bytes: number }
  | { status: 'too_large'; bytes: number }
  | { status: 'unavailable' };

/**
 * Confere o tamanho no descritor antes de alocar/parsear o JSON. Como os writes
 * são atômicos, o descritor continua apontando para a mesma versão do arquivo.
 */
export function readTranscriptBounded(id: string, maxBytes: number): BoundedTranscriptRead {
  if (!VALID_ID.test(id) || !Number.isFinite(maxBytes) || maxBytes <= 0) return { status: 'unavailable' };
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(transcriptPath(id), 'r');
    const size = fs.fstatSync(descriptor).size;
    if (size > maxBytes) return { status: 'too_large', bytes: size };
    const raw = fs.readFileSync(descriptor, 'utf8');
    const bytes = Buffer.byteLength(raw, 'utf8');
    if (bytes > maxBytes) return { status: 'too_large', bytes };
    const segments = JSON.parse(raw) as unknown;
    if (!Array.isArray(segments)) return { status: 'unavailable' };
    return { status: 'ok', segments: segments as TranscriptSegment[], bytes };
  } catch {
    return { status: 'unavailable' };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/** Leitura usada por busca/RAG: arquivo fora do teto fica para a ata estruturada. */
export function readTranscriptForSearch(id: string, maxBytes: number): SearchTranscriptRead | undefined {
  const result = readTranscriptBounded(id, maxBytes);
  return result.status === 'ok' ? { segments: result.segments, bytes: result.bytes } : undefined;
}

export function saveTranscript(id: string, segments: TranscriptSegment[]): void {
  assertValidId(id);
  writePrivateJsonAtomic(transcriptPath(id), segments);
}

export function minutesPath(id: string): string {
  return path.join(recordingDir(id), 'minutes.json');
}

export function readMinutes(id: string): MeetingMinutes | undefined {
  if (!VALID_ID.test(id)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(minutesPath(id), 'utf8')) as MeetingMinutes;
  } catch {
    return undefined;
  }
}

export function saveMinutes(id: string, minutes: MeetingMinutes): void {
  assertValidId(id);
  writePrivateJsonAtomic(minutesPath(id), minutes);
}

export function deleteRecording(id: string): void {
  if (!VALID_ID.test(id)) return;
  fs.rmSync(recordingDir(id), { recursive: true, force: true });
  const previous = metaCache?.get(id);
  if (previous) {
    const guildTimeline = guildMetaTimelineIds?.get(previous.guildId);
    removeTimelineId(guildTimeline, id);
    if (guildTimeline?.length === 0) guildMetaTimelineIds?.delete(previous.guildId);
  }
  metaCache?.delete(id);
  removeTimelineId(metaTimelineIds, id);
}

export function listMetas(): RecordingMeta[] {
  ensureMetaCache();
  return (metaTimelineIds ?? []).flatMap((id) => {
    const meta = metaCache?.get(id);
    return meta ? [cloneMeta(meta)] : [];
  });
}

export interface ListMetaIdsPageResult {
  ids: string[];
  nextCursor?: number;
}

/**
 * Cursor barato sobre a timeline: não clona metas privadas antes de o chamador
 * aplicar seu teto/ACL. O cursor é um offset opaco para a versão atual da lista.
 */
export function listMetaIdsPage(cursor = 0, limit = 100): ListMetaIdsPageResult {
  ensureMetaCache();
  const timeline = metaTimelineIds ?? [];
  const start = Number.isSafeInteger(cursor) && cursor >= 0 ? Math.min(cursor, timeline.length) : 0;
  const safeLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(1, limit), 1_000) : 100;
  const end = Math.min(start + safeLimit, timeline.length);
  return {
    ids: timeline.slice(start, end),
    nextCursor: end < timeline.length ? end : undefined,
  };
}

export interface ListMetasRangeResult {
  metas: RecordingMeta[];
  /** Existem metas adicionais na janela depois do teto solicitado. */
  truncated: boolean;
}

export interface ListMetaIdsRangeResult {
  ids: string[];
  /** Existem ids adicionais na janela depois do teto solicitado. */
  truncated: boolean;
}

function timelineIdsInRange(
  timeline: readonly string[],
  fromMs: number,
  toMs: number,
  limit: number,
): ListMetaIdsRangeResult {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) return { ids: [], truncated: false };
  const safeLimit = Math.max(1, Math.floor(limit));

  let low = 0;
  let high = timeline.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const startedAt = metaCache?.get(timeline[middle])?.startedAt ?? 0;
    if (startedAt >= toMs) low = middle + 1;
    else high = middle;
  }

  const ids: string[] = [];
  let truncated = false;
  for (let index = low; index < timeline.length; index++) {
    const meta = metaCache?.get(timeline[index]);
    if (!meta) continue;
    if (meta.startedAt < fromMs) break;
    if (ids.length >= safeLimit) {
      truncated = true;
      break;
    }
    ids.push(meta.id);
  }
  return { ids, truncated };
}

/** Janela global limitada sem clonar os documentos de metadata. */
export function listMetaIdsInRange(fromMs: number, toMs: number, limit: number): ListMetaIdsRangeResult {
  ensureMetaCache();
  return timelineIdsInRange(metaTimelineIds ?? [], fromMs, toMs, limit);
}

/**
 * Lê uma janela global já ordenada com busca binária e teto rígido. O chamador
 * pode então aplicar filtros/ACL sem transformar uma consulta desde epoch em
 * uma ordenação e clonagem O(arquivo inteiro).
 */
export function listMetasInRange(fromMs: number, toMs: number, limit: number): ListMetasRangeResult {
  const result = listMetaIdsInRange(fromMs, toMs, limit);
  return {
    metas: result.ids.flatMap((id) => {
      const meta = metaCache?.get(id);
      return meta ? [cloneMeta(meta)] : [];
    }),
    truncated: result.truncated,
  };
}

export function listGuildMetas(guildId: string, limit = 5): RecordingMeta[] {
  ensureMetaCache();
  const safeLimit = Math.max(1, Math.floor(limit));
  return (guildMetaTimelineIds?.get(guildId) ?? []).slice(0, safeLimit).flatMap((id) => {
    const meta = metaCache?.get(id);
    return meta ? [cloneMeta(meta)] : [];
  });
}

export interface ListGuildMetasRangeOptions {
  /** Quantas metas podem sair da consulta, já ordenadas da mais recente. */
  limit?: number;
}

/** Janela de uma guild limitada sem clonar os documentos de metadata. */
export function listGuildMetaIdsInRange(
  guildId: string,
  fromMs: number,
  toMs: number,
  limit: number,
): ListMetaIdsRangeResult {
  ensureMetaCache();
  return timelineIdsInRange(guildMetaTimelineIds?.get(guildId) ?? [], fromMs, toMs, limit);
}

/**
 * Consulta o índice em memória montado no boot e mantido por saveMeta/delete.
 * Assim, uma guild barulhenta não ocupa um corte global de diretórios nem força
 * releitura de meta.json enquanto outra guild está gravando.
 */
export function listGuildMetasInRange(
  guildId: string,
  fromMs: number,
  toMs: number,
  options: ListGuildMetasRangeOptions = {},
): RecordingMeta[] {
  const limit = options.limit === undefined ? Number.MAX_SAFE_INTEGER : Math.max(1, Math.floor(options.limit));
  const result = listGuildMetaIdsInRange(guildId, fromMs, toMs, limit);
  return result.ids.flatMap((id) => {
    const meta = metaCache?.get(id);
    return meta ? [cloneMeta(meta)] : [];
  });
}

export function pageUrl(id: string): string {
  // /app/* é o namespace privado (nunca linkado do markup público); o caminho
  // antigo /rec/:id segue vivo por redirect 308 no server (links já enviados).
  return `${config.appUrl}/app/rec/${id}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Quando o ÁUDIO desta gravação expira — respondido pela CONFIG ATUAL, não pelo
 * `expiresAt` gravado no meta. Motivo: gravações feitas antes de o operador mudar
 * pra retenção ilimitada carregam uma data de morte persistida; se ela mandasse,
 * mudar RETENTION_DAYS pra 0 não salvaria o histórico existente.
 * `undefined` = nunca expira (ou ainda está gravando).
 */
export function audioExpiryOf(meta: RecordingMeta): number | undefined {
  if (config.audioRetentionUnlimited) return undefined;
  if (meta.expiresAt) return meta.expiresAt;
  return meta.endedAt ? meta.endedAt + config.retentionDays * DAY_MS : undefined;
}

/** Quando transcrição/ata/meta expiram (config atual manda). `undefined` = nunca. */
export function textExpiryOf(meta: RecordingMeta): number | undefined {
  if (config.textRetentionUnlimited) return undefined;
  if (meta.textExpiresAt) return meta.textExpiresAt;
  return meta.endedAt ? meta.endedAt + config.textRetentionDays * DAY_MS : undefined;
}

// ---------- tamanho em disco (pro painel de gestão do /gravacoes) ----------

const sizeCache = new Map<string, { bytes: number; at: number }>();
const SIZE_CACHE_TTL_MS = 60_000;

function dirBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirBytes(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    } catch {
      // apagado em paralelo
    }
  }
  return total;
}

/**
 * Bytes de ÁUDIO da gravação (masters em tracks/ + mixes/zips em cache/) — é o
 * que a ação "liberar espaço" devolve ao disco. Cache de 60s por gravação:
 * statSync recursivo é barato pra dezenas, mas o índice lista até 300.
 */
export function audioBytesOf(id: string): number {
  if (!VALID_ID.test(id)) return 0;
  const hit = sizeCache.get(id);
  if (hit && Date.now() - hit.at < SIZE_CACHE_TTL_MS) return hit.bytes;
  const bytes = dirBytes(tracksDir(id)) + dirBytes(cacheDir(id));
  sizeCache.set(id, { bytes, at: Date.now() });
  return bytes;
}

/** Invalida o cache de tamanho (chamar após apagar áudio/gravação). */
export function forgetAudioBytes(id: string): void {
  sizeCache.delete(id);
}

/**
 * Apaga SÓ o áudio (tracks/ + cache/), mantendo meta/transcrição/ata/notas — a
 * ação "liberar espaço" da retenção ilimitada: a memória fica, os gigas voltam.
 * Mesmo efeito da expiração por retenção, só que manual.
 */
export function deleteAudioOnly(meta: RecordingMeta): void {
  assertValidId(meta.id);
  fs.rmSync(tracksDir(meta.id), { recursive: true, force: true });
  fs.rmSync(cacheDir(meta.id), { recursive: true, force: true });
  meta.audioDeleted = true;
  saveMeta(meta);
  forgetAudioBytes(meta.id);
}

/**
 * Há transcrição utilizável? 'done' = completa; 'partial' = faltam faixas (rate
 * limit por hora do provedor), mas o que existe já é exibível/pesquisável.
 */
export function transcriptReady(meta: RecordingMeta): boolean {
  const s = meta.transcription?.status;
  return s === 'done' || s === 'partial';
}

/** A fila/retry ainda precisa reler as faixas de áudio desta gravação. */
export function transcriptionNeedsAudio(meta: RecordingMeta): boolean {
  const status = meta.transcription?.status;
  return meta.transcription?.retryScheduled === true || status === 'pending' || status === 'running';
}

/**
 * Recuperação pós-queda: gravações que ficaram com status "recording"
 * após um reinício são marcadas como encerradas (os masters FLAC
 * continuam legíveis mesmo com o ffmpeg morto no meio).
 */
export function recoverInterruptedRecordings(): RecordingMeta[] {
  const recovered: RecordingMeta[] = [];
  for (const meta of listMetas()) {
    if (meta.status !== 'recording') continue;
    let endedAt = meta.startedAt;
    try {
      for (const file of fs.readdirSync(tracksDir(meta.id))) {
        const mtime = fs.statSync(path.join(tracksDir(meta.id), file)).mtimeMs;
        if (mtime > endedAt) endedAt = Math.floor(mtime);
      }
    } catch {
      // sem faixas
    }
    meta.status = 'done';
    meta.endedAt = endedAt;
    if (meta.participants.length > 0) meta.audioIncomplete = true;
    // retenção ilimitada: nada de data de morte no meta (delete é 100% manual)
    if (!config.audioRetentionUnlimited) meta.expiresAt = endedAt + config.retentionDays * 24 * 60 * 60 * 1000;
    if (!config.textRetentionUnlimited) meta.textExpiresAt = endedAt + config.textRetentionDays * 24 * 60 * 60 * 1000;
    meta.events.push({
      atMs: endedAt - meta.startedAt,
      text: t(
        meta.locale === 'en' ? 'en' : meta.locale === 'pt' ? 'pt' : config.defaultLocale,
        'event.stopped-reinicio',
      ),
    });
    // A limpeza roda antes do client ficar pronto. Persistir a intenção agora
    // impede que a retenção apague o áudio antes de o boot re-enfileirar.
    if (!meta.transcription) {
      meta.transcription =
        meta.participants.length > 0 && config.transcribeProvider !== 'none'
          ? { status: 'pending', attempts: 0 }
          : { status: 'disabled' };
    }
    saveMeta(meta);
    recovered.push(meta);
    console.log(`Gravação ${meta.id} recuperada após reinício (marcada como encerrada).`);
  }
  return recovered;
}
