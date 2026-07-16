import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertPublicRuntimeEnvironment,
  privateRuntimeEnvironmentKeys,
  PUBLIC_RUNTIME_ENV,
} from '../src/publicRuntime';

const ROOT = path.resolve(import.meta.dirname, '..');
const temporaryDirectories: string[] = [];

function repositoryFile(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function serviceBlock(compose: string, service: string): string {
  const marker = `  ${service}:\n`;
  const start = compose.indexOf(marker);
  if (start < 0) throw new Error(`serviço ${service} não encontrado no Compose`);
  const bodyStart = start + marker.length;
  const rest = compose.slice(bodyStart);
  const nextService = rest.search(/^  [A-Za-z0-9_.-]+:\s*$/m);
  const nextSection = rest.search(/^(?:volumes|networks):\s*$/m);
  const ends = [nextService, nextSection].filter((value) => value >= 0);
  const end = ends.length > 0 ? Math.min(...ends) : rest.length;
  return rest.slice(0, end);
}

function activeEnvironment(source: string): Map<string, string> {
  return new Map(
    [...source.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((match) => [match[1], match[2].trim()] as const),
  );
}

function makeTempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'kassinao-distribution-'));
  temporaryDirectories.push(directory);
  return directory;
}

function makeNativeRuntimeFixture(): string {
  const root = makeTempDir();
  for (const [architecture, machine] of [
    ['amd64', 62],
    ['arm64', 183],
  ] as const) {
    const directory = path.join(root, `linux-${architecture}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const [name, elfType, mode] of [
      ['kassinao-no-dump', 2, 0o555],
      ['libkassinao-no-dump.so', 3, 0o444],
    ] as const) {
      const elf = Buffer.alloc(64);
      elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
      elf.writeUInt16LE(elfType, 16);
      elf.writeUInt16LE(machine, 18);
      elf.writeUInt32LE(1, 20);
      elf.writeUInt16LE(64, 52);
      elf.writeUInt16LE(56, 54);
      writeFileSync(path.join(directory, name), elf, { mode });
      chmodSync(path.join(directory, name), mode);
    }
  }
  return root;
}

function makeStorageTempDir(): string {
  // Linux usa /tmp por padrão, mas esse caminho precisa continuar inválido para
  // os serviços de produção protegidos por PrivateTmp.
  const configuredRoot = process.env.KASSINAO_TEST_STORAGE_ROOT?.trim();
  const root = realpathSync(configuredRoot || tmpdir());
  const directory = realpathSync(mkdtempSync(path.join(root, 'kassinao-storage-')));
  temporaryDirectories.push(directory);
  return directory;
}

function writePrivateFile(file: string, contents: string): void {
  writeFileSync(file, contents, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function replaceEnvironmentValue(file: string, key: string, value: string): void {
  const source = readFileSync(file, 'utf8');
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (!pattern.test(source)) throw new Error(`${key} não existe em ${file}`);
  writePrivateFile(file, source.replace(pattern, `${key}=${value}`));
}

interface StoragePreparationFixture {
  directory: string;
  script: string;
  dataRoot: string;
  children: string[];
  bin: string;
  verifierLog: string;
  mutationLog: string;
  uid: number;
  gid: number;
}

function storagePreparationFixture(
  options: {
    verifierFails?: boolean;
    reportedUid?: number;
    badBundleOwnership?: boolean;
  } = {},
): StoragePreparationFixture {
  const directory = makeStorageTempDir();
  chmodSync(directory, 0o700);
  const scripts = path.join(directory, 'scripts');
  mkdirSync(scripts, { mode: 0o700 });
  const bin = path.join(directory, 'bin');
  mkdirSync(bin, { mode: 0o700 });
  const script = path.join(scripts, 'prepare-storage.sh');
  const verifier = path.join(scripts, 'verify-storage-encryption.sh');
  const inheritedEnvironment = path.join(directory, 'inherited-storage-environment.bin');
  writeFileSync(
    inheritedEnvironment,
    Buffer.from(
      Object.keys(process.env)
        .map((name) => `${name}=fixture\0`)
        .join(''),
    ),
  );
  const prepareSource = repositoryFile('scripts/prepare-storage.sh')
    .replaceAll('/proc/$$/environ', inheritedEnvironment)
    .replace(
      'export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LC_ALL=C',
      `export PATH=${bin}:/usr/local/bin:/usr/bin:/bin HOME=/root LC_ALL=C`,
    )
    .replace(
      /# KASSINAO_HOST_NO_DUMP_BEGIN[\s\S]*?# KASSINAO_HOST_NO_DUMP_END/,
      '# KASSINAO_HOST_NO_DUMP_BEGIN\nunset LD_PRELOAD\n# KASSINAO_HOST_NO_DUMP_END',
    );
  writeFileSync(script, prepareSource, { mode: 0o755 });
  chmodSync(script, 0o755);

  const verifierLog = path.join(directory, 'verifier.log');
  writeFileSync(
    verifier,
    `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${shellLiteral(verifierLog)}
exit ${options.verifierFails ? '1' : '0'}
`,
    { mode: 0o755 },
  );
  chmodSync(verifier, 0o755);

  const manifestEntries = ['scripts/prepare-storage.sh', 'scripts/verify-storage-encryption.sh'].map((name) => {
    const bytes = readFileSync(path.join(directory, name));
    return `${createHash('sha256').update(bytes).digest('hex')}  ${name}`;
  });
  writeFileSync(path.join(directory, 'MANIFEST.sha256'), `${manifestEntries.join('\n')}\n`, { mode: 0o600 });

  const dataRoot = path.join(directory, 'encrypted-data');
  mkdirSync(dataRoot, { mode: 0o700 });
  chmodSync(dataRoot, 0o700);
  const children = ['recordings', 'state', 'auth', 'cache'].map((name) => path.join(dataRoot, name));
  const uid = (process.getuid?.() ?? 1000) || 1001;
  const gid = (process.getgid?.() ?? 1000) || 1001;
  writePrivateFile(
    path.join(directory, '.env'),
    [
      `KASSINAO_DATA_ROOT=${dataRoot}`,
      `KASSINAO_RECORDINGS_DIR=${children[0]}`,
      `KASSINAO_STATE_DIR=${children[1]}`,
      `KASSINAO_AUTH_DIR=${children[2]}`,
      `KASSINAO_MODEL_CACHE_DIR=${children[3]}`,
      `KASSINAO_UID=${uid}`,
      `KASSINAO_GID=${gid}`,
      'DISCORD_TOKEN=this-value-must-never-be-evaluated',
      '',
    ].join('\n'),
  );

  const mutationLog = path.join(directory, 'mutations.log');
  writeFileSync(
    path.join(bin, 'id'),
    `#!/usr/bin/env bash
[ "\${1:-}" = -u ] || exit 2
printf '%s\n' ${options.reportedUid ?? 0}
`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(bin, 'stat'),
    `#!/usr/bin/env bash
set -eu
target="\${!#}"
case "$target" in
  ${shellLiteral(path.join(directory, '.env'))}) printf '600:0:0\n' ;;
  ${shellLiteral(dataRoot)}) printf '700:0:0\n' ;;
  ${shellLiteral(dataRoot)}/*)
    [ -d "$target" ] || exit 1
    printf '700:${uid}:${gid}\n'
    ;;
  ${shellLiteral(verifier)})
    printf '${options.badBundleOwnership ? '755:1000:1000' : '755:0:0'}\n'
    ;;
  *)
    [ -d "$target" ] && printf '700:0:0\n' || printf '600:0:0\n'
    ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(bin, 'chown'),
    `#!/usr/bin/env bash
printf 'chown:%s\n' "$*" >> ${shellLiteral(mutationLog)}
exit 0
`,
    { mode: 0o755 },
  );
  for (const command of ['id', 'stat', 'chown']) chmodSync(path.join(bin, command), 0o755);

  return { directory, script, dataRoot, children, bin, verifierLog, mutationLog, uid, gid };
}

function bootstrapFixture(): { directory: string; script: string; appEnv: string; composeEnv: string } {
  const directory = realpathSync(makeTempDir());
  chmodSync(directory, 0o700);
  const scripts = path.join(directory, 'scripts');
  mkdirSync(scripts, { mode: 0o700 });
  const script = path.join(scripts, 'inject-secrets.sh');
  const inheritedEnvironment = path.join(directory, 'inherited-environment.bin');
  writeFileSync(
    inheritedEnvironment,
    Buffer.from(
      [...new Set([...Object.keys(process.env), 'PATH', 'HOME', 'KASSINAO_APP_ENV_FILE', 'KASSINAO_COMPOSE_ENV_FILE'])]
        .map((name) => `${name}=fixture\0`)
        .join(''),
    ),
  );
  const injectorSource = repositoryFile('scripts/inject-secrets.sh')
    .replaceAll('/proc/$$/environ', inheritedEnvironment)
    .replace(
      'SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      'SAFE_SYSTEM_PATH=/usr/local/bin:/usr/bin:/bin',
    )
    .replace(
      /# KASSINAO_HOST_NO_DUMP_BEGIN[\s\S]*?# KASSINAO_HOST_NO_DUMP_END/,
      '# KASSINAO_HOST_NO_DUMP_BEGIN\nunset LD_PRELOAD\n# KASSINAO_HOST_NO_DUMP_END',
    );
  writeFileSync(script, injectorSource, { mode: 0o700 });
  chmodSync(script, 0o700);
  const appEnv = path.join(directory, 'app.env');
  const composeEnv = path.join(directory, '.env');
  writePrivateFile(
    appEnv,
    [
      'DISCORD_TOKEN=',
      'APPLICATION_ID=',
      'DISCORD_CLIENT_SECRET=',
      'APP_URL=',
      'BASE_URL=https://stale-instance.example',
      'MCP_URL=',
      'PUBLIC_URL=',
      'DOCS_URL=',
      'SOURCE_URL=',
      'OPERATOR_NAME=',
      'OPERATOR_CONTACT_URL=',
      'PRIVACY_POLICY_URL=',
      'DATA_DELETION_URL=',
      'TERMS_OF_SERVICE_URL=',
      'KASSINAO_ROLLBACK_RETENTION_HOURS=72',
      'ALLOW_ALL_GUILDS=false',
      'ALLOWED_GUILD_IDS=',
      'PUBLIC_SURFACES_ENABLED=false',
      '',
    ].join('\n'),
  );
  writePrivateFile(
    composeEnv,
    [
      'KASSINAO_IMAGE=ghcr.io/example/kassinao@sha256:' + 'f'.repeat(64),
      'KASSINAO_APP_ENV_FILE=app.env',
      'KASSINAO_DEPLOYMENT_MODE=split',
      'KASSINAO_HOST_SCOPE=dedicated',
      'KASSINAO_DEDICATED_DOCKER_HOST_ACK=I_UNDERSTAND_THIS_VPS_MUST_RUN_ONLY_KASSINAO',
      'KASSINAO_ROLLBACK_RETENTION_HOURS=72',
      'APP_URL=',
      'MCP_URL=',
      'PUBLIC_URL=',
      'DOCS_URL=',
      'SOURCE_URL=',
      'COMPOSE_PROFILES=',
      'TUNNEL_TOKEN=',
      '',
    ].join('\n'),
  );
  return { directory, script, appEnv, composeEnv };
}

interface DeploymentFixtureOptions {
  mutateNormalizedConfig?: (config: Record<string, unknown>) => void;
  initiallyRunning?: boolean;
  mode?: 'single' | 'split';
  hostScope?: 'dedicated' | 'shared';
  egressActive?: boolean;
  hardenerCheckFails?: boolean;
  hardenerPreloadFails?: boolean;
  sharedAuditPreflightFails?: boolean;
  sharedAuditFullFails?: boolean;
  sharedAuditRejectsStoppedContainer?: boolean;
  rollbackCheckerFails?: boolean;
  snapshotNestedMount?: boolean;
  snapshotTarFails?: boolean;
  storageVerifierFails?: boolean;
  staleDisabledTunnel?: 'safe' | 'running' | 'restart-policy' | 'foreign-project';
  upFails?: boolean;
  failureNameSquatter?: boolean;
  runtimeMemory?: number;
  runtimeMemorySwap?: number;
  runtimeMemorySwappiness?: number | null;
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function fakeRuntime(
  directory: string,
  image: string,
  digest: string,
  normalizedConfig: Record<string, unknown>,
  initiallyRunning = false,
  egressActive = true,
  upFails = false,
  staleDisabledTunnel?: DeploymentFixtureOptions['staleDisabledTunnel'],
  failureNameSquatter = false,
  snapshotNestedMount = false,
  snapshotFailsAfterStop = false,
  runtimeMemory = 536_870_912,
  runtimeMemorySwap = runtimeMemory,
  runtimeMemorySwappiness: number | null = 0,
): { bin: string; log: string } {
  const bin = path.join(directory, 'bin');
  const log = path.join(directory, 'docker.log');
  const running = path.join(directory, '.fake-running');
  const stopped = path.join(directory, '.fake-stopped');
  const foreignSquatter = path.join(directory, '.fake-foreign-squatter');
  const staleTunnel = path.join(directory, '.fake-stale-tunnel');
  const coreId = 'a'.repeat(64);
  const publicId = 'b'.repeat(64);
  const tunnelId = 'c'.repeat(64);
  const foreignId = 'f'.repeat(64);
  const staleTunnelId = 'd'.repeat(64);
  if (initiallyRunning) writeFileSync(running, 'running');
  if (failureNameSquatter) writeFileSync(foreignSquatter, 'foreign');
  if (staleDisabledTunnel) writeFileSync(staleTunnel, staleDisabledTunnel);
  mkdirSync(bin);
  const executable = path.join(bin, 'docker');
  const serializedConfig = JSON.stringify(normalizedConfig);
  const servicesOutput = `${Object.keys(normalizedConfig.services as Record<string, unknown>).join('\n')}\n`;
  const staleTunnelIdentity = [
    staleTunnelId,
    '/kassinao-tunnel',
    staleDisabledTunnel === 'foreign-project' ? 'company' : 'kassinao',
    'cloudflared',
    staleDisabledTunnel === 'running' ? 'true' : 'false',
    staleDisabledTunnel === 'restart-policy' ? 'unless-stopped' : 'no',
  ].join('|');
  const imagesOutput = `${Object.keys(normalizedConfig.services as Record<string, unknown>)
    .map(() => image)
    .join('\n')}\n`;
  const runtimeResourceContract = `${runtimeMemory}|${runtimeMemorySwap}|${runtimeMemorySwappiness === null ? 'null' : runtimeMemorySwappiness}|no`;
  const privacyDetails = [
    'Example Operator',
    'https://privacy.example.com/contact',
    'https://app.example.com/privacy#data-rights',
    '2026-01-01',
    '1.0',
    'Members of the Discord servers authorized by this operator',
    'Capture requested meetings and generate transcripts for authorized members',
    'Consent and legitimate interests determined by this operator',
    'Example cloud provider',
    'South America region',
    'none',
    'Operational logs are rotated and deleted within seven days',
    'Requests are identity checked and fulfilled by this operator',
    '30',
    'https://privacy.example.com/incident',
    'Incidents are assessed contained and communicated by this operator',
    'https://github.com/example/kassinao',
  ].join('\n');
  const privacyPt = `<html lang="pt-BR"><head><link rel="canonical" href="https://app.example.com/privacy"></head><body><section id="data-rights">${privacyDetails}\n 72 horas.\nBackup de conteúdo declarado como desativado.</section></body></html>`;
  const privacyEn = `<html lang="en"><head><link rel="canonical" href="https://app.example.com/en/privacy"></head><body><section id="data-rights">${privacyDetails}\n 72 hours.\nContent backup declared disabled.</section></body></html>`;
  writeFileSync(
    executable,
    `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> ${shellLiteral(log)}
if [ "\${1:-}" = version ]; then
  printf '28.0.1\n'
  exit 0
fi
if [ "\${1:-}" = compose ] && [ "\${2:-}" = version ]; then
  printf '2.35.1\n'
  exit 0
fi
resolve_container() {
  reference="$1"
  case "$reference" in
    kassinao)
      if [ -f ${shellLiteral(foreignSquatter)} ]; then
        cid=${shellLiteral(foreignId)}; name=kassinao; project=company; service=kassinao
      else
        [ -f ${shellLiteral(running)} ] || return 1
        cid=${shellLiteral(coreId)}; name=kassinao; project=kassinao; service=kassinao
      fi
      ;;
    ${coreId})
      [ -f ${shellLiteral(running)} ] || return 1
      cid=${shellLiteral(coreId)}; name=kassinao; project=kassinao; service=kassinao
      ;;
    ${foreignId})
      [ -f ${shellLiteral(foreignSquatter)} ] || return 1
      cid=${shellLiteral(foreignId)}; name=kassinao; project=company; service=kassinao
      ;;
    kassinao-public|${publicId})
      [ -f ${shellLiteral(running)} ] || return 1
      cid=${shellLiteral(publicId)}; name=kassinao-public; project=kassinao; service=kassinao-public
      ;;
    kassinao-tunnel)
      if [ -f ${shellLiteral(staleTunnel)} ]; then
        cid=${shellLiteral(staleTunnelId)}; name=kassinao-tunnel; project=kassinao; service=cloudflared
      else
        [ -f ${shellLiteral(running)} ] || return 1
        cid=${shellLiteral(tunnelId)}; name=kassinao-tunnel; project=kassinao; service=cloudflared
      fi
      ;;
    ${tunnelId})
      [ -f ${shellLiteral(running)} ] || return 1
      cid=${shellLiteral(tunnelId)}; name=kassinao-tunnel; project=kassinao; service=cloudflared
      ;;
    ${staleTunnelId})
      [ -f ${shellLiteral(staleTunnel)} ] || return 1
      cid=${shellLiteral(staleTunnelId)}; name=kassinao-tunnel; project=kassinao; service=cloudflared
      ;;
    *) return 1 ;;
  esac
}
if [ "\${1:-}" = inspect ] && [ "\${2:-}" = --format ]; then
  template="\${3:-}"
  reference="\${4:-}"
  resolve_container "$reference" || exit 1
  if [ "$template" = '{{.Id}}' ]; then
    printf '%s\n' "$cid"
  elif [ "$cid" = ${shellLiteral(staleTunnelId)} ] && [[ "$template" == *com.docker.compose.project* ]] && \
       [[ "$template" == *HostConfig.RestartPolicy* ]]; then
    printf '%s\n' ${shellLiteral(staleTunnelIdentity)}
  elif [[ "$template" == *com.docker.compose.project* ]]; then
    printf '%s|/%s|%s|%s\n' "$cid" "$name" "$project" "$service"
  elif [[ "$template" == *HostConfig.Memory* ]]; then
    printf '%s\n' ${shellLiteral(runtimeResourceContract)}
  else
    printf 'healthy\n'
  fi
  exit 0
fi
if [ "\${1:-}" = rm ]; then
  [ "\${2:-}" = ${shellLiteral(staleTunnelId)} ] && [ -f ${shellLiteral(staleTunnel)} ] || exit 1
  rm -f ${shellLiteral(staleTunnel)}
  exit 0
fi
case " $* " in
  *" config --no-env-resolution --format json "*) printf '%s\\n' ${shellLiteral(serializedConfig)}; exit 0 ;;
  *" config --quiet "*) exit 0 ;;
  *" config --services "*) printf '%s' ${shellLiteral(servicesOutput)}; exit 0 ;;
  *" config --images "*) printf '%s' ${shellLiteral(imagesOutput)}; exit 0 ;;
  *" ps -q "*)
    service="\${!#}"
    case "$service" in
      kassinao) cid=${shellLiteral(coreId)} ;;
      kassinao-public) cid=${shellLiteral(publicId)} ;;
      cloudflared) cid=${shellLiteral(tunnelId)} ;;
      *) exit 1 ;;
    esac
    if [ -f ${shellLiteral(running)} ] && ! grep -Fqx "$cid" ${shellLiteral(stopped)} 2>/dev/null; then
      printf '%s\n' "$cid"
    fi
    exit 0
    ;;
  *" pull "*) exit 0 ;;
  *" up -d --no-build "*)
    [ ${upFails ? 'true' : 'false'} = false ] || exit 1
    : > ${shellLiteral(running)}
    rm -f ${shellLiteral(stopped)}
    exit 0
    ;;
esac
if [ "\${1:-}" = stop ]; then
  target="\${!#}"
  resolve_container "$target" || exit 1
  printf '%s\n' "$cid" >> ${shellLiteral(stopped)}
  if [ ${snapshotFailsAfterStop ? 'true' : 'false'} = true ]; then
    ln -s ../auth ${shellLiteral(path.join(directory, 'data', 'state', '.unsafe-after-stop'))}
  fi
  exit 0
fi
if [ "\${1:-}" = start ]; then
  resolve_container "\${2:-}" || exit 1
  rm -f ${shellLiteral(stopped)}
  exit 0
fi
if [ "\${1:-}" = kill ]; then
  resolve_container "\${2:-}" || exit 1
  printf '%s\n' "$cid" >> ${shellLiteral(stopped)}
  exit 0
fi
if [ "\${1:-}" = image ] && [ "\${2:-}" = inspect ]; then
  printf '%s\\n' ${shellLiteral(image)}
  exit 0
fi
if [ "\${1:-}" = inspect ]; then
  reference="\${!#}"
  resolve_container "$reference" || exit 1
  case " $* " in
    *".HostConfig.Memory"*) printf '%s\\n' ${shellLiteral(runtimeResourceContract)} ;;
    *".Config.Image"*) printf '%s\\n' ${shellLiteral(image)} ;;
    *".State.Running"*)
      [ -f ${shellLiteral(running)} ] && ! grep -Fqx "$cid" ${shellLiteral(stopped)} 2>/dev/null && \
        printf 'true\\n' || printf 'false\\n'
      ;;
    *) printf 'healthy\\n' ;;
  esac
  exit 0
fi
exit 0
`,
    { mode: 0o700 },
  );
  chmodSync(executable, 0o700);

  for (const [name, script] of [
    ['flock', '#!/usr/bin/env bash\nexit 0\n'],
    [
      'systemctl',
      `#!/usr/bin/env bash
printf 'systemctl %s\\n' "$*" >> ${shellLiteral(log)}
exit ${egressActive ? '0' : '3'}
`,
    ],
    [
      'curl',
      `#!/usr/bin/env bash
set -eu
output=/dev/null
url="\${!#}"
printf 'curl %s\n' "$url" >> ${shellLiteral(log)}
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
surface=private
case "$url" in *www.example.com* | *docs.example.com*) surface=public ;; esac
[ -z "\${FAKE_ALL_SURFACE:-}" ] || surface="$FAKE_ALL_SURFACE"
if [ "$output" != /dev/null ]; then
  case "$url" in
    https://app.example.com/privacy)
      printf '%s' ${shellLiteral(privacyPt)} > "$output"
      printf '200'
      exit 0
      ;;
    https://app.example.com/en/privacy)
      printf '%s' ${shellLiteral(privacyEn)} > "$output"
      printf '200'
      exit 0
      ;;
  esac
  if [ "$surface" = private ]; then
    printf '%s' ${shellLiteral(
      `{"ok":true,"ready":true,"surface":"private","release":"${digest}","deployment":"${'e'.repeat(32)}"}`,
    )} > "$output"
  else
    printf '%s' ${shellLiteral(
      `{"ok":true,"surface":"public","release":"${digest}","deployment":"${'e'.repeat(32)}"}`,
    )} > "$output"
  fi
fi
if [ "$surface" = public ]; then
  case "$url" in
    */app | */auth/login | */api/meetings | */mcp | */privacy | */en/privacy) printf '404'; exit 0 ;;
  esac
