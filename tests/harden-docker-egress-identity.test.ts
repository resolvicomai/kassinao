import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.join(process.cwd(), 'scripts', 'harden-docker-egress.sh');
const REJECT_WITH = { 4: 'icmp-port-unreachable', 6: 'icmp6-port-unreachable' } as const;
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
  const rejectWith = REJECT_WITH[family];
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
    '-A DOCKER-USER -i kas-host0 -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN',
    `-A DOCKER-USER -i kas-host0 -j REJECT --reject-with ${rejectWith}`,
    '-A DOCKER-USER -i kas-core-eg0 -j KASSINAO-EGRESS',
    '-A DOCKER-USER -i kas-tunnel-eg0 -j KASSINAO-EGRESS',
    '-A INPUT -i kas-core-eg0 -j KASSINAO-HOST',
    '-A INPUT -i kas-tunnel-eg0 -j KASSINAO-HOST',
    '-A INPUT -i kas-host0 -j KASSINAO-HOST',
    '-A KASSINAO-EGRESS -j KASSINAO-EGRESS-A',
    ...destinations.map(
      (destination) => `-A KASSINAO-EGRESS-A -d ${destination} -j REJECT --reject-with ${rejectWith}`,
    ),
    '-A KASSINAO-EGRESS-A -j RETURN',
    '-A KASSINAO-HOST -j KASSINAO-HOST-A',
    '-A KASSINAO-HOST-A -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN',
    `-A KASSINAO-HOST-A -m addrtype --dst-type LOCAL -j REJECT --reject-with ${rejectWith}`,
    '-A KASSINAO-HOST-A -j RETURN',
    extraRule,
    '',
  ]
    .filter((line, index, lines) => line || index === lines.length - 1)
    .join('\n');
}

function basePolicyRules(): string {
  return ['-P INPUT ACCEPT', '-P FORWARD DROP', '-N DOCKER-USER', '-A FORWARD -j DOCKER-USER', ''].join('\n');
}

function legacyPolicyRules(family: 4 | 6, extraRule = ''): string {
  const rejectWith = REJECT_WITH[family];
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
    ...destinations.map(
      (destination) => `-A KASSINAO-EGRESS-A -d ${destination} -j REJECT --reject-with ${rejectWith}`,
    ),
    '-A KASSINAO-EGRESS-A -j RETURN',
    '-A KASSINAO-HOST -j KASSINAO-HOST-A',
    '-A KASSINAO-HOST-A -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN',
    `-A KASSINAO-HOST-A -m addrtype --dst-type LOCAL -j REJECT --reject-with ${rejectWith}`,
    '-A KASSINAO-HOST-A -j RETURN',
    extraRule,
    '',
  ]
    .filter((line, index, lines) => line || index === lines.length - 1)
    .join('\n');
}

