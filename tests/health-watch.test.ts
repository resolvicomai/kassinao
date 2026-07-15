import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];
const BACKUP_SCRIPT = path.join(process.cwd(), 'scripts', 'backup.sh');
const HEALTH_WATCH_SCRIPT = path.join(process.cwd(), 'scripts', 'health-watch.sh');

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function runWatch(
  status: string,
  options: {
    profiles?: string;
    publicStatus?: string;
    tunnelStatus?: string;
    coreState?: string;
    lockBusy?: boolean;
    startedAt?: string;
    egressActive?: boolean;
    hardenerFirstStatus?: number;
    hardenerStatus?: number;
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kassinao-health-watch-'));
  tempDirs.push(dir);
  const log = path.join(dir, 'docker.log');
  const docker = path.join(dir, 'docker');
  const flock = path.join(dir, 'flock');
  const systemctl = path.join(dir, 'systemctl');
  const hardener = path.join(dir, 'harden-docker-egress');
  const storageVerifier = path.join(dir, 'verify-storage-encryption');
  const runtime = path.join(dir, 'run', 'lock', 'kassinao');
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    docker,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [ "$1" = inspect ]; then
  if [ "$2" = --format ]; then
    container=''
    for arg in "$@"; do container="$arg"; done
    case "$container" in
      kassinao) health="$FAKE_STATUS" ;;
      kassinao-public) health="$FAKE_PUBLIC_STATUS" ;;
      kassinao-tunnel) health="$FAKE_TUNNEL_STATUS" ;;
      *) exit 1 ;;
    esac
    state="\${FAKE_CORE_STATE:-running}"
    [ "$container" = kassinao ] || state=running
    printf '%s|%s|%s\\n' "$state" "$health" "$FAKE_STARTED_AT"
  fi
  exit 0
fi
`,
    { mode: 0o700 },
  );
  fs.writeFileSync(flock, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$FLOCK_LOG"\nexit "$FAKE_FLOCK_STATUS"\n', {
    mode: 0o700,
  });
  const flockLog = path.join(dir, 'flock.log');
  const systemctlLog = path.join(dir, 'systemctl.log');
  fs.writeFileSync(
    systemctl,
    '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$SYSTEMCTL_LOG"\nexit "$FAKE_SYSTEMCTL_STATUS"\n',
    { mode: 0o700 },
  );
  const hardenerLog = path.join(dir, 'hardener.log');
  const hardenerCount = path.join(dir, 'hardener.count');
  fs.writeFileSync(
    hardener,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HARDENER_LOG"
count=0
[ ! -f "$HARDENER_COUNT" ] || read -r count < "$HARDENER_COUNT"
count=$((count + 1))
printf '%s\\n' "$count" > "$HARDENER_COUNT"
if [ "$count" -eq 1 ]; then exit "$FAKE_HARDENER_FIRST_STATUS"; fi
exit "$FAKE_HARDENER_STATUS"
`,
    { mode: 0o700 },
  );
  fs.writeFileSync(storageVerifier, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o700 });

  const result = spawnSync('bash', [HEALTH_WATCH_SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      DOCKER_BIN: docker,
      DOCKER_LOG: log,
      FAKE_STATUS: status,
      FAKE_PUBLIC_STATUS: options.publicStatus ?? 'healthy',
      FAKE_TUNNEL_STATUS: options.tunnelStatus ?? 'healthy',
      FAKE_CORE_STATE: options.coreState ?? 'running',
      FAKE_FLOCK_STATUS: options.lockBusy ? '1' : '0',
      FAKE_STARTED_AT: options.startedAt ?? new Date().toISOString(),
      FLOCK_LOG: flockLog,
      SYSTEMCTL_BIN: systemctl,
      SYSTEMCTL_LOG: systemctlLog,
      FAKE_SYSTEMCTL_STATUS: options.egressActive === false ? '3' : '0',
      KASSINAO_HARDENER: hardener,
      KASSINAO_STORAGE_VERIFIER: storageVerifier,
      HARDENER_LOG: hardenerLog,
      HARDENER_COUNT: hardenerCount,
      FAKE_HARDENER_FIRST_STATUS: String(options.hardenerFirstStatus ?? 0),
      FAKE_HARDENER_STATUS: String(options.hardenerStatus ?? 0),
      COMPOSE_PROFILES: options.profiles ?? '',
      KASSINAO_RUNTIME_DIR: runtime,
    },
  });
  return {
    result,
    calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
    lock: path.join(runtime, 'maintenance.lock'),
    lockCalls: fs.existsSync(flockLog) ? fs.readFileSync(flockLog, 'utf8') : '',
    systemctlCalls: fs.existsSync(systemctlLog) ? fs.readFileSync(systemctlLog, 'utf8') : '',
    hardenerCalls: fs.existsSync(hardenerLog) ? fs.readFileSync(hardenerLog, 'utf8') : '',
  };
}

