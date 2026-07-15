import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const BACKUP_SCRIPT = path.join(process.cwd(), 'scripts', 'backup.sh');
const tempDirs: string[] = [];
const CORE_ID = 'a'.repeat(64);

interface BackupFixture {
  archive: string;
  auth: string;
  cache: string;
  config: string;
  data: string;
  envFile: string;
  events: string;
  injectedMarker: string;
  recordings: string;
  root: string;
  runtime: string;
  state: string;
  run: (options?: {
    divergentMounts?: boolean;
    extraMount?: boolean;
    envFile?: string;
    health?: 'healthy' | 'unhealthy';
    pathsFromEnvFile?: boolean;
    egressActive?: boolean;
    hardenerStatus?: number;
    hostScope?: 'dedicated' | 'shared';
    rollbackStatus?: number;
    foreignContainer?: boolean;
    rcloneConfig?: string;
    sharedAuditStatus?: number;
    sharedAuditAfterStopStatus?: number;
    tarTransientSwap?: boolean;
  }) => ReturnType<typeof spawnSync>;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function executable(file: string, body: string): void {
  writeFileSync(file, body, { mode: 0o700 });
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function createFixture(): BackupFixture {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'kassinao-backup-behavior-')));
  tempDirs.push(root);

  const data = path.join(root, 'data');
  const recordings = path.join(data, 'recordings');
  const state = path.join(data, 'state');
  const auth = path.join(data, 'auth');
  const cache = path.join(data, 'cache');
  const configDirectory = path.join(data, 'config');
  const wrongRecordings = path.join(root, 'wrong-recordings');
  const runtime = path.join(root, 'runtime');
  const bin = path.join(root, 'bin');
  const scripts = path.join(root, 'scripts');
  const dockerClientDirectory = path.join(root, 'deploy', 'docker-client');
  for (const directory of [recordings, state, auth, cache, configDirectory, wrongRecordings, runtime, bin, scripts]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  mkdirSync(dockerClientDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dockerClientDirectory, 'config.json'), '{}\n', { mode: 0o444 });
  const inheritedEnvironment = path.join(root, 'inherited-environment.bin');
  const maintenanceLock = path.join(runtime, 'maintenance.lock');
  const backupLock = path.join(runtime, 'backup.lock');
  writeFileSync(maintenanceLock, 'maintenance-sentinel\n', { mode: 0o600 });
  writeFileSync(backupLock, 'backup-sentinel\n', { mode: 0o600 });
  chmodSync(maintenanceLock, 0o600);
  chmodSync(backupLock, 0o600);
  const inheritedNames = new Set([
    ...Object.keys(process.env),
    'PATH',
    'HOME',
    'CALLER_CANARY_SECRET',
    'KASSINAO_DEPLOY_DIR',
    'KASSINAO_ENV_FILE',
    'RCLONE_REMOTE',
    'RCLONE_CONFIG',
    'KASSINAO_CONTAINER',
    'BACKUP_STOP_CONTAINER',
    'BACKUP_ASSUME_QUIESCED',
    'DOCKER_BIN',
    'SYSTEMCTL_BIN',
    'KASSINAO_HARDENER',
    'KASSINAO_HOST_SCOPE',
    'KASSINAO_STORAGE_VERIFIER',
    'KASSINAO_ROLLBACK_CHECKER',
    'KASSINAO_SHARED_AUDITOR',
    'KASSINAO_DATA_ROOT',
    'KASSINAO_RECORDINGS_DIR',
    'KASSINAO_STATE_DIR',
    'KASSINAO_AUTH_DIR',
    'KASSINAO_MODEL_CACHE_DIR',
    'RECORDINGS_DIR',
    'STATE_DIR',
    'AUTH_STATE_DIR',
  ]);
  writeFileSync(inheritedEnvironment, Buffer.from([...inheritedNames].map((name) => `${name}=fixture\0`).join('')));
  const backupScript = path.join(scripts, 'backup.sh');
  const backupSource = readFileSync(BACKUP_SCRIPT, 'utf8')
    .replace(
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      `PATH=${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    )
    .replaceAll('/proc/$$/environ', inheritedEnvironment)
    .replace(
      /# KASSINAO_HOST_NO_DUMP_BEGIN[\s\S]*?# KASSINAO_HOST_NO_DUMP_END/,
      '# KASSINAO_HOST_NO_DUMP_BEGIN\nunset LD_PRELOAD\n# KASSINAO_HOST_NO_DUMP_END',
    )
    .replace(
      /# KASSINAO_CLEAN_CHILD_BEGIN[\s\S]*?# KASSINAO_CLEAN_CHILD_END/,
      '# KASSINAO_CLEAN_CHILD_BEGIN\nclean_child() { env "$@"; }\ndocker_local() { "$DOCKER" "$@"; }\n# KASSINAO_CLEAN_CHILD_END',
    )
    .replace(
      'HARDENER="$DEPLOY_DIR/scripts/harden-docker-egress.sh"',
      `HARDENER=${shellLiteral(path.join(bin, 'harden-docker-egress'))}`,
    )
    .replace(
      'STORAGE_VERIFIER="$DEPLOY_DIR/scripts/verify-storage-encryption.sh"',
      `STORAGE_VERIFIER=${shellLiteral(path.join(bin, 'verify-storage-encryption'))}`,
    )
    .replace(
      'STORAGE_VERIFIER="$DEPLOY_DIR/scripts/verify-shared-luks-storage.sh"',
      `STORAGE_VERIFIER=${shellLiteral(path.join(bin, 'verify-storage-encryption'))}`,
    )
    .replace(
      'ROLLBACK_CHECKER="$DEPLOY_DIR/scripts/check-shared-migration-rollback.sh"',
      `ROLLBACK_CHECKER=${shellLiteral(path.join(bin, 'check-shared-migration-rollback'))}`,
    )
    .replace(
      'SHARED_AUDITOR="$DEPLOY_DIR/scripts/audit-shared-vps-security.sh"',
      `SHARED_AUDITOR=${shellLiteral(path.join(bin, 'audit-shared-vps-security'))}`,
    )
    .replace('RUNTIME_DIR=/run/lock/kassinao', `RUNTIME_DIR=${runtime}`)
    .replace('= 700:0:0 ]', `= 700:${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0} ]`)
    .replace('= 600:0:0:1 ]', `= 600:${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}:1 ]`)
    .replace(
      /# KASSINAO_LOCK_FD_PROOF_BEGIN[\s\S]*?# KASSINAO_LOCK_FD_PROOF_END/,
      '# KASSINAO_LOCK_FD_PROOF_BEGIN\n:\n# KASSINAO_LOCK_FD_PROOF_END',
    );
  writeFileSync(backupScript, backupSource, { mode: 0o700 });

  writeFileSync(path.join(recordings, 'meeting.txt'), 'public transcript fixture\n');
  writeFileSync(path.join(state, 'guild-config.json'), '{"language":"pt"}\n');
  writeFileSync(path.join(state, 'web-sessions.json'), '{"session":"must-not-leave"}\n');
  writeFileSync(path.join(state, '.mcp-sessions.json'), '{"session":"must-not-leave"}\n');
  writeFileSync(path.join(auth, '.cookie-secret'), 'cookie-must-not-leave\n');
  writeFileSync(path.join(auth, '.instance-id'), 'instance-must-not-leave\n');
  writeFileSync(path.join(auth, 'web-sessions.json'), '{"session":"must-not-leave"}\n');

  const config = path.join(configDirectory, 'backup-upload-rclone.conf');
  writeFileSync(config, '[archive-crypt]\ntype = crypt\n', { mode: 0o600 });
  chmodSync(config, 0o600);
  writeFileSync(path.join(configDirectory, 'app.env'), 'DISCORD_TOKEN=test\n', { mode: 0o440 });
  writeFileSync(path.join(data, '.kassinao-mounted'), 'fixture\n', { mode: 0o400 });

  const events = path.join(root, 'events.log');
  const injectedMarker = path.join(root, 'env-was-executed');
  const containerState = path.join(root, 'container.state');
  writeFileSync(containerState, 'running\n');
  const archive = path.join(root, 'captured-backup.tar.gz');
  const envFile = path.join(root, '.env');
  writeFileSync(
    envFile,
    [
      `KASSINAO_DATA_ROOT=${data}`,
      `KASSINAO_RECORDINGS_DIR=${recordings}`,
      `KASSINAO_STATE_DIR=${state}`,
      `KASSINAO_AUTH_DIR=${auth}`,
      `KASSINAO_MODEL_CACHE_DIR=${cache}`,
      `KASSINAO_SHARED_APP_ENV_FILE=${configDirectory}/app.env`,
      `DISCORD_TOKEN=do-not-print-or-export-$(touch ${injectedMarker})`,
      'KASSINAO_DATA_ROOT_SUFFIX=must-not-match-the-allowlist',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  chmodSync(envFile, 0o600);

  const docker = path.join(bin, 'docker');
  executable(
    docker,
    `#!/usr/bin/env bash
