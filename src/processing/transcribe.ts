import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import {
  cacheDir,
  Participant,
  readMeta,
  RecordingMeta,
  saveMeta,
  saveTranscript,
  tracksDir,
  TranscriptSegment,
} from '../store';
import { runFfmpeg } from './ffmpeg';

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
const MAX_TRANSCRIPTION_ATTEMPTS = 2;

/** PIDs (grupos) de comandos locais em voo — mortos no shutdown para não virarem órfãos. */
const commandPids = new Set<number>();

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
  return ['openai', 'groq', 'gemini', 'command'].includes(config.transcribeProvider);
}

/** Valida a configuração no boot para o erro aparecer cedo, não na primeira call. */
export function validateTranscriptionConfig(): string | undefined {
  const p = config.transcribeProvider;
  if (p === 'none') return undefined;
  if (p === 'openai' && !config.openaiApiKey) return 'TRANSCRIBE_PROVIDER=openai exige OPENAI_API_KEY';
  if (p === 'groq' && !config.groqApiKey) return 'TRANSCRIBE_PROVIDER=groq exige GROQ_API_KEY';
  if (p === 'gemini' && !config.geminiApiKey) return 'TRANSCRIBE_PROVIDER=gemini exige GEMINI_API_KEY';
  if (p === 'command' && (!config.transcribeCommand.includes('{input}') || !config.transcribeCommand.includes('{output}')))
    return 'TRANSCRIBE_PROVIDER=command exige TRANSCRIBE_COMMAND com os placeholders {input} e {output}';
  if (!['none', 'openai', 'groq', 'gemini', 'command'].includes(p))
    return `TRANSCRIBE_PROVIDER desconhecido: ${p}`;
  return undefined;
}

// Uma transcrição por vez: não compete com gravações e cozimentos por CPU/rede.
let queue: Promise<void> = Promise.resolve();
const queued = new Set<string>();

/** Há transcrição na fila/rodando para esta gravação? (guarda de delete/cleanup) */
export function isTranscribing(recordingId: string): boolean {
  return queued.has(recordingId);
}

/**
 * Enfileira a transcrição de uma gravação finalizada. `onDone` é chamado
 * com o meta atualizado (status done ou error). Idempotente por gravação.
 */