function inactivePolicyRules(kind: 'current' | 'legacy', family: 4 | 6, role: 'egress' | 'host'): string[] {
  const rejectWith = REJECT_WITH[family];
  if (role === 'host') {
    return [
      '-A KASSINAO-HOST-B -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN',
      `-A KASSINAO-HOST-B -m addrtype --dst-type LOCAL -j REJECT --reject-with ${rejectWith}`,
      '-A KASSINAO-HOST-B -j RETURN',
    ];
  }
  const destinations =
    family === 4
      ? ['127.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16']
      : ['::1/128', 'fc00::/7', 'fe80::/10'];
  return [
    ...(kind === 'legacy' ? ['-A KASSINAO-EGRESS-B -o kas-private0 -j RETURN'] : []),
    ...destinations.map(
      (destination) => `-A KASSINAO-EGRESS-B -d ${destination} -j REJECT --reject-with ${rejectWith}`,
    ),
    '-A KASSINAO-EGRESS-B -j RETURN',
  ];
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

function mutableFirewall(
  command: 'iptables' | 'ip6tables',
  state: string,
  counter: string,
  fault: string,
  log: string,
): string {
  return `#!/usr/bin/env bash
set -eu
state=${shellLiteral(state)}
counter=${shellLiteral(counter)}
fault=${shellLiteral(fault)}
log=${shellLiteral(log)}
reject_with=${shellLiteral(command === 'iptables' ? REJECT_WITH[4] : REJECT_WITH[6])}
serialize_rule() {
  rule="$(printf '%s\n' "$1" | sed 's/--ctstate ESTABLISHED,RELATED/--ctstate RELATED,ESTABLISHED/g')"
  case "$rule" in
    *' -j REJECT') rule="$rule --reject-with $reject_with" ;;
  esac
  printf '%s\n' "$rule"
}
[ "\${1:-}" != -w ] || shift 2
printf '%s:%s\\n' ${shellLiteral(command)} "$*" >> "$log"
mutated=false
case "\${1:-}" in
  -S)
    if [ "$#" -eq 1 ]; then
      cat "$state"
    else
      chain="$2"
      exists=false
      case "$chain" in INPUT|FORWARD|OUTPUT) exists=true ;; esac
      if grep -Fqx -- "-N $chain" "$state"; then exists=true; fi
      [ "$exists" = true ] || exit 1
      awk -v chain="$chain" '($1 == "-N" && $2 == chain) || ($1 == "-A" && $2 == chain)' "$state"
    fi
    ;;
  -N)
    chain="$2"
    case "$chain" in INPUT|FORWARD|OUTPUT) exit 41 ;; esac
    grep -Fqx -- "-N $chain" "$state" && exit 41
    printf '%s\n' "-N $chain" >> "$state"
    mutated=true
    ;;
  -A)
    chain="$2"
    shift 2
    exists=false
    case "$chain" in INPUT|FORWARD|OUTPUT) exists=true ;; esac
    grep -Fqx -- "-N $chain" "$state" && exists=true
    [ "$exists" = true ] || exit 43
    rule="-A $chain"
    [ "$#" -eq 0 ] || rule="$rule $*"
    rule="$(serialize_rule "$rule")"
    printf '%s\n' "$rule" >> "$state"
    mutated=true
    ;;
  -I)
    chain="$2"
    position="$3"
    shift 3
    [[ "$position" =~ ^[1-9][0-9]*$ ]] || exit 46
    rule="-A $chain"
    [ "$#" -eq 0 ] || rule="$rule $*"
    rule="$(serialize_rule "$rule")"
    temporary="$state.tmp.$$"
    awk -v chain="$chain" -v position="$position" -v rule="$rule" '
      $1 == "-A" && $2 == chain {
        count++
        if (!inserted && count == position) { print rule; inserted = 1 }
      }
      { print }
      END { if (!inserted) print rule }
    ' "$state" > "$temporary"
    mv "$temporary" "$state"
    mutated=true
    ;;
  -R)
    chain="$2"
    position="$3"
    shift 3
    [[ "$position" =~ ^[1-9][0-9]*$ ]] || exit 46
    rule="-A $chain"
    [ "$#" -eq 0 ] || rule="$rule $*"
    rule="$(serialize_rule "$rule")"
    temporary="$state.tmp.$$"
    awk -v chain="$chain" -v position="$position" -v rule="$rule" '
      $1 == "-A" && $2 == chain {
        count++
        if (count == position) { print rule; replaced = 1; next }
      }
      { print }
      END { if (!replaced) exit 47 }
    ' "$state" > "$temporary" || { rm -f "$temporary"; exit 47; }
    mv "$temporary" "$state"
    mutated=true
    ;;
  -D)
    chain="$2"
    shift 2
    if [[ "\${1:-}" =~ ^[1-9][0-9]*$ ]] && [ "$#" -eq 1 ]; then
      position="$1"
      temporary="$state.tmp.$$"
      awk -v chain="$chain" -v position="$position" '
        $1 == "-A" && $2 == chain {
          count++
          if (count == position) { removed = 1; next }
        }
        { print }
        END { if (!removed) exit 42 }
      ' "$state" > "$temporary" || { rm -f "$temporary"; exit 42; }
      mv "$temporary" "$state"
      mutated=true
      shift
    else
    expected="-A $chain"
    [ "$#" -eq 0 ] || expected="$expected $*"
    expected="$(serialize_rule "$expected")"
    temporary="$state.tmp.$$"
    awk -v expected="$expected" '
      !removed && $0 == expected { removed = 1; next }
      { print }
      END { if (!removed) exit 42 }
    ' "$state" > "$temporary" || { rm -f "$temporary"; exit 42; }
    mv "$temporary" "$state"
    mutated=true
    fi
    ;;
  -F)
    chain="$2"
    grep -Fqx -- "-N $chain" "$state" || exit 43
    temporary="$state.tmp.$$"
    awk -v chain="$chain" '!($1 == "-A" && $2 == chain) { print }' "$state" > "$temporary"
    mv "$temporary" "$state"
    mutated=true
    ;;
  -X)
    chain="$2"
    grep -Fqx -- "-N $chain" "$state" || exit 44
    awk -v chain="$chain" '
      $1 == "-A" && $2 == chain { busy = 1 }
      $1 == "-A" {
        for (i = 1; i < NF; i++) {
          if (($i == "-j" || $i == "-g") && $(i + 1) == chain) busy = 1
        }
      }
      END { exit busy ? 1 : 0 }
    ' "$state" || exit 45
    temporary="$state.tmp.$$"
    awk -v chain="$chain" '!($1 == "-N" && $2 == chain) { print }' "$state" > "$temporary"
    mv "$temporary" "$state"
    mutated=true
    ;;
  *)
    exit 80
    ;;
esac
if [ "$mutated" = true ]; then
  count=0
  if [ -s "$counter" ]; then read -r count < "$counter"; fi
  count=$((count + 1))
  printf '%s\\n' "$count" > "$counter"
  expected=''
  if [ -s "$fault" ]; then read -r expected < "$fault"; fi
  [ "$expected" != "$count" ] || exit 97
fi
`;
}

function runOfflineBootstrap() {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'kassinao-hardener-offline-')));
  tempDirs.push(directory);
  const bin = path.join(directory, 'bin');
  const runtime = path.join(directory, 'runtime');
  const v4 = path.join(directory, 'v4.rules');
  const v6 = path.join(directory, 'v6.rules');
  const v4Counter = path.join(directory, 'v4.counter');
  const v6Counter = path.join(directory, 'v6.counter');
  const v4Fault = path.join(directory, 'v4.fault');
  const v6Fault = path.join(directory, 'v6.fault');
  const firewallLog = path.join(directory, 'firewall.log');
  mkdirSync(bin);
  mkdirSync(runtime, { mode: 0o700 });
  const script = hardenerScript(directory, runtime);
  const cleanBoot = ['-P INPUT ACCEPT', '-P FORWARD DROP', ''].join('\n');
  writeFileSync(v4, cleanBoot);
  writeFileSync(v6, cleanBoot);
  for (const file of [v4Counter, v6Counter, v4Fault, v6Fault, firewallLog]) writeFileSync(file, '');

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
  executable(path.join(bin, 'iptables'), mutableFirewall('iptables', v4, v4Counter, v4Fault, firewallLog));
  executable(path.join(bin, 'ip6tables'), mutableFirewall('ip6tables', v6, v6Counter, v6Fault, firewallLog));

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

  return {
    log: firewallLog,
    read(family: 4 | 6): string {
      return readFileSync(family === 4 ? v4 : v6, 'utf8');
    },
    runFirewall(family: 4 | 6, args: string[]) {
      return spawnSync(path.join(bin, family === 4 ? 'iptables' : 'ip6tables'), args, { encoding: 'utf8' });
    },
    result: spawnSync('bash', [script, '--offline-preload'], {
      encoding: 'utf8',
      env: environment,
    }),
  };
}

