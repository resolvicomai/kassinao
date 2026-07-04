import { config } from '../config';
import {
  MeetingMinutes,
  MinutesAction,
  MinutesPerson,
  MinutesTopic,
  RecordingMeta,
  TranscriptSegment,
} from '../store';
import { msToClock } from './transcribe';

/** Teto de texto enviado ao LLM (~15k tokens). Calls muito longas são cortadas no meio. */
const MAX_TRANSCRIPT_CHARS = 60000;

/** A Ata liga sozinha quando há GROQ_API_KEY (roda o LLM na Groq), salvo MINUTES_ENABLED=false. */
export function minutesEnabled(): boolean {
  if (config.minutesEnabled === 'false') return false;
  if (!config.groqApiKey) return false;
  return config.minutesEnabled === 'true' || config.minutesEnabled === 'auto';
}

/** Gera a ata a partir da transcrição via LLM da Groq. Lança em caso de falha. */
export async function generateMinutes(meta: RecordingMeta, segments: TranscriptSegment[]): Promise<MeetingMinutes> {
  const transcriptText = buildTranscriptText(meta, segments);

  const system = [
    'Você é um assistente que gera ATA DE REUNIÃO em português do Brasil a partir de uma transcrição',
    'que já vem com o NOME de quem falou e o horário [hh:mm:ss]. Responda SOMENTE um objeto JSON válido,',
    'sem markdown e sem texto fora do JSON, com exatamente estas chaves:',
    '- "resumo": string — parágrafo objetivo do que foi tratado (3 a 6 frases).',
    '- "decisoes": array de strings — decisões tomadas (array vazio se não houve).',
    '- "acoes": array de objetos {"tarefa": string, "responsavel": string, "prazo": string} — próximos passos/tarefas.',
    '  Use "" quando não souber o responsável ou o prazo. NUNCA invente responsáveis ou prazos.',
    '- "topicos": array de {"titulo": string, "inicio": "hh:mm:ss"} — principais tópicos na ordem em que',
    '  apareceram, com o horário aproximado de início (use os horários que estão na transcrição).',
    '- "porParticipante": array de {"nome": string, "pontos": [string]} — para CADA pessoa que falou, os',
    '  principais pontos que ELA levantou e com o que se comprometeu. Use exatamente os nomes que aparecem',
    '  na transcrição. Não inclua quem não falou.',
    'Baseie-se APENAS no que está na transcrição. Não invente fatos, nomes ou números. Seja conciso e claro.',
  ].join('\n');

  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.groqApiKey}` },
    body: JSON.stringify({
      model: config.minutesModel,
      temperature: 0.2,
      max_tokens: config.minutesMaxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: transcriptText },
      ],
    }),
  });

  if (!resp.ok) {
    throw new Error(`Groq LLM HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  const data = (await resp.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
  };
  const choice = data.choices?.[0];
  // resposta cortada por limite de tokens = JSON truncado; erro claro em vez de parse quebrado
  if (choice?.finish_reason === 'length') {
    throw new Error('LLM cortou a ata por limite de tokens — aumente MINUTES_MAX_TOKENS (call muito longa?)');
  }
  const content = choice?.message?.content ?? '';
  if (!content.trim()) throw new Error('LLM devolveu resposta vazia');
  return normalizeMinutes(content);
}

function buildTranscriptText(meta: RecordingMeta, segments: TranscriptSegment[]): string {
  const header = [
    `Reunião no canal: ${meta.voiceChannelName}`,
    `Participantes: ${meta.participants.map((p) => p.name).join(', ') || '—'}`,
    meta.notes.length > 0
      ? `Notas marcadas: ${meta.notes.map((n) => `[${msToClock(n.atMs)}] ${n.author}: ${n.text}`).join(' | ')}`
      : '',
    '',
    'TRANSCRIÇÃO:',
  ]
    .filter(Boolean)
    .join('\n');

  const body = segments.map((s) => `[${msToClock(s.startMs)}] ${s.speaker}: ${s.text}`).join('\n');

  let full = `${header}\n${body}`;
  if (full.length > MAX_TRANSCRIPT_CHARS) {
    // mantém começo e fim, corta o miolo (o mais provável de ser redundante)
    const half = Math.floor(MAX_TRANSCRIPT_CHARS / 2);
    full = `${full.slice(0, half)}\n\n[... trecho do meio omitido por tamanho ...]\n\n${full.slice(-half)}`;
  }
  return full;
}

