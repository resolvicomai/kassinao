import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('scripts operacionais destrutivos falham fechados', () => {
  it('retenção rejeita qualquer dry-run diferente de 0 ou 1 antes de tocar o remoto', () => {
    const result = spawnSync('bash', [path.join(process.cwd(), 'scripts', 'backup-retention.sh')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RCLONE_RETENTION_REMOTE: 'backup-crypt:',
        RCLONE_RETENTION_CONFIG: '/arquivo-que-nao-existe',
        BACKUP_RETENTION_DRY_RUN: 'true',
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('BACKUP_RETENTION_DRY_RUN precisa ser 0 ou 1');
  });

  it('retenção exige um caminho remoto explícito e não aceita a raiz do crypt', () => {
    const result = spawnSync('bash', [path.join(process.cwd(), 'scripts', 'backup-retention.sh')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RCLONE_RETENTION_REMOTE: 'backup-crypt:',
        RCLONE_RETENTION_CONFIG: '/arquivo-que-nao-existe',
        BACKUP_RETENTION_DRY_RUN: '1',
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('RCLONE_RETENTION_REMOTE precisa incluir um caminho não vazio');
  });

  it.each([
    ['backup-crypt://', 'RCLONE_RETENTION_REMOTE precisa incluir um caminho não vazio'],
    ['backup-crypt:.', 'RCLONE_RETENTION_REMOTE precisa incluir um caminho seguro'],
    ['backup-crypt:daily/../', 'RCLONE_RETENTION_REMOTE precisa incluir um caminho seguro'],
  ])('retenção rejeita caminho remoto que normaliza para raiz: %s', (remote, expectedError) => {
    const result = spawnSync('bash', [path.join(process.cwd(), 'scripts', 'backup-retention.sh')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RCLONE_RETENTION_REMOTE: remote,
        RCLONE_RETENTION_CONFIG: '/arquivo-que-nao-existe',
        BACKUP_RETENTION_DRY_RUN: '1',
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(expectedError);
  });
});
