import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SOURCE = readFileSync(path.join(ROOT, 'scripts', 'remove-legacy-health-watch.sh'), 'utf8');

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function executable(file: string, contents: string): void {
  writeFileSync(file, contents, { mode: 0o755 });
  chmodSync(file, 0o755);
}

function fixture(options: { validatorFails?: boolean; dropIn?: boolean; tamperAfterStop?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'kassinao-legacy-watch-')));
  chmodSync(root, 0o700);
  const bundle = path.join(root, 'bundle');
  const scripts = path.join(bundle, 'scripts');
  const current = path.join(root, 'current');
  const currentScripts = path.join(current, 'scripts');
  const currentUnits = path.join(current, 'deploy', 'systemd');
  const installedBin = path.join(root, 'installed', 'kassinao-health-watch');
  const installedService = path.join(root, 'installed', 'kassinao-health-watch.service');
  const installedTimer = path.join(root, 'installed', 'kassinao-health-watch.timer');
  const bin = path.join(root, 'bin');
  const calls = path.join(root, 'calls.log');
  const unrelated = path.join(root, 'installed', 'company.service');
  mkdirSync(scripts, { recursive: true, mode: 0o700 });
  mkdirSync(currentScripts, { recursive: true, mode: 0o700 });
  mkdirSync(currentUnits, { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(installedBin), { recursive: true, mode: 0o700 });
  mkdirSync(bin, { mode: 0o700 });

  const files = [
    [path.join(currentScripts, 'health-watch.sh'), installedBin, '#!/usr/bin/env bash\nexit 0\n', 0o755],
    [path.join(currentUnits, 'kassinao-health-watch.service'), installedService, '[Service]\nType=oneshot\n', 0o644],
    [path.join(currentUnits, 'kassinao-health-watch.timer'), installedTimer, '[Timer]\nOnBootSec=2min\n', 0o644],
  ] as const;
  for (const [source, destination, contents, mode] of files) {
    writeFileSync(source, contents, { mode });
    chmodSync(source, mode);
    writeFileSync(destination, contents, { mode });
    chmodSync(destination, mode);
  }
  writeFileSync(unrelated, 'keep me\n', { mode: 0o644 });

  const safePath = `${bin}:/opt/homebrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
  const helper = path.join(scripts, 'remove-legacy-health-watch.sh');
  const inheritedEnvironment = path.join(root, 'inherited-environment.bin');
  writeFileSync(
    inheritedEnvironment,
    Buffer.from(
      [...new Set([...Object.keys(process.env), 'PATH', 'HOME', 'DISCORD_TOKEN'])]
        .map((name) => `${name}=fixture\0`)
        .join(''),
    ),
  );
  const helperSource = SOURCE.replace(
    'SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    `SAFE_SYSTEM_PATH=${safePath}`,
  )
    .replaceAll('/proc/$$/environ', inheritedEnvironment)
    .replace(
      /# KASSINAO_HOST_NO_DUMP_BEGIN[\s\S]*?# KASSINAO_HOST_NO_DUMP_END/,
      '# KASSINAO_HOST_NO_DUMP_BEGIN\nunset LD_PRELOAD\n# KASSINAO_HOST_NO_DUMP_END',
    )
    .replaceAll('/etc/systemd/system/$unit', `${path.dirname(installedService)}/$unit`)
    .replaceAll('/usr/local/sbin/kassinao-health-watch', installedBin)
    .replaceAll('/etc/systemd/system/kassinao-health-watch.service', installedService)
    .replaceAll('/etc/systemd/system/kassinao-health-watch.timer', installedTimer);
  executable(helper, helperSource);
  const validator = path.join(scripts, 'validate-legacy-dedicated-installation.sh');
  executable(
    validator,
    `#!/usr/bin/env bash
printf 'validator:%s\n' "$*" >> ${shellLiteral(calls)}
exit ${options.validatorFails ? 1 : 0}
`,
  );

  executable(path.join(bin, 'id'), '#!/usr/bin/env bash\n[ "${1:-}" = -u ] && printf "0\\n"\n');
  executable(
    path.join(bin, 'readlink'),
    `#!/usr/bin/env bash
last=''; for value in "$@"; do last="$value"; done
python3 - "$last" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
`,
  );
  const executablePaths = [files[0][0], files[0][1]].map(shellLiteral).join('|');
  const regularPaths = files
    .slice(1)
    .flatMap(([source, destination]) => [source, destination])
    .map(shellLiteral)
    .join('|');
  executable(
    path.join(bin, 'stat'),
    `#!/usr/bin/env bash
set -eu
format=''; previous=''; last=''
for value in "$@"; do
  if [ "$previous" = -c ]; then format="$value"; fi
  previous="$value"; last="$value"
done
if [ "$format" = '%a:%u:%g' ] && [ "$last" = ${shellLiteral(bundle)} ]; then printf '700:0:0\n'; exit 0; fi
case "$last" in
  ${executablePaths}) printf '755:0:0:1\n' ;;
  ${regularPaths}) printf '644:0:0:1\n' ;;
  *) printf '700:0:0:1\n' ;;
