import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseShellCommand } from 'shell-quote';
import { config } from '../config';
import {
  operationalError,
  operationalFailure,
  operationalInfo,
  operationalPii,
  operationalWarn,
} from '../operationalLog';
import { cleanInline, neutralizeFences } from '../sanitize';
import {
  cacheDir,
  Participant,
  readMeta,
  readTranscript,
  RecordingMeta,
  saveMeta,
  saveMinutes,
  saveTranscript,
  tracksDir,
  transcriptReady,
  TranscriptSegment,
} from '../store';
import { runFfmpeg } from './ffmpeg';
import { buildSafeChildEnvironment } from './childEnvironment';
import {
  abortableDelay,
  assertGuildWorkActive,
  createGuildWorkContext,
  fetchWithRetry,
  GuildWorkContext,
  isGuildWorkPausedError,
  UpstreamHttpError,
} from './http';
import { generateMinutes, minutesEnabled } from './minutes';
import { batchIntervals, detectSpeechIntervals, extractBatch, filterHallucinations, mapBatchTimeToTrack } from './vad';

/** Segmento cru devolvido por um provider (tempos em segundos, relativos ao chunk). */
interface RawSegment {
  start: number;
  end: number;
  text: string;
}

/** Falha de CONTEÚDO de um chunk (bloqueio do provedor, resposta truncada/ilegível):
 *  vira lacuna naquele trecho, não derruba a faixa inteira. */
class ChunkContentError extends Error {}

/**
 * Pedaços de no máx. 20 min: cabem nos limites de upload de todas as APIs.
 * Gemini usa 10 min — fala densa de 20 min estoura o limite de TOKENS DE SAÍDA
 * (8192) do modelo e truncaria o JSON da resposta.
 */
function chunkSeconds(): number {
  return config.transcribeProvider === 'gemini' ? 10 * 60 : 20 * 60;
}

/** Piso do watchdog por chunk do provider 'command'; o teto real é proporcional à duração. */
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
/** Rate limit por hora (Groq free) pode exigir várias rodadas — cada uma retoma só as faixas que faltam. */
const MAX_TRANSCRIPTION_ATTEMPTS = 4;
/** Espera entre rodadas quando sobraram faixas por rate limit (o limite da Groq é por hora). */
const PARTIAL_RETRY_DELAY_MS = 12 * 60 * 1000;
/** Espera máxima DENTRO de uma chamada quando o provedor pede "try again in Xm". */
const ASR_MAX_WAIT_MS = 10 * 60 * 1000;

/** PIDs (grupos) de comandos locais em voo — mortos no shutdown para não virarem órfãos. */
const commandPids = new Set<number>();

export interface TranscribeCommandTemplate {
  executable: string;
  args: string[];
}

/**
 * Aceita a conveniência de aspas de um comando shell, mas rejeita qualquer
 * construção que dependa de um shell. O resultado sempre é executado como
 * binário + argv, então caminhos de gravação nunca viram código.
 */
export function parseTranscribeCommandTemplate(template: string): TranscribeCommandTemplate {
  if (!template.trim()) throw new Error('TRANSCRIBE_COMMAND está vazio');
  if (template.length > 8_192) throw new Error('TRANSCRIBE_COMMAND excede 8192 caracteres');
  if (/[$\r\n\0]/.test(template))
    throw new Error('TRANSCRIBE_COMMAND não aceita expansão de variáveis, quebras de linha ou NUL');

  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of template) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = undefined;
      else if (character === '\\') escaped = true;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === '\\') escaped = true;
  }
  if (quote || escaped) throw new Error('TRANSCRIBE_COMMAND contém aspas ou escape incompletos');

  const parsed = parseShellCommand(template, {});
  if (parsed.some((entry) => typeof entry !== 'string'))
    throw new Error('TRANSCRIBE_COMMAND não aceita operadores, redirecionamentos, comentários ou glob');
  const tokens = parsed as string[];
  if (!tokens.length || !tokens[0]) throw new Error('TRANSCRIBE_COMMAND não informa um executável');
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]))
    throw new Error('TRANSCRIBE_COMMAND deve começar pelo executável; use env NOME=valor comando quando necessário');
  if (tokens.length > 128 || tokens.some((token) => token.length > 4_096))
    throw new Error('TRANSCRIBE_COMMAND excede os limites de argumentos');

  const inputCount = tokens.filter((token) => token === '{input}').length;
  const outputCount = tokens.filter((token) => token === '{output}').length;
  if (inputCount !== 1 || outputCount !== 1 || tokens[0] === '{input}' || tokens[0] === '{output}') {
    throw new Error('TRANSCRIBE_COMMAND exige {input} e {output} uma vez cada, como argumentos separados');
  }
  if (tokens.some((token) => token.includes('{input}') !== (token === '{input}')))
    throw new Error('TRANSCRIBE_COMMAND exige {input} como argumento separado');
  if (tokens.some((token) => token.includes('{output}') !== (token === '{output}')))
    throw new Error('TRANSCRIBE_COMMAND exige {output} como argumento separado');

  return { executable: tokens[0], args: tokens.slice(1) };
}

/** Ambiente mínimo entregue a um transcritor local; segredos não atravessam por herança. */
export function buildTranscribeCommandEnvironment(
  source: NodeJS.ProcessEnv,
  extraNames: readonly string[],
): NodeJS.ProcessEnv {
  return buildSafeChildEnvironment(source, extraNames);
}

let guildProcessingAllowed: (guildId: string) => boolean = () => false;

/** Index injeta o estado operacional do gateway sem acoplar o pipeline ao Discord. */
export function setProcessingGuildGuard(guard: (guildId: string) => boolean): void {
  guildProcessingAllowed = guard;
}

function killGroup(proc: { pid?: number; kill: (s: NodeJS.Signals) => void }): void {
  try {
    if (proc.pid) {
      process.kill(-proc.pid, 'SIGKILL');
      commandPids.delete(proc.pid);
    }
  } catch {
    proc.kill('SIGKILL');
  }
}

/** Mata comandos locais órfãos no encerramento do bot (chamado pelos handlers de sinal). */
export function killPendingTranscriptions(): void {
  for (const pid of commandPids) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // já morreu
    }
  }
  commandPids.clear();
}

