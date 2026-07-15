import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const FINALIZER = path.join(ROOT, 'scripts', 'finalize-shared-migration.sh');
const FINALIZER_SOURCE = readFileSync(FINALIZER, 'utf8');
const temporaryDirectories: string[] = [];

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function executable(file: string, contents: string): void {
  writeFileSync(file, contents, { mode: 0o755 });
  chmodSync(file, 0o755);
}

function treeManifest(root: string): string {
  const lines: string[] = [];
  function visit(absolute: string, relative: string): void {
    const metadata = lstatSync(absolute);
    if (metadata.isDirectory()) {
      lines.push(
        JSON.stringify({
          gid: metadata.gid,
          mode: metadata.mode & 0o7777,
          path: relative,
          type: 'directory',
          uid: metadata.uid,
        }),
      );
      for (const name of readdirSync(absolute).sort()) visit(path.join(absolute, name), `${relative}/${name}`);
      return;
    }
    if (!metadata.isFile() || metadata.nlink !== 1) throw new Error(`invalid fixture entry: ${relative}`);
    const contents = readFileSync(absolute);
    lines.push(
      JSON.stringify({
        gid: metadata.gid,
        mode: metadata.mode & 0o7777,
        path: relative,
        sha256: createHash('sha256').update(contents).digest('hex'),
        size: metadata.size,
        type: 'file',
        uid: metadata.uid,
      }),
    );
  }
  for (const name of ['recordings', 'state', 'auth', 'cache', '.legacy-shared-transition']) {
    if (existsSync(path.join(root, name))) visit(path.join(root, name), name);
  }
  lines.sort((left, right) => {
    const leftPath = String((JSON.parse(left) as { path: string }).path);
    const rightPath = String((JSON.parse(right) as { path: string }).path);
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
  });
  return `${lines.join('\n')}\n`;
}

type FixtureOptions = {
  auditorFails?: boolean;
  badMarkerHash?: boolean;
  badMarkerMode?: boolean;
  badMarkerPath?: boolean;
  bundleTampered?: boolean;
  crashAfterRollbackRemoval?: boolean;
  expired?: boolean;
  hardlinkInRollback?: boolean;
  hardlinkedMarker?: boolean;
  legacyPurgeIncomplete?: boolean;
  missingPending?: boolean;
  omitLegacyControl?: boolean;
  nestedMount?: boolean;
  pendingRemovalFails?: boolean;
  publishFails?: boolean;
  purgingRemovalFails?: boolean;
  purgedAlreadyExists?: boolean;
  restartPolicy?: string;
  rollbackMounted?: boolean;
  rollbackRemovalFails?: boolean;
  partialRollbackRemovalFails?: boolean;
  runningContainer?: boolean;
  symlinkInRollback?: boolean;
  treeTampered?: boolean;
  verifierFails?: boolean;
};

