import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const VALIDATOR = path.join(ROOT, 'scripts', 'validate-legacy-dedicated-installation.sh');
const validatorSource = readFileSync(VALIDATOR, 'utf8');

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function executable(file: string, contents: string): void {
  writeFileSync(file, contents, { mode: 0o755 });
  chmodSync(file, 0o755);
}

type Options = {
  ack?: string | null;
  configFiles?: string[];
  hostScope?: string;
  missingCore?: boolean;
  reservedCollision?: boolean;
  workingDir?: string;
};

function fixture(options: Options = {}) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'kassinao-legacy-scope-')));
  chmodSync(directory, 0o700);
  const currentRoot = path.join(directory, 'current');
  const scripts = path.join(directory, 'scripts');
  const dockerClient = path.join(directory, 'deploy', 'docker-client');
  const bin = path.join(directory, 'bin');
  const calls = path.join(directory, 'calls.log');
  mkdirSync(currentRoot, { mode: 0o700 });
  mkdirSync(scripts, { mode: 0o700 });
  mkdirSync(dockerClient, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dockerClient, 'config.json'), '{}\n', { mode: 0o444 });
  mkdirSync(bin, { mode: 0o700 });

  const envLines = [
    ...(options.hostScope === undefined ? [] : [`KASSINAO_HOST_SCOPE=${options.hostScope}`]),
    ...(options.ack === null ? [] : [`KASSINAO_DEDICATED_DOCKER_HOST_ACK=${options.ack ?? ''}`]),
    'TRANSCRIBE_PROVIDER=assemblyai',
    'TUNNEL_TOKEN=private-and-ignored',
    '',
  ];
  writeFileSync(path.join(currentRoot, '.env'), envLines.join('\n'), { mode: 0o600 });
  writeFileSync(path.join(currentRoot, 'docker-compose.yml'), 'services: {}\n', { mode: 0o644 });

  const validator = path.join(scripts, 'validate-legacy-dedicated-installation.sh');
  writeFileSync(
    validator,
    validatorSource
      .replace(
        'SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        `SAFE_SYSTEM_PATH=${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      )
      .replace(
        /# KASSINAO_HOST_NO_DUMP_BEGIN[\s\S]*?# KASSINAO_HOST_NO_DUMP_END/,
        '# KASSINAO_HOST_NO_DUMP_BEGIN\nunset LD_PRELOAD\n# KASSINAO_HOST_NO_DUMP_END',
      ),
    { mode: 0o755 },
  );
  chmodSync(validator, 0o755);

  executable(path.join(bin, 'id'), '#!/usr/bin/env bash\n[ "${1:-}" = -u ] && printf "0\\n"\n');
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
format=''; previous=''; last=''
for value in "$@"; do
  if [ "$previous" = -c ]; then format="$value"; fi
  previous="$value"; last="$value"
done
if [ "$format" = %h ]; then printf '1\n'; exit 0; fi
case "$last" in
  ${shellLiteral(currentRoot)}|${shellLiteral(directory)}|${shellLiteral(scripts)}|${shellLiteral(bin)}) printf '700:0:0\n' ;;
  ${shellLiteral(path.join(currentRoot, '.env'))}) printf '600:0:0\n' ;;
  ${shellLiteral(path.join(currentRoot, 'docker-compose.yml'))}) printf '644:0:0\n' ;;
  *) printf '755:0:0\n' ;;
esac
`,
  );

  const baseCompose = path.join(currentRoot, 'docker-compose.yml');
  const configuredFiles = options.configFiles ?? [baseCompose];
  const workingDir = options.workingDir ?? currentRoot;
  const ids = { core: 'a'.repeat(64), tunnel: 'c'.repeat(64), neighbor: 'f'.repeat(64) };
  const containers: Array<Record<string, unknown>> = [];
  if (!options.missingCore) {
    containers.push({
      Id: ids.core,
      Name: '/kassinao',
      Config: {
        Labels: {
          'com.docker.compose.project': 'kassinao',
          'com.docker.compose.service': 'kassinao',
          'com.docker.compose.project.working_dir': workingDir,
          'com.docker.compose.project.config_files': configuredFiles.join(','),
        },
      },
    });
  }
  containers.push({
    Id: ids.tunnel,
    Name: options.reservedCollision ? '/kassinao-public' : '/kassinao-tunnel',
    Config: {
      Labels: {
        'com.docker.compose.project': 'kassinao',
        'com.docker.compose.service': 'cloudflared',
        'com.docker.compose.project.working_dir': workingDir,
        'com.docker.compose.project.config_files': configuredFiles.join(','),
      },
    },
  });
  containers.push({ Id: ids.neighbor, Name: '/company-app', Config: { Labels: {} } });
  const inventory = path.join(directory, 'docker.json');
  writeFileSync(inventory, JSON.stringify(containers));
  executable(
    path.join(bin, 'docker'),
    `#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> ${shellLiteral(calls)}
