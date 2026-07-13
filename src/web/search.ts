import { RecordingMeta, readMinutes, readTranscriptForSearch, transcriptReady } from '../store';
import { MAX_NOTES_PER_RECORDING } from '../securityLimits';

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
}

export const DEFAULT_WEB_SEARCH_LIMITS: WebSearchLimits = {
  maxTranscriptBytesPerMeeting: 1024 * 1024,
  maxTranscriptBytesPerRequest: 5 * 1024 * 1024,
  maxSegmentsPerMeeting: 5_000,
  maxSegmentsPerRequest: 10_000,
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
  const terms = termsOf(query);
  if (terms.length === 0) return [];
  const hits: WebSearchHit[] = [];
  const limits = { ...DEFAULT_WEB_SEARCH_LIMITS, ...overrides };
  let transcriptBytesScanned = 0;
  let transcriptSegmentsScanned = 0;

  for (const meta of metas) {
    if (hits.length >= limit) break;

    const minutes = readMinutes(meta.id);
    if (minutes) {
      const fields = [minutes.resumo, ...minutes.decisoes, ...minutes.acoes.map((a) => a.tarefa)];
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

    if (hits.length >= limit) break;
    for (const note of meta.notes.slice(0, MAX_NOTES_PER_RECORDING)) {
      const nf = norm(note.text);
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

    if (
      hits.length >= limit ||
      !transcriptReady(meta) ||
      transcriptBytesScanned >= limits.maxTranscriptBytesPerRequest ||
      transcriptSegmentsScanned >= limits.maxSegmentsPerRequest
    )
      continue;
    const remainingBytes = limits.maxTranscriptBytesPerRequest - transcriptBytesScanned;
    const transcript = readTranscriptForSearch(meta.id, Math.min(limits.maxTranscriptBytesPerMeeting, remainingBytes));
    if (!transcript) continue;
    const remainingSegments = limits.maxSegmentsPerRequest - transcriptSegmentsScanned;
    const segments = transcript.segments.slice(0, Math.min(limits.maxSegmentsPerMeeting, remainingSegments));
    transcriptBytesScanned += transcript.bytes;
    transcriptSegmentsScanned += segments.length;
    let perMeta = 0;
    for (const s of segments) {
      if (perMeta >= 4 || hits.length >= limit) break; // no máx. 4 trechos por gravação
      const nf = norm(s.text);
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
  return hits;
}
