import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SOURCE = readFileSync(path.join(ROOT, 'scripts', 'remove-legacy-dedicated-host-controls.sh'), 'utf8');

type RaceMutation =
  | 'artifact'
  | 'artifact-identity'
  | 'container'
  | 'current-manifest'
  | 'etc'
  | 'health'
  | 'legacy-env'
  | 'legacy-manifest'
  | 'marker'
  | 'neighbors'
  | 'pid'
  | 'policy'
  | 'rollback'
  | 'runtime'
  | 'shared-env'
  | 'systemd';

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function executable(file: string, contents: string): void {
  writeFileSync(file, contents, { mode: 0o755 });
  chmodSync(file, 0o755);
}

function fixture(
  options: {
    installed?: boolean;
    driftInstalled?: boolean;
    extraEtc?: boolean;
    healthPresent?: boolean;
    legacyContainerRemaining?: boolean;
    markerStatus?: string;
    partial?: boolean;
    dockerPsFailure?: boolean;
    dockerInactive?: boolean;
    extraDockerDropin?: boolean;
    extraDockerHook?: boolean;
    firewallResidual?: boolean;
    residualEffectiveLegacy?: boolean;
    rollbackAfterLocks?: boolean;
    rollbackSnapshot?: boolean;
    raceMutation?: RaceMutation;
    systemctlShowFailure?: boolean;
  } = {},
) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'kassinao-legacy-controls-')));
  chmodSync(root, 0o700);
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const bundle = path.join(root, 'bundle');
  const scripts = path.join(bundle, 'scripts');
  const dockerClient = path.join(bundle, 'deploy', 'docker-client');
  const current = path.join(root, 'current');
  const bin = path.join(root, 'bin');
  const systemd = path.join(root, 'host', 'systemd');
  const sbin = path.join(root, 'host', 'sbin');
  const tmpfiles = path.join(root, 'host', 'tmpfiles');
  const etcKassinao = path.join(root, 'host', 'etc-kassinao');
  const runtime = path.join(root, 'host', 'runtime');
  const oldDataRoot = path.join(root, 'old-data');
  const dataRoot = path.join(root, 'transition-data');
  const calls = path.join(root, 'calls.log');
  const containerRace = path.join(root, 'container-race');
  const neighborRace = path.join(root, 'neighbor-race');
  const pidState = path.join(root, 'docker-main-pid');
  const policyRace = path.join(root, 'policy-race');
  const systemdRace = path.join(root, 'systemd-race');
  for (const directory of [scripts, dockerClient, current, bin, systemd, sbin, tmpfiles, runtime]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  writeFileSync(path.join(dockerClient, 'config.json'), '{}\n', { mode: 0o444 });
  writeFileSync(pidState, '4242\n');

  const installedArtifacts: string[] = [];
  const foreignArtifacts = [
    path.join(systemd, 'company.service'),
    path.join(sbin, 'company-maintenance'),
    path.join(tmpfiles, 'company.conf'),
  ];
  for (const file of foreignArtifacts) writeFileSync(file, 'foreign artifact\n', { mode: 0o644 });

  if (options.installed) {
    const currentScripts = path.join(current, 'scripts');
    const currentSystemd = path.join(current, 'deploy', 'systemd');
    const currentDropins = path.join(currentSystemd, 'docker.service.d');
    const currentTmpfiles = path.join(current, 'deploy', 'tmpfiles.d');
    const dockerDropins = path.join(systemd, 'docker.service.d');
    for (const directory of [currentScripts, currentDropins, currentTmpfiles, dockerDropins, etcKassinao]) {
      mkdirSync(directory, { recursive: true, mode: 0o755 });
    }
    for (const directory of [oldDataRoot, dataRoot, path.join(oldDataRoot, 'rollback')]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    writeFileSync(path.join(runtime, 'maintenance.lock'), '', { mode: 0o600 });

    const hardener = `#!/usr/bin/env bash
printf 'hardener:%s\n' "$*" >> ${shellLiteral(calls)}
if [ "\${1:-}" = --check ] && [ -e ${shellLiteral(policyRace)} ]; then exit 73; fi
case "\${1:-}" in --check|--remove) ;; *) exit 1 ;; esac
`;
    const scriptFiles = [
      ['verify-storage-encryption.sh', '#!/usr/bin/env bash\nexit 0\n'],
      ['harden-docker-egress.sh', hardener],
      ['egress-fail-closed.sh', '#!/usr/bin/env bash\nexit 0\n'],
    ] as const;
    for (const [name, contents] of scriptFiles) {
      const source = path.join(currentScripts, name);
      const destination = path.join(sbin, `kassinao-${name.slice(0, -3)}`);
      executable(source, contents);
      executable(destination, contents);
      installedArtifacts.push(destination);
    }

    const units = [
      ['kassinao-docker-egress.service', '[Service]\nType=oneshot\n'],
      ['kassinao-egress-fail-closed.service', '[Service]\nType=oneshot\n'],
      ['kassinao-rollback-clean.timer', '[Timer]\nOnCalendar=*:0/30\n'],
    ] as const;
    for (const [name, contents] of units) {
      const source = path.join(currentSystemd, name);
      const destination = path.join(systemd, name);
      writeFileSync(source, contents, { mode: 0o644 });
      writeFileSync(destination, contents, { mode: 0o644 });
      installedArtifacts.push(destination);
    }
    const rollbackServiceTemplate =
      '[Service]\nReadWritePaths=@ROLLBACK_DIR@\nEnvironment=KASSINAO_ROLLBACK_RETENTION_HOURS=@RETENTION_HOURS@ KASSINAO_ROLLBACK_CLEANUP_AGE=@CLEANUP_AGE@\n';
    writeFileSync(path.join(currentSystemd, 'kassinao-rollback-clean.service.in'), rollbackServiceTemplate, {
      mode: 0o644,
    });
    const rollbackService = path.join(systemd, 'kassinao-rollback-clean.service');
    writeFileSync(
      rollbackService,
      rollbackServiceTemplate
        .replace('@ROLLBACK_DIR@', `${oldDataRoot}/rollback`)
        .replace('@RETENTION_HOURS@', '24')
        .replace('@CLEANUP_AGE@', '1409min'),
      { mode: 0o644 },
    );
    installedArtifacts.push(rollbackService);

    const dropinContents = '[Service]\nExecStartPre=/usr/local/sbin/kassinao-harden-docker-egress --offline-preload\n';
    const dropinSource = path.join(currentDropins, 'kassinao-egress.conf');
    const dropin = path.join(dockerDropins, 'kassinao-egress.conf');
    writeFileSync(dropinSource, dropinContents, { mode: 0o644 });
    writeFileSync(dropin, dropinContents, { mode: 0o644 });
    installedArtifacts.push(dropin);

    const tmpfilesSource = path.join(currentTmpfiles, 'kassinao.conf');
    const tmpfilesDestination = path.join(tmpfiles, 'kassinao.conf');
    writeFileSync(tmpfilesSource, 'd /run/lock/kassinao 0700 root root -\n', { mode: 0o644 });
    writeFileSync(tmpfilesDestination, readFileSync(tmpfilesSource), { mode: 0o644 });
    installedArtifacts.push(tmpfilesDestination);
    const rollbackTmpfilesTemplate = 'd @ROLLBACK_DIR@ 0700 root root mM:@CLEANUP_AGE@ -\n';
    writeFileSync(path.join(currentTmpfiles, 'kassinao-rollback.conf.in'), rollbackTmpfilesTemplate, { mode: 0o644 });
    const rollbackTmpfiles = path.join(tmpfiles, 'kassinao-rollback.conf');
    writeFileSync(
      rollbackTmpfiles,
      rollbackTmpfilesTemplate.replace('@ROLLBACK_DIR@', `${oldDataRoot}/rollback`).replace('@CLEANUP_AGE@', '1409min'),
      { mode: 0o644 },
    );
    installedArtifacts.push(rollbackTmpfiles);

    const legacyEnvironment = [
      `KASSINAO_DATA_ROOT=${oldDataRoot}`,
      `KASSINAO_RECORDINGS_DIR=${oldDataRoot}/recordings`,
      `KASSINAO_STATE_DIR=${oldDataRoot}/state`,
      `KASSINAO_AUTH_DIR=${oldDataRoot}/auth`,
      `KASSINAO_MODEL_CACHE_DIR=${oldDataRoot}/cache`,
      'KASSINAO_ROLLBACK_RETENTION_HOURS=24',
      '',
    ].join('\n');
    const legacyEnv = path.join(current, '.env');
    writeFileSync(legacyEnv, legacyEnvironment, { mode: 0o600 });
    chmodSync(legacyEnv, 0o600);
    writeFileSync(path.join(current, '.deploy.lock'), '', { mode: 0o600 });
    const storagePaths = path.join(etcKassinao, 'storage-paths');
    const hostControls = path.join(etcKassinao, 'host-controls.env');
    writeFileSync(
      storagePaths,
      [
        oldDataRoot,
        `${oldDataRoot}/recordings`,
        `${oldDataRoot}/state`,
        `${oldDataRoot}/auth`,
        `${oldDataRoot}/cache`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    writeFileSync(hostControls, `KASSINAO_DATA_ROOT=${oldDataRoot}\nKASSINAO_ROLLBACK_RETENTION_HOURS=24\n`, {
      mode: 0o600,
    });
    installedArtifacts.push(storagePaths, hostControls);

    const legacyManifestEntries = [
      ...scriptFiles.map(([name]) => path.join('scripts', name)),
      ...units.map(([name]) => path.join('deploy', 'systemd', name)),
      path.join('deploy', 'systemd', 'kassinao-rollback-clean.service.in'),
      path.join('deploy', 'systemd', 'docker.service.d', 'kassinao-egress.conf'),
      path.join('deploy', 'tmpfiles.d', 'kassinao.conf'),
      path.join('deploy', 'tmpfiles.d', 'kassinao-rollback.conf.in'),
    ].map(
      (relative) =>
        `${createHash('sha256')
          .update(readFileSync(path.join(current, relative)))
          .digest('hex')}  ${relative}`,
    );
    writeFileSync(path.join(current, 'MANIFEST.sha256'), `${legacyManifestEntries.join('\n')}\n`, { mode: 0o644 });

    writeFileSync(
      path.join(bundle, '.env'),
      ['KASSINAO_HOST_SCOPE=shared', 'KASSINAO_DEDICATED_DOCKER_HOST_ACK=', `KASSINAO_DATA_ROOT=${dataRoot}`, ''].join(
        '\n',
      ),
      { mode: 0o600 },
    );
    const transition = path.join(dataRoot, '.legacy-shared-transition');
    mkdirSync(transition, { mode: 0o700 });
    const privateManifest = '{"path":"recordings/demo","sha256":"known"}\n';
    const legacyStat = statSync(legacyEnv, { bigint: true });
    const proof = `{"path":${JSON.stringify(legacyEnv)},"dev":${legacyStat.dev},"ino":${legacyStat.ino},"mode":384,"uid":${legacyStat.uid},"gid":${legacyStat.gid},"nlink":${legacyStat.nlink},"size":${legacyStat.size},"mtime_ns":${legacyStat.mtimeNs},"ctime_ns":${legacyStat.ctimeNs},"sha256":"${createHash('sha256').update(readFileSync(legacyEnv)).digest('hex')}"}`;
    writeFileSync(path.join(transition, 'source-manifest.jsonl'), privateManifest, { mode: 0o600 });
    writeFileSync(
      path.join(transition, 'layout.json'),
      `${JSON.stringify({
        version: 3,
        status: options.markerStatus ?? 'prepared',
        current_root: current,
        data_root: dataRoot,
        legacy_env_proof: null,
        legacy_env_status: 'present',
        source_manifest_sha256: createHash('sha256').update(privateManifest).digest('hex'),
      }).replace('"legacy_env_proof":null', `"legacy_env_proof":${proof}`)}\n`,
      { mode: 0o600 },
    );
    if (options.driftInstalled) writeFileSync(installedArtifacts[0], 'drifted control\n', { mode: 0o755 });
    if (options.partial) unlinkSync(installedArtifacts.at(-1)!);
    if (options.extraEtc) writeFileSync(path.join(etcKassinao, 'foreign.conf'), 'foreign\n', { mode: 0o600 });
    if (options.rollbackSnapshot) writeFileSync(path.join(oldDataRoot, 'rollback', 'pending.tar'), 'snapshot\n');
    if (options.healthPresent) {
      const health = path.join(sbin, 'kassinao-health-watch');
      executable(health, '#!/usr/bin/env bash\nexit 0\n');
      installedArtifacts.push(health);
    }
  }

  const inheritedEnvironment = path.join(root, 'inherited-environment.bin');
  writeFileSync(
    inheritedEnvironment,
    Buffer.from(
      [...new Set([...Object.keys(process.env), 'PATH', 'HOME', 'DISCORD_TOKEN'])]
        .map((name) => `${name}=fixture\0`)
        .join(''),
    ),
  );
  const safePath = `${bin}:/opt/homebrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
  const helper = path.join(scripts, 'remove-legacy-dedicated-host-controls.sh');
  const helperSource = SOURCE.replace(
    'SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    `SAFE_SYSTEM_PATH=${safePath}`,
  )
    .replaceAll('/proc/$$/environ', inheritedEnvironment)
    .replace(
      /# KASSINAO_HOST_NO_DUMP_BEGIN[\s\S]*?# KASSINAO_HOST_NO_DUMP_END/,
      '# KASSINAO_HOST_NO_DUMP_BEGIN\nunset LD_PRELOAD\n# KASSINAO_HOST_NO_DUMP_END',
    )
    .replace('SYSTEMD_DIR=/etc/systemd/system', `SYSTEMD_DIR=${shellLiteral(systemd)}`)
    .replace('SBIN_DIR=/usr/local/sbin', `SBIN_DIR=${shellLiteral(sbin)}`)
    .replace('TMPFILES_DIR=/etc/tmpfiles.d', `TMPFILES_DIR=${shellLiteral(tmpfiles)}`)
    .replace('ETC_KASSINAO=/etc/kassinao', `ETC_KASSINAO=${shellLiteral(etcKassinao)}`)
    .replace('RUNTIME_DIR=/run/lock/kassinao', `RUNTIME_DIR=${shellLiteral(runtime)}`)
    .replaceAll('metadata.st_uid != 0', `metadata.st_uid != ${uid}`)
    .replaceAll('metadata.st_gid != 0', `metadata.st_gid != ${gid}`);
  executable(helper, helperSource);

  executable(path.join(bin, 'id'), '#!/usr/bin/env bash\n[ "${1:-}" = -u ] && printf "0\\n"\n');
  executable(
    path.join(bin, 'readlink'),
    `#!/usr/bin/env bash
last=''; for value in "$@"; do last="$value"; done
case "$last" in
  /proc/*/fd/8) printf '%s\n' ${shellLiteral(path.join(current, '.deploy.lock'))}; exit 0 ;;
  /proc/*/fd/9) printf '%s\n' ${shellLiteral(path.join(runtime, 'maintenance.lock'))}; exit 0 ;;
esac
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
format=''; previous=''; last=''; follow=0
for value in "$@"; do
  if [ "$previous" = -c ]; then format="$value"; fi
  if [ "$value" = -L ]; then follow=1; fi
  previous="$value"; last="$value"
done
case "$last" in
  /proc/*/fd/8) last=${shellLiteral(path.join(current, '.deploy.lock'))} ;;
  /proc/*/fd/9) last=${shellLiteral(path.join(runtime, 'maintenance.lock'))} ;;
esac
python3 - "$format" "$last" "$follow" <<'PY'
import os, stat, sys
fmt, target, follow = sys.argv[1:]
metadata = os.stat(target) if follow == '1' else os.lstat(target)
mode = format_mode = format(stat.S_IMODE(metadata.st_mode), 'o')
values = {
    '%a': mode,
    '%u': '0',
    '%g': '0',
    '%h': str(metadata.st_nlink),
    '%d': str(metadata.st_dev),
    '%i': str(metadata.st_ino),
}
print(':'.join(values.get(part, part) for part in fmt.split(':')))
PY
`,
  );
  executable(
    path.join(bin, 'sha256sum'),
    `#!/usr/bin/env bash
set -eu
if [ "\${1:-}" = -c ]; then
  python3 - "\${2:-MANIFEST.sha256}" <<'PY'
import hashlib, os, sys
with open(sys.argv[1], encoding='utf-8') as handle:
    for raw in handle:
        expected, relative = raw.rstrip('\\n').split('  ', 1)
        with open(os.path.join(os.getcwd(), relative.removeprefix('./')), 'rb') as source:
            if hashlib.sha256(source.read()).hexdigest() != expected:
                raise SystemExit(1)
PY
  exit 0
fi
last=''; for value in "$@"; do last="$value"; done
python3 - "$last" <<'PY'
import hashlib, sys
with open(sys.argv[1], 'rb') as source:
    print(hashlib.sha256(source.read()).hexdigest(), sys.argv[1])
PY
`,
  );
  executable(
    path.join(bin, 'systemctl'),
    `#!/usr/bin/env bash
printf 'systemctl:%s\n' "$*" >> ${shellLiteral(calls)}
case "\${1:-}" in
  show)
    [ ${options.systemctlShowFailure ? 1 : 0} -eq 0 ] || exit 75
    unit="\${2:-}"; property="\${4:-}"
    case "$property" in
      MainPID) cat ${shellLiteral(pidState)} ;;
      ActiveState)
        if [ "$unit" = docker.service ]; then
          [ ${options.dockerInactive ? 1 : 0} -eq 0 ] && printf 'active\n' || printf 'inactive\n'
        elif [ ${options.residualEffectiveLegacy ? 1 : 0} -eq 1 ] && [ "$unit" = kassinao-docker-egress.service ]; then
          printf 'active\n'
        else
          printf 'inactive\n'
        fi
        ;;
      UnitFileState)
        if [ ${options.residualEffectiveLegacy ? 1 : 0} -eq 1 ] && [ "$unit" = kassinao-docker-egress.service ]; then
          printf 'enabled\n'
        fi
        ;;
      FragmentPath)
        if [ ${options.residualEffectiveLegacy ? 1 : 0} -eq 1 ] && [ "$unit" = kassinao-docker-egress.service ]; then
          printf '/run/systemd/system/%s\n' "$unit"
        elif [ -e ${shellLiteral(systemd)}/"$unit" ]; then
          printf '%s/%s\n' ${shellLiteral(systemd)} "$unit"
        fi
        ;;
      DropInPaths)
        if [ "$unit" = docker.service ] && [ -e ${shellLiteral(systemd)}/docker.service.d/kassinao-egress.conf ]; then
          printf '%s\n' ${shellLiteral(path.join(systemd, 'docker.service.d', 'kassinao-egress.conf'))}
        fi
        if [ "$unit" = docker.service ] && { [ ${options.extraDockerDropin ? 1 : 0} -eq 1 ] || [ -e ${shellLiteral(systemdRace)} ]; }; then
          printf '/run/systemd/system/docker.service.d/kassinao-shadow.conf\n'
        fi
        ;;
      ExecStartPre)
        if [ "$unit" = docker.service ] && [ -e ${shellLiteral(systemd)}/docker.service.d/kassinao-egress.conf ]; then
          printf 'path=%s/kassinao-harden-docker-egress ; argv[]=%s/kassinao-harden-docker-egress --offline-preload ; path=%s/kassinao-verify-storage-encryption ;\n' \
            ${shellLiteral(sbin)} ${shellLiteral(sbin)} ${shellLiteral(sbin)}
        fi
        if [ "$unit" = docker.service ] && [ ${options.extraDockerHook ? 1 : 0} -eq 1 ]; then
          printf 'path=/usr/local/sbin/kassinao-shadow-hook ; argv[]=/usr/local/sbin/kassinao-shadow-hook ;\n'
        fi
        ;;
      NeedDaemonReload) printf 'no\n' ;;
    esac
    ;;
  disable|stop|daemon-reload|reset-failed) ;;
  is-active|is-enabled) exit 1 ;;
  *) exit 90 ;;
