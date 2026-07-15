import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.join(process.cwd(), 'scripts', 'egress-fail-closed.sh');
const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runFailClosed(options: { stopFails?: boolean; killFails?: boolean; remainsRunning?: boolean } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'kassinao-egress-fail-closed-'));
  tempDirs.push(directory);
  const log = path.join(directory, 'docker.log');
  writeFileSync(path.join(directory, 'id'), "#!/usr/bin/env bash\nprintf '0\\n'\n", { mode: 0o700 });
  writeFileSync(
    path.join(directory, 'docker'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"
case "\${1:-}" in
  ps) printf 'kassinao\\nkassinao-tunnel\\n' ;;
  inspect)
    if [ "\${2:-}" = -f ]; then
      [ "$FAKE_REMAINS_RUNNING" = true ] && printf 'true\\n' || printf 'false\\n'
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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH ?? ''}`,
    DOCKER_LOG: log,
    FAKE_STOP_FAILS: String(options.stopFails ?? false),
    FAKE_KILL_FAILS: String(options.killFails ?? false),
    FAKE_REMAINS_RUNNING: String(options.remainsRunning ?? false),
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
  const result = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env });
  return { result, calls: readFileSync(log, 'utf8') };
}

describe('contenção fail-closed do egress', () => {
  it('para e prova core e túnel sem ignorar o resultado', () => {
    const { result, calls } = runFailClosed();

    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContain('stop --time 30 kassinao');
    expect(calls).toContain('stop --time 30 kassinao-tunnel');
    expect(calls).not.toContain('kill');
    expect(calls.match(/inspect -f \{\{\.State\.Running\}\}/g)).toHaveLength(2);
  });

  it('usa kill como fallback e ainda exige State.Running=false', () => {
    const { result, calls } = runFailClosed({ stopFails: true });

    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContain('kill kassinao');
    expect(calls).toContain('kill kassinao-tunnel');
    expect(calls).toContain('stop --time 10 kassinao');
    expect(calls).toContain('stop --time 10 kassinao-tunnel');
  });

  it('falha quando stop/kill não contêm ou o estado final continua running', () => {
    const failedKill = runFailClosed({ stopFails: true, killFails: true });
    expect(failedKill.result.status).not.toBe(0);

    const stillRunning = runFailClosed({ remainsRunning: true });
    expect(stillRunning.result.status).not.toBe(0);
    expect(stillRunning.result.stderr).toContain('não foi possível provar');
  });
});
