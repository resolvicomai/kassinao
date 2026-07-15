import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const BACKUP_SCRIPT = path.join(process.cwd(), 'scripts', 'backup.sh');
const tempDirs: string[] = [];

interface BackupFixture {
  archive: string;
  auth: string;
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
    envFile?: string;
    health?: 'healthy' | 'unhealthy';
    pathsFromEnvFile?: boolean;
    egressActive?: boolean;
    hardenerStatus?: number;
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

function createFixture(): BackupFixture {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'kassinao-backup-behavior-')));
  tempDirs.push(root);

  const data = path.join(root, 'data');
  const recordings = path.join(data, 'recordings');
  const state = path.join(data, 'state');
  const auth = path.join(data, 'auth');
  const wrongRecordings = path.join(root, 'wrong-recordings');
  const runtime = path.join(root, 'runtime');
  const bin = path.join(root, 'bin');
  for (const directory of [recordings, state, auth, wrongRecordings, runtime, bin]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  writeFileSync(path.join(recordings, 'meeting.txt'), 'public transcript fixture\n');
  writeFileSync(path.join(state, 'guild-config.json'), '{"language":"pt"}\n');
  writeFileSync(path.join(state, 'web-sessions.json'), '{"session":"must-not-leave"}\n');
  writeFileSync(path.join(state, '.mcp-sessions.json'), '{"session":"must-not-leave"}\n');
  writeFileSync(path.join(auth, '.cookie-secret'), 'cookie-must-not-leave\n');
  writeFileSync(path.join(auth, '.instance-id'), 'instance-must-not-leave\n');
  writeFileSync(path.join(auth, 'web-sessions.json'), '{"session":"must-not-leave"}\n');

  const config = path.join(root, 'rclone.conf');
  writeFileSync(config, '[archive-crypt]\ntype = crypt\n', { mode: 0o600 });
  chmodSync(config, 0o600);

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
command="\${1:-}"
case "$command" in
  inspect)
    if [ "\${2:-}" != "-f" ]; then
      printf 'docker:inspect\n' >> "$EVENT_LOG"
      exit 0
    fi
    template="\${3:-}"
    case "$template" in
      *json*.Mounts*)
        printf 'docker:mounts\n' >> "$EVENT_LOG"
        recordings="$FAKE_RECORDINGS"
        [ "$FAKE_DIVERGENT_MOUNTS" = true ] && recordings="$FAKE_WRONG_RECORDINGS"
        printf '[{"Type":"bind","Source":"%s","Destination":"/app/recordings"},{"Type":"bind","Source":"%s","Destination":"/app/state"},{"Type":"bind","Source":"%s","Destination":"/app/auth"}]\\n' \
          "$recordings" "$FAKE_STATE" "$FAKE_AUTH"
        ;;
      *State.Running*)
        printf 'docker:running-state\n' >> "$EVENT_LOG"
        if grep -Fxq running "$FAKE_CONTAINER_STATE"; then printf 'true\\n'; else printf 'false\\n'; fi
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
printf 'storage:%s\n' "$*" >> "$EVENT_LOG"
exit 0
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
      FAKE_CONTAINER_STATE: containerState,
      FAKE_DIVERGENT_MOUNTS: String(options.divergentMounts ?? false),
      FAKE_EGRESS_STATUS: options.egressActive === false ? '3' : '0',
      FAKE_HARDENER_STATUS: String(options.hardenerStatus ?? 0),
      FAKE_HEALTH: options.health ?? 'healthy',
      FAKE_RECORDINGS: recordings,
      FAKE_STATE: state,
      FAKE_WRONG_RECORDINGS: wrongRecordings,
      KASSINAO_CONTAINER: 'kassinao-test-core',
      KASSINAO_HARDENER: hardener,
      KASSINAO_STORAGE_VERIFIER: storageVerifier,
      KASSINAO_ENV_FILE: options.envFile ?? envFile,
      KASSINAO_RUNTIME_DIR: runtime,
      RCLONE_CONFIG: config,
      RCLONE_REMOTE: 'archive-crypt:daily',
      SYSTEMCTL_BIN: systemctl,
    };
    for (const name of [
      'AUTH_STATE_DIR',
      'KASSINAO_AUTH_DIR',
      'KASSINAO_DATA_ROOT',
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
      env.RECORDINGS_DIR = recordings;
      env.STATE_DIR = state;
    }
    return spawnSync('bash', [BACKUP_SCRIPT], {
      encoding: 'utf8',
      env,
    });
  };

  return { archive, auth, data, envFile, events, injectedMarker, recordings, root, run, runtime, state };
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

describe('backup consistente do writer privado', () => {
  it('lê somente os caminhos permitidos de um .env privado sem executar nem expor outros segredos', () => {
    const fixture = createFixture();

    const result = fixture.run({ pathsFromEnvFile: true });

    expect(result.status, result.stderr).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain('do-not-print-or-export');
    expect(existsSync(fixture.injectedMarker)).toBe(false);
    expect(existsSync(path.join(fixture.runtime, 'backup.lock'))).toBe(true);
    expect(existsSync(path.join(fixture.runtime, 'maintenance.lock'))).toBe(true);
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

  it('recusa um container cujos mounts divergem dos diretórios configurados', () => {
    const fixture = createFixture();

    const result = fixture.run({ divergentMounts: true });
    const events = eventLines(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('não é o writer exato dos três diretórios privados');
    expect(events).toContain('docker:mounts');
    expect(events.some((event) => event.startsWith('docker:stop:'))).toBe(false);
    expect(events.some((event) => event.startsWith('docker:start:'))).toBe(false);
    expect(events).not.toContain('rclone:copyto');
    expect(existsSync(fixture.archive)).toBe(false);
  });

  it('para somente o writer provado, exclui auth e sessões e espera health antes de liberar e enviar', () => {
    const fixture = createFixture();

    const result = fixture.run({ health: 'healthy' });
    const events = eventLines(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(events.filter((event) => event === 'docker:stop:kassinao-test-core')).toHaveLength(1);
    expect(events.filter((event) => event === 'docker:start:kassinao-test-core')).toHaveLength(1);
    expect(events.some((event) => event.startsWith('docker:stop:') && event !== 'docker:stop:kassinao-test-core')).toBe(
      false,
    );
    expectBefore(events, 'docker:stop:kassinao-test-core', 'docker:start:kassinao-test-core');
    expectBefore(
      events,
      'systemctl:is-active --quiet kassinao-docker-egress.service',
      'docker:start:kassinao-test-core',
    );
    expectBefore(events, 'hardener:--check', 'docker:start:kassinao-test-core');
    expectBefore(events, 'docker:start:kassinao-test-core', 'docker:health:healthy');
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
    expect(events).toContain('docker:stop:kassinao-test-core');
    expect(events).toContain('docker:start:kassinao-test-core');
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
    expect(events).toContain('docker:stop:kassinao-test-core');
    expect(events).toContain('systemctl:is-active --quiet kassinao-docker-egress.service');
    expect(events).not.toContain('hardener:--check');
    expect(events).not.toContain('docker:start:kassinao-test-core');
  });

  it('mantém o writer parado quando a policy de egress não passa no hardener', () => {
    const fixture = createFixture();

    const result = fixture.run({ hardenerStatus: 1 });
    const events = eventLines(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('não será reiniciado sem egress active e policy válida');
    expect(events).toContain('docker:stop:kassinao-test-core');
    expect(events).toContain('hardener:--check');
    expect(events).not.toContain('docker:start:kassinao-test-core');
  });
});