export function enqueueTranscription(recordingId: string, onDone?: (meta: RecordingMeta) => void): void {
  if (!transcriptionEnabled() || queued.has(recordingId)) return;
  const meta = readMeta(recordingId);
  if (!meta || meta.status !== 'done' || meta.transcription?.status === 'done') return;

  const attempts = (meta.transcription?.attempts ?? 0) + 1;
  if (attempts > MAX_TRANSCRIPTION_ATTEMPTS) {
    // ex.: áudio que derruba/pendura o motor — não trava a fila para sempre no mesmo item
    meta.transcription = { status: 'error', provider: config.transcribeProvider, error: 'desisti após 2 tentativas', attempts };
    saveMeta(meta);
    onDone?.(meta); // avisa no Discord em vez de falhar em silêncio
    return;
  }
  queued.add(recordingId);
  meta.transcription = { status: 'pending', provider: config.transcribeProvider, attempts };
  saveMeta(meta);

  queue = queue
    .then(() => transcribeRecording(recordingId))
    .catch((err) => console.error(`Transcrição de ${recordingId} falhou:`, err))
    .then(() => {
      queued.delete(recordingId);
      const fresh = readMeta(recordingId);
      if (fresh && onDone) onDone(fresh);
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

  meta.transcription = { ...meta.transcription, status: 'running', provider: config.transcribeProvider };
  saveMeta(meta);

  const work = path.join(cacheDir(meta.id), `transcribe-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(work, { recursive: true });

  try {
    const all: TranscriptSegment[] = [];
    const failed: string[] = [];

    for (const participant of meta.participants) {
      const master = path.join(tracksDir(meta.id), participant.trackFile);
      if (!fs.existsSync(master)) continue;
      // duração REAL da faixa (não a nominal da sessão): -ss além do fim geraria
      // chunks-fantasma que quebram a transcrição. E uma faixa que falha não pode
      // derrubar as demais.
      const trackSec = await probeDurationSec(master);
      if (trackSec <= 0) continue;
      try {
        const segments = await transcribeTrack(master, participant, trackSec, work);
        all.push(...segments);
      } catch (err) {
        console.error(`Transcrição da faixa de ${participant.name} (${meta.id}) falhou:`, (err as Error).message);
        failed.push(participant.name);
      }
    }

    // Só é erro total se NINGUÉM foi transcrito; caso contrário entrega o que deu.
    if (all.length === 0 && failed.length > 0) {
      throw new Error(`todas as faixas falharam (${failed.join(', ')})`);
    }

    all.sort((a, b) => a.startMs - b.startMs);
    saveTranscript(meta.id, all);

    // relê para não sobrescrever notas/eventos adicionados durante a transcrição
    const fresh = readMeta(meta.id);
    if (!fresh) return; // apagada no meio do caminho
    fresh.transcription = { ...fresh.transcription, status: 'done', provider: config.transcribeProvider, finishedAt: Date.now() };
    saveMeta(fresh);
  } catch (err) {
    const fresh = readMeta(meta.id);
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
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function transcribeTrack(
  masterFlac: string,
  participant: Participant,
  durationSec: number,
  work: string,
): Promise<TranscriptSegment[]> {
  const out: TranscriptSegment[] = [];
  const CHUNK = chunkSeconds();
  const chunks = Math.max(1, Math.ceil(durationSec / CHUNK));

  for (let i = 0; i < chunks; i++) {
    const offset = i * CHUNK;
    const thisChunkSec = Math.min(CHUNK, Math.max(1, durationSec - offset));
    const chunkFile = path.join(work, `chunk-${participant.index}-${i}.mp3`);
    // mono 16 kHz 48 kbps: ótimo para ASR e pequeno o bastante para qualquer API
    await runFfmpeg([
      '-ss', String(offset),
      '-t', String(CHUNK),
      '-i', masterFlac,
      '-ac', '1',
      '-ar', '16000',
      '-b:a', '48k',
      '-y', chunkFile,
    ]);

    // Guarda dupla contra chunk-fantasma: -ss perto/além do fim gera um MP3 só de
    // header (~260 bytes, mp3 de 48kbps tem >5KB por segundo real). E chunks que
    // são só o padding de silêncio da faixa não vão para a API: custo à toa, e o
    // Whisper ALUCINA texto em silêncio (atribuiria falas falsas a quem calou).
    const size = fs.statSync(chunkFile).size;
    if (size < 1024 || !(await chunkHasAudio(chunkFile, size))) {
      fs.rmSync(chunkFile, { force: true });
      continue;
    }

    let raw: RawSegment[];
    try {
      raw = await transcribeChunk(chunkFile, work, thisChunkSec);
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
  return out;
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

function transcribeChunk(file: string, work: string, chunkSec: number): Promise<RawSegment[]> {
  switch (config.transcribeProvider) {
    case 'openai':
      return whisperApi('https://api.openai.com/v1/audio/transcriptions', config.openaiApiKey, config.transcribeModel || 'whisper-1', file);
    case 'groq':
      return whisperApi('https://api.groq.com/openai/v1/audio/transcriptions', config.groqApiKey, config.transcribeModel || 'whisper-large-v3-turbo', file);
    case 'gemini':
      return geminiTranscribe(file);
    case 'command':
      return commandTranscribe(file, work, chunkSec);
    default:
      return Promise.resolve([]);
  }
}

// ---------- OpenAI / Groq (API compatível) ----------

async function whisperApi(url: string, apiKey: string, model: string, file: string): Promise<RawSegment[]> {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/mpeg' }), path.basename(file));
  form.append('model', model);
  form.append('language', config.transcribeLanguage);
  form.append('response_format', 'verbose_json');

  const resp = await fetchWithRetry(url, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
  const data = (await resp.json()) as { segments?: { start: number; end: number; text: string }[]; text?: string };
  if (data.segments) return data.segments.map((s) => ({ start: s.start, end: s.end, text: s.text }));
  // modelos sem timestamps (ex.: gpt-4o-transcribe) devolvem só o texto
  return data.text ? [{ start: 0, end: 0, text: data.text }] : [];
}

// ---------- Gemini ----------

async function geminiTranscribe(file: string): Promise<RawSegment[]> {
  const model = config.transcribeModel || 'gemini-2.0-flash';
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
    },
  );
  const data = (await resp.json()) as {
    candidates?: { finishReason?: string; content?: { parts?: { text?: string }[] } }[];
  };
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

async function commandTranscribe(file: string, work: string, chunkSec: number): Promise<RawSegment[]> {
  const outFile = path.join(work, `out-${crypto.randomBytes(3).toString('hex')}.json`);
  // caminhos entram single-quoted no sh -c (diretórios com espaço não quebram o comando)
  const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  const cmd = config.transcribeCommand.replaceAll('{input}', shq(file)).replaceAll('{output}', shq(outFile));
  // watchdog proporcional: um motor a 0,2× tempo real ainda passa; travamento real não
  const timeoutMs = Math.max(COMMAND_TIMEOUT_MS, chunkSec * 1000 * config.transcribeTimeoutFactor);

  await new Promise<void>((resolve, reject) => {
    // detached: o kill de timeout derruba o grupo inteiro (sh + filhos), não só o sh
    const proc = spawn('sh', ['-c', cmd], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    if (proc.pid) commandPids.add(proc.pid);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4096)));
    const timeout = setTimeout(() => {
      killGroup(proc);
      reject(new Error(`TRANSCRIBE_COMMAND excedeu o tempo limite (~${Math.round(timeoutMs / 60000)} min) e foi morto — a fila segue`));
    }, timeoutMs);
    proc.on('error', (err) => {
      clearTimeout(timeout);
      if (proc.pid) commandPids.delete(proc.pid);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (proc.pid) commandPids.delete(proc.pid);
      if (code === 0) resolve();
      else reject(new Error(`TRANSCRIBE_COMMAND saiu com código ${code}: ${stderr.slice(-400)}`));
    });
  });

  try {
    const parsed = JSON.parse(fs.readFileSync(outFile, 'utf8')) as { start?: number; end?: number; text?: string }[];
    if (!Array.isArray(parsed)) throw new Error('não é um array');
    return parsed
      .filter((s) => typeof s.text === 'string')
      .map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: s.text as string }));
  } catch (err) {
    throw new Error(
      `TRANSCRIBE_COMMAND deve escrever em {output} um JSON [{"start":s,"end":s,"text":"..."}] — ${(err as Error).message}`,
    );
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}

// ---------- util ----------

async function fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  let lastErr: Error | undefined;
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetch(url, init);
      if (resp.ok) return resp;
      const body = (await resp.text()).slice(0, 300);
      lastErr = new Error(`HTTP ${resp.status}: ${body}`);
      // 4xx (menos 429) não vai melhorar com retry — break sai do loop e
      // cai no throw final (um throw aqui seria engolido pelo próprio catch)
      if (resp.status < 500 && resp.status !== 429) break;
    } catch (err) {
      lastErr = err as Error;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  throw lastErr ?? new Error('falha de rede');
}

/** Render em Markdown: [hh:mm:ss] **Nome:** texto */
export function transcriptToMarkdown(meta: RecordingMeta, segments: TranscriptSegment[]): string {
  // fuso explícito: o arquivo é estático (sem navegador para reescrever a data)
  const when = new Date(meta.startedAt).toLocaleString('pt-BR', { timeZone: config.timezone });
  const lines = [
    `# Transcrição — ${meta.voiceChannelName} (${when})`,
    '',
    `Gravação \`${meta.id}\` • ${meta.participants.map((p) => p.name).join(', ')}`,
    '',
  ];
  for (const seg of segments) {
    lines.push(`**[${msToClock(seg.startMs)}] ${seg.speaker}:** ${seg.text}`);
    lines.push('');
  }
  if (meta.notes.length > 0) {
    lines.push('---', '', '## Notas da gravação', '');
    for (const note of meta.notes) {
      lines.push(`- **[${msToClock(note.atMs)}]** ${note.author}: ${note.text}`);
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
