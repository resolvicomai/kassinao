import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const AUDITOR = path.join(ROOT, 'scripts', 'audit-shared-vps-security.sh');
const IMAGE = `ghcr.io/resolvicomai/kassinao@sha256:${'a'.repeat(64)}`;
const CLOUDFLARED = `cloudflare/cloudflared:2026.7.1@sha256:${'b'.repeat(64)}`;
const PRIVATE_UID = 61050;
const PRIVATE_GID = 61050;
const APP_DEFAULT_ENV = ['PATH=/usr/local/bin:/usr/bin:/bin', 'NODE_ENV=production', 'PYTHONDONTWRITEBYTECODE=1'];
const CLOUDFLARED_DEFAULT_ENV = ['PATH=/usr/local/bin:/usr/bin:/bin'];
const RESERVED_CHAINS = [
  'KASSINAO-EGRESS',
  'KASSINAO-EGRESS-A',
  'KASSINAO-EGRESS-B',
  'KASSINAO-HOST',
  'KASSINAO-HOST-A',
  'KASSINAO-HOST-B',
];

function firewallInventory(
  chains: string[] = RESERVED_CHAINS,
  forwardRules: string[] = ['-A FORWARD -j DOCKER-USER'],
): string {
  return [
    '*filter',
    ':INPUT ACCEPT [0:0]',
    ':FORWARD DROP [0:0]',
    ':DOCKER-USER - [0:0]',
    ...chains.map((name) => `:${name} - [0:0]`),
    ...forwardRules,
    'COMMIT',
    '',
  ].join('\n');
}

type DockerItem = Record<string, any>;

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function projectContainer(
  service: 'kassinao' | 'kassinao-public' | 'cloudflared',
  dataRoot: string,
  noDumpHelper = '/usr/local/libexec/kassinao/kassinao-no-dump',
): DockerItem {
  const names = { kassinao: 'kassinao', 'kassinao-public': 'kassinao-public', cloudflared: 'kassinao-tunnel' };
  const networkNames =
    service === 'kassinao'
      ? ['kassinao_private']
      : service === 'kassinao-public'
        ? ['kassinao_public']
        : ['kassinao_private', 'kassinao_public'];
  const portBindings =
    service === 'kassinao'
      ? { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] }
      : service === 'kassinao-public'
        ? { '8081/tcp': [{ HostIp: '127.0.0.1', HostPort: '8081' }] }
        : {};
  const mounts =
    service === 'kassinao'
      ? [
          ['/app/recordings', `${dataRoot}/recordings`, true],
          ['/app/state', `${dataRoot}/state`, true],
          ['/app/auth', `${dataRoot}/auth`, true],
          ['/home/node/.cache', `${dataRoot}/cache`, true],
          ['/run/secrets/kassinao-app.env', `${dataRoot}/config/app.env`, false],
          ['/run/kassinao/storage-mounted', `${dataRoot}/.kassinao-mounted`, false],
        ].map(([Destination, Source, RW]) => ({ Type: 'bind', Destination, Source, RW }))
      : service === 'cloudflared'
        ? [
            {
              Type: 'bind',
              Destination: '/usr/local/bin/kassinao-no-dump',
              Source: noDumpHelper,
              RW: false,
            },
            {
              Type: 'bind',
              Destination: '/run/secrets/kassinao-tunnel-token',
              Source: `${dataRoot}/config/cloudflared-token`,
              RW: false,
            },
          ]
        : [];

  const environment =
    service === 'kassinao'
      ? [
          ...APP_DEFAULT_ENV,
          'PORT=8080',
          'WEB_BIND_ADDRESS=0.0.0.0',
          'RECORDINGS_DIR=/app/recordings',
          'STATE_DIR=/app/state',
          'AUTH_STATE_DIR=/app/auth',
          `KASSINAO_RELEASE_DIGEST=sha256:${'a'.repeat(64)}`,
          `KASSINAO_DEPLOYMENT_FINGERPRINT=${'e'.repeat(32)}`,
          'TUNNEL_TOKEN=',
          'XDG_CACHE_HOME=/home/node/.cache',
          'DOTENV_CONFIG_PATH=/run/secrets/kassinao-app.env',
        ]
      : service === 'kassinao-public'
        ? [
            ...APP_DEFAULT_ENV,
            'PORT=8081',
            'WEB_BIND_ADDRESS=0.0.0.0',
            'PUBLIC_URL=https://www.example.com',
            'DOCS_URL=https://docs.example.com',
            'SOURCE_URL=https://github.com/example/kassinao',
            `KASSINAO_RELEASE_DIGEST=sha256:${'a'.repeat(64)}`,
            `KASSINAO_DEPLOYMENT_FINGERPRINT=${'e'.repeat(32)}`,
            'TRUST_PROXY_HOPS=1',
            'REPO_PUBLIC=true',
          ]
        : CLOUDFLARED_DEFAULT_ENV;
  const pidsLimit = service === 'kassinao' ? 256 : service === 'kassinao-public' ? 128 : 64;
  const memoryLimit =
    service === 'kassinao' ? 2 * 1024 ** 3 : service === 'kassinao-public' ? 384 * 1024 ** 2 : 192 * 1024 ** 2;
  const nanoCpus = service === 'kassinao' ? 1_000_000_000 : 200_000_000;
  const logConfig =
    service === 'kassinao' ? { 'max-size': '10m', 'max-file': '3' } : { 'max-size': '5m', 'max-file': '2' };

  return {
    Id: `${service}-id`,
    Name: `/${names[service]}`,
    Config: {
      Image: service === 'cloudflared' ? CLOUDFLARED : IMAGE,
      User: service === 'cloudflared' ? '65532:65532' : `${PRIVATE_UID}:${PRIVATE_GID}`,
      Env: environment,
      Labels: {
        'com.docker.compose.project': 'kassinao',
        'com.docker.compose.service': service,
      },
      ...(service === 'cloudflared'
        ? {
            Entrypoint: ['/usr/local/bin/kassinao-no-dump', '--', '/usr/local/bin/cloudflared'],
            Cmd: ['tunnel', '--no-autoupdate', 'run', '--token-file', '/run/secrets/kassinao-tunnel-token'],
          }
        : {}),
    },
    HostConfig: {
      Privileged: false,
      CapAdd: null,
      CapDrop: ['ALL'],
      Devices: null,
      DeviceCgroupRules: null,
      DeviceRequests: null,
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: true,
      Memory: memoryLimit,
      MemorySwap: memoryLimit,
      MemorySwappiness: 0,
      NanoCpus: nanoCpus,
      PidsLimit: pidsLimit,
      Ulimits: [{ Name: 'core', Hard: 0, Soft: 0 }],
      LogConfig: { Type: 'json-file', Config: logConfig },
      RestartPolicy: { Name: 'no' },
      NetworkMode: networkNames[0],
      PidMode: '',
      IpcMode: 'private',
      PortBindings: portBindings,
      Binds: null,
    },
    Mounts: mounts,
    State: service === 'cloudflared' ? { Running: true } : { Running: true, Health: { Status: 'healthy' } },
    NetworkSettings: { Networks: Object.fromEntries(networkNames.map((name) => [name, {}])) },
  };
}

function safeForeign(): DockerItem {
  return {
    Id: 'foreign-id',
    Name: '/company-app',
    Config: { Image: 'company/app:1', User: '1000:1000', Labels: {} },
    HostConfig: {
      Privileged: false,
      CapAdd: null,
      NetworkMode: 'company_default',
      PidMode: '',
      IpcMode: 'private',
      Binds: null,
    },
    Mounts: [],
    NetworkSettings: { Networks: { company_default: {} } },
  };
}

