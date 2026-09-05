import { RecordingMeta, readMinutesBounded, readTranscriptBounded, transcriptReady } from '../store';
import { MAX_MINUTES_BYTES, MAX_NOTES_PER_RECORDING } from '../securityLimits';

/**
 * Busca simples (sem índice) nas gravações ACESSÍVEIS ao usuário — a lista de
 * metas já chega filtrada pelo checkAccess. Suficiente para centenas de
 * gravações de um time pequeno; com milhares, a resposta é um índice em disco.
 */

export interface WebSearchHit {
  metaId: string;
  channelName: string;
  startedAt: number;
  /** Momento do trecho (transcrição/nota); undefined para hits de ata. */
  atMs?: number;
  speaker?: string;
  snippet: string;
  kind: 'transcript' | 'minutes' | 'note';
}

export interface WebSearchLimits {
  maxTranscriptBytesPerMeeting: number;
  maxTranscriptBytesPerRequest: number;
  maxSegmentsPerMeeting: number;
  maxSegmentsPerRequest: number;
  /** Teto por ata, igual ao de todos os outros leitores (MAX_MINUTES_BYTES). */
  maxMinutesBytesPerMeeting: number;
  /** Teto agregado das atas, espelhando o que a transcrição já tinha por request. */
  maxMinutesBytesPerRequest: number;
}

export type WebSearchCoverageReason =
  | 'query_too_short'
  | 'result_limit'
  | 'transcript_hit_limit'
  | 'transcript_bytes_limit'
  | 'transcript_segments_limit'
  | 'minutes_bytes_limit'
  | 'notes_limit'
  | 'source_unavailable'
  | 'partial_transcript';

/** Cobertura somente das reuniões autorizadas fornecidas pelo chamador. */
export interface WebSearchCoverage {
  complete: boolean;
  candidateMeetings: number;
  scannedMeetings: number;
  omittedMeetings: number;
  reasons: WebSearchCoverageReason[];
  transcriptBytesScanned: number;
  transcriptSegmentsScanned: number;
  minutesBytesScanned: number;
}

export interface WebSearchResult {
  hits: WebSearchHit[];
  coverage: WebSearchCoverage;
}

const DEFAULT_WEB_SEARCH_LIMITS: WebSearchLimits = {
  maxTranscriptBytesPerMeeting: 1024 * 1024,
  maxTranscriptBytesPerRequest: 5 * 1024 * 1024,
  maxSegmentsPerMeeting: 5_000,
  maxSegmentsPerRequest: 10_000,
  maxMinutesBytesPerMeeting: MAX_MINUTES_BYTES,
  maxMinutesBytesPerRequest: 5 * 1024 * 1024,
};

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function termsOf(q: string): string[] {
  return [
    ...new Set(
      norm(q)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 2),
    ),
  ];
}

function snippetAround(text: string, term: string, width = 140): string {
  const idx = norm(text).indexOf(term);
  if (idx < 0) return text.slice(0, width);
  const start = Math.max(0, idx - Math.floor(width / 3));
  const cut = text.slice(start, start + width);
  return `${start > 0 ? '…' : ''}${cut}${start + width < text.length ? '…' : ''}`;
}

export function searchRecordings(
  metas: RecordingMeta[],
  query: string,
  limit = 40,
  overrides: Partial<WebSearchLimits> = {},
): WebSearchHit[] {
  return searchRecordingsWithCoverage(metas, query, limit, overrides).hits;
}

