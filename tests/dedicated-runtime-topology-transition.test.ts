import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
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
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'transition-dedicated-runtime-topology.sh');
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

function legacyCompose(): string {
  return readFileSync(LEGACY_COMPOSE_FIXTURE, 'utf8');
}

function fixture(
  options: {
    activeRecording?: boolean;
    failOnce?: string;
    initialHealth?: 'healthy' | 'starting' | 'unhealthy';
    initialStatus?: 'restarting' | 'running';
    recordingAfterHealthStart?: boolean;
    recordingStatus?: string;
  } = {},
) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'kassinao-dedicated-transition-')));
  chmodSync(root, 0o700);
  const uid = process.getuid?.() ?? 501;
  const gid = process.getgid?.() ?? 20;
  const bin = path.join(root, 'bin');
  const current = path.join(root, 'current');
  const legacy = path.join(root, 'legacy');
  const data = path.join(root, 'data');
  const recordings = path.join(data, 'recordings');
  const state = path.join(data, 'state');
  const auth = path.join(data, 'auth');
  const cache = path.join(data, 'cache');
  const transitionRoot = path.join(data, 'dedicated-topology-transition');
  const hostEtc = path.join(root, 'host', 'etc-kassinao');
  const hostSbin = path.join(root, 'host', 'sbin');
  const runtime = path.join(root, 'host', 'runtime');
  const events = path.join(root, 'events.log');
  const timerState = path.join(root, 'timer-state');
  const policyState = path.join(root, 'policy-state');
  const dockerState = path.join(root, 'docker-state.json');
  const failOnce = path.join(root, 'fail-once');
  const recordingAfterHealthStart = path.join(root, 'recording-after-health-start');
  for (const directory of [
    bin,
    current,
    legacy,
    data,
    recordings,
    state,
    auth,
    cache,
    transitionRoot,
    hostEtc,
    hostSbin,
    runtime,
  ]) {
    mkdirSync(directory, { recursive: true, mode: directory === hostEtc || directory === hostSbin ? 0o755 : 0o700 });
  }
  writeFileSync(events, '');
  writeFileSync(timerState, 'enabled active\n');
  writeFileSync(policyState, 'legacy\n');
  if (options.failOnce) writeFileSync(failOnce, `${options.failOnce}\n`, { mode: 0o600 });
  if (options.recordingAfterHealthStart) writeFileSync(recordingAfterHealthStart, '');
  writeFileSync(path.join(runtime, 'maintenance.lock'), '', { mode: 0o600 });
  if (options.activeRecording) {
    const active = path.join(recordings, 'active');
    mkdirSync(active, { mode: 0o700 });
    writeFileSync(
      path.join(active, 'meta.json'),
      `${JSON.stringify({ status: options.recordingStatus ?? 'recording' })}\n`,
      { mode: 0o600 },
    );
  }

  let transformed = SOURCE;
  const scrubStart = transformed.indexOf('# KASSINAO_DEDICATED_TRANSITION_ENV_SCRUB_BEGIN');
  const scrubEnd = transformed.indexOf('# KASSINAO_DEDICATED_TRANSITION_ENV_SCRUB_END');
  transformed =
    transformed.slice(0, scrubStart) +
    `# KASSINAO_DEDICATED_TRANSITION_ENV_SCRUB_BEGIN\nexport PATH=${shellLiteral(bin)}:/usr/bin:/bin:/sbin HOME=${shellLiteral(root)} LC_ALL=C\n` +
    transformed.slice(scrubEnd);
  const noDumpStart = transformed.indexOf('# KASSINAO_DEDICATED_TRANSITION_NO_DUMP_BEGIN');
  const noDumpEnd = transformed.indexOf('# KASSINAO_DEDICATED_TRANSITION_NO_DUMP_END');
  transformed =
    transformed.slice(0, noDumpStart) +
    '# KASSINAO_DEDICATED_TRANSITION_NO_DUMP_BEGIN\n:\n' +
    transformed.slice(noDumpEnd);
  const composeContractPipe = `python3 /dev/fd/3 "$TUNNEL" 3<<'PY'
import json
import sys
value = json.load(sys.stdin)`;
  expect(transformed).toContain(composeContractPipe);
  transformed = transformed.replace(
    composeContractPipe,
    `python3 - "$TUNNEL" 4<&0 <<'PY'
import json
import os
import sys
value = json.load(os.fdopen(4))`,
  );
  transformed = transformed
    .replaceAll('/etc/kassinao/host-controls.env', path.join(hostEtc, 'host-controls.env'))
    .replaceAll('/usr/local/sbin/kassinao-health-watch', path.join(hostSbin, 'kassinao-health-watch'))
    .replaceAll('/usr/local/sbin/kassinao-harden-docker-egress', path.join(hostSbin, 'kassinao-harden-docker-egress'))
    .replaceAll('/run/lock/kassinao/maintenance.lock', path.join(runtime, 'maintenance.lock'))
    .replaceAll(':0:0:1', `:${uid}:${gid}:1`)
    .replaceAll(':0:0"', `:${uid}:${gid}"`)
    .replaceAll(':0:0 ]', `:${uid}:${gid} ]`)
    .replaceAll('os.chown(temporary, 0, 0', `os.chown(temporary, ${uid}, ${gid}`);
  const fdProofStart = transformed.indexOf('assert_fd_lock() {');
  const fdProofEnd = transformed.indexOf('\n}\n', fdProofStart);
  expect(fdProofStart).toBeGreaterThan(0);
  expect(fdProofEnd).toBeGreaterThan(fdProofStart);
  transformed =
    transformed.slice(0, fdProofStart) +
    `assert_fd_lock() {
  local fd="$1" path="$2" description="$3"
  /usr/bin/python3 - "$fd" "$path" <<'PY' || die "$description mudou durante a abertura ou herança"
import os
import stat
import sys
descriptor = os.fstat(int(sys.argv[1]))
target = os.stat(sys.argv[2], follow_symlinks=False)
if (
    descriptor.st_dev != target.st_dev
    or descriptor.st_ino != target.st_ino
    or not stat.S_ISREG(descriptor.st_mode)
    or stat.S_IMODE(descriptor.st_mode) != 0o600
    or descriptor.st_nlink != 1
):
    raise SystemExit(1)
PY
}
` +
    transformed.slice(fdProofEnd + 3);

  function createBundle(bundle: string, role: 'current' | 'legacy'): void {
    const scripts = path.join(bundle, 'scripts');
    const dockerClient = path.join(bundle, 'deploy', 'docker-client');
    const runtimeDirectory = path.join(bundle, 'runtime', 'linux-amd64');
    for (const directory of [scripts, dockerClient, runtimeDirectory])
      mkdirSync(directory, { recursive: true, mode: 0o755 });
    chmodSync(bundle, 0o700);
    const hardener = `#!/usr/bin/env bash
printf 'hardener:${role}:%s\\n' "$*" >> ${shellLiteral(events)}
case "\${1:-}" in
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
      legacy)
        if [ -f ${shellLiteral(failOnce)} ] && [ "$(cat ${shellLiteral(failOnce)})" = policy-remove ]; then
          printf 'legacy-v6-progress\\n' > ${shellLiteral(policyState)}
          rm -- ${shellLiteral(failOnce)}
          exit 97
        fi
        printf 'none\\n' > ${shellLiteral(policyState)}
        ;;
      legacy-v4-progress|legacy-v6-progress) printf 'none\\n' > ${shellLiteral(policyState)} ;;
      none) ;;
      *) exit 1 ;;
    esac
    ;;
  --check) [ "$(cat ${shellLiteral(policyState)})" = legacy ] ;;
  --preload)
    if [ -f ${shellLiteral(failOnce)} ] && [ "$(cat ${shellLiteral(failOnce)})" = policy-preload ]; then
      printf 'legacy-v4-progress\\n' > ${shellLiteral(policyState)}
      rm -- ${shellLiteral(failOnce)}
      exit 97
    fi
    printf 'legacy\\n' > ${shellLiteral(policyState)}
    ;;
  --remove)
    exit 98
    ;;
  *) exit 1 ;;
esac
`;
    executable(path.join(scripts, 'harden-docker-egress.sh'), hardener);
    executable(path.join(scripts, 'health-watch.sh'), '#!/usr/bin/env bash\nexit 0\n');
    executable(path.join(scripts, 'verify-storage-encryption.sh'), '#!/usr/bin/env bash\nexit 0\n');
    executable(path.join(scripts, 'no-dump-exec.py'), '#!/usr/bin/env python3\nraise SystemExit(0)\n');
    if (role === 'current') executable(path.join(scripts, 'transition-dedicated-runtime-topology.sh'), transformed);
    writeFileSync(path.join(runtimeDirectory, 'libkassinao-no-dump.so'), 'fixture\n', { mode: 0o444 });
    writeFileSync(path.join(dockerClient, 'config.json'), '{}\n', { mode: 0o444 });
    chmodSync(dockerClient, 0o755);
    writeFileSync(
      path.join(bundle, 'docker-compose.yml'),
      role === 'legacy' ? legacyCompose() : '# current fixture\n',
      { mode: 0o644 },
    );
    writeFileSync(
      path.join(bundle, '.env'),
      [
        'KASSINAO_HOST_SCOPE=dedicated',
        'KASSINAO_DEDICATED_DOCKER_HOST_ACK=I_UNDERSTAND_THIS_VPS_MUST_RUN_ONLY_KASSINAO',
        `KASSINAO_DATA_ROOT=${data}`,
        `KASSINAO_RECORDINGS_DIR=${recordings}`,
        `KASSINAO_STATE_DIR=${state}`,
        `KASSINAO_AUTH_DIR=${auth}`,
        `KASSINAO_MODEL_CACHE_DIR=${cache}`,
        `KASSINAO_UID=${uid}`,
        `KASSINAO_GID=${gid}`,
        'KASSINAO_ROLLBACK_RETENTION_HOURS=72',
        'KASSINAO_APP_ENV_FILE=app.env',
        'COMPOSE_PROFILES=tunnel,split-public',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    writeFileSync(path.join(bundle, 'app.env'), 'TRUST_PROXY_HOPS=1\n', { mode: 0o600 });
    writeFileSync(path.join(bundle, '.deploy.lock'), '', { mode: 0o600 });
    const files = [
      'scripts/harden-docker-egress.sh',
      'scripts/health-watch.sh',
      'scripts/verify-storage-encryption.sh',
      'scripts/no-dump-exec.py',
      'deploy/docker-client/config.json',
      'docker-compose.yml',
    ];
    if (role === 'current') files.push('scripts/transition-dedicated-runtime-topology.sh');
    manifest(bundle, files);
  }
  createBundle(current, 'current');
  createBundle(legacy, 'legacy');
  const transitionPath = path.join(current, 'scripts', 'transition-dedicated-runtime-topology.sh');
  let sealedTransition = readFileSync(transitionPath, 'utf8');
  for (const [expected, file] of [
    ['f4d545edbdfe50910126afc441fe7dd47de5eacf3a9cf171c6d2c1a47a1ad2ef', path.join(legacy, 'docker-compose.yml')],
    [
      '50bfe17476580357f3f18439caeefdbd565fc0b09b7156899fe0cb461e8e3829',
      path.join(legacy, 'scripts', 'harden-docker-egress.sh'),
    ],
    [
      '08e3d81f9caab710db565b9ac9e71f4249197633a7294e26618b1645aba4de48',
      path.join(legacy, 'scripts', 'health-watch.sh'),
    ],
  ] as const) {
    sealedTransition = sealedTransition.replaceAll(
      expected,
      createHash('sha256').update(readFileSync(file)).digest('hex'),
    );
  }
  writeFileSync(transitionPath, sealedTransition, { mode: 0o755 });
  manifest(current, [
    'scripts/harden-docker-egress.sh',
    'scripts/health-watch.sh',
    'scripts/verify-storage-encryption.sh',
    'scripts/no-dump-exec.py',
    'scripts/transition-dedicated-runtime-topology.sh',
    'deploy/docker-client/config.json',
    'docker-compose.yml',
  ]);
  writeFileSync(
    path.join(hostEtc, 'host-controls.env'),
    [`KASSINAO_DEPLOY_DIR=${legacy}`, `KASSINAO_DATA_ROOT=${data}`, 'KASSINAO_ROLLBACK_RETENTION_HOURS=72', ''].join(
      '\n',
    ),
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(hostSbin, 'kassinao-health-watch'),
    readFileSync(path.join(legacy, 'scripts', 'health-watch.sh')),
    {
      mode: 0o755,
    },
  );
  writeFileSync(
    path.join(hostSbin, 'kassinao-harden-docker-egress'),
    readFileSync(path.join(legacy, 'scripts', 'harden-docker-egress.sh')),
    { mode: 0o755 },
  );

  executable(
    path.join(bin, 'id'),
    `#!/usr/bin/env bash
if [ "\${1:-}" = -u ]; then printf '0\\n'; else /usr/bin/id "$@"; fi
`,
  );
  executable(
    path.join(bin, 'flock'),
    `#!/usr/bin/env python3
import fcntl
import os
import sys

args = sys.argv[1:]
conflict = 1
nonblocking = False
unlock = False
index = 0
while index < len(args):
    argument = args[index]
    if argument == '-E':
        conflict = int(args[index + 1])
        index += 2
    elif argument == '-w':
        index += 2
    elif argument == '-n':
        nonblocking = True
        index += 1
    elif argument == '-u':
        unlock = True
        index += 1
    else:
        break
if index >= len(args):
    raise SystemExit(64)
target = args[index]
opened = False
if target.isdigit():
    descriptor = int(target)
else:
    descriptor = os.open(target, os.O_RDWR | os.O_CREAT, 0o600)
    opened = True
operation = fcntl.LOCK_UN if unlock else fcntl.LOCK_EX
if nonblocking:
    operation |= fcntl.LOCK_NB
try:
    fcntl.flock(descriptor, operation)
except BlockingIOError:
    raise SystemExit(conflict)
finally:
    if opened:
        os.close(descriptor)
`,
  );
  executable(path.join(bin, 'findmnt'), `#!/usr/bin/env bash\nprintf '%s\\n' ${shellLiteral(data)}\n`);
  executable(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
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
target="$2"
/usr/bin/python3 - "$follow" "$format" "$target" <<'PY'
import os
import stat
import sys
value = os.stat(sys.argv[3], follow_symlinks=sys.argv[1] == 'true')
mapping = {
    '%a': format(stat.S_IMODE(value.st_mode), 'o'),
    '%u': str(value.st_uid),
    '%g': str(value.st_gid),
    '%h': str(value.st_nlink),
    '%d': str(value.st_dev),
    '%i': str(value.st_ino),
}
result = sys.argv[2]
for key, replacement in mapping.items():
    result = result.replace(key, replacement)
print(result)
PY
`,
  );
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
    path.join(bin, 'systemctl'),
    `#!/usr/bin/env bash
printf 'systemctl:%s\\n' "$*" >> ${shellLiteral(events)}
read -r enabled active < ${shellLiteral(timerState)}
consume_fail() {
  [ -f ${shellLiteral(failOnce)} ] || return 1
  [ "$(/bin/cat ${shellLiteral(failOnce)})" = "$1" ] || return 1
  /bin/rm -f ${shellLiteral(failOnce)}
}
case "$1:$2" in
  disable:--now)
    consume_fail watchdog-disable && exit 97
    printf 'disabled inactive\\n' > ${shellLiteral(timerState)}
    ;;
  stop:kassinao-health-watch.service)
    consume_fail watchdog-stop && exit 97
    :
    ;;
  reset-failed:kassinao-health-watch.service) ;;
  enable:kassinao-health-watch.timer)
    consume_fail watchdog-enable && exit 97
    printf 'enabled %s\\n' "$active" > ${shellLiteral(timerState)}
    ;;
  restart:kassinao-health-watch.timer)
    consume_fail watchdog-restart && exit 97
    printf '%s active\\n' "$enabled" > ${shellLiteral(timerState)}
    ;;
  is-enabled:--quiet)
    consume_fail watchdog-is-enabled && exit 97
    [ "$enabled" = enabled ]
    ;;
  is-active:--quiet)
    consume_fail watchdog-is-active && exit 97
    if [ "$3" = kassinao-health-watch.timer ]; then [ "$active" = active ]; else exit 1; fi
    ;;
  start:kassinao-health-watch.service)
    consume_fail watchdog-service-start && exit 97
    /usr/bin/python3 - ${shellLiteral(dockerState)} <<'PY'
