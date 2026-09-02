import { describe, expect, it } from 'vitest';
import { describeBackupProblem, evaluateBackupHeartbeat } from '../src/backupHeartbeat';

const NOW = Date.parse('2026-09-02T12:00:00Z');
const H = 3_600_000;

describe('heartbeat do backup', () => {
  it('sem arquivo: o backup nunca confirmou conclusão', () => {
    const verdict = evaluateBackupHeartbeat(undefined, NOW);
    expect(verdict).toEqual({ ok: false, reason: 'missing' });
    expect(describeBackupProblem(verdict)).toContain('nenhuma execução registrou conclusão');
  });

  it('arquivo ilegível ou sem finishedAt é inválido, não silêncio', () => {
    expect(evaluateBackupHeartbeat('{', NOW)).toEqual({ ok: false, reason: 'invalid' });
    expect(evaluateBackupHeartbeat('{"files":3}', NOW)).toEqual({ ok: false, reason: 'invalid' });
    expect(evaluateBackupHeartbeat('{"finishedAt":"ontem"}', NOW)).toEqual({ ok: false, reason: 'invalid' });
    expect(describeBackupProblem(evaluateBackupHeartbeat('{', NOW))).toContain('ilegível');
  });

  it('sucesso recente é saudável; mais de 48 h vira alerta com a idade em horas', () => {
    const fresh = evaluateBackupHeartbeat(
      JSON.stringify({ finishedAt: new Date(NOW - 9 * H).toISOString(), files: 467, bytes: 3_482_765_639 }),
      NOW,
    );
    expect(fresh.ok).toBe(true);
    expect(describeBackupProblem(fresh)).toBeUndefined();

    const stale = evaluateBackupHeartbeat(JSON.stringify({ finishedAt: new Date(NOW - 60 * H).toISOString() }), NOW);
    expect(stale).toMatchObject({ ok: false, reason: 'stale' });
    expect(describeBackupProblem(stale)).toContain('**60 h**');
  });

  it('um relógio adiantado no servidor de backup não gera alerta falso', () => {
    const future = evaluateBackupHeartbeat(JSON.stringify({ finishedAt: new Date(NOW + H).toISOString() }), NOW);
    expect(future).toMatchObject({ ok: true, ageMs: 0 });
  });
});
