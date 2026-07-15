import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.join(process.cwd(), 'scripts', 'harden-docker-egress.sh');
const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function executable(file: string, source: string): void {
  writeFileSync(file, source, { mode: 0o700 });
}

function hardenerScript(directory: string, runtime: string): string {
  const lock = path.join(runtime, 'docker-egress.lock');
  writeFileSync(lock, 'sentinela-egress\n', { mode: 0o600 });
  const scripts = path.join(directory, 'scripts');
  const dockerClient = path.join(directory, 'deploy', 'docker-client');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(dockerClient, { recursive: true });
  writeFileSync(path.join(dockerClient, 'config.json'), '{}\n', { mode: 0o444 });
  const source = readFileSync(SCRIPT, 'utf8')
    .replace(
      /# KASSINAO_HOST_ENV_SCRUB_BEGIN[\s\S]*?# KASSINAO_HOST_ENV_SCRUB_END/,
      '# KASSINAO_HOST_ENV_SCRUB_BEGIN\n_saved_no_dump_marker=""\n_saved_no_dump_preload=""\n_forbidden_override=""\n# KASSINAO_HOST_ENV_SCRUB_END',
    )
    .replace(
      /# KASSINAO_HOST_NO_DUMP_BEGIN[\s\S]*?# KASSINAO_HOST_NO_DUMP_END/,
      '# KASSINAO_HOST_NO_DUMP_BEGIN\nunset LD_PRELOAD\n# KASSINAO_HOST_NO_DUMP_END',
    )
    .replace('LOCK_DIR=/run/lock/kassinao', `LOCK_DIR=${runtime}`)
    .replace(
      /# KASSINAO_LOCK_FD_PROOF_BEGIN[\s\S]*?# KASSINAO_LOCK_FD_PROOF_END/,
      '# KASSINAO_LOCK_FD_PROOF_BEGIN\n:\n# KASSINAO_LOCK_FD_PROOF_END',
    );
  const script = path.join(scripts, 'harden-docker-egress.sh');
  writeFileSync(script, source, { mode: 0o700 });
  return script;
}

function policyRules(family: 4 | 6, extraRule = ''): string {
  const destinations =
    family === 4
      ? ['127.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16']
      : ['::1/128', 'fc00::/7', 'fe80::/10'];
  return [
    '-P INPUT ACCEPT',
    '-P FORWARD DROP',
    '-N DOCKER-USER',
    '-N KASSINAO-EGRESS',
    '-N KASSINAO-EGRESS-A',
    '-N KASSINAO-EGRESS-B',
    '-N KASSINAO-HOST',
    '-N KASSINAO-HOST-A',
    '-N KASSINAO-HOST-B',
    '-A FORWARD -j DOCKER-USER',
    '-A DOCKER-USER -i kas-private0 -j KASSINAO-EGRESS',
    '-A INPUT -i kas-private0 -j KASSINAO-HOST',
    '-A KASSINAO-EGRESS -j KASSINAO-EGRESS-A',
    '-A KASSINAO-EGRESS-A -o kas-private0 -j RETURN',
    ...destinations.map((destination) => `-A KASSINAO-EGRESS-A -d ${destination} -j REJECT`),
    '-A KASSINAO-EGRESS-A -j RETURN',
    '-A KASSINAO-HOST -j KASSINAO-HOST-A',
    '-A KASSINAO-HOST-A -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN',
    '-A KASSINAO-HOST-A -m addrtype --dst-type LOCAL -j REJECT',
    '-A KASSINAO-HOST-A -j RETURN',
    extraRule,
    '',
  ]
    .filter((line, index, lines) => line || index === lines.length - 1)
    .join('\n');
}

function runPolicyCheck(extraV4 = '', extraV6 = '', mode: 'check' | 'apply' = 'check') {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'kassinao-hardener-policy-')));
  tempDirs.push(directory);
  const bin = path.join(directory, 'bin');
  const runtime = path.join(directory, 'runtime');
  const v4 = path.join(directory, 'v4.rules');
  const v6 = path.join(directory, 'v6.rules');
  mkdirSync(bin);
  mkdirSync(runtime, { mode: 0o700 });
  const script = hardenerScript(directory, runtime);
  writeFileSync(v4, policyRules(4, extraV4));
  writeFileSync(v6, policyRules(6, extraV6));
  executable(path.join(bin, 'id'), "#!/usr/bin/env bash\nprintf '0\\n'\n");
  executable(path.join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n');
  executable(
    path.join(bin, 'stat'),
    `#!/usr/bin/env bash
case "\${!#}" in
  ${shellLiteral(runtime)}) printf '700:0:0\n' ;;
  ${shellLiteral(path.join(runtime, 'docker-egress.lock'))}) printf '600:0:0:1\n' ;;
  *) exit 1 ;;
esac
`,
  );
  executable(path.join(bin, 'readlink'), '#!/usr/bin/env bash\nprintf "%s\\n" "${!#}"\n');
  executable(path.join(bin, 'docker'), '#!/usr/bin/env bash\nexit 1\n');
  for (const [command, rules] of [
    ['iptables', v4],
    ['ip6tables', v6],
  ] as const) {
    executable(
      path.join(bin, command),
      `#!/usr/bin/env bash
set -eu
[ "\${1:-}" != -w ] || shift 2
[ "\${1:-}" = -S ] || exit 80
if [ "$#" -eq 1 ]; then
  cat ${shellLiteral(rules)}
else
  chain="$2"
  awk -v chain="$chain" '($1 == "-N" && $2 == chain) || ($1 == "-A" && $2 == chain)' ${shellLiteral(rules)}
fi
`,
    );
  }
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
  };
  for (const name of [
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_CONFIG',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
    'DOCKER_API_VERSION',
  ]) {
    delete environment[name];
  }
  const args = mode === 'check' ? [script, '--shared-host', '--check'] : [script, '--shared-host'];
  return spawnSync('bash', args, { encoding: 'utf8', env: environment });
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

