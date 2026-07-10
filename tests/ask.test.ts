import { describe, expect, it } from 'vitest';
import {
  AskMeetingDocument,
  AskSource,
  authorizeAskMetas,
  buildAskContext,
  renderAskAnswer,
  resolveAskTemporalIntent,
  selectTranscriptEvidence,
} from '../src/ask';
import { MeetingMinutes, RecordingMeta, TranscriptSegment } from '../src/store';

const TZ = 'America/Sao_Paulo';
const NOW = Date.parse('2026-07-10T15:00:00Z'); // 12:00 em São Paulo

function makeMeta(id: string, startedAt: string, overrides: Partial<RecordingMeta> = {}): RecordingMeta {
  return {
    id,
    guildId: 'guild-1',
    guildName: 'Servidor',
    voiceChannelId: `channel-${id}`,
    voiceChannelName: 'Produto',
    startedBy: { id: 'owner', name: 'Mauro' },
    startedAt: Date.parse(startedAt),
    endedAt: Date.parse(startedAt) + 3_600_000,
    status: 'done',
    participants: [],
    presence: [],
    events: [],
    notes: [],
    transcription: { status: 'done' },
    minutes: { status: 'done' },
    ...overrides,
  };
}

function makeMinutes(overrides: Partial<MeetingMinutes> = {}): MeetingMinutes {
  return {
    resumo: 'Reunião de planejamento.',
    decisoes: [],
    acoes: [],
    topicos: [],
    porParticipante: [],
    ...overrides,
  };
}

describe('interpretação temporal do /perguntar', () => {
  it('resolve ontem pelas bordas civis de São Paulo', () => {
    const result = resolveAskTemporalIntent('o que decidimos ontem?', NOW, TZ, 'pt');
    expect(result.label).toBe('ontem');
    expect(result.range?.fromMs).toBe(Date.parse('2026-07-09T03:00:00Z'));
    expect(result.range?.toMs).toBe(Date.parse('2026-07-10T03:00:00Z'));
  });

  it('não confunde a data local perto da meia-noite UTC', () => {
    const nearMidnightUtc = Date.parse('2026-07-10T02:30:00Z'); // 23:30 do dia 9 em São Paulo
    const result = resolveAskTemporalIntent('calls de ontem', nearMidnightUtc, TZ, 'pt');
    expect(result.range?.fromMs).toBe(Date.parse('2026-07-08T03:00:00Z'));
    expect(result.range?.toMs).toBe(Date.parse('2026-07-09T03:00:00Z'));
  });

  it('aceita datas BR/ISO e rejeita uma data civil impossível', () => {
    expect(resolveAskTemporalIntent('ações de 09/07/2026', NOW, TZ, 'pt').label).toBe('2026-07-09');
    expect(resolveAskTemporalIntent('ações de 2026-07-09', NOW, TZ, 'pt').label).toBe('2026-07-09');
    expect(() => resolveAskTemporalIntent('ações de 31/02/2026', NOW, TZ, 'pt')).toThrow('Data inválida');
  });

  it('distingue data da call de prazo e entende intervalos explícitos', () => {
    expect(resolveAskTemporalIntent('quais ações têm prazo 15/07?', NOW, TZ, 'pt').range).toBeUndefined();
    const interval = resolveAskTemporalIntent('decisões entre 01/07/2026 e 05/07/2026', NOW, TZ, 'pt');
    expect(interval.label).toBe('2026-07-01 a 2026-07-05');
    expect(interval.range?.fromMs).toBe(Date.parse('2026-07-01T03:00:00Z'));
    expect(interval.range?.toMs).toBe(Date.parse('2026-07-06T03:00:00Z'));
  });

  it('combina período natural da call com uma data de prazo', () => {
    const intent = resolveAskTemporalIntent('na reunião de ontem, quais ações têm prazo 15/07?', NOW, TZ, 'pt');
    expect(intent.label).toBe('ontem');
    expect(intent.range?.fromMs).toBe(Date.parse('2026-07-09T03:00:00Z'));
    expect(intent.ignoredDateTerms).toEqual([]); // 15/07 continua como termo de prazo

    const result = buildAskContext(
      'na reunião de ontem, quais ações têm prazo 15/07?',
      [
        {
          meta: makeMeta('ontem-prazo', '2026-07-09T12:00:00Z'),
          minutes: makeMinutes({ acoes: [{ tarefa: 'Publicar', prazo: '15/07' }] }),
        },
        {
          meta: makeMeta('hoje-prazo', '2026-07-10T12:00:00Z'),
          minutes: makeMinutes({ acoes: [{ tarefa: 'Não deve entrar', prazo: '15/07' }] }),
        },
      ],
      'pt',
      { nowMs: NOW, timezone: TZ },
    );
    expect(result.context).toContain('id=ontem-prazo');
    expect(result.context).not.toContain('id=hoje-prazo');
  });

  it('separa duas datas na mesma pergunta: data da call e data do prazo', () => {
    const intent = resolveAskTemporalIntent('na call de 09/07, quais ações têm prazo 15/07?', NOW, TZ, 'pt');
    expect(intent.label).toBe('2026-07-09');
    expect(intent.ignoredDateTerms).toEqual(['date07x09']);
  });
});