function fixture(
  options: { storageFails?: boolean; hardenerFails?: boolean; rollbackFails?: boolean; uid?: number } = {},
) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'kassinao-shared-audit-')));
  const scripts = path.join(directory, 'scripts');
  const bin = path.join(directory, 'bin');
  const dataRoot = path.join(directory, 'data');
  const backingFile = path.join(directory, 'kassinao.luks');
  const dockerJson = path.join(directory, 'docker.json');
  const volumeJson = path.join(directory, 'volumes.json');
  const volumeNames = path.join(directory, 'volume-names.txt');
  const networkJson = path.join(directory, 'networks.json');
  const preflightNetworkJson = path.join(directory, 'networks-preflight.json');
  const containerIds = path.join(directory, 'container-ids.txt');
  const linksJson = path.join(directory, 'links.json');
  const preflightLinksJson = path.join(directory, 'links-preflight.json');
  const mountTargets = path.join(directory, 'mount-targets.json');
  const nextMountTargets = path.join(directory, 'mount-targets-next.json');
  const ipv4Rules = path.join(directory, 'iptables-v4.txt');
  const ipv6Rules = path.join(directory, 'iptables-v6.txt');
  const preflightIpv4Rules = path.join(directory, 'iptables-v4-preflight.txt');
  const preflightIpv6Rules = path.join(directory, 'iptables-v6-preflight.txt');
  const calls = path.join(directory, 'calls.log');
  const swaps = path.join(directory, 'proc-swaps');
  const corePattern = path.join(directory, 'core-pattern');
  const meminfo = path.join(directory, 'meminfo');
  const suidDumpable = path.join(directory, 'suid-dumpable');
  const procRoot = path.join(directory, 'proc');
  const runtimeArchitecture = process.arch === 'arm64' ? 'linux-arm64' : 'linux-amd64';
  const runtimeRoot = path.join(directory, 'runtime', runtimeArchitecture);
  const dockerClientDirectory = path.join(directory, 'deploy', 'docker-client');
  const noDumpSource = path.join(runtimeRoot, 'kassinao-no-dump');
  const installedNoDumpDir = path.join(directory, 'installed-no-dump');
  const installedNoDump = path.join(installedNoDumpDir, 'kassinao-no-dump');
  mkdirSync(scripts);
  mkdirSync(bin);
  mkdirSync(dataRoot);
  mkdirSync(runtimeRoot, { recursive: true });
  mkdirSync(dockerClientDirectory, { recursive: true });
  mkdirSync(installedNoDumpDir);
  mkdirSync(procRoot);
  writeFileSync(noDumpSource, 'fixture-static-no-dump-launcher\n', { mode: 0o555 });
  writeFileSync(path.join(dockerClientDirectory, 'config.json'), '{}\n', { mode: 0o444 });
  writeFileSync(installedNoDump, readFileSync(noDumpSource), { mode: 0o555 });
  chmodSync(noDumpSource, 0o555);
  chmodSync(installedNoDump, 0o555);

  const auditor = path.join(scripts, 'audit-shared-vps-security.sh');
  copyFileSync(AUDITOR, auditor);
  const fixtureEnvironmentNames = [
    'AUDIT_FIXTURE_PREFLIGHT',
    'DOCKER_CONTAINER_IDS',
    'DOCKER_FIXTURE_JSON',
    'DOCKER_NETWORK_FIXTURE_JSON',
    'DOCKER_VOLUME_FIXTURE_JSON',
    'DOCKER_VOLUME_NAMES',
    'DOCKER_ROOT_DIR',
    'IPTABLES_V4_FULL',
    'IPTABLES_V4_PREFLIGHT',
    'IPTABLES_V6_FULL',
    'IPTABLES_V6_PREFLIGHT',
    'LINUX_LINKS_FULL',
    'LINUX_LINKS_PREFLIGHT',
    'SWAP_FIXTURE',
    'CORE_PATTERN_FIXTURE',
    'MEMINFO_FIXTURE',
    'SUID_DUMPABLE_FIXTURE',
  ];
  const inheritedEnvironment = path.join(directory, 'inherited-environment.bin');
  writeFileSync(
    inheritedEnvironment,
    Buffer.from(
      Object.keys(process.env)
        .filter((name) => !fixtureEnvironmentNames.includes(name))
        .map((name) => `${name}=fixture\0`)
        .join(''),
    ),
  );
  const copiedAuditor = readFileSync(auditor, 'utf8')
    .replaceAll('/proc/$$/environ', inheritedEnvironment)
    .replace(
      /# KASSINAO_HOST_NO_DUMP_BEGIN[\s\S]*?# KASSINAO_HOST_NO_DUMP_END/,
      '# KASSINAO_HOST_NO_DUMP_BEGIN\nunset LD_PRELOAD\n# KASSINAO_HOST_NO_DUMP_END',
    )
    .replaceAll("r'[0-9a-f]{64}'", "r'[A-Za-z0-9-]+'")
    .replace(
      "if key in {'PATH', 'HOME', 'LC_ALL', 'LD_PRELOAD', 'DOCKER_HOST', 'DOCKER_CONFIG'}",
      `if key in {'PATH', 'HOME', 'LC_ALL', 'LD_PRELOAD', 'DOCKER_HOST', 'DOCKER_CONFIG', ${fixtureEnvironmentNames
        .map((name) => JSON.stringify(name))
        .join(', ')}}`,
    )
    .replace(
      'DOCKER_HOST=unix:///var/run/docker.sock "DOCKER_CONFIG=$DOCKER_CONFIG" python3 -',
      `DOCKER_HOST=unix:///var/run/docker.sock "DOCKER_CONFIG=$DOCKER_CONFIG" ${fixtureEnvironmentNames
        .map((name) => `"${name}=\${${name}-}"`)
        .join(' ')} python3 -`,
    )
    .replace(
      'SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      `SAFE_SYSTEM_PATH=${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    )
    .replace(
      'for inherited_name in "${inherited_environment[@]}"; do unset "$inherited_name" 2>/dev/null || true; done',
      `for inherited_name in "\${inherited_environment[@]}"; do
  case "$inherited_name" in ${fixtureEnvironmentNames.join('|')}) continue ;; esac
  unset "$inherited_name" 2>/dev/null || true
done`,
    )
    .replace('SWAP_INVENTORY=/proc/swaps', 'SWAP_INVENTORY="$SWAP_FIXTURE"')
    .replace('CORE_PATTERN_FILE=/proc/sys/kernel/core_pattern', 'CORE_PATTERN_FILE="$CORE_PATTERN_FIXTURE"')
    .replace('MEMINFO_FILE=/proc/meminfo', 'MEMINFO_FILE="$MEMINFO_FIXTURE"')
    .replace('SUID_DUMPABLE_FILE=/proc/sys/fs/suid_dumpable', 'SUID_DUMPABLE_FILE="$SUID_DUMPABLE_FIXTURE"')
    .replace('PROC_ROOT=/proc', `PROC_ROOT=${procRoot}`);
  const isolatedAuditor = copiedAuditor.replace(
    'NO_DUMP_INSTALLED_DIR=/usr/local/libexec/kassinao',
    `NO_DUMP_INSTALLED_DIR=${installedNoDumpDir}`,
  );
  writeFileSync(auditor, isolatedAuditor);
  chmodSync(auditor, 0o755);
  writeFileSync(
    path.join(directory, 'docker-compose.yml'),
    'services:\n  cloudflared:\n    image: ' + CLOUDFLARED + '\n',
  );
  const noDumpDigest = createHash('sha256').update(readFileSync(noDumpSource)).digest('hex');
  writeFileSync(
    path.join(directory, 'MANIFEST.sha256'),
    `${noDumpDigest}  runtime/${runtimeArchitecture}/kassinao-no-dump\n` +
      'ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356  deploy/docker-client/config.json\n',
  );
  writeFileSync(
    path.join(directory, 'docker-compose.shared.yml'),
    [
      'services:',
      '  kassinao:',
      "    user: '\${KASSINAO_UID:?Defina um UID privado do adapter shared}:\${KASSINAO_GID:?Defina um GID privado do adapter shared}'",
      '    mem_limit: ${KASSINAO_CORE_MEMORY_LIMIT:?Defina KASSINAO_CORE_MEMORY_LIMIT no compose.env}',
      '    memswap_limit: ${KASSINAO_CORE_MEMORY_LIMIT:?Defina KASSINAO_CORE_MEMORY_LIMIT no compose.env}',
      '    cpus: ${KASSINAO_CORE_CPUS:?Defina KASSINAO_CORE_CPUS no compose.env}',
      '  kassinao-public:',
      "    user: '\${KASSINAO_UID:?Defina um UID privado do adapter shared}:\${KASSINAO_GID:?Defina um GID privado do adapter shared}'",
      '    mem_limit: ${KASSINAO_PUBLIC_MEMORY_LIMIT:?Defina KASSINAO_PUBLIC_MEMORY_LIMIT no compose.env}',
      '    memswap_limit: ${KASSINAO_PUBLIC_MEMORY_LIMIT:?Defina KASSINAO_PUBLIC_MEMORY_LIMIT no compose.env}',
      '    cpus: ${KASSINAO_PUBLIC_CPUS:?Defina KASSINAO_PUBLIC_CPUS no compose.env}',
      '  cloudflared:',
      "    user: '65532:65532'",
      '    mem_limit: ${KASSINAO_TUNNEL_MEMORY_LIMIT:?Defina KASSINAO_TUNNEL_MEMORY_LIMIT no compose.env}',
      '    memswap_limit: ${KASSINAO_TUNNEL_MEMORY_LIMIT:?Defina KASSINAO_TUNNEL_MEMORY_LIMIT no compose.env}',
      '    cpus: ${KASSINAO_TUNNEL_CPUS:?Defina KASSINAO_TUNNEL_CPUS no compose.env}',
      '',
    ].join('\n'),
  );

  writeFileSync(
    path.join(directory, '.env'),
    [
      'KASSINAO_HOST_SCOPE=shared',
      'KASSINAO_DEDICATED_DOCKER_HOST_ACK=',
      `KASSINAO_IMAGE=${IMAGE}`,
      `KASSINAO_DATA_ROOT=${dataRoot}`,
      `KASSINAO_RECORDINGS_DIR=${dataRoot}/recordings`,
      `KASSINAO_STATE_DIR=${dataRoot}/state`,
      `KASSINAO_AUTH_DIR=${dataRoot}/auth`,
      `KASSINAO_MODEL_CACHE_DIR=${dataRoot}/cache`,
      `KASSINAO_SHARED_APP_ENV_FILE=${dataRoot}/config/app.env`,
      `KASSINAO_SHARED_TUNNEL_TOKEN_FILE=${dataRoot}/config/cloudflared-token`,
      `KASSINAO_SHARED_LUKS_BACKING_FILE=${backingFile}`,
      `KASSINAO_UID=${PRIVATE_UID}`,
      `KASSINAO_GID=${PRIVATE_GID}`,
      'KASSINAO_HOST_PORT=8080',
      'KASSINAO_PUBLIC_HOST_PORT=8081',
      'KASSINAO_CORE_MEMORY_LIMIT=2g',
      'KASSINAO_CORE_CPUS=1.0',
      'KASSINAO_PUBLIC_MEMORY_LIMIT=384m',
      'KASSINAO_PUBLIC_CPUS=0.2',
      'KASSINAO_TUNNEL_MEMORY_LIMIT=192m',
      'KASSINAO_TUNNEL_CPUS=0.2',
      'COMPOSE_PROFILES=tunnel,split-public',
      '',
    ].join('\n'),
  );

  const controls = [
    ['verify-shared-luks-storage.sh', options.storageFails ? 1 : 0, 'storage'],
    ['check-shared-migration-rollback.sh', options.rollbackFails ? 1 : 0, 'rollback'],
    ['harden-docker-egress.sh', options.hardenerFails ? 1 : 0, 'hardener'],
  ] as const;
  for (const [name, status, label] of controls) {
    const file = path.join(scripts, name);
    writeFileSync(
      file,
      `#!/usr/bin/env bash\nprintf '${label}:%s\\n' "$*" >> ${shellLiteral(calls)}\nexit ${status}\n`,
    );
    chmodSync(file, 0o755);
  }

  const id = path.join(bin, 'id');
  writeFileSync(id, `#!/usr/bin/env bash\n[ "\${1:-}" = -u ] && printf '${options.uid ?? 0}\\n'\n`);
  chmodSync(id, 0o755);

  const ip = path.join(bin, 'ip');
  writeFileSync(
    ip,
    `#!/usr/bin/env bash
set -eu
[ "$*" = '-j -details link show' ] || exit 92
if [ "\${AUDIT_FIXTURE_PREFLIGHT:-0}" = 1 ]; then
  cat "\${LINUX_LINKS_PREFLIGHT:?}"
else
  cat "\${LINUX_LINKS_FULL:?}"
fi
`,
  );
  chmodSync(ip, 0o755);

  writeFileSync(swaps, 'Filename\tType\tSize\tUsed\tPriority\n');
  writeFileSync(corePattern, '/dev/null\n');
  writeFileSync(suidDumpable, '0\n');
  writeFileSync(meminfo, 'MemTotal:        8388608 kB\n');
  const getconf = path.join(bin, 'getconf');
  writeFileSync(getconf, '#!/usr/bin/env bash\n[ "$*" = _NPROCESSORS_ONLN ] && printf "2\\n"\n');
  chmodSync(getconf, 0o755);
  const getent = path.join(bin, 'getent');
  writeFileSync(getent, '#!/usr/bin/env bash\nexit 2\n');
  chmodSync(getent, 0o755);
  writeFileSync(mountTargets, JSON.stringify({ filesystems: [{ target: '/' }] }));
  const findmnt = path.join(bin, 'findmnt');
  writeFileSync(
    findmnt,
    `#!/usr/bin/env bash
set -eu
[ "$*" = '--json --output TARGET' ] || exit 94
cat ${shellLiteral(mountTargets)}
[ ! -f ${shellLiteral(nextMountTargets)} ] || mv ${shellLiteral(nextMountTargets)} ${shellLiteral(mountTargets)}
`,
  );
  chmodSync(findmnt, 0o755);
  const lsblk = path.join(bin, 'lsblk');
  writeFileSync(
    lsblk,
    `#!/usr/bin/env bash
printf 'crypt\n'
`,
  );
  chmodSync(lsblk, 0o755);
  const readlink = path.join(bin, 'readlink');
  writeFileSync(
    readlink,
    `#!/usr/bin/env bash
if [ "\${1:-}" = -f ] && [ "\${2:-}" = -- ]; then printf '%s\n' "\${3:-}"; else /usr/bin/readlink "$@"; fi
`,
  );
  chmodSync(readlink, 0o755);
  const stat = path.join(bin, 'stat');
  writeFileSync(
    stat,
    `#!/usr/bin/env bash
case "\${!#}" in
  ${shellLiteral(installedNoDumpDir)}) printf '755:0:0\n' ;;
  ${shellLiteral(installedNoDump)}) printf '555:0:0:1\n' ;;
  *) /usr/bin/stat "$@" ;;
esac
`,
  );
  chmodSync(stat, 0o755);
  const find = path.join(bin, 'find');
  writeFileSync(
    find,
    `#!/usr/bin/env bash
if [ "\${1:-}" = ${shellLiteral(installedNoDumpDir)} ] && [ "\${*: -2}" = "-printf %f\\n" ]; then
  printf 'kassinao-no-dump\n'
else
  /usr/bin/find "$@"
fi
`,
  );
  chmodSync(find, 0o755);

  for (const [name, fullVariable, preflightVariable] of [
    ['iptables-save', 'IPTABLES_V4_FULL', 'IPTABLES_V4_PREFLIGHT'],
    ['ip6tables-save', 'IPTABLES_V6_FULL', 'IPTABLES_V6_PREFLIGHT'],
  ] as const) {
    const executable = path.join(bin, name);
    writeFileSync(
      executable,
      `#!/usr/bin/env bash
set -eu
[ "$*" = '-t filter' ] || exit 93
if [ "\${AUDIT_FIXTURE_PREFLIGHT:-0}" = 1 ]; then
  cat "\${${preflightVariable}:?}"
else
  cat "\${${fullVariable}:?}"
fi
`,
    );
    chmodSync(executable, 0o755);
  }

  const docker = path.join(bin, 'docker');
  writeFileSync(
    docker,
    `#!/usr/bin/env bash
set -eu
printf 'docker:%s\\n' "$*" >> ${shellLiteral(calls)}
case "\${1:-}" in
  info)
    case "$*" in
      *DockerRootDir*) printf '%s\\n' "\${DOCKER_ROOT_DIR:?}" ;;
      *) printf '29.0.1\\n' ;;
    esac
    ;;
  ps) cat "\${DOCKER_CONTAINER_IDS:?}" ;;
  inspect)
    if [ "\${2:-}" = --format ]; then
      case "\${3:-}" in
        *NetworkAttachments*)
          python3 - "$@" <<'PY'
import json, os, sys
with open(os.environ['DOCKER_FIXTURE_JSON'], encoding='utf-8') as source:
    items = json.load(source)
wanted = set(sys.argv[4:])
for item in items:
    if item.get('Id') not in wanted:
        continue
    config = item.get('Config') or {}
    host = item.get('HostConfig') or {}
    projected = {
        'Id': item.get('Id'),
        'Name': item.get('Name'),
        'Config': {
            'User': config.get('User'),
            'Labels': {
                'com.docker.compose.project': (config.get('Labels') or {}).get('com.docker.compose.project'),
                'com.docker.compose.service': (config.get('Labels') or {}).get('com.docker.compose.service'),
            },
        },
        'HostConfig': {
            'Privileged': host.get('Privileged'),
            'NetworkMode': host.get('NetworkMode'),
            'PidMode': host.get('PidMode'),
            'IpcMode': host.get('IpcMode'),
            'UTSMode': host.get('UTSMode'),
            'HasDevices': bool(host.get('Devices')),
            'HasDeviceCgroupRules': bool(host.get('DeviceCgroupRules')),
            'HasDeviceRequests': bool(host.get('DeviceRequests')),
            'CapAdd': host.get('CapAdd'),
            'HasVolumesFrom': bool(host.get('VolumesFrom')),
        },
        'Mounts': [{key: mount.get(key) for key in ('Type', 'Name', 'Driver', 'Source', 'Destination', 'RW', 'Propagation')}
                   for mount in item.get('Mounts') or []],
        'State': {
            'Running': (item.get('State') or {}).get('Running'),
            'Pid': (item.get('State') or {}).get('Pid'),
        },
        'NetworkAttachments': [
            {
                'Name': name,
                'NetworkID': network.get('NetworkID'),
                'EndpointID': network.get('EndpointID'),
                'Gateway': network.get('Gateway'),
                'IPAddress': network.get('IPAddress'),
                'GlobalIPv6Address': network.get('GlobalIPv6Address'),
            }
            for name, network in ((item.get('NetworkSettings') or {}).get('Networks') or {}).items()
        ],
    }
    print(json.dumps(projected, separators=(',', ':')))
PY
          ;;
        *LogConfig*)
          python3 - "$@" <<'PY'
import json, os, sys
with open(os.environ['DOCKER_FIXTURE_JSON'], encoding='utf-8') as source:
    items = json.load(source)
wanted = set(sys.argv[4:])
for item in items:
    if item.get('Id') not in wanted:
        continue
    config = item.get('Config') or {}
    host = item.get('HostConfig') or {}
    state = item.get('State') or {}
    log = host.get('LogConfig') or {}
    projected = {
        'Id': item.get('Id'),
        'Config': {key: config.get(key) for key in ('Image', 'User', 'Env', 'Entrypoint', 'Cmd')},
        'HostConfig': {
            'CapDrop': host.get('CapDrop'),
            'SecurityOpt': host.get('SecurityOpt'),
            'ReadonlyRootfs': host.get('ReadonlyRootfs'),
            'Memory': host.get('Memory'),
            'MemorySwap': host.get('MemorySwap'),
            'MemorySwappiness': host.get('MemorySwappiness'),
            'NanoCpus': host.get('NanoCpus'),
            'PidsLimit': host.get('PidsLimit'),
            'Ulimits': host.get('Ulimits'),
            'LogConfig': {'Type': log.get('Type'), 'Config': log.get('Config')},
            'RestartPolicy': {'Name': (host.get('RestartPolicy') or {}).get('Name')},
            'PortBindings': host.get('PortBindings'),
        },
        'State': {'Health': {'Status': (state.get('Health') or {}).get('Status')}},
    }
    print(json.dumps(projected, separators=(',', ':')))
PY
          ;;
        *) exit 95 ;;
      esac
    else
      cat "\${DOCKER_FIXTURE_JSON:?}"
    fi
    ;;
  image)
    case "$*" in
      *cloudflare/cloudflared*) printf '%s\n' ${shellLiteral(JSON.stringify(CLOUDFLARED_DEFAULT_ENV))} ;;
      *) printf '%s\n' ${shellLiteral(JSON.stringify(APP_DEFAULT_ENV))} ;;
    esac
    ;;
  network)
    case "\${2:-}" in
      ls) printf 'private-network-id\\npublic-network-id\\ncompany-network-id\\n' ;;
      inspect)
        [ "\${3:-}" = --format ] || exit 96
        python3 - "$@" <<'PY'
import json, os, sys
with open(os.environ['DOCKER_NETWORK_FIXTURE_JSON'], encoding='utf-8') as source:
    items = json.load(source)
wanted = set(sys.argv[5:])
for item in items:
    if item.get('Id') not in wanted:
        continue
    options = item.get('Options') or {}
    projected = {
        'Id': item.get('Id'), 'Name': item.get('Name'), 'Driver': item.get('Driver'),
        'Internal': item.get('Internal'),
        'IPAM': {'Driver': (item.get('IPAM') or {}).get('Driver'), 'Config': (item.get('IPAM') or {}).get('Config')},
        'BridgeName': options.get('com.docker.network.bridge.name'),
        'GatewayModeIPv4': options.get('com.docker.network.bridge.gateway_mode_ipv4'),
        'GatewayModeIPv6': options.get('com.docker.network.bridge.gateway_mode_ipv6'),
        'ComposeProject': (item.get('Labels') or {}).get('com.docker.compose.project'),
        'ComposeNetwork': (item.get('Labels') or {}).get('com.docker.compose.network'),
        'Containers': [
            {'Id': member_id, 'Name': member.get('Name'), 'EndpointID': member.get('EndpointID'),
             'IPv4Address': member.get('IPv4Address'), 'IPv6Address': member.get('IPv6Address')}
            for member_id, member in (item.get('Containers') or {}).items()
        ],
    }
    print(json.dumps(projected, separators=(',', ':')))
PY
        ;;
      *) exit 91 ;;
    esac
    ;;
  volume)
    case "\${2:-}" in
      ls) cat "\${DOCKER_VOLUME_NAMES:?}" ;;
      inspect)
        [ "\${3:-}" = --format ] || exit 97
        python3 - "$@" <<'PY'
import json, os, sys
with open(os.environ['DOCKER_VOLUME_FIXTURE_JSON'], encoding='utf-8') as source:
    items = json.load(source)
wanted = set(sys.argv[5:])
for item in items:
    if item.get('Name') not in wanted:
        continue
    options = item.get('Options') or {}
    local = item.get('Driver') == 'local'
    projected = {
        'Name': item.get('Name'), 'Driver': item.get('Driver'), 'Scope': item.get('Scope'),
        'Mountpoint': item.get('Mountpoint'), 'HasOptions': bool(item.get('Options')),
        'OptionType': options.get('type') if local else None,
        'OptionDevice': options.get('device') if local else None,
    }
    print(json.dumps(projected, separators=(',', ':')))
PY
        ;;
      *) exit 94 ;;
    esac
    ;;
  *) printf 'unexpected docker call: %s\\n' "$*" >&2; exit 90 ;;
esac
`,
  );
  chmodSync(docker, 0o755);

  const items = [
    projectContainer('kassinao', dataRoot, installedNoDump),
    projectContainer('kassinao-public', dataRoot, installedNoDump),
    projectContainer('cloudflared', dataRoot, installedNoDump),
    safeForeign(),
  ];
  writeFileSync(dockerJson, JSON.stringify(items));
  writeFileSync(containerIds, 'kassinao-id\nkassinao-public-id\ncloudflared-id\nforeign-id\n');
  const volumeItems = [
    {
      Name: 'company-data',
      Driver: 'local',
      Scope: 'local',
      Mountpoint: '/var/lib/docker/volumes/company-data/_data',
      Options: null,
    },
  ];
  writeFileSync(volumeJson, JSON.stringify(volumeItems));
  writeFileSync(volumeNames, 'company-data\n');

  writeFileSync(
    linksJson,
    JSON.stringify([
      { ifname: 'lo', linkinfo: {} },
      { ifname: 'kas-private0', linkinfo: { info_kind: 'bridge' } },
      { ifname: 'kas-public0', linkinfo: { info_kind: 'bridge' } },
      { ifname: 'company0', linkinfo: { info_kind: 'bridge' } },
    ]),
  );
  writeFileSync(
    preflightLinksJson,
    JSON.stringify([
      { ifname: 'lo', linkinfo: {} },
      { ifname: 'company0', linkinfo: { info_kind: 'bridge' } },
    ]),
  );
  writeFileSync(ipv4Rules, firewallInventory());
  writeFileSync(ipv6Rules, firewallInventory());
  writeFileSync(preflightIpv4Rules, firewallInventory([]));
  writeFileSync(preflightIpv6Rules, firewallInventory([]));

  const networkItems = [
    {
      Id: 'private-network-id',
      Name: 'kassinao_private',
      Driver: 'bridge',
      Internal: false,
      Options: { 'com.docker.network.bridge.name': 'kas-private0' },
      Labels: { 'com.docker.compose.project': 'kassinao', 'com.docker.compose.network': 'private' },
    },
    {
      Id: 'public-network-id',
      Name: 'kassinao_public',
      Driver: 'bridge',
      Internal: true,
      Options: {
        'com.docker.network.bridge.name': 'kas-public0',
        'com.docker.network.bridge.gateway_mode_ipv4': 'isolated',
        'com.docker.network.bridge.gateway_mode_ipv6': 'isolated',
      },
      Labels: { 'com.docker.compose.project': 'kassinao', 'com.docker.compose.network': 'public' },
    },
    {
      Id: 'company-network-id',
      Name: 'company_default',
      Driver: 'bridge',
      Internal: false,
      Options: {},
      Labels: {},
    },
  ];
  writeFileSync(networkJson, JSON.stringify(networkItems));
  const preflightNetworkItems = [structuredClone(networkItems[2])];
  writeFileSync(preflightNetworkJson, JSON.stringify(preflightNetworkItems));

  return {
    directory,
    auditor,
    bin,
    dockerJson,
    volumeJson,
    volumeNames,
    networkJson,
    preflightNetworkJson,
    containerIds,
    linksJson,
    preflightLinksJson,
    mountTargets,
    nextMountTargets,
    ipv4Rules,
    ipv6Rules,
    preflightIpv4Rules,
    preflightIpv6Rules,
    calls,
    swaps,
    corePattern,
    meminfo,
    suidDumpable,
    procRoot,
    noDumpSource,
    installedNoDump,
    items,
    volumeItems,
    networkItems,
    preflightNetworkItems,
    dataRoot,
    backingFile,
    dockerRootDir: '/var/lib/docker',
  };
}

