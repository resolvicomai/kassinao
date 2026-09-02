import { describe, expect, it } from 'vitest';
import { buildMinutesEmbed } from '../src/discord/minutesEmbed';
import type { MeetingMinutes, RecordingMeta } from '../src/store';

const meta = { id: '2026-09-02-abc123', voiceChannelName: 'sala-de-reuniao-1' } as RecordingMeta;

function minutes(decisoes: number, acoes: number): MeetingMinutes {
  return {
    resumo: 'Resumo curto.',
    decisoes: Array.from({ length: decisoes }, (_, i) => `Decisão ${i + 1}`),
    acoes: Array.from({ length: acoes }, (_, i) => ({
      tarefa: `Ação ${i + 1}`,
      responsavel: 'Alguém',
      prazo: 'sexta',
    })),
    topicos: [],
    porParticipante: [],
  } as unknown as MeetingMinutes;
}

describe('embed da ata na DM', () => {
  it('diz quantos itens ficaram de fora quando corta a lista', () => {
    const [embed] = buildMinutesEmbed(meta, 'pt', minutes(7, 13));
    const names = embed.data.fields?.map((f) => f.name) ?? [];
    expect(names).toEqual(['✅ Decisões (5 de 7)', '📌 Itens de ação (8 de 13)']);
    expect(embed.data.fields?.[1].value.split('\n')).toHaveLength(8);
  });

  it('não acrescenta contador quando tudo cabe', () => {
    const [embed] = buildMinutesEmbed(meta, 'en', minutes(2, 3));
    expect(embed.data.fields?.map((f) => f.name)).toEqual(['✅ Decisions', '📌 Action items']);
  });

  it('sem ata não gera embed', () => {
    expect(buildMinutesEmbed(meta, 'pt', undefined)).toEqual([]);
  });
});