export function transcriptionEnabled(): boolean {
  return ['assemblyai', 'openai', 'groq', 'gemini', 'command'].includes(config.transcribeProvider);
}

/** Valida a configuração no boot para o erro aparecer cedo, não na primeira call. */
export function validateTranscriptionConfig(): string | undefined {
  // Ata: valores/chaves inválidos falham no boot, não na primeira reunião.
  if (!['openrouter', 'groq'].includes(config.minutesProvider))
    return `MINUTES_PROVIDER desconhecido: ${config.minutesProvider} (use openrouter ou groq)`;
  if (config.minutesEnabled === 'true') {
    if (config.minutesProvider === 'openrouter' && !config.openrouterApiKey)
      return 'MINUTES_ENABLED=true com MINUTES_PROVIDER=openrouter exige OPENROUTER_API_KEY';
    if (config.minutesProvider === 'groq' && !config.groqApiKey)
      return 'MINUTES_ENABLED=true com MINUTES_PROVIDER=groq exige GROQ_API_KEY';
  }
  const p = config.transcribeProvider;
  if (p === 'none') return undefined;
  if (p === 'assemblyai' && !config.assemblyaiApiKey) return 'TRANSCRIBE_PROVIDER=assemblyai exige ASSEMBLYAI_API_KEY';
  if (p === 'openai' && !config.openaiApiKey) return 'TRANSCRIBE_PROVIDER=openai exige OPENAI_API_KEY';
  if (p === 'groq' && !config.groqApiKey) return 'TRANSCRIBE_PROVIDER=groq exige GROQ_API_KEY';
  if (p === 'gemini' && !config.geminiApiKey) return 'TRANSCRIBE_PROVIDER=gemini exige GEMINI_API_KEY';
  if (
    p === 'command' &&
    (!config.transcribeCommand.includes('{input}') || !config.transcribeCommand.includes('{output}'))
  )
    return 'TRANSCRIBE_PROVIDER=command exige TRANSCRIBE_COMMAND com os placeholders {input} e {output}';
  if (p === 'command') {
    try {
      parseTranscribeCommandTemplate(config.transcribeCommand);
    } catch (err) {
      return (err as Error).message;
    }
  }
  if (!['none', 'assemblyai', 'openai', 'groq', 'gemini', 'command'].includes(p))
    return `TRANSCRIBE_PROVIDER desconhecido: ${p}`;
  return undefined;
}

// Uma transcrição por vez: não compete com gravações e cozimentos por CPU/rede.
let queue: Promise<void> = Promise.resolve();
const queued = new Set<string>();
const settlementCallbacks = new Map<string, Set<() => void>>();

function registerSettlement(recordingId: string, onSettled?: () => void): void {
  if (!onSettled) return;
  const callbacks = settlementCallbacks.get(recordingId) ?? new Set<() => void>();
  callbacks.add(onSettled);
  settlementCallbacks.set(recordingId, callbacks);
}

function settle(recordingId: string): void {
  const callbacks = settlementCallbacks.get(recordingId);
  settlementCallbacks.delete(recordingId);
  for (const callback of callbacks ?? []) {
    try {
      callback();
    } catch (err) {
      operationalFailure(
        `Falha liberando admissão recording=${operationalPii(recordingId)} error=${operationalError(err)}.`,
      );
    }
  }
}

function notifyDone(
  recordingId: string,
  onDone: ((meta: RecordingMeta) => void) | undefined,
  meta: RecordingMeta,
): void {
  try {
    onDone?.(meta);
  } catch (err) {
    operationalFailure(
      `Callback final da transcrição falhou recording=${operationalPii(recordingId)} error=${operationalError(err)}.`,
    );
  }
}

/** Há transcrição na fila/rodando para esta gravação? (guarda de delete/cleanup) */
export function isTranscribing(recordingId: string): boolean {
  return queued.has(recordingId);
}

/** Rodadas máximas de transcrição por gravação (exportado p/ boot recovery e UI). */
export { MAX_TRANSCRIPTION_ATTEMPTS };

/**
 * Enfileira a transcrição de uma gravação finalizada. `onDone` é chamado
 * com o meta atualizado (status done ou error). Idempotente por gravação.
 */
