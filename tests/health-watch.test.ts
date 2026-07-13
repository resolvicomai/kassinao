import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function runWatch(status: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kassinao-health-watch-'));
  tempDirs.push(dir);
  const log = path.join(dir, 'docker.log');
  const docker = path.join(dir, 'docker');
  const flock = path.join(dir, 'flock');
  fs.writeFileSync(
    docker,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$DOCKER_LOG"\nif [ "$1" = inspect ]; then printf '%s\\n' "$FAKE_STATUS"; fi\n`,
    { mode: 0o700 },
  );
  fs.writeFileSync(flock, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o700 });

  const result = spawnSync('bash', [path.join(process.cwd(), 'scripts', 'health-watch.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      DOCKER_BIN: docker,
      DOCKER_LOG: log,
      FAKE_STATUS: status,
      HEALTH_WATCH_LOCK_FILE: path.join(dir, 'watch.lock'),
    },
  });
  return { result, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}

describe('watchdog de saúde no host', () => {
  it('reinicia somente o contêiner configurado quando fica unhealthy', () => {
    const { result, calls } = runWatch('unhealthy');
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContain('inspect --format');
    expect(calls).toContain('restart --time 20 kassinao');
  });

  it('não reinicia um contêiner saudável', () => {
    const { result, calls } = runWatch('healthy');
    expect(result.status, result.stderr).toBe(0);
    expect(calls).not.toContain('restart');
  });
});
