import { config } from '../config';
import { cleanInline, cleanText, fenceUntrusted, neutralizeFences, UNTRUSTED_GUARD } from '../sanitize';
import { MeetingMinutes, MinutesAction, MinutesPerson, MinutesTopic, RecordingMeta, TranscriptSegment } from '../store';
import { fetchWithRetry } from './http';
import { msToClock } from './transcribe';

/**
 * Teto de texto enviado ao LLM por provider. OpenRouter (Gemini 2.5 Flash tem
 * 1M de contexto): cabe qualquer call de 6h inteira. Groq free tier: o limite
 * real é 12k TOKENS POR MINUTO (input+output contam juntos) — texto em pt rende
 * ~2,3 chars/token, então o input precisa ficar bem abaixo disso; acima do teto
 * a ata roda em MAP-REDUCE (resumos parciais → ata final) com pausa entre chamadas.
 */
const MAX_CHARS_OPENROUTER = 400_000;
/**
 * Groq free: o pre-check de TPM conta input + max_tokens JUNTOS. 12k chars ≈ 5,2k
 * tokens de input + 4k de saída ≈ 9,2k < 12k TPM. Acima disso vai de map-reduce.
 */
const MAX_CHARS_GROQ_SINGLE = 12_000;
/** Teto de tokens de SAÍDA no caminho Groq (input+output contam juntos no TPM). */
const GROQ_MAX_TOKENS = 4096;
/** Tamanho de cada bloco no map-reduce (Groq). */
const GROQ_BLOCK_CHARS = 14_000;
/** Pausa entre chamadas no map-reduce — deixa o TPM da Groq reabastecer. */
const GROQ_BLOCK_PAUSE_MS = 65_000;
/** Teto de cada nota parcial e do agregado no passo reduce (senão o reduce estoura o TPM). */
const PARTIAL_NOTE_CHARS = 280;
const PARTIAL_TOTAL_CHARS = 9_000;

/** A Ata liga sozinha quando há chave do provider escolhido, salvo MINUTES_ENABLED=false. */
export function minutesEnabled(): boolean {
  if (config.minutesEnabled === 'false') return false;
  const key = config.minutesProvider === 'openrouter' ? config.openrouterApiKey : config.groqApiKey;
  if (!key) return false;
  return config.minutesEnabled === 'true' || config.minutesEnabled === 'auto';
}

/** Chamada de chat ao provider da ata (OpenRouter ou Groq), com retry ciente de 429. */
async function llmChat(system: string, user: string, maxTokens: number): Promise<string> {
  const openrouter = config.minutesProvider === 'openrouter';
  const url = openrouter
    ? 'https://openrouter.ai/api/v1/chat/completions'
    : 'https://api.groq.com/openai/v1/chat/completions';
  const key = openrouter ? config.openrouterApiKey : config.groqApiKey;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
  };
  if (openrouter) {
    headers['HTTP-Referer'] = config.baseUrl;
    headers['X-Title'] = 'Kassinao';
  }
  const resp = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.minutesModel,
        temperature: 0.2,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    },
    { attempts: 4, maxWaitMs: 90_000 },
  );
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
  return content;
}

