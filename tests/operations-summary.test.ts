import { describe, expect, it } from 'vitest';
import { operationsSummaryRows, type OperationSample } from '../src/operationsSummary';

describe('operations summary from existing measurements', () => {
  it('aggregates measured stage durations, queue time, reuse and current provider failures', () => {
    const samples: OperationSample[] = [
      {
        meta: { transcription: { status: 'error', provider: 'assemblyai' } },
        progress: {
          stage: 'error',
          updatedAt: 100,
          stageDurationsMs: { queued: 1000, preparing: 0, transcribing: 60_000 },
          reusedBatches: 2,
        },
      },
      {
        meta: {
          transcription: { status: 'error', provider: 'assemblyai' },
          minutes: { status: 'error', model: 'some-model' },
        },
        progress: {
          stage: 'done',
          updatedAt: 200,
          stageDurationsMs: { queued: 3000, transcribing: 120_000, minutes: 30_000 },
          reusedBatches: 3,
        },
      },
      { meta: {} },
    ];
    const rows = Object.fromEntries(operationsSummaryRows(samples));
    expect(rows['Espera na fila registrada']).toBe('Mediana 2 s; p95 3 s (2 de 3 gravações)');
    expect(rows['Preparação registrada']).toBe('Mediana 0 s; p95 0 s (1 de 3 gravações)');
    expect(rows['Transcrição registrada']).toBe('Mediana 1,5 min; p95 2 min (2 de 3 gravações)');
    expect(rows['Blocos reaproveitados registrados']).toBe('5 (2 de 3 gravações)');
    expect(rows['Falhas atuais por provedor']).toContain('Transcrição · assemblyai: 2');
    expect(rows['Falhas atuais por provedor']).toContain('Ata · provedor não registrado: 1');
    expect(rows['Falhas atuais por provedor']).not.toContain('some-model');
    expect(rows['Histórico de falhas por provedor']).toBe('Não medido');
  });
  it('does not invent elapsed queue time, provider failures, costs or zero measurements for missing/corrupt data', () => {
    const rows = operationsSummaryRows([
      {
        meta: {
          transcription: { status: 'partial', attempts: 3 },
          minutes: { status: 'done', finishedAt: Date.now() },
        },
        progress: {
          stage: 'queued',
          updatedAt: 1,
          stageDurationsMs: { queued: -1, transcribing: NaN, minutes: Infinity },
          reusedBatches: -10,
        },
      },
    ]);
    expect(rows.slice(0, 5).every(([, value]) => value === 'Não medido')).toBe(true);
    expect(Object.fromEntries(rows)['Falhas atuais por provedor']).toBe('Nenhuma falha no estado atual');
    expect(JSON.stringify(rows)).not.toMatch(/R\$|USD|some-model/);
    expect(operationsSummaryRows([]).every(([, value]) => value === 'Não medido')).toBe(true);
  });
});