import json
import pathlib
import sys
path = pathlib.Path(sys.argv[1])
state = json.loads(path.read_text())
for container in state['containers'].values():
    container['running'] = True
    container['status'] = 'running'
    container['health'] = 'none' if container['service'] == 'cloudflared' else 'starting'
    container['startingChecks'] = 0 if container['service'] == 'cloudflared' else 1
path.write_text(json.dumps(state, sort_keys=True))
PY
    if [ -f ${shellLiteral(recordingAfterHealthStart)} ]; then
      /bin/rm -f ${shellLiteral(recordingAfterHealthStart)}
      /bin/mkdir -p ${shellLiteral(path.join(recordings, 'started-during-health'))}
      /usr/bin/printf '%s\n' '{"status":"recording"}' > ${shellLiteral(
        path.join(recordings, 'started-during-health', 'meta.json'),
      )}
    fi
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
    ;;
  *) exit 1 ;;
esac
`,
  );

  function identifier(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
  const containers = {
    kassinao: {
      bundle: legacy,
      configFiles: path.join(legacy, 'docker-compose.yml'),
      health: options.initialHealth ?? 'healthy',
      id: identifier('legacy:kassinao'),
      networks: ['kassinao_private'],
      restart: 'unless-stopped',
      running: true,
      service: 'kassinao',
      status: options.initialStatus ?? 'running',
    },
    'kassinao-public': {
      bundle: legacy,
      configFiles: path.join(legacy, 'docker-compose.yml'),
      health: options.initialHealth ?? 'healthy',
      id: identifier('legacy:kassinao-public'),
      networks: ['kassinao_public'],
      restart: 'unless-stopped',
      running: true,
      service: 'kassinao-public',
      status: options.initialStatus ?? 'running',
    },
    'kassinao-tunnel': {
      bundle: legacy,
      configFiles: path.join(legacy, 'docker-compose.yml'),
      health: 'none',
      id: identifier('legacy:kassinao-tunnel'),
      networks: ['kassinao_private', 'kassinao_public'],
      restart: 'unless-stopped',
      running: true,
      service: 'cloudflared',
      status: options.initialStatus ?? 'running',
    },
  };
  const networks = {
    kassinao_private: {
      bridge: 'kas-private0',
      gateway4: '',
      gateway6: '',
      id: identifier('legacy-network:private'),
      internal: false,
      key: 'private',
      members: Object.fromEntries(
        Object.entries(containers)
          .filter(([, value]) => value.networks.includes('kassinao_private'))
          .map(([name, value]) => [value.id, name]),
      ),
    },
    kassinao_public: {
      bridge: 'kas-public0',
      gateway4: 'isolated',
      gateway6: 'isolated',
      id: identifier('legacy-network:public'),
      internal: true,
      key: 'public',
      members: Object.fromEntries(
        Object.entries(containers)
          .filter(([, value]) => value.networks.includes('kassinao_public'))
          .map(([name, value]) => [value.id, name]),
      ),
    },
  };
  writeFileSync(dockerState, JSON.stringify({ containers, networks }));
  executable(
    path.join(bin, 'docker'),
    `#!/usr/bin/env bash\nexec /usr/bin/python3 ${shellLiteral(path.join(root, 'fake-docker.py'))} "$@"\n`,
  );
  writeFileSync(
    path.join(root, 'fake-docker.py'),
    `import hashlib
import json
import pathlib
import sys
state_path = pathlib.Path(${JSON.stringify(dockerState)})
events_path = pathlib.Path(${JSON.stringify(events)})
failure_path = pathlib.Path(${JSON.stringify(failOnce)})
legacy_bundle = ${JSON.stringify(legacy)}
legacy_compose = ${JSON.stringify(path.join(legacy, 'docker-compose.yml'))}
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
    network_definitions = {
        'kassinao_private': ('private', 'kas-private0', False, '', ''),
        'kassinao_public': ('public', 'kas-public0', True, 'isolated', 'isolated'),
    }
    for name, (key, bridge, internal, gateway4, gateway6) in network_definitions.items():
        state['networks'][name] = {
            'bridge': bridge,
            'gateway4': gateway4,
            'gateway6': gateway6,
            'id': identifier('legacy-network:' + key),
            'internal': internal,
            'key': key,
            'members': {},
        }
        save()
        fail_after('create-network:' + name)
    definitions = {
        'kassinao': ('kassinao', ['kassinao_private']),
        'kassinao-public': ('kassinao-public', ['kassinao_public']),
        'kassinao-tunnel': ('cloudflared', ['kassinao_private', 'kassinao_public']),
    }
    for name, (service, attached) in definitions.items():
        value = {
            'bundle': legacy_bundle,
            'configFiles': legacy_compose,
            'health': 'none',
            'id': identifier('legacy:' + name),
            'networks': attached,
            'restart': 'unless-stopped',
            'running': False,
            'service': service,
        }
        state['containers'][name] = value
        for network_name in attached:
            state['networks'][network_name]['members'][value['id']] = name
        save()
        fail_after('create-container:' + name)
if args[0] == 'info':
    print('29.0.0')
elif args[0] == 'compose':
    if 'config' in args and '--services' in args:
        print('kassinao\\nkassinao-public\\ncloudflared')
    elif 'config' in args and '--networks' in args:
        print('private\\npublic')
    elif 'config' in args and '--format' in args:
        print(json.dumps({
            'services': {
                'kassinao': {'restart': 'unless-stopped', 'container_name': 'kassinao'},
                'kassinao-public': {'restart': 'unless-stopped', 'container_name': 'kassinao-public'},
                'cloudflared': {'restart': 'unless-stopped', 'container_name': 'kassinao-tunnel'},
            },
            'networks': {'private': {}, 'public': {}},
        }), flush=True)
    elif 'create' in args:
        create_legacy()
    else:
        raise SystemExit(1)
elif args[0] == 'inspect':
    try:
        name, value = container(args[-1])
    except KeyError:
        raise SystemExit(1)
    if len(args) == 2:
        print(json.dumps(value))
        raise SystemExit(0)
    fail_after('read-inspect:' + name)
    if all(item['running'] for item in state['containers'].values()):
        fail_after('ready:' + name)
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
            value.get('status', 'running' if value['running'] else 'exited'), value['restart'], reported_health,
        ]))
    elif 'NetworkSettings.Networks' in template:
        print('\\n'.join(value['networks']))
    elif template == '{{.Name}}':
        print('/' + name)
    elif template == '{{.State.Running}}':
        print(str(value['running']).lower())
    elif template == '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}':
        print(value['health'])
    elif template == '{{.HostConfig.RestartPolicy.Name}}':
        print(value['restart'])
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
    try:
        name, value = network(args[-1])
    except KeyError:
        raise SystemExit(1)
    template = args[args.index('-f') + 1]
    if template == '{{.Id}}':
        print(value['id'])
    elif template == '{{.Name}}':
        print(name)
    elif 'com.docker.compose.network' in template:
        print('|'.join([
            value['id'], name, 'bridge', str(value['internal']).lower(), 'kassinao',
            value['key'], value['bridge'], value['gateway4'], value['gateway6'],
        ]))
    elif '.Containers' in template:
        fail_after('read-network-members:' + name)
        print('\\n'.join(f"{member_id}|{member_name}" for member_id, member_name in value['members'].items()))
    else:
        raise SystemExit(1)
elif args[0] == 'update':
    name, value = container(args[-1])
    restart_arg = next(item for item in args if item.startswith('--restart='))
    value['restart'] = restart_arg.split('=', 1)[1]
    save()
    fail_after('update:' + name + ':' + value['restart'])
    print(value['id'])
elif args[0] == 'stop':
    name, value = container(args[-1])
    value['running'] = False
    value['health'] = 'none'
    value['status'] = 'exited'
    save()
    fail_after('stop:' + name)
    print(value['id'])
elif args[0] == 'start':
    name, value = container(args[-1])
    value['running'] = True
    value['health'] = 'none' if value['service'] == 'cloudflared' else 'starting'
    value['startingChecks'] = 0 if value['service'] == 'cloudflared' else 1
    value['status'] = 'running'
    save()
    fail_after('start:' + name)
    print(value['id'])
elif args[0] == 'rm':
    name, value = container(args[-1])
    for item in state['networks'].values():
        item['members'].pop(value['id'], None)
    del state['containers'][name]
    save()
    fail_after('rm:' + name)
    print(value['id'])
elif args[0] == 'network' and args[1] == 'rm':
    name, value = network(args[-1])
    if value['members']:
        raise SystemExit(1)
    del state['networks'][name]
    save()
    fail_after('network-rm:' + name)
    print(value['id'])
else:
    raise SystemExit(1)
`,
    { mode: 0o600 },
  );

  return {
    args: ['--legacy-bundle', legacy, '--state-file', path.join(transitionRoot, 'dedicated-runtime-topology.json')],
    bin,
    current,
    dockerState,
    events,
    legacy,
    maintenanceLock: path.join(runtime, 'maintenance.lock'),
    policyState,
    recordings,
    root,
    script: path.join(current, 'scripts', 'transition-dedicated-runtime-topology.sh'),
    timerState,
  };
}

