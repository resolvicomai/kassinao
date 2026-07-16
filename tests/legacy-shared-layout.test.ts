import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  linkSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const HELPER_SOURCE = readFileSync(path.join(ROOT, 'scripts', 'prepare-legacy-shared-layout.sh'), 'utf8');
const VALIDATOR_SOURCE = readFileSync(path.join(ROOT, 'scripts', 'validate-legacy-dedicated-installation.sh'), 'utf8');

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function executable(file: string, contents: string): void {
  writeFileSync(file, contents, { mode: 0o755 });
  chmodSync(file, 0o755);
}

function fixture(
  options: {
    running?: boolean;
    foreignMount?: boolean;
    foreignVolumesFrom?: boolean;
    lateForeignMount?: boolean;
    lateNestedMount?: boolean;
    volumeSpoof?: boolean;
    bindOutsideCurrent?: boolean;
    unknownRootFile?: boolean;
    explicitStateMount?: boolean;
  } = {},
) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'kassinao-legacy-layout-')));
  chmodSync(root, 0o700);
  const bundle = path.join(root, 'bundle');
  const scripts = path.join(bundle, 'scripts');
  const dockerClient = path.join(bundle, 'deploy', 'docker-client');
  const current = path.join(root, 'current');
  const bin = path.join(root, 'bin');
  const dataParent = path.join(root, 'data');
  const dataRoot = path.join(dataParent, 'kassinao');
  const recordingsSource = path.join(current, 'recordings');
  const stateSource = path.join(current, 'state');
  const outsideRecordingsSource = path.join(root, 'outside-recordings');
  const cacheVolume = path.join(root, 'docker-volumes', 'kassinao_model-cache', '_data');
  const calls = path.join(root, 'calls.log');
  mkdirSync(scripts, { recursive: true, mode: 0o700 });
  mkdirSync(dockerClient, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dockerClient, 'config.json'), '{}\n', { mode: 0o444 });
  mkdirSync(current, { mode: 0o700 });
  mkdirSync(bin, { mode: 0o700 });
  mkdirSync(dataParent, { mode: 0o700 });
  mkdirSync(recordingsSource, { mode: 0o700 });
  if (options.explicitStateMount) mkdirSync(stateSource, { mode: 0o700 });
  mkdirSync(outsideRecordingsSource, { mode: 0o700 });
  mkdirSync(cacheVolume, { recursive: true, mode: 0o700 });

  const recording = path.join(recordingsSource, 'meeting-1');
  mkdirSync(recording, { mode: 0o700 });
  writeFileSync(path.join(recording, 'meta.json'), '{"id":"meeting-1","status":"done"}\n');
  writeFileSync(path.join(recording, 'audio.pcm'), 'private audio\n');
  for (const [name, contents] of [
    ['.cookie-secret', 'cookie-secret\n'],
    ['.web-sessions.json', '{"sessions":[]}\n'],
    ['.mcp-sessions.json', '{"sessions":[]}\n'],
    ['.recording-admission.json', '{"quota":true}\n'],
    ['.discord-surface-inventory.json', '{"surface":true}\n'],
    ['autorecord.json', '{"enabled":false}\n'],
  ]) {
    writeFileSync(path.join(recordingsSource, name), contents);
  }
  writeFileSync(path.join(cacheVolume, 'model.bin'), 'cached model\n');
  if (options.unknownRootFile) writeFileSync(path.join(recordingsSource, 'unknown-private.json'), '{}\n');

  writeFileSync(path.join(current, '.env'), 'TRANSCRIBE_PROVIDER=assemblyai\nTUNNEL_TOKEN=private\n', { mode: 0o600 });
  writeFileSync(path.join(current, 'docker-compose.yml'), 'services: {}\n', { mode: 0o644 });

  const uid = process.getuid?.() ?? 501;
  const gid = process.getgid?.() ?? 20;
  writeFileSync(
    path.join(bundle, '.env'),
    [
      'KASSINAO_HOST_SCOPE=shared',
      'KASSINAO_DEDICATED_DOCKER_HOST_ACK=',
      `KASSINAO_DATA_ROOT=${dataRoot}`,
      `KASSINAO_RECORDINGS_DIR=${dataRoot}/recordings`,
      `KASSINAO_STATE_DIR=${dataRoot}/state`,
      `KASSINAO_AUTH_DIR=${dataRoot}/auth`,
      `KASSINAO_MODEL_CACHE_DIR=${dataRoot}/cache`,
      'KASSINAO_UID=61050',
      'KASSINAO_GID=61050',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );

  const safePath = `${bin}:/opt/homebrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
  const helper = path.join(scripts, 'prepare-legacy-shared-layout.sh');
  const fixtureHelper = HELPER_SOURCE.replace(
    'SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    `SAFE_SYSTEM_PATH=${safePath}`,
  )
    .replace(
      /# KASSINAO_HOST_NO_DUMP_BEGIN[\s\S]*?# KASSINAO_HOST_NO_DUMP_END/,
      '# KASSINAO_HOST_NO_DUMP_BEGIN\nunset LD_PRELOAD\n# KASSINAO_HOST_NO_DUMP_END',
    )
    .replace(
      'if parent_stat.st_uid != 0 or parent_stat.st_gid != 0 or',
      `if parent_stat.st_uid != ${uid} or parent_stat.st_gid != ${gid} or`,
    )
    .replaceAll(
      'or metadata.st_uid != 0\n        or metadata.st_gid != 0',
      `or metadata.st_uid != ${uid}\n        or metadata.st_gid != ${gid}`,
    )
    .replace(
      'or parent_metadata.st_uid != 0\n        or parent_metadata.st_gid != 0',
      `or parent_metadata.st_uid != ${uid}\n        or parent_metadata.st_gid != ${gid}`,
    )
    .replace(
      'or item.st_uid != 0\n            or item.st_gid != 0',
      `or item.st_uid != ${uid}\n            or item.st_gid != ${gid}`,
    )
    .replaceAll('os.chown(state_dir, 0, 0)', 'os.chown(state_dir, os.getuid(), os.getgid())')
    .replaceAll('os.chown(staging, 0, 0)', 'os.chown(staging, os.getuid(), os.getgid())')
    .replaceAll('os.chown(destination, 0, 0)', 'os.chown(destination, os.getuid(), os.getgid())');
  writeFileSync(helper, fixtureHelper, { mode: 0o755 });
  chmodSync(helper, 0o755);
  const validator = path.join(scripts, 'validate-legacy-dedicated-installation.sh');
  writeFileSync(
    validator,
    VALIDATOR_SOURCE.replace(
      'SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      `SAFE_SYSTEM_PATH=${safePath}`,
    ).replace(
      /# KASSINAO_HOST_NO_DUMP_BEGIN[\s\S]*?# KASSINAO_HOST_NO_DUMP_END/,
      '# KASSINAO_HOST_NO_DUMP_BEGIN\nunset LD_PRELOAD\n# KASSINAO_HOST_NO_DUMP_END',
    ),
    { mode: 0o755 },
  );
  chmodSync(validator, 0o755);
  const verifier = path.join(scripts, 'verify-shared-luks-storage.sh');
  executable(
    verifier,
    `#!/usr/bin/env bash
set -eu
[ "\${KASSINAO_ENV_FILE:-}" = ${shellLiteral(path.join(bundle, '.env'))} ] || exit 91
printf 'verifier:%s\n' "$*" >> ${shellLiteral(calls)}
`,
  );

  executable(path.join(bin, 'id'), '#!/usr/bin/env bash\n[ "${1:-}" = -u ] && printf "0\\n"\n');
  executable(
    path.join(bin, 'readlink'),
    `#!/usr/bin/env bash
set -eu
last=''; for value in "$@"; do last="$value"; done
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
format=''; previous=''; last=''
for value in "$@"; do
  if [ "$previous" = -c ]; then format="$value"; fi
  previous="$value"; last="$value"
done
if [ "$format" = %h ]; then printf '1\n'; exit 0; fi
case "$last" in
  ${shellLiteral(bundle)}|${shellLiteral(root)}|${shellLiteral(current)}|${shellLiteral(dataParent)}) printf '700:0:0\n' ;;
  ${shellLiteral(path.join(bundle, '.env'))}|${shellLiteral(path.join(current, '.env'))}) printf '600:0:0\n' ;;
  ${shellLiteral(path.join(current, 'docker-compose.yml'))}|${shellLiteral(path.join(bundle, 'MANIFEST.sha256'))}) printf '644:0:0\n' ;;
  *) printf '755:0:0\n' ;;
