import { describe, expect, it } from 'vitest';
import { safeSlice } from '../src/util';
import { localeOf, localizeEvent, recordingOutputMode, t, tCapability } from '../src/i18n';
import { formatDuration, formatOffset, joinNames, sanitizeFilename } from '../src/recorder/RecordingSession';
import {
  buildLlmRequestBody,
  buildMinutesPrompts,
  isOutputLimitReason,
  minutesToMarkdown,
  normalizeMinutes,
} from '../src/processing/minutes';
import { msToClock, transcriptToMarkdown } from '../src/processing/transcribe';

describe('safeSlice', () => {
  it('não corta strings curtas', () => {
    expect(safeSlice('oi', 10)).toBe('oi');
  });
  it('não parte um par surrogate (emoji) no fim', () => {
    const s = 'ab😀'; // 😀 = 2 code units
    const cut = safeSlice(s, 3); // cortaria no meio do emoji
    expect(cut).toBe('ab'); // remove o surrogate solto
    expect(cut.length).toBeLessThanOrEqual(3);
  });
});

describe('i18n', () => {
  it('localeOf reconhece pt e cai em en', () => {
    expect(localeOf('pt-BR')).toBe('pt');
    expect(localeOf('en-US')).toBe('en');
    expect(localeOf(undefined)).toBe('en');
  });
  it('t interpola variáveis e é seguro com "$"', () => {
    expect(t('pt', 'note.added', { offset: '00:10' })).toContain('00:10');
    // nomes com $& não podem corromper a mensagem
    expect(t('pt', 'event.joined', { name: 'a$&b' })).toContain('a$&b');
  });
  it('reapresenta eventos automáticos no idioma da interface sem alterar texto desconhecido', () => {
    expect(localizeEvent('▶️ Recording started by Priya', 'pt')).toBe('▶️ Gravação iniciada por Priya');
    expect(localizeEvent('🔊 Tobias entrou na call', 'en')).toBe('🔊 Tobias joined the call');
    expect(localizeEvent('📌 observação escrita por uma pessoa', 'en')).toBe('📌 observação escrita por uma pessoa');
  });

  it('seleciona copy pelos artefatos realmente habilitados sem prometer prazo ou download ao vivo', () => {
    const recording = { transcription: false, minutes: false };
    const transcript = { transcription: true, minutes: false };
    const minutes = { transcription: true, minutes: true };

    expect(recordingOutputMode(recording)).toBe('recording');
    expect(recordingOutputMode(transcript)).toBe('transcript');
    expect(recordingOutputMode(minutes)).toBe('minutes');
    expect(recordingOutputMode({ transcription: false, minutes: true })).toBe('recording');

    const ptRecording = tCapability('pt', 'record.stopped', recording, { url: 'https://app.test/r' });
    const enTranscript = tCapability('en', 'record.stopped', transcript, { url: 'https://app.test/r' });
    const ptMinutes = tCapability('pt', 'record.stopped', minutes, { url: 'https://app.test/r' });

    expect(ptRecording).not.toContain('transcrição');
    expect(ptRecording).not.toContain('ata');
    expect(enTranscript).toContain('transcript is queued');
    expect(enTranscript).not.toContain('minutes');
    expect(ptMinutes).toContain('ata vem depois');
    for (const copy of [ptRecording, enTranscript, ptMinutes]) {
      expect(copy).not.toMatch(/~1|minuto|minute|durante a call|during the call/i);
    }
  });
});

describe('formatação de tempo', () => {
  it('formatDuration', () => {
    expect(formatDuration(3723000)).toBe('1h 2min 3s');
    expect(formatDuration(65000)).toBe('1min 5s');
    expect(formatDuration(9000)).toBe('9s');
  });
  it('formatOffset e msToClock', () => {
    expect(formatOffset(3723000)).toBe('1:02:03');
    expect(formatOffset(65000)).toBe('01:05');
    expect(msToClock(3723000)).toBe('01:02:03');
  });
});