set -eu
[ -z "\${CALLER_CANARY_SECRET:-}" ] || exit 98
command="\${1:-}"
case "$command" in
  inspect)
    if [ "\${2:-}" = "--format" ]; then
      template="\${3:-}"
      reference="\${4:-}"
      case "$reference" in kassinao|${CORE_ID}) ;; *) exit 1 ;; esac
      if [ "$template" = '{{.Id}}' ]; then
        printf 'docker:id-lookup\n' >> "$EVENT_LOG"
        printf '${CORE_ID}\n'
      else
        printf 'docker:identity\n' >> "$EVENT_LOG"
        project=kassinao
        [ "$FAKE_FOREIGN_CONTAINER" != true ] || project=company
        printf '${CORE_ID}|/kassinao|%s|kassinao\n' "$project"
      fi
      exit 0
    fi
    [ "\${2:-}" = "-f" ] || exit 1
    [ "\${4:-}" = "${CORE_ID}" ] || exit 1
    template="\${3:-}"
    case "$template" in
      *json*.Mounts*)
        printf 'docker:mounts\n' >> "$EVENT_LOG"
        recordings="$FAKE_RECORDINGS"
        [ "$FAKE_DIVERGENT_MOUNTS" = true ] && recordings="$FAKE_WRONG_RECORDINGS"
        printf '[{"Type":"bind","Source":"%s","Destination":"/app/recordings","RW":true},{"Type":"bind","Source":"%s","Destination":"/app/state","RW":true},{"Type":"bind","Source":"%s","Destination":"/app/auth","RW":true},{"Type":"bind","Source":"%s","Destination":"/home/node/.cache","RW":true}' \
          "$recordings" "$FAKE_STATE" "$FAKE_AUTH" "$FAKE_CACHE"
        if [ "$FAKE_HOST_SCOPE" = shared ]; then
          printf ',{"Type":"bind","Source":"%s","Destination":"/run/secrets/kassinao-app.env","RW":false},{"Type":"bind","Source":"%s","Destination":"/run/kassinao/storage-mounted","RW":false}' \
            "$FAKE_APP_ENV" "$FAKE_SENTINEL"
        fi
        if [ "$FAKE_EXTRA_MOUNT" = true ]; then
          printf ',{"Type":"bind","Source":"/etc","Destination":"/host-etc","RW":false}'
        fi
        printf ']\\n'
        ;;
      *State.Running*)
        printf 'docker:running-state\n' >> "$EVENT_LOG"
        if grep -Fxq running "$FAKE_CONTAINER_STATE"; then printf 'true\\n'; else printf 'false\\n'; fi
        ;;
      *Config.Image*)
        printf '%s\\n' "$FAKE_IMAGE"
        ;;
      *)
        printf 'docker:health:%s\n' "$FAKE_HEALTH" >> "$EVENT_LOG"
        if grep -Fxq running "$FAKE_CONTAINER_STATE"; then
          printf 'running|%s\\n' "$FAKE_HEALTH"
        else
          printf 'exited|none\\n'
        fi
        ;;
    esac
    ;;
  stop)
    printf 'docker:stop:%s\n' "\${2:-}" >> "$EVENT_LOG"
    printf 'stopped\\n' > "$FAKE_CONTAINER_STATE"
    ;;
  start)
    printf 'docker:start:%s\n' "\${2:-}" >> "$EVENT_LOG"
    printf 'running\\n' > "$FAKE_CONTAINER_STATE"
    ;;
  *)
    printf 'docker:unexpected:%s\n' "$*" >> "$EVENT_LOG"
    exit 1
    ;;