function run(aFixture: ReturnType<typeof fixture>, args: string[] = []) {
  const {
    DOCKER_HOST: _dockerHost,
    DOCKER_CONTEXT: _dockerContext,
    DOCKER_CONFIG: _dockerConfig,
    DOCKER_TLS_VERIFY: _dockerTlsVerify,
    DOCKER_CERT_PATH: _dockerCertPath,
    DOCKER_API_VERSION: _dockerApiVersion,
    ...cleanEnvironment
  } = process.env;
  const usesPreflightTopology = args.some((argument) => ['--preflight', '--neighbors-only'].includes(argument));
  return spawnSync('bash', [aFixture.auditor, ...args], {
    cwd: aFixture.directory,
    encoding: 'utf8',
    env: {
      ...cleanEnvironment,
      PATH: `${aFixture.bin}:${process.env.PATH ?? ''}`,
      DOCKER_FIXTURE_JSON: aFixture.dockerJson,
      DOCKER_NETWORK_FIXTURE_JSON: usesPreflightTopology ? aFixture.preflightNetworkJson : aFixture.networkJson,
      DOCKER_VOLUME_FIXTURE_JSON: aFixture.volumeJson,
      DOCKER_VOLUME_NAMES: aFixture.volumeNames,
      DOCKER_CONTAINER_IDS: aFixture.containerIds,
      DOCKER_ROOT_DIR: aFixture.dockerRootDir,
      LINUX_LINKS_FULL: aFixture.linksJson,
      LINUX_LINKS_PREFLIGHT: aFixture.preflightLinksJson,
      IPTABLES_V4_FULL: aFixture.ipv4Rules,
      IPTABLES_V6_FULL: aFixture.ipv6Rules,
      IPTABLES_V4_PREFLIGHT: aFixture.preflightIpv4Rules,
      IPTABLES_V6_PREFLIGHT: aFixture.preflightIpv6Rules,
      AUDIT_FIXTURE_PREFLIGHT: usesPreflightTopology ? '1' : '0',
      SWAP_FIXTURE: aFixture.swaps,
      CORE_PATTERN_FIXTURE: aFixture.corePattern,
      MEMINFO_FIXTURE: aFixture.meminfo,
      SUID_DUMPABLE_FIXTURE: aFixture.suidDumpable,
    },
  });
}

