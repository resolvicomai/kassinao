import type { ProcessingProgress, ProcessingStage } from './processing/progress';
import type { RecordingMeta } from './store';

export interface OperationSample {
  meta: Pick<RecordingMeta, 'transcription' | 'minutes'>;
  progress?: ProcessingProgress;
}

const stages: Array<[ProcessingStage, string]> = [
  ['queued', 'Espera na fila registrada'],
  ['preparing', 'Preparação registrada'],
  ['transcribing', 'Transcrição registrada'],
  ['minutes', 'Geração de ata registrada'],
];
const measured = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const duration = (ms: number) => (ms < 60_000 ? `${number.format(ms / 1000)} s` : `${number.format(ms / 60_000)} min`);

/** Callers supply only the metadata/progress they are authorized to inspect. No files, prices or provider calls. */
export function operationsSummaryRows(samples: readonly OperationSample[]): Array<[string, string]> {
  const coverage = (count: number) => `${count} de ${samples.length} gravações`;
  const rows: Array<[string, string]> = stages.map(([stage, label]) => {
    const values = samples
      .map((sample) => sample.progress?.stageDurationsMs?.[stage])
      .filter(measured)
      .sort((a, b) => a - b);
    if (!values.length) return [label, 'Não medido'];
    const middle = Math.floor(values.length / 2);
    const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    const p95 = values[Math.ceil(values.length * 0.95) - 1];
    return [label, `Mediana ${duration(median)}; p95 ${duration(p95)} (${coverage(values.length)})`];
  });
  const reused = samples.map((sample) => sample.progress?.reusedBatches).filter(measured);
  rows.push([
    'Blocos reaproveitados registrados',
    reused.length ? `${reused.reduce((sum, value) => sum + value, 0)} (${coverage(reused.length)})` : 'Não medido',
  ]);
  const failures = new Map<string, number>();
  const addFailure = (stage: string, provider?: string) => {
    const label =
      provider
        ?.replace(/\p{Cc}/gu, ' ')
        .trim()
        .slice(0, 80) || 'provedor não registrado';
    const key = `${stage} · ${label}`;
    failures.set(key, (failures.get(key) ?? 0) + 1);
  };
  for (const { meta } of samples) {
    if (meta.transcription?.status === 'error') addFailure('Transcrição', meta.transcription.provider);
    // A model name does not identify the historical provider used for this request.
    if (meta.minutes?.status === 'error') addFailure('Ata');
  }
  rows.push([
    'Falhas atuais por provedor',
    samples.length
      ? failures.size
        ? [...failures]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([label, count]) => `${label}: ${count}`)
            .join('; ')
        : 'Nenhuma falha no estado atual'
      : 'Não medido',
  ]);
  rows.push(['Histórico de falhas por provedor', 'Não medido']);
  return rows;
}