esac
`,
  );
  const ids = { core: 'a'.repeat(64), tunnel: 'c'.repeat(64), neighbor: 'f'.repeat(64) };
  const inventory = [
    {
      Id: ids.core,
      Name: '/kassinao',
      Config: {
        Labels: {
          'com.docker.compose.project': 'kassinao',
          'com.docker.compose.service': 'kassinao',
          'com.docker.compose.project.working_dir': current,
          'com.docker.compose.project.config_files': path.join(current, 'docker-compose.yml'),
        },
      },
      State: { Running: options.running === true, Restarting: false },
      HostConfig: { RestartPolicy: { Name: 'no' } },
      Mounts: [
        {
          Type: 'bind',
          Source: options.bindOutsideCurrent ? outsideRecordingsSource : recordingsSource,
          Destination: '/app/recordings',
          RW: true,
        },
        {
          Type: 'volume',
          Name: 'kassinao_model-cache',
          Source: cacheVolume,
          Destination: '/home/node/.cache',
          RW: true,
        },
      ],
    },
    {
      Id: ids.tunnel,
      Name: '/kassinao-tunnel',
      Config: {
        Labels: {
          'com.docker.compose.project': 'kassinao',
          'com.docker.compose.service': 'cloudflared',
          'com.docker.compose.project.working_dir': current,
          'com.docker.compose.project.config_files': path.join(current, 'docker-compose.yml'),
        },
      },
      State: { Running: false, Restarting: false },
      HostConfig: { RestartPolicy: { Name: 'no' } },
      Mounts: [],
    },
    {
      Id: ids.neighbor,
      Name: '/company-app',
      Config: { Labels: {} },
      State: { Running: true },
      HostConfig: {
        VolumesFrom: options.foreignVolumesFrom ? ['kassinao:ro'] : [],
        Binds: [],
      },
      Mounts: options.foreignMount
        ? [{ Type: 'bind', Source: recordingsSource, Destination: '/stolen-recordings', RW: false }]
        : [],
    },
  ];
  if (options.explicitStateMount) {
    inventory[0]!.Mounts.splice(1, 0, {
      Type: 'bind',
      Source: stateSource,
      Destination: '/app/state',
      RW: true,
    });
  }
  const inventoryPath = path.join(root, 'docker.json');
  const lateInventoryPath = path.join(root, 'docker-late.json');
  const inspectCount = path.join(root, 'inspect-count');
  const findmntCount = path.join(root, 'findmnt-count');
  const forceNestedMount = path.join(root, 'force-nested-mount');
  const nestedPayload = JSON.stringify({
    filesystems: [{ target: path.join(recordingsSource, 'meeting-1') }],
  });
  executable(
    path.join(bin, 'findmnt'),
    `#!/usr/bin/env bash