function useInstalledPreflightTopology(aFixture: ReturnType<typeof fixture>): void {
  copyFileSync(aFixture.linksJson, aFixture.preflightLinksJson);
  copyFileSync(aFixture.ipv4Rules, aFixture.preflightIpv4Rules);
  copyFileSync(aFixture.ipv6Rules, aFixture.preflightIpv6Rules);
  copyFileSync(aFixture.networkJson, aFixture.preflightNetworkJson);
}

function prepareAbsentPreflightTopology(aFixture: ReturnType<typeof fixture>): void {
  aFixture.items.splice(0, 3);
  writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));
  writeFileSync(aFixture.containerIds, 'foreign-id\n');
}

function installOwnedPreflightFirewall(aFixture: ReturnType<typeof fixture>): void {
  copyFileSync(aFixture.ipv4Rules, aFixture.preflightIpv4Rules);
  copyFileSync(aFixture.ipv6Rules, aFixture.preflightIpv6Rules);
}

function prepareOwnedUninstallTopology(aFixture: ReturnType<typeof fixture>): void {
  for (const item of aFixture.items.slice(0, 3)) item.State = { Running: false };
  writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));
}

function prepareAbsentUninstallTopology(aFixture: ReturnType<typeof fixture>): void {
  aFixture.items.splice(0, 3);
  aFixture.networkItems.splice(0, 2);
  writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));
  writeFileSync(aFixture.containerIds, 'foreign-id\n');
  writeFileSync(aFixture.networkJson, JSON.stringify(aFixture.networkItems));
  writeFileSync(
    aFixture.linksJson,
    JSON.stringify([
      { ifname: 'lo', linkinfo: {} },
      { ifname: 'company0', linkinfo: { info_kind: 'bridge' } },
    ]),
  );
}

function disableTunnelProfile(aFixture: ReturnType<typeof fixture>): void {
  const envFile = path.join(aFixture.directory, '.env');
  const current = readFileSync(envFile, 'utf8');
  expect(current).toContain('COMPOSE_PROFILES=tunnel,split-public');
  writeFileSync(envFile, current.replace('COMPOSE_PROFILES=tunnel,split-public', 'COMPOSE_PROFILES=split-public'));
}

function replaceEnvValue(aFixture: ReturnType<typeof fixture>, key: string, value: string): void {
  const envFile = path.join(aFixture.directory, '.env');
  const current = readFileSync(envFile, 'utf8');
  const expression = new RegExp(`^${key}=.*$`, 'm');
  expect(current).toMatch(expression);
  writeFileSync(envFile, current.replace(expression, `${key}=${value}`));
}

