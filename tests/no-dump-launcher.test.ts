import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const HOST_HELPER = path.join(ROOT, 'scripts', 'no-dump-exec.py');
const ccAvailable = spawnSync('cc', ['--version'], { stdio: 'ignore' }).status === 0;

describe('isolamento process-scoped de core dumps', () => {
  it('aceita toda representação hexadecimal-zero do Linux e rejeita qualquer outro valor nos gates shell', () => {
    for (const value of ['0', '00', '00000000']) {
      const accepted = spawnSync('bash', ['-c', '[[ "$1" =~ ^0+$ ]]', 'gate', value]);
      expect(accepted.status, value).toBe(0);
    }
    for (const value of ['', '1', '00000001', 'a', '0x0']) {
      const rejected = spawnSync('bash', ['-c', '[[ "$1" =~ ^0+$ ]]', 'gate', value]);
      expect(rejected.status, value).not.toBe(0);
    }

    const guardedScripts = readdirSync(path.join(ROOT, 'scripts'))
      .filter((name) => name.endsWith('.sh'))
      .map((name) => [name, readFileSync(path.join(ROOT, 'scripts', name), 'utf8')] as const)
      .filter(([, source]) => source.includes('_no_dump_filter'));
    expect(guardedScripts.length).toBeGreaterThan(20);
    for (const [name, source] of guardedScripts) {
      expect(source, name).toContain('[[ "$_no_dump_filter" =~ ^0+$ ]]');
      expect(source, name).not.toContain('[ "$_no_dump_filter" = 0 ]');
    }
  });

  it('compila um launcher estático em cada plataforma e o põe antes do tini/Node', () => {
    const dockerfile = readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    const dockerignore = readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');

    expect(dockerfile).toContain('musl-gcc -std=c11 -Os -Wall -Wextra -Werror -static -s');
    expect(dockerfile).toContain('COPY --from=build /usr/local/bin/kassinao-no-dump');
    expect(dockerfile).toContain(
      'ENTRYPOINT ["/usr/local/bin/kassinao-no-dump", "--preload", "/usr/local/lib/libkassinao-no-dump.so", "--", "/usr/bin/tini", "--"]',
    );
    expect(dockerfile).toContain("process.env.KASSINAO_NO_DUMP_ACTIVE!==('prctl-v1:'+process.pid)");
    expect(dockerignore).toContain('!native/no-dump-exec.c');
    expect(dockerignore).toContain('!native/no-dump-preload.c');
  });

  it('protege também os healthchecks do core, router e site público', () => {
    const compose = readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
    const guardedHealthchecks = compose.match(
      /'CMD',\s*'\/usr\/local\/bin\/kassinao-no-dump',\s*'--preload',\s*'\/usr\/local\/lib\/libkassinao-no-dump\.so',\s*'--',\s*'\/usr\/local\/bin\/node'/g,
    );

    expect(guardedHealthchecks).toHaveLength(3);
    expect(compose.match(/ulimits:\s*\n\s*core:\s*\n\s*soft: 0\s*\n\s*hard: 0/g)).toHaveLength(4);
  });

  it('leva o helper host genérico no kit operacional selado', () => {
    const packager = readFileSync(path.join(ROOT, 'scripts', 'package-ops-bundle.sh'), 'utf8');
    const helper = readFileSync(HOST_HELPER, 'utf8');

    expect(packager).toContain('"$ROOT/scripts/no-dump-exec.py"');
    expect(packager).toContain('"$DEST/runtime/linux-amd64"');
    expect(packager).toContain('"$DEST/runtime/linux-arm64"');
    expect(helper).toContain('parser.add_argument("--bundle-root")');
    expect(helper).toContain('parser.add_argument("--script-relative")');
    expect(helper).toContain('for relative, expected_digest in manifest.items():');
    expect(helper).toContain('platform.machine().lower()');
    expect(helper).toContain('if name.startswith("LD_")');
  });

  it('remove variáveis do loader antes do exec e só repõe o preload selado', () => {
    const launcher = readFileSync(path.join(ROOT, 'native', 'no-dump-exec.c'), 'utf8');
    const preload = readFileSync(path.join(ROOT, 'native', 'no-dump-preload.c'), 'utf8');

    for (const name of ['LD_PRELOAD', 'LD_AUDIT', 'LD_LIBRARY_PATH', 'LD_DEBUG', 'LD_PROFILE']) {
      expect(launcher).toContain(`"${name}"`);
    }
    for (const source of [launcher, preload]) {
      expect(source).toContain('#include <sys/prctl.h>');
      expect(source).not.toContain('#include <linux/prctl.h>');
    }
    expect(preload).toContain('prctl(PR_SET_DUMPABLE');
    expect(preload).toContain('saw_zero');
  });

  it.runIf(process.platform === 'linux')('preserva coredump_filter=0 e RLIMIT_CORE=0 por execve', () => {
    const result = spawnSync(
      '/usr/bin/python3',
      [HOST_HELPER, '--', '/usr/bin/python3', HOST_HELPER, '--check-preserved'],
      {
        encoding: 'utf8',
        env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'LD_PRELOAD')),
      },
    );

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
  });

  it.runIf(process.platform === 'linux')('não presume que PR_SET_DUMPABLE sobreviva a execve', () => {
    const result = spawnSync(
      '/usr/bin/python3',
      [HOST_HELPER, '--', '/usr/bin/python3', HOST_HELPER, '--check-current'],
      {
        encoding: 'utf8',
        env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'LD_PRELOAD')),
      },
    );

    expect(result.status).toBe(1);
  });

  it.runIf(process.platform === 'linux' && ccAvailable)(
    'reaplica PR_SET_DUMPABLE no processo final e vincula a prova ao PID',
    () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'kassinao-no-dump-'));
      try {
        const preload = path.join(directory, 'libkassinao-no-dump.so');
        const compile = spawnSync(
          'cc',
          [
            '-std=c11',
            '-Os',
            '-Wall',
            '-Wextra',
            '-Werror',
            '-fPIC',
            '-shared',
            '-o',
            preload,
            path.join(ROOT, 'native', 'no-dump-preload.c'),
          ],
          { encoding: 'utf8' },
        );
        expect(compile.status, `${compile.stderr}\n${compile.stdout}`).toBe(0);
        chmodSync(preload, 0o444);
        const shell = `test "$KASSINAO_NO_DUMP_ACTIVE" = "prctl-v1:$$" && /usr/bin/python3 ${JSON.stringify(HOST_HELPER)} --check-current`;
        const result = spawnSync(
          '/usr/bin/python3',
          [HOST_HELPER, '--preload', preload, '--', '/bin/sh', '-c', shell],
          { encoding: 'utf8' },
        );
        expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === 'linux')('falha fechado quando o programa alvo não existe', () => {
    const result = spawnSync('/usr/bin/python3', [HOST_HELPER, '--', '/definitely/missing/kassinao'], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(127);
    expect(result.stderr).toContain('exec failed');
  });
});
