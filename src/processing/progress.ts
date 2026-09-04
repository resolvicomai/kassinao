import fs from 'node:fs';
import path from 'node:path';
import { readMeta, recordingDir } from '../store';
import { writeJsonStateAtomic } from '../stateFile';
import { operationalWarn } from '../operationalLog';

export type ProcessingStage =
  'queued' | 'preparing' | 'transcribing' | 'minutes' | 'waiting' | 'done' | 'error' | 'paused';
export interface ProcessingProgress {
  stage: ProcessingStage;
  updatedAt: number;
  stageDurationsMs: Partial<Record<ProcessingStage, number>>;
  tracksTotal?: number;
  tracksCompleted?: number;
  batchesTotal?: number;
  batchesCompleted?: number;
  reusedBatches?: number;
}

/** Só chamar depois da ACL da gravação; não inclui nomes, texto ou credenciais. */
export function getProcessingProgress(recordingId: string): ProcessingProgress | undefined {
  if (!readMeta(recordingId)) return undefined;
  try {
    const file = path.join(recordingDir(recordingId), 'processing-progress.json');
    if (fs.statSync(file).size > 16_384) return undefined;
    const progress = JSON.parse(fs.readFileSync(file, 'utf8')) as ProcessingProgress;
    if (
      !['queued', 'preparing', 'transcribing', 'minutes', 'waiting', 'done', 'error', 'paused'].includes(
        progress.stage,
      ) ||
      !Number.isFinite(progress.updatedAt)
    )
      return undefined;
    return progress;
  } catch {
    return undefined;
  }
}

export function updateProcessingProgress(
  recordingId: string,
  patch: Partial<Omit<ProcessingProgress, 'updatedAt' | 'stageDurationsMs'>>,
): void {
  if (!readMeta(recordingId)) return;
  const previous = getProcessingProgress(recordingId);
  const now = Date.now();
  const durations = { ...previous?.stageDurationsMs };
  if (previous && !['done', 'error', 'paused', 'waiting'].includes(previous.stage)) {
    durations[previous.stage] = (durations[previous.stage] ?? 0) + Math.max(0, now - previous.updatedAt);
  }
  try {
    writeJsonStateAtomic(path.join(recordingDir(recordingId), 'processing-progress.json'), {
      stage: 'queued',
      ...previous,
      ...patch,
      updatedAt: now,
      stageDurationsMs: durations,
    } satisfies ProcessingProgress);
  } catch {
    // Métrica não deve transformar resposta paga já recebida em nova tentativa.
    operationalWarn('Não foi possível persistir o progresso do processamento.');
  }
}