function removalHarness(
  options: {
    docker?: 'daemon-failure' | 'empty' | 'restart-enabled' | 'running';
    kind?: 'current' | 'legacy';
    v4?: 'present' | 'absent';
    v6?: 'present' | 'absent';
  } = {},
) {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'kassinao-hardener-remove-')));
  tempDirs.push(directory);
  const bin = path.join(directory, 'bin');
  const runtime = path.join(directory, 'runtime');
  const v4 = path.join(directory, 'v4.rules');
  const v6 = path.join(directory, 'v6.rules');
  const v4Counter = path.join(directory, 'v4.counter');
  const v6Counter = path.join(directory, 'v6.counter');
  const v4Fault = path.join(directory, 'v4.fault');
  const v6Fault = path.join(directory, 'v6.fault');
  const firewallLog = path.join(directory, 'firewall.log');
  mkdirSync(bin);
  mkdirSync(runtime, { mode: 0o700 });
  const script = hardenerScript(directory, runtime);
  const rules = options.kind === 'legacy' ? legacyPolicyRules : policyRules;
  writeFileSync(v4, options.v4 === 'absent' ? basePolicyRules() : rules(4));
  writeFileSync(v6, options.v6 === 'absent' ? basePolicyRules() : rules(6));
  for (const file of [v4Counter, v6Counter, v4Fault, v6Fault, firewallLog]) writeFileSync(file, '');

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
  const coreId = 'a'.repeat(64);
  const dockerMode = options.docker ?? 'empty';
  executable(
    path.join(bin, 'docker'),
    `#!/usr/bin/env bash
set -eu
mode=${shellLiteral(dockerMode)}
core=${shellLiteral(coreId)}
if [ "\${1:-}" = container ] && [ "\${2:-}" = ls ]; then
  [ "$mode" != daemon-failure ] || exit 70
  case "$mode" in
    empty) ;;
    *) printf '%s|kassinao\\n' "$core" ;;
  esac
  exit 0
fi
if [ "\${1:-}" = inspect ] && [ "\${2:-}" = --format ] && [ "\${4:-}" = "$core" ]; then
  case "\${3:-}" in
    '{{.Id}}') printf '%s\\n' "$core" ;;
    *com.docker.compose.project*)
      printf '%s|/kassinao|kassinao|kassinao\\n' "$core"
      ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ "\${1:-}" = inspect ] && [ "\${2:-}" = -f ] && [ "\${4:-}" = "$core" ]; then
  case "\${3:-}" in
    '{{.State.Running}}')
      [ "$mode" = running ] && printf 'true\\n' || printf 'false\\n'
      ;;
    '{{.HostConfig.RestartPolicy.Name}}')
      [ "$mode" = restart-enabled ] && printf 'unless-stopped\\n' || printf 'no\\n'
      ;;
    *) exit 1 ;;
  esac
  exit 0
fi
exit 1
`,
  );
  executable(path.join(bin, 'iptables'), mutableFirewall('iptables', v4, v4Counter, v4Fault, firewallLog));
  executable(path.join(bin, 'ip6tables'), mutableFirewall('ip6tables', v6, v6Counter, v6Fault, firewallLog));

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

  return {
    append(family: 4 | 6, rule: string): void {
      const file = family === 4 ? v4 : v6;
      writeFileSync(file, `${readFileSync(file, 'utf8').trimEnd()}\n${rule}\n`);
    },
    remove(family: 4 | 6, rule: string): void {
      const file = family === 4 ? v4 : v6;
      const lines = readFileSync(file, 'utf8').split('\n');
      const matches = lines.flatMap((line, index) => (line === rule ? [index] : []));
      if (matches.length !== 1) throw new Error(`expected one rule to remove, got ${matches.length}`);
      lines.splice(matches[0], 1);
      writeFileSync(file, lines.join('\n'));
    },
    read(family: 4 | 6): string {
      return readFileSync(family === 4 ? v4 : v6, 'utf8');
    },
    write(family: 4 | 6, rules: string): void {
      writeFileSync(family === 4 ? v4 : v6, rules);
    },
    replace(family: 4 | 6, before: string, after: string): void {
      const file = family === 4 ? v4 : v6;
      const lines = readFileSync(file, 'utf8').split('\n');
      const matches = lines.flatMap((line, index) => (line === before ? [index] : []));
      if (matches.length !== 1) throw new Error(`expected one rule to replace, got ${matches.length}`);
      lines[matches[0]] = after;
      writeFileSync(file, lines.join('\n'));
    },
    state() {
      const mode = options.kind === 'legacy' ? '--legacy-removal-state' : '--removal-state';
      return spawnSync('bash', [script, '--shared-host', mode], {
        encoding: 'utf8',
        env: environment,
      });
    },
    run(fault?: { afterMutation: number; family: 4 | 6 }) {
      writeFileSync(v4Counter, '');
      writeFileSync(v6Counter, '');
      writeFileSync(v4Fault, fault?.family === 4 ? `${fault.afterMutation}\n` : '');
      writeFileSync(v6Fault, fault?.family === 6 ? `${fault.afterMutation}\n` : '');
      const mode = options.kind === 'legacy' ? '--remove-legacy-policy' : '--remove';
      return spawnSync('bash', [script, '--shared-host', mode], {
        encoding: 'utf8',
        env: environment,
      });
    },
  };
}