describe('sanitizeFilename', () => {
  it('remove acentos e caracteres inválidos', () => {
    expect(sanitizeFilename('João da Silva #3!')).toBe('Joao_da_Silva_3');
  });
  it('cai num fallback quando vazio', () => {
    expect(sanitizeFilename('!!!')).toBe('participante');
  });
});

describe('joinNames', () => {
  it('resume com "e mais N"', () => {
    expect(joinNames(['a', 'b', 'c'], 'pt', 2)).toBe('**a**, **b**, e mais 1');
    expect(joinNames(['a'], 'pt', 5)).toBe('**a**');
  });
});

describe('normalizeMinutes (parsing defensivo)', () => {
  it('parseia JSON bem-formado e converte hh:mm:ss em ms', () => {
    const m = normalizeMinutes(
      JSON.stringify({
        resumo: 'r',
        decisoes: ['d1'],
        acoes: [{ tarefa: 't', responsavel: 'Ana', prazo: 'sex' }],
        topicos: [{ titulo: 'T', inicio: '00:12:30' }],
        porParticipante: [{ nome: 'Ana', pontos: ['ponto 1'] }],
      }),
    );
    expect(m.resumo).toBe('r');
    expect(m.acoes[0]).toEqual({ tarefa: 't', responsavel: 'Ana', prazo: 'sex' });
    expect(m.topicos[0].inicioMs).toBe(750000);
    expect(m.porParticipante[0].nome).toBe('Ana');
  });
  it('descarta itens-lixo (null/número/objeto vazio)', () => {
    const m = normalizeMinutes(
      JSON.stringify({
        resumo: 'x',
        decisoes: [{ decisao: 'comprar' }, null, 0, 'real'],
        acoes: [null, 42, { tarefa: 'ok' }],
        topicos: [null, { titulo: 'T2', inicio: '2:00' }],
        porParticipante: [
          { nome: '', pontos: ['x'] },
          { nome: 'Bruno', pontos: [] },
        ],
      }),
    );
    expect(m.decisoes).toEqual(['comprar', 'real']);
    expect(m.acoes).toEqual([{ tarefa: 'ok' }]);
    expect(m.topicos).toHaveLength(1);
    expect(m.porParticipante).toHaveLength(0); // nome vazio e pontos vazios descartados
  });
  it('lança quando não há JSON', () => {
    expect(() => normalizeMinutes('desculpa, não consegui')).toThrow();
  });
  it('gera markdown com as seções', () => {
    const md = minutesToMarkdown({ voiceChannelName: 'Daily', notes: [] } as never, {
      resumo: 'r',
      decisoes: ['d'],
      acoes: [{ tarefa: 't', responsavel: 'Ana' }],
      topicos: [{ titulo: 'T', inicioMs: 90000 }],
      porParticipante: [{ nome: 'Ana', pontos: ['p1'] }],
    });
    expect(md).toContain('## Resumo');
    expect(md).toContain('## Itens de ação');
    expect(md).toContain('## Por participante');
  });
  it('gera headings e labels em inglês sem traduzir o conteúdo da ata', () => {
    const md = minutesToMarkdown({ voiceChannelName: 'Planning', locale: 'en', notes: [] } as never, {
      resumo: 'Preço definido em R$ 49.',
      decisoes: ['Manter o nome Zéfiro.'],
      acoes: [{ tarefa: 'Enviar a proposta.', responsavel: 'João', prazo: 'sexta' }],
      topicos: [{ titulo: 'Orçamento', inicioMs: 90000 }],
      porParticipante: [{ nome: 'João', pontos: ['Aprovou o valor.'] }],
    });
    expect(md).toContain('# Meeting minutes — Planning');
    expect(md).toContain('## Summary');
    expect(md).toContain('## Action items');
    expect(md).toContain('(owner: João • due: sexta)');
    expect(md).toContain('Preço definido em R$ 49.');
    expect(md).toContain('Manter o nome Zéfiro.');
    expect(md).not.toContain('## Resumo');
  });
});

