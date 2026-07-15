import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

function retentionFixture(root: string, bin: string) {
  const scripts = path.join(root, 'scripts');
  const runtime = path.join(root, 'run', 'lock', 'kassinao');
  const inventory = path.join(root, 'inherited-environment.bin');
  mkdirSync(scripts, { recursive: true, mode: 0o700 });
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  chmodSync(runtime, 0o700);
  const lock = path.join(runtime, 'backup-retention.lock');
  writeFileSync(lock, 'sentinela-retention\n', { mode: 0o600 });
  chmodSync(lock, 0o600);
  const source = readFileSync(path.join(process.cwd(), 'scripts', 'backup-retention.sh'), 'utf8')
    .replaceAll('/proc/$$/environ', inventory)
    .replace('PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', `PATH=${bin}:/usr/bin:/bin`)
    .replace(/# KASSINAO_HOST_NO_DUMP_BEGIN[\s\S]*?# KASSINAO_HOST_NO_DUMP_END\n/, '')
    .replace('RUNTIME_DIR=/run/lock/kassinao', `RUNTIME_DIR=${runtime}`)
    .replace('700:0:0', `700:${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`)
    .replaceAll('600:0:0:1', `600:${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}:1`)
    .replace(
      /\[ -d "\$RUNTIME_DIR" \][\s\S]*?die 'backup-retention\.lock mudou durante a abertura'\n/,
      '[ -d "$RUNTIME_DIR" ] && [ ! -L "$RUNTIME_DIR" ] || exit 1\n' +
        '[ -f "$LOCK_FILE" ] && [ ! -L "$LOCK_FILE" ] || exit 1\n' +
        'exec 9<>"$LOCK_FILE"\n',
    );
  const script = path.join(scripts, 'backup-retention.sh');
  writeFileSync(script, source, { mode: 0o700 });
  chmodSync(script, 0o700);
  return {
    script,
    lock,
    setInventory(environment: NodeJS.ProcessEnv) {
      writeFileSync(
        inventory,
        Buffer.from(
          Object.entries(environment)
            .map(([name, value]) => `${name}=${value ?? ''}\0`)
            .join(''),
        ),
      );
    },
  };
}

function runRetention(script: ReturnType<typeof retentionFixture>, environment: NodeJS.ProcessEnv) {
  script.setInventory(environment);
  return spawnSync('/bin/bash', [script.script], { encoding: 'utf8', env: environment });
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('scripts operacionais destrutivos falham fechados', () => {
  it('retenção rejeita qualquer dry-run diferente de 0 ou 1 antes de tocar o remoto', () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'kassinao-retention-unit-')));
    tempDirs.push(root);
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    const envFile = path.join(root, '.env');
    writeFileSync(envFile, 'KASSINAO_HOST_SCOPE=dedicated\n', { mode: 0o600 });
    const script = retentionFixture(root, bin);
    const environment = {
      ...process.env,
      KASSINAO_ENV_FILE: envFile,
      RCLONE_RETENTION_REMOTE: 'backup-crypt:',
      RCLONE_RETENTION_CONFIG: '/arquivo-que-nao-existe',
      BACKUP_RETENTION_DRY_RUN: 'true',
    };
    const result = runRetention(script, environment);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('BACKUP_RETENTION_DRY_RUN precisa ser 0 ou 1');
  });

  it('retenção exige um caminho remoto explícito e não aceita a raiz do crypt', () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'kassinao-retention-unit-')));
    tempDirs.push(root);
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    const envFile = path.join(root, '.env');
    writeFileSync(envFile, 'KASSINAO_HOST_SCOPE=dedicated\n', { mode: 0o600 });
    const script = retentionFixture(root, bin);
    const environment = {
      ...process.env,
      KASSINAO_ENV_FILE: envFile,
      RCLONE_RETENTION_REMOTE: 'backup-crypt:',
      RCLONE_RETENTION_CONFIG: '/arquivo-que-nao-existe',
      BACKUP_RETENTION_DRY_RUN: '1',
    };
    const result = runRetention(script, environment);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('RCLONE_RETENTION_REMOTE precisa incluir um caminho não vazio');
  });

  it.each([
    ['backup-crypt://', 'RCLONE_RETENTION_REMOTE precisa incluir um caminho seguro'],
    ['backup-crypt:.', 'RCLONE_RETENTION_REMOTE precisa incluir um caminho seguro'],
    ['backup-crypt:daily/../', 'RCLONE_RETENTION_REMOTE precisa incluir um caminho seguro'],
  ])('retenção rejeita caminho remoto que normaliza para raiz: %s', (remote, expectedError) => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'kassinao-retention-unit-')));
    tempDirs.push(root);
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    const envFile = path.join(root, '.env');
    writeFileSync(envFile, 'KASSINAO_HOST_SCOPE=dedicated\n', { mode: 0o600 });
    const script = retentionFixture(root, bin);
    const environment = {
      ...process.env,
      KASSINAO_ENV_FILE: envFile,
      RCLONE_RETENTION_REMOTE: remote,
      RCLONE_RETENTION_CONFIG: '/arquivo-que-nao-existe',
      BACKUP_RETENTION_DRY_RUN: '1',
    };
    const result = runRetention(script, environment);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(expectedError);
  });

  it('no shared exige credencial de retenção separada dentro do mount LUKS', () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'kassinao-retention-shared-')));
    tempDirs.push(root);
    const data = path.join(root, 'data');
    const configDirectory = path.join(data, 'config');
    const bin = path.join(root, 'bin');
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(bin, { mode: 0o700 });
    chmodSync(data, 0o700);
    chmodSync(configDirectory, 0o700);
    const envFile = path.join(root, '.env');
    writeFileSync(envFile, `KASSINAO_HOST_SCOPE=shared\nKASSINAO_DATA_ROOT=${data}\n`, { mode: 0o600 });
    const uploadConfig = path.join(configDirectory, 'backup-upload-rclone.conf');
    const retentionConfig = path.join(configDirectory, 'backup-retention-rclone.conf');
    writeFileSync(uploadConfig, '[upload]\ntype = crypt\n', { mode: 0o600 });
    writeFileSync(retentionConfig, '[retention]\ntype = crypt\n', { mode: 0o600 });
    const events = path.join(root, 'events.log');
    const executable = (name: string, body: string) => {
      const file = path.join(bin, name);
      writeFileSync(file, body, { mode: 0o700 });
      chmodSync(file, 0o700);
      return file;
    };
    const verifier = executable('verify-storage', '#!/bin/bash -p\nexit 0\n');
    executable('findmnt', `#!/usr/bin/env bash\nprintf '%s\\n' '${data}'\n`);
    executable('flock', '#!/usr/bin/env bash\nexit 0\n');
    executable(
      'rclone',
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> '${events}'
case " $* " in
  *' listremotes '*) printf 'retention: crypt\n' ;;
  *' delete '*) ;;
  *) exit 1 ;;
