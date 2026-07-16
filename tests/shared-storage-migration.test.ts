import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const MIGRATOR = path.join(ROOT, 'scripts', 'migrate-shared-storage.sh');
const source = readFileSync(MIGRATOR, 'utf8');

const COLOCATED_FIXTURE_FILES = {
  'autorecord.json': '{"enabled":true}\n',
  '.recording-admission.json': '{"admitted":true}\n',
  '.discord-surface-inventory.json': '{"surfaces":[]}\n',
  '.cookie-secret': 'fixture-cookie-secret\n',
  '.web-sessions.json': '{"sessions":[]}\n',
  '.mcp-sessions.json': '{"sessions":[]}\n',
} as const;

const COLOCATED_TARGETS = {
  'autorecord.json': { tree: 'state', name: 'autorecord.json' },
  '.recording-admission.json': { tree: 'state', name: 'recording-admission.json' },
  '.discord-surface-inventory.json': { tree: 'state', name: 'discord-surface-inventory.json' },
  '.cookie-secret': { tree: 'auth', name: '.cookie-secret' },
  '.web-sessions.json': { tree: 'auth', name: 'web-sessions.json' },
  '.mcp-sessions.json': { tree: 'auth', name: 'mcp-sessions.json' },
} as const;

function treeManifest(root: string, includeControl = false): string {
  const records: Array<Record<string, unknown>> = [];
  function visit(absolute: string, relative: string): void {
    const metadata = lstatSync(absolute);
    if (metadata.isDirectory()) {
      records.push({
        gid: metadata.gid,
        mode: metadata.mode & 0o7777,
        path: relative,
        type: 'directory',
        uid: metadata.uid,
      });
      for (const name of readdirSync(absolute).sort()) visit(path.join(absolute, name), `${relative}/${name}`);
      return;
    }
    if (!metadata.isFile() || metadata.nlink !== 1) throw new Error(`invalid fixture entry: ${relative}`);
    const contents = readFileSync(absolute);
    records.push({
      gid: metadata.gid,
      mode: metadata.mode & 0o7777,
      path: relative,
      sha256: createHash('sha256').update(contents).digest('hex'),
      size: metadata.size,
      type: 'file',
      uid: metadata.uid,
    });
  }
  const topLevels = ['recordings', 'state', 'auth', 'cache'];
  if (includeControl) topLevels.push('.legacy-shared-transition');
  for (const name of topLevels) {
    visit(path.join(root, name), name);
  }
  records.sort((left, right) =>
    String(left.path) < String(right.path) ? -1 : String(left.path) > String(right.path) ? 1 : 0,
  );
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function executable(file: string, contents: string): void {
  writeFileSync(file, contents);
  chmodSync(file, 0o755);
}

type FixtureOptions = {
  activeRecording?: boolean;
  corruptCopy?: boolean;
  extraTopLevel?: boolean;
  finalVerifierFails?: boolean;
  foreignWriter?: boolean;
  importLegacyAppEnv?: boolean;
  legacyEnvDrift?: boolean;
  moveFails?: boolean;
  neighborAuditFails?: boolean;
  nestedMount?: boolean;
  rootVerifierFails?: boolean;
  rollbackRetentionHours?: string;
  runningContainer?: boolean;
  signalAfterMove?: boolean;
  signalAfterSourceMove?: boolean;
  sourceEnvMismatch?: boolean;
  symlink?: boolean;
  unmountFails?: boolean;
};

function fixture(options: FixtureOptions = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'kassinao-shared-migration-')));
  chmodSync(root, 0o700);
  const scripts = path.join(root, 'scripts');
  const dockerClient = path.join(root, 'deploy', 'docker-client');
  const bin = path.join(root, 'bin');
  const runtime = path.join(root, 'runtime');
  const dataRoot = path.join(root, 'plaintext-data');
  const rollback = `${dataRoot}.plaintext-before-shared-luks`;
  const stage = `${dataRoot}.luks-staging`;
  const backing = path.join(root, 'kassinao-shared.luks');
  const operations = path.join(root, 'operations.log');
  const mountState = path.join(root, 'mount.state');
  const dockerJson = path.join(root, 'docker.json');
  const legacyDir = path.join(root, 'legacy-release');
  const legacyAppEnv = path.join(legacyDir, '.env');
  mkdirSync(scripts);
  mkdirSync(dockerClient, { recursive: true });
  writeFileSync(path.join(dockerClient, 'config.json'), '{}\n', { mode: 0o444 });
  mkdirSync(bin);
  mkdirSync(runtime, { mode: 0o700 });
  writeFileSync(path.join(runtime, 'maintenance.lock'), 'sentinela-maintenance\n', { mode: 0o600 });
  mkdirSync(legacyDir, { mode: 0o700 });
  mkdirSync(dataRoot, { mode: 0o700 });
  for (const name of ['recordings', 'state', 'auth', 'cache']) {
    mkdirSync(path.join(dataRoot, name), { mode: 0o700 });
  }
  const transitionState = path.join(dataRoot, '.legacy-shared-transition');
  mkdirSync(transitionState, { mode: 0o700 });
  writeFileSync(path.join(transitionState, 'layout.json'), '{"status":"prepared","version":3}\n', {
    mode: 0o600,
  });
  writeFileSync(path.join(transitionState, 'source-manifest.jsonl'), '{"path":"recordings"}\n', {
    mode: 0o600,
  });
  const recording = path.join(dataRoot, 'recordings', 'meeting-1');
  mkdirSync(recording, { mode: 0o700 });
  writeFileSync(
    path.join(recording, 'meta.json'),
    `${JSON.stringify({ id: 'meeting-1', status: options.activeRecording ? 'recording' : 'done' })}\n`,
  );
  const audioFile = path.join(recording, 'audio.pcm');
  writeFileSync(audioFile, 'meeting bytes\n');
  chmodSync(audioFile, 0o640);
  for (const [name, contents] of Object.entries(COLOCATED_FIXTURE_FILES)) {
    writeFileSync(path.join(dataRoot, 'recordings', name), contents, { mode: 0o600 });
  }
  writeFileSync(path.join(dataRoot, 'cache', 'model.bin'), 'model cache\n');
  if (options.extraTopLevel) writeFileSync(path.join(dataRoot, 'legacy.json'), '{"legacy":true}\n');
  writeFileSync(backing, 'fake LUKS backing\n', { mode: 0o600 });

  const uid = process.getuid?.() || 1000;
  const gid = process.getgid?.() || 1000;
  const envFile = path.join(root, '.env');
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
      `KASSINAO_SHARED_APP_ENV_FILE=${dataRoot}/config/app.env`,
      `KASSINAO_SHARED_TUNNEL_TOKEN_FILE=${dataRoot}/config/cloudflared-token`,
      `KASSINAO_SHARED_LUKS_BACKING_FILE=${backing}`,
      'KASSINAO_SHARED_LUKS_MAPPER=kassinao-shared-test',
      'KASSINAO_SHARED_LUKS_UUID=11111111-2222-3333-4444-555555555555',
      `KASSINAO_UID=${uid}`,
      `KASSINAO_GID=${gid}`,
      `KASSINAO_ROLLBACK_RETENTION_HOURS=${options.rollbackRetentionHours ?? '72'}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  chmodSync(envFile, 0o600);
  writeFileSync(
    legacyAppEnv,
    [
      'TRANSCRIBE_PROVIDER=assemblyai',
      'TRANSCRIBE_FALLBACK_PROVIDER=groq',
      'TRANSCRIBE_SEND_MEETING_CONTEXT=true',
      'ASSEMBLYAI_API_KEY=assembly-secret',
      'GROQ_API_KEY=groq-secret',
      'OPENROUTER_API_KEY=openrouter-secret',
      'MINUTES_ENABLED=true',
      'MINUTES_PROVIDER=openrouter',
      'MCP_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'RETENTION_DAYS=21',
      'TEXT_RETENTION_DAYS=120',
      'MAX_RECORDING_HOURS=4',
      'RECORDING_STARTS_GLOBAL_PER_24H=19',
      'MP3_BITRATE=160k',
      'TUNNEL_TOKEN=tunnel-secret-must-stay-out',
      'KASSINAO_HOST_SCOPE=dedicated',
      'KASSINAO_DATA_ROOT=/legacy/plaintext',
      'PORT=9999',
      'UNKNOWN_LEGACY_SECRET=must-not-be-imported',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  chmodSync(legacyAppEnv, 0o600);
  const legacyStat = lstatSync(legacyAppEnv, { bigint: true });
  const legacyEnvProof = `{"path":${JSON.stringify(legacyAppEnv)},"dev":${legacyStat.dev},"ino":${legacyStat.ino},"mode":384,"uid":${legacyStat.uid},"gid":${legacyStat.gid},"nlink":${legacyStat.nlink},"size":${legacyStat.size},"mtime_ns":${legacyStat.mtimeNs},"ctime_ns":${legacyStat.ctimeNs},"sha256":"${createHash('sha256').update(readFileSync(legacyAppEnv)).digest('hex')}"}`;
  const transitionManifest = treeManifest(dataRoot);
  const absentMetadata = {
    state: { mode: 0o700, uid, gid },
    auth: { mode: 0o700, uid, gid },
  };
  const transitionLayout = JSON.stringify({
    absent_metadata: absentMetadata,
    colocated_files: COLOCATED_TARGETS,
    current_root: legacyDir,
    data_root: dataRoot,
    legacy_env_proof: null,
    legacy_env_status: 'present',
    legacy_runtime_uid: uid,
    legacy_runtime_gid: gid,
    source_manifest_sha256: createHash('sha256').update(transitionManifest).digest('hex'),
    sources: { recordings: path.join(legacyDir, 'recordings'), cache: path.join(root, 'cache-volume') },
    status: 'prepared',
    version: 3,
  }).replace('"legacy_env_proof":null', `"legacy_env_proof":${legacyEnvProof}`);
  writeFileSync(path.join(transitionState, 'layout.json'), `${transitionLayout}\n`, { mode: 0o600 });
  writeFileSync(path.join(transitionState, 'source-manifest.jsonl'), transitionManifest, { mode: 0o600 });
  if (options.symlink) symlinkSync('/etc/passwd', path.join(recording, 'escape'));
  if (options.legacyEnvDrift) writeFileSync(legacyAppEnv, `${readFileSync(legacyAppEnv, 'utf8')}DRIFT=1\n`);
  const mismatchedEnv = path.join(legacyDir, '.env-other');
  if (options.sourceEnvMismatch) {
    writeFileSync(mismatchedEnv, readFileSync(legacyAppEnv), { mode: 0o600 });
    chmodSync(mismatchedEnv, 0o600);
  }

  writeFileSync(path.join(root, 'app.env.example'), readFileSync(path.join(ROOT, 'deploy/runtime/app.env.example')), {
    mode: 0o600,
  });

  const migrator = path.join(scripts, 'migrate-shared-storage.sh');
  const inheritedEnvironment = path.join(root, 'inherited-environment.bin');
  writeFileSync(
    inheritedEnvironment,
    Buffer.from(
      [
        ...new Set([
          ...Object.keys(process.env),
          'PATH',
          'HOME',
          'KASSINAO_MIGRATION_SOURCE_APP_ENV',
          'DISCORD_TOKEN',
          'LUKS_PASSPHRASE',
        ]),
      ]
        .map((name) => `${name}=fixture\0`)
        .join(''),
    ),
  );
  const fixtureMigrator = source
    .replace('[ "$EUID" -eq 0 ] || die \'execute como root\'', ': # root simulated by fixture')
    .replace(
      'SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      `SAFE_SYSTEM_PATH=${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    )
    .replaceAll('/proc/$$/environ', inheritedEnvironment)
    .replaceAll('[ "$uid" -ge 61000 ]', '[ "$uid" -ge 1 ]')
    .replaceAll('[ "$gid" -ge 61000 ]', '[ "$gid" -ge 1 ]')
    .replace(
      /# KASSINAO_HOST_NO_DUMP_BEGIN[\s\S]*?# KASSINAO_HOST_NO_DUMP_END/,
      '# KASSINAO_HOST_NO_DUMP_BEGIN\nunset LD_PRELOAD\n# KASSINAO_HOST_NO_DUMP_END',
    )
    .replace('RUNTIME_DIR=/run/lock/kassinao', `RUNTIME_DIR=${runtime}`)
    .replace(
      /\[ "\$\(stat -Lc '%a:%u:%g:%h' "\/proc\/\$\$\/fd\/9"[\s\S]*?die 'maintenance\.lock mudou durante a abertura'\n/,
      '',
    )
    .replace(
      'if metadata.st_uid != 0 or metadata.st_gid != 0:',
      `if metadata.st_uid != ${uid} or metadata.st_gid != ${gid}:`,
    )
    .replace(
      'if item.st_uid != 0 or item.st_gid != 0 or item.st_nlink != 1:',
      `if item.st_uid != ${uid} or item.st_gid != ${gid} or item.st_nlink != 1:`,
    )
    .replaceAll(
      'directory.st_uid != 0 or directory.st_gid != 0',
      `directory.st_uid != ${uid} or directory.st_gid != ${gid}`,
    )
    .replaceAll(
      'control_stat.st_uid != 0 or control_stat.st_gid != 0',
      `control_stat.st_uid != ${uid} or control_stat.st_gid != ${gid}`,
    )
    .replaceAll('layout_stat.st_uid != 0', `layout_stat.st_uid != ${uid}`)
    .replaceAll('layout_stat.st_gid != 0', `layout_stat.st_gid != ${gid}`)
    .replaceAll("fields['uid'] != 0 or fields['gid'] != 0", `fields['uid'] != ${uid} or fields['gid'] != ${gid}`);
  writeFileSync(migrator, fixtureMigrator);
  chmodSync(migrator, 0o755);
  const verifier = path.join(scripts, 'verify-shared-luks-storage.sh');
  executable(
    verifier,
    `#!/usr/bin/env bash
set -eu
[ -z "\${DISCORD_TOKEN:-}" ] && [ -z "\${LUKS_PASSPHRASE:-}" ] || exit 91
printf 'verifier:%s:%s\n' "\${KASSINAO_ENV_FILE:-unset}" "$*" >> ${shellLiteral(operations)}
if [ ${options.rootVerifierFails ? 'true' : 'false'} = true ] && [ "\${1:-}" = --root-only ]; then exit 42; fi
if [ ${options.finalVerifierFails ? 'true' : 'false'} = true ] && [ "\${KASSINAO_ENV_FILE:-}" = ${shellLiteral(
      envFile,
    )} ] && [ "$#" -eq 0 ]; then exit 43; fi
exit 0
`,
  );
  const neighborAuditor = path.join(scripts, 'audit-shared-vps-security.sh');
  executable(
    neighborAuditor,
    `#!/usr/bin/env bash
set -eu
[ -z "\${DISCORD_TOKEN:-}" ] && [ -z "\${LUKS_PASSPHRASE:-}" ] || exit 91
[ "\${KASSINAO_ENV_FILE:-}" = ${shellLiteral(envFile)} ] || exit 92
[ "$#" -eq 1 ] && [ "$1" = --neighbors-only ] || exit 93
printf 'auditor:%s\n' "$*" >> ${shellLiteral(operations)}
[ ${options.neighborAuditFails ? 'true' : 'false'} = false ] || exit 46
exit 0
`,
  );

  const ids = {
    kassinao: 'a'.repeat(64),
    'kassinao-public': 'b'.repeat(64),
    cloudflared: 'c'.repeat(64),
    foreign: 'f'.repeat(64),
  };
  const containers: Array<Record<string, unknown>> = [
    ['kassinao', 'kassinao'],
    ['kassinao-public', 'kassinao-public'],
    ['cloudflared', 'kassinao-tunnel'],
  ].map(([service, name]) => ({
    Id: ids[service as keyof typeof ids],
    Name: `/${name}`,
    Config: {
      Labels: {
        'com.docker.compose.project': 'kassinao',
        'com.docker.compose.service': service,
      },
    },
    State: { Running: options.runningContainer === true && service === 'kassinao' },
    HostConfig: {
      RestartPolicy: { Name: 'no' },
      Binds: null,
      Devices: null,
      DeviceCgroupRules: null,
      DeviceRequests: null,
      VolumesFrom: null,
    },
    Mounts: [],
  }));
  containers.push({
    Id: ids.foreign,
    Name: '/company-app',
    Config: { Labels: {} },
    State: { Running: true },
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped' },
      Binds: options.foreignWriter ? [`${dataRoot}:/data:rw`] : null,
      Devices: null,
      DeviceCgroupRules: null,
      DeviceRequests: null,
      VolumesFrom: null,
    },
    Mounts: options.foreignWriter ? [{ Type: 'bind', Source: dataRoot, Destination: '/data', RW: true }] : [],
  });
  writeFileSync(dockerJson, JSON.stringify(containers));

  executable(
    path.join(bin, 'id'),
    `#!/usr/bin/env bash
[ "\${1:-}" = -u ] && printf '0\n'
`,
  );
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
last=''
previous=''
for value in "$@"; do
  if [ "$previous" = -c ]; then format="$value"; fi
  previous="$value"
  last="$value"
