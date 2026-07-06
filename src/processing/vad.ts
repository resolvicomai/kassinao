import { runFfmpeg } from './ffmpeg';

/** Trecho com fala dentro de uma faixa (segundos, relativos ao início da faixa). */
export interface SpeechInterval {
  start: number;
  end: number;
}

/** Um lote de trechos compactados num único arquivo de áudio para a API. */
export interface SpeechBatch {
  intervals: SpeechInterval[];
  /** Posição de início de cada intervalo DENTRO do arquivo compactado (segundos). */
  batchStarts: number[];
  /** Duração total de fala no lote (segundos). */
  durationSec: number;
}

/** Margem antes/depois de cada trecho de fala (não cortar início/fim de palavra). */
const PAD_SEC = 0.3;
/** Silêncios menores que isso entre falas são mantidos (evita picotar frases). */
const MERGE_GAP_SEC = 1.2;
/** Trechos mais curtos que isso são ruído de clique/respiro — fora. */
const MIN_INTERVAL_SEC = 0.35;
/** Teto de intervalos por lote (expressão de filtro do ffmpeg tem limite de tamanho). */
const MAX_INTERVALS_PER_BATCH = 80;

/**
 * Detecta os trechos com FALA de uma faixa via ffmpeg silencedetect.
 * As faixas do Kassinão são preenchidas com silêncio digital (~-91 dB) entre as
 * falas, então -70 dB separa com segurança fala real de padding. Whisper alucina
 * em silêncio ("Legenda Adriana Zanotto", créditos de legenda...), então só o
 * que tem fala vai para a API — e o volume de áudio enviado despenca junto.
 *
 * Retorna undefined se a detecção falhar (chamador usa o caminho antigo).
 */
export async function detectSpeechIntervals(file: string, durationSec: number): Promise<SpeechInterval[] | undefined> {
  let stderr: string;
  try {
    // -nostats: sem spam de progresso; fullStderr: a saída é PARSEADA linha a linha
    // (o buffer padrão de 8 KB perderia os primeiros silêncios de faixas longas)
    stderr = await runFfmpeg(
      ['-nostats', '-i', file, '-af', 'silencedetect=noise=-70dB:d=1.0', '-f', 'null', '-'],
      'info',
      { fullStderr: true },
    );
  } catch {
    return undefined;
  }
  // silencedetect loga pares silence_start/silence_end; o que sobra é fala
  const silences: SpeechInterval[] = [];
  let open: number | undefined;
  const re = /silence_(start|end):\s*(-?[\d.]+)/g;
  let m: RegExpExecArray | null;
  let sawAny = false;
  while ((m = re.exec(stderr)) !== null) {
    sawAny = true;
    const v = Math.max(0, Number(m[2]));
    if (m[1] === 'start') open = v;
    else {
      silences.push({ start: open ?? 0, end: v });
      open = undefined;
    }
  }
  // não achou nenhuma linha de silêncio E também não conseguimos confirmar que o
  // filtro rodou → na dúvida, considera detecção OK com "faixa inteira é fala"
  if (open !== undefined) silences.push({ start: open, end: durationSec });
  if (!sawAny) {
    // arquivo sem NENHUM silêncio detectado: ou é fala contínua, ou o stderr veio
    // vazio por falha. Se o ffmpeg rodou (stderr tem cabeçalho), é fala contínua.
    if (!stderr.includes('silencedetect')) {
      return stderr.length > 0 ? [{ start: 0, end: durationSec }] : undefined;
    }
    return [{ start: 0, end: durationSec }];
  }

  // inverte silêncio → fala
  const speech: SpeechInterval[] = [];
  let cursor = 0;
  for (const s of silences.sort((a, b) => a.start - b.start)) {
    if (s.start > cursor) speech.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < durationSec) speech.push({ start: cursor, end: durationSec });

  // padding + merge de vizinhos + filtro de micro-ruído
  const padded = speech.map((i) => ({
    start: Math.max(0, i.start - PAD_SEC),
    end: Math.min(durationSec, i.end + PAD_SEC),
  }));
  const merged: SpeechInterval[] = [];
  for (const i of padded) {
    const last = merged[merged.length - 1];
    if (last && i.start - last.end <= MERGE_GAP_SEC) last.end = Math.max(last.end, i.end);
    else merged.push({ ...i });
  }
  return merged.filter((i) => i.end - i.start >= MIN_INTERVAL_SEC);
}

/**
 * Agrupa intervalos de fala em lotes de até `maxBatchSec` segundos de FALA.
 * Cada lote vira um único arquivo compactado (uma chamada de API).
 */