describe('shared VPS read-only audit', () => {
  it('tem sintaxe Bash válida e não contém operações mutantes', () => {
    const syntax = spawnSync('bash', ['-n', AUDITOR], { encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);
    const source = readFileSync(AUDITOR, 'utf8');
    expect(source).toContain('"$HARDENER" --shared-host --check');
    expect(source).toContain('docker_forward_hook_is_stable');
    expect(source).toContain('verify-shared-luks-storage.sh');
    expect(source).toContain('check-shared-migration-rollback.sh');
    expect(source).toContain('SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
    expect(source).toContain('export PATH="$SAFE_SYSTEM_PATH" HOME=/root LC_ALL=C');
    expect(source).toContain('env_file_override="$KASSINAO_ENV_FILE"');
    expect(source.indexOf('export PATH="$SAFE_SYSTEM_PATH" HOME=/root LC_ALL=C')).toBeLessThan(
      source.indexOf('command -v "$command"'),
    );
    expect(source).toContain('/etc/systemd/system/docker.service.d/kassinao-egress.conf');
    expect(source).toContain('ip -j -details link show');
    expect(source).toContain('iptables-save -t filter');
    expect(source).toContain('ip6tables-save -t filter');
    expect(source).toContain('{{json (index $mount "Name")}}');
    expect(source).toContain('{{json (index $mount "Driver")}}');
    expect(source).toContain('{{json (index $network "GlobalIPv6Address")}}');
    expect(source).toContain('{{json $mount.Type}}');
    expect(source).toContain('{{json $mount.Source}}');
    expect(source).not.toContain('{{json $mount.Name}}');
    expect(source).not.toContain('{{json $mount.Driver}}');
    expect(source).toContain("type(mount.get('RW')) is not bool");
    expect(source).toContain("mount_type in ('bind', 'volume')");
    expect(source).not.toMatch(/\bdocker\s+(?:start|stop|restart|kill|rm|run|create|update|compose)\b/);
    expect(source).not.toMatch(/\b(?:iptables|ip6tables|nft|systemctl)\s/);
  });

  it('aprova storage, egress, projeto isolado e vizinho sem privilégio', () => {
    const aFixture = fixture();
    const result = run(aFixture);
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stdout).toContain('Audit shared aprovado');
    const calls = existsSync(aFixture.calls) ? readFileSync(aFixture.calls, 'utf8') : '';
    expect(calls).toContain('storage:');
    expect(calls).toContain('rollback:');
    expect(calls).toContain('hardener:--shared-host --check');
    expect(calls).toContain('docker:ps -aq --no-trunc');
    expect(calls).toContain('docker:network ls -q --no-trunc');
    expect(calls).not.toMatch(/docker:(?:start|stop|restart|kill|rm|run|create|update)/);
  });

  it('aceita Name e Driver ausentes como null quando não são obrigatórios no mount', () => {
    const aFixture = fixture();
    const projectBind = aFixture.items[0].Mounts[0];
    expect(projectBind).not.toHaveProperty('Name');
    expect(projectBind).not.toHaveProperty('Driver');
    aFixture.items[3].Mounts.push({
      Type: 'volume',
      Name: 'company-data',
      Source: '/var/lib/docker/volumes/company-data/_data',
      Destination: '/data',
      RW: true,
    });
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
  });

  it.each([
    ['Type', 'tipo de mount do container é inválido'],
    ['Source', 'source de mount do container é inválido'],
    ['Destination', 'destino de mount do container é inválido'],
    ['RW', 'permissão de mount do container é inválida'],
  ])('falha fechado quando o campo obrigatório %s está ausente no mount', (field, message) => {
    const aFixture = fixture();
    delete aFixture.items[0].Mounts[0][field];
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
  });

  it('aprova host sem swap ativo e device swap com cadeia dm-crypt extensa sem falso SIGPIPE', () => {
    const noSwapFixture = fixture();
    const noSwap = run(noSwapFixture);
    expect(noSwap.status, `${noSwap.stderr}\n${noSwap.stdout}`).toBe(0);

    const encryptedSwapFixture = fixture();
    writeFileSync(
      encryptedSwapFixture.swaps,
      'Filename\tType\tSize\tUsed\tPriority\n/dev/dm-9\tpartition\t1048572\t0\t-2\n',
    );
    writeFileSync(
      path.join(encryptedSwapFixture.bin, 'lsblk'),
      "#!/usr/bin/env bash\nprintf 'crypt\\n'\nprintf 'loop\\n%.0s' {1..20000}\n",
      { mode: 0o755 },
    );
    const encryptedSwap = run(encryptedSwapFixture);
    expect(encryptedSwap.status, `${encryptedSwap.stderr}\n${encryptedSwap.stdout}`).toBe(0);
  }, 15_000);

  it('neighbors-only falha fechado antes do Docker quando existe swap plaintext ativo', () => {
    const aFixture = fixture({ storageFails: true });
    writeFileSync(aFixture.swaps, 'Filename\tType\tSize\tUsed\tPriority\n/swapfile\tfile\t1048572\t0\t-2\n');

    const result = run(aFixture, ['--neighbors-only']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('swap ativo sem prova dm-crypt');
    const calls = existsSync(aFixture.calls) ? readFileSync(aFixture.calls, 'utf8') : '';
    expect(calls).not.toContain('docker:');
    expect(calls).not.toContain('storage:');
  });

  it('exige /dev/null no runtime final e só tolera destino não-pipe no primeiro neighbors-only', () => {
    const driftFixture = fixture();
    writeFileSync(driftFixture.corePattern, 'core\n');
    const drift = run(driftFixture);
    expect(drift.status).not.toBe(0);
    expect(drift.stderr).toContain('kernel.core_pattern=/dev/null');

    const firstGateFixture = fixture();
    prepareAbsentPreflightTopology(firstGateFixture);
    writeFileSync(firstGateFixture.corePattern, 'core\n');
    const firstGate = run(firstGateFixture, ['--neighbors-only']);
    expect(firstGate.status, `${firstGate.stderr}\n${firstGate.stdout}`).toBe(0);

    const pipedFixture = fixture();
    prepareAbsentPreflightTopology(pipedFixture);
    writeFileSync(pipedFixture.corePattern, '|/usr/share/apport/apport %p %s %c %d %P %E\n');
    const piped = run(pipedFixture, ['--neighbors-only']);
    expect(piped.status).not.toBe(0);
    expect(piped.stderr).toContain('kernel.core_pattern em pipe é incompatível');
  });

  it.each([
    ['ausente', (aFixture: ReturnType<typeof fixture>) => rmSync(aFixture.suidDumpable)],
    ['diferente de zero', (aFixture: ReturnType<typeof fixture>) => writeFileSync(aFixture.suidDumpable, '2\n')],
  ] as const)('falha fechado quando fs.suid_dumpable está %s', (_label, arrange) => {
    const aFixture = fixture();
    arrange(aFixture);

    const result = run(aFixture, ['--neighbors-only']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/fs\.suid_dumpable/);
    const calls = existsSync(aFixture.calls) ? readFileSync(aFixture.calls, 'utf8') : '';
    expect(calls).not.toContain('docker:');
  });

  it.each([
    ['core parado', 0, (item: DockerItem) => (item.State.Running = false)],
    ['public parado', 1, (item: DockerItem) => (item.State.Running = false)],
    ['túnel parado', 2, (item: DockerItem) => (item.State.Running = false)],
    ['core unhealthy', 0, (item: DockerItem) => (item.State.Health.Status = 'unhealthy')],
    ['public sem health', 1, (item: DockerItem) => delete item.State.Health],
    ['PidsLimit core', 0, (item: DockerItem) => (item.HostConfig.PidsLimit = 255)],
    ['PidsLimit public', 1, (item: DockerItem) => (item.HostConfig.PidsLimit = 127)],
    ['PidsLimit túnel', 2, (item: DockerItem) => (item.HostConfig.PidsLimit = 63)],
    ['driver de log core', 0, (item: DockerItem) => (item.HostConfig.LogConfig.Type = 'local')],
    ['driver de log public', 1, (item: DockerItem) => (item.HostConfig.LogConfig.Type = 'local')],
    ['driver de log túnel', 2, (item: DockerItem) => (item.HostConfig.LogConfig.Type = 'local')],
    ['max-size core', 0, (item: DockerItem) => (item.HostConfig.LogConfig.Config['max-size'] = '11m')],
    ['max-file core', 0, (item: DockerItem) => (item.HostConfig.LogConfig.Config['max-file'] = '4')],
    ['max-size public', 1, (item: DockerItem) => (item.HostConfig.LogConfig.Config['max-size'] = '6m')],
    ['max-file public', 1, (item: DockerItem) => (item.HostConfig.LogConfig.Config['max-file'] = '3')],
    ['max-size túnel', 2, (item: DockerItem) => (item.HostConfig.LogConfig.Config['max-size'] = '6m')],
    ['max-file túnel', 2, (item: DockerItem) => (item.HostConfig.LogConfig.Config['max-file'] = '3')],
    ['opção de log extra', 0, (item: DockerItem) => (item.HostConfig.LogConfig.Config.compress = 'true')],
  ] as const)('audit full falha fechado com drift de runtime: %s', (_label, index, mutate) => {
    const aFixture = fixture();
    mutate(aFixture.items[index]);
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('inventário Docker viola o contrato do adapter shared');
  });

  it('aprova uninstall-preflight com firewall owned e topologia Kassinão íntegra', () => {
    const aFixture = fixture();
    prepareOwnedUninstallTopology(aFixture);

    const result = run(aFixture, ['--uninstall-preflight']);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stdout).toContain('Preflight de uninstall shared aprovado');
    const calls = readFileSync(aFixture.calls, 'utf8');
    expect(calls).toContain('storage:');
    expect(calls).toContain('hardener:--shared-host --check');
    expect(calls).not.toContain('rollback:');
  });

  it('aprova uninstall-preflight após remoção total da topologia, preservando a policy owned', () => {
    const aFixture = fixture();
    prepareAbsentUninstallTopology(aFixture);

    const result = run(aFixture, ['--uninstall-preflight']);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stdout).toContain('topologia ausente ou íntegra');
    const calls = readFileSync(aFixture.calls, 'utf8');
    expect(calls).toContain('storage:');
    expect(calls).toContain('hardener:--shared-host --check');
  });

  it.each([
    [
      'container ausente em topologia restante',
      (aFixture: ReturnType<typeof fixture>) => {
        prepareOwnedUninstallTopology(aFixture);
        aFixture.items.splice(1, 1);
        writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));
        writeFileSync(aFixture.containerIds, 'kassinao-id\ncloudflared-id\nforeign-id\n');
      },
    ],
    [
      'redes/interfaces sem containers',
      (aFixture: ReturnType<typeof fixture>) => {
        aFixture.items.splice(0, 3);
        writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));
        writeFileSync(aFixture.containerIds, 'foreign-id\n');
      },
    ],
    [
      'container running',
      (aFixture: ReturnType<typeof fixture>) => {
        prepareOwnedUninstallTopology(aFixture);
        aFixture.items[0].State.Running = true;
        writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));
      },
    ],
  ] as const)('uninstall-preflight recusa estado parcial: %s', (_label, arrange) => {
    const aFixture = fixture();
    arrange(aFixture);

    const result = run(aFixture, ['--uninstall-preflight']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/parcial|totalmente ausente|parado/);
  });

  it('uninstall-preflight exige firewall Kassinão owned mesmo com topologia ausente', () => {
    const aFixture = fixture();
    prepareAbsentUninstallTopology(aFixture);
    writeFileSync(aFixture.ipv4Rules, firewallInventory([]));
    writeFileSync(aFixture.ipv6Rules, firewallInventory([]));

    const result = run(aFixture, ['--uninstall-preflight']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('precisam estar owned no modo uninstall-preflight');
  });

  it('aceita named volume normal de workload vizinho no Docker data-root', () => {
    const aFixture = fixture();
    aFixture.items[3].Mounts.push({
      Type: 'volume',
      Name: 'company-data',
      Driver: 'local',
      Source: '/var/lib/docker/volumes/company-data/_data',
      Destination: '/data',
      RW: true,
    });
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
  });

  it('recusa bind mount de workload vizinho sobre o Docker data-root', () => {
    const aFixture = fixture();
    aFixture.items[3].Mounts.push({
      Type: 'bind',
      Source: '/var/lib/docker/volumes/company-data/_data',
      Destination: '/docker-data',
      RW: false,
    });
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('faz bind do DockerRootDir efetivo');
  });

  it('usa o DockerRootDir efetivo e continua permitindo named volume normal', () => {
    const aFixture = fixture();
    aFixture.dockerRootDir = '/srv/company-docker';
    aFixture.items[3].Mounts.push({
      Type: 'volume',
      Name: 'company-data',
      Driver: 'local',
      Source: '/srv/company-docker/volumes/company-data/_data',
      Destination: '/data',
      RW: true,
    });
    aFixture.volumeItems[0].Mountpoint = '/srv/company-docker/volumes/company-data/_data';
    writeFileSync(aFixture.volumeJson, JSON.stringify(aFixture.volumeItems));
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
  });

  it('faz scan metadata-only sem bloquear FIFO legítimo dentro de volume vizinho', () => {
    const aFixture = fixture();
    const dockerRoot = path.join(aFixture.directory, 'company-docker');
    const mountpoint = path.join(dockerRoot, 'volumes', 'company-data', '_data');
    mkdirSync(mountpoint, { recursive: true });
    const fifo = path.join(mountpoint, 'worker.sock.fifo');
    const makeFifo = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    expect(makeFifo.status, makeFifo.stderr).toBe(0);
    aFixture.dockerRootDir = dockerRoot;
    aFixture.items[3].Mounts.push({
      Type: 'volume',
      Name: 'company-data',
      Driver: 'local',
      Source: mountpoint,
      Destination: '/data',
      RW: true,
    });
    aFixture.volumeItems[0].Mountpoint = mountpoint;
    useInstalledPreflightTopology(aFixture);
    writeFileSync(aFixture.volumeJson, JSON.stringify(aFixture.volumeItems));
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture, ['--neighbors-only']);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
  });

  it('recusa bind mount aninhado no mesmo filesystem dentro de volume vizinho', () => {
    const aFixture = fixture();
    const dockerRoot = path.join(aFixture.directory, 'company-docker');
    const mountpoint = path.join(dockerRoot, 'volumes', 'company-data', '_data');
    const nestedMountpoint = path.join(mountpoint, 'nested-bind');
    mkdirSync(nestedMountpoint, { recursive: true });
    aFixture.dockerRootDir = dockerRoot;
    aFixture.items[3].Mounts.push({
      Type: 'volume',
      Name: 'company-data',
      Driver: 'local',
      Source: mountpoint,
      Destination: '/data',
      RW: true,
    });
    aFixture.volumeItems[0].Mountpoint = mountpoint;
    useInstalledPreflightTopology(aFixture);
    writeFileSync(
      aFixture.mountTargets,
      JSON.stringify({
        filesystems: [{ target: '/', children: [{ target: mountpoint, children: [{ target: nestedMountpoint }] }] }],
      }),
    );
    writeFileSync(aFixture.volumeJson, JSON.stringify(aFixture.volumeItems));
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture, ['--neighbors-only']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('árvore estrangeira contém mount aninhado');
  });

  it('recusa mudança concorrente no inventário de mounts durante o deep scan', () => {
    const aFixture = fixture();
    const dockerRoot = path.join(aFixture.directory, 'company-docker');
    const mountpoint = path.join(dockerRoot, 'volumes', 'company-data', '_data');
    mkdirSync(mountpoint, { recursive: true });
    aFixture.dockerRootDir = dockerRoot;
    aFixture.items[3].Mounts.push({
      Type: 'volume',
      Name: 'company-data',
      Driver: 'local',
      Source: mountpoint,
      Destination: '/data',
      RW: true,
    });
    aFixture.volumeItems[0].Mountpoint = mountpoint;
    useInstalledPreflightTopology(aFixture);
    writeFileSync(
      aFixture.nextMountTargets,
      JSON.stringify({ filesystems: [{ target: '/' }, { target: path.join(aFixture.directory, 'concurrent-mount') }] }),
    );
    writeFileSync(aFixture.volumeJson, JSON.stringify(aFixture.volumeItems));
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture, ['--neighbors-only']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('inventário de mounts mudou durante a auditoria');
  });

  it('aceita Config.User nomeado somente quando PID, proc e cgroup provam o container em execução', () => {
    const aFixture = fixture();
    const foreign = aFixture.items[3];
    foreign.Config.User = 'company-worker';
    foreign.State = { Running: true, Pid: 4242 };
    const processRoot = path.join(aFixture.procRoot, '4242');
    mkdirSync(processRoot);
    writeFileSync(
      path.join(processRoot, 'status'),
      'Name:\tworker\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\nGroups:\t1000\n',
    );
    writeFileSync(path.join(processRoot, 'cgroup'), '0::/docker/foreign-id\n');
    useInstalledPreflightTopology(aFixture);
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture, ['--neighbors-only']);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
  });

  it.each([
    [
      'container parado',
      (aFixture: ReturnType<typeof fixture>) => {
        aFixture.items[3].Config.User = 'company-worker';
        aFixture.items[3].State = { Running: false, Pid: 0 };
      },
      'container parado',
    ],
    [
      'ID apenas como prefixo no cgroup',
      (aFixture: ReturnType<typeof fixture>) => {
        aFixture.items[3].Config.User = 'company-worker';
        aFixture.items[3].State = { Running: true, Pid: 4242 };
        const processRoot = path.join(aFixture.procRoot, '4242');
        mkdirSync(processRoot);
        writeFileSync(
          path.join(processRoot, 'status'),
          'Uid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\nGroups:\t1000\n',
        );
        writeFileSync(path.join(processRoot, 'cgroup'), '0::/docker/foreign-id0\n');
      },
      'não pertence ao container',
    ],
  ] as const)('recusa Config.User nomeado sem prova exata: %s', (_label, arrange, message) => {
    const aFixture = fixture();
    arrange(aFixture);
    useInstalledPreflightTopology(aFixture);
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture, ['--neighbors-only']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
  });

  it('recusa Config.User numérico de vizinho que colide com o par privado', () => {
    const aFixture = fixture();
    aFixture.items[3].Config.User = `${PRIVATE_UID}:1000`;
    useInstalledPreflightTopology(aFixture);
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture, ['--neighbors-only']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('identidade runtime estrangeira colide');
  });

  it('recusa volume local disfarçado de bind sobre o storage privado', () => {
    const aFixture = fixture();
    aFixture.items[3].Mounts.push({
      Type: 'volume',
      Name: 'company-bind',
      Driver: 'local',
      Source: '/var/lib/docker/volumes/company-bind/_data',
      Destination: '/private',
      RW: true,
    });
    aFixture.volumeItems.push({
      Name: 'company-bind',
      Driver: 'local',
      Scope: 'local',
      Mountpoint: '/var/lib/docker/volumes/company-bind/_data',
      Options: { type: 'none', o: 'bind', device: aFixture.dataRoot },
    });
    writeFileSync(aFixture.volumeNames, 'company-data\ncompany-bind\n');
    writeFileSync(aFixture.volumeJson, JSON.stringify(aFixture.volumeItems));
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('release, configuração, runtime ou storage privado');
  });

  it('recusa volume estrangeiro em driver/plugin não permitido', () => {
    const aFixture = fixture();
    aFixture.items[3].Mounts.push({
      Type: 'volume',
      Name: 'company-plugin',
      Driver: 'local-persist',
      Source: '/var/lib/docker/plugins/company-plugin',
      Destination: '/plugin',
      RW: false,
    });
    aFixture.volumeItems.push({
      Name: 'company-plugin',
      Driver: 'local-persist',
      Scope: 'local',
      Mountpoint: '/var/lib/docker/plugins/company-plugin',
      Options: null,
    });
    writeFileSync(aFixture.volumeNames, 'company-data\ncompany-plugin\n');
    writeFileSync(aFixture.volumeJson, JSON.stringify(aFixture.volumeItems));
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('driver/plugin não permitido');
  });

  it('recusa bind dentro do DockerRootDir customizado', () => {
    const aFixture = fixture();
    aFixture.dockerRootDir = '/srv/company-docker';
    aFixture.items[3].Mounts.push({
      Type: 'bind',
      Source: '/srv/company-docker/containers',
      Destination: '/docker-state',
      RW: false,
    });
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('DockerRootDir efetivo');
  });

  it('canonicaliza symlink de bind antes de comparar com a release privada', () => {
    const aFixture = fixture();
    const aliasRoot = mkdtempSync(path.join(tmpdir(), 'kassinao-release-alias-'));
    const alias = path.join(aliasRoot, 'release');
    symlinkSync(aFixture.directory, alias);
    aFixture.items[3].Mounts.push({ Type: 'bind', Source: alias, Destination: '/release', RW: false });
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    try {
      const result = run(aFixture);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('release, configuração, runtime ou storage privado');
    } finally {
      rmSync(aliasRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ['/etc/kassinao', false, 'configuração privada'],
    ['/run/lock', true, 'pai do runtime'],
    ['/etc/systemd/system', true, 'units do host'],
    ['/etc/cron.d', true, 'execução root via cron'],
    ['/root/.ssh', true, 'credenciais SSH do root'],
    ['/root', false, 'home root legível'],
    ['/etc', false, 'pai de shadow'],
    ['/etc/shadow', false, 'hashes de senha'],
    ['/etc/systemd/system', false, 'units com credenciais inline'],
    ['/home', false, 'pai dos homes'],
    ['/home/company', false, 'home de usuário'],
    ['/home/company/.ssh/id_ed25519', false, 'chave SSH'],
    ['/home/company/.config', false, 'pai de credenciais XDG'],
    ['/home/company/.aws/credentials', false, 'credencial cloud'],
    ['/proc', false, 'processos do host'],
    ['/var/lib/cloud', false, 'cloud-init do host'],
    ['/usr/local/sbin', true, 'pai dos executáveis'],
    ['/usr/local/sbin/kassinao-company', true, 'prefixo reservado'],
  ] as const)('recusa bind vizinho sobre %s (%s)', (source, writable, _label) => {
    const aFixture = fixture();
    aFixture.items[3].Mounts.push({ Type: 'bind', Source: source, Destination: '/host-control', RW: writable });
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/privado|privilegiados|credenciais legíveis/);
  });

  it('recusa alias/pai do socket Docker e mount RW sobre controles privilegiados', () => {
    const socketFixture = fixture();
    socketFixture.items[3].Mounts.push({ Type: 'bind', Source: '/var/run', Destination: '/host-run', RW: false });
    writeFileSync(socketFixture.dockerJson, JSON.stringify(socketFixture.items));
    const socketResult = run(socketFixture);
    expect(socketResult.status).not.toBe(0);
    expect(socketResult.stderr).toContain('docker.sock');

    const controlsFixture = fixture();
    controlsFixture.items[3].Mounts.push({
      Type: 'bind',
      Source: '/etc/systemd/system',
      Destination: '/host-systemd',
      RW: true,
    });
    writeFileSync(controlsFixture.dockerJson, JSON.stringify(controlsFixture.items));
    const controlsResult = run(controlsFixture);
    expect(controlsResult.status).not.toBe(0);
    expect(controlsResult.stderr).toMatch(/controles privilegiados|credenciais legíveis/);
  });

  it('permite bind read-only alheio somente fora de credenciais e controles sensíveis', () => {
    const aFixture = fixture();
    aFixture.items[3].HostConfig.Binds = ['/srv/company-public:/public:ro'];
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
  });

  it('faz preflight dos vizinhos antes de existirem containers novos sem exigir egress ativo', () => {
    const aFixture = fixture({ hardenerFails: true });
    aFixture.items.splice(0, 3);
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));
    writeFileSync(aFixture.containerIds, 'foreign-id\n');

    const result = run(aFixture, ['--preflight']);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stdout).toContain('Preflight shared aprovado');
    const calls = readFileSync(aFixture.calls, 'utf8');
    expect(calls).toContain('storage:');
    expect(calls).not.toContain('rollback:');
    expect(calls).not.toContain('hardener:');
  });

  it('aceita no primeiro preflight policy owned antes de o Compose criar a topologia', () => {
    const aFixture = fixture();
    prepareAbsentPreflightTopology(aFixture);
    installOwnedPreflightFirewall(aFixture);

    const result = run(aFixture, ['--preflight']);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stdout).toContain('Preflight shared aprovado');
    const calls = readFileSync(aFixture.calls, 'utf8');
    expect(calls).toContain('storage:');
    expect(calls).toContain('hardener:--shared-host --check');
    expect(calls).not.toContain('rollback:');
  });

  it('recusa policy owned sem topologia fora da janela de primeiro preflight', () => {
    const aFixture = fixture({ storageFails: true });
    prepareAbsentPreflightTopology(aFixture);
    installOwnedPreflightFirewall(aFixture);

    const result = run(aFixture, ['--neighbors-only']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('estados incoerentes');
    const calls = readFileSync(aFixture.calls, 'utf8');
    expect(calls).toContain('hardener:--shared-host --check');
    expect(calls).not.toContain('storage:');
  });

  it('faz audit neighbors-only antes de storage ou hardener próprios existirem', () => {
    const aFixture = fixture({ storageFails: true, hardenerFails: true });
    aFixture.items.splice(0, 3);
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));
    writeFileSync(aFixture.containerIds, 'foreign-id\n');

    const result = run(aFixture, ['--neighbors-only']);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stdout).toContain('Audit neighbors-only aprovado');
    const calls = readFileSync(aFixture.calls, 'utf8');
    expect(calls).not.toContain('storage:');
    expect(calls).not.toContain('rollback:');
    expect(calls).not.toContain('hardener:');
    expect(calls).toContain('docker:inspect --format');
    expect(calls).toContain('foreign-id');
    expect(calls).toContain('docker:network inspect');
  });

  it('recusa no audit completo rollback inválido sem vazar detalhes privados', () => {
    const aFixture = fixture({ rollbackFails: true });
    const result = run(aFixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ciclo de vida do rollback plaintext está inválido ou expirado');
    expect(`${result.stdout}${result.stderr}`).not.toContain(aFixture.dataRoot);
    const calls = readFileSync(aFixture.calls, 'utf8');
    expect(calls).toContain('rollback:');
  });

  it.each([
    [
      'container vizinho privilegiado',
      (aFixture: ReturnType<typeof fixture>) => {
        aFixture.items.splice(0, 3);
        aFixture.items[0].HostConfig.Privileged = true;
        writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));
        writeFileSync(aFixture.containerIds, 'foreign-id\n');
      },
    ],
    [
      'bridge reservada estrangeira',
      (aFixture: ReturnType<typeof fixture>) => {
        aFixture.preflightNetworkItems.push({
          ...structuredClone(aFixture.networkItems[0]),
          Name: 'company_private',
          Labels: { 'com.docker.compose.project': 'company' },
        });
        writeFileSync(aFixture.preflightNetworkJson, JSON.stringify(aFixture.preflightNetworkItems));
      },
    ],
    [
      'interface Linux reservada',
      (aFixture: ReturnType<typeof fixture>) => {
        writeFileSync(
          aFixture.preflightLinksJson,
          JSON.stringify([
            { ifname: 'lo', linkinfo: {} },
            { ifname: 'kas-public0', linkinfo: { info_kind: 'bridge' } },
          ]),
        );
      },
    ],
    [
      'chain KASSINAO-* reservada',
      (aFixture: ReturnType<typeof fixture>) => {
        writeFileSync(aFixture.preflightIpv6Rules, firewallInventory(['KASSINAO-HOST']));
      },
    ],
  ])('neighbors-only mantém o gate de %s', (name, arrange) => {
    const aFixture = fixture({ storageFails: true });
    arrange(aFixture);

    const result = run(aFixture, ['--neighbors-only']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('inventário Docker viola o contrato do adapter shared');
    const calls = readFileSync(aFixture.calls, 'utf8');
    expect(calls).not.toContain('storage:');
    if (name.includes('chain')) {
      expect(calls).toContain('hardener:--shared-host --check');
    } else {
      expect(calls).not.toContain('hardener:');
    }
  });

  it.each([
    ['--preflight', true],
    ['--neighbors-only', false],
  ] as const)('aceita upgrade com topologia oficial completa em %s', (mode, checksStorage) => {
    const aFixture = fixture({ storageFails: !checksStorage });
    useInstalledPreflightTopology(aFixture);

    const result = run(aFixture, [mode]);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const calls = readFileSync(aFixture.calls, 'utf8');
    expect(calls).toContain('hardener:--shared-host --check');
    if (checksStorage) {
      expect(calls).toContain('storage:');
    } else {
      expect(calls).not.toContain('storage:');
    }
  });

  it('preflight aceita transição A→B somente com digest anterior pinned e Config.Env coerente', () => {
    const aFixture = fixture();
    useInstalledPreflightTopology(aFixture);
    const nextImage = `ghcr.io/resolvicomai/kassinao@sha256:${'9'.repeat(64)}`;
    const envFile = path.join(aFixture.directory, '.env');
    writeFileSync(
      envFile,
      readFileSync(envFile, 'utf8').replace(`KASSINAO_IMAGE=${IMAGE}`, `KASSINAO_IMAGE=${nextImage}`),
    );

    const transition = run(aFixture, ['--preflight']);
    expect(transition.status, `${transition.stderr}\n${transition.stdout}`).toBe(0);

    const strictCurrent = run(aFixture, ['--preflight', '--require-current-images']);
    expect(strictCurrent.status).not.toBe(0);
    expect(strictCurrent.stderr).toContain('inventário Docker viola o contrato do adapter shared');
  });

  it.each([
    [
      'tag mutável',
      (item: DockerItem) => {
        item.Config.Image = 'ghcr.io/resolvicomai/kassinao:latest';
      },
    ],
    [
      'release digest inconsistente em Config.Env',
      (item: DockerItem) => {
        const index = item.Config.Env.findIndex((entry: string) => entry.startsWith('KASSINAO_RELEASE_DIGEST='));
        item.Config.Env[index] = `KASSINAO_RELEASE_DIGEST=sha256:${'9'.repeat(64)}`;
      },
    ],
  ] as const)('preflight de transição recusa imagem anterior com %s', (_label, mutate) => {
    const aFixture = fixture();
    useInstalledPreflightTopology(aFixture);
    const envFile = path.join(aFixture.directory, '.env');
    const nextImage = `ghcr.io/resolvicomai/kassinao@sha256:${'9'.repeat(64)}`;
    writeFileSync(
      envFile,
      readFileSync(envFile, 'utf8').replace(`KASSINAO_IMAGE=${IMAGE}`, `KASSINAO_IMAGE=${nextImage}`),
    );
    mutate(aFixture.items[0]);
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture, ['--preflight']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('inventário Docker viola o contrato do adapter shared');
  });

  it('aceita no preflight containers oficiais parados quando o contrato estático permanece íntegro', () => {
    const aFixture = fixture();
    useInstalledPreflightTopology(aFixture);
    for (const item of aFixture.items.slice(0, 3)) item.State = { Running: false };
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture, ['--preflight']);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stdout).toContain('Preflight shared aprovado');
  });

  it.each([
    ['segredo em Config.Env', (item: DockerItem) => item.Config.Env.push('DISCORD_TOKEN=nao-pode-estar-aqui')],
    [
      'bind mount extra',
      (item: DockerItem) => item.Mounts.push({ Type: 'bind', Source: '/etc', Destination: '/host-etc', RW: false }),
    ],
    ['privileged', (item: DockerItem) => (item.HostConfig.Privileged = true)],
    ['capability adicionada', (item: DockerItem) => (item.HostConfig.CapAdd = ['SYS_ADMIN'])],
    ['ulimit core removido', (item: DockerItem) => (item.HostConfig.Ulimits = [])],
    [
      'imagem divergente',
      (item: DockerItem) => (item.Config.Image = `ghcr.io/resolvicomai/kassinao@sha256:${'f'.repeat(64)}`),
    ],
  ] as const)('preflight recusa container parado com drift estático: %s', (_label, mutate) => {
    const aFixture = fixture();
    useInstalledPreflightTopology(aFixture);
    for (const item of aFixture.items.slice(0, 3)) item.State = { Running: false };
    mutate(aFixture.items[0]);
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture, ['--preflight']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('inventário Docker viola o contrato do adapter shared');
  });

  it('neighbors-only não ignora container oficial que ganhou bind extra para o segredo da aplicação', () => {
    const aFixture = fixture({ storageFails: true });
    useInstalledPreflightTopology(aFixture);
    aFixture.items[0].Mounts.push({
      Type: 'bind',
      Source: `${aFixture.dataRoot}/config/app.env`,
      Destination: '/tmp/app-secret',
      RW: false,
    });
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture, ['--neighbors-only']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('inventário Docker viola o contrato do adapter shared');
    expect(readFileSync(aFixture.calls, 'utf8')).not.toContain('storage:');
  });

  it('aceita no preflight somente o túnel oficial desabilitado, parado e com restart=no', () => {
    const aFixture = fixture();
    disableTunnelProfile(aFixture);
    useInstalledPreflightTopology(aFixture);
    aFixture.items[2].State = { Running: false };
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture, ['--preflight']);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stdout).toContain('Preflight shared aprovado');
  });

  it.each([
    [
      'em execução',
      (item: DockerItem) => {
        item.State = { Running: true };
      },
    ],
    [
      'com restart autônomo',
      (item: DockerItem) => {
        item.State = { Running: false };
        item.HostConfig.RestartPolicy.Name = 'unless-stopped';
      },
    ],
    [
      'com project label estrangeira',
      (item: DockerItem) => {
        item.State = { Running: false };
        item.Config.Labels['com.docker.compose.project'] = 'company';
      },
    ],
    [
      'com service label desconhecida',
      (item: DockerItem) => {
        item.State = { Running: false };
        item.Config.Labels['com.docker.compose.service'] = 'company-tunnel';
      },
    ],
  ] as const)('recusa no preflight serviço desabilitado %s', (_name, mutate) => {
    const aFixture = fixture();
    disableTunnelProfile(aFixture);
    useInstalledPreflightTopology(aFixture);
    mutate(aFixture.items[2]);
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture, ['--preflight']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('inventário Docker viola o contrato do adapter shared');
  });

  it.each([
    ['audit full', []],
    ['neighbors-only', ['--neighbors-only']],
  ] as const)('não tolera serviço de profile desabilitado fora do preflight: %s', (_name, args) => {
    const aFixture = fixture();
    disableTunnelProfile(aFixture);
    useInstalledPreflightTopology(aFixture);
    aFixture.items[2].State = { Running: false };
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture, [...args]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('inventário Docker viola o contrato do adapter shared');
  });

  it('recusa upgrade quando o inventário das chains parece próprio mas o hardener diverge', () => {
    const aFixture = fixture({ storageFails: true, hardenerFails: true });
    useInstalledPreflightTopology(aFixture);

    const result = run(aFixture, ['--neighbors-only']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('policy de egress da kas-private0 está ausente ou divergente');
  });

  it('com zero containers ainda inventaria e recusa rede reservada estrangeira', () => {
    const aFixture = fixture({ hardenerFails: true });
    aFixture.items.splice(0);
    writeFileSync(aFixture.dockerJson, '[]');
    writeFileSync(aFixture.containerIds, '');
    aFixture.preflightNetworkItems.push({
      ...structuredClone(aFixture.networkItems[0]),
      Name: 'company_private',
      Labels: { 'com.docker.compose.project': 'company' },
    });
    writeFileSync(aFixture.preflightNetworkJson, JSON.stringify(aFixture.preflightNetworkItems));

    const result = run(aFixture, ['--preflight']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('bridge reservada');
    const calls = readFileSync(aFixture.calls, 'utf8');
    expect(calls).toContain('docker:network ls -q --no-trunc');
    expect(calls).toContain('docker:network inspect');
    expect(calls).not.toMatch(/^docker:inspect\b/m);
  });

  it('no preflight recusa topologia com apenas uma interface Linux reservada', () => {
    const aFixture = fixture();
    writeFileSync(
      aFixture.preflightLinksJson,
      JSON.stringify([
        { ifname: 'lo', linkinfo: {} },
        { ifname: 'kas-private0', linkinfo: { info_kind: 'bridge' } },
      ]),
    );

    const result = run(aFixture, ['--preflight']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('interfaces/redes reservadas estão em estado parcial ou estranho');
  });

  it.each([
    ['IPv4', 'preflightIpv4Rules'],
    ['IPv6', 'preflightIpv6Rules'],
  ] as const)('no preflight recusa chain KASSINAO-* parcial em %s', (family, rulesFile) => {
    const aFixture = fixture();
    writeFileSync(aFixture[rulesFile], firewallInventory(['KASSINAO-EGRESS']));

    const result = run(aFixture, ['--preflight']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`chains reservadas KASSINAO-* ausentes ou divergentes em ${family}`);
  });

  it.each([
    ['ausente', []],
    ['atrás de regra alheia', ['-A FORWARD -j COMPANY', '-A FORWARD -j DOCKER-USER']],
    ['duplicado', ['-A FORWARD -j DOCKER-USER', '-A FORWARD -j DOCKER-USER']],
  ])('recusa hook global DOCKER-USER %s antes do preflight', (_label, rules) => {
    const aFixture = fixture();
    writeFileSync(aFixture.preflightIpv4Rules, firewallInventory([], rules));

    const result = run(aFixture, ['--preflight']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('o adapter não altera o hook global');
    expect(existsSync(aFixture.calls)).toBe(false);
  });

  it.each([
    [
      'ausente',
      [
        { ifname: 'lo', linkinfo: {} },
        { ifname: 'kas-private0', linkinfo: { info_kind: 'bridge' } },
      ],
      'interfaces/redes reservadas do projeto estão ausentes ou divergentes',
    ],
    [
      'de tipo divergente',
      [
        { ifname: 'lo', linkinfo: {} },
        { ifname: 'kas-private0', linkinfo: { info_kind: 'bridge' } },
        { ifname: 'kas-public0', linkinfo: { info_kind: 'dummy' } },
      ],
      'interface reservada kas-public0 não é bridge própria',
    ],
  ])('no audit full recusa interface reservada %s', (_name, links, message) => {
    const aFixture = fixture();
    writeFileSync(aFixture.linksJson, JSON.stringify(links));

    const result = run(aFixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
  });

  it.each([
    ['ausente', RESERVED_CHAINS.slice(0, -1)],
    ['estranha', [...RESERVED_CHAINS, 'KASSINAO-FOREIGN']],
  ])('no audit full recusa chain reservada %s', (_name, chains) => {
    const aFixture = fixture();
    writeFileSync(aFixture.ipv4Rules, firewallInventory(chains));

    const result = run(aFixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('chains reservadas KASSINAO-* ausentes ou divergentes em IPv4');
  });

  it.each([
    ['storage sem prova', { storageFails: true }, 'storage shared'],
    ['egress divergente', { hardenerFails: true }, 'policy de egress'],
    ['execução não-root', { uid: 1000 }, 'como root'],
  ])('falha fechado em %s', (_name, options, message) => {
    const result = run(fixture(options));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
  });

  it.each([
    ['rede do projeto', (item: DockerItem) => (item.NetworkSettings.Networks.kassinao_private = {})],
    ['privileged', (item: DockerItem) => (item.HostConfig.Privileged = true)],
    ['docker.sock', (item: DockerItem) => item.Mounts.push({ Source: '/var/run/docker.sock', Destination: '/sock' })],
    ['host network', (item: DockerItem) => (item.HostConfig.NetworkMode = 'host')],
    ['host pid', (item: DockerItem) => (item.HostConfig.PidMode = 'host')],
    ['host ipc', (item: DockerItem) => (item.HostConfig.IpcMode = 'host')],
    ['SYS_ADMIN', (item: DockerItem) => (item.HostConfig.CapAdd = ['SYS_ADMIN'])],
    ['NET_ADMIN', (item: DockerItem) => (item.HostConfig.CapAdd = ['NET_ADMIN'])],
    ['NET_RAW', (item: DockerItem) => (item.HostConfig.CapAdd = ['NET_RAW'])],
    ['container network', (item: DockerItem) => (item.HostConfig.NetworkMode = 'container:kassinao')],
    ['container pid', (item: DockerItem) => (item.HostConfig.PidMode = 'container:kassinao')],
    ['device mapper', (item: DockerItem) => (item.HostConfig.Devices = [{ PathOnHost: '/dev/mapper/kassinao' }])],
    ['device rule', (item: DockerItem) => (item.HostConfig.DeviceCgroupRules = ['b 253:* r'])],
    ['volumes-from', (item: DockerItem) => (item.HostConfig.VolumesFrom = ['kassinao:ro'])],
    [
      'mount de device',
      (item: DockerItem) => item.Mounts.push({ Type: 'bind', Source: '/dev/mapper/kassinao', Destination: '/disk' }),
    ],
  ])('recusa vizinho estrangeiro com %s', (_name, mutate) => {
    const aFixture = fixture();
    mutate(aFixture.items[3]);
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));
    const result = run(aFixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('inventário Docker viola');
  });

  it('recusa colisão de project label antes de qualquer mutação shared', () => {
    const aFixture = fixture();
    aFixture.items[3].Config.Labels = {
      'com.docker.compose.project': 'kassinao',
      'com.docker.compose.service': 'company-app',
    };
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture, ['--preflight']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('inventário Docker viola');
  });

  it('recusa bridge reservada que pertence a workload vizinho', () => {
    const aFixture = fixture();
    aFixture.preflightNetworkItems.push({
      ...structuredClone(aFixture.networkItems[0]),
      Name: 'company_private',
      Labels: { 'com.docker.compose.project': 'company' },
    });
    writeFileSync(aFixture.preflightNetworkJson, JSON.stringify(aFixture.preflightNetworkItems));

    const result = run(aFixture, ['--preflight']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('bridge reservada');
  });

  it.each([
    [
      'label de projeto da rede privada',
      (aFixture: ReturnType<typeof fixture>) =>
        (aFixture.networkItems[0].Labels['com.docker.compose.project'] = 'company'),
    ],
    [
      'label lógico da rede pública',
      (aFixture: ReturnType<typeof fixture>) =>
        (aFixture.networkItems[1].Labels['com.docker.compose.network'] = 'external'),
    ],
    ['Internal da rede pública', (aFixture: ReturnType<typeof fixture>) => (aFixture.networkItems[1].Internal = false)],
    [
      'gateway IPv4 da rede pública',
      (aFixture: ReturnType<typeof fixture>) =>
        (aFixture.networkItems[1].Options['com.docker.network.bridge.gateway_mode_ipv4'] = 'nat'),
    ],
    [
      'gateway IPv6 da rede pública',
      (aFixture: ReturnType<typeof fixture>) =>
        delete aFixture.networkItems[1].Options['com.docker.network.bridge.gateway_mode_ipv6'],
    ],
    ['Internal da rede privada', (aFixture: ReturnType<typeof fixture>) => (aFixture.networkItems[0].Internal = true)],
  ] as const)('recusa drift de ownership/policy de rede: %s', (_label, mutate) => {
    const aFixture = fixture();
    mutate(aFixture);
    writeFileSync(aFixture.networkJson, JSON.stringify(aFixture.networkItems));

    const result = run(aFixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/bridge reservada|rede privada reservada|rede pública reservada/);
  });

  it('não consulta nem materializa campos secretos de workloads vizinhos', () => {
    const aFixture = fixture();
    const sentinel = 'FOREIGN_SECRET_SENTINEL_7ff3c417';
    const foreign = aFixture.items[3];
    foreign.Config.Env = [`TOKEN=${sentinel}`];
    foreign.Config.Entrypoint = ['/bin/company', sentinel];
    foreign.Config.Cmd = ['--token', sentinel];
    foreign.Config.Labels['company.secret'] = sentinel;
    foreign.HostConfig.LogConfig = { Type: 'splunk', Config: { 'splunk-token': sentinel } };
    foreign.State = { Running: true, Health: { Status: 'unhealthy', Log: [{ Output: sentinel }] } };
    aFixture.networkItems[2].Options['company.secret'] = sentinel;
    aFixture.networkItems[2].Labels['company.secret'] = sentinel;
    aFixture.networkItems[2].Containers = {
      'foreign-id': { Name: 'company-app', EndpointID: 'endpoint', IPv4Address: '172.20.0.2/16', Secret: sentinel },
    };
    aFixture.volumeItems.push({
      Name: 'unused-secret-volume',
      Driver: 'local',
      Scope: 'local',
      Mountpoint: '/var/lib/docker/volumes/unused-secret-volume/_data',
      Options: { type: 'cifs', o: `password=${sentinel}`, device: '//files/share' },
    });
    writeFileSync(aFixture.containerIds, 'kassinao-id\nkassinao-public-id\ncloudflared-id\nforeign-id\n');
    writeFileSync(aFixture.volumeNames, 'company-data\nunused-secret-volume\n');
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));
    writeFileSync(aFixture.networkJson, JSON.stringify(aFixture.networkItems));
    writeFileSync(aFixture.volumeJson, JSON.stringify(aFixture.volumeItems));

    const result = run(aFixture);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const calls = readFileSync(aFixture.calls, 'utf8');
    expect(`${result.stdout}${result.stderr}${calls}`).not.toContain(sentinel);
    const inspectCalls = calls.split('\n').filter((line) => line.startsWith('docker:inspect --format'));
    const baseCall = inspectCalls.find((line) => line.includes('NetworkAttachments')) ?? '';
    const privateCall = inspectCalls.find((line) => line.includes('LogConfig')) ?? '';
    expect(baseCall).toContain('foreign-id');
    expect(baseCall).not.toMatch(/\.Config\.(Env|Cmd|Entrypoint)|\.State\.Health|\.HostConfig\.LogConfig/);
    expect(privateCall).not.toContain('foreign-id');
    const networkCall = calls.split('\n').find((line) => line.startsWith('docker:network inspect --format')) ?? '';
    const volumeCall = calls.split('\n').find((line) => line.startsWith('docker:volume inspect --format')) ?? '';
    expect(networkCall).not.toMatch(/json \.Options|json \.Labels/);
    expect(volumeCall).not.toContain('.Options.o');
  });

  it.each([
    ['DATA_ROOT exato', (aFixture: ReturnType<typeof fixture>) => aFixture.dataRoot],
    ['pai de DATA_ROOT', (aFixture: ReturnType<typeof fixture>) => path.dirname(aFixture.dataRoot)],
    ['backing LUKS', (aFixture: ReturnType<typeof fixture>) => aFixture.backingFile],
  ])('recusa vizinho estrangeiro com bind sobre %s', (_name, source) => {
    const aFixture = fixture();
    aFixture.items[3].Mounts.push({ Type: 'bind', Source: source(aFixture), Destination: '/private' });
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('inventário Docker viola');
  });

  it.each([
    ['digest móvel', (item: DockerItem) => (item.Config.Image = 'ghcr.io/resolvicomai/kassinao:latest')],
    [
      'mount extra',
      (item: DockerItem) => item.Mounts.push({ Type: 'bind', Source: '/tmp', Destination: '/extra', RW: true }),
    ],
    ['porta pública', (item: DockerItem) => (item.HostConfig.PortBindings['8080/tcp'][0].HostIp = '0.0.0.0')],
    ['capability', (item: DockerItem) => (item.HostConfig.CapAdd = ['NET_RAW'])],
    ['sem no-new-privileges', (item: DockerItem) => (item.HostConfig.SecurityOpt = [])],
    ['swap maior', (item: DockerItem) => (item.HostConfig.MemorySwap *= 2)],
    ['swappiness', (item: DockerItem) => (item.HostConfig.MemorySwappiness = 60)],
    ['restart autônomo', (item: DockerItem) => (item.HostConfig.RestartPolicy.Name = 'unless-stopped')],
    ['rede extra', (item: DockerItem) => (item.NetworkSettings.Networks.company_default = {})],
    ['segredo em Config.Env', (item: DockerItem) => item.Config.Env.push('DISCORD_TOKEN=nao-pode-persistir')],
  ])('recusa container Kassinão com %s', (_name, mutate) => {
    const aFixture = fixture();
    mutate(aFixture.items[0]);
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));
    const result = run(aFixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('inventário Docker viola');
  });

  it('aceita MemorySwappiness null do Docker 29 sob limite efetivo sem swap', () => {
    const aFixture = fixture();
    for (const item of aFixture.items.slice(0, 3)) item.HostConfig.MemorySwappiness = null;
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
  });

  it('recusa MemorySwappiness null quando MemorySwap deixa swap disponível', () => {
    const aFixture = fixture();
    aFixture.items[0].HostConfig.MemorySwappiness = null;
    aFixture.items[0].HostConfig.MemorySwap *= 2;
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Memory/MemorySwap divergem');
  });

  it.each([
    ['memória ilimitada', 'unlimited', 'unlimited é proibido'],
    ['memória 100G', '100g', 'reservam menos de 25% da memória física'],
  ])('recusa %s no compose.env', (_label, value, expectedError) => {
    const aFixture = fixture();
    replaceEnvValue(aFixture, 'KASSINAO_CORE_MEMORY_LIMIT', value);

    const result = run(aFixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(expectedError);
  });

  it('recusa soma de CPU que deixa menos de 25% para workloads vizinhos', () => {
    const aFixture = fixture();
    replaceEnvValue(aFixture, 'KASSINAO_CORE_CPUS', '1.2');

    const result = run(aFixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('reservam menos de 25% das CPUs online');
  });

  it('recusa limites incompatíveis com a capacidade física de RAM do host', () => {
    const aFixture = fixture();
    writeFileSync(aFixture.meminfo, 'MemTotal:        3145728 kB\n');

    const result = run(aFixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('reservam menos de 25% da memória física');
  });

  it.each([
    ['Memory', (item: DockerItem) => (item.HostConfig.Memory += 1024 ** 2), 'Memory/MemorySwap divergem'],
    ['NanoCpus', (item: DockerItem) => (item.HostConfig.NanoCpus += 1_000_000), 'NanoCpus diverge'],
  ])('recusa divergência runtime em %s', (_field, mutate, expectedError) => {
    const aFixture = fixture();
    mutate(aFixture.items[0]);
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(expectedError);
  });

  it('recusa imagem cloudflared diferente do digest selado', () => {
    const aFixture = fixture();
    aFixture.items[2].Config.Image = `cloudflare/cloudflared:2026.7.1@sha256:${'c'.repeat(64)}`;
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('inventário Docker viola');
  });

  it('recusa token Cloudflare persistido no Config.Env', () => {
    const aFixture = fixture();
    aFixture.items[2].Config.Env.push('TUNNEL_TOKEN=nao-pode-persistir');
    writeFileSync(aFixture.dockerJson, JSON.stringify(aFixture.items));

    const result = run(aFixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('inventário Docker viola');
  });

  it('recusa qualquer configuração Docker herdada antes de consultar o daemon', () => {
    const aFixture = fixture();
    const result = spawnSync('bash', [aFixture.auditor], {
      cwd: aFixture.directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${aFixture.bin}:${process.env.PATH ?? ''}`,
        DOCKER_FIXTURE_JSON: aFixture.dockerJson,
        DOCKER_NETWORK_FIXTURE_JSON: aFixture.networkJson,
        DOCKER_HOST: 'tcp://attacker.invalid:2375',
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('DOCKER_HOST não pode vir do ambiente');
  });
});