done
if [ "$format" = %h ]; then printf '1\n'; exit 0; fi
case "$last" in
  ${shellLiteral(root)}|${shellLiteral(dataRoot)}|${shellLiteral(runtime)}|${shellLiteral(legacyDir)}) printf '700:0:0\n' ;;
  ${shellLiteral(path.join(runtime, 'maintenance.lock'))}) printf '600:0:0:1\n' ;;
  ${shellLiteral(envFile)}|${shellLiteral(legacyAppEnv)}|${shellLiteral(mismatchedEnv)}) printf '600:0:0\n' ;;
  ${shellLiteral(path.join(root, 'MANIFEST.sha256'))}) printf '644:0:0\n' ;;
  ${shellLiteral(migrator)}|${shellLiteral(verifier)}) printf '755:0:0\n' ;;
  *) printf '755:0:0\n' ;;
esac
`,
  );
  executable(
    path.join(bin, 'sha256sum'),
    `#!/usr/bin/env bash
last=''
for value in "$@"; do last="$value"; done
if [ "$last" = ${shellLiteral(path.join(dockerClient, 'config.json'))} ]; then
  printf 'ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356  %s\n' "$last"
  exit 0
fi
python3 - ${shellLiteral(root)} <<'PY'
import hashlib, os, sys
root = sys.argv[1]
with open(os.path.join(root, 'MANIFEST.sha256'), encoding='utf-8') as handle:
    for raw in handle:
        expected, relative = raw.rstrip('\\n').split('  ', 1)
        relative = relative.removeprefix('./')
        with open(os.path.join(root, relative), 'rb') as source:
            actual = hashlib.sha256(source.read()).hexdigest()
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
  ps) printf '%s\n' '${ids.kassinao}' '${ids['kassinao-public']}' '${ids.cloudflared}' '${ids.foreign}' ;;
  inspect)
    python3 - ${shellLiteral(dockerJson)} <<'PY'
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
  executable(
    path.join(bin, 'findmnt'),
    `#!/usr/bin/env bash
set -eu
case " $* " in
  *' --json '*) printf '%s\n' ${shellLiteral(
    JSON.stringify(
      options.nestedMount ? { filesystems: [{ target: `${dataRoot}/state/nested` }] } : { filesystems: [] },
    ),
  )} ;;
  *) exit 1 ;;
esac
`,
  );
  executable(
    path.join(bin, 'mountpoint'),
    `#!/usr/bin/env bash
set -eu
last=''
for value in "$@"; do last="$value"; done
[ -f ${shellLiteral(mountState)} ] && [ "$(cat ${shellLiteral(mountState)})" = "$last" ]
`,
  );
  executable(
    path.join(bin, 'mount'),
    `#!/usr/bin/env bash
set -eu
printf 'mount:%s\n' "$*" >> ${shellLiteral(operations)}
if [ "\${1:-}" = --move ]; then
  source="$2"; destination="$3"
  if [ ${options.moveFails ? 'true' : 'false'} = true ]; then exit 44; fi
  python3 - "$source" "$destination" <<'PY'
import os, sys
source, destination = sys.argv[1:]
for name in os.listdir(source):
    os.rename(os.path.join(source, name), os.path.join(destination, name))
PY
  printf '%s\n' "$destination" > ${shellLiteral(mountState)}
  if [ ${options.signalAfterMove ? 'true' : 'false'} = true ]; then kill -TERM "$PPID"; fi
else
  last=''
  for value in "$@"; do last="$value"; done
  printf '%s\n' "$last" > ${shellLiteral(mountState)}
fi
`,
  );
  executable(
    path.join(bin, 'umount'),
    `#!/usr/bin/env bash
set -eu
printf 'umount:%s\n' "$*" >> ${shellLiteral(operations)}
last=''
for value in "$@"; do last="$value"; done
if [ "$last" = ${shellLiteral(dataRoot)} ]; then
  if [ ${options.unmountFails ? 'true' : 'false'} = true ]; then exit 45; fi
  python3 - "$last" <<'PY'
import os, shutil, sys
root = sys.argv[1]
for name in os.listdir(root):
    path = os.path.join(root, name)
    if os.path.isdir(path) and not os.path.islink(path):
        shutil.rmtree(path)
    else:
        os.unlink(path)
PY
fi
: > ${shellLiteral(mountState)}
`,
  );
  executable(path.join(bin, 'sync'), '#!/usr/bin/env bash\nexit 0\n');
  executable(
    path.join(bin, 'cp'),
    `#!/usr/bin/env bash
set -eu
printf 'cp:%s\n' "$*" >> ${shellLiteral(operations)}
/bin/cp "$@"
case "$*" in
  *${shellLiteral(`${dataRoot}/recordings`)}*)
    if [ ${options.corruptCopy ? 'true' : 'false'} = true ]; then
      printf 'corruption\n' >> ${shellLiteral(path.join(stage, 'recordings', 'meeting-1', 'audio.pcm'))}
    fi
    ;;
esac
`,
  );
  executable(
    path.join(bin, 'mv'),
    `#!/usr/bin/env bash
set -eu
/bin/mv "$@"
if [ ${options.signalAfterSourceMove ? 'true' : 'false'} = true ] && [ "\${1:-}" = -- ] && [ "\${2:-}" = ${shellLiteral(
      dataRoot,
    )} ] && [ "\${3:-}" = ${shellLiteral(rollback)} ]; then
  kill -TERM "$PPID"
fi
`,
  );

  const manifestEntries = [
    'scripts/migrate-shared-storage.sh',
    'scripts/verify-shared-luks-storage.sh',
    'scripts/audit-shared-vps-security.sh',
    'app.env.example',
  ].map((relative) => {
    const bytes = readFileSync(path.join(root, relative));
    return `${createHash('sha256').update(bytes).digest('hex')}  ${relative}`;
  });
  const manifest = path.join(root, 'MANIFEST.sha256');
  writeFileSync(manifest, `${manifestEntries.join('\n')}\n`, { mode: 0o644 });
  chmodSync(manifest, 0o644);

  const execution = spawnSync('bash', [migrator], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: root,
      DISCORD_TOKEN: 'discord-secret-must-not-leak',
      LUKS_PASSPHRASE: 'luks-secret-must-not-leak',
      KASSINAO_MIGRATION_SOURCE_APP_ENV: options.sourceEnvMismatch ? mismatchedEnv : legacyAppEnv,
    },
  });

  return { backing, dataRoot, execution, legacyAppEnv, operations, rollback, root, runtime, stage };
}

