import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];
const BACKUP_SCRIPT = path.join(process.cwd(), 'scripts', 'backup.sh');
const HEALTH_WATCH_SCRIPT = path.join(process.cwd(), 'scripts', 'health-watch.sh');
const HEALTH_WATCH_UNIT = path.join(process.cwd(), 'deploy', 'systemd', 'kassinao-health-watch.service');
const SHARED_INSTALLER = path.join(process.cwd(), 'scripts', 'install-shared-host-controls.sh');
const CORE_ID = 'a'.repeat(64);
const PUBLIC_ID = 'b'.repeat(64);
const TUNNEL_ID = 'c'.repeat(64);

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
    sharedAuditFirstStatus?: number;
    sharedAuditStatus?: number;
    firewallScope?: 'dedicated' | 'shared';
    foreignCore?: boolean;
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kassinao-health-watch-'));
  tempDirs.push(dir);
  const scripts = path.join(dir, 'scripts');
  const dockerClient = path.join(dir, 'deploy', 'docker-client');
  fs.mkdirSync(scripts, { recursive: true, mode: 0o700 });
  fs.mkdirSync(dockerClient, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dockerClient, 'config.json'), '{}\n', { mode: 0o444 });
  const log = path.join(dir, 'docker.log');
  const docker = path.join(dir, 'docker');
  const flock = path.join(dir, 'flock');
  const systemctl = path.join(dir, 'systemctl');
  const hardener = path.join(scripts, 'harden-docker-egress.sh');
  const storageVerifier = path.join(scripts, 'verify-storage-encryption.sh');
  const sharedStorageVerifier = path.join(scripts, 'verify-shared-luks-storage.sh');
  const sharedAuditor = path.join(scripts, 'audit-shared-vps-security.sh');
  const sharedAuditLog = path.join(dir, 'shared-audit.log');
  const sharedAuditCount = path.join(dir, 'shared-audit.count');
  const storageLog = path.join(dir, 'storage.log');
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(
    envFile,
    `KASSINAO_HOST_SCOPE=${options.firewallScope ?? 'dedicated'}\nCOMPOSE_PROFILES=${options.profiles ?? ''}\n`,
    { mode: 0o600 },
  );
  const runtime = path.join(dir, 'run', 'lock', 'kassinao');
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const maintenanceLock = path.join(runtime, 'maintenance.lock');
  fs.writeFileSync(maintenanceLock, 'maintenance-sentinel\n', { mode: 0o600 });
  fs.chmodSync(maintenanceLock, 0o600);
  fs.writeFileSync(
    docker,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [ "$1" = inspect ]; then
  if [ "$2" = -f ]; then
    reference="$4"
    case "$reference" in
      ${CORE_ID}|${PUBLIC_ID}) printf '%s\n' "$FAKE_APP_IMAGE" ;;
      ${TUNNEL_ID}) printf '%s\n' "$FAKE_TUNNEL_IMAGE" ;;
      *) exit 1 ;;
    esac
    exit 0
  fi
  [ "$2" = --format ] || exit 1
  template="$3"
  reference="$4"
  case "$reference" in
    kassinao|${CORE_ID}) cid=${CORE_ID}; name=kassinao; service=kassinao; health="$FAKE_STATUS" ;;
    kassinao-public|${PUBLIC_ID}) cid=${PUBLIC_ID}; name=kassinao-public; service=kassinao-public; health="$FAKE_PUBLIC_STATUS" ;;
    kassinao-tunnel|${TUNNEL_ID}) cid=${TUNNEL_ID}; name=kassinao-tunnel; service=cloudflared; health="$FAKE_TUNNEL_STATUS" ;;
    *) exit 1 ;;
  esac
  case "$template" in
    '{{.Id}}') printf '%s\\n' "$cid" ;;
    *com.docker.compose.project*)
      project=kassinao
      [ "$name" != kassinao ] || [ "$FAKE_FOREIGN_CORE" != true ] || project=company
      printf '%s|/%s|%s|%s\\n' "$cid" "$name" "$project" "$service"
      ;;
    *State.Status*)
      state="\${FAKE_CORE_STATE:-running}"
      [ "$name" = kassinao ] || state=running
      printf '%s|%s|%s\\n' "$state" "$health" "$FAKE_STARTED_AT"
      ;;
    *) exit 1 ;;
  esac
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
	printf '%s\\n' "$*" >> '${hardenerLog.replaceAll("'", `'\\''`)}'
	count=0
	[ ! -f '${hardenerCount.replaceAll("'", `'\\''`)}' ] || read -r count < '${hardenerCount.replaceAll("'", `'\\''`)}'
	count=$((count + 1))
	printf '%s\\n' "$count" > '${hardenerCount.replaceAll("'", `'\\''`)}'
	if [ "$count" -eq 1 ]; then exit ${options.hardenerFirstStatus ?? 0}; fi
	exit ${options.hardenerStatus ?? 0}
`,
    { mode: 0o700 },
  );
  fs.writeFileSync(
    storageVerifier,
    `#!/usr/bin/env bash
printf '%s:%s\\n' "\${KASSINAO_ENV_FILE:-unset}" "$*" >> '${storageLog.replaceAll("'", `'\\''`)}'
exit 0
`,
    { mode: 0o700 },
  );
  fs.copyFileSync(storageVerifier, sharedStorageVerifier);
  fs.chmodSync(sharedStorageVerifier, 0o700);
  fs.writeFileSync(
    sharedAuditor,
    `#!/usr/bin/env bash
printf '%s:%s\n' "\${KASSINAO_ENV_FILE:-unset}" "$*" >> '${sharedAuditLog.replaceAll("'", `'\\''`)}'
count=0
[ ! -f '${sharedAuditCount.replaceAll("'", `'\\''`)}' ] || read -r count < '${sharedAuditCount.replaceAll("'", `'\\''`)}'
count=$((count + 1))
printf '%s\n' "$count" > '${sharedAuditCount.replaceAll("'", `'\\''`)}'
if [ "$count" -eq 1 ]; then exit ${options.sharedAuditFirstStatus ?? 0}; fi
exit ${options.sharedAuditStatus ?? 0}
`,
    { mode: 0o700 },
  );

  const readlink = path.join(dir, 'readlink');
  fs.writeFileSync(
    readlink,
    `#!/usr/bin/env bash
if [ "\${1:-}" = -f ]; then
  shift
  [ "\${1:-}" != -- ] || shift
  case "\${1:-}" in /proc/*/fd/9) printf '%s\n' "$FAKE_LOCK" ;; *) printf '%s\n' "\${1:-}" ;; esac
else
  /usr/bin/readlink "$@"
fi
`,
    { mode: 0o700 },
  );
  const stat = path.join(dir, 'stat');
  fs.writeFileSync(
    stat,
    `#!/usr/bin/env bash
target="\${!#}"
format="\${2:-}"
case "$format:$target" in
  *%d:%i*) printf '1:1\n' ;;
  *%a:%u:%g:%h*:/proc/*/fd/9|*%a:%u:%g:%h*:$FAKE_LOCK) printf '600:${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}:1\n' ;;
  *%a:%u:%g*:$FAKE_RUNTIME) printf '700:${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}\n' ;;
  *) /usr/bin/stat "$@" ;;
