import { RecordingMeta, readMinutes, readTranscript, transcriptReady } from '../store';

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

export function searchRecordings(metas: RecordingMeta[], query: string, limit = 40): WebSearchHit[] {
  const terms = termsOf(query);
  if (terms.length === 0) return [];
  const hits: WebSearchHit[] = [];

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

    for (const note of meta.notes) {
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

    if (!transcriptReady(meta)) continue;
    const segments = readTranscript(meta.id) ?? [];
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
