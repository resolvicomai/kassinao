import { afterEach, describe, expect, it } from 'vitest';
import { deleteRecording, listGuildMetasInRange, RecordingMeta, saveMeta } from '../src/store';

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
});
