import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const CHECKER = path.join(ROOT, 'scripts', 'check-shared-migration-rollback.sh');
const CHECKER_SOURCE = readFileSync(CHECKER, 'utf8');
const temporaryDirectories: string[] = [];

function executable(file: string, body: string): void {
  writeFileSync(file, body, { mode: 0o755 });
  chmodSync(file, 0o755);
}

function fixture() {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'kassinao-rollback-check-')));
  temporaryDirectories.push(directory);
  const bin = path.join(directory, 'bin');
  const scripts = path.join(directory, 'scripts');
  const dataRoot = path.join(directory, 'data');
  const rollback = `${dataRoot}.plaintext-before-shared-luks`;
  const envFile = path.join(directory, '.env');
  const manifest = path.join(dataRoot, '.kassinao-migration-manifest.jsonl');
  const pending = path.join(dataRoot, '.kassinao-plaintext-rollback.pending');
  const purging = path.join(dataRoot, '.kassinao-plaintext-rollback.purging');
  const purged = path.join(dataRoot, '.kassinao-plaintext-rollback.purged');
  const mountInventory = path.join(directory, 'mounts.json');
  const checker = path.join(scripts, 'check-shared-migration-rollback.sh');
  mkdirSync(bin);
  mkdirSync(scripts);
  mkdirSync(dataRoot, { mode: 0o700 });
  chmodSync(dataRoot, 0o700);
  writeFileSync(envFile, `KASSINAO_DATA_ROOT=${dataRoot}\n`, { mode: 0o600 });
  chmodSync(envFile, 0o600);
  writeFileSync(manifest, '{"path":"recordings"}\n', { mode: 0o400 });
  chmodSync(manifest, 0o400);
  const manifestHash = createHash('sha256').update(readFileSync(manifest)).digest('hex');

  writeFileSync(
    checker,
    CHECKER_SOURCE.replace(
      'SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      `SAFE_SYSTEM_PATH=${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    )
      .replace(
        /# KASSINAO_HOST_ENV_SCRUB_BEGIN[\s\S]*?# KASSINAO_HOST_ENV_SCRUB_END/,
        '# KASSINAO_HOST_ENV_SCRUB_BEGIN\nexport PATH="$SAFE_SYSTEM_PATH" HOME=/root LC_ALL=C\nif [ "$env_file_override_set" = true ]; then export KASSINAO_ENV_FILE="$env_file_override"; fi\n# KASSINAO_HOST_ENV_SCRUB_END',
      )
      .replace(
        /# KASSINAO_HOST_NO_DUMP_BEGIN[\s\S]*?# KASSINAO_HOST_NO_DUMP_END/,
        '# KASSINAO_HOST_NO_DUMP_BEGIN\n:\n# KASSINAO_HOST_NO_DUMP_END',
      ),
    { mode: 0o755 },
  );
  chmodSync(checker, 0o755);

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
format=''
last=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -c) format="$2"; shift 2 ;;
    --) shift ;;
    *) last="$1"; shift ;;
  esac
done
python3 - "$format" "$last" <<'PY'
import os, stat, sys
format_string, target = sys.argv[1:]
metadata = os.stat(target, follow_symlinks=False)
mode = format(stat.S_IMODE(metadata.st_mode), 'o')
values = {'%a': mode, '%u': '0', '%g': '0', '%h': str(metadata.st_nlink)}
result = format_string
for key, value in values.items():
    result = result.replace(key, value)