esac
`,
  );
  for (const tool of ['iptables', 'ip6tables']) {
    executable(
      path.join(bin, tool),
      `#!/usr/bin/env bash
[ ${options.firewallResidual ? 1 : 0} -eq 0 ] || printf '%s\n' '-N KASSINAO-EGRESS'
`,
    );
  }
  executable(
    path.join(bin, 'docker'),
    `#!/usr/bin/env bash
printf 'docker:%s\n' "$*" >> ${shellLiteral(calls)}
case "\${1:-}" in
  info) printf '28.0.0\n' ;;
  ps)
    [ ${options.dockerPsFailure ? 1 : 0} -eq 0 ] || exit 72
    printf 'foreign-id\n'
    if [ ${options.legacyContainerRemaining ? 1 : 0} -eq 1 ] || [ -e ${shellLiteral(containerRace)} ]; then
      printf 'legacy-id\n'
    fi
    ;;
  inspect)
    format="\${3:-}"
    id="\${4:-}"
    case "$format" in
      *com.docker.compose.project*) [ "$id" = legacy-id ] && printf 'kassinao\n' || printf 'company\n' ;;
      *'.Name'*) [ "$id" = legacy-id ] && printf '/kassinao\n' || printf '/company-app\n' ;;
      *RestartCount*)
        if [ "$id" = legacy-id ]; then
          printf 'legacy-id false false 0\n'
        elif [ -e ${shellLiteral(neighborRace)} ]; then
          printf 'foreign-id true false 1\n'
        else
          printf 'foreign-id true false 0\n'
        fi
        ;;
      *) printf '{}\n' ;;
    esac
    ;;
  *) exit 91 ;;