function runTopologyCheck(
  options: {
    extraInternalMember?: boolean;
    extraNetworkRole?: 'core' | 'router' | 'public' | 'tunnel';
    missingPublic?: boolean;
    wrongGateway?: boolean;
    wrongHostBinding?: boolean;
    wrongHostGateway6?: boolean;
    wrongHostInternal?: boolean;
    wrongHostIpv6?: boolean;
    wrongIcc?: boolean;
    wrongInternal?: boolean;
    withoutTunnel?: boolean;
  } = {},
) {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'kassinao-hardener-topology-')));
  tempDirs.push(directory);
  const bin = path.join(directory, 'bin');
  const runtime = path.join(directory, 'runtime');
  const v4 = path.join(directory, 'v4.rules');
  const v6 = path.join(directory, 'v6.rules');
  mkdirSync(bin);
  mkdirSync(runtime, { mode: 0o700 });
  const script = hardenerScript(directory, runtime);
  writeFileSync(v4, policyRules(4));
  writeFileSync(v6, policyRules(6));
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

  const coreId = 'a'.repeat(64);
  const routerId = 'b'.repeat(64);
  const publicId = 'c'.repeat(64);
  const tunnelId = 'd'.repeat(64);
  const foreignId = 'e'.repeat(64);
  const networksFor = (role: 'core' | 'router' | 'public' | 'tunnel', baseline: string): string =>
    options.extraNetworkRole === role ? `${baseline}\\nforeign_${role}` : baseline;
  const coreNetworks = networksFor('core', 'kassinao_core_link\\nkassinao_core_egress');
  const routerNetworks = networksFor(
    'router',
    'kassinao_host_ingress\\nkassinao_edge_ingress\\nkassinao_core_link\\nkassinao_public_link',
  );
  const publicNetworks = networksFor('public', 'kassinao_public_link');
  const tunnelNetworks = networksFor('tunnel', 'kassinao_edge_ingress\\nkassinao_tunnel_egress');
  const publicDiscovery = options.missingPublic ? 'exit 1' : `printf '${publicId}\\n'`;
  const tunnelDiscovery = options.withoutTunnel ? 'exit 1' : `printf '${tunnelId}\\n'`;
  const coreLinkMembers = options.extraInternalMember
    ? `${coreId}|kassinao\\n${routerId}|kassinao-router\\n${foreignId}|neighbor`
    : `${coreId}|kassinao\\n${routerId}|kassinao-router`;
  const edgeMembers = options.withoutTunnel
    ? `${routerId}|kassinao-router`
    : `${routerId}|kassinao-router\\n${tunnelId}|kassinao-tunnel`;
  const coreLinkMetadata = `bridge|${options.wrongInternal ? 'false' : 'true'}|false|kas-core0||${
    options.wrongGateway ? 'nat' : 'isolated'
  }|isolated|true`;
  const coreEgressMetadata = `bridge|false|false|kas-core-eg0||||${options.wrongIcc ? 'true' : 'false'}`;
  executable(
    path.join(bin, 'docker'),
    `#!/usr/bin/env bash
set -eu
if [ "\${1:-}" = inspect ] && [ "\${2:-}" = --format ]; then
  case "\${4:-}" in
    kassinao) printf '${coreId}\\n' ;;
    kassinao-router) printf '${routerId}\\n' ;;
    kassinao-public) ${publicDiscovery} ;;
    kassinao-tunnel) ${tunnelDiscovery} ;;
    ${coreId}) printf '${coreId}|/kassinao|kassinao|kassinao\\n' ;;
    ${routerId}) printf '${routerId}|/kassinao-router|kassinao|kassinao-router\\n' ;;
    ${publicId}) printf '${publicId}|/kassinao-public|kassinao|kassinao-public\\n' ;;
    ${tunnelId}) printf '${tunnelId}|/kassinao-tunnel|kassinao|cloudflared\\n' ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ "\${1:-}" = inspect ] && [ "\${2:-}" = -f ]; then
  case "\${4:-}" in
    ${coreId}) printf '${coreNetworks}\\n' ;;
    ${routerId}) printf '${routerNetworks}\\n' ;;
    ${publicId}) printf '${publicNetworks}\\n' ;;
    ${tunnelId}) printf '${tunnelNetworks}\\n' ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ "\${1:-}" = network ] && [ "\${2:-}" = inspect ] && [ "\${3:-}" = -f ]; then
  if [[ "\${4:-}" == *'.Containers'* ]]; then
    case "\${5:-}" in
      kassinao_core_link) printf '${coreLinkMembers}\\n' ;;
      kassinao_core_egress) printf '${coreId}|kassinao\\n' ;;
      kassinao_host_ingress) printf '${routerId}|kassinao-router\\n' ;;
      kassinao_edge_ingress) printf '${edgeMembers}\\n' ;;
      kassinao_public_link) printf '${routerId}|kassinao-router\\n${publicId}|kassinao-public\\n' ;;
      kassinao_tunnel_egress) printf '${tunnelId}|kassinao-tunnel\\n' ;;
      *) exit 1 ;;
    esac
  else
    case "\${5:-}" in
      kassinao_core_link) printf '${coreLinkMetadata}\\n' ;;
      kassinao_core_egress) printf '${coreEgressMetadata}\\n' ;;
      kassinao_host_ingress) printf 'bridge|${options.wrongHostInternal ? 'true' : 'false'}|${
        options.wrongHostIpv6 ? 'true' : 'false'
      }|kas-host0|${options.wrongHostBinding ? '0.0.0.0' : '127.0.0.1'}|nat|${
        options.wrongHostGateway6 ? 'nat' : ''
      }|false\\n' ;;
      kassinao_edge_ingress) printf 'bridge|true|false|kas-edge0||isolated|isolated|true\\n' ;;
      kassinao_public_link) printf 'bridge|true|false|kas-public0||isolated|isolated|true\\n' ;;
      kassinao_tunnel_egress) printf 'bridge|false|false|kas-tunnel-eg0||||false\\n' ;;
      foreign_core) printf 'bridge|false|false|foreign-core-eg0||||false\\n' ;;
      foreign_router) printf 'bridge|true|false|foreign-router0||isolated|isolated|true\\n' ;;
      foreign_public) printf 'bridge|true|false|foreign-public0||isolated|isolated|true\\n' ;;
      foreign_tunnel) printf 'bridge|false|false|foreign-tunnel-eg0||||false\\n' ;;
      *) exit 1 ;;
    esac
  fi
  exit 0
fi
exit 1
`,
  );
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
  return spawnSync('bash', [script, '--shared-host', '--check'], {
    encoding: 'utf8',
    env: environment,
  });
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

