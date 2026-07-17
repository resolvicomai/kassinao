import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'transition-runtime-topology.sh');
const SOURCE = readFileSync(SCRIPT_PATH, 'utf8');
const LEGACY_COMPOSE_FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'docker-compose.dedicated-v1.4.14-v1.4.16.yml');
const LEGACY_COMPOSE_SHA256 = 'f4d545edbdfe50910126afc441fe7dd47de5eacf3a9cf171c6d2c1a47a1ad2ef';

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function executable(file: string, source: string): void {
  writeFileSync(file, source, { mode: 0o755 });
  chmodSync(file, 0o755);
}

function manifest(bundle: string, files: string[]): void {
  const lines = files.sort().map((relative) => {
    const digest = createHash('sha256')
      .update(readFileSync(path.join(bundle, relative)))
      .digest('hex');
    return `${digest}  ${relative}`;
  });
  writeFileSync(path.join(bundle, 'MANIFEST.sha256'), `${lines.join('\n')}\n`, { mode: 0o644 });
}

function createBundle(
  root: string,
  role: 'current' | 'legacy',
  transitionSource: string,
  events: string,
  policyState: string,
  failRemoveOnce?: string,
  failPreloadOnce?: string,
): { bundle: string; compose: [string, string]; env: string } {
  const bundle = path.join(root, role);
  const scripts = path.join(bundle, 'scripts');
  const dockerClient = path.join(bundle, 'deploy', 'docker-client');
  const runtime = path.join(bundle, 'runtime', 'linux-amd64');
  for (const directory of [bundle, scripts, dockerClient, runtime]) {
    mkdirSync(directory, { recursive: true, mode: directory === bundle ? 0o700 : 0o755 });
  }
  chmodSync(bundle, 0o700);
  const health = '#!/usr/bin/env bash\nexit 0\n';
  const hardener = `#!/usr/bin/env bash
printf 'hardener:${role}:%s\\n' "$*" >> ${shellLiteral(events)}
case "\${*: -1}" in
  --removal-state)
    [ ${shellLiteral(role)} = current ] || exit 1
    case "$(cat ${shellLiteral(policyState)})" in
      current) printf 'present\\n' ;;
      current-v4-progress|current-v6-progress) printf 'owned-progress\\n' ;;
      none) printf 'absent\\n' ;;
      *) exit 1 ;;
    esac
    ;;
  --legacy-removal-state)
    [ ${shellLiteral(role)} = current ] || exit 1
    case "$(cat ${shellLiteral(policyState)})" in
      legacy) printf 'present\\n' ;;
      legacy-v4-progress|legacy-v6-progress) printf 'owned-progress\\n' ;;
      none) printf 'absent\\n' ;;
      *) exit 1 ;;
    esac
    ;;
  --remove-legacy-policy)
    [ ${shellLiteral(role)} = current ] || exit 1
    case "$(cat ${shellLiteral(policyState)})" in
      legacy|legacy-v4-progress|legacy-v6-progress) printf 'none\\n' > ${shellLiteral(policyState)} ;;
      none) ;;
      *) exit 1 ;;
    esac
    ;;
  --check) [ "$(cat ${shellLiteral(policyState)})" = ${shellLiteral(role)} ] ;;
  --preload)
    ${
      failPreloadOnce
        ? `[ ! -f ${shellLiteral(failPreloadOnce)} ] || { printf 'legacy-v4-progress\\n' > ${shellLiteral(policyState)}; rm -- ${shellLiteral(failPreloadOnce)}; exit 76; }`
        : ':'
    }
    printf '${role}\\n' > ${shellLiteral(policyState)}
    ;;
  --remove)
    [ ${shellLiteral(role)} = current ] || exit 98
    ${
      failRemoveOnce
        ? `[ ! -f ${shellLiteral(failRemoveOnce)} ] || { printf 'current-v6-progress\\n' > ${shellLiteral(policyState)}; rm -- ${shellLiteral(failRemoveOnce)}; exit 75; }`
        : ':'
    }
    printf 'none\\n' > ${shellLiteral(policyState)}
    ;;
  *) exit 1 ;;
esac
`;
  const noDump = '#!/usr/bin/env python3\nraise SystemExit(0)\n';
  executable(path.join(scripts, 'health-watch.sh'), health);
  executable(path.join(scripts, 'harden-docker-egress.sh'), hardener);
  executable(path.join(scripts, 'no-dump-exec.py'), noDump);
  if (role === 'current') executable(path.join(scripts, 'transition-runtime-topology.sh'), transitionSource);
  writeFileSync(path.join(runtime, 'libkassinao-no-dump.so'), 'fixture\n', { mode: 0o444 });
  writeFileSync(path.join(dockerClient, 'config.json'), '{}\n', { mode: 0o444 });
  chmodSync(dockerClient, 0o755);
  const compose: [string, string] = [
    path.join(bundle, 'docker-compose.yml'),
    path.join(bundle, 'docker-compose.shared.yml'),
  ];
  writeFileSync(compose[0], `# ${role} base fixture\n`, { mode: 0o644 });
  writeFileSync(compose[1], `# ${role} shared fixture\n`, { mode: 0o644 });
  const env = path.join(bundle, '.env');
  writeFileSync(
    env,
    [
      'KASSINAO_HOST_SCOPE=shared',
      'COMPOSE_PROFILES=tunnel,split-public',
      `KASSINAO_DATA_ROOT=${path.join(root, 'data')}`,
      `KASSINAO_STATE_DIR=${path.join(root, 'data', 'state')}`,
      `KASSINAO_RECORDINGS_DIR=${path.join(root, 'data', 'recordings')}`,
      `KASSINAO_SHARED_APP_ENV_FILE=${path.join(root, 'data', 'config', 'app.env')}`,
      'KASSINAO_ROLLBACK_RETENTION_HOURS=72',
      `KASSINAO_UID=${process.getuid?.() ?? 0}`,
      `KASSINAO_GID=${process.getgid?.() ?? 0}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  writeFileSync(path.join(bundle, '.deploy.lock'), '', { mode: 0o600 });
  const files = [
    'scripts/health-watch.sh',
    'scripts/harden-docker-egress.sh',
    'scripts/no-dump-exec.py',
    'deploy/docker-client/config.json',
    'docker-compose.yml',
    'docker-compose.shared.yml',
  ];
  if (role === 'current') files.push('scripts/transition-runtime-topology.sh');
  manifest(bundle, files);
  return { bundle, compose, env };
}

function neutralFixture(
  options: {
    currentRunning?: boolean;
    dockerReadFailOnce?: string;
    failCurrentRemoveOnce?: boolean;
    failHealthAfter?: 'kassinao' | 'kassinao-public' | 'kassinao-tunnel';
    failLegacyPreloadOnce?: boolean;
    inverseLegacyProfiles?: boolean;
    recordingAfterHealthStart?: boolean;
    recordingAfterStop?: boolean;
    systemctlFailOnce?: string;
    trustProxyHops?: '0' | '1' | '2';
  } = {},
) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'kassinao-topology-transition-')));
  chmodSync(root, 0o700);
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const bin = path.join(root, 'bin');
  const hostEtc = path.join(root, 'host', 'etc-kassinao');
  const hostSbin = path.join(root, 'host', 'sbin');
  const runtime = path.join(root, 'host', 'runtime');
  const data = path.join(root, 'data');
  const state = path.join(data, 'state');
  const recordings = path.join(data, 'recordings');
  const config = path.join(data, 'config');
  const appEnv = path.join(config, 'app.env');
  const transitionState = path.join(data, 'transition-state');
  const events = path.join(root, 'events.log');
  const dockerState = path.join(root, 'docker-state.json');
  const timerState = path.join(root, 'timer-state');
  const policyState = path.join(root, 'policy-state');
  const failCurrentRemove = path.join(root, 'fail-current-remove-once');
  const failDockerRead = path.join(root, 'fail-docker-read-once');
  const failHealthAfter = path.join(root, 'fail-health-after');
  const failLegacyPreload = path.join(root, 'fail-legacy-preload-once');
  const failSystemctl = path.join(root, 'fail-systemctl-once');
  const recordingAfterHealthStart = path.join(root, 'recording-after-health-start');
  for (const directory of [bin, hostEtc, hostSbin, runtime, data, state, recordings, config, transitionState]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  chmodSync(hostEtc, 0o755);
  chmodSync(hostSbin, 0o755);
  writeFileSync(path.join(runtime, 'maintenance.lock'), '', { mode: 0o600 });
  writeFileSync(events, '');
  writeFileSync(timerState, 'enabled active\n');
  writeFileSync(policyState, options.currentRunning ? 'current\n' : 'none\n');
  writeFileSync(appEnv, `TRUST_PROXY_HOPS=${options.trustProxyHops ?? '1'}\n`, { mode: 0o440 });
  if (options.failCurrentRemoveOnce) writeFileSync(failCurrentRemove, '');
  if (options.dockerReadFailOnce) writeFileSync(failDockerRead, `${options.dockerReadFailOnce}\n`);
  if (options.failHealthAfter) writeFileSync(failHealthAfter, `${options.failHealthAfter}\n`, { mode: 0o600 });
  if (options.failLegacyPreloadOnce) writeFileSync(failLegacyPreload, '');
  if (options.systemctlFailOnce) writeFileSync(failSystemctl, `${options.systemctlFailOnce}\n`);
  if (options.recordingAfterHealthStart) writeFileSync(recordingAfterHealthStart, '');

  let transformed = SOURCE;
  const scrubStart = transformed.indexOf('# KASSINAO_HOST_ENV_SCRUB_BEGIN');
  const scrubEnd = transformed.indexOf('# KASSINAO_HOST_ENV_SCRUB_END');
  expect(scrubStart).toBeGreaterThan(0);
  expect(scrubEnd).toBeGreaterThan(scrubStart);
  transformed =
    transformed.slice(0, scrubStart) +
    `# KASSINAO_HOST_ENV_SCRUB_BEGIN\nexport PATH=${shellLiteral(bin)}:/usr/bin:/bin:/sbin HOME=${shellLiteral(root)} LC_ALL=C\n` +
    transformed.slice(scrubEnd);
  const noDumpStart = transformed.indexOf('# KASSINAO_HOST_NO_DUMP_BEGIN');
  const noDumpEnd = transformed.indexOf('# KASSINAO_HOST_NO_DUMP_END');
  expect(noDumpStart).toBeGreaterThan(0);
  expect(noDumpEnd).toBeGreaterThan(noDumpStart);
  transformed = transformed.slice(0, noDumpStart) + '# KASSINAO_HOST_NO_DUMP_BEGIN\n:\n' + transformed.slice(noDumpEnd);
  const lockProofStart = transformed.indexOf('assert_fd_lock() {');
  const lockProofEnd = transformed.indexOf('\n}\n', lockProofStart);
  expect(lockProofStart).toBeGreaterThan(0);
  expect(lockProofEnd).toBeGreaterThan(lockProofStart);
  transformed =
    transformed.slice(0, lockProofStart) + 'assert_fd_lock() { :; }\n' + transformed.slice(lockProofEnd + 3);
  transformed = transformed
    .replaceAll('/etc/kassinao/host-controls.env', path.join(hostEtc, 'host-controls.env'))
    .replaceAll('/etc/kassinao', hostEtc)
    .replaceAll('/usr/local/sbin/kassinao-health-watch', path.join(hostSbin, 'kassinao-health-watch'))
    .replaceAll('/usr/local/sbin/kassinao-harden-docker-egress', path.join(hostSbin, 'kassinao-harden-docker-egress'))
    .replaceAll('/run/lock/kassinao', runtime)
    .replaceAll(':0:0:1', `:${uid}:${gid}:1`)
    .replaceAll(':0:0"', `:${uid}:${gid}"`)
    .replaceAll(':0:0 ]', `:${uid}:${gid} ]`)
    .replaceAll('"440:0:$APP_GID:1"', `"440:${uid}:$APP_GID:1"`)
    .replaceAll('[ "$APP_UID" -ge 61000 ] && [ "$APP_UID" -le 61183 ]', '[ "$APP_UID" -ge 0 ]')
    .replaceAll('[ "$APP_GID" -ge 61000 ] && [ "$APP_GID" -le 61183 ]', '[ "$APP_GID" -ge 0 ]')
    .replaceAll('os.chown(temporary, 0, 0', `os.chown(temporary, ${uid}, ${gid}`);

  const current = createBundle(
    root,
    'current',
    transformed,
    events,
    policyState,
    options.failCurrentRemoveOnce ? failCurrentRemove : undefined,
  );
  const legacy = createBundle(
    root,
    'legacy',
    transformed,
    events,
    policyState,
    undefined,
    options.failLegacyPreloadOnce ? failLegacyPreload : undefined,
  );
  const transitionPath = path.join(current.bundle, 'scripts', 'transition-runtime-topology.sh');
  let sealedTransition = readFileSync(transitionPath, 'utf8');
  for (const [expected, file] of [
    ['f4d545edbdfe50910126afc441fe7dd47de5eacf3a9cf171c6d2c1a47a1ad2ef', legacy.compose[0]],
    ['18553d4bc3200b8cbe8dce44251956266fb7cac9334ac8550f426fe7c03a2e3b', legacy.compose[1]],
    [
      '50bfe17476580357f3f18439caeefdbd565fc0b09b7156899fe0cb461e8e3829',
      path.join(legacy.bundle, 'scripts', 'harden-docker-egress.sh'),
    ],
    [
      '08e3d81f9caab710db565b9ac9e71f4249197633a7294e26618b1645aba4de48',
      path.join(legacy.bundle, 'scripts', 'health-watch.sh'),
    ],
  ] as const) {
    sealedTransition = sealedTransition.replaceAll(
      expected,
      createHash('sha256').update(readFileSync(file)).digest('hex'),
    );
  }
  writeFileSync(transitionPath, sealedTransition, { mode: 0o755 });
  manifest(current.bundle, [
    'scripts/health-watch.sh',
    'scripts/harden-docker-egress.sh',
    'scripts/no-dump-exec.py',
    'scripts/transition-runtime-topology.sh',
    'deploy/docker-client/config.json',
    'docker-compose.yml',
    'docker-compose.shared.yml',
  ]);
  if (options.inverseLegacyProfiles) {
    writeFileSync(
      legacy.env,
      readFileSync(legacy.env, 'utf8').replace(
        'COMPOSE_PROFILES=tunnel,split-public',
        'COMPOSE_PROFILES=split-public,tunnel',
      ),
      { mode: 0o600 },
    );
  }
  writeFileSync(
    path.join(hostEtc, 'host-controls.env'),
    [
      'KASSINAO_HOST_SCOPE=shared',
      `KASSINAO_DEPLOY_DIR=${current.bundle}`,
      `KASSINAO_DATA_ROOT=${data}`,
      'KASSINAO_ROLLBACK_RETENTION_HOURS=72',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(hostSbin, 'kassinao-health-watch'),
    readFileSync(path.join(current.bundle, 'scripts', 'health-watch.sh')),
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(hostSbin, 'kassinao-harden-docker-egress'),
    readFileSync(path.join(current.bundle, 'scripts', 'harden-docker-egress.sh')),
    { mode: 0o755 },
  );

  executable(
    path.join(bin, 'id'),
    `#!/usr/bin/env bash
if [ "\${1:-}" = -u ]; then printf '0\\n'; else /usr/bin/id "$@"; fi
`,
  );
  executable(path.join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n');
  executable(path.join(bin, 'findmnt'), `#!/usr/bin/env bash\nprintf '%s\\n' ${shellLiteral(data)}\n`);
  executable(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  for (const command of ['iptables', 'ip6tables']) {
    executable(
      path.join(bin, command),
      `#!/usr/bin/env bash
if [ "$(cat ${shellLiteral(policyState)})" = none ]; then
  printf '%s\\n' '-P INPUT ACCEPT' '-P FORWARD ACCEPT'
else
  printf '%s\\n' '-N KASSINAO-EGRESS' '-N KASSINAO-HOST'
fi
`,
    );
  }
  executable(
    path.join(bin, 'readlink'),
    `#!/usr/bin/env bash
if [ "\${1:-}" = -f ]; then
  shift
  [ "\${1:-}" != -- ] || shift
  /usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"
else
  /usr/bin/readlink "$@"
fi
`,
  );
  executable(
    path.join(bin, 'stat'),
    `#!/usr/bin/env bash
follow=false
case "\${1:-}" in -Lc) follow=true; shift ;; -c) shift ;; *) exec /usr/bin/stat "$@" ;; esac
format="$1"
path="$2"
/usr/bin/python3 - "$follow" "$format" "$path" <<'PY'
import os
import stat
import sys
follow = sys.argv[1] == 'true'
fmt = sys.argv[2]
value = os.stat(sys.argv[3], follow_symlinks=follow)
mapping = {
    '%a': format(stat.S_IMODE(value.st_mode), 'o'),
    '%u': str(value.st_uid),
    '%g': str(value.st_gid),
    '%h': str(value.st_nlink),
    '%d': str(value.st_dev),
    '%i': str(value.st_ino),
}
for key, replacement in mapping.items():
    fmt = fmt.replace(key, replacement)
print(fmt)
PY
`,
  );
  executable(
    path.join(bin, 'systemctl'),
    `#!/usr/bin/env bash
printf 'systemctl:%s\\n' "$*" >> ${shellLiteral(events)}
read -r enabled active < ${shellLiteral(timerState)}
consume_fail() {
  [ -f ${shellLiteral(failSystemctl)} ] || return 1
  [ "$(/bin/cat ${shellLiteral(failSystemctl)})" = "$1" ] || return 1
  /bin/rm -f ${shellLiteral(failSystemctl)}
}
case "$1:$2" in
  disable:--now)
    consume_fail watchdog-disable && exit 97
    printf 'disabled inactive\\n' > ${shellLiteral(timerState)}
    exit 0
    ;;
  stop:kassinao-health-watch.service|reset-failed:kassinao-health-watch.service) exit 0 ;;
  enable:kassinao-health-watch.timer)
    consume_fail watchdog-enable && exit 97
    printf 'enabled %s\\n' "$active" > ${shellLiteral(timerState)}
    exit 0
    ;;
  restart:kassinao-health-watch.timer)
    consume_fail watchdog-restart && exit 97
    printf '%s active\\n' "$enabled" > ${shellLiteral(timerState)}
    exit 0
    ;;
  is-enabled:--quiet)
    consume_fail watchdog-is-enabled && exit 97
    [ "$enabled" = enabled ]
    exit
    ;;
  is-active:--quiet)
    consume_fail watchdog-is-active && exit 97
    if [ "$3" = kassinao-health-watch.timer ]; then [ "$active" = active ]; else exit 1; fi
    exit
    ;;
  start:kassinao-health-watch.service)
    consume_fail watchdog-service-start && exit 97
    /usr/bin/python3 - ${shellLiteral(dockerState)} ${shellLiteral(failHealthAfter)} <<'PY'
import json
import pathlib
import sys
path = pathlib.Path(sys.argv[1])
failure_path = pathlib.Path(sys.argv[2])
state = json.loads(path.read_text())
names = list(state['containers'])
failure = failure_path.read_text(encoding='utf-8').strip() if failure_path.exists() else ''
if failure in names:
    names.remove(failure)
    names.insert(0, failure)
for name in names:
    container = state['containers'][name]
    container['running'] = True
    container['health'] = 'none' if container['service'] == 'cloudflared' else 'starting'
    container['startingChecks'] = 0 if container['service'] == 'cloudflared' else 1
    path.write_text(json.dumps(state, sort_keys=True))
    if failure == name:
        failure_path.unlink()
        raise SystemExit(97)
PY
    status=$?
    if [ "$status" -eq 0 ] && [ -f ${shellLiteral(recordingAfterHealthStart)} ]; then
      /bin/rm -f ${shellLiteral(recordingAfterHealthStart)}
      /bin/mkdir -p ${shellLiteral(path.join(recordings, 'started-during-health'))}
      /usr/bin/printf '%s\n' '{"status":"recording"}' > ${shellLiteral(
        path.join(recordings, 'started-during-health', 'meta.json'),
      )}
    fi
    exit "$status"
    ;;
  show:kassinao-health-watch.service)
    case "$4" in
      ActiveState) printf 'inactive\\n' ;;
      Result)
        consume_fail watchdog-service-result && { printf 'failed\\n'; exit 0; }
        printf 'success\\n'
        ;;
      ExecMainStatus)
        consume_fail watchdog-service-exit && { printf '97\\n'; exit 0; }
        printf '0\\n'
        ;;
      *) exit 1 ;;
    esac
    exit 0
    ;;
  show:kassinao-health-watch.timer)
    case "$4" in
      UnitFileState)
        consume_fail watchdog-show-unit-file && exit 97
        printf '%s\\n' "$enabled"
        ;;
      ActiveState)
        consume_fail watchdog-show-active && exit 97
        printf '%s\\n' "$active"
        ;;
      *) exit 1 ;;
    esac
    exit 0
    ;;
  *) exit 1 ;;
esac
`,
  );
  const currentServices = ['kassinao', 'kassinao-public', 'kassinao-router', 'cloudflared'];
  const currentNetworks = ['core_egress', 'core_link', 'edge_ingress', 'host_ingress', 'public_link', 'tunnel_egress'];
  const legacyServices = ['kassinao', 'kassinao-public', 'cloudflared'];
  const legacyNetworks = ['private', 'public'];
  function identifier(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
  const initialState: {
    containers: Record<
      string,
      {
        bundle: string;
        configFiles: string;
        health: string;
        id: string;
        networks: string[];
        restart: string;
        running: boolean;
        service: string;
      }
    >;
    networks: Record<
      string,
      {
        bridge: string;
        enableIpv6: boolean;
        gateway4: string;
        gateway6: string;
        hostBindingIpv4: string;
        id: string;
        icc: string;
        internal: boolean;
        key: string;
        members: Record<string, string>;
      }
    >;
  } = { containers: {}, networks: {} };
  if (options.currentRunning) {
    const containerDefinitions = {
      kassinao: { service: 'kassinao', networks: ['kassinao_core_egress', 'kassinao_core_link'] },
      'kassinao-router': {
        service: 'kassinao-router',
        networks: ['kassinao_core_link', 'kassinao_edge_ingress', 'kassinao_host_ingress', 'kassinao_public_link'],
      },
      'kassinao-public': { service: 'kassinao-public', networks: ['kassinao_public_link'] },
      'kassinao-tunnel': {
        service: 'cloudflared',
        networks: ['kassinao_edge_ingress', 'kassinao_tunnel_egress'],
      },
    };
    for (const [name, definition] of Object.entries(containerDefinitions)) {
      initialState.containers[name] = {
        bundle: current.bundle,
        configFiles: current.compose.join(','),
        health: definition.service === 'cloudflared' ? 'none' : 'healthy',
        id: identifier(`current:${name}`),
        networks: definition.networks,
        restart: 'no',
        running: true,
        service: definition.service,
      };
    }
    const networkDefinitions = {
      kassinao_host_ingress: {
        key: 'host_ingress',
        bridge: 'kas-host0',
        internal: false,
        enableIpv6: false,
        hostBindingIpv4: '127.0.0.1',
        gateway4: 'nat',
        gateway6: '',
        icc: 'false',
      },
      kassinao_edge_ingress: {
        key: 'edge_ingress',
        bridge: 'kas-edge0',
        internal: true,
        enableIpv6: false,
        hostBindingIpv4: '',
        gateway4: 'isolated',
        gateway6: 'isolated',
        icc: '',
      },
      kassinao_core_link: {
        key: 'core_link',
        bridge: 'kas-core0',
        internal: true,
        enableIpv6: false,
        hostBindingIpv4: '',
        gateway4: 'isolated',
        gateway6: 'isolated',
        icc: '',
      },
      kassinao_public_link: {
        key: 'public_link',
        bridge: 'kas-public0',
        internal: true,
        enableIpv6: false,
        hostBindingIpv4: '',
        gateway4: 'isolated',
        gateway6: 'isolated',
        icc: '',
      },
      kassinao_core_egress: {
        key: 'core_egress',
        bridge: 'kas-core-eg0',
        internal: false,
        enableIpv6: false,
        hostBindingIpv4: '',
        gateway4: '',
        gateway6: '',
        icc: 'false',
      },
      kassinao_tunnel_egress: {
        key: 'tunnel_egress',
        bridge: 'kas-tunnel-eg0',
        internal: false,
        enableIpv6: false,
        hostBindingIpv4: '',
        gateway4: '',
        gateway6: '',
        icc: 'false',
      },
    };
    for (const [name, definition] of Object.entries(networkDefinitions)) {
      const members: Record<string, string> = {};
      for (const [containerName, container] of Object.entries(initialState.containers)) {
        if (container.networks.includes(name)) members[container.id] = containerName;
      }
      initialState.networks[name] = {
        ...definition,
        id: identifier(`current-network:${name}`),
        members,
      };
    }
  }
  writeFileSync(dockerState, JSON.stringify(initialState));
  executable(
    path.join(bin, 'docker'),
    `#!/usr/bin/env bash
exec /usr/bin/python3 ${shellLiteral(path.join(root, 'fake-docker.py'))} "$@"
`,
  );
  writeFileSync(
    path.join(root, 'fake-docker.py'),
    `import hashlib
import json
import pathlib
import sys

state_path = pathlib.Path(${JSON.stringify(dockerState)})
events_path = pathlib.Path(${JSON.stringify(events)})
failure_path = pathlib.Path(${JSON.stringify(failDockerRead)})
recordings_path = pathlib.Path(${JSON.stringify(recordings)})
recording_after_stop = ${options.recordingAfterStop ? 'True' : 'False'}
current_bundle = ${JSON.stringify(current.bundle)}
legacy_bundle = ${JSON.stringify(legacy.bundle)}
current_configs = ${JSON.stringify(current.compose.join(','))}
legacy_configs = ${JSON.stringify(legacy.compose.join(','))}
args = sys.argv[1:]
with events_path.open('a', encoding='utf-8') as handle:
    handle.write('docker:' + ' '.join(args) + '\\n')
state = json.loads(state_path.read_text())

def save():
    state_path.write_text(json.dumps(state, sort_keys=True))

def identifier(value):
    return hashlib.sha256(value.encode()).hexdigest()

def fail_after(token):
    if failure_path.exists() and failure_path.read_text(encoding='utf-8').strip() == token:
        failure_path.unlink()
        raise SystemExit(97)

def container(reference):
    if reference in state['containers']:
        return reference, state['containers'][reference]
    for name, value in state['containers'].items():
        if value['id'] == reference:
            return name, value
    raise KeyError(reference)

def network(reference):
    if reference in state['networks']:
        return reference, state['networks'][reference]
    for name, value in state['networks'].items():
        if value['id'] == reference:
            return name, value
    raise KeyError(reference)

def create_legacy():
    definitions = {
        'kassinao': ('kassinao', ['kassinao_private']),
        'kassinao-public': ('kassinao-public', ['kassinao_public']),
        'kassinao-tunnel': ('cloudflared', ['kassinao_private', 'kassinao_public']),
    }
    for name, (service, networks) in definitions.items():
        state['containers'].setdefault(name, {
            'bundle': legacy_bundle,
            'configFiles': legacy_configs,
            'health': 'none',
            'id': identifier('legacy:' + name),
            'networks': networks,
            'restart': 'no',
            'running': False,
            'service': service,
        })
    network_definitions = {
        'kassinao_private': ('private', 'kas-private0', False, '', '', ''),
        'kassinao_public': ('public', 'kas-public0', True, 'isolated', 'isolated', ''),
    }
    for name, (key, bridge, internal, gateway4, gateway6, icc) in network_definitions.items():
        members = {
            value['id']: container_name
            for container_name, value in state['containers'].items()
            if name in value['networks']
        }
        state['networks'].setdefault(name, {
            'bridge': bridge,
            'enableIpv6': False,
            'gateway4': gateway4,
            'gateway6': gateway6,
            'hostBindingIpv4': '',
            'id': identifier('legacy-network:' + name),
            'icc': icc,
            'internal': internal,
            'key': key,
            'members': members,
        })
    save()

if not args:
    raise SystemExit(1)
if args[0] == 'info':
    print('29.0.0')
elif args[0] == 'compose':
    topology = 'current' if current_bundle in args else 'legacy'
    services = {
        'current': ['kassinao', 'kassinao-public', 'kassinao-router', 'cloudflared'],
        'legacy': ['kassinao', 'kassinao-public', 'cloudflared'],
    }[topology]
    networks = {
        'current': ['core_egress', 'core_link', 'edge_ingress', 'host_ingress', 'public_link', 'tunnel_egress'],
        'legacy': ['private', 'public'],
    }[topology]
    if 'config' in args and '--services' in args:
        print('\\n'.join(services))
    elif 'config' in args and '--networks' in args:
        print('\\n'.join(networks))
    elif 'config' in args and '--format' in args:
        names = {
            'kassinao': 'kassinao',
            'kassinao-public': 'kassinao-public',
            'kassinao-router': 'kassinao-router',
            'cloudflared': 'kassinao-tunnel',
        }
        print(json.dumps({
            'services': {name: {'restart': 'no', 'container_name': names[name]} for name in services},
            'networks': {name: {} for name in networks},
        }))
    elif 'create' in args and topology == 'legacy':
        create_legacy()
    else:
        raise SystemExit(1)
elif args[0] == 'inspect':
    reference = args[-1]
    try:
        name, value = container(reference)
    except KeyError:
        raise SystemExit(1)
    if len(args) == 2:
        print(json.dumps(value))
    else:
        fail_after('read-inspect:' + name)
        template = args[args.index('--format') + 1] if '--format' in args else args[args.index('-f') + 1]
        if template == '{{.Id}}':
            print(value['id'])
        elif 'com.docker.compose.project.working_dir' in template:
            reported_health = value['health']
            if value.get('startingChecks', 0) > 0:
                value['startingChecks'] -= 1
                if value['startingChecks'] == 0:
                    value['health'] = 'healthy'
                save()
            print('|'.join([
                value['id'], '/' + name, 'kassinao', value['service'], value['bundle'],
                value['configFiles'], str(value['running']).lower(),
                'running' if value['running'] else 'exited', value['restart'], reported_health,
            ]))
        elif 'NetworkSettings.Networks' in template:
            print('\\n'.join(value['networks']))
        elif template == '{{.Name}}':
            print('/' + name)
        elif template == '{{.State.Running}}':
            print(str(value['running']).lower())
        elif template == '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}':
            print(value['health'])
        else:
            raise SystemExit(1)
elif args[0] == 'ps':
    docker_filter = args[args.index('--filter') + 1] if '--filter' in args else ''
    if docker_filter.startswith('name=^/') and docker_filter.endswith('$'):
        wanted = docker_filter[len('name=^/'):-1]
        fail_after('read-name-ps:' + wanted)
        print(state['containers'].get(wanted, {}).get('id', ''))
    else:
        if failure_path.exists() and failure_path.read_text(encoding='utf-8').strip() == 'read-project-ps-after-stop' and any(not value['running'] for value in state['containers'].values()):
            fail_after('read-project-ps-after-stop')
        fail_after('read-project-ps')
        print('\\n'.join(value['id'] for value in state['containers'].values()))
elif args[0] == 'network' and args[1] == 'ls':
    docker_filter = args[args.index('--filter') + 1] if '--filter' in args else ''
    if docker_filter.startswith('name=^') and docker_filter.endswith('$'):
        wanted = docker_filter[len('name=^'):-1]
        fail_after('read-network-ls:' + wanted)
        print(state['networks'].get(wanted, {}).get('id', ''))
    else:
        fail_after('read-project-network-ls')
        print('\\n'.join(value['id'] for value in state['networks'].values()))
elif args[0] == 'network' and args[1] == 'inspect':
    reference = args[-1]
    try:
        name, value = network(reference)
    except KeyError:
        raise SystemExit(1)
    template = args[args.index('-f') + 1]
    if template == '{{.Id}}':
        print(value['id'])
    elif template == '{{.Name}}':
        print(name)
    elif 'com.docker.compose.network' in template:
        print('|'.join([
            value['id'], name, 'bridge', str(value['internal']).lower(),
            str(value.get('enableIpv6', False)).lower(), 'kassinao', value['key'], value['bridge'],
            value.get('hostBindingIpv4', ''), value['gateway4'], value['gateway6'], value['icc'],
        ]))
    elif '.Containers' in template:
        fail_after('read-network-members:' + name)
        print('\\n'.join(f"{member_id}|{member_name}" for member_id, member_name in value['members'].items()))
    else:
        raise SystemExit(1)
elif args[0] == 'update':
    name, value = container(args[-1])
    value['restart'] = 'no'
    save()
    print(value['id'])
elif args[0] == 'stop':
    name, value = container(args[-1])
    value['running'] = False
    value['health'] = 'none'
    save()
    if recording_after_stop and name == 'kassinao':
        active = recordings_path / 'appeared-after-stop'
        active.mkdir(exist_ok=True)
        (active / 'meta.json').write_text('{"status":"recording"}\\n')
    print(value['id'])
elif args[0] == 'rm':
    name, value = container(args[-1])
    for item in state['networks'].values():
        item['members'].pop(value['id'], None)
    del state['containers'][name]
    save()
    print(value['id'])
elif args[0] == 'network' and args[1] == 'rm':
    name, value = network(args[-1])
    if value['members']:
        raise SystemExit(1)
    del state['networks'][name]
    save()
    print(value['id'])
else:
    raise SystemExit(1)
`,
    { mode: 0o600 },
  );

  const script = path.join(current.bundle, 'scripts', 'transition-runtime-topology.sh');
  const args = [
    'inspect',
    '--current-bundle',
    current.bundle,
    '--current-env',
    current.env,
    '--current-compose',
    current.compose[0],
    '--current-compose',
    current.compose[1],
    '--legacy-bundle',
    legacy.bundle,
    '--legacy-env',
    legacy.env,
    '--legacy-compose',
    legacy.compose[0],
    '--legacy-compose',
    legacy.compose[1],
    '--state-file',
    path.join(transitionState, 'topology-transition.json'),
  ];
  return {
    args,
    bin,
    current,
    dockerState,
    events,
    legacy,
    hardenerDispatcher: path.join(hostSbin, 'kassinao-harden-docker-egress'),
    healthDispatcher: path.join(hostSbin, 'kassinao-health-watch'),
    policyState,
    recordings,
    root,
    script,
    stateRoot: transitionState,
    timerState,
  };
}

describe('transição pública da topologia runtime', () => {
  it('inspeciona neutral sem criar estado, enumerar env ou tocar Docker/systemd', () => {
    const fixture = neutralFixture();
    const result = spawnSync('bash', [fixture.script, ...fixture.args], {
      cwd: fixture.current.bundle,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      runtime: 'absent',
      schema_version: 1,
      state: 'neutral',
      topology: 'none',
      tunnel: true,
      watchdog: 'enabled',
    });
    expect(result.stdout).not.toContain('KASSINAO_DATA_ROOT');
    expect(result.stdout).not.toContain(fixture.root);
  }, 20_000);

  it('inspect recusa topologia current parcialmente running', () => {
    const fixture = neutralFixture({ currentRunning: true });
    const state = JSON.parse(readFileSync(fixture.dockerState, 'utf8')) as {
      containers: Record<string, { health: string; running: boolean }>;
    };
    state.containers['kassinao-public'].running = false;
    state.containers['kassinao-public'].health = 'none';
    writeFileSync(fixture.dockerState, JSON.stringify(state));

    const result = spawnSync('bash', [fixture.script, ...fixture.args], {
      cwd: fixture.current.bundle,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('topologia current parcialmente running');
  });

  it.each([
    ['internal', (network: Record<string, unknown>) => (network.internal = true)],
    ['IPv6 ativo', (network: Record<string, unknown>) => (network.enableIpv6 = true)],
    ['binding amplo', (network: Record<string, unknown>) => (network.hostBindingIpv4 = '0.0.0.0')],
    ['gateway IPv6 presente', (network: Record<string, unknown>) => (network.gateway6 = 'nat')],
  ])(
    'inspect recusa host_ingress com %s',
    (_label, mutate) => {
      const fixture = neutralFixture({ currentRunning: true });
      const state = JSON.parse(readFileSync(fixture.dockerState, 'utf8')) as {
        networks: Record<string, Record<string, unknown>>;
      };
      mutate(state.networks.kassinao_host_ingress);
      writeFileSync(fixture.dockerState, JSON.stringify(state));

      const result = spawnSync('bash', [fixture.script, ...fixture.args], {
        cwd: fixture.current.bundle,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('rede kassinao_host_ingress diverge');
    },
    10_000,
  );

  it.each(['read-name-ps:kassinao', 'read-project-ps-after-stop', 'read-network-members:kassinao_edge_ingress'])(
    'falha fechado quando a API Docker diverge durante containment: %s',
    (dockerReadFailOnce) => {
      const fixture = neutralFixture({ currentRunning: true, dockerReadFailOnce });
      const result = spawnSync('bash', [fixture.script, 'retire-current', ...fixture.args.slice(1)], {
        cwd: fixture.current.bundle,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(result.status, `${dockerReadFailOnce}\n${result.stderr}\n${result.stdout}`).not.toBe(0);
      const events = readFileSync(fixture.events, 'utf8');
      expect(events).not.toContain('systemctl:disable --now');
      expect(events).not.toContain('hardener:current:--shared-host --remove');
      expect(readFileSync(fixture.timerState, 'utf8')).toBe('enabled active\n');
      expect(readFileSync(fixture.policyState, 'utf8')).toBe('current\n');
      expect(existsSync(path.join(fixture.stateRoot, 'topology-transition.json'))).toBe(false);
    },
    20_000,
  );

  it('faz current -> neutral -> legacy -> neutral com recovery/idempotência e watchdog real', () => {
    const fixture = neutralFixture({ currentRunning: true, inverseLegacyProfiles: true });
    const run = (command: 'inspect' | 'prepare-legacy' | 'retire-current' | 'retire-legacy') => {
      const args = [command, ...fixture.args.slice(1)];
      const result = spawnSync('bash', [fixture.script, ...args], {
        cwd: fixture.current.bundle,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(result.status, `${command}\n${result.stderr}\n${result.stdout}`).toBe(0);
      return JSON.parse(result.stdout) as Record<string, unknown>;
    };

    expect(run('inspect')).toMatchObject({
      state: 'neutral',
      topology: 'current',
      runtime: 'running',
      tunnel: true,
      watchdog: 'enabled',
    });
    expect(run('retire-current')).toMatchObject({
      state: 'neutral',
      topology: 'none',
      runtime: 'absent',
      watchdog: 'disabled',
    });
    expect(run('retire-current')).toMatchObject({
      state: 'neutral',
      topology: 'none',
      runtime: 'absent',
      watchdog: 'disabled',
    });
    expect(run('prepare-legacy')).toMatchObject({
      state: 'legacy_running',
      topology: 'legacy',
      runtime: 'running',
      watchdog: 'enabled',
    });
    expect(run('retire-legacy')).toMatchObject({
      state: 'neutral',
      topology: 'none',
      runtime: 'absent',
      watchdog: 'disabled',
    });
    expect(run('retire-legacy')).toMatchObject({
      state: 'neutral',
      topology: 'none',
      runtime: 'absent',
      watchdog: 'disabled',
    });

    const events = readFileSync(fixture.events, 'utf8');
    expect(events.match(/^hardener:current:--shared-host --remove$/gm)).toHaveLength(1);
    expect(events.match(/hardener:current:--shared-host --remove-legacy-policy/g)).toHaveLength(1);
    expect(events).not.toContain('hardener:legacy:--shared-host --remove');
    const currentRemove = events.indexOf('hardener:current:--shared-host --remove');
    const firstCurrentNetworkRm = events.indexOf('docker:network rm', currentRemove);
    expect(currentRemove).toBeGreaterThan(0);
    expect(firstCurrentNetworkRm).toBeGreaterThan(currentRemove);
    const legacyPreload = events.indexOf('hardener:legacy:--shared-host --preload');
    const timerEnable = events.indexOf('systemctl:enable kassinao-health-watch.timer', legacyPreload);
    const healthStart = events.indexOf('systemctl:start kassinao-health-watch.service', timerEnable);
    expect(legacyPreload).toBeGreaterThan(firstCurrentNetworkRm);
    expect(timerEnable).toBeGreaterThan(legacyPreload);
    expect(healthStart).toBeGreaterThan(timerEnable);
    expect(readFileSync(fixture.timerState, 'utf8')).toBe('disabled inactive\n');
    expect(JSON.parse(readFileSync(fixture.dockerState, 'utf8'))).toEqual({
      containers: {},
      networks: {},
    });
  }, 60_000);

  it('retoma --remove current a partir de owned-progress', () => {
    const fixture = neutralFixture({ currentRunning: true, failCurrentRemoveOnce: true });
    const args = ['retire-current', ...fixture.args.slice(1)];
    const first = spawnSync('bash', [fixture.script, ...args], {
      cwd: fixture.current.bundle,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(first.status).not.toBe(0);
    expect(readFileSync(fixture.policyState, 'utf8')).toBe('current-v6-progress\n');
    expect(JSON.parse(readFileSync(path.join(fixture.stateRoot, 'topology-transition.json'), 'utf8'))).toEqual({
      schema_version: 1,
      state: 'current_stopped',
      tunnel: true,
    });

    const second = spawnSync('bash', [fixture.script, ...args], {
      cwd: fixture.current.bundle,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(second.status, `${second.stderr}\n${second.stdout}`).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({
      state: 'neutral',
      topology: 'none',
      runtime: 'absent',
    });
    const events = readFileSync(fixture.events, 'utf8');
    expect(events.match(/hardener:current:--shared-host --remove/g)).toHaveLength(2);
  }, 40_000);

  it('retire-legacy limpa neutral com objetos legacy criados e ainda parados', () => {
    const fixture = neutralFixture({ failLegacyPreloadOnce: true });
    const prepare = spawnSync('bash', [fixture.script, 'prepare-legacy', ...fixture.args.slice(1)], {
      cwd: fixture.current.bundle,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(prepare.status).not.toBe(0);
    expect(readFileSync(fixture.policyState, 'utf8')).toBe('legacy\n');
    expect(JSON.parse(readFileSync(path.join(fixture.stateRoot, 'topology-transition.json'), 'utf8'))).toMatchObject({
      state: 'legacy_prepared',
    });

    const retire = spawnSync('bash', [fixture.script, 'retire-legacy', ...fixture.args.slice(1)], {
      cwd: fixture.current.bundle,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(retire.status, `${retire.stderr}\n${retire.stdout}`).toBe(0);
    expect(JSON.parse(retire.stdout)).toMatchObject({
      state: 'neutral',
      topology: 'none',
      runtime: 'absent',
      watchdog: 'disabled',
    });
    expect(JSON.parse(readFileSync(fixture.dockerState, 'utf8'))).toEqual({
      containers: {},
      networks: {},
    });
  }, 40_000);

  it('prepare-legacy retoma após cleanup reconstruir preload interrompido', () => {
    const fixture = neutralFixture({ failLegacyPreloadOnce: true });
    const args = ['prepare-legacy', ...fixture.args.slice(1)];
    const first = spawnSync('bash', [fixture.script, ...args], {
      cwd: fixture.current.bundle,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(first.status).not.toBe(0);
    expect(readFileSync(fixture.policyState, 'utf8')).toBe('legacy\n');
    expect(JSON.parse(readFileSync(path.join(fixture.stateRoot, 'topology-transition.json'), 'utf8'))).toMatchObject({
      state: 'legacy_prepared',
    });
    expect(readFileSync(fixture.timerState, 'utf8')).toBe('disabled inactive\n');

    const retry = spawnSync('bash', [fixture.script, ...args], {
      cwd: fixture.current.bundle,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(retry.status, `${retry.stderr}\n${retry.stdout}`).toBe(0);
    expect(JSON.parse(retry.stdout)).toMatchObject({ state: 'legacy_running', topology: 'legacy' });
    expect(readFileSync(fixture.policyState, 'utf8')).toBe('legacy\n');
    const events = readFileSync(fixture.events, 'utf8');
    expect(events).toContain('hardener:current:--shared-host --remove-legacy-policy');
  }, 40_000);

  it.each(['legacy-v4-progress', 'legacy-v6-progress'] as const)(
    'prepare-legacy reconstrói policy a partir de %s via adapter current',
    (progress) => {
      const fixture = neutralFixture();
      writeFileSync(fixture.policyState, `${progress}\n`);
      const result = spawnSync('bash', [fixture.script, 'prepare-legacy', ...fixture.args.slice(1)], {
        cwd: fixture.current.bundle,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ state: 'legacy_running', topology: 'legacy' });
      expect(readFileSync(fixture.policyState, 'utf8')).toBe('legacy\n');
      const events = readFileSync(fixture.events, 'utf8');
      expect(events).toContain('hardener:current:--shared-host --remove-legacy-policy');
      expect(events).not.toContain('hardener:legacy:--shared-host --remove');
    },
    40_000,
  );

  it('retire-legacy conclui owned-progress pelo adapter current', () => {
    const fixture = neutralFixture();
    const prepare = spawnSync('bash', [fixture.script, 'prepare-legacy', ...fixture.args.slice(1)], {
      cwd: fixture.current.bundle,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(prepare.status, prepare.stderr).toBe(0);
    writeFileSync(fixture.policyState, 'legacy-v4-progress\n');
    const retire = spawnSync('bash', [fixture.script, 'retire-legacy', ...fixture.args.slice(1)], {
      cwd: fixture.current.bundle,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(retire.status, `${retire.stderr}\n${retire.stdout}`).toBe(0);
    expect(readFileSync(fixture.policyState, 'utf8')).toBe('none\n');
    const events = readFileSync(fixture.events, 'utf8');
    expect(events).toContain('hardener:current:--shared-host --remove-legacy-policy');
    expect(events).not.toContain('hardener:legacy:--shared-host --remove');
  }, 40_000);

  it('retira e restaura legacy antes de instalar os dispatchers current', () => {
    const fixture = neutralFixture();
    const run = (command: 'prepare-legacy' | 'retire-legacy') => {
      const result = spawnSync('bash', [fixture.script, command, ...fixture.args.slice(1)], {
        cwd: fixture.current.bundle,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(result.status, `${command}\n${result.stderr}\n${result.stdout}`).toBe(0);
      return JSON.parse(result.stdout) as Record<string, unknown>;
    };
    expect(run('prepare-legacy')).toMatchObject({ state: 'legacy_running', topology: 'legacy' });
    writeFileSync(
      fixture.healthDispatcher,
      readFileSync(path.join(fixture.legacy.bundle, 'scripts', 'health-watch.sh')),
      { mode: 0o755 },
    );
    writeFileSync(
      fixture.hardenerDispatcher,
      readFileSync(path.join(fixture.legacy.bundle, 'scripts', 'harden-docker-egress.sh')),
      { mode: 0o755 },
    );
    expect(run('retire-legacy')).toMatchObject({
      state: 'neutral',
      topology: 'none',
      runtime: 'absent',
      watchdog: 'disabled',
    });
    expect(run('prepare-legacy')).toMatchObject({
      state: 'legacy_running',
      topology: 'legacy',
      runtime: 'running',
      watchdog: 'enabled',
    });
  }, 40_000);

  it.each(['kassinao', 'kassinao-public', 'kassinao-tunnel'] as const)(
    'normaliza e retoma legacy quando o health-watch falha após iniciar %s',
    (failHealthAfter) => {
      const fixture = neutralFixture({ failHealthAfter });
      const args = ['prepare-legacy', ...fixture.args.slice(1)];
      const first = spawnSync('bash', [fixture.script, ...args], {
        cwd: fixture.current.bundle,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(first.status, `${first.stderr}\n${first.stdout}`).not.toBe(0);
      const partial = JSON.parse(readFileSync(fixture.dockerState, 'utf8')) as {
        containers: Record<string, { restart: string; running: boolean }>;
      };
      expect(Object.values(partial.containers).every((container) => !container.running)).toBe(true);
      expect(Object.values(partial.containers).every((container) => container.restart === 'no')).toBe(true);
      expect(readFileSync(fixture.policyState, 'utf8')).toBe('legacy\n');
      expect(readFileSync(fixture.timerState, 'utf8')).toBe('disabled inactive\n');
      expect(JSON.parse(readFileSync(path.join(fixture.stateRoot, 'topology-transition.json'), 'utf8'))).toMatchObject({
        state: 'legacy_prepared',
      });

      const retry = spawnSync('bash', [fixture.script, ...args], {
        cwd: fixture.current.bundle,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(retry.status, `${retry.stderr}\n${retry.stdout}`).toBe(0);
      expect(JSON.parse(retry.stdout)).toMatchObject({
        state: 'legacy_running',
        topology: 'legacy',
        runtime: 'running',
        watchdog: 'enabled',
      });
      const recovered = JSON.parse(readFileSync(fixture.dockerState, 'utf8')) as {
        containers: Record<string, { restart: string; running: boolean }>;
      };
      expect(Object.values(recovered.containers).every((container) => container.running)).toBe(true);
      expect(Object.values(recovered.containers).every((container) => container.restart === 'no')).toBe(true);
      const events = readFileSync(fixture.events, 'utf8');
      expect(events.match(/systemctl:start kassinao-health-watch\.service/g)).toHaveLength(2);
      expect(events).toContain('docker:stop --timeout 60');
    },
    40_000,
  );

  it('contém public/tunnel running sem core antes de desabilitar e retoma', () => {
    const fixture = neutralFixture({ failLegacyPreloadOnce: true });
    rmSync(path.join(fixture.root, 'fail-legacy-preload-once'));
    const args = ['prepare-legacy', ...fixture.args.slice(1)];
    const initial = spawnSync('bash', [fixture.script, ...args], {
      cwd: fixture.current.bundle,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(initial.status, `${initial.stderr}\n${initial.stdout}`).toBe(0);

    const docker = JSON.parse(readFileSync(fixture.dockerState, 'utf8')) as {
      containers: Record<string, { id: string }>;
      networks: Record<string, { members: Record<string, string> }>;
    };
    const coreId = docker.containers.kassinao.id;
    delete docker.containers.kassinao;
    for (const network of Object.values(docker.networks)) delete network.members[coreId];
    writeFileSync(fixture.dockerState, JSON.stringify(docker));
    writeFileSync(path.join(fixture.root, 'fail-legacy-preload-once'), '');
    const checkpoint = readFileSync(fixture.events, 'utf8').length;

    const interrupted = spawnSync('bash', [fixture.script, ...args], {
      cwd: fixture.current.bundle,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(interrupted.status, `${interrupted.stderr}\n${interrupted.stdout}`).not.toBe(0);
    const events = readFileSync(fixture.events, 'utf8').slice(checkpoint);
    const stop = events.indexOf('docker:stop --timeout 60');
    const disable = events.indexOf('systemctl:disable --now');
    expect(events).toContain('docker:update --restart=no');
    expect(stop).toBeGreaterThan(0);
    expect(disable).toBeGreaterThan(stop);

    const retry = spawnSync('bash', [fixture.script, ...args], {
      cwd: fixture.current.bundle,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(retry.status, `${retry.stderr}\n${retry.stdout}`).toBe(0);
    expect(JSON.parse(retry.stdout)).toMatchObject({ state: 'legacy_running', runtime: 'running' });
  }, 80_000);

  it.each([
    'watchdog-show-unit-file',
    'watchdog-enable',
    'watchdog-restart',
    'watchdog-is-active',
    'watchdog-service-start',
    'watchdog-service-result',
  ])(
    'fecha e retoma shared após falha única do watchdog: %s',
    (systemctlFailOnce) => {
      const fixture = neutralFixture({ systemctlFailOnce });
      const args = ['prepare-legacy', ...fixture.args.slice(1)];
      const first = spawnSync('bash', [fixture.script, ...args], {
        cwd: fixture.current.bundle,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(first.status, `${systemctlFailOnce}\n${first.stderr}\n${first.stdout}`).not.toBe(0);
      const failedState = JSON.parse(readFileSync(fixture.dockerState, 'utf8')) as {
        containers: Record<string, { restart: string; running: boolean }>;
      };
      expect(Object.values(failedState.containers).every((container) => !container.running)).toBe(true);
      expect(Object.values(failedState.containers).every((container) => container.restart === 'no')).toBe(true);
      expect(readFileSync(fixture.timerState, 'utf8')).toBe('disabled inactive\n');

      const retry = spawnSync('bash', [fixture.script, ...args], {
        cwd: fixture.current.bundle,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(retry.status, `${systemctlFailOnce}\n${retry.stderr}\n${retry.stdout}`).toBe(0);
      expect(JSON.parse(retry.stdout)).toMatchObject({
        state: 'legacy_running',
        topology: 'legacy',
        runtime: 'running',
        watchdog: 'enabled',
      });
    },
    40_000,
  );

  it('preserva runtime íntegro quando recording começa após o health-watch e permite retry shared', () => {
    const fixture = neutralFixture({
      recordingAfterHealthStart: true,
      systemctlFailOnce: 'watchdog-service-result',
    });
    const args = ['prepare-legacy', ...fixture.args.slice(1)];
    const checkpoint = readFileSync(fixture.events, 'utf8').length;

    const first = spawnSync('bash', [fixture.script, ...args], {
      cwd: fixture.current.bundle,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(first.status, `${first.stderr}\n${first.stdout}`).not.toBe(0);
    expect(first.stderr).toContain('runtime íntegro foi preservado');
    expect(readFileSync(fixture.timerState, 'utf8')).toBe('enabled active\n');
    const failedState = JSON.parse(readFileSync(fixture.dockerState, 'utf8')) as {
      containers: Record<string, { running: boolean }>;
    };
    expect(Object.values(failedState.containers).every((container) => container.running)).toBe(true);
    expect(readFileSync(fixture.events, 'utf8').slice(checkpoint)).not.toContain('docker:stop');
    expect(JSON.parse(readFileSync(path.join(fixture.stateRoot, 'topology-transition.json'), 'utf8'))).toMatchObject({
      state: 'legacy_prepared',
    });

    writeFileSync(path.join(fixture.recordings, 'started-during-health', 'meta.json'), '{"status":"done"}\n', {
      mode: 0o600,
    });
    const retry = spawnSync('bash', [fixture.script, ...args], {
      cwd: fixture.current.bundle,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(retry.status, `${retry.stderr}\n${retry.stdout}`).toBe(0);
    expect(JSON.parse(retry.stdout)).toMatchObject({
      state: 'legacy_running',
      runtime: 'running',
      watchdog: 'enabled',
    });
  }, 60_000);

  it('mantém uma máquina fechada e ordem de locks/mutações auditável', () => {
    for (const command of ['inspect', 'retire-current', 'prepare-legacy', 'retire-legacy']) {
      expect(SOURCE).toContain(command);
    }
    for (const state of ['current_stopped', 'neutral', 'legacy_prepared', 'legacy_running', 'legacy_stopped']) {
      expect(SOURCE).toContain(state);
    }
    expect(SOURCE.indexOf('flock -w 120 7')).toBeLessThan(SOURCE.indexOf('flock -w 120 8'));
    expect(SOURCE.indexOf('flock -w 120 8')).toBeLessThan(SOURCE.indexOf('flock -w 120 9'));
    expect(SOURCE).toContain('remove_policy_if_present()');
    expect(SOURCE).toContain('remove_legacy_policy()');
    expect(SOURCE).toContain('remove_policy_if_present\n      remove_topology_objects current');
    expect(SOURCE).toContain('remove_legacy_policy\n      remove_topology_objects legacy');
    expect(SOURCE).not.toMatch(/\bdocker\s+(?:compose\s+down|system\s+prune|rm\s+-f)\b/);
    expect(SOURCE).not.toContain('git ');
    expect(SOURCE).not.toContain('env |');
    expect(SOURCE).not.toContain('printenv');
    expect(SOURCE).toContain('gateway_mode_ipv4');
    expect(SOURCE).toContain('gateway_mode_ipv6');
    expect(SOURCE).toContain('enable_icc');
    expect(SOURCE).toContain('docker stop --timeout 60');
    expect(readFileSync(path.join(ROOT, 'scripts', 'package-ops-bundle.sh'), 'utf8')).toContain(
      '"$ROOT/scripts/transition-runtime-topology.sh"',
    );
  });

  it.each([
    ['adapter dedicated', 'KASSINAO_HOST_SCOPE=shared', 'KASSINAO_HOST_SCOPE=dedicated', 'somente o adapter shared'],
    [
      'profile duplicado',
      'COMPOSE_PROFILES=tunnel,split-public',
      'COMPOSE_PROFILES=tunnel,split-public,tunnel',
      'mesmo conjunto sem duplicados',
    ],
  ])(
    'recusa %s antes de mutar runtime',
    (_label, before, after, expected) => {
      const fixture = neutralFixture();
      writeFileSync(fixture.current.env, readFileSync(fixture.current.env, 'utf8').replace(before, after), {
        mode: 0o600,
      });
      const result = spawnSync('bash', [fixture.script, ...fixture.args], {
        cwd: fixture.current.bundle,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(expected);
      expect(readFileSync(fixture.events, 'utf8')).toBe('');
    },
    20_000,
  );

  it.each(['0', '2'] as const)('recusa TRUST_PROXY_HOPS=%s antes de parar o runtime', (trustProxyHops) => {
    const fixture = neutralFixture({ currentRunning: true, trustProxyHops });
    const result = spawnSync('bash', [fixture.script, 'retire-current', ...fixture.args.slice(1)], {
      cwd: fixture.current.bundle,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('TRUST_PROXY_HOPS precisa ser exatamente 1');
    expect(readFileSync(fixture.events, 'utf8')).toBe('');
    expect(JSON.parse(readFileSync(fixture.dockerState, 'utf8')).containers).not.toEqual({});
  });

  it.each(['recording', 'unknown'])(
    'recusa metadata %s antes de desabilitar watchdog ou parar containers',
    (recordingStatus) => {
      const fixture = neutralFixture({ currentRunning: true });
      const active = path.join(fixture.recordings, 'active-recording');
      mkdirSync(active, { mode: 0o700 });
      writeFileSync(path.join(active, 'meta.json'), `${JSON.stringify({ status: recordingStatus })}\n`, {
        mode: 0o600,
      });
      const result = spawnSync('bash', [fixture.script, 'retire-current', ...fixture.args.slice(1)], {
        cwd: fixture.current.bundle,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(result.status).not.toBe(0);
      expect(readFileSync(fixture.timerState, 'utf8')).toBe('enabled active\n');
      const events = readFileSync(fixture.events, 'utf8');
      expect(events).not.toContain('systemctl:disable --now');
      expect(events).not.toContain('docker:update');
      expect(events).not.toContain('docker:stop');
    },
  );

  it('retire-legacy recusa recording inicial sem desabilitar watchdog ou parar containers', () => {
    const fixture = neutralFixture();
    const prepared = spawnSync('bash', [fixture.script, 'prepare-legacy', ...fixture.args.slice(1)], {
      cwd: fixture.current.bundle,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(prepared.status, `${prepared.stderr}\n${prepared.stdout}`).toBe(0);
    const active = path.join(fixture.recordings, 'active-before-retire-legacy');
    mkdirSync(active, { mode: 0o700 });
    writeFileSync(path.join(active, 'meta.json'), '{"status":"recording"}\n', { mode: 0o600 });
    const checkpoint = readFileSync(fixture.events, 'utf8').length;

    const result = spawnSync('bash', [fixture.script, 'retire-legacy', ...fixture.args.slice(1)], {
      cwd: fixture.current.bundle,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(result.status).not.toBe(0);
    expect(readFileSync(fixture.timerState, 'utf8')).toBe('enabled active\n');
    const events = readFileSync(fixture.events, 'utf8').slice(checkpoint);
    expect(events).not.toContain('systemctl:disable --now');
    expect(events).not.toContain('docker:update');
    expect(events).not.toContain('docker:stop');
  }, 40_000);

  it('retry continua recusando quando recording aparece depois do stop', () => {
    const fixture = neutralFixture({ currentRunning: true, recordingAfterStop: true });
    const args = ['retire-current', ...fixture.args.slice(1)];
    const first = spawnSync('bash', [fixture.script, ...args], {
      cwd: fixture.current.bundle,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(first.status).not.toBe(0);
    expect(readFileSync(fixture.timerState, 'utf8')).toBe('disabled inactive\n');
    expect(readFileSync(fixture.policyState, 'utf8')).toBe('current\n');
    const stoppedState = JSON.parse(readFileSync(fixture.dockerState, 'utf8')) as {
      containers: Record<string, { running: boolean }>;
    };
    expect(Object.keys(stoppedState.containers)).not.toHaveLength(0);
    expect(Object.values(stoppedState.containers).every((container) => !container.running)).toBe(true);

    const eventsBeforeRetry = readFileSync(fixture.events, 'utf8');
    const second = spawnSync('bash', [fixture.script, ...args], {
      cwd: fixture.current.bundle,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(second.status).not.toBe(0);
    const retryEvents = readFileSync(fixture.events, 'utf8').slice(eventsBeforeRetry.length);
    expect(retryEvents).not.toContain('hardener:current:--shared-host --remove');
    expect(retryEvents).not.toContain('docker:rm ');
    expect(retryEvents).not.toContain('docker:network rm');
    expect(readFileSync(fixture.policyState, 'utf8')).toBe('current\n');
  }, 40_000);

  it.each(['mode', 'symlink', 'hardlink', 'nested-mount', 'app-overlap'] as const)(
    'recusa state root inseguro: %s',
    (kind) => {
      const fixture = neutralFixture();
      const args = [...fixture.args];
      if (kind === 'mode') {
        chmodSync(fixture.stateRoot, 0o770);
      } else if (kind === 'symlink') {
        const real = `${fixture.stateRoot}-real`;
        renameSync(fixture.stateRoot, real);
        symlinkSync(real, fixture.stateRoot, 'dir');
      } else if (kind === 'hardlink') {
        const stateFile = path.join(fixture.stateRoot, 'topology-transition.json');
        writeFileSync(stateFile, '{"schema_version":1,"state":"neutral","tunnel":true}\n', { mode: 0o600 });
        linkSync(stateFile, path.join(fixture.stateRoot, 'state-copy'));
      } else if (kind === 'nested-mount') {
        executable(
          path.join(fixture.bin, 'findmnt'),
          `#!/usr/bin/env bash
if [ "\${!#}" = ${shellLiteral(fixture.stateRoot)} ]; then
  printf '%s\\n' ${shellLiteral(fixture.stateRoot)}
else
  printf '%s\\n' ${shellLiteral(path.join(fixture.root, 'data'))}
fi
`,
        );
      } else {
        args[args.length - 1] = path.join(fixture.root, 'data', 'state', 'topology-transition.json');
      }
      const result = spawnSync('bash', [fixture.script, ...args], {
        cwd: fixture.current.bundle,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/state root|estado da transição/);
      expect(readFileSync(fixture.events, 'utf8')).toBe('');
    },
    20_000,
  );

  it('preserva o formato legacy real publicado em v1.4.14, v1.4.15 e v1.4.16', () => {
    const compose = readFileSync(LEGACY_COMPOSE_FIXTURE, 'utf8');
    expect(compose).toContain('com.docker.network.bridge.name: kas-private0');
    expect(compose).toContain('com.docker.network.bridge.name: kas-public0');
    expect(compose).not.toContain('kassinao-router:');
    expect(createHash('sha256').update(compose).digest('hex')).toBe(LEGACY_COMPOSE_SHA256);
    expect(SOURCE).toContain('18553d4bc3200b8cbe8dce44251956266fb7cac9334ac8550f426fe7c03a2e3b');
    expect(SOURCE).toContain('50bfe17476580357f3f18439caeefdbd565fc0b09b7156899fe0cb461e8e3829');
    expect(SOURCE).toContain('08e3d81f9caab710db565b9ac9e71f4249197633a7294e26618b1645aba4de48');
    expect(SOURCE).toContain('hardener "$CURRENT_BUNDLE" --remove-legacy-policy');
    expect(SOURCE).not.toContain('hardener "$LEGACY_BUNDLE" --remove');
  });
});