esac
`,
  );

  executable(
    path.join(bin, 'rclone'),
    `#!/usr/bin/env bash
set -eu
[ -z "\${CALLER_CANARY_SECRET:-}" ] || exit 98
operation="\${3:-}"
case "$operation" in
  listremotes)
    printf 'rclone:listremotes\n' >> "$EVENT_LOG"
    printf 'archive-crypt: crypt\\n'
    ;;
  copyto)
    printf 'rclone:copyto\n' >> "$EVENT_LOG"
    cp -- "$4" "$CAPTURE_ARCHIVE"
    ;;
  check)
    printf 'rclone:check\n' >> "$EVENT_LOG"
    ;;
  *)
    printf 'rclone:unexpected:%s\n' "$*" >> "$EVENT_LOG"
    exit 1
    ;;
esac
`,
  );

  executable(
    path.join(bin, 'tar'),
    `#!/usr/bin/env bash
set -eu
case " $* " in
  *' -czf '*)
    if [ "$FAKE_TAR_TRANSIENT_SWAP" = true ]; then
      target="$FAKE_STATE/guild-config.json"
      original=${shellLiteral(path.join(root, 'tar-original'))}
      cp -p -- "$target" "$original"
      printf '{"language":"xx"}\n' > "$target"
      touch -r "$original" "$target"
      /usr/bin/tar "$@"
      status=$?
      cp -p -- "$original" "$target"
      rm -f -- "$original"
      exit "$status"
    fi
    ;;