describe('identidade da topologia no hardener de egress', () => {
  it('pré-carrega um boot dedicated limpo ainda sem DOCKER-USER', () => {
    const bootstrap = runOfflineBootstrap();

    expect(bootstrap.result.status, bootstrap.result.stderr).toBe(0);
    expect(bootstrap.result.stdout).toContain('pré-carregada antes do daemon Docker');
    for (const family of [4, 6] as const) {
      const rules = bootstrap.read(family);
      const rejectWith = REJECT_WITH[family];
      expect(rules).toContain('-N DOCKER-USER');
      expect(rules).toContain('-A FORWARD -j DOCKER-USER');
      expect(rules).toContain('-A DOCKER-USER -i kas-host0 -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN');
      expect(rules).toContain(`-A DOCKER-USER -i kas-host0 -j REJECT --reject-with ${rejectWith}`);
      expect(rules).toContain('-A DOCKER-USER -i kas-core-eg0 -j KASSINAO-EGRESS');
      expect(rules).toContain('-A DOCKER-USER -i kas-tunnel-eg0 -j KASSINAO-EGRESS');
      expect(rules).toContain(
        `-A KASSINAO-EGRESS-A -d ${family === 4 ? '127.0.0.0/8' : '::1/128'} -j REJECT --reject-with ${rejectWith}`,
      );
      expect(rules).toContain(`-A KASSINAO-HOST-A -m addrtype --dst-type LOCAL -j REJECT --reject-with ${rejectWith}`);

      expect(bootstrap.runFirewall(family, ['-N', 'SERIALIZATION-PROBE']).status).toBe(0);
      expect(
        bootstrap.runFirewall(family, [
          '-A',
          'SERIALIZATION-PROBE',
          '-m',
          'conntrack',
          '--ctstate',
          'ESTABLISHED,RELATED',
          '-j',
          'RETURN',
        ]).status,
      ).toBe(0);
      expect(bootstrap.runFirewall(family, ['-A', 'SERIALIZATION-PROBE', '-j', 'REJECT']).status).toBe(0);
      expect(bootstrap.read(family)).toContain(
        '-A SERIALIZATION-PROBE -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN',
      );
      expect(bootstrap.read(family)).toContain(`-A SERIALIZATION-PROBE -j REJECT --reject-with ${rejectWith}`);
    }
    const log = readFileSync(bootstrap.log, 'utf8');
    expect(log).toContain('iptables:-S DOCKER-USER');
    expect(log).toContain('iptables:-N DOCKER-USER');
    expect(log).toContain('ip6tables:-S DOCKER-USER');
    expect(log).toContain('ip6tables:-N DOCKER-USER');
  });

  it('aprova anchors com uma única referência no hook e bridge exatos', () => {
    const result = runPolicyCheck();
    expect(result.status, result.stderr).toBe(0);
  });

  it('aprova a topologia com egress exclusivo para core e túnel', () => {
    const result = runTopologyCheck();
    expect(result.status, result.stderr).toBe(0);
  });

  it('aprova o perfil split-public sem túnel e mantém a segunda bridge pré-carregada', () => {
    const result = runTopologyCheck({ withoutTunnel: true });
    expect(result.status, result.stderr).toBe(0);
  });

  it('recusa endpoint adicional em link interno aprovado', () => {
    const result = runTopologyCheck({ extraInternalMember: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('membership da bridge kas-core0 diverge');
  });

  it.each(['core', 'router', 'public', 'tunnel'] as const)(
    'recusa rede Docker extra no papel %s',
    (extraNetworkRole) => {
      const result = runTopologyCheck({ extraNetworkRole });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('participa de rede não autorizada');
    },
  );

  it('recusa link interno que deixou de ser internal', () => {
    const result = runTopologyCheck({ wrongInternal: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('bridge interna kas-core0 não está isolada');
  });

  it('recusa link interno sem gateway mode isolated', () => {
    const result = runTopologyCheck({ wrongGateway: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('bridge interna kas-core0 não está isolada');
  });

  it('recusa egress que deixou de usar ICC=false', () => {
    const result = runTopologyCheck({ wrongIcc: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('bridge de egress kas-core-eg0 não está selada');
  });

  it.each([
    ['internal', { wrongHostInternal: true }],
    ['IPv6 ativo', { wrongHostIpv6: true }],
    ['binding amplo', { wrongHostBinding: true }],
    ['gateway IPv6', { wrongHostGateway6: true }],
  ] as const)('recusa host ingress %s', (_label, options) => {
    const result = runTopologyCheck(options);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('bridge host ingress kas-host0 precisa ser externa');
  });

  it('recusa topologia parcial em vez de aplicar policy ambígua', () => {
    const result = runTopologyCheck({ missingPublic: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('topologia parcial');
  });

  it.each([
    ['IPv4', '-A INPUT -j KASSINAO-EGRESS', ''],
    ['IPv6', '', '-A DOCKER-USER -i neighbor0 -j KASSINAO-HOST'],
    ['IPv4 goto', '-A INPUT -g KASSINAO-EGRESS', ''],
    ['IPv6 policy goto', '', '-A OUTPUT -g KASSINAO-HOST-B'],
  ])('recusa referência externa/duplicada aos anchors em %s', (_family, extraV4, extraV6) => {
    const result = runPolicyCheck(extraV4, extraV6);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('política de egress/host ausente, incompleta ou desviada');
  });

  it.each([
    ['IPv4', '-A INPUT -j KASSINAO-EGRESS', ''],
    ['IPv6', '', '-A DOCKER-USER -i neighbor0 -j KASSINAO-HOST'],
    ['IPv4 goto', '-A INPUT -g KASSINAO-EGRESS', ''],
    ['IPv6 policy goto', '', '-A OUTPUT -g KASSINAO-HOST-B'],
  ])('recusa anchor externo em %s antes da primeira mutação de apply', (_family, extraV4, extraV6) => {
    const result = runPolicyCheck(extraV4, extraV6, 'apply');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('referência externa/duplicada aos anchors KASSINAO');
    expect(result.stderr).toContain('nenhuma regra foi alterada');
  });

  it.each([
    ['present', {}, 'present'],
    ['absent', { v4: 'absent', v6: 'absent' } as const, 'absent'],
    ['mixed', { v4: 'absent' } as const, 'owned-progress'],
  ])('classifica policy current %s sem mutação', (_label, options, expected) => {
    const harness = removalHarness(options);
    const beforeV4 = harness.read(4);
    const beforeV6 = harness.read(6);

    const state = harness.state();

    expect(state.status, state.stderr).toBe(0);
    expect(state.stdout).toBe(`${expected}\n`);
    expect(harness.read(4)).toBe(beforeV4);
    expect(harness.read(6)).toBe(beforeV6);
  });

  it('classifica progresso owned current após interrupção', () => {
    const harness = removalHarness();
    const interrupted = harness.run({ afterMutation: 5, family: 4 });
    expect(interrupted.status).not.toBe(0);
    const beforeV4 = harness.read(4);
    const beforeV6 = harness.read(6);

    const state = harness.state();

    expect(state.status, state.stderr).toBe(0);
    expect(state.stdout).toBe('owned-progress\n');
    expect(harness.read(4)).toBe(beforeV4);
    expect(harness.read(6)).toBe(beforeV6);
  }, 15_000);

  it('read-only current recusa policy estrangeira sem stdout nem mutação', () => {
    const harness = removalHarness();
    harness.append(4, '-A OUTPUT -j KASSINAO-EGRESS');
    const beforeV4 = harness.read(4);
    const beforeV6 = harness.read(6);

    const state = harness.state();

    expect(state.status).not.toBe(0);
    expect(state.stdout).toBe('');
    expect(harness.read(4)).toBe(beforeV4);
    expect(harness.read(6)).toBe(beforeV6);
  });

  it.each(['current', 'legacy'] as const)('estado read-only %s não depende do daemon Docker', (kind) => {
    const harness = removalHarness({ docker: 'daemon-failure', kind });

    const state = harness.state();

    expect(state.status, state.stderr).toBe(0);
    expect(state.stdout).toBe('present\n');
  });

  it.each(
    (['current', 'legacy'] as const).flatMap((kind) =>
      [
        ['daemon-failure', 'daemon Docker indisponível'],
        ['running', 'precisa estar parado'],
        ['restart-enabled', 'desative o restart policy'],
      ].map(([docker, message]) => ({
        docker: docker as 'daemon-failure' | 'restart-enabled' | 'running',
        kind,
        message,
      })),
    ),
  )('remoção $kind falha fechada com gate Docker $docker', ({ docker, kind, message }) => {
    const harness = removalHarness({ docker, kind });
    const beforeV4 = harness.read(4);
    const beforeV6 = harness.read(6);

    const result = harness.run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(harness.read(4)).toBe(beforeV4);
    expect(harness.read(6)).toBe(beforeV6);
  });

  it.each(
    (['current', 'legacy'] as const).flatMap((kind) =>
      ([4, 6] as const).flatMap((family) =>
        (['egress', 'host'] as const).flatMap((role) => {
          const rules = inactivePolicyRules(kind, family, role);
          return Array.from({ length: rules.length - 1 }, (_value, index) => ({
            family,
            kind,
            prefix: index + 1,
            role,
          }));
        }),
      ),
    ),
  )(
    'classifica e remove prefixo owned $kind IPv$family $role $prefix',
    ({ family, kind, prefix, role }) => {
      const harness = removalHarness({ kind });
      for (const rule of inactivePolicyRules(kind, family, role).slice(0, prefix)) {
        harness.append(family, rule);
      }
      const beforeV4 = harness.read(4);
      const beforeV6 = harness.read(6);

      const state = harness.state();
      expect(state.status, state.stderr).toBe(0);
      expect(state.stdout).toBe('owned-progress\n');
      expect(harness.read(4)).toBe(beforeV4);
      expect(harness.read(6)).toBe(beforeV6);

      const removed = harness.run();
      expect(removed.status, removed.stderr).toBe(0);
      expect(harness.read(4)).not.toContain('KASSINAO-');
      expect(harness.read(6)).not.toContain('KASSINAO-');
    },
    15_000,
  );

  it.each(
    (['current', 'legacy'] as const).flatMap((kind) => (['egress', 'host'] as const).map((role) => ({ kind, role }))),
  )('recusa child $kind $role parcial quando já está referenciada', ({ kind, role }) => {
    const harness = removalHarness({ kind });
    const first = inactivePolicyRules(kind, 4, role)[0]!;
    harness.append(4, first);
    const anchor = role === 'egress' ? 'KASSINAO-EGRESS' : 'KASSINAO-HOST';
    harness.replace(4, `-A ${anchor} -j ${anchor}-A`, `-A ${anchor} -j ${anchor}-B`);
    const beforeV4 = harness.read(4);
    const beforeV6 = harness.read(6);

    const state = harness.state();

    expect(state.status).not.toBe(0);
    expect(state.stdout).toBe('');
    expect(harness.read(4)).toBe(beforeV4);
    expect(harness.read(6)).toBe(beforeV6);
  });

  it.each(
    (['current', 'legacy'] as const).flatMap((kind) => (['egress', 'host'] as const).map((role) => ({ kind, role }))),
  )('recusa prefixo $kind $role fora de ordem', ({ kind, role }) => {
    const harness = removalHarness({ kind });
    const rules = inactivePolicyRules(kind, 4, role);
    harness.append(4, rules[1]);
    const beforeV4 = harness.read(4);
    const beforeV6 = harness.read(6);

    const state = harness.state();

    expect(state.status).not.toBe(0);
    expect(state.stdout).toBe('');
    expect(harness.read(4)).toBe(beforeV4);
    expect(harness.read(6)).toBe(beforeV6);
  });

  it.each([
    ['current', '-A DOCKER-USER -i kas-host0 -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN'],
    ['current', '-A DOCKER-USER -i kas-host0 -j REJECT --reject-with icmp-port-unreachable'],
    ['current', '-A DOCKER-USER -i kas-core-eg0 -j KASSINAO-EGRESS'],
    ['current', '-A DOCKER-USER -i kas-tunnel-eg0 -j KASSINAO-EGRESS'],
    ['current', '-A INPUT -i kas-core-eg0 -j KASSINAO-HOST'],
    ['current', '-A INPUT -i kas-tunnel-eg0 -j KASSINAO-HOST'],
    ['current', '-A INPUT -i kas-host0 -j KASSINAO-HOST'],
    ['legacy', '-A DOCKER-USER -i kas-private0 -j KASSINAO-EGRESS'],
    ['legacy', '-A INPUT -i kas-private0 -j KASSINAO-HOST'],
  ] as const)(
    'retoma policy %s com hook owned ainda ausente: %s',
    (kind, hook) => {
      const harness = removalHarness({ kind });
      harness.remove(4, hook);

      const state = harness.state();
      expect(state.status, state.stderr).toBe(0);
      expect(state.stdout).toBe('owned-progress\n');

      const removed = harness.run();
      expect(removed.status, removed.stderr).toBe(0);
      expect(harness.read(4)).not.toContain('KASSINAO-');
      expect(harness.read(6)).not.toContain('KASSINAO-');
    },
    15_000,
  );

  it.each(
    (['current', 'legacy'] as const).flatMap((kind) =>
      ([4, 6] as const).flatMap((family) => (['egress', 'host'] as const).map((role) => ({ family, kind, role }))),
    ),
  )('aceita activate atômico $kind IPv$family $role com child completa', ({ family, kind, role }) => {
    const harness = removalHarness({ kind });
    for (const rule of inactivePolicyRules(kind, family, role)) harness.append(family, rule);
    const anchor = role === 'egress' ? 'KASSINAO-EGRESS' : 'KASSINAO-HOST';
    harness.replace(family, `-A ${anchor} -j ${anchor}-A`, `-A ${anchor} -j ${anchor}-B`);

    const state = harness.state();

    expect(state.status, state.stderr).toBe(0);
    expect(state.stdout).toBe('present\n');
  });

  it.each(
    ([4, 6] as const).flatMap((family) =>
      Array.from({ length: 16 }, (_value, index) => ({
        family,
        step: index + 1,
      })),
    ),
  )(
    'retoma remoção após falha owned $step em IPv$family',
    ({ family, step }) => {
      const harness = removalHarness();

      const interrupted = harness.run({ afterMutation: step, family });
      expect(interrupted.status).not.toBe(0);

      const resumed = harness.run();
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(harness.read(4)).not.toContain('KASSINAO-');
      expect(harness.read(6)).not.toContain('KASSINAO-');
    },
    15_000,
  );

  it('aceita IPv4 já ausente e conclui a remoção IPv6', () => {
    const harness = removalHarness({ v4: 'absent' });

    const result = harness.run();

    expect(result.status, result.stderr).toBe(0);
    expect(harness.read(4)).not.toContain('KASSINAO-');
    expect(harness.read(6)).not.toContain('KASSINAO-');
  });

  it('é idempotente quando as duas famílias já estão ausentes', () => {
    const harness = removalHarness({ v4: 'absent', v6: 'absent' });

    const result = harness.run();

    expect(result.status, result.stderr).toBe(0);
    expect(harness.read(4)).toBe(basePolicyRules());
    expect(harness.read(6)).toBe(basePolicyRules());
  });

  it('recusa referência estrangeira surgida durante uma remoção parcial sem tocar na outra família', () => {
    const harness = removalHarness();
    const interrupted = harness.run({ afterMutation: 4, family: 4 });
    expect(interrupted.status).not.toBe(0);
    harness.append(4, '-A OUTPUT -j KASSINAO-EGRESS');
    const beforeV4 = harness.read(4);
    const beforeV6 = harness.read(6);

    const retry = harness.run();

    expect(retry.status).not.toBe(0);
    expect(retry.stderr).toContain('regras Kassinão divergiram');
    expect(harness.read(4)).toBe(beforeV4);
    expect(harness.read(6)).toBe(beforeV6);
  });

  it('recusa regra estrangeira dentro de chain própria durante uma remoção parcial', () => {
    const harness = removalHarness();
    const interrupted = harness.run({ afterMutation: 5, family: 6 });
    expect(interrupted.status).not.toBe(0);
    harness.append(6, '-A KASSINAO-EGRESS-A -j ACCEPT');
    const beforeV4 = harness.read(4);
    const beforeV6 = harness.read(6);

    const retry = harness.run();

    expect(retry.status).not.toBe(0);
    expect(retry.stderr).toContain('regras Kassinão divergiram');
    expect(harness.read(4)).toBe(beforeV4);
    expect(harness.read(6)).toBe(beforeV6);
  }, 15_000);

  it.each([
    ['present', {}, 'present'],
    ['absent', { v4: 'absent', v6: 'absent' } as const, 'absent'],
    ['mixed', { v6: 'absent' } as const, 'owned-progress'],
  ])('classifica policy legacy %s sem mutação', (_label, stateOptions, expected) => {
    const harness = removalHarness({ kind: 'legacy', ...stateOptions });
    const beforeV4 = harness.read(4);
    const beforeV6 = harness.read(6);

    const state = harness.state();

    expect(state.status, state.stderr).toBe(0);
    expect(state.stdout).toBe(`${expected}\n`);
    expect(harness.read(4)).toBe(beforeV4);
    expect(harness.read(6)).toBe(beforeV6);
  });

  it('classifica progresso owned legacy após interrupção', () => {
    const harness = removalHarness({ kind: 'legacy' });
    const interrupted = harness.run({ afterMutation: 4, family: 6 });
    expect(interrupted.status).not.toBe(0);
    const beforeV4 = harness.read(4);
    const beforeV6 = harness.read(6);

    const state = harness.state();

    expect(state.status, state.stderr).toBe(0);
    expect(state.stdout).toBe('owned-progress\n');
    expect(harness.read(4)).toBe(beforeV4);
    expect(harness.read(6)).toBe(beforeV6);
  }, 15_000);

  it('read-only legacy recusa policy current e regra estrangeira sem mutação', () => {
    const wrongKind = removalHarness({ kind: 'legacy' });
    wrongKind.write(4, policyRules(4));
    wrongKind.write(6, policyRules(6));
    const currentV4 = wrongKind.read(4);
    const currentV6 = wrongKind.read(6);
    const wrongKindState = wrongKind.state();
    expect(wrongKindState.status).not.toBe(0);
    expect(wrongKindState.stdout).toBe('');
    expect(wrongKind.read(4)).toBe(currentV4);
    expect(wrongKind.read(6)).toBe(currentV6);

    const legacy = removalHarness({ kind: 'legacy' });
    legacy.append(6, '-A OUTPUT -g KASSINAO-HOST-B');
    const beforeV4 = legacy.read(4);
    const beforeV6 = legacy.read(6);
    const state = legacy.state();
    expect(state.status).not.toBe(0);
    expect(state.stdout).toBe('');
    expect(legacy.read(4)).toBe(beforeV4);
    expect(legacy.read(6)).toBe(beforeV6);
  });

  it.each(
    ([4, 6] as const).flatMap((family) =>
      Array.from({ length: 14 }, (_value, index) => ({
        family,
        step: index + 1,
      })),
    ),
  )(
    'retoma remoção legacy após falha owned $step em IPv$family',
    ({ family, step }) => {
      const harness = removalHarness({ kind: 'legacy' });

      const interrupted = harness.run({ afterMutation: step, family });
      expect(interrupted.status).not.toBe(0);

      const state = harness.state();
      expect(state.status, state.stderr).toBe(0);
      expect(state.stdout).toBe(family === 6 && step === 14 ? 'absent\n' : 'owned-progress\n');

      const resumed = harness.run();
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(harness.read(4)).not.toContain('KASSINAO-');
      expect(harness.read(6)).not.toContain('KASSINAO-');
    },
    15_000,
  );

  it('legacy aceita família já ausente e termina idempotente', () => {
    const harness = removalHarness({ kind: 'legacy', v4: 'absent' });

    const first = harness.run();
    expect(first.status, first.stderr).toBe(0);
    const second = harness.run();
    expect(second.status, second.stderr).toBe(0);
    expect(harness.read(4)).not.toContain('KASSINAO-');
    expect(harness.read(6)).not.toContain('KASSINAO-');
  });

  it('legacy recusa referência estrangeira durante progresso sem tocar na outra família', () => {
    const harness = removalHarness({ kind: 'legacy' });
    const interrupted = harness.run({ afterMutation: 3, family: 4 });
    expect(interrupted.status).not.toBe(0);
    harness.append(4, '-A OUTPUT -j KASSINAO-EGRESS');
    const beforeV4 = harness.read(4);
    const beforeV6 = harness.read(6);

    const retry = harness.run();

    expect(retry.status).not.toBe(0);
    expect(retry.stderr).toContain('regras legacy Kassinão divergiram');
    expect(harness.read(4)).toBe(beforeV4);
    expect(harness.read(6)).toBe(beforeV6);
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