esac
`,
  );
  executable(
    path.join(bin, 'systemctl'),
    `#!/usr/bin/env bash
set -eu
printf 'systemctl:%s\n' "$*" >> ${shellLiteral(calls)}
case "\${1:-}" in
  show)
    unit="\${2:-}"; property="\${4:-}"
    case "$unit" in
      kassinao-health-watch.service) fragment=${shellLiteral(installedService)} ;;
      kassinao-health-watch.timer) fragment=${shellLiteral(installedTimer)} ;;
      *) exit 92 ;;
    esac
    case "$property" in
      FragmentPath) [ ! -e "$fragment" ] || printf '%s\n' "$fragment" ;;
      DropInPaths) [ ${options.dropIn ? 1 : 0} -eq 0 ] || printf '/tmp/foreign.conf\n' ;;
      *) exit 93 ;;
    esac
    ;;
  disable)
    if [ ${options.tamperAfterStop ? 1 : 0} -eq 1 ]; then printf 'tampered\n' > ${shellLiteral(installedTimer)}; fi
    ;;
  stop|daemon-reload|reset-failed) ;;
  is-active|is-enabled) exit 1 ;;
  *) exit 94 ;;
esac
`,
  );
  executable(
    path.join(bin, 'sha256sum'),
    `#!/usr/bin/env bash
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
    'scripts/remove-legacy-health-watch.sh',
    'scripts/validate-legacy-dedicated-installation.sh',
  ].map(
    (relative) =>
      `${createHash('sha256')
        .update(readFileSync(path.join(bundle, relative)))
        .digest('hex')}  ${relative}`,
  );
  writeFileSync(path.join(bundle, 'MANIFEST.sha256'), `${manifestEntries.join('\n')}\n`, { mode: 0o644 });

  const run = () =>
    spawnSync('bash', [helper, current, '--confirm-remove-exact-legacy-health-watch'], {
      cwd: bundle,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, DISCORD_TOKEN: 'must-not-leak' },
    });
  return { calls, files, installedService, installedTimer, run, unrelated };
}

describe('remoção comprovada do health-watch legado', () => {
  it('remove somente os três artefatos byte-matched sem tocar Docker ou arquivo alheio', () => {
    const value = fixture();
    const result = value.run();
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    for (const [, destination] of value.files) expect(existsSync(destination)).toBe(false);
    expect(readFileSync(value.unrelated, 'utf8')).toBe('keep me\n');
    const calls = readFileSync(value.calls, 'utf8');
    expect(calls).toContain('systemctl:disable --now kassinao-health-watch.timer');
    expect(calls).toContain('systemctl:stop kassinao-health-watch.service');
    expect(calls).toContain('systemctl:daemon-reload');
    expect(calls).not.toContain('docker.service');
    expect(calls).not.toMatch(/docker:(?:start|stop|restart|rm|compose)/);
  });

  it('recusa byte divergente antes de parar ou remover qualquer unit', () => {
    const value = fixture();
    writeFileSync(value.installedService, 'foreign contents\n', { mode: 0o644 });
    const result = value.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('não corresponde byte a byte');
    expect(readFileSync(value.calls, 'utf8')).not.toContain('systemctl:disable');
    for (const [, destination] of value.files) expect(existsSync(destination)).toBe(true);
  });

  it('recusa drop-in alheio antes da primeira mutação', () => {
    const value = fixture({ dropIn: true });
    const result = value.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('possui drop-in');
    expect(readFileSync(value.calls, 'utf8')).not.toContain('systemctl:disable');
  });

  it('revalida bytes depois do stop e recusa remoção se um destino mudar', () => {
    const value = fixture({ tamperAfterStop: true });
    const result = value.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('mudou durante disable/stop');
    for (const [, destination] of value.files) expect(existsSync(destination)).toBe(true);
  });

  it('não toca systemd quando a classificação legada falha', () => {
    const value = fixture({ validatorFails: true });
    const result = value.run();
    expect(result.status).not.toBe(0);
    const calls = readFileSync(value.calls, 'utf8');
    expect(calls).toContain('validator:');
    expect(calls).not.toContain('systemctl:');
  });
});
