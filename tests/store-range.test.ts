import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteRecording,
  listGuildMetaIdsInRange,
  listGuildMetasInRange,
  listMetaIdsPage,
  listMetaIdsInRange,
  listMetasInRange,
  minutesPath,
  readTranscriptBounded,
  readTranscriptForSearch,
  recordingDir,
  RecordingMeta,
  saveMeta,
  saveMinutes,
  saveTranscript,
  transcriptPath,
} from '../src/store';

const created: string[] = [];

function meta(id: string, startedAt: string, guildId = 'guild-range-test'): RecordingMeta {
  const value: RecordingMeta = {
    id,
    guildId,
    guildName: 'Servidor',
    voiceChannelId: 'voice',
    voiceChannelName: 'Produto',
    startedBy: { id: 'owner', name: 'Mauro' },
    startedAt: Date.parse(startedAt),
    endedAt: Date.parse(startedAt) + 60_000,
    status: 'done',
    participants: [],
    presence: [],
    events: [],
    notes: [],
    transcription: { status: 'done' },
    minutes: { status: 'done' },
  };
  saveMeta(value);
  created.push(id);
  return value;
}

afterEach(() => {
  for (const id of created.splice(0)) deleteRecording(id);
});

describe('listGuildMetasInRange', () => {
  it('persiste diretório e artefatos da gravação somente para o dono', () => {
    if (process.platform === 'win32') return;
    const value = meta('2026-07-09-private-files', '2026-07-09T12:00:00Z');
    saveTranscript(value.id, [{ startMs: 0, endMs: 1_000, speaker: 'Ana', text: 'segredo' }]);
    saveMinutes(value.id, {
      resumo: 'Resumo privado',
      decisoes: [],
      acoes: [],
      topicos: [],
      porParticipante: [],
    });

    expect(fs.statSync(recordingDir(value.id)).mode & 0o777).toBe(0o700);
    for (const file of [`${recordingDir(value.id)}/meta.json`, transcriptPath(value.id), minutesPath(value.id)]) {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('respeita a janela real mesmo quando o dia local cruza dois prefixos UTC', () => {
    meta('2026-07-09-range-before', '2026-07-09T02:59:59Z');
    meta('2026-07-09-range-start', '2026-07-09T03:00:00Z');
    meta('2026-07-10-range-end', '2026-07-10T02:59:59Z');
    meta('2026-07-10-range-after', '2026-07-10T03:00:00Z');
    meta('2026-07-09-range-other', '2026-07-09T12:00:00Z', 'other-guild');

    const result = listGuildMetasInRange(
      'guild-range-test',
      Date.parse('2026-07-09T03:00:00Z'),
      Date.parse('2026-07-10T03:00:00Z'),
      { limit: 10 },
    );
    expect(result.map((item) => item.id)).toEqual(['2026-07-10-range-end', '2026-07-09-range-start']);
  });

  it('aplica teto de saída depois de isolar a guild', () => {
    for (let index = 0; index < 5; index++) {
      meta(`2026-07-09-zzzz-range-cap-${index}`, `2026-07-09T1${index}:00:00Z`);
    }
    const result = listGuildMetasInRange(
      'guild-range-test',
      Date.parse('2026-07-09T00:00:00Z'),
      Date.parse('2026-07-10T00:00:00Z'),
      { limit: 2 },
    );
    expect(result).toHaveLength(2);
  });

  it('usa o índice já ordenado e não reordena toda a guild durante a consulta limitada', () => {
    for (let index = 0; index < 40; index++) {
      meta(`2026-07-09-indexed-range-${index}`, `2026-07-09T${String(index % 24).padStart(2, '0')}:00:00Z`);
    }
    const sortSpy = vi.spyOn(Array.prototype, 'sort');
    const callsBefore = sortSpy.mock.calls.length;
    const result = listGuildMetasInRange(
      'guild-range-test',
      Date.parse('2026-07-09T00:00:00Z'),
      Date.parse('2026-07-10T00:00:00Z'),
      { limit: 2 },
    );
    const callsAfter = sortSpy.mock.calls.length;
    sortSpy.mockRestore();

    expect(callsAfter).toBe(callsBefore);
    expect(result).toHaveLength(2);
    expect(result[0].startedAt).toBeGreaterThanOrEqual(result[1].startedAt);
  });

  it('reposiciona a meta quando guild ou startedAt mudam', () => {
    const value = meta('2026-07-09-index-move', '2026-07-09T10:00:00Z');
    saveMeta({ ...value, guildId: 'guild-range-new', startedAt: Date.parse('2026-07-09T18:00:00Z') });

    expect(
      listGuildMetasInRange(
        'guild-range-test',
        Date.parse('2026-07-09T00:00:00Z'),
        Date.parse('2026-07-10T00:00:00Z'),
      ).map((item) => item.id),
    ).not.toContain(value.id);
    expect(
      listGuildMetasInRange(
        'guild-range-new',
        Date.parse('2026-07-09T00:00:00Z'),
        Date.parse('2026-07-10T00:00:00Z'),
      ).map((item) => item.id),
    ).toEqual([value.id]);
  });

  it('limita a janela global em ordem recente e sinaliza continuação', () => {
    for (let index = 0; index < 5; index++) {
      meta(`2026-07-09-global-cap-${index}`, `2026-07-09T1${index}:00:00Z`);
    }
    const result = listMetasInRange(Date.parse('2026-07-09T00:00:00Z'), Date.parse('2026-07-10T00:00:00Z'), 2);

    expect(result.metas.map((item) => item.id)).toEqual(['2026-07-09-global-cap-4', '2026-07-09-global-cap-3']);
    expect(result.truncated).toBe(true);
  });

  it('consulta ids globais e por guild sem materializar as metas', () => {
    meta('2026-07-09-id-range-new', '2026-07-09T14:00:00Z');
    meta('2026-07-09-id-range-old', '2026-07-09T13:00:00Z');
    meta('2026-07-09-id-range-other', '2026-07-09T15:00:00Z', 'other-guild');
    const from = Date.parse('2026-07-09T00:00:00Z');
    const to = Date.parse('2026-07-10T00:00:00Z');

    expect(listMetaIdsInRange(from, to, 2)).toEqual({
      ids: ['2026-07-09-id-range-other', '2026-07-09-id-range-new'],
      truncated: true,
    });
    expect(listGuildMetaIdsInRange('guild-range-test', from, to, 1)).toEqual({
      ids: ['2026-07-09-id-range-new'],
      truncated: true,
    });
  });

  it('pagina apenas ids sem clonar o arquivo global inteiro', () => {
    for (let index = 0; index < 5; index++) {
      meta(`2026-07-09-id-page-${index}`, `2099-07-09T1${index}:00:00Z`);
    }
    const first = listMetaIdsPage(0, 2);
    const second = listMetaIdsPage(first.nextCursor, 2);

    expect(first.ids).toEqual(['2026-07-09-id-page-4', '2026-07-09-id-page-3']);
    expect(first.nextCursor).toBe(2);
    expect(second.ids).toEqual(['2026-07-09-id-page-2', '2026-07-09-id-page-1']);
    expect(second.nextCursor).toBe(4);
  });

  it('não confunde metas mais novas fora da janela com truncamento interno', () => {
    meta('2026-07-10-newer-outside', '2026-07-10T12:00:00Z');
    meta('2026-07-09-only-inside', '2026-07-09T12:00:00Z');
    const result = listMetasInRange(Date.parse('2026-07-09T00:00:00Z'), Date.parse('2026-07-10T00:00:00Z'), 5);

    expect(result.metas.map((item) => item.id)).toEqual(['2026-07-09-only-inside']);
    expect(result.truncated).toBe(false);
  });

  it('não deixa gravações de outra guild ocuparem o corte', () => {
    meta('2026-07-09-zzzz-outra-1', '2026-07-09T14:00:00Z', 'other-guild');
    meta('2026-07-09-zzzz-outra-2', '2026-07-09T13:00:00Z', 'other-guild');
    meta('2026-07-09-aaaa-alvo', '2026-07-09T12:00:00Z');
    const result = listGuildMetasInRange(
      'guild-range-test',
      Date.parse('2026-07-09T00:00:00Z'),
      Date.parse('2026-07-10T00:00:00Z'),
      { limit: 1 },
    );
    expect(result.map((item) => item.id)).toEqual(['2026-07-09-aaaa-alvo']);
  });

  it('usa startedAt, não a data antiga capturada no ID antes do início', () => {
    meta('2026-07-09-crossed-midnight', '2026-07-10T00:00:05Z');
    const result = listGuildMetasInRange(
      'guild-range-test',
      Date.parse('2026-07-10T00:00:00Z'),
      Date.parse('2026-07-11T00:00:00Z'),
    );
    expect(result.map((item) => item.id)).toContain('2026-07-09-crossed-midnight');
  });

  it('mede e lê a mesma versão da transcrição dentro do teto', () => {
    const value = meta('2026-07-09-transcript-bound', '2026-07-09T12:00:00Z');
    saveTranscript(value.id, [{ startMs: 0, endMs: 1_000, speaker: 'Ana', text: 'Projeto Zéfiro' }]);
    const result = readTranscriptForSearch(value.id, 1_024);
    expect(result?.segments[0].text).toBe('Projeto Zéfiro');
    expect(result?.bytes).toBeGreaterThan(0);
    expect(readTranscriptForSearch(value.id, (result?.bytes ?? 1) - 1)).toBeUndefined();
  });

  it('recusa uma transcrição acima do teto antes de devolvê-la ao chamador', () => {
    const value = meta('2026-07-09-transcript-direct-bound', '2026-07-09T12:00:00Z');
    saveTranscript(value.id, [{ startMs: 0, endMs: 1_000, speaker: 'Ana', text: 'conteúdo privado' }]);
    const accepted = readTranscriptBounded(value.id, 1_024);
    expect(accepted.status).toBe('ok');
    if (accepted.status !== 'ok') throw new Error('transcrição deveria caber no teto');

    expect(readTranscriptBounded(value.id, accepted.bytes - 1)).toEqual({
      status: 'too_large',
      bytes: accepted.bytes,
    });
  });
});
