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

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  speaker: string;
  text: string;
}

export interface TranscriptionState {
  status: 'pending' | 'running' | 'done' | 'error' | 'disabled';
  provider?: string;
  error?: string;
  finishedAt?: number;
  /** Tentativas já feitas — evita re-travar a fila no mesmo áudio após reinícios. */
  attempts?: number;
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
  /** Quem iniciou; null quando iniciada pelo auto-record. */
  startedBy: { id: string; name: string } | null;
  startedAt: number;
  endedAt?: number;
  status: 'recording' | 'done';
  participants: Participant[];
  events: RecordingEvent[];
  notes: RecordingNote[];
  transcription?: TranscriptionState;
  minutes?: MinutesState;
  expiresAt?: number;
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

// Fail-closed: os writes recebem ids gerados pelo servidor, então um id fora do
// padrão é bug/ataque (path traversal) — barramos antes de tocar o filesystem.
// Espelha a validação que os reads já fazem (retornam undefined).
function assertValidId(id: string): void {
  if (!VALID_ID.test(id)) throw new Error(`store: id de gravação inválido: ${JSON.stringify(id)}`);
}

export function saveMeta(meta: RecordingMeta): void {
  assertValidId(meta.id);
  fs.mkdirSync(recordingDir(meta.id), { recursive: true });
  const tmp = metaPath(meta.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, metaPath(meta.id));
}

export function readMeta(id: string): RecordingMeta | undefined {
  if (!VALID_ID.test(id)) return undefined;
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

export function saveTranscript(id: string, segments: TranscriptSegment[]): void {
  assertValidId(id);
  const tmp = transcriptPath(id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(segments));
  fs.renameSync(tmp, transcriptPath(id));
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
  const tmp = minutesPath(id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(minutes));
  fs.renameSync(tmp, minutesPath(id));
}

export function deleteRecording(id: string): void {
  if (!VALID_ID.test(id)) return;
  fs.rmSync(recordingDir(id), { recursive: true, force: true });
}

export function listMetas(): RecordingMeta[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(config.recordingsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const metas: RecordingMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const meta = readMeta(entry.name);
    if (meta) metas.push(meta);
  }
  return metas;
}

export function listGuildMetas(guildId: string, limit = 5): RecordingMeta[] {
  return listMetas()
    .filter((m) => m.guildId === guildId)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit);
}

export function pageUrl(id: string): string {
  return `${config.baseUrl}/rec/${id}`;
}

/**
 * Recuperação pós-queda: gravações que ficaram com status "recording"
 * após um reinício são marcadas como encerradas (os masters FLAC
 * continuam legíveis mesmo com o ffmpeg morto no meio).
 */
export function recoverInterruptedRecordings(): void {
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
    meta.expiresAt = endedAt + config.retentionDays * 24 * 60 * 60 * 1000;
    meta.events.push({ atMs: endedAt - meta.startedAt, text: t('pt', 'event.stopped-reinicio') });
    saveMeta(meta);
    console.log(`Gravação ${meta.id} recuperada após reinício (marcada como encerrada).`);
  }
}