set -eu
count=0
[ ! -f ${shellLiteral(findmntCount)} ] || count="$(cat ${shellLiteral(findmntCount)})"
count="$((count + 1))"
printf '%s\n' "$count" > ${shellLiteral(findmntCount)}
if [ -f ${shellLiteral(forceNestedMount)} ] || { [ ${options.lateNestedMount ? 1 : 0} -eq 1 ] && [ "$count" -ge 2 ]; }; then
  printf '%s\n' ${shellLiteral(nestedPayload)}
else
  printf '%s\n' '{"filesystems":[]}'
fi
`,
  );
  writeFileSync(inventoryPath, JSON.stringify(inventory));
  const lateInventory = structuredClone(inventory);
  lateInventory[2].Mounts = [{ Type: 'bind', Source: cacheVolume, Destination: '/late-cache-access', RW: false }];
  writeFileSync(lateInventoryPath, JSON.stringify(lateInventory));
  const volumeInventory = [
    {
      Name: 'kassinao_model-cache',
      Driver: 'local',
      Scope: 'local',
      Mountpoint: cacheVolume,
      Labels: {
        'com.docker.compose.project': options.volumeSpoof ? 'company-app' : 'kassinao',
        'com.docker.compose.volume': 'model-cache',
      },
    },
  ];
  const volumeInventoryPath = path.join(root, 'docker-volume.json');
  writeFileSync(volumeInventoryPath, JSON.stringify(volumeInventory));
  executable(
    path.join(bin, 'docker'),
    `#!/usr/bin/env bash