describe('watchdog de saúde no host', () => {
  it('compartilha com o backup um runtime determinístico, sem fallback por usuário', () => {
    const backup = fs.readFileSync(BACKUP_SCRIPT, 'utf8');
    const watchdog = fs.readFileSync(HEALTH_WATCH_SCRIPT, 'utf8');

    for (const script of [backup, watchdog]) {
      expect(script).toContain('KASSINAO_RUNTIME_DIR:-/run/lock/kassinao');
      expect(script).toContain('$RUNTIME_DIR/maintenance.lock');
      expect(script).not.toContain('XDG_RUNTIME_DIR');
      expect(script).not.toContain('KASSINAO_MAINTENANCE_LOCK_FILE');
    }
    expect(backup).toContain('$RUNTIME_DIR/backup.lock');
    expect(watchdog).not.toContain('HEALTH_WATCH_LOCK_FILE');
  });

  it('reinicia somente o contêiner configurado quando fica unhealthy', () => {
    const { result, calls } = runWatch('unhealthy');
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContain('inspect --format');
    expect(calls).toContain('restart kassinao');
    expect(calls).not.toContain('kassinao-public');
    expect(calls).not.toContain('kassinao-tunnel');
    expect(calls).not.toContain('--time');
    expect(calls).not.toContain('--timeout');
  });

  it('não reinicia um contêiner saudável', () => {
    const { result, calls, lock, lockCalls } = runWatch('healthy');
    expect(result.status, result.stderr).toBe(0);
    expect(calls).not.toContain('restart');
    expect(fs.existsSync(lock)).toBe(true);
    expect(lockCalls).toContain('-n 9');
  });

  it('não toca no Docker quando o lock único de manutenção está ocupado', () => {
    const { result, calls, lock } = runWatch('healthy', { lockBusy: true });
    expect(result.status).toBe(0);
    expect(fs.existsSync(lock)).toBe(true);
    expect(calls).toBe('');
  });

  it('não toca no Docker quando o serviço de egress não está active', () => {
    const { result, calls, systemctlCalls, hardenerCalls } = runWatch('unhealthy', { egressActive: false });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('não está active');
    expect(systemctlCalls).toContain('is-active --quiet kassinao-docker-egress.service');
    expect(hardenerCalls).toBe('');
    expect(calls).toBe('');
  });

  it('não toca no Docker quando a verificação das regras de egress falha', () => {
    const { result, calls, hardenerCalls } = runWatch('unhealthy', { hardenerFirstStatus: 1 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('não confirmou as regras de egress');
    expect(hardenerCalls).toBe('--check\n');
    expect(calls).toBe('');
  });

  it('revalida as regras imediatamente antes do restart e falha fechado se elas mudaram', () => {
    const { result, calls, hardenerCalls } = runWatch('unhealthy', { hardenerStatus: 1 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('não confirmou as regras de egress');
    expect(hardenerCalls).toBe('--check\n--check\n');
    expect(calls).toContain('inspect --format');
    expect(calls).not.toContain('restart kassinao');
  });

  it('reporta crash-loop restarting sem disputar o restart automático do Docker', () => {
    const { result, calls } = runWatch('none', { coreState: 'restarting' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('crash-loop');
    expect(calls).not.toContain('restart kassinao');
  });

  it('recusa core em execução quando o healthcheck foi removido', () => {
    const { result, calls } = runWatch('none');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('sem healthcheck obrigatório');
    expect(calls).not.toContain('restart kassinao');
  });

  it('recusa health starting que ultrapassa a janela de inicialização', () => {
    const { result, calls } = runWatch('starting', { startedAt: '2020-01-01T00:00:00.000Z' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('janela segura');
    expect(calls).not.toContain('restart kassinao');
  });

  it('monitora somente os componentes opcionais habilitados', () => {
    const { result, calls } = runWatch('healthy', {
      profiles: 'split-public,tunnel',
      publicStatus: 'unhealthy',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContain('restart kassinao-public');
    expect(calls).not.toContain('restart kassinao\n');
    expect(calls).not.toContain('restart kassinao-tunnel');
  });
});