esac
`,
    { mode: 0o700 },
  );
  const healthScript = path.join(scripts, 'health-watch.sh');
  const healthSource = fs
    .readFileSync(HEALTH_WATCH_SCRIPT, 'utf8')
    .replace(
      /# KASSINAO_HOST_ENV_SCRUB_BEGIN[\s\S]*?# KASSINAO_HOST_ENV_SCRUB_END/,
      `# KASSINAO_HOST_ENV_SCRUB_BEGIN
_saved_no_dump_marker=""
_saved_no_dump_preload=""
_forbidden_override=""
export PATH=${dir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LC_ALL=C
# KASSINAO_HOST_ENV_SCRUB_END`,
    )
    .replace(
      /# KASSINAO_HOST_NO_DUMP_BEGIN[\s\S]*?# KASSINAO_HOST_NO_DUMP_END/,
      '# KASSINAO_HOST_NO_DUMP_BEGIN\nunset LD_PRELOAD\n# KASSINAO_HOST_NO_DUMP_END',
    )
    .replace('RUNTIME_DIR=/run/lock/kassinao', `RUNTIME_DIR=${runtime}`)
    .replaceAll('700:0:0', `700:${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`)
    .replaceAll('600:0:0:1', `600:${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}:1`)
    .replace(
      /# KASSINAO_LOCK_FD_PROOF_BEGIN[\s\S]*?# KASSINAO_LOCK_FD_PROOF_END/,
      '# KASSINAO_LOCK_FD_PROOF_BEGIN\n:\n# KASSINAO_LOCK_FD_PROOF_END',
    );
  fs.writeFileSync(healthScript, healthSource, { mode: 0o700 });

  const result = spawnSync('bash', [healthScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      LC_ALL: undefined,
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
      KASSINAO_FIREWALL_SCOPE: options.firewallScope ?? 'dedicated',
      KASSINAO_STORAGE_VERIFIER: storageVerifier,
      KASSINAO_ENV_FILE: envFile,
      KASSINAO_SHARED_AUDITOR: sharedAuditor,
      KASSINAO_SHARED_AUDIT_ENV_FILE: envFile,
      STORAGE_LOG: storageLog,
      HARDENER_LOG: hardenerLog,
      HARDENER_COUNT: hardenerCount,
      FAKE_HARDENER_FIRST_STATUS: String(options.hardenerFirstStatus ?? 0),
      FAKE_HARDENER_STATUS: String(options.hardenerStatus ?? 0),
      FAKE_FOREIGN_CORE: String(options.foreignCore ?? false),
      FAKE_APP_IMAGE: `ghcr.io/example/kassinao@sha256:${'a'.repeat(64)}`,
      FAKE_TUNNEL_IMAGE: `cloudflare/cloudflared:2026.7.1@sha256:${'b'.repeat(64)}`,
      COMPOSE_PROFILES: options.profiles ?? '',
      KASSINAO_RUNTIME_DIR: runtime,
      FAKE_RUNTIME: runtime,
      FAKE_LOCK: maintenanceLock,
    },
  });
  return {
    result,
    calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
    lock: path.join(runtime, 'maintenance.lock'),
    lockCalls: fs.existsSync(flockLog) ? fs.readFileSync(flockLog, 'utf8') : '',
    systemctlCalls: fs.existsSync(systemctlLog) ? fs.readFileSync(systemctlLog, 'utf8') : '',
    hardenerCalls: fs.existsSync(hardenerLog) ? fs.readFileSync(hardenerLog, 'utf8') : '',
    storageCalls: fs.existsSync(storageLog) ? fs.readFileSync(storageLog, 'utf8') : '',
    sharedAuditCalls: fs.existsSync(sharedAuditLog) ? fs.readFileSync(sharedAuditLog, 'utf8') : '',
    envFile,
  };
}