export function searchRecordingsWithCoverage(
  metas: RecordingMeta[],
  query: string,
  limit = 40,
  overrides: Partial<WebSearchLimits> = {},
): WebSearchResult {
  const terms = termsOf(query);
  const hits: WebSearchHit[] = [];
  const limits = { ...DEFAULT_WEB_SEARCH_LIMITS, ...overrides };
  const reasons = new Set<WebSearchCoverageReason>();
  let scannedMeetings = 0;
  let transcriptBytesScanned = 0;
  let transcriptSegmentsScanned = 0;
  let minutesBytesScanned = 0;
  const result = (): WebSearchResult => ({
    hits,
    coverage: {
      complete: reasons.size === 0,
      candidateMeetings: metas.length,
      scannedMeetings,
      omittedMeetings: metas.length - scannedMeetings,
      reasons: [...reasons],
      transcriptBytesScanned,
      transcriptSegmentsScanned,
      minutesBytesScanned,
    },
  });
  if (terms.length === 0) {
    reasons.add('query_too_short');
    return result();
  }

  for (const meta of metas) {
    if (hits.length >= limit) {
      reasons.add('result_limit');
      break;
    }
    scannedMeetings++;
    if (meta.transcription?.status === 'partial') reasons.add('partial_transcript');

    // Sem a guarda de status, um lote de 100 reuniões abria e parseava 100 arquivos
    // de ata de forma síncrona no event loop. A página individual já checava isso.
    const minutesRead =
      meta.minutes?.status === 'done' && minutesBytesScanned < limits.maxMinutesBytesPerRequest
        ? readMinutesBounded(
            meta.id,
            // O teto por ata continua o mesmo dos outros leitores: sem isto a busca
            // devolveria trecho de uma ata que a página da gravação se recusa a abrir.
            Math.min(limits.maxMinutesBytesPerMeeting, limits.maxMinutesBytesPerRequest - minutesBytesScanned),
          )
        : { status: 'unavailable' as const };
    if (minutesRead.status === 'ok') minutesBytesScanned += minutesRead.bytes;
    else if (meta.minutes?.status === 'done')
      reasons.add(
        minutesRead.status === 'too_large' || minutesBytesScanned >= limits.maxMinutesBytesPerRequest
          ? 'minutes_bytes_limit'
          : 'source_unavailable',
      );
    const minutes = minutesRead.status === 'ok' ? minutesRead.minutes : undefined;
    if (minutes) {
      const fields = [
        minutes.resumo,
        ...minutes.decisoes,
        ...minutes.acoes.map((a) => [a.tarefa, a.responsavel, a.prazo].filter(Boolean).join(' · ')),
        ...minutes.topicos.map((topic) => topic.titulo),
        ...minutes.porParticipante.map((person) => [person.nome, ...person.pontos].join(' · ')),
      ];
      for (const f of fields) {
        if (!f) continue;
        const nf = norm(f);
        const hit = terms.find((t) => nf.includes(t));
        if (hit) {
          hits.push({
            metaId: meta.id,
            channelName: meta.voiceChannelName,
            startedAt: meta.startedAt,
            snippet: snippetAround(f, hit),
            kind: 'minutes',
          });
          break; // 1 hit de ata por gravação basta (o link leva à página completa)
        }
      }
    }

    if (hits.length >= limit) {
      reasons.add('result_limit');
      break;
    }
    if (meta.notes.length > MAX_NOTES_PER_RECORDING) reasons.add('notes_limit');
    for (const note of meta.notes.slice(0, MAX_NOTES_PER_RECORDING)) {
      const nf = norm(`${note.author} ${note.text}`);
      const hit = terms.find((t) => nf.includes(t));
      if (hit) {
        hits.push({
          metaId: meta.id,
          channelName: meta.voiceChannelName,
          startedAt: meta.startedAt,
          atMs: note.atMs,
          speaker: note.author,
          snippet: snippetAround(note.text, hit),
          kind: 'note',
        });
        if (hits.length >= limit) break;
      }
    }

    if (hits.length >= limit) {
      reasons.add('result_limit');
      break;
    }
    if (!transcriptReady(meta)) continue;
    if (transcriptBytesScanned >= limits.maxTranscriptBytesPerRequest) {
      reasons.add('transcript_bytes_limit');
      continue;
    }
    if (transcriptSegmentsScanned >= limits.maxSegmentsPerRequest) {
      reasons.add('transcript_segments_limit');
      continue;
    }
    const remainingBytes = limits.maxTranscriptBytesPerRequest - transcriptBytesScanned;
    const transcript = readTranscriptBounded(meta.id, Math.min(limits.maxTranscriptBytesPerMeeting, remainingBytes));
    if (transcript.status !== 'ok') {
      reasons.add(transcript.status === 'too_large' ? 'transcript_bytes_limit' : 'source_unavailable');
      continue;
    }
    const remainingSegments = limits.maxSegmentsPerRequest - transcriptSegmentsScanned;
    const segments = transcript.segments.slice(0, Math.min(limits.maxSegmentsPerMeeting, remainingSegments));
    if (segments.length < transcript.segments.length) reasons.add('transcript_segments_limit');
    transcriptBytesScanned += transcript.bytes;
    let perMeta = 0;
    for (const s of segments) {
      if (hits.length >= limit) {
        reasons.add('result_limit');
        break;
      }
      if (perMeta >= 4) {
        reasons.add('transcript_hit_limit');
        break;
      }
      transcriptSegmentsScanned++;
      const nf = norm(`${s.speaker} ${s.text}`);
      const hit = terms.find((t) => nf.includes(t));
      if (hit) {
        hits.push({
          metaId: meta.id,
          channelName: meta.voiceChannelName,
          startedAt: meta.startedAt,
          atMs: s.startMs,
          speaker: s.speaker,
          snippet: snippetAround(s.text, hit),
          kind: 'transcript',
        });
        perMeta++;
      }
    }
  }
  return result();
}