describe('recuperação híbrida do /perguntar', () => {
  it('cria o conjunto opaco apenas com metas aprovados pela ACL do chamador', () => {
    const allowed = makeMeta('permitida', '2026-07-09T12:00:00Z');
    const denied = makeMeta('negada', '2026-07-09T13:00:00Z');
    const authorized = authorizeAskMetas([allowed, denied], (meta) => meta.id === 'permitida');
    expect(authorized.metas.map((meta) => meta.id)).toEqual(['permitida']);
  });

  it('filtra ontem antes de ranquear e exclui a call de hoje', () => {
    const documents: AskMeetingDocument[] = [
      {
        meta: makeMeta('hoje', '2026-07-10T12:00:00Z'),
        minutes: makeMinutes({ acoes: [{ tarefa: 'Publicar hoje', responsavel: 'Ana' }] }),
      },
      {
        meta: makeMeta('ontem', '2026-07-09T12:00:00Z'),
        minutes: makeMinutes({ acoes: [{ tarefa: 'Revisar política', responsavel: 'Ana', prazo: 'sexta' }] }),
      },
    ];
    const result = buildAskContext('quais foram as ações da Ana ontem?', documents, 'pt', {
      nowMs: NOW,
      timezone: TZ,
    });
    expect(result.candidateMeetings).toBe(1);
    expect(result.context).toContain('id=ontem');
    expect(result.context).toContain('Revisar política');
    expect(result.context).not.toContain('id=hoje');
  });

  it('usa ações, prazos e o bloco por participante como evidência pesquisável', () => {
    const document: AskMeetingDocument = {
      meta: makeMeta('estruturada', '2026-07-09T12:00:00Z'),
      minutes: makeMinutes({
        acoes: [{ tarefa: 'Revisar política de dados', responsavel: 'Ana', prazo: 'sexta-feira' }],
        porParticipante: [{ nome: 'Ana', pontos: ['Propôs a nova política de dados'] }],
      }),
    };
    const result = buildAskContext('ações da Ana sobre política', [document], 'pt', {
      nowMs: NOW,
      timezone: TZ,
    });
    expect(result.context).toContain('Ação: Revisar política de dados; responsável: Ana; prazo: sexta-feira');
    expect(result.context).toContain('Por participante — Ana: Propôs a nova política de dados');
    expect(result.sources.some((source) => source.kind === 'action' && source.label === 'ata')).toBe(true);
    expect(result.sources.some((source) => source.kind === 'participant')).toBe(true);
  });

  it('usa uma data de prazo como termo da ação, não como data da reunião', () => {
    const result = buildAskContext(
      'quais ações têm prazo 15/07/2026?',
      [
        {
          meta: makeMeta('vence-dia-15', '2026-07-09T12:00:00Z'),
          minutes: makeMinutes({ acoes: [{ tarefa: 'Publicar relatório', responsavel: 'Ana', prazo: '15/07' }] }),
        },
        {
          meta: makeMeta('vence-dia-16', '2026-07-09T13:00:00Z'),
          minutes: makeMinutes({ acoes: [{ tarefa: 'Revisar contrato', responsavel: 'Bruno', prazo: '16/07' }] }),
        },
      ],
      'pt',
      { nowMs: NOW, timezone: TZ },
    );
    expect(result.context).toContain('id=vence-dia-15');
    expect(result.context).toContain('prazo: 15/07');
    expect(result.context).not.toContain('id=vence-dia-16');
  });

  it('não perde prazos internos quando a pergunta traz um intervalo de vencimento', () => {
    const result = buildAskContext(
      'ações com prazo entre 01/07/2026 e 05/07/2026',
      [
        {
          meta: makeMeta('limite', '2026-06-30T12:00:00Z'),
          minutes: makeMinutes({ acoes: [{ tarefa: 'Abrir janela', prazo: '01/07' }] }),
        },
        {
          meta: makeMeta('meio', '2026-06-30T13:00:00Z'),
          minutes: makeMinutes({ acoes: [{ tarefa: 'Executar plano', prazo: '03/07' }] }),
        },
      ],
      'pt',
      { nowMs: NOW, timezone: TZ },
    );
    expect(result.context).toContain('prazo: 01/07');
    expect(result.context).toContain('prazo: 03/07');
  });

  it('ranqueia globalmente antes do corte e encontra uma call antiga relevante', () => {
    const documents: AskMeetingDocument[] = Array.from({ length: 14 }, (_, index) => ({
      meta: makeMeta(`recente-${index}`, `2026-07-${String(10 - Math.floor(index / 5)).padStart(2, '0')}T10:00:00Z`),
      minutes: makeMinutes({ resumo: `Rotina operacional ${index}` }),
    }));
    documents.push({
      meta: makeMeta('relevante-antiga', '2026-06-20T10:00:00Z'),
      minutes: makeMinutes({ decisoes: ['Projeto Zéfiro foi aprovado para lançamento'] }),
    });
    const result = buildAskContext('o que decidimos sobre o projeto Zéfiro?', documents, 'pt', {
      nowMs: NOW,
      timezone: TZ,
    });
    expect(result.candidateMeetings).toBe(15);
    expect(result.context).toContain('id=relevante-antiga');
    expect(result.context).toContain('Projeto Zéfiro foi aprovado');
    expect(result.meetingsUsed).toBe(1);
  });

  it('não trata sigla curta como pedaço de outra palavra', () => {
    const result = buildAskContext(
      'IA',
      [
        {
          meta: makeMeta('irrelevante', '2026-07-09T13:00:00Z'),
          minutes: makeMinutes({ resumo: 'Reunião geral de operações.' }),
        },
        {
          meta: makeMeta('ia', '2026-07-09T12:00:00Z'),
          minutes: makeMinutes({ resumo: 'IA generativa aplicada ao produto.' }),
        },
      ],
      'pt',
      { nowMs: NOW, timezone: TZ },
    );
    expect(result.context).toContain('id=ia');
    expect(result.context).not.toContain('id=irrelevante');
  });

  it('respeita o orçamento e sinaliza transcrição parcial', () => {
    const transcript: TranscriptSegment[] = Array.from({ length: 80 }, (_, index) => ({
      startMs: index * 10_000,
      endMs: index * 10_000 + 5_000,
      speaker: 'Ana',
      text: `alfa ${'conteúdo '.repeat(40)} ${index}`,
    }));
    const result = buildAskContext(
      'alfa',
      [
        {
          meta: makeMeta('parcial', '2026-07-09T12:00:00Z', {
            transcription: { status: 'partial', pendingTracks: ['Bruno.flac'] },
          }),
          transcript,
        },
      ],
      'pt',
      { nowMs: NOW, timezone: TZ, maxContextChars: 900 },
    );
    expect(result.context.length).toBeLessThanOrEqual(900);
    expect(result.context).toContain('transcrição=PARCIAL');
    expect(result.sources).toHaveLength(result.chunksUsed);
  });

  it('ainda funciona quando a ata falhou, usando amostra distribuída da transcrição', () => {
    const transcript: TranscriptSegment[] = Array.from({ length: 20 }, (_, index) => ({
      startMs: index * 60_000,
      endMs: index * 60_000 + 10_000,
      speaker: index % 2 ? 'Ana' : 'Bruno',
      text: `Trecho número ${index} do planejamento`,
    }));
    const result = buildAskContext(
      'o que houve?',
      [{ meta: makeMeta('sem-ata', '2026-07-09T12:00:00Z', { minutes: { status: 'error' } }), transcript }],
      'pt',
      { nowMs: NOW, timezone: TZ },
    );
    expect(result.context).toContain('id=sem-ata');
    expect(result.chunksUsed).toBe(6);
    expect(result.sources.every((source) => source.kind === 'transcript')).toBe(true);
  });

  it('consulta a fala quando a pergunta é ampla e a ata omitiu a decisão', () => {
    const result = buildAskContext(
      'o que decidimos ontem?',
      [
        {
          meta: makeMeta('ata-incompleta', '2026-07-09T12:00:00Z'),
          minutes: makeMinutes({ resumo: 'Conversa de produto.', decisoes: [] }),
          transcript: [
            { startMs: 1_000, endMs: 2_000, speaker: 'Ana', text: 'Abertura.' },
            { startMs: 50_000, endMs: 55_000, speaker: 'Bruno', text: 'Vamos lançar na sexta; está decidido.' },
          ],
        },
      ],
      'pt',
      { nowMs: NOW, timezone: TZ },
    );
    expect(result.context).toContain('Conversa de produto');
    expect(result.context).toContain('Vamos lançar na sexta; está decidido');
  });
});