print(result)
PY
`,
  );
  executable(path.join(bin, 'findmnt'), `#!/usr/bin/env bash\ncat -- '${mountInventory}'\n`);

  function marker(
    status: 'pending' | 'purging' | 'purged',
    overrides: Partial<
      Record<
        'migrationId' | 'manifestHash' | 'rollbackPath' | 'createdAt' | 'deadline' | 'purgeStartedAt' | 'purgedAt',
        string
      >
    > = {},
  ): string {
    const now = Math.floor(Date.now() / 1000);
    const createdAt = overrides.createdAt ?? String(now);
    const lines = [
      'kassinao-shared-plaintext-rollback-v1',
      `status=${status}`,
      `migration_id=${overrides.migrationId ?? 'a'.repeat(32)}`,
      `manifest_sha256=${overrides.manifestHash ?? manifestHash}`,
      `rollback_path=${overrides.rollbackPath ?? rollback}`,
      `created_at=${createdAt}`,
      `deadline=${overrides.deadline ?? String(Number(createdAt) + 3600)}`,
    ];
    if (status === 'purging') lines.push(`purge_started_at=${overrides.purgeStartedAt ?? String(now)}`);
    if (status === 'purged') lines.push(`purged_at=${overrides.purgedAt ?? String(now)}`);
    return `${lines.join('\n')}\n`;
  }

  function createRollback(): void {
    mkdirSync(rollback, { mode: 0o700 });
    chmodSync(rollback, 0o700);
  }

  function writeMarker(file: string, contents: string): void {
    writeFileSync(file, contents, { mode: 0o400 });
    chmodSync(file, 0o400);
  }

  function run(mounts: unknown = { filesystems: [] }, initialPath?: string, explicitEnv = true) {
    writeFileSync(mountInventory, `${JSON.stringify(mounts)}\n`, { mode: 0o600 });
    const environment = {
      ...process.env,
      PATH: initialPath ?? `${bin}:${process.env.PATH ?? ''}`,
    } as NodeJS.ProcessEnv;
    delete environment.KASSINAO_ENV_FILE;
    if (explicitEnv) environment.KASSINAO_ENV_FILE = envFile;
    return spawnSync('bash', [checker], {
      encoding: 'utf8',
      env: environment,
    });
  }

  return {
    createRollback,
    dataRoot,
    directory,
    envFile,
    manifest,
    marker,
    pending,
    purging,
    purged,
    rollback,
    run,
    writeMarker,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('checker read-only do rollback plaintext shared', () => {
  it('aceita instalação fresh sem marker, receipt ou sibling plaintext', () => {
    const aFixture = fixture();
    rmSync(aFixture.manifest);
    const result = aFixture.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('fresh');
  });

  it('deriva o .env da release quando o caller não fornece override', () => {
    const aFixture = fixture();
    rmSync(aFixture.manifest);
    const result = aFixture.run({ filesystems: [] }, undefined, false);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('fresh');
    expect(CHECKER_SOURCE).toContain('env_file_override=/etc/kassinao/shared.env');
  });

  it('descarta PATH e HOME herdados antes de procurar ou executar binários', () => {
    const aFixture = fixture();
    rmSync(aFixture.manifest);
    const hostile = path.join(aFixture.directory, 'hostile');
    const evidence = path.join(aFixture.directory, 'hostile-called');
    mkdirSync(hostile);
    for (const command of ['awk', 'findmnt', 'id', 'python3', 'readlink', 'stat']) {
      executable(path.join(hostile, command), `#!/usr/bin/env bash\nprintf called >> '${evidence}'\nexit 99\n`);
    }
    const result = aFixture.run({ filesystems: [] }, `${hostile}:${process.env.PATH ?? ''}`);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(evidence)).toBe(false);
    expect(CHECKER_SOURCE).toContain('SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
    expect(CHECKER_SOURCE.indexOf('export PATH="$SAFE_SYSTEM_PATH" HOME=/root LC_ALL=C')).toBeLessThan(
      CHECKER_SOURCE.indexOf('command -v "$command"'),
    );
  });

  it('recusa manifesto órfão sem marker para não reclassificar migração como fresh', () => {
    const aFixture = fixture();
    const result = aFixture.run();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(aFixture.dataRoot);
  });

  it('aceita pending íntegro somente dentro do deadline', () => {
    const aFixture = fixture();
    aFixture.createRollback();
    aFixture.writeMarker(aFixture.pending, aFixture.marker('pending'));
    const result = aFixture.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('pending');
  });

  it('aceita receipt purged íntegro somente sem pending e sem rollback', () => {
    const aFixture = fixture();
    aFixture.writeMarker(aFixture.purged, aFixture.marker('purged'));
    const result = aFixture.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('purged');
  });

  it.each([
    ['purging antes ou durante o rm', true, false],
    ['purging depois do rm', false, false],
    ['purged publicado antes da limpeza dos markers', false, true],
  ])('reconhece finalização interrompida e orienta retomada: %s', (_label, rollbackPresent, receiptPresent) => {
    const aFixture = fixture();
    const createdAt = String(Math.floor(Date.now() / 1000) - 60);
    const common = { createdAt, deadline: String(Number(createdAt) + 3600) };
    if (rollbackPresent) aFixture.createRollback();
    aFixture.writeMarker(aFixture.pending, aFixture.marker('pending', common));
    aFixture.writeMarker(aFixture.purging, aFixture.marker('purging', common));
    if (receiptPresent) aFixture.writeMarker(aFixture.purged, aFixture.marker('purged', common));

    const result = aFixture.run();
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('execute novamente o finalizador');
    expect(output).not.toContain(aFixture.dataRoot);
    expect(output).not.toContain('a'.repeat(32));
  });

  it('reconhece limpeza interrompida depois de retirar purging', () => {
    const aFixture = fixture();
    const createdAt = String(Math.floor(Date.now() / 1000) - 60);
    const common = { createdAt, deadline: String(Number(createdAt) + 3600) };
    aFixture.writeMarker(aFixture.pending, aFixture.marker('pending', common));
    aFixture.writeMarker(aFixture.purged, aFixture.marker('purged', common));

    const result = aFixture.run();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('execute novamente o finalizador');
  });

  it('não classifica marker purging adulterado como transição retomável', () => {
    const aFixture = fixture();
    aFixture.createRollback();
    aFixture.writeMarker(aFixture.pending, aFixture.marker('pending'));
    aFixture.writeMarker(aFixture.purging, `${aFixture.marker('purging')}extra=true\n`);

    const result = aFixture.run();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain('execute novamente o finalizador');
  });

  it('recusa pending expirado sem revelar path, migration ID ou hash', () => {
    const aFixture = fixture();
    const now = Math.floor(Date.now() / 1000);
    aFixture.createRollback();
    const contents = aFixture.marker('pending', {
      createdAt: String(now - 7201),
      deadline: String(now - 3601),
    });
    aFixture.writeMarker(aFixture.pending, contents);
    const result = aFixture.run();
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('estado do rollback plaintext inválido ou expirado');
    expect(output).not.toContain(aFixture.dataRoot);
    expect(output).not.toContain('a'.repeat(32));
    expect(output).not.toContain(createHash('sha256').update(readFileSync(aFixture.manifest)).digest('hex'));
  });

  it.each([
    ['rollback sem marker', (value: ReturnType<typeof fixture>) => value.createRollback()],
    [
      'pending sem rollback',
      (value: ReturnType<typeof fixture>) => value.writeMarker(value.pending, value.marker('pending')),
    ],
    [
      'pending e purged simultâneos',
      (value: ReturnType<typeof fixture>) => {
        value.createRollback();
        value.writeMarker(value.pending, value.marker('pending'));
        value.writeMarker(value.purged, value.marker('purged'));
      },
    ],
    [
      'purged ainda com rollback',
      (value: ReturnType<typeof fixture>) => {
        value.createRollback();
        value.writeMarker(value.purged, value.marker('purged'));
      },
    ],
  ])('recusa estado parcial: %s', (_name, arrange) => {
    const aFixture = fixture();
    arrange(aFixture);
    expect(aFixture.run().status).not.toBe(0);
  });

  it.each([
    [
      'status divergente',
      (value: ReturnType<typeof fixture>) => value.marker('pending').replace('status=pending', 'status=purged'),
    ],
    ['linha extra', (value: ReturnType<typeof fixture>) => `${value.marker('pending')}extra=true\n`],
    [
      'migration ID inválido',
      (value: ReturnType<typeof fixture>) => value.marker('pending', { migrationId: 'private-id' }),
    ],
    [
      'hash divergente',
      (value: ReturnType<typeof fixture>) => value.marker('pending', { manifestHash: 'b'.repeat(64) }),
    ],
    [
      'rollback path divergente',
      (value: ReturnType<typeof fixture>) => value.marker('pending', { rollbackPath: '/tmp/foreign' }),
    ],
    [
      'janela acima de 168 horas',
      (value: ReturnType<typeof fixture>) => {
        const now = Math.floor(Date.now() / 1000);
        return value.marker('pending', { createdAt: String(now), deadline: String(now + 169 * 3600) });
      },
    ],
  ])('recusa marker fora do formato exato: %s', (_name, contents) => {
    const aFixture = fixture();
    aFixture.createRollback();
    aFixture.writeMarker(aFixture.pending, contents(aFixture));
    expect(aFixture.run().status).not.toBe(0);
  });

  it('recusa marker com hardlink ou symlink', () => {
    const hardlinked = fixture();
    hardlinked.createRollback();
    hardlinked.writeMarker(hardlinked.pending, hardlinked.marker('pending'));
    linkSync(hardlinked.pending, path.join(hardlinked.dataRoot, 'marker-copy'));
    expect(hardlinked.run().status).not.toBe(0);

    const symlinked = fixture();
    symlinked.createRollback();
    const outside = path.join(symlinked.directory, 'outside-marker');
    symlinked.writeMarker(outside, symlinked.marker('pending'));
    symlinkSync(outside, symlinked.pending);
    expect(symlinked.run().status).not.toBe(0);
  });

  it('recusa rollback que é mountpoint ou contém nested mount', () => {
    const aFixture = fixture();
    aFixture.createRollback();
    aFixture.writeMarker(aFixture.pending, aFixture.marker('pending'));
    const result = aFixture.run({ filesystems: [{ target: path.join(aFixture.rollback, 'nested') }] });
    expect(result.status).not.toBe(0);
  });
});