describe('identidade da topologia no hardener de egress', () => {
  it('aprova anchors com uma única referência no hook e bridge exatos', () => {
    const result = runPolicyCheck();
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ['IPv4', '-A INPUT -j KASSINAO-EGRESS', ''],
    ['IPv6', '', '-A DOCKER-USER -i neighbor0 -j KASSINAO-HOST'],
  ])('recusa referência externa/duplicada aos anchors em %s', (_family, extraV4, extraV6) => {
    const result = runPolicyCheck(extraV4, extraV6);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('política de egress/host ausente, incompleta ou desviada');
  });

  it.each([
    ['IPv4', '-A INPUT -j KASSINAO-EGRESS', ''],
    ['IPv6', '', '-A DOCKER-USER -i neighbor0 -j KASSINAO-HOST'],
  ])('recusa anchor externo em %s antes da primeira mutação de apply', (_family, extraV4, extraV6) => {
    const result = runPolicyCheck(extraV4, extraV6, 'apply');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('referência externa/duplicada aos anchors KASSINAO');
    expect(result.stderr).toContain('nenhuma regra foi alterada');
  });

  it('não autoriza nem altera firewall quando um container alheio ocupa o nome reservado', () => {
    const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'kassinao-hardener-identity-')));
    tempDirs.push(directory);
    const bin = path.join(directory, 'bin');
    const runtime = path.join(directory, 'runtime');
    const dockerLog = path.join(directory, 'docker.log');
    const firewallLog = path.join(directory, 'firewall.log');
    mkdirSync(bin);
    mkdirSync(runtime, { mode: 0o700 });
    const script = hardenerScript(directory, runtime);
    const foreignId = 'f'.repeat(64);

    executable(path.join(bin, 'id'), "#!/usr/bin/env bash\nprintf '0\\n'\n");
    executable(path.join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n');
    executable(
      path.join(bin, 'stat'),
      `#!/usr/bin/env bash
case "\${!#}" in
  ${shellLiteral(runtime)}) printf '700:0:0\n' ;;
  ${shellLiteral(path.join(runtime, 'docker-egress.lock'))}) printf '600:0:0:1\n' ;;
  *) exit 1 ;;
esac
`,
    );
    executable(path.join(bin, 'readlink'), '#!/usr/bin/env bash\nprintf "%s\\n" "${!#}"\n');
    executable(
      path.join(bin, 'docker'),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [ "\${1:-}" = inspect ] && [ "\${2:-}" = --format ]; then
  case "\${3:-}:\${4:-}" in
    '{{.Id}}:kassinao') printf '${foreignId}\\n'; exit 0 ;;
    *com.docker.compose.project*:${foreignId})
      printf '${foreignId}|/kassinao|company|kassinao\\n'
      exit 0
      ;;
  esac
fi
exit 1
`,
    );
    for (const command of ['iptables', 'ip6tables']) {
      executable(
        path.join(bin, command),
        `#!/usr/bin/env bash
printf '${command}:%s\\n' "$*" >> "$FIREWALL_LOG"
exit 0
`,
      );
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      DOCKER_LOG: dockerLog,
      FIREWALL_LOG: firewallLog,
    };
    for (const name of [
      'DOCKER_HOST',
      'DOCKER_CONTEXT',
      'DOCKER_CONFIG',
      'DOCKER_TLS_VERIFY',
      'DOCKER_CERT_PATH',
      'DOCKER_API_VERSION',
    ]) {
      delete env[name];
    }

    const result = spawnSync('bash', [script], { encoding: 'utf8', env });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ocupa nome reservado sem identidade Compose aprovada');
    expect(readFileSync(dockerLog, 'utf8')).toContain(`inspect --format {{.Id}} kassinao`);
    expect(existsSync(firewallLog)).toBe(false);
  });
});