function operationLog(aFixture: ReturnType<typeof fixture>): string {
  return existsSync(aFixture.operations) ? readFileSync(aFixture.operations, 'utf8') : '';
}

describe('migração offline para storage shared LUKS', () => {
  it('tem sintaxe válida e não recebe chave nem altera Docker global/vizinhos', () => {
    const syntax = spawnSync('bash', ['-n', MIGRATOR], { encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);
    expect(source).toContain('activeRecordings=0');
    expect(source).toContain('maintenance.lock');
    expect(source).toContain('mount --move "$staging" "$data_root"');
    expect(source).toContain('plaintext-before-shared-luks');
    expect(source).toContain('SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
    expect(source).toContain('export PATH="$SAFE_SYSTEM_PATH" HOME=/root');
    expect(source).toContain('shutil.disk_usage(destination).free');
    expect(source).toContain('controle legado root-only');
    expect(source).not.toContain("host.get('Binds')");
    expect(source).toContain("item.get('Mounts')");
    expect(source).toContain('{{json (index $mount "Name")}}');
    expect(source).toContain('{{json $mount.Source}}');
    expect(source).not.toContain('{{json $mount.Name}}');
    expect(source).toContain("mount_type in ('bind', 'volume')");
    expect(source).toContain("not isinstance(mount.get('Name'), str) or not mount.get('Name')");
    expect(source).toContain('"$NEIGHBOR_AUDITOR" --neighbors-only');
    expect(source).toContain('mountpoint -q -- "$data_root"');
    expect(source).toContain('.kassinao-plaintext-rollback.pending');
    expect(source).toContain('KASSINAO_ROLLBACK_RETENTION_HOURS');
    expect(source).not.toMatch(/cryptsetup\s+(?:open|luksFormat)|--key-file/);
    expect(source).not.toMatch(/docker\s+(?:start|stop|restart|kill|rm|run|create|update|compose)/);
    expect(source).not.toContain('rm -rf');
    expect(source).not.toContain('/etc/docker');
    expect(source).not.toContain('docker.service');
    if ((process.getuid?.() ?? 1) !== 0) {
      const execution = spawnSync('bash', [MIGRATOR], { encoding: 'utf8' });
      expect(execution.status).not.toBe(0);
      expect(execution.stderr).toContain('execute como root');
    }
  });

  it('migra em staging, preserva bytes/metadados e mantém plaintext para rollback de dados', () => {
    const aFixture = fixture();
    expect(aFixture.execution.status, `${aFixture.execution.stderr}\n${aFixture.execution.stdout}`).toBe(0);
    expect(aFixture.execution.stdout).toContain('Migração shared concluída');
    expect(aFixture.execution.stdout).toContain('Rollback de dados plaintext preservado');
    expect(aFixture.execution.stdout).toContain('não é um rollback operacional');
    expect(aFixture.execution.stdout).toContain('recuperação do serviço é fix-forward');
    expect(existsSync(aFixture.rollback)).toBe(true);
    expect(existsSync(path.join(aFixture.dataRoot, '.legacy-shared-transition', 'layout.json'))).toBe(true);
    expect(existsSync(path.join(aFixture.rollback, '.legacy-shared-transition', 'layout.json'))).toBe(true);
    expect(existsSync(path.join(aFixture.dataRoot, '.kassinao-migration-manifest.jsonl'))).toBe(true);
    const persistedManifest = path.join(aFixture.dataRoot, '.kassinao-migration-manifest.jsonl');
    const pendingMarker = path.join(aFixture.dataRoot, '.kassinao-plaintext-rollback.pending');
    const markerLines = readFileSync(pendingMarker, 'utf8').split('\n');
    expect(markerLines).toHaveLength(8);
    expect(markerLines[0]).toBe('kassinao-shared-plaintext-rollback-v1');
    expect(markerLines[1]).toBe('status=pending');
    expect(markerLines[2]).toMatch(/^migration_id=[0-9a-f]{32}$/);
    expect(markerLines[3]).toBe(
      `manifest_sha256=${createHash('sha256').update(readFileSync(persistedManifest)).digest('hex')}`,
    );
    expect(markerLines[4]).toBe(`rollback_path=${aFixture.rollback}`);
    expect(markerLines[5]).toMatch(/^created_at=[1-9][0-9]*$/);
    expect(markerLines[6]).toMatch(/^deadline=[1-9][0-9]*$/);
    expect(markerLines[7]).toBe('');
    expect(
      Number(markerLines[6]!.slice('deadline='.length)) - Number(markerLines[5]!.slice('created_at='.length)),
    ).toBe(72 * 3600);
    expect(lstatSync(pendingMarker).mode & 0o777).toBe(0o400);
    expect(existsSync(path.join(aFixture.dataRoot, '.kassinao-plaintext-rollback.purged'))).toBe(false);
    expect(readFileSync(path.join(aFixture.dataRoot, 'recordings', 'meeting-1', 'audio.pcm'), 'utf8')).toBe(
      'meeting bytes\n',
    );
    expect(readFileSync(path.join(aFixture.rollback, 'recordings', 'meeting-1', 'audio.pcm'), 'utf8')).toBe(
      'meeting bytes\n',
    );
    expect(lstatSync(path.join(aFixture.rollback, 'recordings', 'meeting-1', 'audio.pcm')).isFile()).toBe(true);
    expect(lstatSync(path.join(aFixture.dataRoot, 'recordings', 'meeting-1', 'audio.pcm')).mode & 0o777).toBe(0o640);
    expect(lstatSync(path.join(aFixture.rollback, 'recordings', 'meeting-1', 'audio.pcm')).mode & 0o777).toBe(0o640);
    for (const [sourceName, contents] of Object.entries(COLOCATED_FIXTURE_FILES)) {
      const target = COLOCATED_TARGETS[sourceName as keyof typeof COLOCATED_TARGETS];
      expect(existsSync(path.join(aFixture.dataRoot, 'recordings', sourceName))).toBe(false);
      expect(readFileSync(path.join(aFixture.dataRoot, target.tree, target.name), 'utf8')).toBe(contents);
      expect(readFileSync(path.join(aFixture.rollback, 'recordings', sourceName), 'utf8')).toBe(contents);
    }
    expect(readFileSync(path.join(aFixture.dataRoot, 'state', '.layout-v2'), 'utf8')).toBe('2\n');
    expect(lstatSync(path.join(aFixture.dataRoot, 'state', '.layout-v2')).mode & 0o777).toBe(0o600);
    expect(existsSync(path.join(aFixture.dataRoot, 'state', '.instance-id'))).toBe(false);
    expect(existsSync(path.join(aFixture.dataRoot, 'auth', '.instance-id'))).toBe(false);
    expect(existsSync(path.join(aFixture.rollback, 'state', '.layout-v2'))).toBe(false);
    expect(readdirSync(path.join(aFixture.rollback, 'state'))).toEqual([]);
    expect(readdirSync(path.join(aFixture.rollback, 'auth'))).toEqual([]);
    expect(readFileSync(persistedManifest, 'utf8')).toBe(treeManifest(aFixture.rollback, true));
    const log = operationLog(aFixture);
    expect(log.match(/auditor:--neighbors-only/g)).toHaveLength(2);
    expect(log.indexOf('auditor:--neighbors-only')).toBeLessThan(log.indexOf('mount:-o rw,nodev,nosuid,noexec'));
    expect(log).toContain(`mount:-o rw,nodev,nosuid,noexec /dev/mapper/kassinao-shared-test ${aFixture.stage}`);
    expect(log).toContain(`mount:--move ${aFixture.stage} ${aFixture.dataRoot}`);
    expect(log).not.toMatch(/docker:(?:start|stop|restart|kill|rm|run|create|update|compose)/);
    expect(`${log}\n${aFixture.execution.stdout}\n${aFixture.execution.stderr}`).not.toContain(
      'discord-secret-must-not-leak',
    );
    expect(`${log}\n${aFixture.execution.stdout}\n${aFixture.execution.stderr}`).not.toContain(
      'luks-secret-must-not-leak',
    );
    for (const contents of Object.values(COLOCATED_FIXTURE_FILES)) {
      expect(`${log}\n${aFixture.execution.stdout}\n${aFixture.execution.stderr}`).not.toContain(contents.trim());
    }
  }, 30_000);

  it('importa somente a allowlist de runtime legado para o app.env cifrado', () => {
    const aFixture = fixture({ importLegacyAppEnv: true });
    expect(aFixture.execution.status, `${aFixture.execution.stderr}\n${aFixture.execution.stdout}`).toBe(0);
    const encryptedAppEnv = readFileSync(path.join(aFixture.dataRoot, 'config', 'app.env'), 'utf8');
    for (const expected of [
      'TRANSCRIBE_PROVIDER=assemblyai',
      'TRANSCRIBE_FALLBACK_PROVIDER=groq',
      'TRANSCRIBE_SEND_MEETING_CONTEXT=true',
      'ASSEMBLYAI_API_KEY=assembly-secret',
      'GROQ_API_KEY=groq-secret',
      'OPENROUTER_API_KEY=openrouter-secret',
      'MINUTES_ENABLED=true',
      'MINUTES_PROVIDER=openrouter',
      'MCP_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'RETENTION_DAYS=21',
      'TEXT_RETENTION_DAYS=120',
      'MAX_RECORDING_HOURS=4',
      'RECORDING_STARTS_GLOBAL_PER_24H=19',
      'MP3_BITRATE=160k',
    ]) {
      expect(encryptedAppEnv).toContain(`${expected}\n`);
    }
    for (const forbidden of [
      'TUNNEL_TOKEN=',
      'KASSINAO_HOST_SCOPE=',
      'KASSINAO_DATA_ROOT=',
      'PORT=',
      'UNKNOWN_LEGACY_SECRET=',
      'tunnel-secret-must-stay-out',
      'must-not-be-imported',
    ]) {
      expect(encryptedAppEnv).not.toContain(forbidden);
    }
    expect(readFileSync(path.join(aFixture.dataRoot, 'config', 'cloudflared-token'), 'utf8')).toBe('');
    expect(`${aFixture.execution.stdout}\n${aFixture.execution.stderr}`).not.toContain('assembly-secret');
    expect(`${aFixture.execution.stdout}\n${aFixture.execution.stderr}`).not.toContain('tunnel-secret-must-stay-out');
  });

  it.each([
    ['outro .env 0600 root no mesmo release', { sourceEnvMismatch: true }],
    ['drift de bytes após o preparo', { legacyEnvDrift: true }],
  ] as const)('recusa %s quando não corresponde à prova cifrada', (_label, options) => {
    const aFixture = fixture(options);
    expect(aFixture.execution.status).not.toBe(0);
    expect(aFixture.execution.stderr).toContain('template/import legado');
    expect(existsSync(aFixture.rollback)).toBe(false);
    expect(operationLog(aFixture)).not.toContain('mount:');
  });

  it('recusa activeRecordings antes de montar ou trocar a origem', () => {
    const aFixture = fixture({ activeRecording: true });
    expect(aFixture.execution.status).not.toBe(0);
    expect(aFixture.execution.stderr).toContain('activeRecordings=1');
    expect(existsSync(aFixture.rollback)).toBe(false);
    expect(existsSync(aFixture.dataRoot)).toBe(true);
    expect(operationLog(aFixture)).not.toContain('mount:');
  });

  it.each(['0', '169', 'not-a-number'])('recusa retenção fora de 1..168 horas: %s', (rollbackRetentionHours) => {
    const aFixture = fixture({ rollbackRetentionHours });
    expect(aFixture.execution.status).not.toBe(0);
    expect(aFixture.execution.stderr).toContain('entre 1 e 168');
    expect(existsSync(aFixture.rollback)).toBe(false);
    expect(operationLog(aFixture)).not.toContain('mount:');
  });

  it('recusa o audit forte de vizinhos antes de montar ou copiar', () => {
    const aFixture = fixture({ neighborAuditFails: true });
    expect(aFixture.execution.status).not.toBe(0);
    expect(aFixture.execution.stderr).toContain('auditoria read-only dos vizinhos recusou');
    expect(existsSync(aFixture.rollback)).toBe(false);
    const log = operationLog(aFixture);
    expect(log).toContain('auditor:--neighbors-only');
    expect(log).not.toContain('mount:');
    expect(log).not.toContain('cp:');
  });

  it('recusa symlink recursivo antes de montar ou trocar a origem', () => {
    const aFixture = fixture({ symlink: true });
    expect(aFixture.execution.status).not.toBe(0);
    expect(aFixture.execution.stderr).toContain('symlink proibido');
    expect(existsSync(aFixture.rollback)).toBe(false);
    expect(operationLog(aFixture)).not.toContain('mount:');
  });

  it('recusa container Kassinão em execução antes de montar', () => {
    const aFixture = fixture({ runningContainer: true });
    expect(aFixture.execution.status).not.toBe(0);
    expect(aFixture.execution.stderr).toContain('containers Kassinão precisam estar parados');
    expect(existsSync(aFixture.rollback)).toBe(false);
    expect(operationLog(aFixture)).not.toContain('mount:');
  });

  it('recusa nested mount na origem antes da cópia', () => {
    const aFixture = fixture({ nestedMount: true });
    expect(aFixture.execution.status).not.toBe(0);
    expect(aFixture.execution.stderr).toContain('nested mount detectado');
    expect(existsSync(aFixture.rollback)).toBe(false);
    expect(operationLog(aFixture)).not.toContain('mount:');
  });

  it('recusa container vizinho com acesso ao storage antes de montar', () => {
    const aFixture = fixture({ foreignWriter: true });
    expect(aFixture.execution.status).not.toBe(0);
    expect(aFixture.execution.stderr).toContain('nenhum vizinho pode alcançar o storage');
    expect(existsSync(aFixture.rollback)).toBe(false);
    expect(operationLog(aFixture)).not.toContain('mount:');
  });

  it('recusa conteúdo top-level fora das quatro árvores migradas', () => {
    const aFixture = fixture({ extraTopLevel: true });
    expect(aFixture.execution.status).not.toBe(0);
    expect(aFixture.execution.stderr).toContain('top-level extra');
    expect(existsSync(aFixture.rollback)).toBe(false);
    expect(operationLog(aFixture)).not.toContain('mount:');
  });

  it('cancela em checksum divergente e mantém plaintext no caminho original', () => {
    const aFixture = fixture({ corruptCopy: true });
    expect(aFixture.execution.status).not.toBe(0);
    expect(aFixture.execution.stderr).toContain('checksum/mode/ownership normalizado do destino diverge');
    expect(existsSync(aFixture.rollback)).toBe(false);
    expect(readFileSync(path.join(aFixture.dataRoot, 'recordings', 'meeting-1', 'audio.pcm'), 'utf8')).toBe(
      'meeting bytes\n',
    );
    expect(operationLog(aFixture)).not.toContain('mount:--move');
  });

  it('falha no verifier de staging antes da troca e nunca move a origem', () => {
    const aFixture = fixture({ rootVerifierFails: true });
    expect(aFixture.execution.status).not.toBe(0);
    expect(aFixture.execution.stderr).toContain('staging não passou na prova root-only');
    expect(existsSync(aFixture.rollback)).toBe(false);
    expect(existsSync(aFixture.dataRoot)).toBe(true);
    const log = operationLog(aFixture);
    expect(log).toContain('verifier:');
    expect(log).not.toContain('mount:--move');
  });

  it('restaura automaticamente a origem quando mount --move falha', () => {
    const aFixture = fixture({ moveFails: true });
    expect(aFixture.execution.status).not.toBe(0);
    expect(aFixture.execution.stderr).toContain('falha ao mover mount cifrado');
    expect(existsSync(aFixture.rollback)).toBe(false);
    expect(readFileSync(path.join(aFixture.dataRoot, 'recordings', 'meeting-1', 'audio.pcm'), 'utf8')).toBe(
      'meeting bytes\n',
    );
    const log = operationLog(aFixture);
    expect(log).toContain(`mount:--move ${aFixture.stage} ${aFixture.dataRoot}`);
    expect(log).toContain(`umount:-- ${aFixture.stage}`);
  });

  it('restaura automaticamente a origem quando a validação pós-troca falha', () => {
    const aFixture = fixture({ finalVerifierFails: true });
    expect(aFixture.execution.status).not.toBe(0);
    expect(aFixture.execution.stderr).toContain('storage cifrado final não passou');
    expect(existsSync(aFixture.rollback)).toBe(false);
    expect(readFileSync(path.join(aFixture.dataRoot, 'recordings', 'meeting-1', 'audio.pcm'), 'utf8')).toBe(
      'meeting bytes\n',
    );
    expect(operationLog(aFixture)).toContain(`umount:-- ${aFixture.dataRoot}`);
  });

  it('reconcilia o mount real e restaura a origem se receber sinal logo após mount --move', () => {
    const aFixture = fixture({ signalAfterMove: true });
    expect(aFixture.execution.status).not.toBe(0);
    expect(existsSync(aFixture.rollback)).toBe(false);
    expect(readFileSync(path.join(aFixture.dataRoot, 'recordings', 'meeting-1', 'audio.pcm'), 'utf8')).toBe(
      'meeting bytes\n',
    );
    const log = operationLog(aFixture);
    expect(log).toContain(`mount:--move ${aFixture.stage} ${aFixture.dataRoot}`);
    expect(log).toContain(`umount:-- ${aFixture.dataRoot}`);
  });

  it('restaura a origem se receber SIGTERM entre o rename e source_moved=true', () => {
    const aFixture = fixture({ signalAfterSourceMove: true });
    expect(aFixture.execution.status).not.toBe(0);
    expect(existsSync(aFixture.rollback)).toBe(false);
    expect(readFileSync(path.join(aFixture.dataRoot, 'recordings', 'meeting-1', 'audio.pcm'), 'utf8')).toBe(
      'meeting bytes\n',
    );
    expect(operationLog(aFixture)).not.toContain(`mount:--move ${aFixture.stage} ${aFixture.dataRoot}`);
  });

  it('preserva o rollback plaintext se o destino não puder ser desmontado após falha', () => {
    const aFixture = fixture({ finalVerifierFails: true, unmountFails: true });
    expect(aFixture.execution.status).not.toBe(0);
    expect(aFixture.execution.stderr).toContain('ERRO CRÍTICO');
    expect(existsSync(aFixture.rollback)).toBe(true);
    expect(readFileSync(path.join(aFixture.rollback, 'recordings', 'meeting-1', 'audio.pcm'), 'utf8')).toBe(
      'meeting bytes\n',
    );
  });
});