esac
exec /usr/bin/tar "$@"
`,
  );

  executable(
    path.join(bin, 'flock'),
    `#!/usr/bin/env bash
printf 'flock:%s\n' "$*" >> "$EVENT_LOG"
exit 0
`,
  );

  const systemctl = path.join(bin, 'systemctl');
  executable(
    systemctl,
    `#!/usr/bin/env bash
printf 'systemctl:%s\n' "$*" >> "$EVENT_LOG"
exit "$FAKE_EGRESS_STATUS"
`,
  );

  const hardener = path.join(bin, 'harden-docker-egress');
  executable(
    hardener,
    `#!/usr/bin/env bash
printf 'hardener:%s\n' "$*" >> "$EVENT_LOG"
exit "$FAKE_HARDENER_STATUS"
`,
  );
  const storageVerifier = path.join(bin, 'verify-storage-encryption');
  executable(
    storageVerifier,
    `#!/usr/bin/env bash
printf 'storage:%s:%s\n' "\${KASSINAO_ENV_FILE:-unset}" "$*" >> ${shellLiteral(events)}
exit 0
`,
  );
  const rollbackChecker = path.join(bin, 'check-shared-migration-rollback');
  const rollbackStatusFile = path.join(root, 'rollback.status');
  writeFileSync(rollbackStatusFile, '0\n');
  executable(
    rollbackChecker,
    `#!/usr/bin/env bash
printf 'rollback:%s:%s\n' "\${KASSINAO_ENV_FILE:-unset}" "$*" >> ${shellLiteral(events)}
exit "$(cat -- ${shellLiteral(rollbackStatusFile)})"
`,
  );
  const sharedAuditor = path.join(bin, 'audit-shared-vps-security');
  const sharedAuditStatusFile = path.join(root, 'shared-audit.status');
  const sharedAuditAfterStopStatusFile = path.join(root, 'shared-audit-after-stop.status');
  writeFileSync(sharedAuditStatusFile, '0\n');
  writeFileSync(sharedAuditAfterStopStatusFile, '0\n');
  executable(
    sharedAuditor,
    `#!/usr/bin/env bash
printf 'shared-audit:%s:%s\n' "\${KASSINAO_ENV_FILE:-unset}" "$*" >> ${shellLiteral(events)}
if grep -Fxq stopped ${shellLiteral(containerState)}; then
  exit "$(cat -- ${shellLiteral(sharedAuditAfterStopStatusFile)})"
fi
exit "$(cat -- ${shellLiteral(sharedAuditStatusFile)})"
`,
  );
  executable(
    path.join(bin, 'findmnt'),
    `#!/usr/bin/env bash
