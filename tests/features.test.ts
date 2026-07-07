import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { guildConfigStore } from '../src/guildConfig';
import { RecordingMeta, saveMeta, saveMinutes, saveTranscript } from '../src/store';
import { searchRecordings } from '../src/web/search';
import { shortError } from '../src/util';

const DIR = process.env.RECORDINGS_DIR!;

function makeMeta(id: string): RecordingMeta {
  return {
    id,
    guildId: 'g1',
    guildName: 'time',
    voiceChannelId: 'c1',
    voiceChannelName: 'daily',
    startedBy: { id: 'u1', name: 'Ana' },
    startedAt: Date.now() - 3600_000,
    endedAt: Date.now(),
    status: 'done',
    participants: [{ id: 'u1', name: 'Ana', avatar: null, trackFile: '1-u1.flac', index: 1 }],
    events: [],
    notes: [{ atMs: 60_000, author: 'Ana', text: 'lembrar do orçamento' }],
    transcription: { status: 'done' },
    minutes: { status: 'done' },
  };
}

describe('searchRecordings', () => {
  beforeAll(() => {
    fs.rmSync(path.join(DIR, 'busca-teste-1'), { recursive: true, force: true });
    const meta = makeMeta('busca-teste-1');
    saveMeta(meta);
    saveTranscript('busca-teste-1', [
      { startMs: 10_000, endMs: 12_000, speaker: 'Ana', text: 'Precisamos revisar o deploy amanhã cedo' },
      { startMs: 30_000, endMs: 33_000, speaker: 'Ana', text: 'A reunião de orçamento ficou pra sexta' },
    ]);
    saveMinutes('busca-teste-1', {
      resumo: 'Discutido o deploy e o orçamento do trimestre.',
      decisoes: ['Deploy vai pra quinta'],
      acoes: [{ tarefa: 'Revisar orçamento' }],
      topicos: [],
      porParticipante: [],
    });
  });

  it('acha trecho de transcrição por termo (sem acento vs com acento)', () => {
    const hits = searchRecordings([makeMeta('busca-teste-1')], 'orcamento');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.kind === 'transcript' && h.snippet.includes('orçamento'))).toBe(true);
  });

  it('acha na ata e na nota, com link pro momento nos trechos', () => {
    const hits = searchRecordings([makeMeta('busca-teste-1')], 'orçamento');
    expect(hits.some((h) => h.kind === 'minutes')).toBe(true);
    expect(hits.some((h) => h.kind === 'note' && h.atMs === 60_000)).toBe(true);
    const seg = hits.find((h) => h.kind === 'transcript');
    expect(seg?.atMs).toBe(30_000);
  });

  it('query vazia/curta não retorna nada', () => {
    expect(searchRecordings([makeMeta('busca-teste-1')], '')).toHaveLength(0);
    expect(searchRecordings([makeMeta('busca-teste-1')], 'a')).toHaveLength(0);
  });
});

describe('guildConfigStore', () => {
  it('grava, lê e limpa a configuração por guild', () => {
    guildConfigStore.set('g-teste', { minutesChannelId: '123', updatedBy: 'u1' });
    expect(guildConfigStore.get('g-teste').minutesChannelId).toBe('123');
    guildConfigStore.set('g-teste', { minutesChannelId: undefined });
    expect(guildConfigStore.get('g-teste').minutesChannelId).toBeUndefined();
  });
});

describe('shortError', () => {
  it('traduz erros de provedor pra linguagem humana', () => {
    expect(shortError('Groq LLM HTTP 413: {"error":{"message":"Request too large"}}', 'pt')).toContain('longa demais');
    expect(shortError('HTTP 429: rate limit reached, try again in 8m', 'en')).toContain('rate-limited');
    expect(shortError('HTTP 401: invalid api key', 'pt')).toContain('chave');
  });
  it('corta o JSON do provedor em erro desconhecido', () => {
    const out = shortError('erro estranho: {"gigante":"blob"}', 'pt');
    expect(out).not.toContain('{');
  });
});