fi
printf '200'
`,
    ],
  ] as const) {
    const file = path.join(bin, name);
    writeFileSync(file, script, { mode: 0o700 });
    chmodSync(file, 0o700);
  }
  const nestedMountTarget = path.join(directory, 'data', 'state', 'nested-mount');
  writeFileSync(
    path.join(bin, 'findmnt'),
    `#!/usr/bin/env bash
set -eu
printf '%s\n' ${shellLiteral(
      JSON.stringify({
        filesystems: snapshotNestedMount ? [{ target: nestedMountTarget }] : [],
      }),
    )}
`,
    { mode: 0o700 },
  );
  chmodSync(path.join(bin, 'findmnt'), 0o700);
  return { bin, log };
}

function deploymentFixture(
  image: string,
  options: DeploymentFixtureOptions = {},
): {
  directory: string;
  digest: string;
  script: string;
  runtimeDirectory: string;
  runtime: ReturnType<typeof fakeRuntime>;
} {
  const directory = makeStorageTempDir();
  chmodSync(directory, 0o700);
  const digest = image.includes('@') ? image.slice(image.indexOf('@') + 1) : `sha256:${'a'.repeat(64)}`;
  const deploymentFingerprint = 'e'.repeat(32);
  const dataRoot = path.join(directory, 'data');
  const recordings = path.join(dataRoot, 'recordings');
  const state = path.join(dataRoot, 'state');
  const auth = path.join(dataRoot, 'auth');
  const cache = path.join(dataRoot, 'cache');
  const configDirectory = path.join(dataRoot, 'config');
  const sharedAppEnv = path.join(configDirectory, 'app.env');
  const sharedTunnelToken = path.join(configDirectory, 'cloudflared-token');
  const runtimeDirectory = path.join(directory, 'runtime');
  for (const dataDirectory of [dataRoot, recordings, state, auth, cache, configDirectory, runtimeDirectory]) {
    mkdirSync(dataDirectory, { mode: 0o700 });
    chmodSync(dataDirectory, 0o700);
  }
  const mode = options.mode ?? 'split';
  const hostScope = options.hostScope ?? 'dedicated';
  const uid = hostScope === 'shared' ? 61050 : (process.getuid?.() ?? 1000);
  const gid = hostScope === 'shared' ? 61050 : (process.getgid?.() ?? 1000);
  const appUrl = 'https://app.example.com';
  const publicUrl = mode === 'split' ? 'https://www.example.com' : appUrl;
  const docsUrl = mode === 'split' ? 'https://docs.example.com' : appUrl;
  const environment = [
    `KASSINAO_IMAGE=${image}`,
    `KASSINAO_RELEASE_DIGEST=${digest}`,
    `KASSINAO_DEPLOYMENT_FINGERPRINT=${deploymentFingerprint}`,
    'KASSINAO_APP_ENV_FILE=app.env',
    `KASSINAO_DEPLOYMENT_MODE=${mode}`,
    `KASSINAO_HOST_SCOPE=${hostScope}`,
    `KASSINAO_DEDICATED_DOCKER_HOST_ACK=${hostScope === 'dedicated' ? 'I_UNDERSTAND_THIS_VPS_MUST_RUN_ONLY_KASSINAO' : ''}`,
    'KASSINAO_ROLLBACK_RETENTION_HOURS=72',
    'KASSINAO_CORE_MEMORY_LIMIT=2g',
    'KASSINAO_CORE_CPUS=1.0',
    'KASSINAO_PUBLIC_MEMORY_LIMIT=384m',
    'KASSINAO_PUBLIC_CPUS=0.2',
    'KASSINAO_TUNNEL_MEMORY_LIMIT=192m',
    'KASSINAO_TUNNEL_CPUS=0.2',
    `COMPOSE_PROFILES=${mode === 'split' ? 'split-public' : ''}`,
    'TUNNEL_TOKEN=',
    `KASSINAO_DATA_ROOT=${dataRoot}`,
    `KASSINAO_RECORDINGS_DIR=${recordings}`,
    `KASSINAO_STATE_DIR=${state}`,
    `KASSINAO_AUTH_DIR=${auth}`,
    `KASSINAO_MODEL_CACHE_DIR=${cache}`,
    `KASSINAO_UID=${uid}`,
    `KASSINAO_GID=${gid}`,
    `KASSINAO_SHARED_LUKS_BACKING_FILE=${directory}/kassinao.luks`,
    'KASSINAO_SHARED_LUKS_MAPPER=kassinao-shared-test',
    'KASSINAO_SHARED_LUKS_UUID=12345678-1234-4abc-8def-1234567890ab',
    `KASSINAO_SHARED_APP_ENV_FILE=${sharedAppEnv}`,
    `KASSINAO_SHARED_TUNNEL_TOKEN_FILE=${sharedTunnelToken}`,
    `APP_URL=${appUrl}`,
    `MCP_URL=${appUrl}`,
    `PUBLIC_URL=${publicUrl}`,
    `DOCS_URL=${docsUrl}`,
    'SOURCE_URL=https://github.com/example/kassinao',
    '',
  ].join('\n');
  writePrivateFile(path.join(directory, '.env'), environment);
  const appEnvironmentFile = hostScope === 'shared' ? sharedAppEnv : path.join(directory, 'app.env');
  writePrivateFile(
    appEnvironmentFile,
    [
      'DISCORD_TOKEN=test-discord-token',
      'APPLICATION_ID=123456789012345678',
      'DISCORD_CLIENT_SECRET=test-client-secret',
      `APP_URL=${appUrl}`,
      'BASE_URL=',
      `MCP_URL=${appUrl}`,
      `PUBLIC_URL=${publicUrl}`,
      `DOCS_URL=${docsUrl}`,
      'SOURCE_URL=https://github.com/example/kassinao',
      'OPERATOR_NAME=Example Operator',
      'OPERATOR_CONTACT_URL=https://privacy.example.com/contact',
      `PRIVACY_POLICY_URL=${appUrl}/privacy`,
      `DATA_DELETION_URL=${appUrl}/privacy#data-rights`,
      'TERMS_OF_SERVICE_URL=',
      'PRIVACY_EFFECTIVE_DATE=2026-01-01',
      'PRIVACY_POLICY_VERSION=1.0',
      'PRIVACY_AUDIENCE=Members of the Discord servers authorized by this operator',
      'PRIVACY_PURPOSES=Capture requested meetings and generate transcripts for authorized members',
      'PRIVACY_LAWFUL_BASIS=Consent and legitimate interests determined by this operator',
      'INFRASTRUCTURE_PROVIDER=Example cloud provider',
      'INFRASTRUCTURE_REGION=South America region',
      'EDGE_PROVIDER=none',
      'EDGE_REGION=none',
      'OPERATIONAL_LOG_RETENTION=Operational logs are rotated and deleted within seven days',
      'BACKUP_STATUS=disabled',
      'BACKUP_PROVIDER=none',
      'BACKUP_REGION=none',
      'BACKUP_RETENTION_DAYS=0',
      'DATA_REQUEST_PROCESS=Requests are identity checked and fulfilled by this operator',
      'DATA_REQUEST_RESPONSE_DAYS=30',
      'INCIDENT_CONTACT_URL=https://privacy.example.com/incident',
      'INCIDENT_PROCESS=Incidents are assessed contained and communicated by this operator',
      'KASSINAO_ROLLBACK_RETENTION_HOURS=72',
      'ALLOWED_GUILD_IDS=987654321098765432',
      'ALLOW_ALL_GUILDS=false',
      'ALLOW_LEGACY_SHARED_STATE=false',
      `PUBLIC_SURFACES_ENABLED=${mode === 'single' ? 'true' : 'false'}`,
      '',
    ].join('\n'),
  );
  if (hostScope === 'shared') chmodSync(appEnvironmentFile, 0o440);
  writeFileSync(sharedTunnelToken, '', { mode: 0o444 });
  chmodSync(sharedTunnelToken, 0o444);
  writeFileSync(
    path.join(directory, 'compose.env.example'),
    `KASSINAO_IMAGE=${image}\nKASSINAO_RELEASE_DIGEST=${digest}\nKASSINAO_DEPLOYMENT_FINGERPRINT=\n`,
  );
  writeFileSync(
    path.join(directory, 'docker-compose.yml'),
    `services:\n  kassinao:\n    image: \${KASSINAO_IMAGE}\n  cloudflared:\n    image: cloudflare/cloudflared:2026.7.1@sha256:${'b'.repeat(64)}\n`,
  );
  writeFileSync(path.join(directory, 'docker-compose.shared.yml'), 'services:\n  kassinao:\n    restart: "no"\n');
  mkdirSync(path.join(directory, 'scripts'));
  mkdirSync(path.join(directory, 'deploy'));
  mkdirSync(path.join(directory, 'deploy', 'docker-client'));
  writeFileSync(path.join(directory, 'deploy', 'docker-client', 'config.json'), '{}\n', { mode: 0o444 });
  const hardenerLog = path.join(directory, 'hardener.log');
  writeFileSync(
    path.join(directory, 'scripts', 'harden-docker-egress.sh'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${shellLiteral(hardenerLog)}
case "\${1:-}" in
  --preload) exit ${options.hardenerPreloadFails ? '1' : '0'} ;;
  --check) exit ${options.hardenerCheckFails ? '1' : '0'} ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o700 },
  );
  writeFileSync(
    path.join(directory, 'scripts', 'verify-storage-encryption.sh'),
    `#!/usr/bin/env bash
printf 'storage:%s\\n' "$*" >> ${shellLiteral(hardenerLog)}
exit ${options.storageVerifierFails ? '1' : '0'}
`,
    { mode: 0o700 },
  );
  writeFileSync(
    path.join(directory, 'scripts', 'verify-shared-luks-storage.sh'),
    `#!/usr/bin/env bash
printf 'shared-storage:%s:%s\\n' "\${KASSINAO_ENV_FILE:-unset}" "$*" >> ${shellLiteral(hardenerLog)}
exit ${options.storageVerifierFails ? '1' : '0'}
`,
    { mode: 0o700 },
  );
  writeFileSync(
    path.join(directory, 'scripts', 'audit-shared-vps-security.sh'),
    `#!/usr/bin/env bash
printf 'shared-audit:%s\n' "\${1:-}" >> ${shellLiteral(hardenerLog)}
case "\${1:-}" in
  --preflight)
    if [ ${options.sharedAuditRejectsStoppedContainer ? 'true' : 'false'} = true ] && \
       [ -s ${shellLiteral(path.join(directory, '.fake-stopped'))} ]; then
      exit 1
    fi
    exit ${options.sharedAuditPreflightFails ? '1' : '0'}
    ;;
  '') exit ${options.sharedAuditFullFails ? '1' : '0'} ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o700 },
  );
  writeFileSync(
    path.join(directory, 'scripts', 'check-shared-migration-rollback.sh'),
    `#!/usr/bin/env bash
printf 'rollback-check:%s:%s\n' "\${KASSINAO_ENV_FILE:-unset}" "$*" >> ${shellLiteral(hardenerLog)}
exit ${options.rollbackCheckerFails ? '1' : '0'}
`,
    { mode: 0o700 },
  );
  const manifestEntries = [
    'compose.env.example',
    'docker-compose.yml',
    'docker-compose.shared.yml',
    'deploy/docker-client/config.json',
    'scripts/harden-docker-egress.sh',
    'scripts/verify-storage-encryption.sh',
    'scripts/verify-shared-luks-storage.sh',
    'scripts/audit-shared-vps-security.sh',
    'scripts/check-shared-migration-rollback.sh',
  ].map((name) => {
    const bytes = readFileSync(path.join(directory, name));
    return `${createHash('sha256').update(bytes).digest('hex')}  ${name}`;
  });
  writeFileSync(path.join(directory, 'MANIFEST.sha256'), `${manifestEntries.join('\n')}\n`);

  const normalizedConfig: Record<string, unknown> = {
    services: {
      kassinao: {
        image,
        user: `${uid}:${gid}`,
        read_only: true,
        cap_drop: ['ALL'],
        security_opt: ['no-new-privileges:true'],
        networks: { private: null },
        environment:
          hostScope === 'shared'
            ? {
                PORT: '8080',
                WEB_BIND_ADDRESS: '0.0.0.0',
                RECORDINGS_DIR: '/app/recordings',
                STATE_DIR: '/app/state',
                AUTH_STATE_DIR: '/app/auth',
                KASSINAO_RELEASE_DIGEST: digest,
                KASSINAO_DEPLOYMENT_FINGERPRINT: deploymentFingerprint,
                TUNNEL_TOKEN: '',
                XDG_CACHE_HOME: '/home/node/.cache',
                DOTENV_CONFIG_PATH: '/run/secrets/kassinao-app.env',
              }
            : {
                KASSINAO_RELEASE_DIGEST: digest,
                KASSINAO_DEPLOYMENT_FINGERPRINT: deploymentFingerprint,
              },
        ...(hostScope === 'shared' ? {} : { env_file: [{ path: path.join(directory, 'app.env'), required: true }] }),
        ports: [{ host_ip: '127.0.0.1', target: 8080, published: '8080' }],
        volumes: [
          { type: 'bind', source: recordings, target: '/app/recordings' },
          { type: 'bind', source: state, target: '/app/state' },
          { type: 'bind', source: auth, target: '/app/auth' },
          { type: 'bind', source: cache, target: '/home/node/.cache' },
          ...(hostScope === 'shared'
            ? [
                {
                  type: 'bind',
                  source: path.join(dataRoot, '.kassinao-mounted'),
                  target: '/run/kassinao/storage-mounted',
                  read_only: true,
                  bind: { create_host_path: false },
                },
                {
                  type: 'bind',
                  source: sharedAppEnv,
                  target: '/run/secrets/kassinao-app.env',
                  read_only: true,
                  bind: { create_host_path: false },
                },
              ]
            : []),
        ],
        ...(hostScope === 'shared'
          ? {
              restart: 'no',
              mem_limit: 2_147_483_648,
              memswap_limit: 2_147_483_648,
              mem_swappiness: 0,
              cpus: 1,
            }
          : {}),
      },
    },
    networks: {
      private: {
        driver_opts: {
          'com.docker.network.bridge.name': 'kas-private0',
        },
      },
      public: {
        internal: true,
        driver_opts: {
          'com.docker.network.bridge.name': 'kas-public0',
          'com.docker.network.bridge.gateway_mode_ipv4': 'isolated',
          'com.docker.network.bridge.gateway_mode_ipv6': 'isolated',
        },
      },
    },
  };
  if (mode === 'split') {
    const services = normalizedConfig.services as Record<string, unknown>;
    services['kassinao-public'] = {
      image,
      user: `${uid}:${gid}`,
      read_only: true,
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges:true'],
      networks: { public: null },
      environment: {
        NODE_ENV: 'production',
        PORT: '8081',
        WEB_BIND_ADDRESS: '0.0.0.0',
        PUBLIC_URL: publicUrl,
        DOCS_URL: docsUrl,
        SOURCE_URL: 'https://github.com/example/kassinao',
        KASSINAO_RELEASE_DIGEST: digest,
        KASSINAO_DEPLOYMENT_FINGERPRINT: deploymentFingerprint,
        TRUST_PROXY_HOPS: '1',
        REPO_PUBLIC: 'true',
      },
      ports: [{ host_ip: '127.0.0.1', target: 8081, published: '8081' }],
      ...(hostScope === 'shared'
        ? {
            restart: 'no',
            mem_limit: 402_653_184,
            memswap_limit: 402_653_184,
            mem_swappiness: 0,
            cpus: 0.2,
          }
        : {}),
    };
  }
  options.mutateNormalizedConfig?.(normalizedConfig);
  const runtime = fakeRuntime(
    directory,
    image,
    digest,
    normalizedConfig,
    options.initiallyRunning,
    options.egressActive,
    options.upFails,
    options.staleDisabledTunnel,
    options.failureNameSquatter,
    options.snapshotNestedMount,
    options.snapshotTarFails,
    options.runtimeMemory,
    options.runtimeMemorySwap,
    options.runtimeMemorySwappiness,
  );
  if (hostScope === 'shared') {
    const callerUid = process.getuid?.() ?? 1000;
    const callerGid = process.getgid?.() ?? 1000;
    const statFixture = path.join(runtime.bin, 'stat');
    writeFileSync(
      statFixture,
      `#!/usr/bin/env bash
if [ "\${1:-}" = -c ] && [ "\${2:-}" = '%u:%g' ]; then
  case "\${3:-}" in
    ${shellLiteral(recordings)}|${shellLiteral(state)}|${shellLiteral(auth)}|${shellLiteral(cache)})
      printf '${uid}:${gid}\n'; exit 0 ;;
    ${shellLiteral(sharedAppEnv)}) printf '${callerUid}:${gid}\n'; exit 0 ;;
    ${shellLiteral(sharedTunnelToken)}) printf '${callerUid}:${callerGid}\n'; exit 0 ;;
  esac