/** Gera a ata a partir da transcrição via LLM (OpenRouter ou Groq). Lança em caso de falha. */
export async function generateMinutes(meta: RecordingMeta, segments: TranscriptSegment[]): Promise<MeetingMinutes> {
  const system = [
    UNTRUSTED_GUARD,
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

  const { header, body } = buildTranscriptParts(meta, segments);
  const openrouter = config.minutesProvider === 'openrouter';
  const maxSingle = openrouter ? MAX_CHARS_OPENROUTER : MAX_CHARS_GROQ_SINGLE;
  const outTokens = openrouter ? config.minutesMaxTokens : Math.min(config.minutesMaxTokens, GROQ_MAX_TOKENS);

  if (header.length + body.length <= maxSingle) {
    return normalizeMinutes(await llmChat(system, fenceUntrusted(`${header}\n${body}`), outTokens));
  }

  if (openrouter) {
    // acima de 400k chars (call absurda): corta o miolo — começo e fim carregam decisões
    const half = Math.floor(MAX_CHARS_OPENROUTER / 2);
    const cut = `${body.slice(0, half)}\n\n[... trecho do meio omitido por tamanho ...]\n\n${body.slice(-half)}`;
    return normalizeMinutes(await llmChat(system, fenceUntrusted(`${header}\n${cut}`), outTokens));
  }

  // ---- map-reduce (Groq free tier, TPM 12k): blocos → notas parciais → ata final ----
  // Teto de blocos: call gigante não pode segurar a fila serial por 1h de pausas.
  // Acima do teto, mantém começo e fim (decisões vivem nas pontas) e pula o miolo.
  const MAX_BLOCKS = 12;
  const blocks: string[] = [];
  for (let i = 0; i < body.length; i += GROQ_BLOCK_CHARS) blocks.push(body.slice(i, i + GROQ_BLOCK_CHARS));
  if (blocks.length > MAX_BLOCKS) {
    const head = blocks.slice(0, MAX_BLOCKS / 2);
    const tail = blocks.slice(-MAX_BLOCKS / 2);
    blocks.length = 0;
    blocks.push(...head, ...tail);
  }

  const mapSystem = [
    UNTRUSTED_GUARD,
    'Você resume um TRECHO de transcrição de reunião em português do Brasil (nomes e horários [hh:mm:ss] inclusos).',
    'Responda SOMENTE JSON: {"notas": [string]} — fatos, decisões, tarefas (com responsável/prazo se ditos)',
    'e tópicos com o horário em que apareceram. Máximo 12 notas, específicas e com nomes. Não invente nada.',
  ].join('\n');

  const partials: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const content = await llmChat(
      mapSystem,
      fenceUntrusted(`${header}\n[BLOCO ${i + 1}/${blocks.length}]\n${blocks[i]}`),
      1024,
    );
    try {
      const parsed = JSON.parse(content) as { notas?: unknown[] };
      const notas = Array.isArray(parsed.notas) ? parsed.notas.map((n) => String(n)) : [content];
      partials.push(...notas.map((n) => `[bloco ${i + 1}] ${n.slice(0, PARTIAL_NOTE_CHARS)}`));
    } catch {
      partials.push(`[bloco ${i + 1}] ${content.slice(0, 1500)}`);
    }
    if (i < blocks.length - 1) await new Promise((r) => setTimeout(r, GROQ_BLOCK_PAUSE_MS));
  }

  // reduce com teto: notas demais estourariam o mesmo TPM que o map-reduce contorna
  let joined = partials.map((p) => `- ${p}`).join('\n');
  if (joined.length > PARTIAL_TOTAL_CHARS) {
    joined = `${joined.slice(0, PARTIAL_TOTAL_CHARS)}\n[... notas excedentes omitidas por tamanho ...]`;
  }
  await new Promise((r) => setTimeout(r, GROQ_BLOCK_PAUSE_MS));
  const reduceUser = fenceUntrusted(
    `${header}\nNOTAS PARCIAIS (extraídas em ordem cronológica da transcrição completa):\n${joined}`,
  );
  return normalizeMinutes(await llmChat(system, reduceUser, outTokens));
}

function buildTranscriptParts(meta: RecordingMeta, segments: TranscriptSegment[]): { header: string; body: string } {
  const header = [
    `Reunião no canal: ${cleanInline(meta.voiceChannelName)}`,
    `Participantes: ${meta.participants.map((p) => cleanInline(p.name)).join(', ') || '—'}`,
    meta.notes.length > 0
      ? `Notas marcadas: ${meta.notes.map((n) => `[${msToClock(n.atMs)}] ${cleanInline(n.author)}: ${cleanInline(n.text)}`).join(' | ')}`
      : '',
    '',
    'TRANSCRIÇÃO:',
  ]
    .filter(Boolean)
    .join('\n');

  const body = segments
    .map((s) => `[${msToClock(s.startMs)}] ${cleanInline(s.speaker)}: ${cleanText(s.text)}`)
    .join('\n');

  return { header, body };
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
  // A ata vem do LLM, mas o LLM leu transcrição adversarial; limpamos na saída também.
  const lines = [`# Ata — ${cleanInline(meta.voiceChannelName)}`, ''];
  if (m.resumo) lines.push('## Resumo', '', neutralizeFences(cleanText(m.resumo)), '');
  if (m.decisoes.length) {
    lines.push('## Decisões', '');
    for (const d of m.decisoes) lines.push(`- ${neutralizeFences(cleanInline(d))}`);
    lines.push('');
  }
  if (m.acoes.length) {
    lines.push('## Itens de ação', '');
    for (const a of m.acoes) {
      const extra = [
        a.responsavel && `resp.: ${cleanInline(a.responsavel)}`,
        a.prazo && `prazo: ${cleanInline(a.prazo)}`,
      ]
        .filter(Boolean)
        .join(' • ');
      lines.push(`- [ ] ${neutralizeFences(cleanInline(a.tarefa))}${extra ? ` (${extra})` : ''}`);
    }
    lines.push('');
  }
  if (m.topicos.length) {
    lines.push('## Tópicos', '');
    for (const tp of m.topicos)
      lines.push(`- \`${msToClock(tp.inicioMs)}\` ${neutralizeFences(cleanInline(tp.titulo))}`);
    lines.push('');
  }
  if (m.porParticipante?.length) {
    lines.push('## Por participante', '');
    for (const pp of m.porParticipante) {
      lines.push(`### ${cleanInline(pp.nome)}`);
      for (const pt of pp.pontos) lines.push(`- ${neutralizeFences(cleanInline(pt))}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}