export function enqueueTranscription(
  recordingId: string,
  onDone?: (meta: RecordingMeta) => void,
  onSettled?: () => void,
): void {
  registerSettlement(recordingId, onSettled);
  if (!transcriptionEnabled()) {
    settle(recordingId);
    return;
  }
  if (queued.has(recordingId)) return;
  const meta = readMeta(recordingId);
  if (!meta || meta.status !== 'done' || meta.transcription?.status === 'done') {
    settle(recordingId);
    return;
  }
  if (!guildProcessingAllowed(meta.guildId)) {
    settle(recordingId);
    return;
  }

  const attempts = (meta.transcription?.attempts ?? 0) + 1;
  if (attempts > MAX_TRANSCRIPTION_ATTEMPTS) {
    // ex.: áudio que derruba/pendura o motor ou rate limit que não cede — não
    // trava a fila para sempre no mesmo item. Se já há transcrição PARCIAL,
    // ela é entregue como está (com aviso), em vez de virar erro total.
    const partial = (meta.transcription?.doneTrackIds?.length ?? 0) > 0;
    meta.transcription = {
      ...meta.transcription,
      status: partial ? 'partial' : 'error',
      provider: config.transcribeProvider,
      error: partial
        ? (meta.transcription?.error ?? 'faixas faltando após várias tentativas')
        : 'desisti após 4 tentativas',
      attempts,
      retryScheduled: false,
      finishedAt: Date.now(),
    };
    saveMeta(meta);
    // entrega o que deu: a ata roda sobre a transcrição parcial (melhor que nada)
    if (partial) enqueueMinutesOnly(recordingId, onDone);
    else {
      notifyDone(recordingId, onDone, meta); // avisa no Discord em vez de falhar em silêncio
      settle(recordingId);
    }
    return;
  }
  queued.add(recordingId);
  meta.transcription = { ...meta.transcription, status: 'pending', provider: config.transcribeProvider, attempts };
  saveMeta(meta);

  queue = queue
    .then(() => transcribeRecording(recordingId))
    .catch((err) =>
      operationalFailure(`Transcrição falhou recording=${operationalPii(recordingId)} error=${operationalError(err)}.`),
    )
    .then(() => {
      queued.delete(recordingId);
      const fresh = readMeta(recordingId);
      if (!fresh) {
        settle(recordingId);
        return;
      }
      const st = fresh.transcription?.status;
      const tries = fresh.transcription?.attempts ?? 0;
      // A guild pode ter voltado antes de o AbortSignal antigo terminar de
      // desenrolar a pilha. Nesse caso GuildCreate já tentou retomar, mas viu
      // `queued`; rearma aqui com a geração nova sem perder os callbacks.
      if (st === 'pending') {
        if (guildProcessingAllowed(fresh.guildId)) {
          queueMicrotask(() => enqueueTranscription(recordingId, onDone));
        } else {
          settle(recordingId);
        }
        return;
      }
      // Sobraram faixas (rate limit por hora) ou falhou tudo (ex.: 429 que não
      // cede): reagenda sozinho enquanto houver tentativa, e SÓ avisa no final.
      if ((st === 'partial' || st === 'error') && tries < MAX_TRANSCRIPTION_ATTEMPTS) {
        fresh.transcription = { status: st, ...fresh.transcription, retryScheduled: true };
        saveMeta(fresh);
        operationalInfo(
          `Transcrição ${st === 'partial' ? 'parcial' : 'falhou'} recording=${operationalPii(recordingId)} error=${operationalError(fresh.transcription.error ?? 'unknown')} retry_min=${Math.round(PARTIAL_RETRY_DELAY_MS / 60000)}.`,
        );
        const timer = setTimeout(() => enqueueTranscription(recordingId, onDone), PARTIAL_RETRY_DELAY_MS);
        timer.unref?.();
        return;
      }
      // Última rodada terminou parcial: é o resultado FINAL — gera a ata do que
      // existe e avisa (sem isso a página ficaria em "processando" pra sempre).
      if (st === 'partial') {
        fresh.transcription = { status: st, ...fresh.transcription, retryScheduled: false };
        saveMeta(fresh);
        enqueueMinutesOnly(recordingId, onDone);
        return;
      }
      // A guild pode pausar durante a ata e voltar antes de este job deixar
      // `queued`. O evento de retomada então não consegue enfileirar nada. Se a
      // transcrição já terminou e a ata voltou a pending/running, rearma aqui
      // com a nova geração em vez de deixá-la presa até restart/outro evento.
      if (transcriptReady(fresh) && (fresh.minutes?.status === 'pending' || fresh.minutes?.status === 'running')) {
        if (guildProcessingAllowed(fresh.guildId)) {
          queueMicrotask(() => enqueueMinutesOnly(recordingId, onDone));
        } else {
          settle(recordingId);
        }
        return;
      }
      notifyDone(recordingId, onDone, fresh);
      settle(recordingId);
    });
}

/**
 * Retoma SÓ a ata (transcrição já pronta ou parcial-final) — para recuperação
 * após reinício entre a transcrição e a ata, e para gerar a ata do que existe
 * quando faixas ficaram de fora após todas as tentativas. Idempotente.
 */
export function enqueueMinutesOnly(
  recordingId: string,
  onDone?: (meta: RecordingMeta) => void,
  onSettled?: () => void,
): void {
  registerSettlement(recordingId, onSettled);
  if (!minutesEnabled()) {
    settle(recordingId);
    return;
  }
  if (queued.has(recordingId)) return;
  const meta = readMeta(recordingId);
  if (!meta || !transcriptReady(meta) || meta.minutes?.status === 'done') {
    settle(recordingId);
    return;
  }
  if (!guildProcessingAllowed(meta.guildId)) {
    settle(recordingId);
    return;
  }
  const segments = readTranscript(recordingId);
  if (!segments || segments.length === 0) {
    notifyDone(recordingId, onDone, meta);
    settle(recordingId);
    return;
  }

  queued.add(recordingId);
  meta.minutes = { ...meta.minutes, status: 'pending', model: config.minutesModel };
  saveMeta(meta);
  queue = queue
    .then(() => generateMinutesStep(recordingId, segments))
    .catch((err) =>
      operationalFailure(
        `Ata retomada falhou recording=${operationalPii(recordingId)} error=${operationalError(err)}.`,
      ),
    )
    .then(() => {
      queued.delete(recordingId);
      const fresh = readMeta(recordingId);
      if (fresh?.minutes?.status === 'pending' && guildProcessingAllowed(fresh.guildId)) {
        queueMicrotask(() => enqueueMinutesOnly(recordingId, onDone));
        return;
      }
      if (fresh) notifyDone(recordingId, onDone, fresh);
      settle(recordingId);
    });
}