set -eu
printf 'docker:%s\n' "$*" >> ${shellLiteral(calls)}
case "\${1:-}" in
  info) printf '29.0.1\n' ;;
  ps) printf '%s\n' '${ids.core}' '${ids.tunnel}' '${ids.neighbor}' ;;
  inspect)
    template="\${3:-}"
    shift 3
    selected=${shellLiteral(inventoryPath)}
    if [[ "$template" == *'State'* ]]; then
      count=0
      [ ! -f ${shellLiteral(inspectCount)} ] || count="$(cat ${shellLiteral(inspectCount)})"
      count="$((count + 1))"
      printf '%s\n' "$count" > ${shellLiteral(inspectCount)}
      if [ ${options.lateForeignMount ? 1 : 0} -eq 1 ] && [ "$count" -ge 2 ]; then selected=${shellLiteral(lateInventoryPath)}; fi
    fi
    python3 - "$selected" "$template" "$@" <<'PY'
import json, sys
inventory, template, *wanted = sys.argv[1:]
with open(inventory, encoding='utf-8') as source:
    items = {item['Id']: item for item in json.load(source)}
for identity in wanted:
    item = items[identity]
    labels = (item.get('Config') or {}).get('Labels') or {}
    if 'WorkingDir' in template:
        result = {'Id': item['Id'], 'WorkingDir': labels.get('com.docker.compose.project.working_dir'), 'ConfigFiles': labels.get('com.docker.compose.project.config_files')}
    elif 'State' not in template:
        result = {'Id': item['Id'], 'Name': item['Name'], 'Config': {'Labels': {'com.docker.compose.project': labels.get('com.docker.compose.project'), 'com.docker.compose.service': labels.get('com.docker.compose.service')}}}
    else:
        result = item
    print(json.dumps(result, separators=(',', ':')))
PY
    ;;
  volume)
    [ "\${2:-}" = inspect ] || exit 92
    python3 - ${shellLiteral(volumeInventoryPath)} <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf-8') as source:
    print(json.dumps(json.load(source)[0], separators=(',', ':')))
PY
    ;;
  *) exit 90 ;;
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
python3 - ${shellLiteral(bundle)} <<'PY'
import hashlib, os, sys
root = sys.argv[1]
with open(os.path.join(root, 'MANIFEST.sha256'), encoding='utf-8') as handle:
    for raw in handle:
        expected, relative = raw.rstrip('\\n').split('  ', 1)
        with open(os.path.join(root, relative.removeprefix('./')), 'rb') as source:
            if hashlib.sha256(source.read()).hexdigest() != expected:
                raise SystemExit(1)
