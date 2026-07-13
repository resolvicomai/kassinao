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

export interface RecordingMeta {
  id: string;
  guildId: string;
  guildName: string;
  voiceChannelId: string;
  voiceChannelName: string;
  /** Painel do Discord, persistido para neutralização após crash/restart. */
  panelChannelId?: string;
  panelMessageId?: string;
  /**
   * O canal de voz era visível a @everyone no INÍCIO da gravação (audiência do
   * consentimento). Fallback da entrega da ata quando o canal (efêmero) já foi
   * apagado na hora de postar. Gravações antigas não têm este campo (= desconhecido).
   */
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
let guildMetaIds: Map<string, Set<string>> | undefined;

function cloneMeta(meta: RecordingMeta): RecordingMeta {
  return structuredClone(meta);
}

function cacheMeta(meta: RecordingMeta): void {
  if (!metaCache || !guildMetaIds) return;
  const previous = metaCache.get(meta.id);
  if (previous && previous.guildId !== meta.guildId) guildMetaIds.get(previous.guildId)?.delete(meta.id);
  metaCache.set(meta.id, cloneMeta(meta));
  const ids = guildMetaIds.get(meta.guildId) ?? new Set<string>();
  ids.add(meta.id);
  guildMetaIds.set(meta.guildId, ids);
}

function ensureMetaCache(): void {
  if (metaCache && guildMetaIds) return;
  const cache = new Map<string, RecordingMeta>();
  const byGuild = new Map<string, Set<string>>();
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
      const ids = byGuild.get(meta.guildId) ?? new Set<string>();
      ids.add(meta.id);
      byGuild.set(meta.guildId, ids);
    } catch {
      // Diretório incompleto/corrompido não entra no índice.
    }
  }
  metaCache = cache;
  guildMetaIds = byGuild;
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

/** Leitura usada por busca/RAG: arquivo fora do teto fica para a ata estruturada. */
export function readTranscriptForSearch(id: string, maxBytes: number): SearchTranscriptRead | undefined {
  if (!VALID_ID.test(id) || !Number.isFinite(maxBytes) || maxBytes <= 0) return undefined;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(transcriptPath(id), 'r');
    if (fs.fstatSync(descriptor).size > maxBytes) return undefined;
    const raw = fs.readFileSync(descriptor, 'utf8');
    const bytes = Buffer.byteLength(raw, 'utf8');
    if (bytes > maxBytes) return undefined;
    return { segments: JSON.parse(raw) as TranscriptSegment[], bytes };
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
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
  if (previous) guildMetaIds?.get(previous.guildId)?.delete(id);
  metaCache?.delete(id);
}

export function listMetas(): RecordingMeta[] {
  ensureMetaCache();
  return [...(metaCache?.values() ?? [])].map(cloneMeta);
}

export function listGuildMetas(guildId: string, limit = 5): RecordingMeta[] {
  return listMetas()
    .filter((m) => m.guildId === guildId)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit);
}

export interface ListGuildMetasRangeOptions {
  /** Quantas metas podem sair da consulta, já ordenadas da mais recente. */
  limit?: number;
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
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) return [];
  const limit = options.limit === undefined ? Number.MAX_SAFE_INTEGER : Math.max(1, Math.floor(options.limit));
  ensureMetaCache();
  const ids = guildMetaIds?.get(guildId) ?? new Set<string>();
  return [...ids]
    .map((id) => metaCache?.get(id))
    .filter((meta): meta is RecordingMeta => Boolean(meta && meta.startedAt >= fromMs && meta.startedAt < toMs))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit)
    .map(cloneMeta);
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
