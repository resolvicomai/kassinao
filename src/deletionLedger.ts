import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { readPrivateFileBounded, writeJsonStateAtomic } from './stateFile';

export interface DeletionTombstone {
  recordingId: string;
  kind: 'recording' | 'audio';
  requestedAt: number;
}

const MAX_ENTRIES = 100_000;
const FILE = () => path.join(config.stateDir, 'deletion-ledger.json');
const VALID_ID = /^[a-zA-Z0-9-]{1,255}$/;

/** Leitura estrita: uma exclusão não pode sobrescrever um ledger ilegível. */
export function readDeletionLedger(): DeletionTombstone[] {
  try {
    const entries = JSON.parse(readPrivateFileBounded(FILE(), 32 * 1024 * 1024)) as DeletionTombstone[];
    if (
      !Array.isArray(entries) ||
      entries.length > MAX_ENTRIES ||
      entries.some(
        (entry) =>
          !entry ||
          typeof entry.recordingId !== 'string' ||
          !VALID_ID.test(entry.recordingId) ||
          !['recording', 'audio'].includes(entry.kind) ||
          !Number.isFinite(entry.requestedAt) ||
          entry.requestedAt < 0,
      )
    )
      throw new Error('ledger schema');
    return entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    // eslint-disable-next-line preserve-caught-error -- JSON/paths podem conter referências privadas; não propagar causa bruta para logs.
    throw new Error('deletion ledger unavailable');
  }
}

/** Persistir ANTES de remover arquivos. Continua sendo intenção se o disco falhar. */
export function recordDeletionTombstone(recordingId: string, kind: DeletionTombstone['kind'] = 'recording'): void {
  if (typeof recordingId !== 'string' || !VALID_ID.test(recordingId)) throw new Error('invalid deletion reference');
  const entries = readDeletionLedger();
  const existing = entries.find((entry) => entry.recordingId === recordingId);
  if (existing) {
    if (existing.kind === 'recording' || existing.kind === kind) return;
    existing.kind = 'recording';
    existing.requestedAt = Date.now();
  } else {
    // ponytail: lista simples até 100 mil exclusões; migrar índice se este teto for atingido.
    if (entries.length >= MAX_ENTRIES) throw new Error('deletion ledger capacity reached');
    entries.push({ recordingId, kind, requestedAt: Date.now() });
  }
  writeJsonStateAtomic(FILE(), entries);
}

/** Bloqueia a abertura do acervo restaurado até reconciliar exclusões, sem apagar no boot. */
export function assertDeletionsReconciled(recordingsDir = config.recordingsDir): void {
  const exists = (file: string): boolean => {
    try {
      fs.lstatSync(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  for (const entry of readDeletionLedger()) {
    const directory = path.join(recordingsDir, entry.recordingId);
    if (!exists(directory)) continue;
    if (entry.kind === 'recording' || fs.lstatSync(directory).isSymbolicLink())
      throw new Error('restored deletions need offline reconciliation');
    const file = path.join(directory, 'meta.json');
    if (['tracks', 'cache'].some((name) => exists(path.join(directory, name))) || !exists(file))
      throw new Error('restored deletions need offline reconciliation');
    const meta = JSON.parse(readPrivateFileBounded(file, 16 * 1024 * 1024)) as { id?: string; audioDeleted?: boolean };
    if (meta.id !== entry.recordingId || meta.audioDeleted !== true)
      throw new Error('restored deletions need offline reconciliation');
  }
}
