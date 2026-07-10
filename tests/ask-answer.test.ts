import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  llmChat: vi.fn(),
  readMinutes: vi.fn(),
  readTranscriptForSearch: vi.fn(),
}));

vi.mock('../src/processing/minutes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/processing/minutes')>()),
  llmChat: mocks.llmChat,
}));

vi.mock('../src/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/store')>()),
  readMinutes: mocks.readMinutes,
  readTranscriptForSearch: mocks.readTranscriptForSearch,
}));

import { answerQuestion, authorizeAskMetas } from '../src/ask';
import { MeetingMinutes, RecordingMeta } from '../src/store';

function meta(index: number): RecordingMeta {
  const id = index === 155 ? '2026-07-05-zefiro-target' : `2026-07-09-generic-${index}`;
  return {
    id,
    guildId: 'guild-ask-answer',
    guildName: 'Servidor',
    voiceChannelId: 'voice',
    voiceChannelName: 'Produto',
    startedBy: { id: 'owner', name: 'Mauro' },
    startedAt: Date.parse('2026-07-09T12:00:00Z') - index * 60_000,
    endedAt: Date.parse('2026-07-09T13:00:00Z') - index * 60_000,
    status: 'done',
    participants: [],
    presence: [],
    events: [],
    notes: [],
    transcription: { status: 'done' },
    minutes: { status: 'done' },
  };
}

const genericMinutes: MeetingMinutes = {
  resumo: 'Rotina operacional sem relação com o tema.',
  decisoes: [],
  acoes: [],
  topicos: [],
  porParticipante: [],
};

describe('answerQuestion — arquivo profundo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readMinutes.mockReturnValue(genericMinutes);
    mocks.readTranscriptForSearch.mockImplementation((id: string) => ({
      bytes: 120,
      segments: [
        {
          startMs: 1_000,
          endMs: 2_000,
          speaker: 'Ana',
          text: id.includes('zefiro-target') ? 'Projeto Zéfiro aprovado para lançamento.' : 'Conversa genérica.',
        },
      ],
    }));
    mocks.llmChat.mockImplementation(async (_system: string, user: string) => {
      const source = /\[FONTE (S\d{3})[^\n]*\][^\n]*Projeto Zéfiro/.exec(user)?.[1];
      return source ? `[${source}]` : 'NONE';
    });
  });

  it('alcança evidência que existe só depois da antiga barreira de 150 calls', async () => {
    const metas = Array.from({ length: 160 }, (_, index) => meta(index));
    const result = await answerQuestion(
      'o que houve com o Projeto Zéfiro?',
      authorizeAskMetas(metas, () => true),
      'pt',
      {
        nowMs: Date.parse('2026-07-10T15:00:00Z'),
        timezone: 'America/Sao_Paulo',
      },
    );
    expect(result.answer).toContain('Projeto Zéfiro aprovado para lançamento');
    expect(mocks.readTranscriptForSearch).toHaveBeenCalledWith('2026-07-05-zefiro-target', expect.any(Number));
    expect(mocks.llmChat).toHaveBeenCalledOnce();
  });
});