printf '%s\n' "$FAKE_DATA"
`,
  );

  const run: BackupFixture['run'] = (options = {}) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      BACKUP_STOP_CONTAINER: 'true',
      CAPTURE_ARCHIVE: archive,
      DOCKER_BIN: docker,
      EVENT_LOG: events,
      FAKE_AUTH: auth,
      FAKE_CACHE: cache,
      FAKE_APP_ENV: path.join(configDirectory, 'app.env'),
      FAKE_CONTAINER_STATE: containerState,
      FAKE_DIVERGENT_MOUNTS: String(options.divergentMounts ?? false),
      FAKE_EXTRA_MOUNT: String(options.extraMount ?? false),
      FAKE_EGRESS_STATUS: options.egressActive === false ? '3' : '0',
      FAKE_HARDENER_STATUS: String(options.hardenerStatus ?? 0),
      FAKE_HEALTH: options.health ?? 'healthy',
      FAKE_IMAGE: `ghcr.io/example/kassinao@sha256:${'a'.repeat(64)}`,
      FAKE_FOREIGN_CONTAINER: String(options.foreignContainer ?? false),
      FAKE_RECORDINGS: recordings,
      FAKE_SENTINEL: path.join(data, '.kassinao-mounted'),
      FAKE_STATE: state,
      FAKE_TAR_TRANSIENT_SWAP: String(options.tarTransientSwap ?? false),
      FAKE_DATA: data,
      FAKE_WRONG_RECORDINGS: wrongRecordings,
      KASSINAO_HARDENER: hardener,
      KASSINAO_ROLLBACK_CHECKER: rollbackChecker,
      KASSINAO_SHARED_AUDITOR: sharedAuditor,
      KASSINAO_STORAGE_VERIFIER: storageVerifier,
      KASSINAO_ENV_FILE: options.envFile ?? envFile,
      KASSINAO_RUNTIME_DIR: runtime,
      RCLONE_CONFIG: options.rcloneConfig ?? config,
      RCLONE_REMOTE: 'archive-crypt:daily',
      SYSTEMCTL_BIN: systemctl,
      CALLER_CANARY_SECRET: 'must-never-reach-backup-child-or-output',
    };
    if (options.hostScope) env.KASSINAO_HOST_SCOPE = options.hostScope;
    for (const name of [
      'AUTH_STATE_DIR',
      'KASSINAO_AUTH_DIR',
      'KASSINAO_DATA_ROOT',
      'KASSINAO_MODEL_CACHE_DIR',
      'KASSINAO_RECORDINGS_DIR',
      'KASSINAO_STATE_DIR',
      'RECORDINGS_DIR',
      'STATE_DIR',
    ]) {
      delete env[name];
    }
    if (!options.pathsFromEnvFile) {
      env.AUTH_STATE_DIR = auth;
      env.KASSINAO_DATA_ROOT = data;
      env.KASSINAO_MODEL_CACHE_DIR = cache;
      env.RECORDINGS_DIR = recordings;
      env.STATE_DIR = state;
    }
    writeFileSync(rollbackStatusFile, `${options.rollbackStatus ?? 0}\n`);
    writeFileSync(sharedAuditStatusFile, `${options.sharedAuditStatus ?? 0}\n`);
    writeFileSync(sharedAuditAfterStopStatusFile, `${options.sharedAuditAfterStopStatus ?? 0}\n`);
    env.FAKE_HOST_SCOPE = 'dedicated';
    try {
      if (readFileSync(options.envFile ?? envFile, 'utf8').includes('KASSINAO_HOST_SCOPE=shared')) {
        env.FAKE_HOST_SCOPE = 'shared';
      }
    } catch {
      // O próprio teste de .env inacessível exporta todos os paths e continua dedicated.
    }
    return spawnSync('bash', [backupScript], {
      encoding: 'utf8',
      env,
    });
  };

  return { archive, auth, cache, config, data, envFile, events, injectedMarker, recordings, root, run, runtime, state };
}

function eventLines(fixture: BackupFixture): string[] {
  return existsSync(fixture.events) ? readFileSync(fixture.events, 'utf8').trim().split('\n') : [];
}

function expectBefore(events: string[], first: string, second: string): void {
  expect(events, `evento ausente: ${first}`).toContain(first);
  expect(events, `evento ausente: ${second}`).toContain(second);
  expect(events.indexOf(first), `${first} deveria ocorrer antes de ${second}`).toBeLessThan(events.indexOf(second));
}

function archiveListing(archive: string): string[] {
  const result = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim().split('\n');
}

function enableShared(fixture: BackupFixture): void {
  writeFileSync(fixture.envFile, `${readFileSync(fixture.envFile, 'utf8').trimEnd()}\nKASSINAO_HOST_SCOPE=shared\n`, {
    mode: 0o600,
  });
}

describe('backup consistente do writer privado', () => {
  it('lê somente os caminhos permitidos de um .env privado sem executar nem expor outros segredos', () => {
    const fixture = createFixture();

    const result = fixture.run({ pathsFromEnvFile: true });

    expect(result.status, result.stderr).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain('do-not-print-or-export');
    expect(existsSync(fixture.injectedMarker)).toBe(false);
    expect(existsSync(path.join(fixture.runtime, 'backup.lock'))).toBe(true);
    expect(existsSync(path.join(fixture.runtime, 'maintenance.lock'))).toBe(true);
    expect(readFileSync(path.join(fixture.runtime, 'backup.lock'), 'utf8')).toBe('backup-sentinel\n');
    expect(readFileSync(path.join(fixture.runtime, 'maintenance.lock'), 'utf8')).toBe('maintenance-sentinel\n');
    expect(archiveListing(fixture.archive)).toContain('./recordings/meeting.txt');
  });

  it('recusa .env permissivo ou não canônico quando precisa ler os caminhos', () => {
    const fixture = createFixture();
    chmodSync(fixture.envFile, 0o640);

    const permissive = fixture.run({ pathsFromEnvFile: true });
    expect(permissive.status).not.toBe(0);
    expect(permissive.stderr).toContain('modo 0600');
    expect(permissive.stderr).not.toContain('do-not-print-or-export');

    chmodSync(fixture.envFile, 0o600);
    const nonCanonical = fixture.run({ envFile: `${fixture.root}//.env`, pathsFromEnvFile: true });
    expect(nonCanonical.status).not.toBe(0);
    expect(nonCanonical.stderr).toContain('caminho canônico');
  });

  it('não abre KASSINAO_ENV_FILE quando todos os caminhos já foram exportados', () => {
    const fixture = createFixture();
    chmodSync(fixture.envFile, 0o000);

    const result = fixture.run();

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(fixture.injectedMarker)).toBe(false);
  });

  it('host scope shared explícito sempre exige e confere o .env selado mesmo com todos os paths exportados', () => {
    const unreadable = createFixture();
    enableShared(unreadable);
    chmodSync(unreadable.envFile, 0o000);

    const missingProof = unreadable.run({ hostScope: 'shared' });

    expect(missingProof.status).not.toBe(0);
    expect(missingProof.stderr).toContain('modo 0600');

    const mismatch = createFixture();
    writeFileSync(
      mismatch.envFile,
      `${readFileSync(mismatch.envFile, 'utf8').trimEnd()}\nKASSINAO_HOST_SCOPE=dedicated\n`,
      { mode: 0o600 },
    );

    const downgraded = mismatch.run({ hostScope: 'shared' });

    expect(downgraded.status).not.toBe(0);
    expect(downgraded.stderr).toContain('KASSINAO_HOST_SCOPE exportado diverge');
  });

  it('no adapter shared vincula o verifier ao .env privado e não aceita paths posicionais', () => {
    const fixture = createFixture();
    enableShared(fixture);

    const result = fixture.run({ pathsFromEnvFile: true });
    const storageEvents = eventLines(fixture).filter((event) => event.startsWith('storage:'));

    expect(result.status, result.stderr).toBe(0);
    expect(storageEvents.length).toBeGreaterThanOrEqual(2);
    expect(storageEvents.every((event) => event === `storage:${fixture.envFile}:`)).toBe(true);
    const rollbackEvents = eventLines(fixture).filter((event) => event.startsWith('rollback:'));
    expect(rollbackEvents.length).toBeGreaterThanOrEqual(2);
    expect(rollbackEvents.every((event) => event === `rollback:${fixture.envFile}:`)).toBe(true);
    expect(eventLines(fixture)).toContain('hardener:--shared-host --check');
    const staticEvents = eventLines(fixture).filter((event) => event.startsWith('shared-audit:'));
    expect(staticEvents.length).toBeGreaterThanOrEqual(2);
    const existingImage = `ghcr.io/example/kassinao@sha256:${'a'.repeat(64)}`;
    expect(staticEvents).toContain(`shared-audit:${fixture.envFile}:--preflight`);
    expect(staticEvents).toContain(
      `shared-audit:${fixture.envFile}:--preflight --expected-existing-image ${existingImage}`,
    );
    expectBefore(
      eventLines(fixture),
      `shared-audit:${fixture.envFile}:--preflight --expected-existing-image ${existingImage}`,
      `docker:start:${CORE_ID}`,
    );
  });

  it('cancela o backup shared antes de parar o writer quando o rollback está inválido', () => {
    const fixture = createFixture();
    enableShared(fixture);

    const result = fixture.run({ pathsFromEnvFile: true, rollbackStatus: 1 });
    const events = eventLines(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('rollback plaintext inválido ou expirado; backup cancelado');
    expect(events).toContain(`rollback:${fixture.envFile}:`);
    expect(events.some((event) => event.startsWith('docker:stop:'))).toBe(false);
    expect(events).not.toContain('rclone:copyto');
  });

  it('recusa um container cujos mounts divergem dos diretórios configurados', () => {
    const fixture = createFixture();

    const result = fixture.run({ divergentMounts: true });
    const events = eventLines(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('não possui exatamente os mounts privados selados');
    expect(events).toContain('docker:mounts');
    expect(events.some((event) => event.startsWith('docker:stop:'))).toBe(false);
    expect(events.some((event) => event.startsWith('docker:start:'))).toBe(false);
    expect(events).not.toContain('rclone:copyto');
    expect(existsSync(fixture.archive)).toBe(false);
  });

  it('recusa qualquer mount extra no writer antes de pará-lo', () => {
    const fixture = createFixture();

    const result = fixture.run({ extraMount: true });
    const events = eventLines(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('não possui exatamente os mounts privados selados');
    expect(events).toContain('docker:mounts');
    expect(events.some((event) => event.startsWith('docker:stop:'))).toBe(false);
    expect(events.some((event) => event.startsWith('docker:start:'))).toBe(false);
  });

  it.each([
    [
      'hardlink de auth para state',
      (fixture: BackupFixture) =>
        linkSync(path.join(fixture.auth, '.cookie-secret'), path.join(fixture.state, 'innocent.bin')),
      'hardlink',
    ],
    [
      'symlink de auth para state',
      (fixture: BackupFixture) =>
        symlinkSync(path.join(fixture.auth, '.cookie-secret'), path.join(fixture.state, 'innocent-link')),
      'symlink',
    ],
    [
      'arquivo especial em state',
      (fixture: BackupFixture) => {
        const fifo = spawnSync('mkfifo', [path.join(fixture.state, 'unexpected.fifo')], { encoding: 'utf8' });
        expect(fifo.status, fifo.stderr).toBe(0);
      },
      'arquivo especial',
    ],
  ] as const)('recusa %s antes de abrir o rclone ou enviar bytes', (_label, mutate, expectedError) => {
    const fixture = createFixture();
    enableShared(fixture);
    mutate(fixture);

    const result = fixture.run({ pathsFromEnvFile: true });
    const events = eventLines(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(expectedError);
    expect(events).toContain(`docker:stop:${CORE_ID}`);
    expect(events).toContain(`docker:start:${CORE_ID}`);
    expect(events.some((event) => event.startsWith('rclone:'))).toBe(false);
  });

  it('detecta conteúdo transitório capturado pelo tar mesmo quando a árvore é restaurada', () => {
    const fixture = createFixture();
    enableShared(fixture);
    const original = readFileSync(path.join(fixture.state, 'guild-config.json'), 'utf8');

    const result = fixture.run({ pathsFromEnvFile: true, tarTransientSwap: true });
    const events = eventLines(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('conteúdo/hash divergente');
    expect(readFileSync(path.join(fixture.state, 'guild-config.json'), 'utf8')).toBe(original);
    expect(events).toContain('rclone:listremotes');
    expect(events).not.toContain('rclone:copyto');
  });

  it.each(['segredo em Config.Env', 'bind extra', 'privileged/capability'])(
    'no shared falha antes do stop quando o auditor encontra %s',
    (_drift) => {
      const fixture = createFixture();
      enableShared(fixture);

      const result = fixture.run({ pathsFromEnvFile: true, sharedAuditStatus: 1 });
      const events = eventLines(fixture);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('contrato estático shared divergiu');
      expect(events).toContain(`shared-audit:${fixture.envFile}:--preflight`);
      expect(events.some((event) => event.startsWith('docker:stop:'))).toBe(false);
      expect(events.some((event) => event.startsWith('docker:start:'))).toBe(false);
    },
  );

  it('mantém o core shared parado se o contrato estático divergir imediatamente antes do restart', () => {
    const fixture = createFixture();
    enableShared(fixture);

    const result = fixture.run({ pathsFromEnvFile: true, sharedAuditAfterStopStatus: 1 });
    const events = eventLines(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('contrato estático shared divergiu');
    expect(events).toContain(`docker:stop:${CORE_ID}`);
    expect(
      events.filter((event) => event.startsWith(`shared-audit:${fixture.envFile}:--preflight`)).length,
    ).toBeGreaterThanOrEqual(2);
    expect(events).not.toContain(`docker:start:${CORE_ID}`);
    expect(events).not.toContain('rclone:copyto');
  });

  it('no shared recusa credencial rclone fora do mount LUKS ou com hardlink', () => {
    const outsideFixture = createFixture();
    enableShared(outsideFixture);
    const outside = path.join(outsideFixture.root, 'outside-rclone.conf');
    writeFileSync(outside, '[archive-crypt]\ntype = crypt\n', { mode: 0o600 });

    const outsideResult = outsideFixture.run({ pathsFromEnvFile: true, rcloneConfig: outside });
    expect(outsideResult.status).not.toBe(0);
    expect(outsideResult.stderr).toContain('DATA_ROOT/config/backup-upload-rclone.conf');
    expect(eventLines(outsideFixture).some((event) => event.startsWith('docker:stop:'))).toBe(false);

    const hardlinkFixture = createFixture();
    enableShared(hardlinkFixture);
    linkSync(hardlinkFixture.config, path.join(hardlinkFixture.root, 'rclone-hardlink.conf'));
    const hardlinkResult = hardlinkFixture.run({ pathsFromEnvFile: true });
    expect(hardlinkResult.status).not.toBe(0);
    expect(hardlinkResult.stderr).toContain('não pode possuir hardlinks');
    expect(eventLines(hardlinkFixture).some((event) => event.startsWith('docker:stop:'))).toBe(false);
  });

  it('recusa name-squatting e não para nem reinicia um container alheio', () => {
    const fixture = createFixture();

    const result = fixture.run({ foreignContainer: true });
    const events = eventLines(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('nome reservado do core pertence a um container com identidade divergente');
    expect(events).toContain('docker:identity');
    expect(events.some((event) => event.startsWith('docker:stop:'))).toBe(false);
    expect(events.some((event) => event.startsWith('docker:start:'))).toBe(false);
    expect(events).not.toContain('rclone:copyto');
  });

  it('para somente o writer provado, exclui auth e sessões e espera health antes de liberar e enviar', () => {
    const fixture = createFixture();

    const result = fixture.run({ health: 'healthy' });
    const events = eventLines(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(events.filter((event) => event === `docker:stop:${CORE_ID}`)).toHaveLength(1);
    expect(events.filter((event) => event === `docker:start:${CORE_ID}`)).toHaveLength(1);
    expect(events.some((event) => event.startsWith('docker:stop:') && event !== `docker:stop:${CORE_ID}`)).toBe(false);
    expectBefore(events, `docker:stop:${CORE_ID}`, `docker:start:${CORE_ID}`);
    expectBefore(events, 'systemctl:is-active --quiet kassinao-docker-egress.service', `docker:start:${CORE_ID}`);
    expectBefore(events, 'hardener:--check', `docker:start:${CORE_ID}`);
    expectBefore(events, `docker:start:${CORE_ID}`, 'docker:health:healthy');
    expectBefore(events, 'docker:health:healthy', 'flock:-u 9');
    expectBefore(events, 'flock:-u 9', 'rclone:copyto');
    expectBefore(events, 'rclone:copyto', 'rclone:check');

    const listing = archiveListing(fixture.archive);
    expect(listing).toContain('./recordings/meeting.txt');
    expect(listing).toContain('./state/guild-config.json');
    expect(listing).toContain('./BACKUP-MANIFEST.txt');
    expect(listing.some((entry) => entry === './auth' || entry.startsWith('./auth/'))).toBe(false);
    expect(listing.some((entry) => /(?:^|\/)web-sessions\.json$/.test(entry))).toBe(false);
    expect(listing.some((entry) => /(?:^|\/)\.mcp-sessions\.json$/.test(entry))).toBe(false);
    expect(result.stdout).toContain('backup consistente e verificado');
  });

  it('falha fechado e não libera nem envia se o writer reiniciado não fica saudável', () => {
    const fixture = createFixture();

    const result = fixture.run({ health: 'unhealthy' });
    const events = eventLines(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('o core não voltou saudável após o snapshot; lock mantido');
    expect(events).toContain(`docker:stop:${CORE_ID}`);
    expect(events).toContain(`docker:start:${CORE_ID}`);
    expect(events).toContain('docker:health:unhealthy');
    expect(events).not.toContain('flock:-u 9');
    expect(events).not.toContain('rclone:copyto');
    expect(events).not.toContain('rclone:check');
    expect(existsSync(fixture.archive)).toBe(false);
  });

  it('mantém o writer parado quando o serviço de egress não está active', () => {
    const fixture = createFixture();

    const result = fixture.run({ egressActive: false });
    const events = eventLines(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('não será reiniciado sem egress active e policy válida');
    expect(events).toContain(`docker:stop:${CORE_ID}`);
    expect(events).toContain('systemctl:is-active --quiet kassinao-docker-egress.service');
    expect(events).not.toContain('hardener:--check');
    expect(events).not.toContain(`docker:start:${CORE_ID}`);
  });

  it('mantém o writer parado quando a policy de egress não passa no hardener', () => {
    const fixture = createFixture();

    const result = fixture.run({ hardenerStatus: 1 });
    const events = eventLines(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('não será reiniciado sem egress active e policy válida');
    expect(events).toContain(`docker:stop:${CORE_ID}`);
    expect(events).toContain('hardener:--check');
    expect(events).not.toContain(`docker:start:${CORE_ID}`);
  });
});
