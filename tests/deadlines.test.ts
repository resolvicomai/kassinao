import { describe, expect, it } from 'vitest';
import { resolveDeadline } from '../src/deadlines';

const TZ = 'America/Sao_Paulo';
const CALL = Date.parse('2026-09-04T02:30:00Z'); // quinta, 23:30 no fuso da reunião

describe('prazos referenciados à reunião', () => {
  it.each([
    ['hoje', '2026-09-03'],
    ['amanhã', '2026-09-04'],
    ['tomorrow', '2026-09-04'],
    ['depois de amanhã', '2026-09-05'],
    ['day after tomorrow', '2026-09-05'],
    ['sexta-feira', '2026-09-04'],
    ['by Friday', '2026-09-04'],
    ['até quinta', '2026-09-03'],
    ['até 04/09/26 às 17h', '2026-09-04'],
    ['2026-09-04', '2026-09-04'],
  ])('resolve %s sem usar a data da consulta', (raw, date) => {
    expect(resolveDeadline(raw, CALL, TZ)).toMatchObject({ status: 'resolved', date });
  });

  it.each(['31/02/2026', '2026-04-31', '29/02/2025', '00/09/2026', '30/13/2026'])('rejeita %s', (raw) => {
    expect(resolveDeadline(raw, CALL, TZ)).toEqual({ status: 'invalid' });
  });

  it('valida ano bissexto e usa o ano civil da call para datas sem ano', () => {
    expect(resolveDeadline('29/02/2024', CALL, TZ)).toMatchObject({ status: 'resolved', date: '2024-02-29' });
    const nearNewYear = Date.parse('2027-01-01T02:30:00Z');
    expect(resolveDeadline('31/12', nearNewYear, TZ)).toMatchObject({
      status: 'resolved',
      date: '2026-12-31',
      assumedYear: true,
    });
    expect(resolveDeadline('amanhã', nearNewYear, TZ)).toMatchObject({ status: 'resolved', date: '2027-01-01' });
  });

  it('calcula o início e o fim do dia no fuso de destino, inclusive em DST', () => {
    const result = resolveDeadline('2026-03-08', CALL, 'America/New_York');
    expect(result).toMatchObject({
      status: 'resolved',
      fromMs: Date.parse('2026-03-08T05:00:00Z'),
      toMs: Date.parse('2026-03-09T04:00:00Z'),
    });
  });

  it.each(['sexta ou segunda', 'talvez 04/09', 'próxima sexta', 'entre 04/09 e 08/09', 'sexta após deploy'])(
    'preserva ambiguidade em %s',
    (raw) => {
      expect(resolveDeadline(raw, CALL, TZ)).toEqual({ status: 'ambiguous' });
    },
  );

  it.each(['próxima sprint', 'assim que possível', 'segunda etapa', 'final do mês', undefined])(
    'não inventa um dia para %s',
    (raw) => {
      expect(resolveDeadline(raw, CALL, TZ)).toEqual({ status: 'unknown' });
    },
  );
});