describe('transição dedicated da topologia v1.4.14..v1.4.16', () => {
  it('retira legacy sem janela de egress e permite restauração antes da troca dos controles', () => {
    const value = fixture();
    const run = (command: 'inspect' | 'retire-legacy' | 'restore-legacy') => {
      const result = spawnSync('bash', [value.script, command, ...value.args], {
        cwd: value.current,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(result.status, `${command}\n${result.stderr}\n${result.stdout}`).toBe(0);
      return JSON.parse(result.stdout) as Record<string, unknown>;
    };

    expect(run('inspect')).toMatchObject({
      state: 'legacy_running',
      topology: 'legacy',
      runtime: 'running',
      watchdog: 'enabled',
    });
    expect(run('retire-legacy')).toMatchObject({
      state: 'legacy_retired',
      topology: 'none',
      runtime: 'absent',
      watchdog: 'disabled',
    });
    expect(JSON.parse(readFileSync(value.dockerState, 'utf8'))).toEqual({ containers: {}, networks: {} });
    expect(readFileSync(value.policyState, 'utf8')).toBe('none\n');

    expect(run('restore-legacy')).toMatchObject({
      state: 'legacy_running',
      topology: 'legacy',
      runtime: 'running',
      watchdog: 'enabled',
    });
    expect(readFileSync(value.policyState, 'utf8')).toBe('legacy\n');
    const events = readFileSync(value.events, 'utf8');
    const stop = events.indexOf('docker:stop --timeout 60');
    const removePolicy = events.indexOf('hardener:current:--remove-legacy-policy');
    const removeContainer = events.indexOf('docker:rm ', removePolicy);
    expect(stop).toBeGreaterThan(0);
    expect(removePolicy).toBeGreaterThan(stop);
    expect(removeContainer).toBeGreaterThan(removePolicy);
    const create = events.indexOf('docker:compose ', removeContainer);
    const preload = events.indexOf('hardener:legacy:--preload', create);
    const reconcile = events.indexOf('systemctl:start kassinao-health-watch.service', preload);
    const restartArmed = events.indexOf('docker:update --restart=unless-stopped', preload);
    expect(create).toBeGreaterThan(removeContainer);
    expect(preload).toBeGreaterThan(create);
    expect(reconcile).toBeGreaterThan(preload);
    expect(restartArmed).toBeGreaterThan(reconcile);
  }, 40_000);

  it('mantém os três locks herdados após o child e durante o commit do installer', async () => {
    const value = fixture();
    const wrapper = path.join(value.root, 'installer-lock-handoff.sh');
    const childReturned = path.join(value.root, 'child-returned');
    const commitPaused = path.join(value.root, 'commit-paused');
    const releaseCommit = path.join(value.root, 'release-commit');
    const currentLock = path.join(value.current, '.deploy.lock');
    const legacyLock = path.join(value.legacy, '.deploy.lock');
    const [firstLock, secondLock] = [currentLock, legacyLock].sort();
    executable(
      wrapper,
      `#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=${shellLiteral(value.bin)}:/usr/bin:/bin:/sbin
exec 7<>${shellLiteral(firstLock)}
exec 8<>${shellLiteral(secondLock)}
exec 9<>${shellLiteral(value.maintenanceLock)}
flock -w 120 7
flock -w 120 8
flock -w 120 9
"$BASH" ${shellLiteral(value.script)} retire-legacy \
  --legacy-bundle ${shellLiteral(value.legacy)} \
  --state-file ${shellLiteral(value.args[3])} \
  --inherited-first-lock-fd 7 \
  --inherited-second-lock-fd 8 \
  --inherited-maintenance-lock-fd 9 \
  7>&7 8>&8 9>&9 >/dev/null
: > ${shellLiteral(childReturned)}
printf 'marker committed\n' >> ${shellLiteral(value.events)}
: > ${shellLiteral(commitPaused)}
while [ ! -f ${shellLiteral(releaseCommit)} ]; do /bin/sleep 0.01; done
printf 'dispatchers committed\n' >> ${shellLiteral(value.events)}
`,
    );

    const installer = spawn('bash', [wrapper], {
      cwd: value.current,
      env: { PATH: `${value.bin}:${process.env.PATH ?? ''}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    installer.stderr!.setEncoding('utf8');
    installer.stderr!.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const completion = new Promise<number | null>((resolve) => installer.once('close', (code) => resolve(code)));
    const probe = (lock: string) =>
      spawnSync(path.join(value.bin, 'flock'), ['-E', '75', '-n', lock, '-c', ':'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${value.bin}:${process.env.PATH ?? ''}` },
      });
    const waitForInstallerExit = async (timeoutMs: number) => {
      if (installer.exitCode !== null || installer.signalCode !== null) return true;
      return new Promise<boolean>((resolve) => {
        const onClose = () => {
          clearTimeout(timeout);
          resolve(true);
        };
        const timeout = setTimeout(() => {
          installer.off('close', onClose);
          resolve(false);
        }, timeoutMs);
        installer.once('close', onClose);
      });
    };

    try {
      for (let attempt = 0; attempt < 3000 && !existsSync(commitPaused); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(childReturned), stderr).toBe(true);
      expect(existsSync(commitPaused), stderr).toBe(true);

      for (const lock of [currentLock, legacyLock, value.maintenanceLock]) {
        expect(probe(lock).status, lock).toBe(75);
      }

      writeFileSync(releaseCommit, 'release\n', { mode: 0o600 });
      expect(await completion, stderr).toBe(0);
      for (const lock of [currentLock, legacyLock, value.maintenanceLock]) {
        expect(probe(lock).status, lock).toBe(0);
      }
      expect(readFileSync(value.events, 'utf8')).toContain('marker committed\ndispatchers committed\n');
    } finally {
      writeFileSync(releaseCommit, 'release\n', { mode: 0o600 });
      if (!(await waitForInstallerExit(2000))) {
        installer.kill('SIGTERM');
        if (!(await waitForInstallerExit(2000))) installer.kill('SIGKILL');
        await completion;
      }
    }
  }, 60_000);

  it.each(['reinstall', 'upgrade'] as const)(
    'serializa marker e dispatchers no caminho current de %s',
    async (mode) => {
      const value = fixture();
      const installed = mode === 'reinstall' ? value.current : path.join(value.root, 'installed-current-topology');
      if (mode === 'upgrade') {
        mkdirSync(installed, { mode: 0o700 });
        writeFileSync(path.join(installed, '.deploy.lock'), '', { mode: 0o600 });
      }
      const deployLocks = [
        ...new Set([path.join(value.current, '.deploy.lock'), path.join(installed, '.deploy.lock')]),
      ].sort();
      const wrapper = path.join(value.root, `current-${mode}-lock-window.sh`);
      const commitPaused = path.join(value.root, `current-${mode}-commit-paused`);
      const releaseCommit = path.join(value.root, `current-${mode}-release`);
      executable(
        wrapper,
        `#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=${shellLiteral(value.bin)}:/usr/bin:/bin:/sbin
exec 7<>${shellLiteral(deployLocks[0])}
flock -w 120 7
${deployLocks[1] ? `exec 8<>${shellLiteral(deployLocks[1])}\nflock -w 120 8` : ''}
exec 9<>${shellLiteral(value.maintenanceLock)}
flock -w 120 9
printf 'marker committed\n' >> ${shellLiteral(value.events)}
: > ${shellLiteral(commitPaused)}
while [ ! -f ${shellLiteral(releaseCommit)} ]; do /bin/sleep 0.01; done
printf 'dispatchers committed\n' >> ${shellLiteral(value.events)}
`,
      );
      const installer = spawn('bash', [wrapper], {
        cwd: value.current,
        env: { PATH: `${value.bin}:${process.env.PATH ?? ''}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      installer.stderr!.setEncoding('utf8');
      installer.stderr!.on('data', (chunk: string) => {
        stderr += chunk;
      });
      const completion = new Promise<number | null>((resolve) => installer.once('close', (code) => resolve(code)));
      for (let attempt = 0; attempt < 500 && !existsSync(commitPaused); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(commitPaused), stderr).toBe(true);
      const probe = (lock: string) =>
        spawnSync(path.join(value.bin, 'flock'), ['-E', '75', '-n', lock, '-c', ':'], {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${value.bin}:${process.env.PATH ?? ''}` },
        });
      for (const lock of [...deployLocks, value.maintenanceLock]) {
        expect(probe(lock).status, lock).toBe(75);
      }
      writeFileSync(releaseCommit, 'release\n', { mode: 0o600 });
      expect(await completion, stderr).toBe(0);
      for (const lock of [...deployLocks, value.maintenanceLock]) {
        expect(probe(lock).status, lock).toBe(0);
      }
    },
    20_000,
  );

  it.each(['missing', 'swapped'] as const)(
    'recusa handoff %s antes de qualquer mutação do runtime',
    (mode) => {
      const value = fixture();
      const wrapper = path.join(value.root, `invalid-lock-handoff-${mode}.sh`);
      const currentLock = path.join(value.current, '.deploy.lock');
      const legacyLock = path.join(value.legacy, '.deploy.lock');
      const [firstLock, secondLock] = [currentLock, legacyLock].sort();
      const openLocks =
        mode === 'missing'
          ? 'exec 7>&- 8>&- 9>&-'
          : [
              `exec 7<>${shellLiteral(mode === 'swapped' ? secondLock : firstLock)}`,
              `exec 8<>${shellLiteral(mode === 'swapped' ? firstLock : secondLock)}`,
              `exec 9<>${shellLiteral(value.maintenanceLock)}`,
              'flock -w 120 7',
              'flock -w 120 8',
              'flock -w 120 9',
            ].join('\n');
      const inheritedRedirections = mode === 'missing' ? '' : '7>&7 8>&8 9>&9';
      executable(
        wrapper,
        `#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=${shellLiteral(value.bin)}:/usr/bin:/bin:/sbin
${openLocks}
"$BASH" ${shellLiteral(value.script)} retire-legacy \
  --legacy-bundle ${shellLiteral(value.legacy)} \
  --state-file ${shellLiteral(value.args[3])} \
  --inherited-first-lock-fd 7 \
  --inherited-second-lock-fd 8 \
  --inherited-maintenance-lock-fd 9 \
  ${inheritedRedirections}
`,
      );
      const result = spawnSync('bash', [wrapper], {
        cwd: value.current,
        encoding: 'utf8',
        env: { PATH: `${value.bin}:${process.env.PATH ?? ''}` },
      });
      expect(result.status, `${result.stderr}\n${result.stdout}`).not.toBe(0);
      const events = readFileSync(value.events, 'utf8');
      expect(events).not.toContain('systemctl:disable --now');
      expect(events).not.toContain('docker:update');
      expect(events).not.toContain('docker:stop');
      expect(events).not.toContain('hardener:current:--remove-legacy-policy');
    },
    20_000,
  );

  it.each(['read-name-ps:kassinao', 'read-project-ps-after-stop', 'read-network-members:kassinao_private'])(
    'falha fechado quando a API Docker diverge durante containment: %s',
    (failOnce) => {
      const value = fixture({ failOnce });
      const result = spawnSync('bash', [value.script, 'retire-legacy', ...value.args], {
        cwd: value.current,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(result.status, `${failOnce}\n${result.stderr}\n${result.stdout}`).not.toBe(0);
      const events = readFileSync(value.events, 'utf8');
      expect(events).not.toContain('systemctl:disable --now');
      expect(events).not.toContain('hardener:current:--remove-legacy-policy');
      expect(readFileSync(value.timerState, 'utf8')).toBe('enabled active\n');
      expect(readFileSync(value.policyState, 'utf8')).toBe('legacy\n');
      expect(existsSync(value.args[3])).toBe(false);
    },
    20_000,
  );

  it('recusa FD correto e livre quando outro open-file description segura o lock', () => {
    const value = fixture();
    const wrapper = path.join(value.root, 'external-lock-holder.sh');
    const holderReady = path.join(value.root, 'holder-ready');
    const releaseHolder = path.join(value.root, 'release-holder');
    const currentLock = path.join(value.current, '.deploy.lock');
    const legacyLock = path.join(value.legacy, '.deploy.lock');
    const [firstLock, secondLock] = [currentLock, legacyLock].sort();
    executable(
      wrapper,
      `#!/usr/bin/env bash
set -u
export PATH=${shellLiteral(value.bin)}:/usr/bin:/bin:/sbin
(
  exec 6<>${shellLiteral(firstLock)}
  flock -w 120 6
  : > ${shellLiteral(holderReady)}
  while [ ! -f ${shellLiteral(releaseHolder)} ]; do /bin/sleep 0.01; done
) &
holder=$!
while [ ! -f ${shellLiteral(holderReady)} ]; do /bin/sleep 0.01; done
exec 7<>${shellLiteral(firstLock)}
exec 8<>${shellLiteral(secondLock)}
exec 9<>${shellLiteral(value.maintenanceLock)}
"$BASH" ${shellLiteral(value.script)} retire-legacy \
  --legacy-bundle ${shellLiteral(value.legacy)} \
  --state-file ${shellLiteral(value.args[3])} \
  --inherited-first-lock-fd 7 \
  --inherited-second-lock-fd 8 \
  --inherited-maintenance-lock-fd 9 \
  7>&7 8>&8 9>&9
status=$?
: > ${shellLiteral(releaseHolder)}
wait "$holder"
exit "$status"
`,
    );
    const result = spawnSync('bash', [wrapper], {
      cwd: value.current,
      encoding: 'utf8',
      env: { PATH: `${value.bin}:${process.env.PATH ?? ''}` },
      timeout: 60_000,
    });
    expect(result.signal, `${result.stderr}\n${result.stdout}`).not.toBe('SIGTERM');
    expect(result.status, `${result.stderr}\n${result.stdout}`).not.toBe(0);
    const events = readFileSync(value.events, 'utf8');
    expect(events).not.toContain('systemctl:disable --now');
    expect(events).not.toContain('docker:update');
    expect(events).not.toContain('docker:stop');
  }, 80_000);

  it('restaura sob os mesmos FDs herdados quando o installer falha antes do commit', () => {
    const value = fixture();
    const wrapper = path.join(value.root, 'installer-precommit-rollback.sh');
    const currentLock = path.join(value.current, '.deploy.lock');
    const legacyLock = path.join(value.legacy, '.deploy.lock');
    const [firstLock, secondLock] = [currentLock, legacyLock].sort();
    executable(
      wrapper,
      `#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=${shellLiteral(value.bin)}:/usr/bin:/bin:/sbin
restore_on_failure() {
  status=$?
  if [ "$status" -ne 0 ]; then
    "$BASH" ${shellLiteral(value.script)} restore-legacy \
      --legacy-bundle ${shellLiteral(value.legacy)} \
      --state-file ${shellLiteral(value.args[3])} \
      --inherited-first-lock-fd 7 \
      --inherited-second-lock-fd 8 \
      --inherited-maintenance-lock-fd 9 \
      7>&7 8>&8 9>&9 >/dev/null
  fi
  exit "$status"
}
trap restore_on_failure EXIT
exec 7<>${shellLiteral(firstLock)}
exec 8<>${shellLiteral(secondLock)}
exec 9<>${shellLiteral(value.maintenanceLock)}
flock -w 120 7
flock -w 120 8
flock -w 120 9
"$BASH" ${shellLiteral(value.script)} retire-legacy \
  --legacy-bundle ${shellLiteral(value.legacy)} \
  --state-file ${shellLiteral(value.args[3])} \
  --inherited-first-lock-fd 7 \
  --inherited-second-lock-fd 8 \
  --inherited-maintenance-lock-fd 9 \
  7>&7 8>&8 9>&9 >/dev/null
false
`,
    );
    const result = spawnSync('bash', [wrapper], {
      cwd: value.current,
      encoding: 'utf8',
      env: { PATH: `${value.bin}:${process.env.PATH ?? ''}` },
      timeout: 60_000,
    });
    expect(result.signal, `${result.stderr}\n${result.stdout}`).not.toBe('SIGTERM');
    expect(result.status, `${result.stderr}\n${result.stdout}`).not.toBe(0);
    const state = JSON.parse(readFileSync(value.dockerState, 'utf8')) as {
      containers: Record<string, { restart: string; running: boolean }>;
      networks: Record<string, unknown>;
    };
    expect(Object.values(state.containers).every((container) => container.running)).toBe(true);
    expect(Object.values(state.containers).every((container) => container.restart === 'unless-stopped')).toBe(true);
    expect(Object.keys(state.networks).sort()).toEqual(['kassinao_private', 'kassinao_public']);
    expect(readFileSync(value.policyState, 'utf8')).toBe('legacy\n');
    const events = readFileSync(value.events, 'utf8');
    const retireStop = events.indexOf('docker:stop --timeout 60');
    const restoreWatchdog = events.indexOf('systemctl:start kassinao-health-watch.service', retireStop);
    const restoreRestartPolicy = events.indexOf('docker:update --restart=unless-stopped', restoreWatchdog);
    expect(retireStop).toBeGreaterThan(0);
    expect(restoreWatchdog).toBeGreaterThan(retireStop);
    expect(restoreRestartPolicy).toBeGreaterThan(restoreWatchdog);
  }, 80_000);

  it.each(['recording', 'unknown'])(
    'recusa metadata %s antes de desabilitar watchdog ou parar legacy',
    (recordingStatus) => {
      const value = fixture({ activeRecording: true, recordingStatus });
      const result = spawnSync('bash', [value.script, 'retire-legacy', ...value.args], {
        cwd: value.current,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(result.status).not.toBe(0);
      expect(readFileSync(value.timerState, 'utf8')).toBe('enabled active\n');
      const events = readFileSync(value.events, 'utf8');
      expect(events).not.toContain('systemctl:disable --now');
      expect(events).not.toContain('docker:update');
      expect(events).not.toContain('docker:stop');
    },
  );

  it.each(['starting', 'unhealthy'] as const)(
    'retira legacy mesmo com readiness transitória %s',
    (initialHealth) => {
      const value = fixture({ initialHealth });
      const result = spawnSync('bash', [value.script, 'retire-legacy', ...value.args], {
        cwd: value.current,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        state: 'legacy_retired',
        topology: 'none',
        runtime: 'absent',
        watchdog: 'disabled',
      });
    },
    30_000,
  );

  it.each([
    ['retire-legacy', 'legacy_retired', 'absent'],
    ['restore-legacy', 'legacy_running', 'running'],
  ] as const)(
    'normaliza crash-loop restarting durante %s',
    (command, state, runtime) => {
      const value = fixture({ initialHealth: 'unhealthy', initialStatus: 'restarting' });
      const result = spawnSync('bash', [value.script, command, ...value.args], {
        cwd: value.current,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ state, runtime });
    },
    30_000,
  );

  it.each(['legacy-v4-progress', 'legacy-v6-progress'] as const)(
    'restore-legacy reconstrói policy a partir de %s via adapter current',
    (progress) => {
      const value = fixture();
      writeFileSync(value.policyState, `${progress}\n`);
      const result = spawnSync('bash', [value.script, 'restore-legacy', ...value.args], {
        cwd: value.current,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ state: 'legacy_running', runtime: 'running' });
      expect(readFileSync(value.policyState, 'utf8')).toBe('legacy\n');
      const events = readFileSync(value.events, 'utf8');
      expect(events).toContain('hardener:current:--remove-legacy-policy');
      expect(events).not.toContain('hardener:legacy:--remove');
    },
    20_000,
  );

  it('reconhece o fixture imutável das três releases legacy publicadas', () => {
    const compose = legacyCompose();
    expect(compose).toContain('com.docker.network.bridge.name: kas-private0');
    expect(compose).toContain('com.docker.network.bridge.name: kas-public0');
    expect(compose).not.toContain('kassinao-router:');
    expect(createHash('sha256').update(compose).digest('hex')).toBe(LEGACY_COMPOSE_SHA256);
    expect(SOURCE).toContain(LEGACY_COMPOSE_SHA256);
    expect(SOURCE).toContain('50bfe17476580357f3f18439caeefdbd565fc0b09b7156899fe0cb461e8e3829');
    expect(SOURCE).toContain('08e3d81f9caab710db565b9ac9e71f4249197633a7294e26618b1645aba4de48');
    expect(SOURCE).toContain('legacy_adapter --remove-legacy-policy');
    expect(SOURCE).not.toContain('legacy_hardener --remove');
  });

  it.each([
    'update:kassinao-tunnel:no',
    'update:kassinao-public:no',
    'update:kassinao:no',
    'stop:kassinao-tunnel',
    'stop:kassinao-public',
    'stop:kassinao',
  ])(
    'aceita erro pós-commit de containment quando o estado final fica provadamente parado: %s',
    (failOnce) => {
      const value = fixture({ failOnce });
      const retired = spawnSync('bash', [value.script, 'retire-legacy', ...value.args], {
        cwd: value.current,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(retired.status, `${failOnce}\n${retired.stderr}\n${retired.stdout}`).toBe(0);
      expect(JSON.parse(retired.stdout)).toMatchObject({
        state: 'legacy_retired',
        topology: 'none',
        runtime: 'absent',
        watchdog: 'disabled',
      });
      expect(existsSync(path.join(value.root, 'fail-once'))).toBe(false);
      expect(JSON.parse(readFileSync(value.dockerState, 'utf8'))).toEqual({ containers: {}, networks: {} });
      expect(readFileSync(value.policyState, 'utf8')).toBe('none\n');
    },
    30_000,
  );

  it.each([
    'policy-remove',
    'rm:kassinao-tunnel',
    'rm:kassinao-public',
    'rm:kassinao',
    'network-rm:kassinao_private',
    'network-rm:kassinao_public',
  ])(
    'restaura o legacy após falha única durante a retirada: %s',
    (failOnce) => {
      const value = fixture({ failOnce });
      const retired = spawnSync('bash', [value.script, 'retire-legacy', ...value.args], {
        cwd: value.current,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(retired.status, `${failOnce}\n${retired.stderr}\n${retired.stdout}`).not.toBe(0);

      const restored = spawnSync('bash', [value.script, 'restore-legacy', ...value.args], {
        cwd: value.current,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(restored.status, `${failOnce}\n${restored.stderr}\n${restored.stdout}`).toBe(0);
      expect(JSON.parse(restored.stdout)).toMatchObject({
        state: 'legacy_running',
        topology: 'legacy',
        runtime: 'running',
        watchdog: 'enabled',
      });
      const state = JSON.parse(readFileSync(value.dockerState, 'utf8')) as {
        containers: Record<string, { restart: string; running: boolean }>;
        networks: Record<string, unknown>;
      };
      expect(Object.keys(state.containers).sort()).toEqual(['kassinao', 'kassinao-public', 'kassinao-tunnel']);
      expect(Object.keys(state.networks).sort()).toEqual(['kassinao_private', 'kassinao_public']);
      expect(Object.values(state.containers).every((container) => container.running)).toBe(true);
      expect(Object.values(state.containers).every((container) => container.restart === 'unless-stopped')).toBe(true);
      expect(readFileSync(value.policyState, 'utf8')).toBe('legacy\n');
    },
    60_000,
  );

  it.each([
    'create-network:kassinao_private',
    'create-network:kassinao_public',
    'create-container:kassinao',
    'create-container:kassinao-public',
    'create-container:kassinao-tunnel',
    'policy-preload',
    'update:kassinao:unless-stopped',
    'update:kassinao-public:unless-stopped',
    'update:kassinao-tunnel:unless-stopped',
    'ready:kassinao',
  ])(
    'conclui a restauração após falha única durante a reconstrução: %s',
    (failOnce) => {
      const value = fixture();
      const retired = spawnSync('bash', [value.script, 'retire-legacy', ...value.args], {
        cwd: value.current,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(retired.status, retired.stderr).toBe(0);
      writeFileSync(path.join(value.root, 'fail-once'), `${failOnce}\n`, { mode: 0o600 });

      const firstRestore = spawnSync('bash', [value.script, 'restore-legacy', ...value.args], {
        cwd: value.current,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(firstRestore.status, `${failOnce}\n${firstRestore.stderr}\n${firstRestore.stdout}`).not.toBe(0);
      const failedState = JSON.parse(readFileSync(value.dockerState, 'utf8')) as {
        containers: Record<string, { restart: string; running: boolean }>;
      };
      expect(Object.values(failedState.containers).every((container) => !container.running)).toBe(true);
      expect(Object.values(failedState.containers).every((container) => container.restart === 'no')).toBe(true);
      expect(readFileSync(value.timerState, 'utf8')).toBe('disabled inactive\n');
      expect(
        ['legacy_prepared', 'legacy_retired'].includes(JSON.parse(readFileSync(value.args[3], 'utf8')).state as string),
      ).toBe(true);

      const retry = spawnSync('bash', [value.script, 'restore-legacy', ...value.args], {
        cwd: value.current,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(retry.status, `${failOnce}\n${retry.stderr}\n${retry.stdout}`).toBe(0);
      expect(JSON.parse(retry.stdout)).toMatchObject({
        state: 'legacy_running',
        topology: 'legacy',
        runtime: 'running',
        watchdog: 'enabled',
      });
      const state = JSON.parse(readFileSync(value.dockerState, 'utf8')) as {
        containers: Record<string, { restart: string; running: boolean }>;
        networks: Record<string, unknown>;
      };
      expect(Object.keys(state.containers).sort()).toEqual(['kassinao', 'kassinao-public', 'kassinao-tunnel']);
      expect(Object.keys(state.networks).sort()).toEqual(['kassinao_private', 'kassinao_public']);
      expect(Object.values(state.containers).every((container) => container.running)).toBe(true);
      expect(Object.values(state.containers).every((container) => container.restart === 'unless-stopped')).toBe(true);
      expect(readFileSync(value.policyState, 'utf8')).toBe('legacy\n');
    },
    60_000,
  );

  it.each([
    'watchdog-show-unit-file',
    'watchdog-enable',
    'watchdog-restart',
    'watchdog-is-active',
    'watchdog-service-start',
    'watchdog-service-result',
  ])(
    'fecha e retoma após falha única do watchdog: %s',
    (failOnce) => {
      const value = fixture();
      const retired = spawnSync('bash', [value.script, 'retire-legacy', ...value.args], {
        cwd: value.current,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(retired.status, retired.stderr).toBe(0);
      writeFileSync(path.join(value.root, 'fail-once'), `${failOnce}\n`, { mode: 0o600 });

      const first = spawnSync('bash', [value.script, 'restore-legacy', ...value.args], {
        cwd: value.current,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(first.status, `${failOnce}\n${first.stderr}\n${first.stdout}`).not.toBe(0);
      const failedState = JSON.parse(readFileSync(value.dockerState, 'utf8')) as {
        containers: Record<string, { restart: string; running: boolean }>;
      };
      expect(Object.values(failedState.containers).every((container) => !container.running)).toBe(true);
      expect(Object.values(failedState.containers).every((container) => container.restart === 'no')).toBe(true);
      expect(readFileSync(value.timerState, 'utf8')).toBe('disabled inactive\n');

      const retry = spawnSync('bash', [value.script, 'restore-legacy', ...value.args], {
        cwd: value.current,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(retry.status, `${failOnce}\n${retry.stderr}\n${retry.stdout}`).toBe(0);
      expect(JSON.parse(retry.stdout)).toMatchObject({
        state: 'legacy_running',
        topology: 'legacy',
        runtime: 'running',
        watchdog: 'enabled',
      });
    },
    40_000,
  );

  it('preserva runtime íntegro quando recording começa após o health-watch e permite retry', () => {
    const value = fixture({
      failOnce: 'watchdog-service-result',
      recordingAfterHealthStart: true,
    });
    const retired = spawnSync('bash', [value.script, 'retire-legacy', ...value.args], {
      cwd: value.current,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(retired.status, `${retired.stderr}\n${retired.stdout}`).toBe(0);
    const checkpoint = readFileSync(value.events, 'utf8').length;

    const first = spawnSync('bash', [value.script, 'restore-legacy', ...value.args], {
      cwd: value.current,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(first.status, `${first.stderr}\n${first.stdout}`).not.toBe(0);
    expect(first.stderr).toContain('runtime íntegro foi preservado');
    expect(readFileSync(value.timerState, 'utf8')).toBe('enabled active\n');
    const failedState = JSON.parse(readFileSync(value.dockerState, 'utf8')) as {
      containers: Record<string, { running: boolean }>;
    };
    expect(Object.values(failedState.containers).every((container) => container.running)).toBe(true);
    expect(readFileSync(value.events, 'utf8').slice(checkpoint)).not.toContain('docker:stop');
    expect(JSON.parse(readFileSync(value.args[3], 'utf8'))).toMatchObject({ state: 'legacy_prepared' });

    rmSync(path.join(value.recordings, 'started-during-health'), { recursive: true, force: true });
    const retry = spawnSync('bash', [value.script, 'restore-legacy', ...value.args], {
      cwd: value.current,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(retry.status, `${retry.stderr}\n${retry.stdout}`).toBe(0);
    expect(JSON.parse(retry.stdout)).toMatchObject({
      state: 'legacy_running',
      runtime: 'running',
      watchdog: 'enabled',
    });
  }, 40_000);

  it('integra a retirada antes de o installer substituir marker/dispatchers', () => {
    const installer = readFileSync(path.join(ROOT, 'scripts', 'install-host-controls.sh'), 'utf8');
    const transitionScript = installer.indexOf(
      'DEDICATED_TRANSITION_SCRIPT="$ROOT/scripts/transition-dedicated-runtime-topology.sh"',
    );
    const transitionCall = installer.indexOf('"$DEDICATED_TRANSITION_SCRIPT" retire-legacy');
    const transitionArmed = installer.indexOf('DEDICATED_LEGACY_TRANSITION_ACTIVE=true');
    const restoreCall = installer.indexOf('"$DEDICATED_TRANSITION_SCRIPT" restore-legacy');
    const firstLockOpen = installer.indexOf('exec 7<>"$first_transition_lock"');
    const inheritedArgs = installer.indexOf('--inherited-first-lock-fd 7');
    const controlsCommitted = installer.indexOf('CURRENT_CONTROLS_COMMITTED=true');
    const markerWrite = installer.indexOf('install -o root -g root -m 0600 "$HOST_CONTROLS_TMP"');
    const dispatcherWrite = installer.indexOf(
      'install -o root -g root -m 0755 "$ROOT/scripts/harden-docker-egress.sh"',
    );
    expect(transitionScript).toBeGreaterThan(0);
    expect(transitionCall).toBeGreaterThan(transitionScript);
    expect(restoreCall).toBeGreaterThan(0);
    expect(transitionArmed).toBeGreaterThan(transitionScript);
    expect(transitionArmed).toBeLessThan(transitionCall);
    expect(firstLockOpen).toBeGreaterThan(0);
    expect(firstLockOpen).toBeLessThan(transitionScript);
    expect(inheritedArgs).toBeGreaterThan(transitionScript);
    expect(inheritedArgs).toBeLessThan(transitionCall);
    expect(transitionCall).toBeLessThan(markerWrite);
    expect(transitionCall).toBeLessThan(dispatcherWrite);
    expect(controlsCommitted).toBeGreaterThan(markerWrite);
    expect(controlsCommitted).toBeLessThan(dispatcherWrite);
    expect(installer).toContain('restaurando runtime legacy verificado');
    expect(installer).toContain('runtime legacy permanece intencionalmente parado');
    expect(installer.match(/7>&7 8>&8 9>&9/g)).toHaveLength(2);
    expect(installer).not.toMatch(/exec [789]>&-/);
    expect(SOURCE).toContain('--inherited-first-lock-fd');
    expect(SOURCE).toContain('assert_lock_contended_by_our_open_description');
    expect(readFileSync(path.join(ROOT, 'scripts', 'package-ops-bundle.sh'), 'utf8')).toContain(
      '"$ROOT/scripts/transition-dedicated-runtime-topology.sh"',
    );
  });
});
