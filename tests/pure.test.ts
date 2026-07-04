import { describe, expect, it } from 'vitest';
import { safeSlice } from '../src/util';
import { localeOf, t } from '../src/i18n';
import { formatDuration, formatOffset, joinNames, sanitizeFilename } from '../src/recorder/RecordingSession';
import { minutesToMarkdown, normalizeMinutes } from '../src/processing/minutes';
import { msToClock } from '../src/processing/transcribe';

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
});