case "\${1:-}" in
  info) printf '29.0.1\n' ;;
  ps) printf '%s\n' '${ids.core}' '${ids.tunnel}' '${ids.neighbor}' ;;
  inspect)
    template="\${3:-}"
    shift 3
    python3 - ${shellLiteral(inventory)} "$template" "$@" <<'PY'
import json, sys
inventory, template, *wanted = sys.argv[1:]
with open(inventory, encoding='utf-8') as source:
    items = {item['Id']: item for item in json.load(source)}
for identity in wanted:
    item = items[identity]
    labels = (item.get('Config') or {}).get('Labels') or {}
    if 'WorkingDir' in template:
        result = {
            'Id': item['Id'],
            'WorkingDir': labels.get('com.docker.compose.project.working_dir'),
            'ConfigFiles': labels.get('com.docker.compose.project.config_files'),
        }
    else:
        result = {
            'Id': item['Id'], 'Name': item['Name'],
            'Config': {'Labels': {
                'com.docker.compose.project': labels.get('com.docker.compose.project'),
                'com.docker.compose.service': labels.get('com.docker.compose.service'),
            }},
        }
    print(json.dumps(result, separators=(',', ':')))
PY
    ;;
  *) exit 90 ;;
esac
`,
  );

  const result = spawnSync('bash', [validator, currentRoot], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, DISCORD_TOKEN: 'must-not-leak' },
  });
  return { baseCompose, calls, currentRoot, directory, result };
}

describe('transição fail-closed do layout legado dedicado', () => {
  it('reconhece ausência de scope/ACK só quando labels provam o Compose base exato', () => {
    const value = fixture({ ack: null });
    expect(value.result.status, `${value.result.stderr}\n${value.result.stdout}`).toBe(0);
    expect(value.result.stdout).toBe('legacy-dedicated\n');
    expect(`${value.result.stdout}${value.result.stderr}`).not.toContain('must-not-leak');
    const calls = readFileSync(value.calls, 'utf8');
    expect(calls).toContain('info --format {{.ServerVersion}}');
    expect(calls).toContain('ps -aq --no-trunc');
    expect(calls).toContain(`inspect --format`);
    expect(calls).not.toMatch(/^(stop|start|restart|rm|kill|update|compose)\b/m);
  });

  it('aceita o ACK vazio do template legado sem usá-lo como evidência suficiente', () => {
    const value = fixture({ ack: '' });
    expect(value.result.status, value.result.stderr).toBe(0);
    expect(value.result.stdout).toBe('legacy-dedicated\n');
  });

  it.each([
    ['scope explícito', { hostScope: 'shared' }],
    ['overlay shared no runtime', { configFiles: ['/tmp/base.yml', '/tmp/docker-compose.shared.yml'] }],
    ['working_dir divergente', { workingDir: '/opt/foreign' }],
    ['colisão de nome/service', { reservedCollision: true }],
    ['core ausente', { missingCore: true }],
    ['ACK inesperado', { ack: 'yes' }],
  ] satisfies Array<[string, Options]>)('recusa %s', (_name, options) => {
    const value = fixture(options);
    expect(value.result.status).not.toBe(0);
    expect(value.result.stdout).not.toContain('legacy-dedicated');
  });

  it('é sintaticamente válido e não contém lifecycle mutável do Docker', () => {
    expect(spawnSync('bash', ['-n', VALIDATOR]).status).toBe(0);
    expect(validatorSource).not.toMatch(/\bdocker\s+(?:stop|start|restart|rm|kill|update|compose)\b/);
  });
});