describe('locale das saídas compartilhadas', () => {
  it('monta prompts em inglês sem alterar as chaves públicas do schema', () => {
    const prompts = buildMinutesPrompts({ locale: 'en' });
    expect(prompts.locale).toBe('en');
    expect(prompts.system).toContain('MEETING MINUTES in English');
    expect(prompts.mapSystem).toContain('transcript EXCERPT into English');
    expect(prompts.system).toContain('"resumo"');
    expect(prompts.system).toContain('"porParticipante"');
    expect(prompts.system).toContain('do not translate speech or quoted excerpts');
  });

  it('mantém PT-BR como fallback para gravações antigas sem locale', () => {
    const prompts = buildMinutesPrompts({});
    expect(prompts.locale).toBe('pt');
    expect(prompts.system).toContain('ATA DE REUNIÃO em português do Brasil');
  });

  it('gera transcrição em inglês e mantém falas, nomes e notas intactos', () => {
    const md = transcriptToMarkdown(
      {
        id: 'meeting-1',
        locale: 'en',
        startedAt: Date.UTC(2026, 6, 13, 15, 0, 0),
        voiceChannelName: 'Product room',
        participants: [{ name: 'João' }],
        transcription: { status: 'partial', pendingTracks: ['Lívia'] },
        notes: [{ atMs: 14_000, author: 'João', text: 'Plano de R$ 49 até sexta.' }],
      } as never,
      [{ startMs: 1_000, endMs: 2_000, speaker: 'João', text: 'Vamos manter o nome Zéfiro.' }],
    );
    expect(md).toContain('# Transcript — Product room');
    expect(md).toContain('Recording `meeting-1`');
    expect(md).toContain('**Partial transcript** — tracks not transcribed: Lívia.');
    expect(md).toContain('## Recording notes');
    expect(md).toContain('Vamos manter o nome Zéfiro.');
    expect(md).toContain('Plano de R$ 49 até sexta.');
    expect(md).not.toContain('## Notas da gravação');
  });
});

describe('contrato de saída do LLM', () => {
  const schema = {
    name: 'ata_reuniao',
    schema: {
      type: 'object',
      properties: { resumo: { type: 'string' } },
      required: ['resumo'],
      additionalProperties: false,
    },
  };

  it('usa schema estrito, backend compatível e healing no OpenRouter', () => {
    const body = buildLlmRequestBody(true, 'google/gemini-2.5-flash', 's', 'u', 8192, { schema });
    expect(body).toMatchObject({
      reasoning: { max_tokens: 0 },
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'ata_reuniao', strict: true, schema: schema.schema },
      },
      provider: { require_parameters: true },
      plugins: [{ id: 'response-healing' }],
    });
  });

  it('reserva os tokens para a resposta do /perguntar no Gemini 2.5 Flash', () => {
    const body = buildLlmRequestBody(true, 'google/gemini-2.5-flash', 's', 'u', 700, { json: false });
    expect(body).toMatchObject({ reasoning: { max_tokens: 0 }, max_tokens: 700 });
    expect(body).not.toHaveProperty('response_format');
    expect(body).not.toHaveProperty('plugins');
  });

  it('mantém JSON mode compatível no caminho Groq', () => {
    const body = buildLlmRequestBody(false, 'llama-3.3-70b-versatile', 's', 'u', 4096, { schema });
    expect(body).toMatchObject({ response_format: { type: 'json_object' } });
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('provider');
  });

  it('reconhece motivos de truncamento normalizados e nativos', () => {
    expect(isOutputLimitReason('length')).toBe(true);
    expect(isOutputLimitReason('stop', 'MAX_TOKENS')).toBe(true);
    expect(isOutputLimitReason('stop', 'STOP')).toBe(false);
  });
});
