import { describe, expect, it, vi } from 'vitest';
import { fetchWithRetry, parseRetryAfterMs } from '../src/processing/http';
import {
  batchIntervals,
  filterHallucinations,
  isHallucination,
  mapBatchTimeToTrack,
  SpeechBatch,
} from '../src/processing/vad';

describe('parseRetryAfterMs', () => {
  it('nunca incorpora o corpo remoto em erro ou log local', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('prompt privado sk-secret', { status: 400 })),
    );
    try {
      const result = fetchWithRetry('https://provider.invalid', {}, { attempts: 1 });
      await expect(result).rejects.toThrow('upstream HTTP 400');
      await expect(result).rejects.not.toThrow(/prompt privado|sk-secret/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('lê o header Retry-After em segundos', () => {
    expect(parseRetryAfterMs(new Headers({ 'retry-after': '30' }), '')).toBe(30_000);
  });
  it('lê o "try again in 8m25s" do corpo da Groq', () => {
    const body = '{"error":{"message":"Rate limit reached ... Please try again in 8m25s. Need more tokens?"}}';
    expect(parseRetryAfterMs(new Headers(), body)).toBe((8 * 60 + 25) * 1000);
  });
  it('lê segundos fracionários ("in 8.5s")', () => {
    expect(parseRetryAfterMs(new Headers(), 'try again in 8.5s')).toBe(8500);
  });
  it('retorna 0 quando não há dica', () => {
    expect(parseRetryAfterMs(new Headers(), 'sem dica')).toBe(0);
  });
});

describe('batchIntervals', () => {
  it('agrupa intervalos até o teto de segundos de fala', () => {
    const intervals = [
      { start: 0, end: 600 },
      { start: 700, end: 1300 },
      { start: 1400, end: 1500 },
    ];
    const batches = batchIntervals(intervals, 1200);
    expect(batches).toHaveLength(2);
    expect(batches[0].intervals).toHaveLength(2);
    expect(batches[0].durationSec).toBe(1200);
    expect(batches[1].intervals).toHaveLength(1);
  });
  it('registra a posição de cada intervalo dentro do lote', () => {
    const [b] = batchIntervals(
      [
        { start: 10, end: 20 },
        { start: 100, end: 130 },
      ],
      1200,
    );
    expect(b.batchStarts).toEqual([0, 10]);
    expect(b.durationSec).toBe(40);
  });
  it('lote vazio quando não há intervalos', () => {
    expect(batchIntervals([], 1200)).toHaveLength(0);
  });
});

describe('mapBatchTimeToTrack', () => {
  const batch: SpeechBatch = {
    intervals: [
      { start: 10, end: 20 },
      { start: 100, end: 130 },
    ],
    batchStarts: [0, 10],
    durationSec: 40,
  };
  it('mapeia tempo do áudio compactado de volta pra faixa original', () => {
    expect(mapBatchTimeToTrack(batch, 0)).toBe(10); // início do 1º intervalo
    expect(mapBatchTimeToTrack(batch, 5)).toBe(15); // meio do 1º
    expect(mapBatchTimeToTrack(batch, 10)).toBe(100); // início do 2º
    expect(mapBatchTimeToTrack(batch, 25)).toBe(115); // meio do 2º
  });
  it('não vaza pra dentro do silêncio (clamp no fim do intervalo)', () => {
    expect(mapBatchTimeToTrack(batch, 9.9)).toBeCloseTo(19.9);
    // ASR devolveu timestamp além do fim do lote: gruda no fim do último intervalo
    expect(mapBatchTimeToTrack(batch, 45)).toBe(130);
  });
  it('fim de segmento exatamente na emenda pertence ao intervalo ANTERIOR', () => {
    // sem isEnd, 10 cai no 2º intervalo (start 100); como FIM, deve ser 20 (fim do 1º)
    expect(mapBatchTimeToTrack(batch, 10, true)).toBe(20);
    expect(mapBatchTimeToTrack(batch, 10)).toBe(100);
  });
});

describe('filtro de alucinações do Whisper', () => {
  it('reconhece créditos de legenda clássicos', () => {
    expect(isHallucination('Legenda Adriana Zanotto')).toBe(true);
    expect(isHallucination('Legendas pela comunidade Amara.org')).toBe(true);
    expect(isHallucination('Obrigado por assistir!')).toBe(true);
    expect(isHallucination('Não esqueça de se inscrever no canal')).toBe(true);
  });
  it('NÃO descarta fala normal', () => {
    expect(isHallucination('A legenda do gráfico ficou errada no slide')).toBe(false);
    expect(isHallucination('Legendas prontas pra revisão')).toBe(false);
    expect(isHallucination('Tchau, tchau')).toBe(false);
    expect(isHallucination('Vamos revisar o backlog amanhã')).toBe(false);
    expect(isHallucination('E aí, tudo bem?')).toBe(false);
  });
  it('remove alucinações e colapsa repetições curtas consecutivas', () => {
    const segs = [
      { text: 'Bom dia, pessoal' },
      { text: 'Legenda Adriana Zanotto' },
      { text: 'E aí' },
      { text: 'E aí' },
      { text: 'E aí' },
      { text: 'Vamos começar a daily' },
    ];
    const out = filterHallucinations(segs);
    expect(out.map((s) => s.text)).toEqual(['Bom dia, pessoal', 'E aí', 'Vamos começar a daily']);
  });
  it('mantém frases longas repetidas (podem ser fala real)', () => {
    const long = 'Essa frase é longa o suficiente pra não ser colapsada';
    const out = filterHallucinations([{ text: long }, { text: long }]);
    expect(out).toHaveLength(2);
  });
});