function fixture(options: FixtureOptions = {}) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'kassinao-shared-finalize-')));
  temporaryDirectories.push(directory);
  chmodSync(directory, 0o700);
  const scripts = path.join(directory, 'scripts');
  const dockerClient = path.join(directory, 'deploy', 'docker-client');
  const bin = path.join(directory, 'bin');
  const runtime = path.join(directory, 'runtime');
  const dataRoot = path.join(directory, 'data');
  const rollback = `${dataRoot}.plaintext-before-shared-luks`;
  const pending = path.join(dataRoot, '.kassinao-plaintext-rollback.pending');
  const purging = path.join(dataRoot, '.kassinao-plaintext-rollback.purging');
  const purged = path.join(dataRoot, '.kassinao-plaintext-rollback.purged');
  const persistedManifest = path.join(dataRoot, '.kassinao-migration-manifest.jsonl');
  const operations = path.join(directory, 'operations.log');
  const mountInventory = path.join(directory, 'mounts.json');
  const dockerInventory = path.join(directory, 'docker-source.json');
  const rollbackRemovalFailure = path.join(directory, 'rollback-removal-failure.once');
  const partialRollbackRemovalFailure = path.join(directory, 'partial-rollback-removal-failure.once');
  const crashAfterRollbackRemoval = path.join(directory, 'crash-after-rollback-removal.once');
  const publishFailure = path.join(directory, 'publish-failure.once');
  const purgingRemovalFailure = path.join(directory, 'purging-removal-failure.once');
  const pendingRemovalFailure = path.join(directory, 'pending-removal-failure.once');
  const uid = process.getuid?.() ?? 501;
  const gid = process.getgid?.() ?? 20;
  mkdirSync(scripts, { mode: 0o700 });
  mkdirSync(dockerClient, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dockerClient, 'config.json'), '{}\n', { mode: 0o444 });
  mkdirSync(bin, { mode: 0o700 });
  mkdirSync(runtime, { mode: 0o700 });
  mkdirSync(dataRoot, { mode: 0o700 });
  mkdirSync(rollback, { mode: 0o700 });
  chmodSync(runtime, 0o700);
  writeFileSync(path.join(runtime, 'maintenance.lock'), 'maintenance-sentinel\n', { mode: 0o600 });
  chmodSync(dataRoot, 0o700);
  chmodSync(rollback, 0o700);
  if (options.rollbackRemovalFails) writeFileSync(rollbackRemovalFailure, 'once\n');
  if (options.partialRollbackRemovalFails) writeFileSync(partialRollbackRemovalFailure, 'once\n');
  if (options.crashAfterRollbackRemoval) writeFileSync(crashAfterRollbackRemoval, 'once\n');
  if (options.publishFails) writeFileSync(publishFailure, 'once\n');
  if (options.purgingRemovalFails) writeFileSync(purgingRemovalFailure, 'once\n');
  if (options.pendingRemovalFails) writeFileSync(pendingRemovalFailure, 'once\n');

  const activeFiles: string[] = [];
  for (const name of ['recordings', 'state', 'auth', 'cache']) {
    const activeDirectory = path.join(dataRoot, name);
    const rollbackDirectory = path.join(rollback, name);
    mkdirSync(activeDirectory, { mode: 0o700 });
    mkdirSync(rollbackDirectory, { mode: 0o700 });
    chmodSync(activeDirectory, 0o700);
    chmodSync(rollbackDirectory, 0o700);
    const contents = `${name}-private-bytes\n`;
    const activeFile = path.join(activeDirectory, `${name}.data`);
    const rollbackFile = path.join(rollbackDirectory, `${name}.data`);
    writeFileSync(activeFile, contents, { mode: 0o640 });
    writeFileSync(rollbackFile, contents, { mode: 0o640 });
    chmodSync(activeFile, 0o640);
    chmodSync(rollbackFile, 0o640);
    activeFiles.push(activeFile);
  }
  const legacyRoot = path.join(directory, 'legacy-release');
  const legacyRecordings = path.join(legacyRoot, 'recordings');
  const legacyCache = path.join(directory, 'docker-volumes', 'kassinao_model-cache', '_data');
  mkdirSync(legacyRecordings, { recursive: true, mode: 0o700 });
  mkdirSync(legacyCache, { recursive: true, mode: 0o700 });
  const sourceManifest = '{"path":"recordings","type":"directory"}\n';
  const sourceManifestHash = createHash('sha256').update(sourceManifest).digest('hex');
  const sourceProofs = {
    recordings: {
      expected_path: legacyRecordings,
      identity: { dev: statSync(legacyRecordings).dev, ino: statSync(legacyRecordings).ino },
      kind: 'bind',
    },
    cache: {
      compose_project: 'kassinao',
      compose_volume: 'model-cache',
      driver: 'local',
      identity: { dev: statSync(legacyCache).dev, ino: statSync(legacyCache).ino },
      kind: 'volume',
      mountpoint: legacyCache,
      name: 'kassinao_model-cache',
      scope: 'local',
    },
  };
  if (!options.omitLegacyControl) {
    for (const [root, status] of [
      [dataRoot, options.legacyPurgeIncomplete ? 'prepared' : 'purged'],
      [rollback, 'prepared'],
    ] as const) {
      const control = path.join(root, '.legacy-shared-transition');
      mkdirSync(control, { mode: 0o700 });
      const layout = {
        current_root: legacyRoot,
        data_root: dataRoot,
        legacy_env_proof: { path: path.join(legacyRoot, '.env') },
        legacy_env_status: status === 'purged' ? 'removed' : 'present',
        source_manifest_sha256: sourceManifestHash,
        source_proofs: sourceProofs,
        sources: { cache: legacyCache, recordings: legacyRecordings },
        status,
        legacy_runtime_uid: uid,
        legacy_runtime_gid: gid,
        version: 3,
      };
      writeFileSync(path.join(control, 'layout.json'), `${JSON.stringify(layout)}\n`, { mode: 0o600 });
      writeFileSync(path.join(control, 'source-manifest.jsonl'), sourceManifest, { mode: 0o600 });
    }
  }
  const activeBefore = activeFiles.map((file) => readFileSync(file, 'hex'));

  const manifestContents = treeManifest(rollback);
  writeFileSync(persistedManifest, manifestContents, { mode: 0o400 });
  chmodSync(persistedManifest, 0o400);
  const manifestHash = createHash('sha256').update(manifestContents).digest('hex');
  const migrationId = '4f36b987a1054b90a0ec7ee0dcb6f78a';
  const now = Math.floor(Date.now() / 1000);
  const createdAt = options.expired ? now - 10 * 3600 : now - 60;
  const deadline = createdAt + 2 * 3600;
  const markerContents = [
    'kassinao-shared-plaintext-rollback-v1',
    'status=pending',
    `migration_id=${migrationId}`,
    `manifest_sha256=${options.badMarkerHash ? '0'.repeat(64) : manifestHash}`,
    `rollback_path=${options.badMarkerPath ? `${rollback}.other` : rollback}`,
    `created_at=${createdAt}`,
    `deadline=${deadline}`,
    '',
  ].join('\n');
  writeFileSync(pending, markerContents, { mode: options.badMarkerMode ? 0o600 : 0o400 });
  chmodSync(pending, options.badMarkerMode ? 0o600 : 0o400);
  if (options.hardlinkedMarker) linkSync(pending, path.join(dataRoot, '.pending-hardlink'));
  if (options.missingPending) unlinkSync(pending);
  if (options.purgedAlreadyExists) {
    writeFileSync(purged, markerContents.replace('status=pending', 'status=purged'), { mode: 0o400 });
    chmodSync(purged, 0o400);
  }
  if (options.treeTampered) writeFileSync(path.join(rollback, 'state', 'state.data'), 'changed\n');
  if (options.hardlinkInRollback) {
    linkSync(path.join(rollback, 'state', 'state.data'), path.join(rollback, 'state', 'state-copy.data'));
  }
  if (options.symlinkInRollback) {
    const target = path.join(rollback, 'auth', 'auth.data');
    unlinkSync(target);
    symlinkSync('/etc/passwd', target);
  }

  const envFile = path.join(directory, '.env');
  writeFileSync(
    envFile,
    [
      'KASSINAO_HOST_SCOPE=shared',
      'KASSINAO_DEDICATED_DOCKER_HOST_ACK=',
      `KASSINAO_DATA_ROOT=${dataRoot}`,
      `KASSINAO_RECORDINGS_DIR=${dataRoot}/recordings`,
      `KASSINAO_STATE_DIR=${dataRoot}/state`,
      `KASSINAO_AUTH_DIR=${dataRoot}/auth`,
      `KASSINAO_MODEL_CACHE_DIR=${dataRoot}/cache`,
      'KASSINAO_ROLLBACK_RETENTION_HOURS=72',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  chmodSync(envFile, 0o600);

  const finalizer = path.join(scripts, 'finalize-shared-migration.sh');
  const verifier = path.join(scripts, 'verify-shared-luks-storage.sh');
  const auditor = path.join(scripts, 'audit-shared-vps-security.sh');
  executable(
    finalizer,
    FINALIZER_SOURCE.replace(
      /# KASSINAO_HOST_ENV_SCRUB_BEGIN[\s\S]*?# KASSINAO_HOST_ENV_SCRUB_END/,
      '# KASSINAO_HOST_ENV_SCRUB_BEGIN\nSAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nunset DISCORD_TOKEN LUKS_PASSPHRASE\nexport PATH="$SAFE_SYSTEM_PATH" HOME=/root LC_ALL=C TMPDIR=/tmp\n_saved_no_dump_marker=""\n_saved_no_dump_preload=""\n_inherited_docker_environment_name=""\n_runtime_override_present=false\n# KASSINAO_HOST_ENV_SCRUB_END',
    )
      .replace(
        /# KASSINAO_HOST_NO_DUMP_BEGIN[\s\S]*?# KASSINAO_HOST_NO_DUMP_END/,
        '# KASSINAO_HOST_NO_DUMP_BEGIN\nunset LD_PRELOAD\n# KASSINAO_HOST_NO_DUMP_END',
      )
      .replace(
        'SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        `SAFE_SYSTEM_PATH=${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      )
      .replace('RUNTIME_DIR=/run/lock/kassinao', `RUNTIME_DIR=${runtime}`)
      .replace(
        /# KASSINAO_LOCK_FD_PROOF_BEGIN[\s\S]*?# KASSINAO_LOCK_FD_PROOF_END/,
        '# KASSINAO_LOCK_FD_PROOF_BEGIN\n:\n# KASSINAO_LOCK_FD_PROOF_END',
      )
      .replace('[ "$EUID" -eq 0 ] || die \'execute como root\'', ':')
      .replace('metadata.st_uid != 0 or metadata.st_gid != 0', `metadata.st_uid != ${uid} or metadata.st_gid != ${gid}`)
      .replace('before.st_uid != 0 or before.st_gid != 0', `before.st_uid != ${uid} or before.st_gid != ${gid}`),
  );
  executable(
    verifier,
    `#!/usr/bin/env bash
set -eu
[ -z "\${DISCORD_TOKEN:-}" ] && [ -z "\${LUKS_PASSPHRASE:-}" ] || exit 91
[ "\${KASSINAO_ENV_FILE:-}" = ${shellLiteral(envFile)} ] || exit 92
printf 'verifier:%s\n' "$*" >> ${shellLiteral(operations)}
[ ${options.verifierFails ? 'true' : 'false'} = false ] || exit 46
`,
  );
  executable(
    auditor,
    `#!/usr/bin/env bash
set -eu
[ -z "\${DISCORD_TOKEN:-}" ] && [ -z "\${LUKS_PASSPHRASE:-}" ] || exit 91
[ "\${KASSINAO_ENV_FILE:-}" = ${shellLiteral(envFile)} ] || exit 92
[ "$#" -eq 1 ] && [ "$1" = --neighbors-only ] || exit 93
printf 'auditor:%s\n' "$*" >> ${shellLiteral(operations)}
[ ${options.auditorFails ? 'true' : 'false'} = false ] || exit 47
`,
  );

  const manifestLines = [
    'scripts/finalize-shared-migration.sh',
    'scripts/verify-shared-luks-storage.sh',
    'scripts/audit-shared-vps-security.sh',
  ].map((name) => {
    const digest = createHash('sha256')
      .update(readFileSync(path.join(directory, name)))
      .digest('hex');
    return `${digest}  ${name}`;
  });
  writeFileSync(path.join(directory, 'MANIFEST.sha256'), `${manifestLines.join('\n')}\n`, { mode: 0o600 });
  chmodSync(path.join(directory, 'MANIFEST.sha256'), 0o600);
  if (options.bundleTampered) writeFileSync(auditor, `${readFileSync(auditor, 'utf8')}# tampered\n`);

  const containers = [
    {
      Id: 'kassinao-id',
      Name: '/kassinao',
      Config: {
        Labels: {
          'com.docker.compose.project': 'kassinao',
          'com.docker.compose.service': 'kassinao',
        },
      },
      State: { Running: options.runningContainer === true },
      HostConfig: { RestartPolicy: { Name: options.restartPolicy ?? 'no' } },
    },
    {
      Id: 'neighbor-id',
      Name: '/company-app',
      Config: { Labels: {} },
      State: { Running: true },
      HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
    },
  ];
  writeFileSync(dockerInventory, `${JSON.stringify(containers)}\n`);
  writeFileSync(
    mountInventory,
    `${JSON.stringify(
      options.nestedMount ? { filesystems: [{ target: path.join(rollback, 'state') }] } : { filesystems: [] },
    )}\n`,
  );

  executable(path.join(bin, 'id'), '#!/usr/bin/env bash\n[ "${1:-}" = -u ] && printf "0\\n"\n');
  executable(path.join(bin, 'chown'), '#!/usr/bin/env bash\nexit 0\n');
  executable(path.join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n');
  executable(
    path.join(bin, 'readlink'),
    `#!/usr/bin/env bash
set -eu
last=''
for value in "$@"; do last="$value"; done
python3 - "$last" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
`,
  );
  executable(
    path.join(bin, 'stat'),
    `#!/usr/bin/env bash
set -eu
format=''
target=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -c) format="$2"; shift 2 ;;
    --) shift ;;
    *) target="$1"; shift ;;
  esac
done
python3 - "$format" "$target" <<'PY'
import os, stat, sys
format_string, target = sys.argv[1:]
metadata = os.lstat(target)
values = {
    '%a': format(stat.S_IMODE(metadata.st_mode), 'o'),
    '%u': '0',
    '%g': '0',
    '%h': str(metadata.st_nlink),
}
result = format_string
for key, value in values.items():
    result = result.replace(key, value)
print(result)
PY
`,
  );
  executable(
    path.join(bin, 'sha256sum'),
    `#!/usr/bin/env bash
set -eu
last=''
for value in "$@"; do last="$value"; done
if [ "$last" = ${shellLiteral(path.join(dockerClient, 'config.json'))} ]; then
  printf 'ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356  %s\n' "$last"
  exit 0
fi
python3 - ${shellLiteral(directory)} <<'PY'
import hashlib, os, sys
root = sys.argv[1]
with open(os.path.join(root, 'MANIFEST.sha256'), encoding='utf-8') as source:
    for raw in source:
        expected, relative = raw.rstrip('\\n').split('  ', 1)
        relative = relative.removeprefix('./')
        with open(os.path.join(root, relative), 'rb') as controlled:
            actual = hashlib.sha256(controlled.read()).hexdigest()
        if actual != expected:
            raise SystemExit(1)
PY
`,
  );
  executable(
    path.join(bin, 'docker'),
    `#!/usr/bin/env bash
set -eu
[ -z "\${DISCORD_TOKEN:-}" ] && [ -z "\${LUKS_PASSPHRASE:-}" ] || exit 91
printf 'docker:%s\n' "$*" >> ${shellLiteral(operations)}
case "\${1:-}" in
  info) printf '29.0.1\n' ;;
  ps) printf 'kassinao-id\nneighbor-id\n' ;;
  inspect)
    python3 - ${shellLiteral(dockerInventory)} <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf-8') as source:
    for item in json.load(source):
        print(json.dumps(item, separators=(',', ':')))
PY
    ;;
  *) exit 90 ;;
esac
`,
  );
  executable(path.join(bin, 'findmnt'), `#!/usr/bin/env bash\ncat ${shellLiteral(mountInventory)}\n`);
  executable(
    path.join(bin, 'mountpoint'),
    `#!/usr/bin/env bash
[ ${options.rollbackMounted ? 'true' : 'false'} = true ]
`,
  );
  executable(
    path.join(bin, 'rm'),
    `#!/usr/bin/env bash
set -u
if [ "\${1:-}" = --version ]; then printf 'rm (GNU coreutils) 9.5\n'; exit 0; fi
printf 'rm:%s\n' "$*" >> ${shellLiteral(operations)}
last=''
for value in "$@"; do last="$value"; done
if [ "$last" = ${shellLiteral(rollback)} ]; then
  case " $* " in *' --one-file-system '*) ;; *) exit 81 ;; esac
  if [ -f ${shellLiteral(rollbackRemovalFailure)} ]; then
    /bin/rm -f -- ${shellLiteral(rollbackRemovalFailure)}
    exit 82
  fi
  if [ -f ${shellLiteral(partialRollbackRemovalFailure)} ]; then
    /bin/rm -f -- ${shellLiteral(partialRollbackRemovalFailure)}
    /bin/rm -f -- ${shellLiteral(path.join(rollback, 'recordings', 'recordings.data'))}
    exit 82
  fi
  /bin/rm -rf -- "$last" || exit $?
  if [ -f ${shellLiteral(crashAfterRollbackRemoval)} ]; then
    /bin/rm -f -- ${shellLiteral(crashAfterRollbackRemoval)}
    kill -KILL "$PPID"
  fi
  exit 0
fi
if [ "$last" = ${shellLiteral(pending)} ] && [ -f ${shellLiteral(pendingRemovalFailure)} ]; then
  /bin/rm -f -- ${shellLiteral(pendingRemovalFailure)}
  exit 83
fi
if [ "$last" = ${shellLiteral(purging)} ] && [ -f ${shellLiteral(purgingRemovalFailure)} ]; then
  /bin/rm -f -- ${shellLiteral(purgingRemovalFailure)}
  exit 85
fi
exec /bin/rm "$@"
`,
  );
  executable(
    path.join(bin, 'mv'),
    `#!/usr/bin/env bash
set -eu
printf 'mv:%s\n' "$*" >> ${shellLiteral(operations)}
last=''
for value in "$@"; do last="$value"; done
if [ "$last" = ${shellLiteral(purged)} ] && [ -f ${shellLiteral(publishFailure)} ]; then
  /bin/rm -f -- ${shellLiteral(publishFailure)}
  exit 84
fi
exec /bin/mv "$@"
`,
  );
  executable(path.join(bin, 'sync'), `#!/usr/bin/env bash\nprintf 'sync:%s\n' "$*" >> ${shellLiteral(operations)}\n`);

  function run(args = ['--confirm-destroy-plaintext-rollback']) {
    return spawnSync('bash', [finalizer, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: process.env.PATH ?? '',
        DISCORD_TOKEN: 'inherited-discord-secret',
        LUKS_PASSPHRASE: 'inherited-luks-secret',
      },
      timeout: 15_000,
    });
  }

  return {
    activeBefore,
    activeFiles,
    createdAt,
    dataRoot,
    deadline,
    directory,
    finalizer,
    manifestHash,
    migrationId,
    operations,
    pending,
    persistedManifest,
    purging,
    purged,
    rollback,
    run,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('finalização manual do rollback plaintext shared', () => {
  it('mantém compatibilidade com migração sem consolidação e sem controle legado', () => {
    const value = fixture({ omitLegacyControl: true });
    const result = value.run();
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(existsSync(value.rollback)).toBe(false);
  });

  it('recusa destruir rollback quando o controle legado não prova purge de sources e .env', () => {
    const value = fixture({ legacyPurgeIncomplete: true });
    const result = value.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('não prova purge prévio');
    expect(existsSync(value.rollback)).toBe(true);
  });

  it('expõe uma única confirmação e sanitiza ambiente/PATH antes de qualquer comando', () => {
    expect(FINALIZER_SOURCE).toContain('--confirm-destroy-plaintext-rollback');
    expect(FINALIZER_SOURCE).not.toMatch(/docker\s+(stop|start|restart|update|rm)\b/);
    expect(FINALIZER_SOURCE).not.toMatch(/^\s*(shred|wipefs|cryptsetup|systemctl|mount|umount)\b/m);
    expect(FINALIZER_SOURCE.match(/rm -rf --one-file-system -- "\$rollback_path"/g)).toHaveLength(1);
    expect(FINALIZER_SOURCE).toContain('export PATH="$SAFE_SYSTEM_PATH" HOME=/root LC_ALL=C');
    expect(FINALIZER_SOURCE.indexOf('unset "$inherited_name"')).toBeLessThan(
      FINALIZER_SOURCE.indexOf('command -v "$command"'),
    );
    const aFixture = fixture();
    const result = aFixture.run([]);
    expect(result.status).not.toBe(0);
    expect(existsSync(aFixture.rollback)).toBe(true);
    expect(existsSync(aFixture.operations) ? readFileSync(aFixture.operations, 'utf8') : '').toBe('');
  });

  it('remove somente o sibling, preserva dados ativos e publica receipt purged estrito', () => {
    const aFixture = fixture();
    const result = aFixture.run();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(aFixture.rollback)).toBe(false);
    expect(existsSync(aFixture.pending)).toBe(false);
    expect(existsSync(aFixture.purging)).toBe(false);
    expect(existsSync(aFixture.purged)).toBe(true);
    expect(statSync(aFixture.purged).mode & 0o777).toBe(0o400);
    expect(aFixture.activeFiles.map((file) => readFileSync(file, 'hex'))).toEqual(aFixture.activeBefore);
    expect(existsSync(aFixture.persistedManifest)).toBe(true);
    const receipt = readFileSync(aFixture.purged, 'utf8').split('\n');
    expect(receipt.slice(0, 7)).toEqual([
      'kassinao-shared-plaintext-rollback-v1',
      'status=purged',
      `migration_id=${aFixture.migrationId}`,
      `manifest_sha256=${aFixture.manifestHash}`,
      `rollback_path=${aFixture.rollback}`,
      `created_at=${aFixture.createdAt}`,
      `deadline=${aFixture.deadline}`,
    ]);
    expect(receipt[7]).toMatch(/^purged_at=[1-9][0-9]*$/);
    expect(receipt).toHaveLength(9);
    const operations = readFileSync(aFixture.operations, 'utf8');
    expect(operations).toContain(`rm:-rf --one-file-system -- ${aFixture.rollback}`);
    expect(operations.match(/verifier:/g)).toHaveLength(2);
    expect(operations.match(/auditor:--neighbors-only/g)).toHaveLength(2);
    expect(`${result.stdout}${result.stderr}${operations}`).not.toContain('inherited-discord-secret');
    expect(`${result.stdout}${result.stderr}`).not.toContain(aFixture.manifestHash);
    expect(`${result.stdout}${result.stderr}`).not.toContain(aFixture.migrationId);
    expect(result.stdout).toContain('não comprova secure erase');
  }, 30_000);

  it.each([
    ['bundle adulterado', { bundleTampered: true }],
    ['verifier reprovado', { verifierFails: true }],
    ['auditor reprovado', { auditorFails: true }],
    ['container rodando', { runningContainer: true }],
    ['restart policy armada', { restartPolicy: 'unless-stopped' }],
    ['marker com hash divergente', { badMarkerHash: true }],
    ['marker com path divergente', { badMarkerPath: true }],
    ['marker com modo divergente', { badMarkerMode: true }],
    ['marker ausente', { missingPending: true }],
    ['marker com hardlink', { hardlinkedMarker: true }],
    ['receipt pré-existente', { purgedAlreadyExists: true }],
    ['árvore com bytes divergentes', { treeTampered: true }],
    ['árvore com symlink', { symlinkInRollback: true }],
    ['árvore com hardlink', { hardlinkInRollback: true }],
    ['rollback montado', { rollbackMounted: true }],
    ['mount aninhado', { nestedMount: true }],
  ])('falha fechado antes de apagar: %s', (_label, options) => {
    const aFixture = fixture(options as FixtureOptions);
    const result = aFixture.run();
    expect(result.status).not.toBe(0);
    expect(existsSync(aFixture.rollback)).toBe(true);
    expect(existsSync(aFixture.pending)).toBe(options.missingPending !== true);
    expect(existsSync(aFixture.purging)).toBe(false);
    expect(existsSync(aFixture.purged)).toBe(options.purgedAlreadyExists === true);
    const operations = existsSync(aFixture.operations) ? readFileSync(aFixture.operations, 'utf8') : '';
    expect(operations).not.toContain(`rm:-rf --one-file-system -- ${aFixture.rollback}`);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).not.toContain(aFixture.directory);
    expect(output).not.toContain(aFixture.manifestHash);
    expect(output).not.toContain(aFixture.migrationId);
    expect(output).not.toContain('auth.data');
  });

  it('permite finalizar um marker vencido sem apagar a evidência antes dos gates', () => {
    const aFixture = fixture({ expired: true });
    const result = aFixture.run();
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(aFixture.rollback)).toBe(false);
    expect(existsSync(aFixture.purged)).toBe(true);
  }, 30_000);

  it('retoma depois que GNU rm falha sem reautorizar nem apagar outro path', () => {
    const aFixture = fixture({ rollbackRemovalFails: true });
    const interrupted = aFixture.run();
    expect(interrupted.status).not.toBe(0);
    expect(existsSync(aFixture.rollback)).toBe(true);
    expect(existsSync(aFixture.pending)).toBe(true);
    expect(existsSync(aFixture.purging)).toBe(true);
    expect(existsSync(aFixture.purged)).toBe(false);
    expect(`${interrupted.stdout}${interrupted.stderr}`).not.toContain(aFixture.directory);

    const resumed = aFixture.run();
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(existsSync(aFixture.rollback)).toBe(false);
    expect(existsSync(aFixture.pending)).toBe(false);
    expect(existsSync(aFixture.purging)).toBe(false);
    expect(existsSync(aFixture.purged)).toBe(true);
  }, 30_000);

  it('retoma uma deleção parcial somente porque o marker purging já tornou a autorização durável', () => {
    const aFixture = fixture({ partialRollbackRemovalFails: true });
    const interrupted = aFixture.run();
    expect(interrupted.status).not.toBe(0);
    expect(existsSync(aFixture.rollback)).toBe(true);
    expect(existsSync(path.join(aFixture.rollback, 'recordings', 'recordings.data'))).toBe(false);
    expect(existsSync(aFixture.pending)).toBe(true);
    expect(existsSync(aFixture.purging)).toBe(true);
    expect(existsSync(aFixture.purged)).toBe(false);
    expect(`${interrupted.stdout}${interrupted.stderr}`).not.toContain(aFixture.directory);

    const resumed = aFixture.run();
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(existsSync(aFixture.rollback)).toBe(false);
    expect(existsSync(aFixture.pending)).toBe(false);
    expect(existsSync(aFixture.purging)).toBe(false);
    expect(existsSync(aFixture.purged)).toBe(true);
  }, 30_000);

  it('retoma depois de SIGKILL entre o rm durável e a publicação do receipt', () => {
    const aFixture = fixture({ crashAfterRollbackRemoval: true });
    const interrupted = aFixture.run();
    expect(interrupted.signal).toBe('SIGKILL');
    expect(existsSync(aFixture.rollback)).toBe(false);
    expect(existsSync(aFixture.pending)).toBe(true);
    expect(existsSync(aFixture.purging)).toBe(true);
    expect(existsSync(aFixture.purged)).toBe(false);

    const resumed = aFixture.run();
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(existsSync(aFixture.pending)).toBe(false);
    expect(existsSync(aFixture.purging)).toBe(false);
    expect(existsSync(aFixture.purged)).toBe(true);
  }, 30_000);

  it('retoma depois de falha atômica ao publicar purged', () => {
    const aFixture = fixture({ publishFails: true });
    const interrupted = aFixture.run();
    expect(interrupted.status).not.toBe(0);
    expect(existsSync(aFixture.rollback)).toBe(false);
    expect(existsSync(aFixture.pending)).toBe(true);
    expect(existsSync(aFixture.purging)).toBe(true);
    expect(existsSync(aFixture.purged)).toBe(false);

    const resumed = aFixture.run();
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(existsSync(aFixture.pending)).toBe(false);
    expect(existsSync(aFixture.purging)).toBe(false);
    expect(existsSync(aFixture.purged)).toBe(true);
  }, 30_000);

  it('retoma quando o receipt ficou durável antes de limpar pending e purging', () => {
    const aFixture = fixture({ purgingRemovalFails: true });
    const interrupted = aFixture.run();
    expect(interrupted.status).not.toBe(0);
    expect(existsSync(aFixture.rollback)).toBe(false);
    expect(existsSync(aFixture.pending)).toBe(true);
    expect(existsSync(aFixture.purging)).toBe(true);
    expect(existsSync(aFixture.purged)).toBe(true);

    const resumed = aFixture.run();
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(existsSync(aFixture.pending)).toBe(false);
    expect(existsSync(aFixture.purging)).toBe(false);
    expect(existsSync(aFixture.purged)).toBe(true);
  }, 30_000);

  it('retoma a limpeza de markers depois de purged já estar durável', () => {
    const aFixture = fixture({ pendingRemovalFails: true });
    const interrupted = aFixture.run();
    expect(interrupted.status).not.toBe(0);
    expect(existsSync(aFixture.rollback)).toBe(false);
    expect(existsSync(aFixture.pending)).toBe(true);
    expect(existsSync(aFixture.purging)).toBe(false);
    expect(existsSync(aFixture.purged)).toBe(true);

    const resumed = aFixture.run();
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(existsSync(aFixture.pending)).toBe(false);
    expect(existsSync(aFixture.purging)).toBe(false);
    expect(existsSync(aFixture.purged)).toBe(true);
  }, 30_000);

  it('é idempotente quando o receipt final já está completo', () => {
    const aFixture = fixture();
    expect(aFixture.run().status).toBe(0);
    const receiptBefore = readFileSync(aFixture.purged, 'utf8');

    const repeated = aFixture.run();
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(readFileSync(aFixture.purged, 'utf8')).toBe(receiptBefore);
    expect(existsSync(aFixture.pending)).toBe(false);
    expect(existsSync(aFixture.purging)).toBe(false);
    expect(existsSync(aFixture.rollback)).toBe(false);
  }, 30_000);
});