async function transcribeRecording(recordingId: string): Promise<void> {
  const meta = readMeta(recordingId);
  if (!meta || meta.status !== 'done' || meta.participants.length === 0) {
    if (meta && meta.participants.length === 0) {
      meta.transcription = { status: 'disabled' };
      saveMeta(meta);
    }
    return;
  }
  if (!guildProcessingAllowed(meta.guildId)) return;
  const guildWork = createGuildWorkContext(meta.guildId, () => guildProcessingAllowed(meta.guildId));

  // Retomada por faixa: rodada anterior pode ter parado no rate limit por hora.
  // Faixas já transcritas não são reenviadas (não gastam cota de novo).
  const doneTrackIds = new Set(meta.transcription?.doneTrackIds ?? []);
  const previous = doneTrackIds.size > 0 ? (readTranscript(recordingId) ?? []) : [];

  // Apelidos duplicados não podem virar UMA pessoa só na transcrição/ata/MCP:
  // o segundo "João" vira "João (2)".
  const nameCount = new Map<string, number>();
  const displayName = new Map<string, string>();
  for (const p of meta.participants) {
    const n = (nameCount.get(p.name) ?? 0) + 1;
    nameCount.set(p.name, n);
    displayName.set(p.id, n > 1 ? `${p.name} (${n})` : p.name);
  }

  meta.transcription = { ...meta.transcription, status: 'running', provider: config.transcribeProvider };
  saveMeta(meta);

  const work = path.join(cacheDir(meta.id), `transcribe-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(work, { recursive: true });

  // contexto da gravação pro Universal-3.5-Pro (nomes → keyterms); fila serial garante 1 por vez
  setAaiRecordingContext(meta);

  try {
    assertGuildWorkActive(guildWork);
    const all: TranscriptSegment[] = [...previous];
    const failed: string[] = [];

    for (const participant of meta.participants) {
      assertGuildWorkActive(guildWork);
      if (doneTrackIds.has(participant.id)) continue;
      const master = path.join(tracksDir(meta.id), participant.trackFile);
      if (!fs.existsSync(master)) {
        doneTrackIds.add(participant.id); // sem arquivo não há o que tentar de novo
        continue;
      }
      // duração REAL da faixa (não a nominal da sessão): -ss além do fim geraria
      // chunks-fantasma que quebram a transcrição. E uma faixa que falha não pode
      // derrubar as demais.
      const trackSec = await probeDurationSec(master);
      assertGuildWorkActive(guildWork);
      if (trackSec <= 0) {
        doneTrackIds.add(participant.id);
        continue;
      }
      try {
        const segments = await transcribeTrack(
          master,
          { ...participant, name: displayName.get(participant.id) ?? participant.name },
          trackSec,
          work,
          guildWork,
        );
        assertGuildWorkActive(guildWork);
        all.push(...segments);
        doneTrackIds.add(participant.id);
        // checkpoint: se a PRÓXIMA faixa estourar o rate limit, esta não se perde
        all.sort((a, b) => a.startMs - b.startMs);
        saveTranscript(meta.id, all);
        const cp = readMeta(meta.id);
        if (cp) {
          cp.transcription = { status: 'running', ...cp.transcription, doneTrackIds: [...doneTrackIds] };
          saveMeta(cp);
        }
      } catch (err) {
        if (isGuildWorkPausedError(err)) throw err;
        operationalFailure(
          `Transcrição de faixa falhou recording=${operationalPii(meta.id)} error=${operationalError(err)}.`,
        );
        failed.push(participant.name);
      }
    }

    // Só é erro total se NENHUMA faixa teve sucesso (fala transcrita OU faixa
    // legitimamente silenciosa contam como sucesso); senão entrega o que deu.
    if (failed.length > 0 && doneTrackIds.size === 0) {
      throw new Error(`todas as faixas falharam (${failed.join(', ')})`);
    }

    assertGuildWorkActive(guildWork);
    all.sort((a, b) => a.startMs - b.startMs);
    saveTranscript(meta.id, all);

    // relê para não sobrescrever notas/eventos adicionados durante a transcrição
    const fresh = readMeta(meta.id);
    if (!fresh) return; // apagada no meio do caminho
    fresh.transcription = {
      ...fresh.transcription,
      // faixas faltando ≠ pronto: 'partial' faz o chamador reagendar outra rodada
      status: failed.length > 0 ? 'partial' : 'done',
      provider: config.transcribeProvider,
      doneTrackIds: [...doneTrackIds],
      pendingTracks: failed.length > 0 ? failed : undefined,
      error: failed.length > 0 ? `faixas pendentes: ${failed.join(', ')}` : undefined,
      finishedAt: Date.now(),
    };
    saveMeta(fresh);

    // Ata com IA (mesma fila serial) — falha aqui NÃO derruba a transcrição já entregue.
    // Com faixas pendentes a ata espera a transcrição completar (senão sairia capenga).
    if (failed.length === 0 && all.length > 0 && minutesEnabled()) {
      assertGuildWorkActive(guildWork);
      await generateMinutesStep(meta.id, all, guildWork);
    }
  } catch (err) {
    const fresh = readMeta(meta.id);
    if (isGuildWorkPausedError(err)) {
      if (fresh) {
        fresh.transcription = {
          ...fresh.transcription,
          status: 'pending',
          provider: config.transcribeProvider,
          attempts: Math.max(0, (fresh.transcription?.attempts ?? 1) - 1),
          error: undefined,
          finishedAt: undefined,
          retryScheduled: false,
        };
        saveMeta(fresh);
      }
      return;
    }
    if (fresh) {
      fresh.transcription = {
        ...fresh.transcription,
        status: 'error',
        provider: config.transcribeProvider,
        error: String((err as Error).message).slice(0, 300),
        finishedAt: Date.now(),
      };
      saveMeta(fresh);
    }
    throw err;
  } finally {
    setAaiRecordingContext(undefined);
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Gera a ata após a transcrição. NUNCA relança — a transcrição já foi entregue. */
async function generateMinutesStep(
  recordingId: string,
  segments: TranscriptSegment[],
  existingWork?: GuildWorkContext,
): Promise<void> {
  const meta = readMeta(recordingId);
  if (!meta || !guildProcessingAllowed(meta.guildId)) return;
  const guildWork = existingWork ?? createGuildWorkContext(meta.guildId, () => guildProcessingAllowed(meta.guildId));
  assertGuildWorkActive(guildWork);
  meta.minutes = { status: 'running', model: config.minutesModel };
  saveMeta(meta);
  try {
    const minutes = await generateMinutes(meta, segments, guildWork);
    assertGuildWorkActive(guildWork);
    saveMinutes(recordingId, minutes);
    const fresh = readMeta(recordingId);
    if (!fresh) return;
    fresh.minutes = { status: 'done', model: config.minutesModel, finishedAt: Date.now() };
    saveMeta(fresh);
  } catch (err) {
    if (isGuildWorkPausedError(err)) {
      const fresh = readMeta(recordingId);
      if (fresh) {
        fresh.minutes = {
          status: 'pending',
          model: config.minutesModel,
          error: undefined,
          finishedAt: undefined,
        };
        saveMeta(fresh);
      }
      return;
    }
    operationalFailure(`Ata falhou recording=${operationalPii(recordingId)} error=${operationalError(err)}.`);
    const fresh = readMeta(recordingId);
    if (fresh) {
      fresh.minutes = {
        status: 'error',
        model: config.minutesModel,
        error: String((err as Error).message).slice(0, 300),
        finishedAt: Date.now(),
      };
      saveMeta(fresh);
    }
  }
}

async function transcribeTrack(
  masterFlac: string,
  participant: Participant,
  durationSec: number,
  work: string,
  guildWork: GuildWorkContext,
): Promise<TranscriptSegment[]> {
  // VAD primeiro: as faixas são preenchidas com silêncio digital (sincronia), e
  // silêncio na API = alucinação ("Legenda Adriana Zanotto") + cota desperdiçada
  // (o rate limit da Groq é em SEGUNDOS DE ÁUDIO por hora). Só a fala viaja.
  assertGuildWorkActive(guildWork);
  const intervals = await detectSpeechIntervals(masterFlac, durationSec);
  assertGuildWorkActive(guildWork);
  if (intervals === undefined) {
    // detecção falhou — caminho antigo (chunks de 20 min com filtro de silêncio grosseiro)
    return transcribeTrackLegacy(masterFlac, participant, durationSec, work, guildWork);
  }
  if (intervals.length === 0) return []; // ninguém falou nesta faixa — nada a enviar

  const out: TranscriptSegment[] = [];
  const batches = batchIntervals(intervals, chunkSeconds());

  for (let i = 0; i < batches.length; i++) {
    assertGuildWorkActive(guildWork);
    const batch = batches[i];
    const batchFile = path.join(work, `batch-${participant.index}-${i}.mp3`);
    await extractBatch(masterFlac, batch, batchFile);
    assertGuildWorkActive(guildWork);

    // MP3 compactado ínfimo = só header/ruído residual — não gasta uma chamada
    if (fs.statSync(batchFile).size < 1024) {
      fs.rmSync(batchFile, { force: true });
      continue;
    }

    let raw: RawSegment[];
    try {
      assertGuildWorkActive(guildWork);
      raw = await transcribeChunk(batchFile, work, batch.durationSec, guildWork);
      assertGuildWorkActive(guildWork);
    } catch (err) {
      fs.rmSync(batchFile, { force: true });
      // conteúdo bloqueado/incodificável de UM lote vira lacuna, não mata a faixa
      if (err instanceof ChunkContentError) {
        const first = batch.intervals[0];
        const last = batch.intervals[batch.intervals.length - 1];
        out.push({
          startMs: Math.round(first.start * 1000),
          endMs: Math.round(last.end * 1000),
          speaker: participant.name,
          text: '[trecho não transcrito]',
        });
        continue;
      }
      throw err; // erro sistêmico (rede/timeout/rate limit): propaga para marcar a faixa
    }
    fs.rmSync(batchFile, { force: true });

    // modelo sem timestamps (start=end=0 num bloco único): ancora no lote inteiro
    if (raw.length === 1 && raw[0].start === 0 && raw[0].end === 0) {
      raw[0].end = batch.durationSec;
    }

    for (const seg of raw) {
      const text = seg.text.trim();
      if (!text) continue;
      // tempos do ASR são relativos ao ÁUDIO COMPACTADO → mapeia de volta pra faixa real
      const startSec = mapBatchTimeToTrack(batch, Math.max(0, seg.start));
      const endSec = Math.max(startSec, mapBatchTimeToTrack(batch, Math.max(seg.start, seg.end), true));
      out.push({
        startMs: Math.round(startSec * 1000),
        endMs: Math.round(endSec * 1000),
        speaker: participant.name,
        text,
      });
    }
  }
  return filterHallucinations(out);
}

/** Caminho antigo (sem VAD): chunks fixos de 20 min. Usado só se o silencedetect falhar. */
async function transcribeTrackLegacy(
  masterFlac: string,
  participant: Participant,
  durationSec: number,
  work: string,
  guildWork: GuildWorkContext,
): Promise<TranscriptSegment[]> {
  const out: TranscriptSegment[] = [];
  const CHUNK = chunkSeconds();
  const chunks = Math.max(1, Math.ceil(durationSec / CHUNK));

  for (let i = 0; i < chunks; i++) {
    assertGuildWorkActive(guildWork);
    const offset = i * CHUNK;
    const thisChunkSec = Math.min(CHUNK, Math.max(1, durationSec - offset));
    const chunkFile = path.join(work, `chunk-${participant.index}-${i}.mp3`);
    // mono 16 kHz 48 kbps: ótimo para ASR e pequeno o bastante para qualquer API
    await runFfmpeg([
      '-ss',
      String(offset),
      '-t',
      String(CHUNK),
      '-i',
      masterFlac,
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      '48k',
      '-y',
      chunkFile,
    ]);
    assertGuildWorkActive(guildWork);

    // Guarda dupla contra chunk-fantasma: -ss perto/além do fim gera um MP3 só de
    // header (~260 bytes, mp3 de 48kbps tem >5KB por segundo real). E chunks que
    // são só o padding de silêncio da faixa não vão para a API: custo à toa, e o
    // Whisper ALUCINA texto em silêncio (atribuiria falas falsas a quem calou).
    const size = fs.statSync(chunkFile).size;
    if (size < 1024 || !(await chunkHasAudio(chunkFile, size))) {
      fs.rmSync(chunkFile, { force: true });
      continue;
    }
    assertGuildWorkActive(guildWork);

    let raw: RawSegment[];
    try {
      raw = await transcribeChunk(chunkFile, work, thisChunkSec, guildWork);
      assertGuildWorkActive(guildWork);
    } catch (err) {
      fs.rmSync(chunkFile, { force: true });
      // conteúdo bloqueado/incodificável de UM chunk vira lacuna, não mata a faixa
      if (err instanceof ChunkContentError) {
        out.push({
          startMs: Math.round(offset * 1000),
          endMs: Math.round((offset + thisChunkSec) * 1000),
          speaker: participant.name,
          text: '[trecho não transcrito]',
        });
        continue;
      }
      throw err; // erro sistêmico (rede/timeout): propaga para marcar a faixa
    }
    fs.rmSync(chunkFile, { force: true });

    // modelo sem timestamps (start=end=0 num bloco único): ancora no chunk
    // inteiro para a cronologia se manter ao menos na granularidade do chunk
    if (raw.length === 1 && raw[0].start === 0 && raw[0].end === 0) {
      raw[0].end = thisChunkSec;
    }

    for (const seg of raw) {
      const text = seg.text.trim();
      if (!text) continue;
      out.push({
        startMs: Math.round((offset + seg.start) * 1000),
        endMs: Math.round((offset + seg.end) * 1000),
        speaker: participant.name,
        text,
      });
    }
  }
  return filterHallucinations(out);
}

/** Duração real de um arquivo de áudio em segundos (0 se não der para medir). */
async function probeDurationSec(file: string): Promise<number> {
  try {
    const stderr = await runFfmpeg(['-i', file, '-f', 'null', '-'], 'info');
    const m = stderr.match(/time=(\d+):(\d+):([\d.]+)/g);
    if (!m || m.length === 0) return 0;
    const last = m[m.length - 1].slice(5);
    const [h, mm, ss] = last.split(':').map(Number);
    return h * 3600 + mm * 60 + ss;
  } catch {
    return 0;
  }
}

/**
 * Detecção real de silêncio via ffmpeg volumedetect. O padding das faixas é
 * silêncio DIGITAL puro (amostras zero → max_volume abaixo de ~-90 dB), então
 * o limiar de -80 dB descarta só o padding e nunca fala real (mesmo baixinha).
 */
async function chunkHasAudio(file: string, size: number): Promise<boolean> {
  try {
    const stderr = await runFfmpeg(['-i', file, '-af', 'volumedetect', '-f', 'null', '-'], 'info');
    const match = stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
    if (!match) return true; // não deu para medir — na dúvida, transcreve
    return Number(match[1]) > -80; // acima de -80 dB há sinal real; padding é ~-91 dB
  } catch {
    // volumedetect falhou (ex.: arquivo indecodificável): se é minúsculo, é
    // chunk-fantasma → trata como silêncio; se tem tamanho plausível, transcreve
    return size >= 4096;
  }
}

function transcribeChunk(
  file: string,
  work: string,
  chunkSec: number,
  guildWork: GuildWorkContext,
): Promise<RawSegment[]> {
  assertGuildWorkActive(guildWork);
  switch (config.transcribeProvider) {
    case 'assemblyai':
      // fallback: se a AssemblyAI falhar por questão SISTÊMICA (crédito no fim,
      // 5xx, timeout) e houver GROQ_API_KEY, o mesmo chunk tenta no Whisper da
      // Groq — a transcrição não pode morrer por causa de um provedor fora do ar
      return assemblyaiTranscribe(file, chunkSec, guildWork).catch((err) => {
        assertGuildWorkActive(guildWork);
        if (err instanceof ChunkContentError || config.transcribeFallbackProvider !== 'groq' || !config.groqApiKey)
          throw err;
        operationalWarn(`AssemblyAI falhou error=${operationalError(err)}; tentando o mesmo chunk na Groq.`);
        return whisperApi(
          'https://api.groq.com/openai/v1/audio/transcriptions',
          config.groqApiKey,
          'whisper-large-v3',
          file,
          guildWork,
        );
      });
    case 'openai':
      return whisperApi(
        'https://api.openai.com/v1/audio/transcriptions',
        config.openaiApiKey,
        config.transcribeModel || 'whisper-1',
        file,
        guildWork,
      );
    case 'groq':
      return whisperApi(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        config.groqApiKey,
        // large-v3 completo: erra bem menos em pt-BR que o -turbo (mesma cota free)
        config.transcribeModel || 'whisper-large-v3',
        file,
        guildWork,
      );
    case 'gemini':
      return geminiTranscribe(file, guildWork);
    case 'command':
      return commandTranscribe(file, work, chunkSec, guildWork);
    default:
      return Promise.resolve([]);
  }
}

// ---------- AssemblyAI (Universal-3.5-Pro — top-3 em pt-BR no Open ASR Leaderboard) ----------

const AAI_BASE = 'https://api.assemblyai.com/v2';

/**
 * Contexto POR GRAVAÇÃO pro Universal-3.5-Pro: prompt contextual + keyterms.
 * Nomes de quem estava na call viram keyterms → a grafia exata ("Kaio" vs "Caio")
 * chega certa na transcrição e, por consequência, na ata e no /perguntar.
 * A fila de transcrição é SERIAL (uma gravação por vez), então uma variável de
 * módulo é segura — setada no início de transcribeRecording e limpa no finally.
 */
let aaiKeyterms: string[] = [];

/** Monta os keyterms da gravação: participantes (falando ou não) + servidor/canal + vocabulário fixo (env). */
export function buildAaiKeyterms(meta: RecordingMeta): string[] {
  const terms = new Set<string>();
  if (config.transcribeSendMeetingContext) {
    for (const p of meta.participants) terms.add(p.name);
    for (const p of meta.presence ?? []) terms.add(p.name);
    terms.add(meta.guildName);
    terms.add(meta.voiceChannelName);
  }
  for (const t of config.transcribeKeyterms) terms.add(t);
  // limite da API: 1000 termos / 6 palavras por termo — teto defensivo bem menor
  // (a tokenização interna come capacidade; nomes + jargão cabem folgados em 200)
  return [...terms]
    .map((s) => s.replace(/[\r\n\t]+/g, ' ').trim())
    .filter((s) => s.length > 1 && s.split(/\s+/).length <= 6)
    .slice(0, 200);
}

/** Define/limpa o contexto de keyterms da gravação em transcrição (fila serial). */
export function setAaiRecordingContext(meta: RecordingMeta | undefined): void {
  aaiKeyterms = meta ? buildAaiKeyterms(meta) : [];
}

/**
 * Fluxo da AssemblyAI: upload do arquivo → cria job de transcrição → poll até
 * completar → busca as sentenças (viram nossos segmentos com timestamps).
 * Language: usa os 2 primeiros caracteres de TRANSCRIBE_LANGUAGE ('pt' cobre
 * pt-BR — é o grosso do treino deles em português).
 */
async function assemblyaiTranscribe(
  file: string,
  chunkSec: number,
  guildWork: GuildWorkContext,
): Promise<RawSegment[]> {
  assertGuildWorkActive(guildWork);
  const auth = { Authorization: config.assemblyaiApiKey };

  const up = await fetchWithRetry(
    `${AAI_BASE}/upload`,
    {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/octet-stream' },
      body: fs.readFileSync(file),
      signal: guildWork.signal,
    },
    { attempts: 3 },
  );
  const { upload_url } = (await up.json()) as { upload_url?: string };
  assertGuildWorkActive(guildWork);
  if (!upload_url) throw new Error('AssemblyAI upload não devolveu upload_url');

  const models = config.transcribeModel ? [config.transcribeModel] : ['universal-3-5-pro', 'universal-2'];
  const baseBody: Record<string, unknown> = {
    audio_url: upload_url,
    language_code: config.transcribeLanguage.slice(0, 2) || 'pt',
    // API atual usa speech_modelS (lista em ordem de preferência); o antigo
    // speech_model singular foi descontinuado em 2026
    speech_models: models,
    punctuate: true,
    format_text: true,
  };
  // prompt contextual + keyterms: recursos do Universal-3.5-Pro (o "hard stuff":
  // nomes próprios, jargão). Só entram quando ele está na lista de preferência.
  const extras: Record<string, unknown> = {};
  if (models.includes('universal-3-5-pro')) {
    if (config.transcribePrompt) extras.prompt = config.transcribePrompt.slice(0, 800);
    if (aaiKeyterms.length > 0) extras.keyterms_prompt = aaiKeyterms;
  }

  const createJob = async (body: Record<string, unknown>) => {
    const create = await fetchWithRetry(
      `${AAI_BASE}/transcript`,
      {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: guildWork.signal,
      },
      { attempts: 3 },
    );
    const result = (await create.json()) as { id?: string; status?: string; error?: string };
    assertGuildWorkActive(guildWork);
    return result;
  };

  let created: { id?: string; status?: string; error?: string };
  try {
    created = await createJob({ ...baseBody, ...extras });
  } catch (err) {
    // 4xx citando prompt/keyterms: degrada pro job básico sem registrar o corpo
    // remoto, que pode ecoar nomes ou trechos privados do contexto.
    if (
      Object.keys(extras).length > 0 &&
      err instanceof UpstreamHttpError &&
      err.status >= 400 &&
      err.status < 500 &&
      err.category === 'context-fields-rejected'
    ) {
      operationalWarn('AssemblyAI recusou prompt/keyterms; reenviando sem eles.');
      created = await createJob(baseBody);
    } else {
      throw err;
    }
  }
  if (!created.id) throw new Error('AssemblyAI não criou o job (sem id)');

  // poll proporcional à duração do áudio (piso 3 min, teto 30 min — os lotes têm
  // no máx. 20 min de fala, e um poll sem teto seguraria a fila serial por horas)
  const deadline = Date.now() + Math.min(30 * 60_000, Math.max(3 * 60_000, chunkSec * 1000));
  for (;;) {
    await abortableDelay(3000, guildWork.signal);
    assertGuildWorkActive(guildWork);
    const st = await fetchWithRetry(
      `${AAI_BASE}/transcript/${created.id}`,
      { headers: auth, signal: guildWork.signal },
      { attempts: 3 },
    );
    const job = (await st.json()) as { status?: string; error?: string };
    assertGuildWorkActive(guildWork);
    if (job.status === 'completed') break;
    if (job.status === 'error') {
      // erro de CONTEÚDO (áudio ilegível) vira lacuna; resto é sistêmico → fallback/retry.
      // Cuidado pra NÃO classificar transiente como conteúdo (ex.: "unable to
      // download audio" contém "audio" mas é transiente) — por isso termos estreitos.
      const msg = job.error ?? '';
      if (/corrupt|unsupported|decode|too short|duration/i.test(msg)) {
        throw new ChunkContentError('AssemblyAI recusou ou não decodificou o áudio');
      }
      throw new Error('AssemblyAI encerrou o job com erro');
    }
    if (Date.now() > deadline) throw new Error('AssemblyAI: transcrição não completou a tempo (poll timeout)');
  }

  const sent = await fetchWithRetry(
    `${AAI_BASE}/transcript/${created.id}/sentences`,
    { headers: auth, signal: guildWork.signal },
    { attempts: 3 },
  );
  const data = (await sent.json()) as { sentences?: { text?: string; start?: number; end?: number }[] };
  assertGuildWorkActive(guildWork);
  return (data.sentences ?? [])
    .filter((s) => typeof s.text === 'string' && s.text.trim())
    .map((s) => ({
      start: (Number(s.start) || 0) / 1000, // AssemblyAI usa ms; nosso RawSegment usa segundos
      end: (Number(s.end) || 0) / 1000,
      text: s.text as string,
    }));
}

// ---------- OpenAI / Groq (API compatível) ----------

async function whisperApi(
  url: string,
  apiKey: string,
  model: string,
  file: string,
  guildWork: GuildWorkContext,
): Promise<RawSegment[]> {
  assertGuildWorkActive(guildWork);
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/mpeg' }), path.basename(file));
  form.append('model', model);
  form.append('language', config.transcribeLanguage);
  form.append('response_format', 'verbose_json');
  // temperature 0 + prompt de contexto: menos alucinação e melhor grafia de jargão
  form.append('temperature', '0');
  if (config.transcribePrompt) form.append('prompt', config.transcribePrompt.slice(0, 800));

  const resp = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: guildWork.signal,
    },
    // 429 com "try again in 8m": espera de verdade (a fila é serial e roda em
    // segundo plano) — melhor esperar que perder a faixa e gastar outra rodada
    { attempts: 4, maxWaitMs: ASR_MAX_WAIT_MS },
  );
  const data = (await resp.json()) as { segments?: { start: number; end: number; text: string }[]; text?: string };
  assertGuildWorkActive(guildWork);
  if (data.segments) return data.segments.map((s) => ({ start: s.start, end: s.end, text: s.text }));
  // modelos sem timestamps (ex.: gpt-4o-transcribe) devolvem só o texto
  return data.text ? [{ start: 0, end: 0, text: data.text }] : [];
}

// ---------- Gemini ----------

async function geminiTranscribe(file: string, guildWork: GuildWorkContext): Promise<RawSegment[]> {
  assertGuildWorkActive(guildWork);
  const model = config.transcribeModel || 'gemini-3.5-flash';
  const audio = fs.readFileSync(file).toString('base64');
  const prompt =
    `Transcreva este áudio (idioma: ${config.transcribeLanguage}). Responda SOMENTE um array JSON, sem markdown, ` +
    `no formato [{"start": segundos, "end": segundos, "text": "..."}] com um item por trecho de fala.`;

  const resp = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.geminiApiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'audio/mpeg', data: audio } }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 8192, responseMimeType: 'application/json' },
      }),
      signal: guildWork.signal,
    },
  );
  const data = (await resp.json()) as {
    candidates?: { finishReason?: string; content?: { parts?: { text?: string }[] } }[];
  };
  assertGuildWorkActive(guildWork);
  const candidate = data.candidates?.[0];
  // resposta interrompida (limite de saída, filtro de segurança/recitação) NÃO
  // pode virar transcrição "pronta"; é falha de conteúdo → lacuna neste chunk
  if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
    throw new ChunkContentError(`Gemini interrompeu a resposta (${candidate.finishReason})`);
  }
  const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  const trimmed = text.trim();
  if (!trimmed) return [];
  const match = trimmed.match(/\[[\s\S]*\]/);
  const jsonish = trimmed.startsWith('[') || trimmed.startsWith('{');
  if (!match) {
    if (jsonish) throw new ChunkContentError('Gemini devolveu JSON inválido/incompleto');
    return [{ start: 0, end: 0, text: trimmed }]; // resposta em prosa — usa como bloco único
  }
  try {
    const parsed = JSON.parse(match[0]) as { start?: number; end?: number; text?: string }[];
    return parsed
      .filter((s) => typeof s.text === 'string')
      .map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: s.text as string }));
  } catch {
    throw new ChunkContentError('Gemini devolveu JSON que não parseia');
  }
}

// ---------- Comando local (faster-whisper, whisper.cpp, Parakeet...) ----------

export async function commandTranscribe(
  file: string,
  work: string,
  chunkSec: number,
  guildWork: GuildWorkContext,
): Promise<RawSegment[]> {
  assertGuildWorkActive(guildWork);
  const outFile = path.join(work, `out-${crypto.randomBytes(3).toString('hex')}.json`);
  const command = parseTranscribeCommandTemplate(config.transcribeCommand);
  const args = command.args.map((arg) => (arg === '{input}' ? file : arg === '{output}' ? outFile : arg));
  // watchdog proporcional: um motor a 0,2× tempo real ainda passa; travamento real não
  const timeoutMs = Math.max(COMMAND_TIMEOUT_MS, chunkSec * 1000 * config.transcribeTimeoutFactor);

  await new Promise<void>((resolve, reject) => {
    const env = buildTranscribeCommandEnvironment(process.env, config.transcribeCommandEnvAllowlist);
    // Sem shell: nomes de arquivo e configuração nunca são reinterpretados como
    // operadores. detached mantém o watchdog capaz de derrubar o grupo inteiro.
    const proc = spawn(command.executable, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
      env,
      shell: false,
    });
    if (proc.pid) commandPids.add(proc.pid);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      guildWork.signal.removeEventListener('abort', onAbort);
      if (proc.pid) commandPids.delete(proc.pid);
      if (error) reject(error);
      else resolve();
    };
    // Consome sem registrar: ferramentas locais podem ecoar caminhos, prompts ou
    // trechos de áudio no stderr, e os logs Docker não são arquivo de reunião.
    proc.stderr.resume();
    const timeout = setTimeout(() => {
      killGroup(proc);
      finish(
        new Error(
          `TRANSCRIBE_COMMAND excedeu o tempo limite (~${Math.round(timeoutMs / 60000)} min) e foi morto — a fila segue`,
        ),
      );
    }, timeoutMs);
    const onAbort = () => {
      killGroup(proc);
      finish(guildWork.signal.reason instanceof Error ? guildWork.signal.reason : new Error('processamento pausado'));
    };
    guildWork.signal.addEventListener('abort', onAbort, { once: true });
    if (guildWork.signal.aborted) onAbort();
    proc.on('error', (err) => finish(err));
    proc.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`TRANSCRIBE_COMMAND saiu com código ${code}`));
    });
  });

  try {
    assertGuildWorkActive(guildWork);
    const parsed = JSON.parse(fs.readFileSync(outFile, 'utf8')) as { start?: number; end?: number; text?: string }[];
    if (!Array.isArray(parsed)) throw new Error('não é um array');
    return parsed
      .filter((s) => typeof s.text === 'string')
      .map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: s.text as string }));
  } catch (err) {
    if (isGuildWorkPausedError(err)) throw err;
    throw new Error('TRANSCRIBE_COMMAND deve escrever em {output} um array JSON válido de segmentos', { cause: err });
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}

// ---------- util ----------

/** Render em Markdown: [hh:mm:ss] **Nome:** texto */
export function transcriptToMarkdown(meta: RecordingMeta, segments: TranscriptSegment[]): string {
  // Gravações antigas não tinham locale e historicamente geravam arquivos em PT-BR.
  const locale = meta.locale?.toLowerCase().startsWith('en') ? 'en' : 'pt';
  const labels =
    locale === 'en'
      ? {
          dateLocale: 'en-US',
          title: 'Transcript',
          recording: 'Recording',
          partial: 'Partial transcript',
          missingTracks: 'tracks not transcribed',
          notes: 'Recording notes',
        }
      : {
          dateLocale: 'pt-BR',
          title: 'Transcrição',
          recording: 'Gravação',
          partial: 'Transcrição parcial',
          missingTracks: 'faixas não transcritas',
          notes: 'Notas da gravação',
        };
  // fuso explícito: o arquivo é estático (sem navegador para reescrever a data)
  const when = new Date(meta.startedAt).toLocaleString(labels.dateLocale, { timeZone: config.timezone });
  const lines = [
    `# ${labels.title} — ${cleanInline(meta.voiceChannelName)} (${when})`,
    '',
    `${labels.recording} \`${meta.id}\` • ${meta.participants.map((p) => cleanInline(p.name)).join(', ')}`,
    '',
  ];
  // quem arquiva o .md precisa SABER que está incompleto (faixas fora por rate limit)
  if (meta.transcription?.status === 'partial') {
    const missing = (meta.transcription.pendingTracks ?? []).map((n) => cleanInline(n)).join(', ');
    lines.push(`> ⚠️ **${labels.partial}** — ${labels.missingTracks}: ${missing || '?'}.`, '');
  }
  for (const seg of segments) {
    // fala/apelido são entrada adversarial: limpa controle/ANSI e neutraliza fences
    lines.push(
      `**[${msToClock(seg.startMs)}] ${cleanInline(seg.speaker)}:** ${neutralizeFences(cleanInline(seg.text))}`,
    );
    lines.push('');
  }
  if (meta.notes.length > 0) {
    lines.push('---', '', `## ${labels.notes}`, '');
    for (const note of meta.notes) {
      lines.push(
        `- **[${msToClock(note.atMs)}]** ${cleanInline(note.author)}: ${neutralizeFences(cleanInline(note.text))}`,
      );
    }
  }
  return lines.join('\n');
}

export function msToClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