fi
exec /usr/bin/stat "$@"
`,
      { mode: 0o700 },
    );
    chmodSync(statFixture, 0o700);
  }
  const inheritedEnvironment = path.join(directory, 'inherited-deploy-environment.bin');
  writeFileSync(
    inheritedEnvironment,
    Buffer.from(
      [...new Set([...Object.keys(process.env), 'PATH', 'HOME', 'KASSINAO_DEPLOY_DIR'])]
        .map((name) => `${name}=fixture\0`)
        .join(''),
    ),
  );
  const script = path.join(directory, 'scripts', 'deploy-release.sh');
  const lockHarness = `cursor="$ROOT"
while :; do
  [ ! -e "$cursor/.git" ] || die "deploy precisa ficar fora de qualquer Git ($cursor/.git)"
  parent="$(dirname "$cursor")"
  [ "$parent" != "$cursor" ] || break
  cursor="$parent"
done
LOCK_FILE="$ROOT/.deploy.lock"
[ -e "$LOCK_FILE" ] || : > "$LOCK_FILE"
chmod 600 "$LOCK_FILE"
exec 9<>"$LOCK_FILE"
flock -n 9 || die 'já existe outro deploy em andamento'
DOCKER_CONFIG="$ROOT/deploy/docker-client"
DOCKER_CONFIG_FILE="$DOCKER_CONFIG/config.json"
[ -d "$DOCKER_CONFIG" ] && [ ! -L "$DOCKER_CONFIG" ] && \
  [ -f "$DOCKER_CONFIG_FILE" ] && [ ! -L "$DOCKER_CONFIG_FILE" ] || \
  die 'configuração isolada do cliente Docker está ausente ou irregular'