PY
`,
  );

  const manifestEntries = [
    'scripts/prepare-legacy-shared-layout.sh',
    'scripts/validate-legacy-dedicated-installation.sh',
    'scripts/verify-shared-luks-storage.sh',
  ].map(
    (relative) =>
      `${createHash('sha256')
        .update(readFileSync(path.join(bundle, relative)))
        .digest('hex')}  ${relative}`,
  );
  writeFileSync(path.join(bundle, 'MANIFEST.sha256'), `${manifestEntries.join('\n')}\n`, { mode: 0o644 });

  const run = (args: string[]) =>
    spawnSync('bash', [helper, ...args], {
      cwd: bundle,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, DISCORD_TOKEN: 'must-not-leak' },
    });
  return {
    bundle,
    cacheVolume,
    calls,
    current,
    dataRoot,
    forceNestedMount,
    helper,
    recordingsSource,
    root,
    run,
  };
}

function simulateEncryptedMigration(value: ReturnType<typeof fixture>): string {
  const rollback = `${value.dataRoot}.plaintext-before-shared-luks`;
  renameSync(value.dataRoot, rollback);
  cpSync(rollback, value.dataRoot, { recursive: true, preserveTimestamps: true });
  chmodSync(value.dataRoot, 0o700);
  const control = path.join(value.dataRoot, '.legacy-shared-transition');
  chmodSync(control, 0o700);
  chmodSync(path.join(control, 'layout.json'), 0o600);
  chmodSync(path.join(control, 'source-manifest.jsonl'), 0o600);
  return rollback;
}

describe('preparo transacional do layout shared legado', () => {
  it('mantém sintaxe válida e projeta chaves opcionais de mounts sem exigir presença no Docker 29', () => {
    const syntax = spawnSync('bash', ['-n', path.join(ROOT, 'scripts', 'prepare-legacy-shared-layout.sh')], {
      encoding: 'utf8',
    });
    expect(syntax.status, syntax.stderr).toBe(0);
    expect(HELPER_SOURCE).toContain('{{json (index $mount "Name")}}');
    expect(HELPER_SOURCE).toContain('{{json $mount.Source}}');
    expect(HELPER_SOURCE).not.toContain('{{json $mount.Name}}');
    expect(HELPER_SOURCE).toContain("mount_type in ('bind', 'volume')");
    expect(HELPER_SOURCE).toContain("not isinstance(mount.get('Name'), str) or not mount.get('Name')");
  });

  it('consolida recordings e named-volume cache, preservando estado/auth legados e originais', () => {
    const value = fixture();
    const prepared = value.run([value.current]);
    expect(prepared.status, `${prepared.stderr}\n${prepared.stdout}`).toBe(0);
    expect(prepared.stdout).toContain('Layout legado consolidado e verificado');
    expect(readFileSync(path.join(value.dataRoot, 'recordings', 'meeting-1', 'audio.pcm'), 'utf8')).toBe(
      'private audio\n',
    );
    for (const legacyState of [
      '.cookie-secret',
      '.web-sessions.json',
      '.mcp-sessions.json',
      '.recording-admission.json',
      '.discord-surface-inventory.json',
      'autorecord.json',
    ]) {
      expect(existsSync(path.join(value.dataRoot, 'recordings', legacyState))).toBe(true);
      expect(existsSync(path.join(value.recordingsSource, legacyState))).toBe(true);
    }
    expect(readFileSync(path.join(value.dataRoot, 'cache', 'model.bin'), 'utf8')).toBe('cached model\n');
    expect(readdirSync(path.join(value.dataRoot, 'state'))).toEqual([]);
    expect(readdirSync(path.join(value.dataRoot, 'auth'))).toEqual([]);
    expect(readFileSync(path.join(value.recordingsSource, 'meeting-1', 'audio.pcm'), 'utf8')).toBe('private audio\n');
    expect(readFileSync(path.join(value.cacheVolume, 'model.bin'), 'utf8')).toBe('cached model\n');
    const marker = JSON.parse(
      readFileSync(path.join(value.dataRoot, '.legacy-shared-transition', 'layout.json'), 'utf8'),
    );
    expect(marker.status).toBe('prepared');
    expect(marker.colocated_files).toEqual({
      '.cookie-secret': { name: '.cookie-secret', tree: 'auth' },
      '.discord-surface-inventory.json': { name: 'discord-surface-inventory.json', tree: 'state' },
      '.mcp-sessions.json': { name: 'mcp-sessions.json', tree: 'auth' },
      '.recording-admission.json': { name: 'recording-admission.json', tree: 'state' },
      '.web-sessions.json': { name: 'web-sessions.json', tree: 'auth' },
      'autorecord.json': { name: 'autorecord.json', tree: 'state' },
    });
    expect(existsSync(path.join(value.bundle, '.legacy-shared-transition'))).toBe(false);
    expect(`${prepared.stdout}\n${prepared.stderr}`).not.toContain(value.current);
    expect(`${prepared.stdout}\n${prepared.stderr}`).not.toContain('must-not-leak');

    const repeated = value.run([value.current]);
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(repeated.stdout).toContain('já estava preparado');
  });

  it('recusa arquivo root desconhecido no recordings legado antes de criar DATA_ROOT', () => {
    const value = fixture({ unknownRootFile: true });
    const result = value.run([value.current]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('arquivo root desconhecido');
    expect(existsSync(value.dataRoot)).toBe(false);
  });

  it('recusa conflito entre estado co-located e mount state explícito', () => {
    const value = fixture({ explicitStateMount: true });
    const result = value.run([value.current]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('conflita com mount legado de state');
    expect(existsSync(value.dataRoot)).toBe(false);
  });

  it('recusa container ainda rodando antes de criar DATA_ROOT ou marker', () => {
    const value = fixture({ running: true });
    const result = value.run([value.current]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('containers Kassinão precisam estar parados');
    expect(existsSync(value.dataRoot)).toBe(false);
    expect(existsSync(path.join(value.bundle, '.legacy-shared-transition'))).toBe(false);
  });

  it.each([
    ['mount read-only sobre recordings', { foreignMount: true }],
    ['volumes-from do core', { foreignVolumesFrom: true }],
  ] as const)('recusa vizinho com %s antes de copiar', (_label, options) => {
    const value = fixture(options);
    const result = value.run([value.current]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/workload vizinho/);
    expect(existsSync(value.dataRoot)).toBe(false);
  });

  it('recusa bind que não é o filho exato allowlisted de CURRENT_ROOT', () => {
    const value = fixture({ bindOutsideCurrent: true });
    const result = value.run([value.current]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('filho exato allowlisted de CURRENT_ROOT');
    expect(existsSync(value.dataRoot)).toBe(false);
  });

  it('recusa named volume com identidade Compose falsificada', () => {
    const value = fixture({ volumeSpoof: true });
    const result = value.run([value.current]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('identidade do named volume legado diverge');
    expect(existsSync(value.dataRoot)).toBe(false);
  });

  it('repete o gate de mounts vizinhos imediatamente antes da cópia', () => {
    const value = fixture({ lateForeignMount: true });
    const result = value.run([value.current]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('workload vizinho possui mount sobre source legado protegido');
    expect(existsSync(path.join(value.dataRoot, 'recordings', 'meeting-1', 'audio.pcm'))).toBe(false);
  });

  it('repete o inventário findmnt imediatamente antes da cópia e recusa nested mount tardio', () => {
    const value = fixture({ lateNestedMount: true });
    const result = value.run([value.current]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('nested mount detectado no layout legado');
    expect(existsSync(path.join(value.dataRoot, 'recordings', 'meeting-1', 'audio.pcm'))).toBe(false);
  });

  it('expurga somente sources revalidados e mantém o rollback consolidado intacto', () => {
    const value = fixture();
    expect(value.run([value.current]).status).toBe(0);
    const rollback = simulateEncryptedMigration(value);
    const purge = value.run(['--purge-originals', value.current, '--confirm-after-app-and-backup-validation']);
    expect(purge.status, `${purge.stderr}\n${purge.stdout}`).toBe(0);
    expect(purge.stdout).toContain('rollback de dados consolidado permaneceu intacto');
    expect(readdirSync(value.recordingsSource)).toEqual([]);
    expect(readdirSync(value.cacheVolume)).toEqual([]);
    expect(readFileSync(path.join(rollback, 'recordings', 'meeting-1', 'audio.pcm'), 'utf8')).toBe('private audio\n');
    expect(readFileSync(path.join(rollback, 'cache', 'model.bin'), 'utf8')).toBe('cached model\n');
    const marker = JSON.parse(
      readFileSync(path.join(value.dataRoot, '.legacy-shared-transition', 'layout.json'), 'utf8'),
    );
    expect(marker.status).toBe('purged');
    expect(marker.legacy_env_status).toBe('removed');
    expect(existsSync(path.join(value.current, '.env'))).toBe(false);
    expect(existsSync(path.join(value.bundle, '.legacy-shared-transition'))).toBe(false);
  });

  it('recusa drift de bytes no .env legado sem expurgar dados', () => {
    const value = fixture();
    expect(value.run([value.current]).status).toBe(0);
    simulateEncryptedMigration(value);
    appendFileSync(path.join(value.current, '.env'), 'DRIFT=1\n');

    const purge = value.run(['--purge-originals', value.current, '--confirm-after-app-and-backup-validation']);
    expect(purge.status).not.toBe(0);
    expect(purge.stderr).toContain('.env legado divergiu');
    expect(readFileSync(path.join(value.recordingsSource, 'meeting-1', 'audio.pcm'), 'utf8')).toBe('private audio\n');
  });

  it('recusa hardlink tardio no .env legado', () => {
    const value = fixture();
    expect(value.run([value.current]).status).toBe(0);
    simulateEncryptedMigration(value);
    linkSync(path.join(value.current, '.env'), path.join(value.current, '.env-hardlink'));

    const purge = value.run(['--purge-originals', value.current, '--confirm-after-app-and-backup-validation']);
    expect(purge.status).not.toBe(0);
    expect(purge.stderr).toContain('sem symlink ou hardlink');
    expect(existsSync(path.join(value.current, '.env'))).toBe(true);
  });

  it('recusa troca tardia do .env legado por symlink', () => {
    const value = fixture();
    expect(value.run([value.current]).status).toBe(0);
    simulateEncryptedMigration(value);
    const original = path.join(value.current, '.env-original');
    renameSync(path.join(value.current, '.env'), original);
    symlinkSync(original, path.join(value.current, '.env'));

    const purge = value.run(['--purge-originals', value.current, '--confirm-after-app-and-backup-validation']);
    expect(purge.status).not.toBe(0);
    expect(purge.stderr).toContain('sem symlink ou hardlink');
    expect(readFileSync(original, 'utf8')).toContain('TRANSCRIBE_PROVIDER');
    unlinkSync(path.join(value.current, '.env'));
  });

  it('na retomada purging revalida findmnt antes de qualquer deleção', () => {
    const value = fixture();
    expect(value.run([value.current]).status).toBe(0);
    simulateEncryptedMigration(value);
    const markerPath = path.join(value.dataRoot, '.legacy-shared-transition', 'layout.json');
    const marker = readFileSync(markerPath, 'utf8');
    writeFileSync(markerPath, marker.replace('"status":"prepared"', '"status":"purging"'), { mode: 0o600 });
    writeFileSync(value.forceNestedMount, 'enabled\n');

    const resumed = value.run(['--purge-originals', value.current, '--confirm-after-app-and-backup-validation']);
    expect(resumed.status).not.toBe(0);
    expect(resumed.stderr).toContain('mount detectado no layout legado');
    expect(readFileSync(path.join(value.recordingsSource, 'meeting-1', 'audio.pcm'), 'utf8')).toBe('private audio\n');
    expect(readFileSync(path.join(value.cacheVolume, 'model.bin'), 'utf8')).toBe('cached model\n');
    expect(existsSync(path.join(value.bundle, '.legacy-shared-transition'))).toBe(false);
  });
});