describe('citações determinísticas do /perguntar', () => {
  const sources: AskSource[] = [
    {
      id: 'S001',
      kind: 'action',
      meetingId: 'abc',
      label: 'ata',
      link: 'https://kassinao.example/app/rec/abc#ata',
    },
    {
      id: 'S002',
      kind: 'transcript',
      meetingId: 'abc',
      label: '00:03:20',
      link: 'https://kassinao.example/app/rec/abc#t=200',
    },
  ];

  it('só transforma IDs recuperados em links construídos pelo servidor', () => {
    const rendered = renderAskAnswer(
      'Ação confirmada [S001] e fala [S002]. Inventada [S999]. [clique](https://evil.tld) https://evil.tld/x ftp://evil.tld @everyone',
      sources,
    );
    expect(rendered).toContain('[ata](https://kassinao.example/app/rec/abc#ata)');
    expect(rendered).toContain('[00:03:20](https://kassinao.example/app/rec/abc#t=200)');
    expect(rendered).not.toContain('S999');
    expect(rendered).not.toContain('evil.tld');
    expect(rendered).not.toContain('@everyone');
  });

  it('não corta um link do servidor pela metade no limite de tamanho', () => {
    const rendered = renderAskAnswer(`${'x'.repeat(35)} [S001]`, sources, 40);
    expect(rendered.length).toBeLessThanOrEqual(40);
    expect(rendered).not.toContain('https://');
  });
});

describe('pré-seleção incremental da transcrição', () => {
  const transcript: TranscriptSegment[] = Array.from({ length: 100 }, (_, index) => ({
    startMs: index * 1_000,
    endMs: index * 1_000 + 500,
    speaker: 'Ana',
    text: index >= 90 ? `Projeto Zéfiro relevante ${index}` : `Conversa genérica ${index}`,
  }));

  it('retém no máximo seis matches relevantes sem guardar a call inteira', () => {
    const selected = selectTranscriptEvidence('o que houve com Zéfiro?', transcript, []);
    expect(selected).toHaveLength(6);
    expect(selected.every((segment) => segment.text.includes('Zéfiro'))).toBe(true);
  });

  it('amostra começo, meio e fim quando não há termo lexical', () => {
    const selected = selectTranscriptEvidence('o que decidimos ontem?', transcript, []);
    expect(selected).toHaveLength(6);
    expect(selected[0].startMs).toBe(0);
    expect(selected.at(-1)?.startMs).toBe(99_000);
  });
});