export DOCKER_CONFIG
RUNTIME_DIR=${shellLiteral(runtimeDirectory)}
MAINTENANCE_LOCK_FILE="$RUNTIME_DIR/maintenance.lock"
exec 8<>"$MAINTENANCE_LOCK_FILE"
flock -w 120 8 || die 'outra manutenção não liberou a instância em 120 segundos'
`;
  const deploySource = repositoryFile('scripts/deploy-release.sh')
    .replaceAll('/proc/$$/environ', inheritedEnvironment)
    .replace(
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      `PATH=${runtime.bin}:/usr/local/bin:/usr/bin:/bin`,
    )
    .replace(
      /# KASSINAO_HOST_NO_DUMP_BEGIN[\s\S]*?# KASSINAO_HOST_NO_DUMP_END/,
      '# KASSINAO_HOST_NO_DUMP_BEGIN\nunset LD_PRELOAD\n# KASSINAO_HOST_NO_DUMP_END',
    )
    .replace(
      /cursor="\$ROOT"\nwhile :; do[\s\S]*?flock -w 120 8 \|\| die 'outra manutenção não liberou a instância em 120 segundos'\n/,
      lockHarness,
    );
  expect(deploySource).toContain(`RUNTIME_DIR=${shellLiteral(runtimeDirectory)}`);
  expect(deploySource).not.toContain('stat -Lc \'%a:%u:%g:%h\' "/proc/$$/fd/8"');
  writeFileSync(script, deploySource, { mode: 0o700 });
  chmodSync(script, 0o700);
  writeFileSync(path.join(runtimeDirectory, 'maintenance.lock'), 'maintenance-sentinel\n', { mode: 0o600 });
  chmodSync(path.join(runtimeDirectory, 'maintenance.lock'), 0o600);
  const deployBytes = readFileSync(script);
  writeFileSync(
    path.join(directory, 'MANIFEST.sha256'),
    `${readFileSync(path.join(directory, 'MANIFEST.sha256'), 'utf8')}${createHash('sha256').update(deployBytes).digest('hex')}  scripts/deploy-release.sh\n`,
  );
  return {
    directory,
    digest,
    script,
    runtimeDirectory,
    runtime,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('fronteira do processo público', () => {
  const safePublicEnvironment = {
    NODE_ENV: 'production',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/home/node',
    HOSTNAME: 'public-container',
    PUBLIC_URL: 'https://example.com',
    DOCS_URL: 'https://docs.example.com',
    SOURCE_URL: 'https://github.com/example/kassinao',
  } satisfies NodeJS.ProcessEnv;

  it('inicia somente com origens públicas explícitas e sem configuração privada', () => {
    expect(() => assertPublicRuntimeEnvironment(safePublicEnvironment)).not.toThrow();
    expect(
      privateRuntimeEnvironmentKeys({
        ...safePublicEnvironment,
        DISCORD_TOKEN: '   ',
        RECORDINGS_DIR: '',
      }),
    ).toEqual([]);
  });

  it('falha fechado para qualquer chave não aprovada, incluindo segredo, tenancy e caminho', () => {
    for (const name of [
      'DISCORD_TOKEN',
      'ALLOWED_GUILD_IDS',
      'RECORDINGS_DIR',
      'AWS_SECRET_ACCESS_KEY',
      'DATABASE_URL',
    ]) {
      const value = `valor-privado-${name}`;
      expect(() => assertPublicRuntimeEnvironment({ ...safePublicEnvironment, [name]: value })).toThrow(name);
      try {
        assertPublicRuntimeEnvironment({ ...safePublicEnvironment, [name]: value });
      } catch (error) {
        expect((error as Error).message).not.toContain(value);
      }
    }
  });

  it('recusa também segredos desconhecidos pelo sufixo, sem registrar o valor', () => {
    const environment = { ...safePublicEnvironment, FUTURE_PROVIDER_API_KEY: 'segredo-futuro' };
    expect(privateRuntimeEnvironmentKeys(environment)).toContain('FUTURE_PROVIDER_API_KEY');
    try {
      assertPublicRuntimeEnvironment(environment);
      throw new Error('deveria falhar');
    } catch (error) {
      expect((error as Error).message).toContain('FUTURE_PROVIDER_API_KEY');
      expect((error as Error).message).not.toContain('segredo-futuro');
    }
  });

  it('recusa origem ausente, externa sem HTTPS ou com partes além da origem', () => {
    expect(() => assertPublicRuntimeEnvironment({ DOCS_URL: safePublicEnvironment.DOCS_URL })).toThrow('PUBLIC_URL');
    expect(() => assertPublicRuntimeEnvironment({ PUBLIC_URL: safePublicEnvironment.PUBLIC_URL })).toThrow('DOCS_URL');
    expect(() =>
      assertPublicRuntimeEnvironment({ ...safePublicEnvironment, PUBLIC_URL: 'http://public.example.com' }),
    ).toThrow(/HTTPS/);
    for (const url of [
      'https://example.com/path',
      'https://example.com?query=1',
      'https://user:password@example.com',
      'https://example.com#fragment',
    ]) {
      expect(() => assertPublicRuntimeEnvironment({ ...safePublicEnvironment, DOCS_URL: url })).toThrow(/origem/);
    }
  });

  it('exige SOURCE_URL explícita e sem credenciais/query/hash no processo público', () => {
    expect(() => assertPublicRuntimeEnvironment({ ...safePublicEnvironment, SOURCE_URL: '' })).toThrow('SOURCE_URL');
    for (const sourceUrl of [
      'http://github.example.com/example/kassinao',
      'https://user:secret@github.example.com/example/kassinao',
      'https://github.example.com/example/kassinao?ref=private',
      'https://github.example.com/example/kassinao#branch',
      'https://github.example.com',
    ]) {
      expect(() => assertPublicRuntimeEnvironment({ ...safePublicEnvironment, SOURCE_URL: sourceUrl })).toThrow();
    }
  });
});

describe('artefatos de distribuição', () => {
  it('limpa dist antes do build para não distribuir módulos removidos', () => {
    const packageJson = JSON.parse(repositoryFile('package.json')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts.prebuild).toBe('npm run clean');

    const fixture = makeTempDir();
    const retiredArtifact = path.join(fixture, 'dist', 'web', 'revenueLanding.js');
    mkdirSync(path.dirname(retiredArtifact), { recursive: true });
    writeFileSync(retiredArtifact, 'retired build artifact');
    writeFileSync(
      path.join(fixture, 'package.json'),
      JSON.stringify({ private: true, scripts: { clean: packageJson.scripts.clean } }),
    );

    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = spawnSync(npm, ['run', 'clean'], { cwd: fixture, encoding: 'utf8' });
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(existsSync(path.join(fixture, 'dist'))).toBe(false);
  });

  it('usa imagens publicadas e processos sem rede ou dados compartilhados no Compose', () => {
    const compose = repositoryFile('docker-compose.yml');
    const privateProcess = serviceBlock(compose, 'kassinao');
    const publicProcess = serviceBlock(compose, 'kassinao-public');

    expect(compose).not.toMatch(/^\s*build:\s*/m);
    expect(privateProcess).toMatch(/^\s*image:\s*\$\{KASSINAO_IMAGE/m);
    expect(publicProcess).toMatch(/^\s*image:\s*\$\{KASSINAO_IMAGE/m);
    expect(publicProcess).toContain("command: ['/usr/local/bin/node', 'dist/public.js']");
    expect(privateProcess).toMatch(/^\s*networks:\s*\[private\]\s*$/m);
    expect(publicProcess).toMatch(/^\s*networks:\s*\[public\]\s*$/m);
    expect(privateProcess).not.toMatch(/^\s*networks:\s*\[[^\]]*public/m);
    expect(publicProcess).not.toMatch(/^\s*networks:\s*\[[^\]]*private/m);
    expect(publicProcess).not.toMatch(/^\s*env_file:/m);
    expect(publicProcess).not.toMatch(/^\s*volumes:/m);
    expect(compose).toMatch(/^  public:\n    internal: true\n    driver_opts:/m);
    const configuredKeys = [...publicProcess.matchAll(/^\s{6}([A-Z][A-Z0-9_]*):/gm)].map((match) => match[1]);
    for (const name of configuredKeys) {
      expect(PUBLIC_RUNTIME_ENV.has(name), `${name} precisa constar da allowlist pública`).toBe(true);
    }
  });

  it('publica no GHCR com actions pinadas, SBOM, provenance e attestation do digest', () => {
    const workflow = repositoryFile('.github/workflows/publish-image.yml');
    const runtimeTemplate = repositoryFile('deploy/runtime/compose.env.example');
    const actions = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);

    expect(workflow).toMatch(/^\s*REGISTRY:\s*ghcr\.io\s*$/m);
    expect(workflow).toMatch(/^\s*packages:\s*write\s*$/m);
    expect(workflow).toMatch(/^\s*id-token:\s*write\s*$/m);
    expect(workflow).toMatch(/^\s*attestations:\s*write\s*$/m);
    expect(actions.length).toBeGreaterThanOrEqual(5);
    expect(actions.every((action) => /@[0-9a-f]{40}$/.test(action))).toBe(true);
    expect(workflow).toContain('docker/setup-qemu-action@06116385d9baf250c9f4dcb4858b16962ea869c3 # v4.1.0');
    expect(workflow).toContain(
      'image: docker.io/tonistiigi/binfmt:qemu-v10.2.3-68@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0',
    );
    expect(workflow).toMatch(/docker\/build-push-action@[0-9a-f]{40}/);
    expect(workflow.indexOf('docker/setup-qemu-action@')).toBeLessThan(workflow.indexOf('docker/setup-buildx-action@'));
    expect(workflow).toContain('version: v0.35.0');
    expect(workflow).toContain(
      'driver-opts: image=moby/buildkit:v0.30.0@sha256:0168606be2315b7c807a03b3d8aa79beefdb31c98740cebdffdfeebf31190c9f',
    );
    expect(workflow).toMatch(/^\s*push:\s*true\s*$/m);
    expect(workflow).toMatch(/^\s*provenance:\s*mode=max\s*$/m);
    expect(workflow).toMatch(/^\s*sbom:\s*true\s*$/m);
    expect(workflow).toMatch(/actions\/attest@[0-9a-f]{40}/);
    expect(workflow).toMatch(/subject-digest:\s*\$\{\{\s*steps\.[A-Za-z0-9_-]+\.outputs\.digest\s*\}\}/);
    expect(workflow).toMatch(/^\s*push-to-registry:\s*true\s*$/m);
    expect(workflow).toContain('npm audit --audit-level=high');
    expect(workflow).toContain('npm audit signatures');
    expect(workflow).toContain('npm test');
    expect(workflow).toContain('npm run build');
    expect(workflow).toContain('vars.IMMUTABLE_RELEASES_ENABLED');
    expect(workflow).toContain('vars.RELEASE_TAG_RULESET_ENABLED');
    expect(workflow).toContain('test "$release_commit" = "$main_commit"');
    expect(workflow).toContain('Require the reviewed MCP release before publishing the app');
    expect(workflow).toContain('https://registry.npmjs.org/-/npm/v1/attestations/$package@$version');
    expect(workflow).toContain('test "$(git rev-parse "$mcp_ref^{commit}")" = "$release_commit"');
    expect(workflow).toContain('npm audit signatures --prefix "$audit_root"');
    expect(workflow).toContain('node scripts/verify-npm-release-attestation.cjs');
    expect(workflow).toContain('publish mcp-v$version first');
    expect(workflow.indexOf('Require the reviewed MCP release')).toBeLessThan(
      workflow.indexOf('Gate the release on the audited source tree'),
    );
    expect(workflow).toContain('git ls-remote --refs origin "$GITHUB_REF"');
    expect(workflow).toContain('gh release edit "$tag" --draft');
    expect(workflow).toContain('amd64_image="$repository@$(platform_digest amd64)"');
    expect(workflow).toContain('arm64_image="$repository@$(platform_digest arm64)"');
    expect(workflow).toContain('DOCKER_CONFIG="$anonymous_config" docker pull --platform linux/amd64 "$amd64_image"');
    expect(workflow).toContain('DOCKER_CONFIG="$anonymous_config" docker pull --platform linux/arm64 "$arm64_image"');
    expect(workflow).not.toContain('docker pull --platform linux/amd64 "$image"');
    expect(workflow).not.toContain('docker pull --platform linux/arm64 "$image"');
    expect(workflow).toContain('docker run --rm --platform linux/amd64 --network none --read-only --user 1000:1000');
    expect(workflow).toContain('--entrypoint node "$amd64_image"');
    expect(workflow).toContain('"/usr/local/lib/node_modules/npm"');
    expect(workflow).toContain('"/usr/local/lib/node_modules/corepack"');
    expect(workflow).toContain('fs.lstatSync(path); process.exit(12);');
    expect(workflow).toContain('entry.startsWith("yarn-")');
    expect(workflow).toContain('prove_no_dump_runtime linux/amd64 "$amd64_image"');
    expect(workflow).toContain('prove_no_dump_runtime linux/arm64 "$arm64_image"');
    expect(workflow).toContain('extract_no_dump_runtime linux/amd64 amd64 "$amd64_image"');
    expect(workflow).toContain('extract_no_dump_runtime linux/arm64 arm64 "$arm64_image"');
    expect(workflow).toContain('dist/native-runtime');
    expect(workflow.indexOf('docker run --rm --platform linux/amd64')).toBeLessThan(
      workflow.indexOf('docker pull --platform linux/arm64'),
    );
    expect(workflow.match(/aquasecurity\/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25/g)).toHaveLength(2);
    expect(workflow.match(/version: v0\.70\.0/g)).toHaveLength(2);
    expect(workflow).toContain('gh release delete-asset "$tag" "$extra" --yes');
    expect(workflow).not.toContain('subject-path: dist/release/trivy-image-');
    expect(workflow).toContain('package-ops-bundle.sh');
    expect(workflow).toContain('subject-path: dist/release/kassinao-ops-${{ github.ref_name }}.tar.gz');
    expect(workflow.indexOf('Promote rolling tags only after')).toBeGreaterThan(
      workflow.indexOf('Published release $tag is not verifiably immutable'),
    );
    expect(runtimeTemplate).toContain('KASSINAO_IMAGE=REPLACED_BY_VERIFIED_RELEASE_BUNDLE');
    expect(runtimeTemplate).not.toMatch(/^KASSINAO_IMAGE=ghcr\.io\/[^\s:]+\/[^\s:]+:\d/m);
  });

  it('troca o firewall por policy A/B pronta, suporta preload e falha fechado no systemd', () => {
    const harden = repositoryFile('scripts/harden-docker-egress.sh');
    const audit = repositoryFile('scripts/audit-vps-security.sh');
    const deploy = repositoryFile('scripts/deploy-release.sh');
    const egressUnit = repositoryFile('deploy/systemd/kassinao-docker-egress.service');
    const healthUnit = repositoryFile('deploy/systemd/kassinao-health-watch.service');
    const failClosedUnit = repositoryFile('deploy/systemd/kassinao-egress-fail-closed.service');
    const failClosedScript = repositoryFile('scripts/egress-fail-closed.sh');
    const dockerDropIn = repositoryFile('deploy/systemd/docker.service.d/kassinao-egress.conf');
    const installer = repositoryFile('scripts/install-host-controls.sh');
    const uninstaller = repositoryFile('scripts/uninstall-host-controls.sh');
    const rollbackServiceTemplate = repositoryFile('deploy/systemd/kassinao-rollback-clean.service.in');
    const rollbackTimer = repositoryFile('deploy/systemd/kassinao-rollback-clean.timer');
    const rollbackTmpfiles = repositoryFile('deploy/tmpfiles.d/kassinao-rollback.conf.in');

    expect(harden).toContain('{{range $id, $member := .Containers}}{{printf "%s|%s\\n" $id $member.Name}}{{end}}');
    expect(harden).toContain('managed_container_id()');
    expect(harden).toContain('ocupa nome reservado sem identidade Compose aprovada');
    expect(harden).toContain('BRIDGE_NAME=kas-private0');
    expect(harden).toContain('PRELOAD=true');
    expect(harden).toContain('--preload)');
    expect(harden).toContain('--check)');
    expect(harden).toContain('--offline-preload)');
    expect(harden).toContain('--remove)');
    expect(harden).toContain('LOCK_DIR=/run/lock/kassinao');
    expect(harden).not.toContain('KASSINAO_RUNTIME_DIR:-/run/lock/kassinao');
    expect(harden).toContain("= '700:0:0'");
    expect(harden).not.toContain('core não apareceu em 120 segundos');
    expect(harden).toContain('iptables -w 10');
    expect(harden).toContain('ip6tables -w 10');
    expect(harden).toContain('KASSINAO-EGRESS-A');
    expect(harden).toContain('KASSINAO-EGRESS-B');
    expect(harden).toContain('KASSINAO-HOST-A');
    expect(harden).toContain('KASSINAO-HOST-B');
    expect(harden).toContain('chain_is_referenced "$tool" "$inactive"');
    expect(harden).toContain('"$tool" -F "$inactive"');
    expect(harden).not.toContain('"$tool" -F "$anchor"');
    expect(harden.indexOf('v6_host="$(prepare_policy')).toBeLessThan(
      harden.indexOf('activate_policy ipt KASSINAO-EGRESS'),
    );
    expect(harden).toContain('"$tool" -R "$anchor" 1 -j "$replacement"');
    expect(harden).toContain('canonicalize_first_rule ipt FORWARD -j DOCKER-USER');
    expect(harden).toContain('canonicalize_first_rule ip6t FORWARD -j DOCKER-USER');
    expect(harden).toContain('--ctstate ESTABLISHED,RELATED -j RETURN');
    expect(egressUnit).toContain('OnFailure=kassinao-egress-fail-closed.service');
    expect(egressUnit).toContain('Restart=on-failure');
    expect(egressUnit).toContain('BindsTo=docker.service');
    expect(egressUnit).not.toContain('PartOf=docker.service');
    expect(healthUnit).toContain('Requires=docker.service kassinao-docker-egress.service');
    expect(healthUnit).toContain('After=docker.service kassinao-docker-egress.service');
    expect(healthUnit).toContain('RestrictAddressFamilies=AF_UNIX AF_NETLINK');
    expect(healthUnit).toContain('CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_RAW');
    expect(egressUnit).not.toContain('kassinao-health-watch.service');
    expect(failClosedUnit).toContain('ExecStart=/usr/local/sbin/kassinao-egress-fail-closed');
    expect(failClosedUnit).not.toContain('ExecStart=-');
    expect(failClosedScript).toContain('docker stop --timeout 30 "$cid"');
    expect(failClosedScript).not.toContain('docker stop --time ');
    expect(deploy).not.toContain('docker stop --time ');
    expect(failClosedScript).toContain('docker kill "$cid"');
    expect(failClosedScript).toContain("'{{.State.Running}}'");
    expect(dockerDropIn).toContain('Wants=kassinao-docker-egress.service');
    expect(dockerDropIn).toContain('ExecStartPre=/usr/local/sbin/kassinao-harden-docker-egress --offline-preload');
    expect(installer).toContain('kassinao-egress-fail-closed.service');
    expect(installer).toContain('systemd-tmpfiles --create "$TMPFILES_DESTINATION"');
    expect(installer).toContain('systemctl show docker.service -p ExecStartPre');
    expect(installer).toContain('systemctl show docker.service -p NeedDaemonReload');
    expect(installer).toContain("= '700:0:0'");
    expect(installer).toContain('drop-in não auditado');
    expect(installer).toContain('não pode ser symlink');
    expect(installer).toContain('I_UNDERSTAND_THIS_VPS_MUST_RUN_ONLY_KASSINAO');
    expect(installer).toContain('KASSINAO_ROLLBACK_RETENTION_HOURS');
    expect(installer).toContain('rollback_retention_hours * 60 - 31');
    expect(installer).not.toContain('rollback_cleanup_age=0');
    expect(installer).toContain('systemctl start kassinao-rollback-clean.service');
    expect(rollbackServiceTemplate).toContain('ProtectSystem=strict');
    expect(rollbackServiceTemplate).toContain('ReadWritePaths=@ROLLBACK_DIR@');
    expect(rollbackTimer).toContain('Persistent=true');
    expect(rollbackTimer).toContain('OnCalendar=*:0/30');
    expect(rollbackTimer).toContain('AccuracySec=1s');
    expect(rollbackTmpfiles).toContain('mM:@CLEANUP_AGE@');
    expect(deploy).toContain('mktemp -d "$rollback_dir/.snapshot.XXXXXX"');
    expect(deploy).toContain('SNAPSHOT_ARCHIVE_TMP="$(mktemp "$rollback_dir/.operational-state-$stamp.XXXXXX")"');
    expect(uninstaller).toContain('--confirm-remove-kassinao-host-controls');
    expect(uninstaller).toContain("'{{.HostConfig.RestartPolicy.Name}}'");
    expect(uninstaller).toContain('flock -n 6');
    expect(uninstaller).toContain('flock -n 8');
    expect(uninstaller).not.toContain('docker stop');
    expect(uninstaller).toContain('kassinao-harden-docker-egress --remove');
    expect(uninstaller).toContain('os dados da instância não foram apagados');
    expect(audit).toContain('first_docker="$("$tool" -S DOCKER-USER');
    expect(audit).toContain('PRIVATE_MEMBERS=');
    expect(audit).toContain('.HostConfig.CapAdd');
    expect(audit).toContain('.HostConfig.DeviceCgroupRules');
    expect(audit).toContain('.HostConfig.UtsMode');
    expect(audit).toContain("expected_forward='-A FORWARD -j DOCKER-USER'");
    expect(audit).toContain('mapfile -t egress_rules');
    expect(audit).toContain('mapfile -t host_rules');
    expect(audit).toContain('scripts e units root correspondem exatamente ao kit atual');
    expect(audit).toContain('systemctl is-enabled --quiet kassinao-health-watch.timer');
    expect(audit).toContain('systemctl is-enabled --quiet kassinao-docker-egress.service');
    expect(audit).toContain('systemctl is-enabled --quiet kassinao-rollback-clean.timer');
    expect(audit).toContain('container alheio, privilégio global, device, docker.sock ou bind sensível detectado');
    expect(audit).toContain('host.get("HasDeviceRequests")');
    expect(audit).toContain('actual != expected');
    expect(audit).toContain('unit_property_is "$unit" FragmentPath');
    expect(audit).toContain('unit_property_is "$unit" DropInPaths \'\'');
    expect(audit).toContain('unit_property_is "$unit" NeedDaemonReload no');
    expect(audit).toContain('deploy/tmpfiles.d/kassinao.conf:/etc/tmpfiles.d/kassinao.conf:644');
    expect(audit).toContain(
      'deploy/systemd/docker.service.d/kassinao-egress.conf:/etc/systemd/system/docker.service.d/kassinao-egress.conf:644',
    );
    expect(audit).toContain(
      'deploy/systemd/kassinao-egress-fail-closed.service:/etc/systemd/system/kassinao-egress-fail-closed.service:644',
    );
    expect(audit).toContain("stat -c '%a:%u:%g' /run/lock/kassinao");
    expect(audit).toContain("grep -Fq '$RUNTIME_DIR/maintenance.lock'");
    expect(audit).toContain("unit_words_are kassinao-health-watch.service ReadWritePaths '/run/lock/kassinao'");
    expect(audit).toContain(
      "unit_words_are kassinao-health-watch.service Requires 'docker.service kassinao-docker-egress.service'",
    );
    expect(audit).toContain("unit_words_are kassinao-docker-egress.service ReadWritePaths '/run/lock/kassinao'");
    expect(audit).toContain('unit_property_is docker.service NeedDaemonReload no');
    expect(audit).toContain("app.get('PUBLIC_SURFACES_ENABLED') != 'false'");
    expect(audit).toContain("app.get('ALLOW_ALL_GUILDS') != 'false'");
    expect(audit).toContain("re.fullmatch(r'[0-9]{17,20}', item)");
    expect(audit).toContain('ambiente efetivo do core corresponde às invariantes privadas do app.env');
    expect(audit).toContain("CORE_STATE_HEALTH\" = 'running|healthy'");
    expect(audit).toContain("PUBLIC_STATE_HEALTH\" = 'running|healthy'");
    expect(audit).toContain('TUNNEL_STATE" = running');
    expect(audit).toContain('TUNNEL_RUNTIME_CMD" = \'["tunnel","--no-autoupdate","run"]\'');
    expect(audit).toContain('com.docker.compose.project.config_files');
    expect(audit).toContain('RUNTIME_TUNNEL_TOKEN');
    expect(audit).toContain("arg.startswith('--config-file=')");
    expect(audit).toContain("value.lower() in ('true', 'false', '1', '0')");
    expect(audit).toContain("'live-restore'");
    expect(audit).toContain("docker info --format '{{.LiveRestoreEnabled}}'");
    expect(audit).toContain("'{{.HostConfig.RestartPolicy.Name}}'");
    expect(audit).toContain('DATA_ROOT_MODE" = 700');
    expect(audit).toContain('[ "$EUID" -eq 0 ] || fatal \'execute o audit como root\'');
    expect(audit).toContain('arquivos de ambiente pertencem somente a root:root');
    expect(audit).toContain('DATA_ROOT pertence a root:root');
    expect(audit).toContain("key == 'permitrootlogin' and value != 'no'");
    expect(audit).toContain("'hostbasedauthentication:no'");
    expect(audit).toContain("'gssapiauthentication:no'");
    expect(audit).toContain("'permitemptypasswords:no'");
    expect(audit).toContain("any(step != 'publickey' for step in chain.split(','))");
    expect(audit).toContain('systemctl start kassinao-health-watch.service');
    expect(audit).toContain('ExecMainStatus 0');
    expect(audit).toContain('egress_chain=KASSINAO-EGRESS-A; egress_inactive=KASSINAO-EGRESS-B');
    expect(audit).toContain('host_chain=KASSINAO-HOST-B; host_inactive=KASSINAO-HOST-A');
    expect(audit).toContain('[ "$CORE_BRIDGE" = kas-private0 ]');
    expect(deploy).toContain("'build', 'cap_add', 'devices', 'device_cgroup_rules'");
    expect(deploy).toContain("network_mode.startswith('container:')");
  });

  it('mantém source e scripts operacionais fora do estágio final da imagem', () => {
    const dockerfile = repositoryFile('Dockerfile');
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM ') + 1);

    expect(runtime).toMatch(/COPY\s+.*--from=build\s+\/app\/dist\s+\.\/dist/);
    expect(runtime).not.toMatch(/COPY\s+(?:--\S+\s+)*src(?:\s|\/)/);
    expect(runtime).not.toMatch(/COPY\s+(?:--\S+\s+)*scripts\s+\.\/scripts/);
    for (const operationalScript of [
      'audit-vps-security',
      'backup-retention',
      'backup.sh',
      'deploy-release',
      'egress-fail-closed',
      'health-watch',
      'harden-docker-egress',
      'install-host-controls',
      'install-shared-host-controls',
      'check-shared-migration-rollback',
      'finalize-shared-migration',
      'migrate-shared-storage',
      'prepare-legacy-shared-layout',
      'remove-legacy-dedicated-host-controls',
      'remove-legacy-health-watch',
      'validate-legacy-dedicated-installation',
      'uninstall-host-controls',
      'uninstall-shared-host-controls',
      'inject-secrets',
      'preview-web',
    ]) {
      expect(runtime).not.toContain(operationalScript);
    }
    expect(runtime).toContain('scripts/transcribe-local.py');
    expect(runtime).toContain('/usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-*');
    expect(runtime).toContain('/usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack');
    expect(runtime).toContain('/usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx');
  });

  it('executa somente o build nativo do Opus durante a instalação da imagem', () => {
    const dockerfile = repositoryFile('Dockerfile');
    const build = dockerfile.slice(0, dockerfile.indexOf('\n# --- runtime ---'));

    expect(build).toMatch(/npm ci --omit=peer --ignore-scripts/);
    expect(build).toContain('npm_config_build_from_source=true npm rebuild @discordjs/opus');
    expect(build).toContain(`node -e "require('@discordjs/opus')"`);
    expect(build).not.toContain('.npmrc.security');
    expect(build).not.toContain('npm rebuild sharp');
    expect(build).not.toContain('npm_config_userconfig=');
  });

  it('deixa origens privadas sem default ou domínio oficial na configuração de exemplo', () => {
    const example = repositoryFile('.env.example');
    const env = activeEnvironment(example);

    expect(env.get('APP_URL')).toBe('');
    expect(env.get('BASE_URL')).toBe('');
    for (const name of ['PUBLIC_URL', 'DOCS_URL', 'MCP_URL']) {
      expect(env.get(name) ?? '').toBe('');
    }
    expect(example).not.toContain('kassinao.cloud');
    expect(env.get('APP_URL')).not.toContain('localhost');
    expect(env.get('SOURCE_URL')).toBe('');
    expect(example).not.toContain('SOURCE_URL=https://github.com/resolvicomai/kassinao');
  });

  it('gera kit operacional sem checkout/app source, segredos ou tag mutável e com checksum portátil', () => {
    const output = makeTempDir();
    const digest = `sha256:${'b'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const nativeRuntime = makeNativeRuntimeFixture();
    const result = spawnSync(
      'bash',
      [path.join(ROOT, 'scripts', 'package-ops-bundle.sh'), 'v1.4.5', output, image, nativeRuntime],
      {
        cwd: ROOT,
        encoding: 'utf8',
      },
    );
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const archive = path.join(output, 'kassinao-ops-v1.4.5.tar.gz');
    const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
    expect(listing.status, listing.stderr).toBe(0);
    expect(listing.stdout).toContain('docker-compose.yml');
    expect(listing.stdout).toContain('compose.env.example');
    expect(listing.stdout).toContain('app.env.example');
    expect(listing.stdout).toContain('scripts/deploy-release.sh');
    expect(listing.stdout).toContain('scripts/prepare-storage.sh');
    expect(listing.stdout).toContain('scripts/prepare-shared-storage.sh');
    expect(listing.stdout).toContain('scripts/validate-legacy-dedicated-installation.sh');
    expect(listing.stdout).toContain('scripts/remove-legacy-health-watch.sh');
    expect(listing.stdout).toContain('scripts/remove-legacy-dedicated-host-controls.sh');
    expect(listing.stdout).toContain('scripts/prepare-legacy-shared-layout.sh');
    expect(listing.stdout).toContain('scripts/migrate-shared-storage.sh');
    expect(listing.stdout).toContain('scripts/check-shared-migration-rollback.sh');
    expect(listing.stdout).toContain('scripts/finalize-shared-migration.sh');
    expect(listing.stdout).toContain('scripts/harden-docker-egress.sh');
    expect(listing.stdout).toContain('scripts/egress-fail-closed.sh');
    expect(listing.stdout).toContain('scripts/install-host-controls.sh');
    expect(listing.stdout).toContain('scripts/uninstall-host-controls.sh');
    expect(listing.stdout).toContain('scripts/uninstall-shared-host-controls.sh');
    expect(listing.stdout).toContain('scripts/audit-shared-vps-security.sh');
    expect(listing.stdout).toContain('deploy/systemd/kassinao-docker-egress.service');
    expect(listing.stdout).toContain('deploy/systemd/kassinao-egress-fail-closed.service');
    expect(listing.stdout).toContain('deploy/systemd/kassinao-rollback-clean.service.in');
    expect(listing.stdout).toContain('deploy/systemd/kassinao-rollback-clean.timer');
    expect(listing.stdout).toContain('deploy/systemd/docker.service.d/kassinao-egress.conf');
    expect(listing.stdout).toContain('deploy/tmpfiles.d/kassinao.conf');
    expect(listing.stdout).toContain('deploy/tmpfiles.d/kassinao-rollback.conf.in');
    expect(listing.stdout).toContain('runtime/linux-amd64/kassinao-no-dump');
    expect(listing.stdout).toContain('runtime/linux-amd64/libkassinao-no-dump.so');
    expect(listing.stdout).toContain('runtime/linux-arm64/kassinao-no-dump');
    expect(listing.stdout).toContain('runtime/linux-arm64/libkassinao-no-dump.so');
    expect(listing.stdout).not.toMatch(/(?:^|\/)src\//m);
    expect(listing.stdout).not.toMatch(/(?:^|\/)\.git(?:\/|$)/m);
    const env = spawnSync('tar', ['-xOf', archive, 'kassinao-ops-v1.4.5/compose.env.example'], { encoding: 'utf8' });
    expect(env.status, env.stderr).toBe(0);
    expect(env.stdout).toContain(`KASSINAO_IMAGE=${image}`);
    expect(env.stdout).toContain(`KASSINAO_RELEASE_DIGEST=${digest}`);
    expect(env.stdout).toContain('KASSINAO_DEPLOYMENT_FINGERPRINT=');
    const checksum = readFileSync(`${archive}.sha256`, 'utf8');
    expect(checksum).toMatch(new RegExp(`^[0-9a-f]{64}  ${path.basename(archive)}\\n$`));
    const verboseListing = spawnSync('tar', ['-tvzf', archive], { encoding: 'utf8' });
    expect(verboseListing.status, verboseListing.stderr).toBe(0);
    expect(verboseListing.stdout).not.toContain(process.env.USER ?? '__no_local_user__');
    expect(verboseListing.stdout).not.toContain(' staff ');
    const manifest = spawnSync('tar', ['-xOf', archive, 'kassinao-ops-v1.4.5/MANIFEST.sha256'], {
      encoding: 'utf8',
    });
    expect(manifest.status, manifest.stderr).toBe(0);
    expect(manifest.stdout).toMatch(/[0-9a-f]{64}  \.\/scripts\/prepare-storage\.sh/);
    expect(manifest.stdout).toMatch(/[0-9a-f]{64}  \.\/scripts\/validate-legacy-dedicated-installation\.sh/);
    expect(manifest.stdout).toMatch(/[0-9a-f]{64}  \.\/scripts\/remove-legacy-health-watch\.sh/);
    expect(manifest.stdout).toMatch(/[0-9a-f]{64}  \.\/scripts\/remove-legacy-dedicated-host-controls\.sh/);
    expect(manifest.stdout).toMatch(/[0-9a-f]{64}  \.\/scripts\/prepare-legacy-shared-layout\.sh/);
    expect(manifest.stdout).toMatch(/[0-9a-f]{64}  \.\/scripts\/check-shared-migration-rollback\.sh/);
    expect(manifest.stdout).toMatch(/[0-9a-f]{64}  \.\/scripts\/finalize-shared-migration\.sh/);
    expect(manifest.stdout).toMatch(/[0-9a-f]{64}  \.\/runtime\/linux-amd64\/kassinao-no-dump/);
    expect(manifest.stdout).toMatch(/[0-9a-f]{64}  \.\/runtime\/linux-arm64\/libkassinao-no-dump\.so/);
  });

  it('prepara somente os quatro filhos depois de provar o DATA_ROOT criptografado', () => {
    const fixture = storagePreparationFixture();
    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(statSync(fixture.dataRoot).mode & 0o777).toBe(0o700);
    for (const child of fixture.children) {
      expect(existsSync(child), child).toBe(true);
      expect(statSync(child).isDirectory(), child).toBe(true);
      expect(statSync(child).mode & 0o777, child).toBe(0o700);
    }
    const verifierCalls = readFileSync(fixture.verifierLog, 'utf8').trim().split('\n');
    expect(verifierCalls).toEqual([fixture.dataRoot, [fixture.dataRoot, ...fixture.children].join(' ')]);
    const mutations = readFileSync(fixture.mutationLog, 'utf8');
    for (const child of fixture.children)
      expect(mutations).toContain(`chown:-- ${fixture.uid}:${fixture.gid} ${child}`);
    expect(mutations).not.toContain(fixture.dataRoot + '\n');
  });

  it('não cria nem normaliza filho algum antes de o DATA_ROOT passar no gate LUKS', () => {
    const fixture = storagePreparationFixture({ verifierFails: true });
    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('não passou na prova dm-crypt/LUKS');
    for (const child of fixture.children) expect(existsSync(child), child).toBe(false);
    expect(readFileSync(fixture.verifierLog, 'utf8').trim()).toBe(fixture.dataRoot);
    expect(existsSync(fixture.mutationLog)).toBe(false);
  });

  it('recusa executar como não-root antes de verificar storage ou alterar diretórios', () => {
    const fixture = storagePreparationFixture({ reportedUid: 1000 });
    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('execute como root');
    expect(existsSync(fixture.verifierLog)).toBe(false);
    expect(existsSync(fixture.mutationLog)).toBe(false);
    for (const child of fixture.children) expect(existsSync(child), child).toBe(false);
  });

  it('recusa kit adulterado ou sem ownership root antes do gate LUKS', () => {
    for (const scenario of ['tampered', 'bad-owner'] as const) {
      const fixture = storagePreparationFixture({ badBundleOwnership: scenario === 'bad-owner' });
      if (scenario === 'tampered') writeFileSync(fixture.script, '\n# adulterado\n', { flag: 'a' });
      const result = spawnSync('bash', [fixture.script], {
        cwd: fixture.directory,
        env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
      });

      expect(result.status, scenario).not.toBe(0);
      expect(result.stderr, scenario).toMatch(/integridade do kit|não pertence a root:root/);
      expect(existsSync(fixture.verifierLog), scenario).toBe(false);
      expect(existsSync(fixture.mutationLog), scenario).toBe(false);
      for (const child of fixture.children) expect(existsSync(child), `${scenario}:${child}`).toBe(false);
    }
  });

  it('recusa filho symlink sem tocar no alvo nem criar os demais diretórios', () => {
    const fixture = storagePreparationFixture();
    const outside = path.join(fixture.directory, 'outside');
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, fixture.children[0]!);
    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('irregular ou symlink');
    expect(readFileSync(fixture.verifierLog, 'utf8').trim()).toBe(fixture.dataRoot);
    expect(existsSync(fixture.mutationLog)).toBe(false);
    for (const child of fixture.children.slice(1)) expect(existsSync(child), child).toBe(false);
    expect(statSync(outside).mode & 0o777).toBe(0o700);
  });

  it('protege também o publish MCP contra tag antiga, movida ou artefato divergente', () => {
    const workflow = repositoryFile('.github/workflows/publish-mcp.yml');
    const actions = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);

    expect(actions.length).toBeGreaterThanOrEqual(2);
    expect(actions.every((action) => /@[0-9a-f]{40}$/.test(action))).toBe(true);
    expect(workflow).toContain('vars.MCP_RELEASE_TAG_RULESET_ENABLED');
    expect(workflow).toContain('test "$(git cat-file -t "$tag_oid")" = tag');
    expect(workflow).toContain('test "$release_commit" = "$main_commit"');
    expect(workflow).toContain('git ls-remote --refs origin "$GITHUB_REF"');
    expect(workflow).toContain('npm publish "$RUNNER_TEMP/kassinao-mcp-$version.tgz" --access public --provenance');
    expect(workflow).toContain('npm test -- --run tests/mcp-client.test.ts');
    expect(workflow).toContain('published_integrity');
    expect(workflow).toContain('expected_integrity');
  });

  it('coordena deploy, backup e watchdog pelo mesmo lock de manutenção', () => {
    const deploy = repositoryFile('scripts/deploy-release.sh');
    const backup = repositoryFile('scripts/backup.sh');
    const watchdog = repositoryFile('scripts/health-watch.sh');

    for (const script of [deploy, backup, watchdog]) {
      expect(script).toContain('RUNTIME_DIR=/run/lock/kassinao');
      expect(script).not.toContain('KASSINAO_RUNTIME_DIR:-/run/lock/kassinao');
      expect(script).toContain('$RUNTIME_DIR/maintenance.lock');
      expect(script).not.toContain('kassinao-maintenance.lock');
    }
    expect(deploy).toContain('flock -w 120 8');
    expect(backup).toContain('flock -w 120 9');
    expect(watchdog).toContain('flock -n 9 || exit 0');
  });

  it('prende todos os controles que tocam dados ao daemon Docker local da VPS', () => {
    const paths = [
      'scripts/deploy-release.sh',
      'scripts/audit-vps-security.sh',
      'scripts/harden-docker-egress.sh',
      'scripts/health-watch.sh',
      'scripts/backup.sh',
    ];
    for (const file of paths) {
      const script = repositoryFile(file);
      expect(script, file).toContain('DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY');
      expect(script, file).toContain('export DOCKER_HOST=unix:///var/run/docker.sock');
      expect(script, file).toContain('unset DOCKER_CONTEXT DOCKER_TLS_VERIFY');
      expect(script, file).toMatch(/DOCKER_CONFIG="?\$[^\n]*deploy\/docker-client/);
      expect(script, file).toContain('export DOCKER_CONFIG');
    }
    const deploy = repositoryFile('scripts/deploy-release.sh');
    expect(deploy.indexOf('seal_local_docker')).toBeLessThan(deploy.indexOf('require_private_file'));
    expect(deploy).toContain('"DOCKER_HOST=$DOCKER_HOST"');
  });
});

