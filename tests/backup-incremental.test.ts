import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, '../scripts/backup-incremental.sh');
const tempDirs: string[] = [];

function fixture(remoteType = 'crypt') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kassinao-backup-inc-')));
  tempDirs.push(root);
  const bin = path.join(root, 'bin');
  const recordings = path.join(root, 'recordings');
  const state = path.join(root, 'state');
  const locks = path.join(root, 'locks');
  for (const dir of [bin, recordings, state, locks]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(recordings, 'placeholder.flac'), 'fLaC');
  // flock não existe no macOS; o teste cobre a lógica do script, não o util.
  fs.writeFileSync(path.join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const calls = path.join(root, 'rclone-calls.log');
  fs.writeFileSync(
    path.join(bin, 'rclone'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${calls}"
case " $* " in
  *" listremotes "*) printf 'kassinao-crypt: ${remoteType}\\n'; exit 0 ;;
  *" size "*) printf '{"count":467,"bytes":3482765639}\\n'; exit 0 ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  const rcloneConf = path.join(root, 'rclone.conf');
  fs.writeFileSync(rcloneConf, '[kassinao-crypt]\ntype = crypt\n', { mode: 0o600 });
  return { root, bin, recordings, state, locks, rcloneConf, calls };
}

function run(f: ReturnType<typeof fixture>, extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: `${f.bin}:${process.env.PATH ?? ''}`,
      HOME: f.root,
      RECORDINGS_DIR: f.recordings,
      STATE_DIR: f.state,
      RCLONE_REMOTE: 'kassinao-crypt:live',
      RCLONE_CONFIG: f.rcloneConf,
      BACKUP_LOCK_FILE: path.join(f.locks, 'backup.lock'),
      ...extraEnv,
    },
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('scripts/backup-incremental.sh', () => {
  it('sobe só o que falta, nunca apaga no destino e grava o heartbeat legível', () => {
    const f = fixture();
    const result = run(f);
    expect(result.status, result.stderr).toBe(0);
    const calls = fs.readFileSync(f.calls, 'utf8');
    expect(calls).toMatch(/copy .*recordings kassinao-crypt:live/);
    expect(calls).toMatch(/copy .*state kassinao-crypt:live\/\.state/);
    expect(calls).not.toMatch(/\bsync\b|\bdelete\b|\bpurge\b/);
    expect(calls).toMatch(/check .*--one-way --size-only/);
    // segredos e cache nunca saem do servidor
    for (const excluded of [
      '/.cookie-secret',
      '/.web-sessions.json',
      '/.mcp-sessions.json',
      '/*/cache/**',
      '/.instance-id',
    ]) {
      expect(calls).toContain(`--exclude ${excluded}`);
    }
    const heartbeat = JSON.parse(fs.readFileSync(path.join(f.state, 'backup-heartbeat.json'), 'utf8'));
    expect(heartbeat).toMatchObject({ files: 467, bytes: 3482765639, remote: 'kassinao-crypt:live' });
    expect(Number.isFinite(Date.parse(heartbeat.finishedAt))).toBe(true);
    expect(fs.statSync(path.join(f.state, 'backup-heartbeat.json')).mode & 0o044).toBe(0o044);
    expect(fs.readdirSync(f.state).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    expect(result.stdout).toContain('backup incremental verificado');
  });

  it('recusa um remoto que não é crypt antes de enviar qualquer byte', () => {
    const f = fixture('s3');
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('precisa ser um remoto do tipo crypt');
    expect(fs.readFileSync(f.calls, 'utf8')).not.toMatch(/\bcopy\b/);
    expect(fs.existsSync(path.join(f.state, 'backup-heartbeat.json'))).toBe(false);
  });

  it('recusa rclone.conf com permissão aberta', () => {
    const f = fixture();
    fs.chmodSync(f.rcloneConf, 0o644);
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('chmod 600');
  });

  it('sem STATE_DIR só o acervo sobe e nenhum heartbeat é gravado', () => {
    const f = fixture();
    const result = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: {
        PATH: `${f.bin}:${process.env.PATH ?? ''}`,
        RECORDINGS_DIR: f.recordings,
        RCLONE_REMOTE: 'kassinao-crypt:live',
        RCLONE_CONFIG: f.rcloneConf,
        BACKUP_LOCK_FILE: path.join(f.locks, 'backup.lock'),
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(f.calls, 'utf8')).not.toMatch(/copy \S+ kassinao-crypt:live\/\.state/);
    expect(fs.existsSync(path.join(f.state, 'backup-heartbeat.json'))).toBe(false);
  });
});
