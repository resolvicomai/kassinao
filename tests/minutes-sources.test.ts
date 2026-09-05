import { afterEach, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { generateMinutes } from '../src/processing/minutes';
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