export function batchIntervals(intervals: SpeechInterval[], maxBatchSec: number): SpeechBatch[] {
  const batches: SpeechBatch[] = [];
  let cur: SpeechBatch = { intervals: [], batchStarts: [], durationSec: 0 };
  for (const i of intervals) {
    const dur = i.end - i.start;
    if (
      cur.intervals.length > 0 &&
      (cur.durationSec + dur > maxBatchSec || cur.intervals.length >= MAX_INTERVALS_PER_BATCH)
    ) {
      batches.push(cur);
      cur = { intervals: [], batchStarts: [], durationSec: 0 };
    }
    cur.batchStarts.push(cur.durationSec);
    cur.intervals.push(i);
    cur.durationSec += dur;
  }
  if (cur.intervals.length > 0) batches.push(cur);
  return batches;
}

/**
 * Extrai um lote da faixa master num único MP3 mono 16 kHz, concatenando só os
 * trechos com fala (aselect compacta; asetpts/aresample reescrevem o relógio).
 */
export async function extractBatch(masterFile: string, batch: SpeechBatch, outFile: string): Promise<void> {
  const expr = batch.intervals.map((i) => `between(t,${i.start.toFixed(3)},${i.end.toFixed(3)})`).join('+');
  await runFfmpeg([
    '-i',
    masterFile,
    '-af',
    `aselect='${expr}',asetpts=N/SR/TB,aresample=async=1`,
    '-ac',
    '1',
    '-ar',
    '16000',
    '-b:a',
    '48k',
    '-y',
    outFile,
  ]);
}

/**
 * Converte um instante DENTRO do arquivo compactado de volta para o tempo real
 * da faixa original (segundos → segundos). `isEnd`: um tempo exatamente na
 * emenda entre dois intervalos pertence ao intervalo ANTERIOR quando é um fim
 * de segmento (senão o fim "pularia" o silêncio e inflaria endMs em minutos).
 */
export function mapBatchTimeToTrack(batch: SpeechBatch, batchSec: number, isEnd = false): number {
  let idx = 0;
  for (let i = 0; i < batch.batchStarts.length; i++) {
    if (isEnd ? batch.batchStarts[i] < batchSec : batch.batchStarts[i] <= batchSec) idx = i;
    else break;
  }
  const interval = batch.intervals[idx];
  const offsetInInterval = batchSec - batch.batchStarts[idx];
  // clamp: um timestamp do ASR levemente além do fim do intervalo não pode
  // "vazar" para dentro do silêncio seguinte
  return Math.min(interval.start + Math.max(0, offsetInInterval), interval.end);
}

// ---------- pós-filtro de alucinações ----------

/**
 * Frases que o Whisper alucina em silêncio/ruído (vem do dataset de legendas).
 * Um segmento que é SÓ isso é descartado; se aparecer no meio de fala real,
 * fica (pode ser alguém lendo créditos em voz alta — improvável, mas correto).
 */
const HALLUCINATION_RES: RegExp[] = [
  /^legendas?\s+(pela\s+comunidade\s+)?amara\.org.*$/i,
  // créditos de legendagem: "Legenda Adriana Zanotto", "Legendas por Fulano" —
  // exige cara de NOME PRÓPRIO depois (capitalizado), pra não engolir fala real
  // tipo "legendas prontas pra revisão"
  /^[Ll]egendas?(\s+(por|by))?(\s+[A-ZÀ-Ü][\p{L}.]*){1,4}\.?$/u,
  /^legendado por.{0,40}$/i,
  /^(obrigad[oa] por assistir|thanks? for watching).{0,30}$/i,
  /^(não (se )?esqueça de (se )?inscrever|please subscribe).{0,40}$/i,
  /^(inscreva-se no canal|curta o v[íi]deo).{0,40}$/i,
  /^www\.[\w.-]+$/i,
];

export function isHallucination(text: string): boolean {
  const t = text.trim();
  return HALLUCINATION_RES.some((re) => re.test(t));
}

/**
 * Limpa alucinações de uma lista de segmentos de UMA faixa (mesmo falante):
 *  1. remove frases da blacklist;
 *  2. colapsa repetições consecutivas de textos curtos (loop clássico do
 *     Whisper: o mesmo "E aí" dezenas de vezes em respiração/ruído) — mantém
 *     a primeira ocorrência de cada sequência.
 */
export function filterHallucinations<T extends { text: string }>(segments: T[]): T[] {
  const out: T[] = [];
  let repeatCount = 0;
  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text || isHallucination(text)) continue;
    const prev = out[out.length - 1];
    if (prev && prev.text.trim() === text && text.length <= 30) {
      repeatCount++;
      if (repeatCount >= 1) continue; // segunda repetição idêntica em diante: descarta
    } else {
      repeatCount = 0;
    }
    out.push(seg);
  }
  return out;
}
