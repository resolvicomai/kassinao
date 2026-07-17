import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const UNINSTALLER = path.join(ROOT, 'scripts', 'uninstall-shared-host-controls.sh');
const source = readFileSync(UNINSTALLER, 'utf8');
const temporaryDirectories: string[] = [];

function runContainerGate(options: { running?: string; restart?: string; project?: string; service?: string }) {
  const directory = mkdtempSync(path.join(tmpdir(), 'kassinao-shared-uninstall-'));
  temporaryDirectories.push(directory);
  const bin = path.join(directory, 'bin');
  mkdirSync(bin);
  const docker = path.join(bin, 'docker');
  writeFileSync(
    docker,
    `#!/usr/bin/env bash
set -eu
case "$1" in
  ps) printf 'kassinao\nkassinao-router\nkassinao-public\nkassinao-tunnel\n' ;;
  inspect)
    case "$3" in
      *State.Running*) printf '%s\n' "\${TEST_RUNNING}" ;;
      *RestartPolicy.Name*) printf '%s\n' "\${TEST_RESTART}" ;;
      *compose.project*) printf '%s\n' "\${TEST_PROJECT}" ;;
      *compose.service*)
        case "$4" in
          kassinao) printf 'kassinao\n' ;;
          kassinao-router) printf 'kassinao-router\n' ;;
          kassinao-public) printf 'kassinao-public\n' ;;
          kassinao-tunnel) printf '%s\n' "\${TEST_SERVICE}" ;;
        esac
        ;;
      *) exit 2 ;;
    esac
    ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
  chmodSync(docker, 0o755);

  const start = source.indexOf('containers="$(docker ps -a --format \'{{.Names}}\')"');
  const end = source.indexOf('# Prova que a policy', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const gate = source.slice(start, end);
  return spawnSync(
    'bash',
    ['-c', ['set -Eeuo pipefail', 'die() { printf \'ERRO: %s\\n\' "$*" >&2; exit 1; }', gate].join('\n')],
    {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        TEST_RUNNING: options.running ?? 'false',
        TEST_RESTART: options.restart ?? 'no',
        TEST_PROJECT: options.project ?? 'kassinao',
        TEST_SERVICE: options.service ?? 'cloudflared',
      },
    },
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('uninstaller do adapter shared', () => {
  it('é Bash válido, exige confirmação explícita e barra execução sem root', () => {
    const syntax = spawnSync('bash', ['-n', UNINSTALLER], { encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);
    expect(source).toContain('SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
    expect(source).toContain('export PATH="$SAFE_SYSTEM_PATH" HOME=/root LC_ALL=C');
    expect(source.indexOf('export PATH="$SAFE_SYSTEM_PATH" HOME=/root LC_ALL=C')).toBeLessThan(
      source.indexOf('command -v "$command"'),
    );
    expect(source.indexOf('export PATH="$SAFE_SYSTEM_PATH" HOME=/root LC_ALL=C')).toBeLessThan(source.indexOf('id -u'));

    const withoutConfirmation = spawnSync('bash', [UNINSTALLER], { encoding: 'utf8' });
    expect(withoutConfirmation.status).not.toBe(0);
    expect(withoutConfirmation.stderr).toContain('--confirm-remove-kassinao-shared-host-controls');

    if ((process.getuid?.() ?? 1) !== 0) {
      const notRoot = spawnSync('bash', [UNINSTALLER, '--confirm-remove-kassinao-shared-host-controls'], {
        encoding: 'utf8',
      });
      expect(notRoot.status).not.toBe(0);
      expect(notRoot.stderr).toContain('execute como root');
    }
  });

  it('aceita somente marker e allowlist shared exatos da release atual', () => {
    expect(source).toContain('[ "$(env_value KASSINAO_HOST_SCOPE "$ENV_FILE")" = shared ]');
    expect(source).toContain('KASSINAO_HOST_SCOPE=shared\\nKASSINAO_DEPLOY_DIR=%s');
    expect(source).toContain('marker shared possui chaves extras, formato ou release divergente');
    expect(source).toContain('shared.env diverge da allowlist exata desta release/storage');
    expect(source).toContain('file_matches_exact()');
    expect(source).toContain('"${expected}"$\'\\n\\037\'');
    expect(source).toContain('[ "${#etc_entries[@]}" -eq 2 ]');
    for (const key of [
      'KASSINAO_DATA_ROOT',
      'KASSINAO_RECORDINGS_DIR',
      'KASSINAO_STATE_DIR',
      'KASSINAO_AUTH_DIR',
      'KASSINAO_MODEL_CACHE_DIR',
      'KASSINAO_UID',
      'KASSINAO_GID',
      'KASSINAO_SHARED_LUKS_BACKING_FILE',
      'KASSINAO_SHARED_LUKS_MAPPER',
      'KASSINAO_SHARED_LUKS_UUID',
      'KASSINAO_SHARED_APP_ENV_FILE',
      'KASSINAO_SHARED_TUNNEL_TOKEN_FILE',
    ]) {
      expect(source).toContain(`  ${key}\n`);
    }
  });

  it('valida todos os artefatos e bloqueios antes da primeira mutação', () => {
    const mutation = source.indexOf('# A partir daqui começam as mutações');
    expect(mutation).toBeGreaterThan(0);
    for (const gate of [
      'script instalado ausente, divergente ou symlink',
      'unit instalada ausente, insegura ou symlink',
      'health-watch possui drop-in fora do adapter shared',
      'tmpfiles de rollback divergiu',
      'flock -w 120 9',
      'ainda há snapshot de rollback pendente',
      'docker.service precisa estar active',
      'precisa estar parado; o uninstall nunca para containers',
      'precisa usar restart=no antes do uninstall',
      '--check',
      'estado do rollback plaintext inválido ou expirado; remoção recusada antes de qualquer mutação',
      'rollback plaintext ainda está pending',
      '--uninstall-preflight',
    ]) {
      const gateIndex = source.indexOf(gate);
      expect(gateIndex, gate).toBeGreaterThan(0);
      expect(gateIndex, gate).toBeLessThan(mutation);
    }
    expect(source.slice(0, mutation)).not.toMatch(/\bsystemctl\s+(?:disable|stop)\b/);
    expect(source.slice(0, mutation)).not.toMatch(/^rm\s/m);

    const audit = source.indexOf('"$SHARED_AUDITOR" --uninstall-preflight');
    expect(audit).toBeGreaterThan(0);
    expect(audit).toBeLessThan(mutation);
    expect(source).toContain('"KASSINAO_ENV_FILE=$ENV_FILE"');
    expect(source).toContain('scripts/audit-shared-vps-security.sh');
    const currentDropinStart = source.indexOf('expected_health_dropin="$(printf');
    const currentDropinEnd = source.indexOf('file_matches_exact "$HEALTH_DROPIN"', currentDropinStart);
    expect(currentDropinStart).toBeGreaterThan(0);
    expect(currentDropinEnd).toBeGreaterThan(currentDropinStart);
    const currentDropin = source.slice(currentDropinStart, currentDropinEnd);
    expect(currentDropin).not.toMatch(/^\s*['"]Environment=/m);
    expect(currentDropin).toContain("grep -c '^Environment='");
    expect(source).toContain('ReadOnlyPaths=/etc/kassinao/shared.env $ENV_FILE $SHARED_AUDITOR');
  });

  it.each([
    ['running', { running: 'true' }, 'precisa estar parado'],
    ['restart autônomo', { restart: 'unless-stopped' }, 'restart=no'],
    ['projeto divergente', { project: 'foreign' }, 'não pertence ao projeto/serviço'],
    ['serviço divergente', { service: 'foreign' }, 'não pertence ao projeto/serviço'],
  ] as const)('falha fechado para container %s', (_label, options, error) => {
    const result = runContainerGate(options);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(error);
  });

  it('aceita somente containers parados, sem restart e com labels shared', () => {
    const result = runContainerGate({});
    expect(result.status, result.stderr).toBe(0);
  });

  it('remove e prova apenas a policy Kassinão pelo hardener instalado', () => {
    const check = source.indexOf('kassinao-harden-docker-egress --shared-host --check');
    const mutation = source.indexOf('# A partir daqui começam as mutações');
    const remove = source.indexOf('kassinao-harden-docker-egress --shared-host --remove');
    const proof = source.indexOf("grep -Fq 'KASSINAO-'", remove);
    expect(check).toBeLessThan(mutation);
    expect(remove).toBeGreaterThan(mutation);
    expect(proof).toBeGreaterThan(remove);
    expect(source).toContain('policy Kassinão permaneceu em $tool');
    expect(source).toContain('ExecStart=/usr/local/sbin/kassinao-harden-docker-egress --shared-host');
    expect(source).toContain('unit shared de egress instalada divergiu');
  });

  it('não reinicia/altera docker.service nem muta containers ou workloads vizinhos', () => {
    expect(source).toContain('export DOCKER_HOST=unix:///var/run/docker.sock');
    expect(source).toContain('docker_main_pid_before');
    expect(source).toContain('[ "$docker_main_pid_after" = "$docker_main_pid_before" ]');
    expect(source).not.toMatch(
      /systemctl\s+(?:start|stop|restart|enable|disable|mask|unmask)\s+docker(?:\.service)?\b/,
    );
    expect(source).not.toMatch(/docker\s+(?:stop|start|restart|rm|update|compose)\b/);
    expect(source).not.toContain('/etc/docker/');
    expect(source).not.toContain('docker.service.d');
  });

  it('não apaga DATA_ROOT, backing, segredos, release ou snapshots', () => {
    expect(source).not.toMatch(/\brm\s[^\n]*(?:\$data_root|\$backing_file|APP_ENV|TUNNEL_TOKEN|\$ROOT)/);
    expect(source).not.toMatch(/\brmdir\s[^\n]*(?:\$data_root|\$backing_file|\$ROOT|rollback_dir)/);
    expect(source).not.toMatch(/\brm\s+-rf\b/);
    expect(source).not.toContain('systemd-tmpfiles --remove');
    expect(source).toContain('o uninstall nunca apaga snapshots');
    expect(source).toContain('sem reiniciar Docker ou apagar release, storage e segredos');
  });

  it('preserva maintenance.lock como tombstone enquanto o FD 9 permanece aberto', () => {
    expect(source).toContain('exec 9<>"$RUNTIME_DIR/maintenance.lock"');
    expect(source).toContain('for lock in backup.lock backup-retention.lock docker-egress.lock; do');
    expect(source).toContain('tombstone maintenance.lock ficou ausente ou inseguro');
    expect(source).toContain('[ "${#tombstone_entries[@]}" -eq 1 ]');
    expect(source).not.toMatch(/rm[^\n]*maintenance\.lock/);
    expect(source).not.toContain('rmdir -- "$RUNTIME_DIR"');
  });

  it('desabilita e remove somente units, scripts, drop-in, env e tmpfiles compartilhados conhecidos', () => {
    for (const unit of [
      'kassinao-health-watch.service',
      'kassinao-health-watch.timer',
      'kassinao-docker-egress.service',
      'kassinao-egress-fail-closed.service',
      'kassinao-rollback-clean.service',
      'kassinao-rollback-clean.timer',
    ]) {
      expect(source).toContain(unit);
    }
    for (const artifact of [
      '/usr/local/sbin/kassinao-health-watch',
      '/usr/local/sbin/kassinao-verify-shared-luks-storage',
      '/usr/local/sbin/kassinao-check-shared-migration-rollback',
      '/usr/local/sbin/kassinao-harden-docker-egress',
      '/usr/local/sbin/kassinao-egress-fail-closed',
      '/etc/tmpfiles.d/kassinao.conf',
      '/etc/tmpfiles.d/kassinao-rollback.conf',
      '$ETC_KASSINAO/shared.env',
      '$ETC_KASSINAO/host-controls.env',
    ]) {
      expect(source).toContain(artifact);
    }
    expect(source).not.toContain('kassinao-verify-storage-encryption');
    expect(source).not.toContain('/etc/kassinao/storage-paths');
    expect(source).toContain('scripts/check-shared-migration-rollback.sh');
    expect(source).toContain('ExecStartPre=/usr/local/sbin/kassinao-check-shared-migration-rollback');
  });
});