describe('bootstrap da identidade privada', () => {
  it('exige origens e guild próprias, grava em 0600 e não ecoa segredos', () => {
    const fixture = bootstrapFixture();
    const botToken = 'dummy-bot-secret-not-real';
    const oauthSecret = 'dummy-oauth-secret-not-real';
    const input = [
      botToken,
      '123456789012345678',
      oauthSecret,
      'https://app.example.com',
      'https://www.example.com',
      'https://docs.example.com',
      '',
      'https://github.com/example/kassinao',
      'Example Operator',
      'mailto:privacy@example.com',
      '',
      '987654321098765432',
      '',
      '2026-07-14',
      '1.0',
      'Members of the configured Discord servers',
      'Record meetings and provide operator-enabled outputs',
      'Operator-defined organizational necessity',
      'Example Cloud',
      'Brazil',
      '',
      '',
      'Container host and provider logs expire after thirty days',
      '',
      'Requests are verified and answered through the operator contact',
      '',
      '',
      'Incidents are triaged contained investigated and communicated',
      '',
    ].join('\n');
    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      input,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: fixture.directory,
        KASSINAO_APP_ENV_FILE: 'app.env',
        KASSINAO_COMPOSE_ENV_FILE: '.env',
      },
    });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(botToken);
    expect(`${result.stdout}${result.stderr}`).not.toContain(oauthSecret);
    const app = activeEnvironment(readFileSync(fixture.appEnv, 'utf8'));
    const compose = activeEnvironment(readFileSync(fixture.composeEnv, 'utf8'));
    expect(app.get('APP_URL')).toBe('https://app.example.com');
    expect(app.get('BASE_URL')).toBe('');
    expect(app.get('PUBLIC_URL')).toBe('https://www.example.com');
    expect(app.get('DOCS_URL')).toBe('https://docs.example.com');
    expect(app.get('MCP_URL')).toBe('https://app.example.com');
    expect(app.get('SOURCE_URL')).toBe('https://github.com/example/kassinao');
    expect(app.get('OPERATOR_NAME')).toBe('Example Operator');
    expect(app.get('OPERATOR_CONTACT_URL')).toBe('mailto:privacy@example.com');
    expect(app.get('PRIVACY_POLICY_URL')).toBe('https://app.example.com/privacy');
    expect(app.get('DATA_DELETION_URL')).toBe('https://app.example.com/privacy#data-rights');
    expect(app.get('TERMS_OF_SERVICE_URL')).toBe('');
    expect(app.get('KASSINAO_ROLLBACK_RETENTION_HOURS')).toBe('72');
    expect(app.get('ALLOWED_GUILD_IDS')).toBe('987654321098765432');
    expect(app.get('ALLOW_ALL_GUILDS')).toBe('false');
    expect(app.get('PUBLIC_SURFACES_ENABLED')).toBe('false');
    expect(compose.get('KASSINAO_DEPLOYMENT_MODE')).toBe('split');
    expect(compose.get('KASSINAO_DEPLOYMENT_FINGERPRINT')).toMatch(/^[0-9a-f]{32}$/);
    expect(compose.get('KASSINAO_UID')).toBe(String(process.getuid?.()));
    expect(compose.get('KASSINAO_GID')).toBe(String(process.getgid?.()));
    expect(compose.get('COMPOSE_PROFILES')).toBe('split-public');
    expect(compose.get('TUNNEL_TOKEN')).toBe('');
    expect(compose.get('KASSINAO_ROLLBACK_RETENTION_HOURS')).toBe('72');
    expect(compose.get('SOURCE_URL')).toBe('https://github.com/example/kassinao');
    expect(readFileSync(fixture.appEnv, 'utf8')).not.toContain('kassinao.cloud');
  });

  it('falha antes de alterar os arquivos quando a topologia split mistura hosts', () => {
    const fixture = bootstrapFixture();
    const beforeApp = readFileSync(fixture.appEnv, 'utf8');
    const beforeCompose = readFileSync(fixture.composeEnv, 'utf8');
    const input = [
      'dummy-bot-secret-not-real',
      '123456789012345678',
      'dummy-oauth-secret-not-real',
      'https://app.example.com',
      'https://www.example.com',
      'https://www.example.com',
      '',
      '',
    ].join('\n');
    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      input,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: fixture.directory,
        KASSINAO_APP_ENV_FILE: 'app.env',
        KASSINAO_COMPOSE_ENV_FILE: '.env',
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('hosts próprios');
    expect(readFileSync(fixture.appEnv, 'utf8')).toBe(beforeApp);
    expect(readFileSync(fixture.composeEnv, 'utf8')).toBe(beforeCompose);
  });

  it('grava hostname, trailing dot e porta default em forma canônica', () => {
    const fixture = bootstrapFixture();
    const input = [
      'dummy-bot-secret-not-real',
      '123456789012345678',
      'dummy-oauth-secret-not-real',
      'https://APP.Example.com.:0443',
      'https://WWW.Example.com.:443',
      'https://DOCS.Example.com.:00443',
      'https://MCP.Example.com.:08443',
      'https://GitHub.com/example/kassinao',
      'Example Operator',
      'https://privacy.example.com/contact',
      'https://privacy.example.com/terms',
      '987654321098765432',
      '',
      '2026-07-14',
      '1.0',
      'Members of the configured Discord servers',
      'Record meetings and provide operator-enabled outputs',
      'Operator-defined organizational necessity',
      'Example Cloud',
      'Brazil',
      '',
      '',
      'Container host and provider logs expire after thirty days',
      '',
      'Requests are verified and answered through the operator contact',
      '',
      '',
      'Incidents are triaged contained investigated and communicated',
      '',
    ].join('\n');
    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      input,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: fixture.directory,
        KASSINAO_APP_ENV_FILE: 'app.env',
        KASSINAO_COMPOSE_ENV_FILE: '.env',
      },
    });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    for (const file of [fixture.appEnv, fixture.composeEnv]) {
      const env = activeEnvironment(readFileSync(file, 'utf8'));
      expect(env.get('APP_URL')).toBe('https://app.example.com');
      expect(env.get('MCP_URL')).toBe('https://mcp.example.com:8443');
      expect(env.get('PUBLIC_URL')).toBe('https://www.example.com');
      expect(env.get('DOCS_URL')).toBe('https://docs.example.com');
    }
    const app = activeEnvironment(readFileSync(fixture.appEnv, 'utf8'));
    expect(app.get('PRIVACY_POLICY_URL')).toBe('https://app.example.com/privacy');
    expect(app.get('DATA_DELETION_URL')).toBe('https://app.example.com/privacy#data-rights');
    expect(app.get('TERMS_OF_SERVICE_URL')).toBe('https://privacy.example.com/terms');
    expect(app.get('SOURCE_URL')).toBe('https://github.com/example/kassinao');
  });

  it('não permite separar landing e docs apenas por case, trailing dot ou porta default', () => {
    const fixture = bootstrapFixture();
    const beforeApp = readFileSync(fixture.appEnv, 'utf8');
    const beforeCompose = readFileSync(fixture.composeEnv, 'utf8');
    const input = [
      'dummy-bot-secret-not-real',
      '123456789012345678',
      'dummy-oauth-secret-not-real',
      'https://app.example.com',
      'https://shared.example.com',
      'https://SHARED.Example.com.:0443',
      '',
      '',
    ].join('\n');
    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      input,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: fixture.directory,
        KASSINAO_APP_ENV_FILE: 'app.env',
        KASSINAO_COMPOSE_ENV_FILE: '.env',
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('hosts próprios');
    expect(readFileSync(fixture.appEnv, 'utf8')).toBe(beforeApp);
    expect(readFileSync(fixture.composeEnv, 'utf8')).toBe(beforeCompose);
  });

  it('continua recusando caminho, query e credenciais durante a canonicalização', () => {
    for (const invalidOrigin of [
      'https://example.com/path',
      'https://example.com?debug=1',
      'https://user@example.com',
      'https://example.com\\path',
      'https://example.com:',
    ]) {
      const fixture = bootstrapFixture();
      const beforeApp = readFileSync(fixture.appEnv, 'utf8');
      const beforeCompose = readFileSync(fixture.composeEnv, 'utf8');
      const input = [
        'dummy-bot-secret-not-real',
        '123456789012345678',
        'dummy-oauth-secret-not-real',
        invalidOrigin,
        '',
      ].join('\n');
      const result = spawnSync('bash', [fixture.script], {
        cwd: fixture.directory,
        input,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: fixture.directory,
          KASSINAO_APP_ENV_FILE: 'app.env',
          KASSINAO_COMPOSE_ENV_FILE: '.env',
        },
      });

      expect(result.status, invalidOrigin).not.toBe(0);
      expect(readFileSync(fixture.appEnv, 'utf8')).toBe(beforeApp);
      expect(readFileSync(fixture.composeEnv, 'utf8')).toBe(beforeCompose);
    }
  });

  it('recusa SOURCE_URL não pública antes de gravar a identidade da instância', () => {
    const fixture = bootstrapFixture();
    const beforeApp = readFileSync(fixture.appEnv, 'utf8');
    const beforeCompose = readFileSync(fixture.composeEnv, 'utf8');
    const input = [
      'dummy-bot-secret-not-real',
      '123456789012345678',
      'dummy-oauth-secret-not-real',
      'https://app.example.com',
      'https://www.example.com',
      'https://docs.example.com',
      '',
      'http://git.internal/example/kassinao',
      '',
    ].join('\n');
    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      input,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: fixture.directory,
        KASSINAO_APP_ENV_FILE: 'app.env',
        KASSINAO_COMPOSE_ENV_FILE: '.env',
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('SOURCE_URL');
    expect(readFileSync(fixture.appEnv, 'utf8')).toBe(beforeApp);
    expect(readFileSync(fixture.composeEnv, 'utf8')).toBe(beforeCompose);
  });
});

