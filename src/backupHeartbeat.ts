import fs from 'node:fs';
import path from 'node:path';

/**
 * Contrato entre o script de backup (cron do host) e o bot: ao terminar um
 * upload verificado, o script grava `backup-heartbeat.json` no volume de estado.
 * O monitor lê o arquivo e avisa o dono quando o último sucesso ficou velho.
 *
 * Foi assim que 60 execuções falharam em sequência em 2026 sem ninguém saber:
 * o erro só ia para um log do host que ninguém lê. Este arquivo é a ponte.
 */
export const BACKUP_HEARTBEAT_FILE = 'backup-heartbeat.json';
export const BACKUP_STALE_AFTER_MS = 48 * 60 * 60 * 1000;

export interface BackupHeartbeat {
  /** ISO-8601 do fim do último upload verificado. */
  finishedAt: string;
  files?: number;
  bytes?: number;
  remote?: string;
}

export type BackupHeartbeatVerdict =
  | { ok: true; ageMs: number; heartbeat: BackupHeartbeat }
  | { ok: false; reason: 'missing' | 'invalid' | 'stale'; ageMs?: number; heartbeat?: BackupHeartbeat };

export function readBackupHeartbeat(stateDir: string): string | undefined {
  try {
    return fs.readFileSync(path.join(stateDir, BACKUP_HEARTBEAT_FILE), 'utf8');
  } catch {
    return undefined;
  }
}

/** Decisão pura, testável sem filesystem: o raw vem de readBackupHeartbeat. */
export function evaluateBackupHeartbeat(
  raw: string | undefined,
  nowMs: number,
  staleAfterMs = BACKUP_STALE_AFTER_MS,
): BackupHeartbeatVerdict {
  if (raw === undefined) return { ok: false, reason: 'missing' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as { finishedAt?: unknown }).finishedAt !== 'string') {
    return { ok: false, reason: 'invalid' };
  }
  const heartbeat = parsed as BackupHeartbeat;
  const finished = Date.parse(heartbeat.finishedAt);
  if (!Number.isFinite(finished)) return { ok: false, reason: 'invalid' };
  const ageMs = Math.max(0, nowMs - finished);
  if (ageMs > staleAfterMs) return { ok: false, reason: 'stale', ageMs, heartbeat };
  return { ok: true, ageMs, heartbeat };
}

export function describeBackupProblem(verdict: BackupHeartbeatVerdict): string | undefined {
  if (verdict.ok) return undefined;
  if (verdict.reason === 'missing') {
    return (
      'O backup externo está declarado como ativo (BACKUP_STATUS=enabled), mas nenhuma execução registrou conclusão ainda. ' +
      'Confira se o job de backup está agendado e gravando backup-heartbeat.json no volume de estado.'
    );
  }
  if (verdict.reason === 'invalid') {
    return 'O registro do último backup (backup-heartbeat.json) está ilegível. Confira o job de backup no servidor.';
  }
  const hours = Math.round((verdict.ageMs ?? 0) / 3_600_000);
  return (
    `O backup externo não confirma sucesso há **${hours} h** (último registrado: ${verdict.heartbeat?.finishedAt ?? '?'}). ` +
    'Confira o log do backup no servidor antes que a janela sem cópia cresça.'
  );
}