esac
`,
    );
    const fixture = retentionFixture(root, bin);
    let fixtureSource = readFileSync(fixture.script, 'utf8');
    fixtureSource = fixtureSource.replace(
      'STORAGE_VERIFIER=/usr/local/sbin/kassinao-verify-shared-luks-storage',
      `STORAGE_VERIFIER=${verifier}`,
    );
    writeFileSync(fixture.script, fixtureSource, { mode: 0o700 });
    const baseEnvironment = {
      ...process.env,
      KASSINAO_ENV_FILE: envFile,
      RCLONE_RETENTION_REMOTE: 'retention:daily',
      BACKUP_RETENTION_DRY_RUN: '1',
    };

    const wrongCredential = runRetention(fixture, { ...baseEnvironment, RCLONE_RETENTION_CONFIG: uploadConfig });
    expect(wrongCredential.status).not.toBe(0);
    expect(wrongCredential.stderr).toContain('DATA_ROOT/config/backup-retention-rclone.conf');
    expect(readFileSync(events, { encoding: 'utf8', flag: 'a+' })).toBe('');

    const correctCredential = runRetention(fixture, { ...baseEnvironment, RCLONE_RETENTION_CONFIG: retentionConfig });
    expect(correctCredential.status, correctCredential.stderr).toBe(0);
    expect(readFileSync(fixture.lock, 'utf8')).toBe('sentinela-retention\n');
    expect(readFileSync(events, 'utf8')).toContain('listremotes');
    expect(readFileSync(events, 'utf8')).toContain('delete');
  });
});
