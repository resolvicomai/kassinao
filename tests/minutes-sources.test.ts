import { afterEach, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { generateMinutes, normalizeMinutes, verifiedMinutesSource } from '../src/processing/minutes';
import type { RecordingMeta } from '../src/store';

const provider = config.minutesProvider;
afterEach(() => {
  config.minutesProvider = provider;
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('preserva fonte literal conferida no map-reduce de reunião longa', async () => {
  vi.useFakeTimers();
  config.minutesProvider = 'groq';
  const source = { startMs: 0, endMs: 1000, quote: 'Vou revisar a proposta amanhã.' };
  let reduceInput = '';
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const map = request.messages[0].content.includes('TRECHO');
    if (!map) reduceInput = request.messages[1].content;
    const content = map
      ? { notas: ['Revisão da proposta.'], fontes: [source] }
      : {
          resumo: 'Revisar proposta.',
          decisoes: ['Revisar'],
          decisionSources: [source],
          acoes: [{ tarefa: 'Revisar', responsavel: 'Ana', prazo: 'amanhã', source }],
          topicos: [],
          porParticipante: [],
        };
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }] }),
      { status: 200 },
    );
  });
  const meta: RecordingMeta = {
    id: 'long-minutes',
    guildId: '1',
    guildName: 'Teste',
    voiceChannelId: '2',
    voiceChannelName: 'Teste',
    startedBy: null,
    startedAt: Date.now(),
    status: 'done',
    participants: [],
    notes: [],
    events: [],
    locale: 'pt',
  };
  const task = generateMinutes(meta, [{ ...source, speaker: 'Ana', text: source.quote + ' contexto'.repeat(2000) }]);
  await vi.runAllTimersAsync();
  const minutes = await task;
  expect(reduceInput).toContain('SOURCE');
  expect(reduceInput).toContain(source.quote);
  expect(minutes.acoes[0].source).toEqual(source);
});

it('só publica a fonte quando trecho e limites conferem com uma fala original', () => {
  const segments = [{ startMs: 1200, endMs: 5400, speaker: 'Ana', text: 'Vou revisar a proposta amanhã.' }];
  const source = { startMs: 1200, endMs: 5400, quote: 'revisar a proposta amanhã' };
  expect(verifiedMinutesSource(source, segments)).toEqual(source);
  expect(verifiedMinutesSource({ ...source, startMs: 1000 }, segments)).toBeUndefined();
  expect(verifiedMinutesSource({ ...source, quote: 'Já publiquei em produção' }, segments)).toBeUndefined();
  const raw = JSON.stringify({
    resumo: 'Proposta',
    decisoes: ['', 'Revisar'],
    decisionSources: [null, source],
    acoes: [{ tarefa: 'Revisar', source }],
  });
  const checked = normalizeMinutes(raw, segments);
  expect(checked.decisionSources).toEqual([source]);
  expect(checked.acoes[0].source).toEqual(source);
  expect(normalizeMinutes(raw).acoes[0].source).toBeUndefined();
});