describe('watchdog de saúde no host', () => {
  it('aciona contenção fail-closed quando qualquer gate do watchdog falha', () => {
    const unit = fs.readFileSync(HEALTH_WATCH_UNIT, 'utf8');
    const sharedInstaller = fs.readFileSync(SHARED_INSTALLER, 'utf8');
    expect(unit).toContain('OnFailure=kassinao-egress-fail-closed.service');
    expect(unit).toContain('OnFailureJobMode=replace-irreversibly');
    expect(sharedInstaller).toContain('ExecStartPre=/usr/local/sbin/kassinao-check-shared-migration-rollback');
  });

  it('gera o drop-in shared sem Environment e deriva configuração somente da release selada', () => {
    const installer = fs.readFileSync(SHARED_INSTALLER, 'utf8');
    const start = installer.indexOf('expected_health_dropin="$(printf');
    const end = installer.indexOf('installed_env_file=', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const generatedDropin = installer.slice(start, end);
    expect(generatedDropin).not.toMatch(/^\s*['"]Environment=/m);
    expect(generatedDropin).toContain('ExecStartPre=/usr/local/sbin/kassinao-check-shared-migration-rollback');

    const watchdog = fs.readFileSync(HEALTH_WATCH_SCRIPT, 'utf8');
    expect(watchdog).toContain('FIREWALL_SCOPE="$(env_value KASSINAO_HOST_SCOPE)"');
    expect(watchdog).toContain('COMPOSE_PROFILES="$(env_value COMPOSE_PROFILES)"');
    expect(watchdog).toContain('SHARED_AUDITOR="$DEPLOY_DIR/scripts/audit-shared-vps-security.sh"');
    expect(watchdog).toContain('SHARED_AUDIT_ENV_FILE="$ENV_FILE"');
  });

  it('compartilha com o backup um runtime determinístico, sem fallback por usuário', () => {
    const backup = fs.readFileSync(BACKUP_SCRIPT, 'utf8');
    const watchdog = fs.readFileSync(HEALTH_WATCH_SCRIPT, 'utf8');

    for (const script of [backup, watchdog]) {
      expect(script).toContain('RUNTIME_DIR=/run/lock/kassinao');
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
    expect(calls).toContain(`restart ${CORE_ID}`);
    expect(calls).not.toContain('kassinao-public');
    expect(calls).not.toContain('kassinao-tunnel');
    expect(calls).not.toContain('--time');
    expect(calls).not.toContain('--timeout');
  });

  it('preserva somente o path do env privado ao executar o verifier em ambiente limpo', () => {
    const { result, storageCalls, envFile } = runWatch('healthy');
    expect(result.status, result.stderr).toBe(0);
    expect(storageCalls).toBe(`${envFile}:\n`);
  });

  it('não reinicia um contêiner saudável', () => {
    const { result, calls, lock, lockCalls } = runWatch('healthy');
    expect(result.status, result.stderr).toBe(0);
    expect(calls).not.toContain('restart');
    expect(fs.existsSync(lock)).toBe(true);
    expect(lockCalls).toContain('-n 9');
  });

  it('não reinicia um container alheio que ocupou o nome reservado do core', () => {
    const { result, calls } = runWatch('unhealthy', { foreignCore: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('identidade divergente');
    expect(calls).toContain(`inspect --format {{.Id}} kassinao`);
    expect(calls).not.toContain(`restart ${CORE_ID}`);
    expect(calls).not.toMatch(/^restart /m);
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

  it('usa o modo de firewall que não altera o hook global no adapter shared', () => {
    const { result, hardenerCalls, sharedAuditCalls, envFile } = runWatch('healthy', { firewallScope: 'shared' });
    expect(result.status, result.stderr).toBe(0);
    expect(hardenerCalls).toBe('--shared-host --check\n');
    expect(sharedAuditCalls).toBe(`${envFile}:--preflight\n`);
  });

  it('no adapter shared revalida o contrato estático imediatamente antes do restart', () => {
    const { result, calls, sharedAuditCalls, envFile } = runWatch('unhealthy', { firewallScope: 'shared' });
    expect(result.status, result.stderr).toBe(0);
    const image = `ghcr.io/example/kassinao@sha256:${'a'.repeat(64)}`;
    expect(sharedAuditCalls).toBe(
      `${envFile}:--preflight\n${envFile}:--preflight --expected-existing-image ${image}\n`,
    );
    expect(calls).toContain(`restart ${CORE_ID}`);
  });

  it('no adapter shared não toca no Docker quando o primeiro gate estático falha', () => {
    const { result, calls, sharedAuditCalls } = runWatch('unhealthy', {
      firewallScope: 'shared',
      sharedAuditFirstStatus: 1,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('contrato estático shared divergiu');
    expect(sharedAuditCalls.split('\n').filter(Boolean)).toHaveLength(1);
    expect(calls).toBe('');
  });

  it('no adapter shared não reinicia quando o gate estático muda após a inspeção', () => {
    const { result, calls, sharedAuditCalls } = runWatch('unhealthy', {
      firewallScope: 'shared',
      sharedAuditStatus: 1,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('contrato estático shared divergiu');
    expect(sharedAuditCalls.split('\n').filter(Boolean)).toHaveLength(2);
    expect(calls).toContain('inspect --format');
    expect(calls).not.toContain(`restart ${CORE_ID}`);
  });

  it('revalida as regras imediatamente antes do restart e falha fechado se elas mudaram', () => {
    const { result, calls, hardenerCalls } = runWatch('unhealthy', { hardenerStatus: 1 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('não confirmou as regras de egress');
    expect(hardenerCalls).toBe('--check\n--check\n');
    expect(calls).toContain('inspect --format');
    expect(calls).not.toContain(`restart ${CORE_ID}`);
  });

  it('reporta crash-loop restarting sem disputar o restart automático do Docker', () => {
    const { result, calls } = runWatch('none', { coreState: 'restarting' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('crash-loop');
    expect(calls).not.toContain(`restart ${CORE_ID}`);
  });

  it('recusa core em execução quando o healthcheck foi removido', () => {
    const { result, calls } = runWatch('none');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('sem healthcheck obrigatório');
    expect(calls).not.toContain(`restart ${CORE_ID}`);
  });

  it('recusa health starting que ultrapassa a janela de inicialização', () => {
    const { result, calls } = runWatch('starting', { startedAt: '2020-01-01T00:00:00.000Z' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('janela segura');
    expect(calls).not.toContain(`restart ${CORE_ID}`);
  });

  it('monitora somente os componentes opcionais habilitados', () => {
    const { result, calls } = runWatch('healthy', {
      profiles: 'split-public,tunnel',
      publicStatus: 'unhealthy',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContain(`restart ${PUBLIC_ID}`);
    expect(calls).not.toContain(`restart ${CORE_ID}`);
    expect(calls).not.toContain(`restart ${TUNNEL_ID}`);
  });
});