esac
`,
  );
  const transition = path.join(dataRoot, '.legacy-shared-transition');
  const raceMutationCommand = (() => {
    switch (options.raceMutation) {
      case 'artifact':
        return `printf 'raced artifact\\n' >> ${shellLiteral(installedArtifacts[0] ?? path.join(root, 'missing-artifact'))}`;
      case 'artifact-identity': {
        const target = installedArtifacts[0] ?? path.join(root, 'missing-artifact');
        return `/bin/cp -p ${shellLiteral(target)} ${shellLiteral(`${target}.raced`)} && /bin/mv -f ${shellLiteral(`${target}.raced`)} ${shellLiteral(target)}`;
      }
      case 'container':
        return `/usr/bin/touch ${shellLiteral(containerRace)}`;
      case 'current-manifest':
        return `printf 'invalid current manifest\\n' >> ${shellLiteral(path.join(bundle, 'MANIFEST.sha256'))}`;
      case 'etc':
        return `/usr/bin/touch ${shellLiteral(path.join(etcKassinao, 'raced.conf'))}`;
      case 'health':
        return `/usr/bin/touch ${shellLiteral(path.join(sbin, 'kassinao-health-watch'))}`;
      case 'legacy-env':
        return `printf 'RACED_ENV=1\\n' >> ${shellLiteral(path.join(current, '.env'))}`;
      case 'legacy-manifest':
        return `printf 'invalid legacy manifest\\n' >> ${shellLiteral(path.join(current, 'MANIFEST.sha256'))}`;
      case 'marker':
        return `printf 'tampered\\n' >> ${shellLiteral(path.join(transition, 'layout.json'))}`;
      case 'neighbors':
        return `/usr/bin/touch ${shellLiteral(neighborRace)}`;
      case 'pid':
        return `printf '4343\\n' > ${shellLiteral(pidState)}`;
      case 'policy':
        return `/usr/bin/touch ${shellLiteral(policyRace)}`;
      case 'rollback':
        return `/usr/bin/touch ${shellLiteral(path.join(oldDataRoot, 'rollback', 'raced-snapshot.tar'))}`;
      case 'runtime':
        return `/usr/bin/touch ${shellLiteral(path.join(runtime, 'raced.lock'))}`;
      case 'shared-env':
        return `printf 'KASSINAO_HOST_SCOPE=dedicated\\n' >> ${shellLiteral(path.join(bundle, '.env'))}`;
      case 'systemd':
        return `/usr/bin/touch ${shellLiteral(systemdRace)}`;
      default:
        return ':';
    }
  })();
  executable(
    path.join(bin, 'flock'),
    `#!/usr/bin/env bash