/** Parse defensivo: o modelo pode variar chaves/tipos; coage tudo para o formato esperado. */
export function normalizeMinutes(raw: string): MeetingMinutes {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('LLM não devolveu JSON válido');
    obj = JSON.parse(m[0]) as Record<string, unknown>;
  }

  const resumo = typeof obj.resumo === 'string' ? obj.resumo.trim() : '';

  const decisoes = Array.isArray(obj.decisoes)
    ? obj.decisoes
        .map((d) => {
          if (typeof d === 'string') return d.trim();
          if (d && typeof d === 'object') {
            const o = d as Record<string, unknown>;
            return String(o.decisao ?? o.decision ?? o.texto ?? o.text ?? '').trim();
          }
          return ''; // número/null/bool viram vazio e são filtrados (nada de "null"/"[object Object]")
        })
        .filter(Boolean)
    : [];

  const acoes: MinutesAction[] = Array.isArray(obj.acoes)
    ? obj.acoes
        .map((a): MinutesAction | null => {
          if (a && typeof a === 'object') {
            const o = a as Record<string, unknown>;
            const tarefa = String(o.tarefa ?? o.task ?? '').trim();
            if (!tarefa) return null;
            return {
              tarefa,
              responsavel: String(o.responsavel ?? o.responsável ?? o.owner ?? '').trim() || undefined,
              prazo: String(o.prazo ?? o.deadline ?? o.due ?? '').trim() || undefined,
            };
          }
          if (typeof a !== 'string') return null; // descarta null/número/bool (sem "null" fantasma)
          const s = a.trim();
          return s ? { tarefa: s } : null;
        })
        .filter((a): a is MinutesAction => a !== null)
    : [];

  const topicos: MinutesTopic[] = Array.isArray(obj.topicos)
    ? obj.topicos
        .map((tp): MinutesTopic | null => {
          if (tp && typeof tp === 'object') {
            const o = tp as Record<string, unknown>;
            const titulo = String(o.titulo ?? o.title ?? o.topico ?? '').trim();
            if (!titulo) return null;
            return { titulo, inicioMs: clockToMs(String(o.inicio ?? o.inicioMs ?? o.start ?? '0')) };
          }
          if (typeof tp !== 'string') return null; // descarta null/número/bool
          const s = tp.trim();
          return s ? { titulo: s, inicioMs: 0 } : null;
        })
        .filter((t): t is MinutesTopic => t !== null)
    : [];

  const porParticipante: MinutesPerson[] = Array.isArray(obj.porParticipante)
    ? obj.porParticipante
        .map((pp): MinutesPerson | null => {
          if (!pp || typeof pp !== 'object') return null;
          const o = pp as Record<string, unknown>;
          const nome = String(o.nome ?? o.name ?? o.participante ?? '').trim();
          if (!nome) return null;
          const pontos = Array.isArray(o.pontos ?? o.points)
            ? ((o.pontos ?? o.points) as unknown[]).map((x) => String(x).trim()).filter(Boolean)
            : [];
          if (pontos.length === 0) return null;
          return { nome, pontos };
        })
        .filter((p): p is MinutesPerson => p !== null)
    : [];

  return { resumo, decisoes, acoes, topicos, porParticipante };
}

/** "hh:mm:ss" ou "mm:ss" ou número (ms/s) → milissegundos. */
function clockToMs(v: string): number {
  const s = v.trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 100000 ? n : n * 1000; // heurística: número grande já é ms, pequeno é segundos
  }
  const parts = s.split(':').map((p) => Number(p.replace(/[^\d]/g, '')) || 0);
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return sec * 1000;
}

/** Ata em Markdown (para o .txt/.md e o info). */
export function minutesToMarkdown(meta: RecordingMeta, m: MeetingMinutes): string {
  const lines = [`# Ata — ${meta.voiceChannelName}`, ''];
  if (m.resumo) lines.push('## Resumo', '', m.resumo, '');
  if (m.decisoes.length) {
    lines.push('## Decisões', '');
    for (const d of m.decisoes) lines.push(`- ${d}`);
    lines.push('');
  }
  if (m.acoes.length) {
    lines.push('## Itens de ação', '');
    for (const a of m.acoes) {
      const extra = [a.responsavel && `resp.: ${a.responsavel}`, a.prazo && `prazo: ${a.prazo}`]
        .filter(Boolean)
        .join(' • ');
      lines.push(`- [ ] ${a.tarefa}${extra ? ` (${extra})` : ''}`);
    }
    lines.push('');
  }
  if (m.topicos.length) {
    lines.push('## Tópicos', '');
    for (const tp of m.topicos) lines.push(`- \`${msToClock(tp.inicioMs)}\` ${tp.titulo}`);
    lines.push('');
  }
  if (m.porParticipante?.length) {
    lines.push('## Por participante', '');
    for (const pp of m.porParticipante) {
      lines.push(`### ${pp.nome}`);
      for (const pt of pp.pontos) lines.push(`- ${pt}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}
