import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.join(process.cwd(), 'scripts', 'egress-fail-closed.sh');
const tempDirs: string[] = [];
const CORE_ID = 'a'.repeat(64);
const TUNNEL_ID = 'c'.repeat(64);

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runFailClosed(
  options: { stopFails?: boolean; killFails?: boolean; remainsRunning?: boolean; foreignCore?: boolean } = {},
) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'kassinao-egress-fail-closed-'));
  tempDirs.push(directory);
  const scripts = path.join(directory, 'scripts');
  const dockerClient = path.join(directory, 'deploy', 'docker-client');
  const runtime = path.join(directory, 'run', 'lock', 'kassinao');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(dockerClient, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  writeFileSync(path.join(dockerClient, 'config.json'), '{}\n', { mode: 0o444 });
  const lock = path.join(runtime, 'maintenance.lock');
  writeFileSync(lock, 'maintenance-sentinel\n', { mode: 0o600 });
  const source = readFileSync(SCRIPT, 'utf8')
    .replace(
      /# KASSINAO_HOST_ENV_SCRUB_BEGIN[\s\S]*?# KASSINAO_HOST_ENV_SCRUB_END/,
      '# KASSINAO_HOST_ENV_SCRUB_BEGIN\n_saved_no_dump_marker=""\n_saved_no_dump_preload=""\n_forbidden_override=""\n# KASSINAO_HOST_ENV_SCRUB_END',
    )
    .replace(
      /# KASSINAO_HOST_NO_DUMP_BEGIN[\s\S]*?# KASSINAO_HOST_NO_DUMP_END/,
      '# KASSINAO_HOST_NO_DUMP_BEGIN\nunset LD_PRELOAD\n# KASSINAO_HOST_NO_DUMP_END',
    )
    .replace('RUNTIME_DIR=/run/lock/kassinao', `RUNTIME_DIR=${runtime}`)
    .replaceAll('700:0:0', `700:${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`)
    .replaceAll('600:0:0:1', `600:${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}:1`)
    .replace(
      /# KASSINAO_LOCK_FD_PROOF_BEGIN[\s\S]*?# KASSINAO_LOCK_FD_PROOF_END/,
      '# KASSINAO_LOCK_FD_PROOF_BEGIN\n:\n# KASSINAO_LOCK_FD_PROOF_END',
    );
  const script = path.join(scripts, 'egress-fail-closed.sh');
  writeFileSync(script, source, { mode: 0o700 });
  const log = path.join(directory, 'docker.log');
  writeFileSync(path.join(directory, 'id'), "#!/usr/bin/env bash\nprintf '0\\n'\n", { mode: 0o700 });
  writeFileSync(
    path.join(directory, 'docker'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"
case "\${1:-}" in
  inspect)
    if [ "\${2:-}" = --format ]; then
      template="\${3:-}"
      reference="\${4:-}"
      case "$reference" in
        kassinao|${CORE_ID}) cid=${CORE_ID}; name=kassinao; service=kassinao ;;
        kassinao-tunnel|${TUNNEL_ID}) cid=${TUNNEL_ID}; name=kassinao-tunnel; service=cloudflared ;;
        *) exit 1 ;;
      esac
      if [ "$template" = '{{.Id}}' ]; then
        printf '%s\\n' "$cid"
      else
        project=kassinao
        [ "$name" != kassinao ] || [ "$FAKE_FOREIGN_CORE" != true ] || project=company
        printf '%s|/%s|%s|%s\\n' "$cid" "$name" "$project" "$service"
      fi
    elif [ "\${2:-}" = -f ]; then
      [ "$FAKE_REMAINS_RUNNING" = true ] && printf 'true\\n' || printf 'false\\n'
    else
      exit 1
    fi
    exit 0
    ;;
  stop) [ "$FAKE_STOP_FAILS" != true ] ;;
  kill) [ "$FAKE_KILL_FAILS" != true ] ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o700 },
  );
  writeFileSync(path.join(directory, 'flock'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o700 });
  writeFileSync(
    path.join(directory, 'readlink'),
    `#!/usr/bin/env bash
if [ "\${1:-}" = -f ]; then
  shift
  [ "\${1:-}" != -- ] || shift
  case "\${1:-}" in /proc/*/fd/9) printf '%s\n' '${lock}' ;; *) printf '%s\n' "\${1:-}" ;; esac
else
  /usr/bin/readlink "$@"
fi
`,
    { mode: 0o700 },
  );
  writeFileSync(
    path.join(directory, 'stat'),
    `#!/usr/bin/env bash
target="\${!#}"
case "$target" in
  '${runtime}') printf '700:${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}\n' ;;
  '${lock}') printf '600:${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}:1\n' ;;
  *) /usr/bin/stat "$@" ;;
esac
`,
    { mode: 0o700 },
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH ?? ''}`,
    DOCKER_LOG: log,
    FAKE_STOP_FAILS: String(options.stopFails ?? false),
    FAKE_KILL_FAILS: String(options.killFails ?? false),
    FAKE_REMAINS_RUNNING: String(options.remainsRunning ?? false),
    FAKE_FOREIGN_CORE: String(options.foreignCore ?? false),
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
  return { result, calls: readFileSync(log, 'utf8') };
}

describe('contenção fail-closed do egress', () => {
  it('para e prova core e túnel sem ignorar o resultado', () => {
    const { result, calls } = runFailClosed();

    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContain(`stop --timeout 30 ${CORE_ID}`);
    expect(calls).toContain(`stop --timeout 30 ${TUNNEL_ID}`);
    expect(calls).not.toContain('kill');
    expect(calls.match(/inspect -f \{\{\.State\.Running\}\}/g)).toHaveLength(2);
  });

  it('usa kill como fallback e ainda exige State.Running=false', () => {
    const { result, calls } = runFailClosed({ stopFails: true });

    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContain(`kill ${CORE_ID}`);
    expect(calls).toContain(`kill ${TUNNEL_ID}`);
    expect(calls).toContain(`stop --timeout 10 ${CORE_ID}`);
    expect(calls).toContain(`stop --timeout 10 ${TUNNEL_ID}`);
  });

  it('falha quando stop/kill não contêm ou o estado final continua running', () => {
    const failedKill = runFailClosed({ stopFails: true, killFails: true });
    expect(failedKill.result.status).not.toBe(0);

    const stillRunning = runFailClosed({ remainsRunning: true });
    expect(stillRunning.result.status).not.toBe(0);
    expect(stillRunning.result.stderr).toContain('não foi possível provar');
  });

  it('não para nem mata um container alheio que ocupou o nome reservado', () => {
    const { result, calls } = runFailClosed({ foreignCore: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('não pertence ao projeto/serviço esperado');
    expect(calls).not.toContain(`stop --timeout 30 ${CORE_ID}`);
    expect(calls).not.toContain(`kill ${CORE_ID}`);
    expect(calls).toContain(`stop --timeout 30 ${TUNNEL_ID}`);
  });
});