printf 'flock:%s\n' "$*" >> ${shellLiteral(calls)}
if [ ${options.rollbackAfterLocks ? 1 : 0} -eq 1 ] && [ "$*" = '-w 120 9' ]; then
  /usr/bin/touch ${shellLiteral(path.join(oldDataRoot, 'rollback', 'raced-snapshot.tar'))}
fi
if [ "$*" = '-w 120 9' ]; then
  ${raceMutationCommand}
fi
exit 0
`,
  );

  const manifest = `${createHash('sha256').update(readFileSync(helper)).digest('hex')}  scripts/remove-legacy-dedicated-host-controls.sh\n`;
  writeFileSync(path.join(bundle, 'MANIFEST.sha256'), manifest, { mode: 0o644 });
  const artifactSnapshot = installedArtifacts
    .filter((artifact) => existsSync(artifact))
    .map((artifact) => [artifact, readFileSync(artifact)] as const);
  const run = () =>
    spawnSync('bash', [helper, current, '--confirm-remove-exact-legacy-dedicated-host-controls'], {
      cwd: bundle,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, DISCORD_TOKEN: 'must-not-leak' },
    });
  return {
    artifactSnapshot,
    calls,
    current,
    dataRoot,
    foreignArtifacts,
    installedArtifacts,
    oldDataRoot,
    run,
    runtime,
  };
}

function expectNoMutation(value: ReturnType<typeof fixture>): string {
  for (const [artifact, contents] of value.artifactSnapshot) {
    expect(readFileSync(artifact), artifact).toEqual(contents);
  }
  for (const artifact of value.foreignArtifacts) {
    expect(readFileSync(artifact, 'utf8')).toBe('foreign artifact\n');
  }
  const calls = existsSync(value.calls) ? readFileSync(value.calls, 'utf8') : '';
  expect(calls).not.toMatch(/systemctl:(?:disable|stop|daemon-reload)/);
  expect(calls).not.toContain('hardener:--remove');
  return calls;
}

function expectNoHelperMutation(value: ReturnType<typeof fixture>): void {
  for (const artifact of value.installedArtifacts) expect(existsSync(artifact), artifact).toBe(true);
  for (const artifact of value.foreignArtifacts) {
    expect(readFileSync(artifact, 'utf8')).toBe('foreign artifact\n');
  }
  const calls = existsSync(value.calls) ? readFileSync(value.calls, 'utf8') : '';
  expect(calls).not.toMatch(/systemctl:(?:disable|stop|daemon-reload)/);
  expect(calls).not.toContain('hardener:--remove');
}

describe('transição dos controles dedicated legados', () => {
  it('é no-op seguro quando nenhum artefato legado existe', () => {
    const value = fixture();
    const result = value.run();

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stdout).toMatch(/nenhum controle dedicated legado instalado/i);
    expect(readFileSync(value.calls, 'utf8')).not.toMatch(/systemctl:(?:disable|stop|daemon-reload)/);
  });

  it.each([
    ['unit efetiva residual', { residualEffectiveLegacy: true }, 'fragmento de unit dedicated'],
    ['drop-in Docker Kassinão residual', { extraDockerDropin: true }, 'drop-in do Kassinão'],
    ['container Kassinão residual', { legacyContainerRemaining: true }, 'permaneceu após compose down'],
    ['policy Kassinão residual', { firewallResidual: true }, 'policy KASSINAO residual'],
  ] as const)('recusa no-op diante de %s', (_label, options, expectedError) => {
    const value = fixture(options);
    const result = value.run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(expectedError);
    expectNoMutation(value);
  });

  it('remove o conjunto v1.4.9 exato e preserva dados, locks e artefatos vizinhos', () => {
    const value = fixture({ installed: true });
    const result = value.run();

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    for (const artifact of value.installedArtifacts) expect(existsSync(artifact), artifact).toBe(false);
    for (const artifact of value.foreignArtifacts) {
      expect(readFileSync(artifact, 'utf8')).toBe('foreign artifact\n');
    }
    expect(existsSync(path.join(value.current, '.env'))).toBe(true);
    expect(existsSync(value.oldDataRoot)).toBe(true);
    expect(existsSync(path.join(value.dataRoot, '.legacy-shared-transition', 'layout.json'))).toBe(true);
    expect(existsSync(path.join(value.runtime, 'maintenance.lock'))).toBe(true);
    const calls = readFileSync(value.calls, 'utf8');
    expect(calls).toContain('hardener:--remove');
    expect(calls).toContain('systemctl:disable --now kassinao-docker-egress.service kassinao-rollback-clean.timer');
    expect(calls).toContain('systemctl:daemon-reload');
    expect(calls).not.toMatch(/systemctl:(?:start|stop|restart|enable|disable|mask|unmask) docker(?:\.service)?/);
    expect(calls).not.toMatch(/docker:(?:stop|start|restart|rm|kill|update|compose)/);
  }, 20_000);

  it.each([
    ['conjunto parcial', { partial: true }, 'parcial'],
    ['health-watch residual', { healthPresent: true }, 'health-watch legado ainda está instalado'],
    ['marker fora de prepared', { markerStatus: 'preparing' }, 'não está no estado prepared v3'],
    ['bytes divergentes', { driftInstalled: true }, 'script dedicated instalado divergiu'],
    ['entrada estranha em /etc/kassinao', { extraEtc: true }, 'entrada fora do conjunto v1.4.9'],
    ['snapshot de rollback pendente', { rollbackSnapshot: true }, 'rollback legado ainda contém snapshot'],
    ['docker ps indisponível', { dockerPsFailure: true }, 'inventário Docker local falhou'],
    ['docker.service inativo', { dockerInactive: true }, 'docker.service precisa estar ativo'],
    ['drop-in Docker Kassinão adicional', { extraDockerDropin: true }, 'drop-in Kassinão alheio'],
    ['pre-hook Docker Kassinão adicional', { extraDockerHook: true }, 'pre-hooks dedicated não são'],
    ['falha ao consultar systemd', { systemctlShowFailure: true }, 'systemd não respondeu'],
    [
      'snapshot de rollback criado enquanto aguardava os locks',
      { rollbackAfterLocks: true },
      'rollback legado ainda contém snapshot',
    ],
    ['container Kassinão residual', { legacyContainerRemaining: true }, 'permaneceu após compose down'],
  ] as const)(
    'falha sem mutação diante de %s',
    (_label, options, expectedError) => {
      const value = fixture({ installed: true, ...options });
      const result = value.run();

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(expectedError);
      expectNoMutation(value);
    },
    20_000,
  );

  it.each([
    ['marker v3', 'marker', 'marker'],
    ['.env/proof legado', 'legacy-env', '.env legada'],
    ['MANIFEST legado', 'legacy-manifest', 'MANIFEST'],
    ['MANIFEST do kit atual', 'current-manifest', 'MANIFEST'],
    ['health-watch', 'health', 'health-watch'],
    ['bytes de artefato instalado', 'artifact', 'script dedicated instalado divergiu'],
    ['identidade de artefato instalado', 'artifact-identity', 'identidade dos artefatos mudou'],
    ['/etc/kassinao', 'etc', '/etc/kassinao'],
    ['runtime', 'runtime', 'runtime legado'],
    ['config shared', 'shared-env', 'KASSINAO_HOST_SCOPE'],
    ['estado efetivo do systemd', 'systemd', 'drop-in Kassinão alheio'],
    ['containers', 'container', 'permaneceu após compose down'],
    ['policy', 'policy', 'policy dedicated legada divergiu'],
    ['PID do Docker', 'pid', 'MainPID do docker.service mudou'],
    ['vizinhos', 'neighbors', 'workload vizinho mudou'],
    ['rollback', 'rollback', 'rollback legado ainda contém snapshot'],
  ] as const)(
    'revalida %s após esperar o segundo lock e não inicia mutação',
    (_label, raceMutation, expectedError) => {
      const value = fixture({ installed: true, raceMutation });
      const result = value.run();

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(expectedError);
      expectNoHelperMutation(value);
    },
    20_000,
  );

  it('mantém todas as provas antes da primeira mutação e não possui lifecycle amplo', () => {
    const mutation = SOURCE.indexOf('# A partir daqui começam as mutações');
    const firstMutation = SOURCE.indexOf(
      'systemctl disable --now kassinao-docker-egress.service kassinao-rollback-clean.timer',
    );
    const lockedFunction = SOURCE.indexOf('verify_locked_pre_mutation_state() {');
    const lockedFunctionEnd = SOURCE.indexOf('\n}\n\n# A partir daqui começam as mutações', lockedFunction);
    const lockedCall = SOURCE.lastIndexOf('\nverify_locked_pre_mutation_state\n', firstMutation);
    expect(mutation).toBeGreaterThan(0);
    expect(firstMutation).toBeGreaterThan(mutation);
    expect(lockedFunction).toBeGreaterThan(0);
    expect(lockedFunctionEnd).toBeGreaterThan(lockedFunction);
    expect(lockedCall).toBeGreaterThan(SOURCE.indexOf('flock -w 120 9'));
    for (const gate of [
      'marker legado não está no estado prepared v3',
      'rollback legado ainda contém snapshot',
      'flock -w 120 9',
    ]) {
      const gateIndex = SOURCE.indexOf(gate);
      expect(gateIndex, gate).toBeGreaterThan(0);
      expect(gateIndex, gate).toBeLessThan(mutation);
    }
    const lockedBody = SOURCE.slice(lockedFunction, lockedFunctionEnd);
    for (const gate of [
      'verify_current_bundle',
      'verify_shared_transition_config',
      'verify_transition_marker',
      'verify_legacy_bundle_and_config',
      'assert_health_watch_absent',
      'assert_complete_legacy_set',
      'verify_legacy_host_directories',
      'assert_rollback_empty',
      'verify_legacy_artifacts',
      'assert_held_lock_identity',
      'snapshot_proof_identities',
      'assert_no_kassinao_containers',
      'systemctl_value docker.service ActiveState',
      'systemctl_value docker.service MainPID',
      'snapshot_neighbors',
      'kassinao-harden-docker-egress" --check',
    ]) {
      expect(lockedBody, gate).toContain(gate);
    }
    expect(SOURCE.slice(lockedCall + '\nverify_locked_pre_mutation_state\n'.length, firstMutation).trim()).toBe('');
    expect(SOURCE.slice(0, mutation)).not.toMatch(/\bsystemctl\s+(?:disable|stop)\b/);
    expect(SOURCE.slice(0, mutation)).not.toMatch(/^rm\s/m);
    expect(SOURCE).not.toMatch(
      /systemctl\s+(?:start|stop|restart|enable|disable|mask|unmask)\s+docker(?:\.service)?\b/,
    );
    expect(SOURCE).not.toMatch(/docker\s+(?:stop|start|restart|rm|kill|update|compose)\b/);
    expect(SOURCE).not.toMatch(/\brm\s+-rf\b/);
    expect(SOURCE).not.toContain('systemd-tmpfiles --remove');
    expect(SOURCE).not.toMatch(/rm[^\n]*maintenance\.lock/);
    expect(SOURCE).not.toMatch(/< <\(docker ps\b/);
    expect(SOURCE).toContain('DEPLOY_LOCK="$CURRENT_ROOT/.deploy.lock"');
    expect(SOURCE.indexOf('flock -w 120 8')).toBeLessThan(SOURCE.indexOf('flock -w 120 9'));
    const unlinkBoundary = SOURCE.indexOf('for unit in "${legacy_unit_names[@]}"; do rm --');
    expect(unlinkBoundary).toBeGreaterThan(mutation);
    expect(SOURCE.lastIndexOf('verify_legacy_artifacts', unlinkBoundary)).toBeGreaterThan(mutation);
    expect(SOURCE).toContain('[ "$docker_main_pid_after" = "$docker_main_pid_before" ]');
  });
});