describe('deploy image-only', () => {
  it('recusa endpoint Docker herdado antes de tocar o kit privado', () => {
    const fixture = deploymentFixture(`ghcr.io/example/kassinao@sha256:${'1'.repeat(64)}`);
    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        DOCKER_HOST: 'tcp://attacker.invalid:2375',
      },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('daemon local da VPS');
  });

  it('não aceita topologia split separada apenas por case, trailing dot ou porta default', () => {
    const digest = `sha256:${'6'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image, { mode: 'split' });
    for (const file of [path.join(fixture.directory, '.env'), path.join(fixture.directory, 'app.env')]) {
      replaceEnvironmentValue(file, 'PUBLIC_URL', 'https://shared.example.com');
      replaceEnvironmentValue(file, 'DOCS_URL', 'https://SHARED.Example.com.:0443');
    }

    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('hosts próprios');
  });

  it('compara .env e app.env pelas origens canônicas', () => {
    const digest = `sha256:${'7'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image);
    replaceEnvironmentValue(path.join(fixture.directory, 'app.env'), 'APP_URL', 'https://APP.Example.com.:0443');
    replaceEnvironmentValue(path.join(fixture.directory, 'app.env'), 'MCP_URL', 'https://APP.Example.com.:0443');
    replaceEnvironmentValue(path.join(fixture.directory, 'app.env'), 'PUBLIC_URL', 'https://WWW.Example.com.:0443');
    replaceEnvironmentValue(path.join(fixture.directory, 'app.env'), 'DOCS_URL', 'https://DOCS.Example.com.:0443');

    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
  });

  it('recusa metadata operacional ausente, contato privado ou política fora da APP_URL', () => {
    const digest = `sha256:${'8'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    for (const [key, value, message] of [
      ['OPERATOR_CONTACT_URL', '', 'OPERATOR_CONTACT_URL precisa ser configurada'],
      ['OPERATOR_NAME', '   ', 'OPERATOR_NAME precisa ter até 160 caracteres'],
      ['OPERATOR_CONTACT_URL', 'https://operator.internal/contact', 'OPERATOR_CONTACT_URL precisa ser página HTTPS'],
      ['PRIVACY_POLICY_URL', 'https://privacy.example.com/policy', 'PRIVACY_POLICY_URL precisa ser exatamente'],
      ['DATA_DELETION_URL', 'https://privacy.example.com/delete', 'DATA_DELETION_URL precisa ser exatamente'],
      ['PRIVACY_AUDIENCE', '', 'PRIVACY_AUDIENCE precisa ser configurada'],
      ['PRIVACY_AUDIENCE', 'Data from recorder.internal', 'PRIVACY_AUDIENCE precisa ser descrição pública'],
      ['PRIVACY_EFFECTIVE_DATE', '2999-01-01', 'PRIVACY_EFFECTIVE_DATE precisa ser uma data real e não futura'],
      ['EDGE_REGION', 'global', 'EDGE_PROVIDER e EDGE_REGION precisam ser ambos none'],
      ['BACKUP_STATUS', 'enabled', 'BACKUP_PROVIDER precisa identificar o provedor real'],
      ['DATA_REQUEST_RESPONSE_DAYS', '0', 'DATA_REQUEST_RESPONSE_DAYS precisa ficar entre 1 e 365'],
      ['INCIDENT_CONTACT_URL', 'https://security.internal/contact', 'INCIDENT_CONTACT_URL precisa ser página HTTPS'],
      ['SOURCE_URL', '', 'SOURCE_URL precisa ser configurada'],
      ['SOURCE_URL', 'https://github.com/different/kassinao', 'SOURCE_URL diverge entre .env e app.env'],
    ] as const) {
      const fixture = deploymentFixture(image);
      replaceEnvironmentValue(path.join(fixture.directory, 'app.env'), key, value);
      const result = spawnSync('bash', [fixture.script], {
        cwd: fixture.directory,
        env: {
          ...process.env,
          PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
          KASSINAO_DEPLOY_DIR: fixture.directory,
          KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
        },
        encoding: 'utf8',
      });
      expect(result.status, key).not.toBe(0);
      expect(result.stderr, key).toContain(message);
    }
  }, 15_000);

  it('exige aceite host-wide e retenção idêntica entre os dois ambientes', () => {
    const digest = `sha256:${'9'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    for (const [file, key, value, message] of [
      ['.env', 'KASSINAO_DEDICATED_DOCKER_HOST_ACK', '', 'pre-hooks controlam o docker.service inteiro'],
      ['app.env', 'KASSINAO_ROLLBACK_RETENTION_HOURS', '48', 'diverge entre .env e app.env'],
      ['.env', 'KASSINAO_ROLLBACK_RETENTION_HOURS', '169', 'precisa ficar entre 1 e 168'],
    ] as const) {
      const fixture = deploymentFixture(image);
      replaceEnvironmentValue(path.join(fixture.directory, file), key, value);
      const result = spawnSync('bash', [fixture.script], {
        cwd: fixture.directory,
        env: {
          ...process.env,
          PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
          KASSINAO_DEPLOY_DIR: fixture.directory,
          KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
        },
        encoding: 'utf8',
      });
      expect(result.status, key).not.toBe(0);
      expect(result.stderr, key).toContain(message);
      const calls = existsSync(fixture.runtime.log) ? readFileSync(fixture.runtime.log, 'utf8') : '';
      expect(calls, key).not.toMatch(/\bpull\b/);
    }
  });

  it('usa o adapter shared sem aceite dedicado, com overlay e verifier vinculados ao .env privado', () => {
    const digest = `sha256:${'b'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image, { hostScope: 'shared' });

    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const storageCalls = readFileSync(path.join(fixture.directory, 'hardener.log'), 'utf8');
    expect(storageCalls).toContain(`shared-storage:${path.join(fixture.directory, '.env')}:\n`);
    expect(storageCalls).not.toMatch(/^storage:/m);
    expect(storageCalls).toContain('shared-audit:--preflight\n');
    expect(storageCalls).toContain(`rollback-check:${path.join(fixture.directory, '.env')}:\n`);
    expect(storageCalls).toContain('shared-audit:\n');
    const dockerCalls = readFileSync(fixture.runtime.log, 'utf8');
    expect(dockerCalls).toContain(`-f ${path.join(fixture.directory, 'docker-compose.shared.yml')}`);
    expect(dockerCalls).toContain('.HostConfig.Memory');
    expect(dockerCalls).toContain('up -d --no-build');
    expect(dockerCalls).toContain('--force-recreate');
    expect(dockerCalls).not.toContain('up -d --no-build --remove-orphans');
  });

  it('aceita MemorySwappiness null do Docker 29 quando MemorySwap iguala Memory', () => {
    const digest = `sha256:${'c'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image, {
      hostScope: 'shared',
      runtimeMemorySwappiness: null,
    });

    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
  });

  it.each([
    ['swappiness explícita permissiva', { runtimeMemorySwappiness: 60 }],
    ['swap disponível apesar de swappiness null', { runtimeMemorySwap: 1_073_741_824, runtimeMemorySwappiness: null }],
  ])('mantém o gate shared fechado para %s', (_scenario, runtime) => {
    const digest = `sha256:${'d'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image, { hostScope: 'shared', ...runtime });

    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('gate shared de memória sem swap/restart fail-closed');
  });

  it('mantém o core parado quando o checker shared reprova o rollback plaintext', () => {
    const digest = `sha256:${'6'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image, {
      hostScope: 'shared',
      initiallyRunning: true,
      rollbackCheckerFails: true,
    });

    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('rollback plaintext inválido ou expirado; core continuará parado');
    expect(result.stderr).not.toContain(fixture.directory);
    const calls = readFileSync(fixture.runtime.log, 'utf8');
    expect(calls).not.toContain('up -d --no-build');
    expect(calls).not.toMatch(/^start /m);
    expect(result.stderr).toContain('gates fail-closed não foram aprovados');
  });

  it('remove somente pelo ID imutável o túnel oficial parado de um profile desabilitado', () => {
    const digest = `sha256:${'3'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image, { hostScope: 'shared', staleDisabledTunnel: 'safe' });

    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const calls = readFileSync(fixture.runtime.log, 'utf8');
    const immutableId = 'd'.repeat(64);
    const removeAt = calls.indexOf(`rm ${immutableId}\n`);
    const upAt = calls.indexOf('up -d --no-build');
    expect(calls).toContain('inspect --format {{.Id}} kassinao-tunnel');
    expect(calls).toContain(`inspect --format {{.Id}}|{{.Name}}|`);
    expect(removeAt).toBeGreaterThanOrEqual(0);
    expect(upAt).toBeGreaterThan(removeAt);
    expect(calls).not.toMatch(/^rm kassinao-tunnel$/m);
    expect(calls).not.toContain('--remove-orphans');
  });

  it.each(['running', 'restart-policy', 'foreign-project'] as const)(
    'recusa remover túnel desabilitado cuja identidade ficou insegura: %s',
    (staleDisabledTunnel) => {
      const digest = `sha256:${'4'.repeat(64)}`;
      const image = `ghcr.io/example/kassinao@${digest}`;
      const fixture = deploymentFixture(image, { hostScope: 'shared', staleDisabledTunnel });

      const result = spawnSync('bash', [fixture.script], {
        cwd: fixture.directory,
        env: {
          ...process.env,
          PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
          KASSINAO_DEPLOY_DIR: fixture.directory,
          KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
        },
        encoding: 'utf8',
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('falhou na revalidação de identidade');
      const calls = readFileSync(fixture.runtime.log, 'utf8');
      expect(calls).not.toMatch(/^rm /m);
      expect(calls).not.toContain('up -d --no-build');
    },
  );

  it('recusa workload vizinho inseguro antes de pull ou start no adapter shared', () => {
    const digest = `sha256:${'1'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image, { hostScope: 'shared', sharedAuditPreflightFails: true });

    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('preflight shared recusou');
    const calls = readFileSync(fixture.runtime.log, 'utf8');
    expect(calls).not.toMatch(/\bpull\b/);
    expect(calls).not.toMatch(/\bup -d\b/);
  });

  it('contém a tentativa shared quando o audit completo recusa o runtime novo', () => {
    const digest = `sha256:${'0'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image, { hostScope: 'shared', sharedAuditFullFails: true });

    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('audit final shared recusou');
    const calls = readFileSync(fixture.runtime.log, 'utf8');
    expect(calls).toContain('up -d --no-build');
    expect(calls).toContain(`stop --timeout 30 ${'a'.repeat(64)}`);
    expect(calls).not.toContain('curl https://app.example.com/health');
    expect(existsSync(path.join(fixture.directory, '.deployed-image'))).toBe(false);
  });

  it('não contém por nome um container alheio que ocupou kassinao durante uma falha', () => {
    const digest = `sha256:${'8'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image, { upFails: true, failureNameSquatter: true });

    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('nome reservado ocupado por container alheio');
    const calls = readFileSync(fixture.runtime.log, 'utf8');
    const foreignId = 'f'.repeat(64);
    expect(calls).toContain(`inspect --format {{.Id}} kassinao`);
    expect(calls).toContain(`inspect --format {{.Id}}|{{.Name}}|`);
    expect(calls).not.toContain(`stop --timeout 30 ${foreignId}`);
    expect(calls).not.toContain('stop --timeout 30 kassinao\n');
  });

  it('recusa misturar o aceite do daemon dedicado com KASSINAO_HOST_SCOPE=shared', () => {
    const digest = `sha256:${'c'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image, { hostScope: 'shared' });
    replaceEnvironmentValue(
      path.join(fixture.directory, '.env'),
      'KASSINAO_DEDICATED_DOCKER_HOST_ACK',
      'I_UNDERSTAND_THIS_VPS_MUST_RUN_ONLY_KASSINAO',
    );

    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('adapter shared exige KASSINAO_DEDICATED_DOCKER_HOST_ACK vazio');
    const calls = existsSync(fixture.runtime.log) ? readFileSync(fixture.runtime.log, 'utf8') : '';
    expect(calls).not.toMatch(/\bpull\b/);
  });

  it('recusa DATA_ROOT invisível ao sandbox persistente de limpeza', () => {
    const digest = `sha256:${'2'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image);
    replaceEnvironmentValue(path.join(fixture.directory, '.env'), 'KASSINAO_DATA_ROOT', '/home/kassinao');

    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('área isolada por ProtectHome/PrivateTmp');
    const calls = existsSync(fixture.runtime.log) ? readFileSync(fixture.runtime.log, 'utf8') : '';
    expect(calls).not.toMatch(/\bpull\b/);
  });

  it('não deixa um túnel ativo ser omitido da política canônica', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image);
    replaceEnvironmentValue(path.join(fixture.directory, '.env'), 'COMPOSE_PROFILES', 'tunnel,split-public');
    replaceEnvironmentValue(path.join(fixture.directory, '.env'), 'TUNNEL_TOKEN', 'test-tunnel-token');

    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('profile tunnel exige declarar EDGE_PROVIDER e EDGE_REGION reais');
    const calls = existsSync(fixture.runtime.log) ? readFileSync(fixture.runtime.log, 'utf8') : '';
    expect(calls).not.toMatch(/\bpull\b/);
  });

  it('recusa topologia single no kit operacional de produção', () => {
    const digest = `sha256:${'3'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image, { mode: 'single' });

    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('aceita somente KASSINAO_DEPLOYMENT_MODE=split');
  });

  it('recusa executar dentro de qualquer checkout Git antes de ler segredos ou chamar Docker', () => {
    const fixture = deploymentFixture(`ghcr.io/example/kassinao@sha256:${'2'.repeat(64)}`);
    mkdirSync(path.join(fixture.directory, '.git'));

    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: { ...process.env, KASSINAO_DEPLOY_DIR: fixture.directory },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/diretório operacional privado|fora de qualquer Git/);
  });

  it('recusa também um subdiretório aparentemente privado dentro de um checkout Git', () => {
    const fixture = deploymentFixture(`ghcr.io/example/kassinao@sha256:${'3'.repeat(64)}`);
    mkdirSync(path.join(fixture.directory, '.git'));
    const directory = path.join(fixture.directory, 'private-runtime');
    mkdirSync(directory, { mode: 0o700 });
    const result = spawnSync('bash', [fixture.script], {
      cwd: directory,
      env: { ...process.env, KASSINAO_DEPLOY_DIR: directory },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/fora de qualquer Git|exatamente a raiz do kit selado/);
  });

  it('recusa tag mutável e exige image@sha256', () => {
    const fixture = deploymentFixture('ghcr.io/example/kassinao:latest');
    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('@sha256:<64 hex>');
  });

  it('recusa iniciar quando o host não prova storage ativo em dm-crypt/LUKS', () => {
    const digest = `sha256:${'2'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image, { storageVerifierFails: true });
    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('dm-crypt/LUKS verification gate');
    expect(existsSync(path.join(fixture.directory, '.deployed-image'))).toBe(false);
  });

  it('faz pull do digest aprovado e sobe sem permitir build de fonte', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image);
    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const calls = readFileSync(fixture.runtime.log, 'utf8');
    expect(calls).toMatch(/\bpull\b/);
    expect(calls).toContain('up -d --no-build --force-recreate --remove-orphans');
    expect(calls).not.toMatch(/(^|\s)build(\s|$)/);
    expect(result.stdout).toContain(`digest=${digest}`);
    expect(readFileSync(path.join(fixture.directory, '.deployed-image'), 'utf8').trim()).toBe(image);
    const rollbackDirectory = path.join(fixture.directory, 'data', 'rollback');
    expect(readdirSync(rollbackDirectory).filter((name) => name.startsWith('operational-state-'))).toHaveLength(0);
  });

  it('mantém deploy validado e snapshot retido quando o cleanup final fica inseguro', () => {
    const digest = `sha256:${'b'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image);
    const findmntCalls = path.join(fixture.directory, '.cleanup-findmnt-calls');
    const rollbackGlob = `${path.join(fixture.directory, 'data', 'rollback')}/operational-state-*`;
    writeFileSync(
      path.join(fixture.runtime.bin, 'findmnt'),
      `#!/usr/bin/env bash
set -eu
count=0
[ ! -f ${shellLiteral(findmntCalls)} ] || count="$(cat ${shellLiteral(findmntCalls)})"
count=$((count + 1))
printf '%s\n' "$count" > ${shellLiteral(findmntCalls)}
if [ "$count" -eq 6 ]; then
  chmod 0644 ${rollbackGlob}
fi
printf '%s\n' '{"filesystems":[]}'
`,
      { mode: 0o700 },
    );
    chmodSync(path.join(fixture.runtime.bin, 'findmnt'), 0o700);

    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stderr).toContain('snapshot não foi removido');
    expect(readFileSync(path.join(fixture.directory, '.deployed-image'), 'utf8').trim()).toBe(image);
    const rollbackDirectory = path.join(fixture.directory, 'data', 'rollback');
    expect(readdirSync(rollbackDirectory).filter((name) => name.startsWith('operational-state-'))).toHaveLength(1);
  });

  it('preserva por tempo limitado um snapshot operacional sem autenticação quando a troca falha', () => {
    const digest = `sha256:${'d'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image, { initiallyRunning: true, upFails: true });
    writeFileSync(path.join(fixture.directory, 'data', 'state', 'guildconfig.json'), '{}');
    writeFileSync(path.join(fixture.directory, 'data', 'auth', '.cookie-secret'), 'private-secret');
    const recording = path.join(fixture.directory, 'data', 'recordings', 'meeting-1');
    mkdirSync(recording, { mode: 0o700 });
    writeFileSync(path.join(recording, 'meta.json'), '{"status":"completed"}', { mode: 0o600 });
    writeFileSync(path.join(recording, 'audio.mp3'), 'audio-must-not-enter-rollback', { mode: 0o600 });

    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    const calls = readFileSync(fixture.runtime.log, 'utf8');
    expect(calls.indexOf(' pull')).toBeLessThan(calls.indexOf('stop --timeout 60'));
    const rollbackDirectory = path.join(fixture.directory, 'data', 'rollback');
    const archives = readdirSync(rollbackDirectory).filter((name) => name.startsWith('operational-state-'));
    expect(archives).toHaveLength(1);
    const listing = spawnSync('tar', ['-tzf', path.join(rollbackDirectory, archives[0]!)], {
      encoding: 'utf8',
    });
    expect(listing.status, listing.stderr).toBe(0);
    expect(listing.stdout).toContain('state/guildconfig.json');
    expect(listing.stdout).toContain('recording-meta/meeting-1/meta.json');
    expect(listing.stdout).not.toContain('audio.mp3');
    expect(listing.stdout).not.toContain('auth');
    expect(listing.stdout).not.toContain('cookie-secret');
  });

  it('recusa hardlink de auth para state antes de parar qualquer container', () => {
    const digest = `sha256:${'1'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image, { initiallyRunning: true });
    const authFile = path.join(fixture.directory, 'data', 'auth', '.cookie-secret');
    writeFileSync(authFile, 'private-secret', { mode: 0o600 });
    linkSync(authFile, path.join(fixture.directory, 'data', 'state', 'leaked-auth.json'));

    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('hardlink');
    const calls = readFileSync(fixture.runtime.log, 'utf8');
    expect(calls).not.toContain('stop --timeout 60');
    expect(calls).not.toContain('up -d --no-build');
  });

  it.each(['symlink', 'fifo'] as const)('recusa %s dentro de state antes de parar qualquer container', (entryType) => {
    const digest = `sha256:${'2'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image, { initiallyRunning: true });
    const unsafe = path.join(fixture.directory, 'data', 'state', `unsafe-${entryType}`);
    if (entryType === 'symlink') {
      const authFile = path.join(fixture.directory, 'data', 'auth', '.cookie-secret');
      writeFileSync(authFile, 'private-secret', { mode: 0o600 });
      symlinkSync(authFile, unsafe);
    } else {
      const fifo = spawnSync('mkfifo', [unsafe], { encoding: 'utf8' });
      expect(fifo.status, fifo.stderr).toBe(0);
    }

    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/symlink|FIFO|especial/);
    const calls = readFileSync(fixture.runtime.log, 'utf8');
    expect(calls).not.toContain('stop --timeout 60');
    expect(calls).not.toContain('up -d --no-build');
  });

  it('recusa nested mount em state antes de parar qualquer container', () => {
    const digest = `sha256:${'3'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image, { initiallyRunning: true, snapshotNestedMount: true });

    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('nested mount');
    const calls = readFileSync(fixture.runtime.log, 'utf8');
    expect(calls).not.toContain('stop --timeout 60');
    expect(calls).not.toContain('up -d --no-build');
  });

  it('detecta TOCTOU da fonte durante a geração e não troca para a release nova', () => {
    const digest = `sha256:${'4'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image, { initiallyRunning: true });
    const stateFile = path.join(fixture.directory, 'data', 'state', 'guildconfig.json');
    writeFileSync(stateFile, '{"before":true}\n', { mode: 0o600 });
    const findmntCalls = path.join(fixture.directory, '.snapshot-findmnt-calls');
    writeFileSync(
      path.join(fixture.runtime.bin, 'findmnt'),
      `#!/usr/bin/env bash
set -eu
count=0
[ ! -f ${shellLiteral(findmntCalls)} ] || count="$(cat ${shellLiteral(findmntCalls)})"
count=$((count + 1))
printf '%s\n' "$count" > ${shellLiteral(findmntCalls)}
if [ "$count" -eq 3 ]; then
  printf '{"after":true}\\n' > ${shellLiteral(stateFile)}
fi
printf '%s\n' '{"filesystems":[]}'
`,
      { mode: 0o700 },
    );
    chmodSync(path.join(fixture.runtime.bin, 'findmnt'), 0o700);

    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/mudou durante a geracao|inventario mudou durante a geracao/);
    const calls = readFileSync(fixture.runtime.log, 'utf8');
    expect(calls).toContain(`stop --timeout 60 ${'a'.repeat(64)}`);
    expect(calls).not.toContain('up -d --no-build');
    const rollbackDirectory = path.join(fixture.directory, 'data', 'rollback');
    expect(readdirSync(rollbackDirectory).filter((name) => name.startsWith('operational-state-'))).toHaveLength(0);
  });

  it('não executa tar do PATH e publica somente o archive canônico privado', () => {
    const digest = `sha256:${'5'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image, { initiallyRunning: true, upFails: true });
    const tarWasCalled = path.join(fixture.directory, '.attacker-tar-called');
    writeFileSync(
      path.join(fixture.runtime.bin, 'tar'),
      `#!/usr/bin/env bash
set -eu
touch ${shellLiteral(tarWasCalled)}
exit 73
`,
      { mode: 0o700 },
    );
    chmodSync(path.join(fixture.runtime.bin, 'tar'), 0o700);

    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(existsSync(tarWasCalled)).toBe(false);
    const calls = readFileSync(fixture.runtime.log, 'utf8');
    expect(calls).toContain('up -d --no-build');
    const rollbackDirectory = path.join(fixture.directory, 'data', 'rollback');
    const archives = readdirSync(rollbackDirectory).filter((name) => name.startsWith('operational-state-'));
    expect(archives).toHaveLength(1);
    const archivePath = path.join(rollbackDirectory, archives[0]!);
    const archiveStat = statSync(archivePath);
    expect(archiveStat.mode & 0o777).toBe(0o600);
    expect(archiveStat.nlink).toBe(1);
    expect(archiveStat.uid).toBe(process.geteuid?.() ?? process.getuid?.());
    expect(archiveStat.gid).toBe(process.getegid?.() ?? process.getgid?.());
    const canonical = spawnSync(
      'python3',
      [
        '-c',
        `import json,sys,tarfile,zlib
raw=open(sys.argv[1],'rb').read()
decoder=zlib.decompressobj(16+zlib.MAX_WBITS)
plain=decoder.decompress(raw)+decoder.flush()
with tarfile.open(sys.argv[1], 'r:gz') as archive:
  members=archive.getmembers()
print(json.dumps({
  'gzip_header': list(raw[:8]),
  'eof': decoder.eof,
  'unused': len(decoder.unused_data),
  'tar_zeros': plain[-1024:] == bytes(1024),
  'hidden_metadata': any(
    member.uname or member.gname or member.linkname or
    set(member.pax_headers).difference({'path'})
    for member in members
  ),
  'bad_directory': any(
    member.isdir() and (member.mode != 0o700 or member.size != 0 or int(member.mtime) != 0)
    for member in members
  ),
}))`,
        archivePath,
      ],
      { encoding: 'utf8' },
    );
    expect(canonical.status, canonical.stderr).toBe(0);
    expect(JSON.parse(canonical.stdout)).toEqual({
      gzip_header: [31, 139, 8, 0, 0, 0, 0, 0],
      eof: true,
      unused: 0,
      tar_zeros: true,
      hidden_metadata: false,
      bad_directory: false,
    });
  });

  it.each(['chmod', 'trailing-bytes'] as const)('recusa adulteração pós-geração do archive: %s', (mutation) => {
    const digest = `sha256:${'6'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image, { initiallyRunning: true });
    const findmntCalls = path.join(fixture.directory, `.archive-${mutation}-findmnt-calls`);
    const rollbackGlob = `${path.join(fixture.directory, 'data', 'rollback')}/.operational-state-*`;
    const mutate = mutation === 'chmod' ? `chmod 0644 ${rollbackGlob}` : `printf 'trailing-payload' >> ${rollbackGlob}`;
    writeFileSync(
      path.join(fixture.runtime.bin, 'findmnt'),
      `#!/usr/bin/env bash
set -eu
count=0
[ ! -f ${shellLiteral(findmntCalls)} ] || count="$(cat ${shellLiteral(findmntCalls)})"
count=$((count + 1))
printf '%s\n' "$count" > ${shellLiteral(findmntCalls)}
if [ "$count" -eq 3 ]; then
  ${mutate}
fi
printf '%s\n' '{"filesystems":[]}'
`,
      { mode: 0o700 },
    );
    chmodSync(path.join(fixture.runtime.bin, 'findmnt'), 0o700);

    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/archive nao permaneceu privado|fluxo canonico|mudou durante/);
    const calls = readFileSync(fixture.runtime.log, 'utf8');
    expect(calls).not.toContain('up -d --no-build');
  });

  it('não religa o core anterior no rollback quando o serviço de egress está inativo', () => {
    const digest = `sha256:${'4'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image, {
      initiallyRunning: true,
      egressActive: false,
    });

    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    const calls = readFileSync(fixture.runtime.log, 'utf8');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('core anterior permaneceu parado');
    expect(calls).toContain('systemctl is-active --quiet kassinao-docker-egress.service');
    expect(calls).not.toMatch(/^start /m);
  });

  it('não religa o core anterior no rollback quando a policy de egress diverge', () => {
    const digest = `sha256:${'5'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image, {
      initiallyRunning: true,
      hardenerCheckFails: true,
    });

    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    const calls = readFileSync(fixture.runtime.log, 'utf8');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('core anterior permaneceu parado');
    expect(readFileSync(path.join(fixture.directory, 'hardener.log'), 'utf8')).toContain('--check');
    expect(calls).not.toMatch(/^start /m);
  });

  it('não religa o core anterior shared quando o contrato estático do container parado foi adulterado', () => {
    const digest = `sha256:${'6'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image, {
      hostScope: 'shared',
      initiallyRunning: true,
      snapshotTarFails: true,
      sharedAuditRejectsStoppedContainer: true,
    });

    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    const calls = readFileSync(fixture.runtime.log, 'utf8');
    const gates = readFileSync(path.join(fixture.directory, 'hardener.log'), 'utf8');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('contrato estático shared divergiu');
    expect(gates.match(/shared-audit:--preflight/g)).toHaveLength(2);
    expect(calls).toContain(`stop --timeout 60 ${'a'.repeat(64)}`);
    expect(calls).not.toMatch(/^start /m);
  });

  it('recusa split quando app ou MCP chegam ao processo público', () => {
    const digest = `sha256:${'f'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image, { mode: 'split' });
    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
        FAKE_ALL_SURFACE: 'public',
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('fingerprint/roteamento externo diverge');
    const calls = readFileSync(fixture.runtime.log, 'utf8');
    for (const [container, id] of [
      ['kassinao', 'a'.repeat(64)],
      ['kassinao-tunnel', 'c'.repeat(64)],
      ['kassinao-public', 'b'.repeat(64)],
    ] as const) {
      expect(calls).toContain(`stop --timeout 30 ${id}`);
      expect(result.stderr).toContain(`Container da tentativa falha contido: ${container}`);
    }
  });

  it('aceita split somente quando app/MCP e landing/docs chegam às superfícies corretas', () => {
    const digest = `sha256:${'9'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image, { mode: 'split' });
    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const calls = readFileSync(fixture.runtime.log, 'utf8');
    expect(calls).toContain('curl https://app.example.com/privacy');
    expect(calls).toContain('curl https://app.example.com/en/privacy');
    for (const host of ['www.example.com', 'docs.example.com']) {
      for (const privatePath of ['/app', '/auth/login', '/api/meetings', '/mcp', '/privacy', '/en/privacy']) {
        expect(calls).toContain(`curl https://${host}${privatePath}`);
      }
    }
  });

  it('recusa split quando landing ou docs chegam ao processo privado', () => {
    const digest = `sha256:${'8'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image, { mode: 'split' });
    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
        FAKE_ALL_SURFACE: 'private',
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('fingerprint/roteamento externo diverge');
  });

  it('recusa privilégio ou mount divergente mesmo quando o manifesto do kit é válido', () => {
    const digest = `sha256:${'c'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image, {
      mutateNormalizedConfig(config) {
        const services = config.services as Record<string, Record<string, unknown>>;
        services.kassinao.privileged = true;
      },
    });
    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('perfil de segurança');
    expect(readFileSync(fixture.runtime.log, 'utf8')).not.toMatch(/\bup -d\b/);
  });

  it('recusa SOURCE_URL divergente no ambiente normalizado do processo público', () => {
    const digest = `sha256:${'d'.repeat(64)}`;
    const image = `ghcr.io/example/kassinao@${digest}`;
    const fixture = deploymentFixture(image, {
      mutateNormalizedConfig(config) {
        const services = config.services as Record<string, { environment?: Record<string, string> }>;
        if (services['kassinao-public'].environment) {
          services['kassinao-public'].environment.SOURCE_URL = 'https://github.com/attacker/fork';
        }
      },
    });
    const result = spawnSync('bash', [fixture.script], {
      cwd: fixture.directory,
      env: {
        ...process.env,
        PATH: `${fixture.runtime.bin}:${process.env.PATH ?? ''}`,
        KASSINAO_DEPLOY_DIR: fixture.directory,
        KASSINAO_RUNTIME_DIR: fixture.runtimeDirectory,
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('perfil de segurança');
    expect(readFileSync(fixture.runtime.log, 'utf8')).not.toMatch(/\bup -d\b/);
  });
});
