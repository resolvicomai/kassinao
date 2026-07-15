import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const temporaryDirectories: string[] = [];

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

interface FixtureOptions {
  luksValid?: boolean;
  actualUuid?: string;
  mountOptions?: string;
  loopBacking?: string;
  mountSource?: string;
  mountActive?: boolean;
  backingMode?: string;
  backingParentMode?: string;
  backingInode?: string;
  loopBackingInode?: string;
  backingDevice?: string;
  loopBackingDevice?: string;
  cryptType?: string;
  neighborAuditFails?: boolean;
  plaintextSwap?: boolean;
  sparseBacking?: boolean;
}

interface SharedStorageFixture {
  directory: string;
  prepare: string;
  verifier: string;
  auditor: string;
  envFile: string;
  dataRoot: string;
  backingFile: string;
  children: string[];
  configDir: string;
  appEnv: string;
  tunnelToken: string;
  sentinel: string;
  bin: string;
  mutationLog: string;
  commandLog: string;
  runtimeDir: string;
  maintenanceLock: string;
  differentMountFlag: string;
  hardlinkFlag: string;
  uuid: string;
  mapper: string;
  uid: number;
  gid: number;
}

function fixture(options: FixtureOptions = {}): SharedStorageFixture {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'kassinao-shared-storage-')));
  temporaryDirectories.push(directory);
  chmodSync(directory, 0o700);
  const scripts = path.join(directory, 'scripts');
  const bin = path.join(directory, 'bin');
  const mutationLog = path.join(directory, 'mutations.log');
  const commandLog = path.join(directory, 'commands.log');
  const runtimeDir = path.join(directory, 'runtime');
  const maintenanceLock = path.join(runtimeDir, 'maintenance.lock');
  const inheritedEnvironment = path.join(directory, 'inherited-environment.bin');
  mkdirSync(scripts, { mode: 0o700 });
  mkdirSync(bin, { mode: 0o700 });
  writeFileSync(
    inheritedEnvironment,
    Buffer.from(
      [...new Set([...Object.keys(process.env), 'PATH', 'HOME', 'DISCORD_TOKEN'])]
        .map((name) => `${name}=fixture\0`)
        .join(''),
    ),
  );
  const prepare = path.join(scripts, 'prepare-shared-storage.sh');
  const verifier = path.join(scripts, 'verify-shared-luks-storage.sh');
  const auditor = path.join(scripts, 'audit-shared-vps-security.sh');
  const safeSystemPath = `SAFE_SYSTEM_PATH=${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
  writeFileSync(
    prepare,
    readFileSync(path.join(ROOT, 'scripts', 'prepare-shared-storage.sh'), 'utf8')
      .replace('SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', safeSystemPath)
      .replaceAll('/proc/$$/environ', inheritedEnvironment)
      .replace(
        /# KASSINAO_HOST_NO_DUMP_BEGIN[\s\S]*?# KASSINAO_HOST_NO_DUMP_END/,
        '# KASSINAO_HOST_NO_DUMP_BEGIN\nunset LD_PRELOAD\n# KASSINAO_HOST_NO_DUMP_END',
      )
      .replace('RUNTIME_DIR=/run/lock/kassinao', `RUNTIME_DIR=${runtimeDir}`),
    { mode: 0o755 },
  );
  writeFileSync(
    verifier,
    readFileSync(path.join(ROOT, 'scripts', 'verify-shared-luks-storage.sh'), 'utf8')
      .replace('SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', safeSystemPath)
      .replaceAll('/proc/$$/environ', inheritedEnvironment)
      .replace(
        /# KASSINAO_HOST_NO_DUMP_BEGIN[\s\S]*?# KASSINAO_HOST_NO_DUMP_END/,
        '# KASSINAO_HOST_NO_DUMP_BEGIN\nunset LD_PRELOAD\n# KASSINAO_HOST_NO_DUMP_END',
      ),
    { mode: 0o755 },
  );
  writeFileSync(
    auditor,
    `#!/usr/bin/env bash
set -eu
[ "$#" -eq 1 ] && [ "$1" = --neighbors-only ] || exit 90
[ -z "\${DISCORD_TOKEN:-}" ] || exit 91
printf 'auditor:%s\n' "$*" >> ${shellLiteral(commandLog)}
[ ${options.neighborAuditFails ? 'true' : 'false'} = false ] || exit 92
`,
    { mode: 0o755 },
  );
  chmodSync(prepare, 0o755);
  chmodSync(verifier, 0o755);
  chmodSync(auditor, 0o755);
  const appEnvTemplate = path.join(directory, 'app.env.example');
  writeFileSync(appEnvTemplate, readFileSync(path.join(ROOT, 'deploy', 'runtime', 'app.env.example')), {
    mode: 0o600,
  });

  const manifestLines = [
    'scripts/prepare-shared-storage.sh',
    'scripts/verify-shared-luks-storage.sh',
    'scripts/audit-shared-vps-security.sh',
    'app.env.example',
  ].map((name) => {
    const digest = createHash('sha256')
      .update(readFileSync(path.join(directory, name)))
      .digest('hex');
    return `${digest}  ${name}`;
  });
  writeFileSync(path.join(directory, 'MANIFEST.sha256'), `${manifestLines.join('\n')}\n`, { mode: 0o600 });

  const dataRoot = path.join(directory, 'mounted-luks');
  const backingFile = path.join(directory, 'kassinao.luks');
  mkdirSync(dataRoot, { mode: 0o700 });
  chmodSync(dataRoot, 0o700);
  writeFileSync(backingFile, 'fake-luks-container', { mode: 0o600 });
  chmodSync(backingFile, 0o600);
  const children = ['recordings', 'state', 'auth', 'cache'].map((name) => path.join(dataRoot, name));
  const configDir = path.join(dataRoot, 'config');
  const appEnv = path.join(configDir, 'app.env');
  const tunnelToken = path.join(configDir, 'cloudflared-token');
  const sentinel = path.join(dataRoot, '.kassinao-mounted');
  const uuid = '12345678-1234-4abc-8def-1234567890ab';
  const mapper = 'kassinao-shared';
  const uid = 61050;
  const gid = 61050;
  const envFile = path.join(directory, '.env');
  writeFileSync(
    envFile,
    [
      `KASSINAO_DATA_ROOT=${dataRoot}`,
      `KASSINAO_RECORDINGS_DIR=${children[0]}`,
      `KASSINAO_STATE_DIR=${children[1]}`,
      `KASSINAO_AUTH_DIR=${children[2]}`,
      `KASSINAO_MODEL_CACHE_DIR=${children[3]}`,
      `KASSINAO_SHARED_APP_ENV_FILE=${appEnv}`,
      `KASSINAO_SHARED_TUNNEL_TOKEN_FILE=${tunnelToken}`,
      `KASSINAO_UID=${uid}`,
      `KASSINAO_GID=${gid}`,
      `KASSINAO_SHARED_LUKS_BACKING_FILE=${backingFile}`,
      `KASSINAO_SHARED_LUKS_MAPPER=${mapper}`,
      `KASSINAO_SHARED_LUKS_UUID=${uuid}`,
      'DISCORD_TOKEN=this-must-never-be-sourced',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  chmodSync(envFile, 0o600);

  const differentMountFlag = path.join(directory, 'different-mount.flag');
  const hardlinkFlag = path.join(directory, 'hardlink.flag');
  const actualUuid = options.actualUuid ?? uuid;
  const loopBacking = options.loopBacking ?? backingFile;
  const mountSource = options.mountSource ?? `/dev/mapper/${mapper}`;
  const mountOptions = options.mountOptions ?? 'rw,nosuid,nodev,noexec,relatime';
  const backingMode = options.backingMode ?? '600:0:0';
  const backingParentMode = options.backingParentMode ?? '700:0:0';
  const backingInode = options.backingInode ?? '424242';
  const loopBackingInode = options.loopBackingInode ?? backingInode;
  const backingDevice = options.backingDevice ?? '8:1';
  const loopBackingDevice = options.loopBackingDevice ?? backingDevice;
  const cryptType = options.cryptType ?? 'LUKS2';

  const commands: Record<string, string> = {
    id: `#!/usr/bin/env bash
[ "\${1:-}" = -u ] || exit 2
printf '0\n'
`,
    stat: `#!/usr/bin/env bash
set -eu
target="\${!#}"
format="\${2:-}"
if [ "$format" = %h ]; then
  if [ -f ${shellLiteral(hardlinkFlag)} ] && [ "$(cat ${shellLiteral(hardlinkFlag)})" = "$target" ]; then
    printf '2\n'
  else
    printf '1\n'
  fi
  exit 0
fi
if [ "$format" = %s:%b ] && [ "$target" = ${shellLiteral(backingFile)} ]; then
  if [ ${options.sparseBacking ? 'true' : 'false'} = true ]; then printf '4096:0\n'; else printf '19:1\n'; fi
  exit 0
fi
if [ "$format" = %i ] && [ "$target" = ${shellLiteral(backingFile)} ]; then
  printf '%s\n' ${shellLiteral(backingInode)}
  exit 0
fi
case "$target" in
  ${shellLiteral(directory)}) printf '${backingParentMode}\n' ;;
  ${shellLiteral(envFile)}) printf '600:0:0\n' ;;
  ${shellLiteral(dataRoot)}) printf '700:0:0\n' ;;
  ${shellLiteral(backingFile)}) printf '${backingMode}\n' ;;
  ${shellLiteral(sentinel)}) [ -f "$target" ] && printf '400:0:0\n' || exit 1 ;;
  ${shellLiteral(configDir)}) [ -d "$target" ] && printf '700:0:0\n' || exit 1 ;;
  ${shellLiteral(runtimeDir)}) [ -d "$target" ] && printf '700:0:0\n' || exit 1 ;;
  ${shellLiteral(maintenanceLock)}) [ -f "$target" ] && printf '600:0:0\n' || exit 1 ;;
  ${shellLiteral(appEnv)}) [ -f "$target" ] && printf '440:0:${gid}\n' || exit 1 ;;
  ${shellLiteral(tunnelToken)}) [ -f "$target" ] && printf '444:0:0\n' || exit 1 ;;
  ${shellLiteral(dataRoot)}/*) [ -d "$target" ] && printf '700:${uid}:${gid}\n' || exit 1 ;;
  ${shellLiteral(prepare)} | ${shellLiteral(verifier)} | ${shellLiteral(auditor)}) printf '755:0:0\n' ;;
  ${shellLiteral(path.join(directory, 'MANIFEST.sha256'))}) printf '600:0:0\n' ;;
  *) [ -d "$target" ] && printf '700:0:0\n' || printf '600:0:0\n' ;;
esac
`,
    readlink: `#!/usr/bin/env bash
set -eu
target="\${!#}"
case "$target" in
  /dev/mapper/${mapper}) printf '/dev/dm-7\n' ;;
  *) printf '%s\n' "$target" ;;
esac
`,
    findmnt: `#!/usr/bin/env bash
set -eu
printf 'findmnt:%s\n' "$*" >> ${shellLiteral(commandLog)}
if [ "$*" = '--json --output TARGET' ]; then
  printf '{"filesystems":[{"target":"%s"}]}\n' ${shellLiteral(dataRoot)}
  exit 0
fi
field=''
target="\${!#}"
while [ "$#" -gt 0 ]; do
  case "$1" in -o) field="$2"; shift 2 ;; *) shift ;; esac
done
case "$field" in
  TARGET)
    flagged=''
    if [ -f ${shellLiteral(differentMountFlag)} ]; then
      flagged="$(cat ${shellLiteral(differentMountFlag)})"
      [ "$flagged" != 1 ] || flagged=${shellLiteral(children[2]!)}
    fi
    if [ -n "$flagged" ] && [ "$target" = "$flagged" ]; then
      printf '/other-mount\n'
    else
      printf '%s\n' ${shellLiteral(dataRoot)}
    fi
    ;;
  SOURCE) printf '%s\n' ${shellLiteral(mountSource)} ;;
  OPTIONS) printf '%s\n' ${shellLiteral(mountOptions)} ;;
  MAJ:MIN) printf '%s\n' ${shellLiteral(backingDevice)} ;;
  FSTYPE) printf 'ext4\n' ;;
  *) exit 2 ;;
esac
`,
    mountpoint: `#!/usr/bin/env bash
printf 'mountpoint:%s\n' "$*" >> ${shellLiteral(commandLog)}
exit ${options.mountActive === false ? '1' : '0'}
`,
    cryptsetup: `#!/usr/bin/env bash
set -eu
printf 'cryptsetup:%s\n' "$*" >> ${shellLiteral(commandLog)}
case "$1" in
  isLuks) exit ${options.luksValid === false ? '1' : '0'} ;;
  luksUUID) printf '%s\n' ${shellLiteral(actualUuid)} ;;
  status)
    printf '/dev/mapper/${mapper} is active.\n  type: ${cryptType}\n  device: /dev/loop7\n'
    ;;
  *) exit 2 ;;
esac
`,
    losetup: `#!/usr/bin/env bash
printf 'losetup:%s\n' "$*" >> ${shellLiteral(commandLog)}
case "$*" in
  *BACK-INO,BACK-MAJ:MIN*) printf '%s %s\n' ${shellLiteral(loopBackingInode)} ${shellLiteral(loopBackingDevice)} ;;
  *) printf '%s\n' ${shellLiteral(loopBacking)} ;;
esac
`,
    lsblk: `#!/usr/bin/env bash
printf 'lsblk:%s\n' "$*" >> ${shellLiteral(commandLog)}
target="\${!#}"
if [ ${options.plaintextSwap ? 'true' : 'false'} = true ] && [ "$target" = /dev/sda2 ]; then
  printf 'part\ndisk\n'
else
  printf 'crypt\nloop\n'
fi
`,
    chown: `#!/usr/bin/env bash
printf 'chown:%s\n' "$*" >> ${shellLiteral(mutationLog)}
`,
    swapon: `#!/usr/bin/env bash
printf 'swapon:%s\n' "$*" >> ${shellLiteral(commandLog)}
[ ${options.plaintextSwap ? 'true' : 'false'} = false ] || printf '/dev/sda2\n'
`,
  };
  for (const [name, contents] of Object.entries(commands)) {
    const file = path.join(bin, name);
    writeFileSync(file, contents, { mode: 0o755 });
    chmodSync(file, 0o755);
  }

  return {
    directory,
    prepare,
    verifier,
    auditor,
    envFile,
    dataRoot,
    backingFile,
    children,
    configDir,
    appEnv,
    tunnelToken,
    sentinel,
    bin,
    mutationLog,
    commandLog,
    runtimeDir,
    maintenanceLock,
    differentMountFlag,
    hardlinkFlag,
    uuid,
    mapper,
    uid,
    gid,
  };
}

function run(file: string, value: SharedStorageFixture, args: string[] = []) {
  return spawnSync('bash', [file, ...args], {
    cwd: value.directory,
    env: { ...process.env, PATH: `${value.bin}:${process.env.PATH ?? ''}` },
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('storage LUKS escopado para host compartilhado', () => {
  it('prova a raiz antes da sentinel e prepara runtime mais segredos no LUKS', () => {
    const value = fixture();
    const rootOnly = run(value.verifier, value, ['--root-only']);
    expect(rootOnly.status, rootOnly.stderr).toBe(0);
    expect(existsSync(value.sentinel)).toBe(false);
    for (const child of value.children) expect(existsSync(child), child).toBe(false);

    const beforePrepare = run(value.verifier, value);
    expect(beforePrepare.status).not.toBe(0);
    expect(beforePrepare.stderr).toContain('sentinel .kassinao-mounted ausente');

    const prepared = run(value.prepare, value);
    expect(prepared.status, `${prepared.stderr}\n${prepared.stdout}`).toBe(0);
    expect(readFileSync(value.sentinel, 'utf8')).toBe(
      `kassinao-shared-luks-v1\nuuid=${value.uuid}\nmapper=${value.mapper}\n`,
    );
    expect(statSync(value.sentinel).mode & 0o777).toBe(0o400);
    for (const child of value.children) {
      expect(statSync(child).isDirectory(), child).toBe(true);
      expect(statSync(child).mode & 0o777, child).toBe(0o700);
    }
    expect(statSync(value.configDir).mode & 0o777).toBe(0o700);
    expect(statSync(value.appEnv).mode & 0o777).toBe(0o440);
    expect(statSync(value.tunnelToken).mode & 0o777).toBe(0o444);
    expect(statSync(value.runtimeDir).mode & 0o777).toBe(0o700);
    expect(statSync(value.maintenanceLock).mode & 0o777).toBe(0o600);
    const seededAppEnv = readFileSync(value.appEnv, 'utf8');
    expect(seededAppEnv).toBe(readFileSync(path.join(ROOT, 'deploy', 'runtime', 'app.env.example'), 'utf8'));
    expect(seededAppEnv).toContain('TRANSCRIBE_PROVIDER=none');
    expect(seededAppEnv).toContain('MINUTES_ENABLED=false');
    expect(seededAppEnv).toContain('MCP_SECRET=');
    expect(seededAppEnv).toContain('RETENTION_DAYS=7');
    expect(seededAppEnv).not.toContain('TUNNEL_TOKEN=');
    const commands = readFileSync(value.commandLog, 'utf8');
    expect(commands).toContain('swapon:--show --noheadings --raw --output NAME');
    const full = run(value.verifier, value);
    expect(full.status, full.stderr).toBe(0);
    for (const sensitiveIdentity of [value.dataRoot, value.mapper, value.uuid]) {
      expect(`${rootOnly.stdout}${full.stdout}`).not.toContain(sensitiveIdentity);
    }
  });

  it('não cria, chowna nem chmoda antes da prova LUKS root-only', () => {
    const value = fixture({ luksValid: false });
    const result = run(value.prepare, value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('raiz shared LUKS não passou na prova pré-mutation');
    expect(existsSync(value.mutationLog)).toBe(false);
    expect(existsSync(value.sentinel)).toBe(false);
    for (const child of value.children) expect(existsSync(child), child).toBe(false);
  });

  it('recusa vizinho inseguro antes da primeira mutação ou arquivo de segredo', () => {
    const value = fixture({ neighborAuditFails: true });
    const result = run(value.prepare, value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('auditoria read-only dos vizinhos recusou');
    expect(readFileSync(value.commandLog, 'utf8')).toContain('auditor:--neighbors-only');
    expect(existsSync(value.mutationLog)).toBe(false);
    expect(existsSync(value.configDir)).toBe(false);
    expect(existsSync(value.appEnv)).toBe(false);
    expect(existsSync(value.tunnelToken)).toBe(false);
    for (const child of value.children) expect(existsSync(child), child).toBe(false);
  });

  it('pré-valida todos os filhos e a sentinel antes da primeira normalização', () => {
    const value = fixture();
    const outside = path.join(value.directory, 'outside');
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, value.children[2]!);

    const result = run(value.prepare, value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('diretório privado existente é irregular ou symlink');
    expect(existsSync(value.mutationLog)).toBe(false);
    expect(existsSync(value.children[0]!)).toBe(false);
    expect(existsSync(value.children[1]!)).toBe(false);
    expect(existsSync(value.children[3]!)).toBe(false);
    expect(existsSync(value.sentinel)).toBe(false);
  });

  it('não normaliza filho existente que pertence a outro mount', () => {
    const value = fixture();
    mkdirSync(value.children[2]!, { mode: 0o700 });
    writeFileSync(value.differentMountFlag, '1');

    const result = run(value.prepare, value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('diretório privado existente não está no mount LUKS');
    expect(existsSync(value.mutationLog)).toBe(false);
    expect(existsSync(value.children[0]!)).toBe(false);
    expect(existsSync(value.children[1]!)).toBe(false);
    expect(existsSync(value.children[3]!)).toBe(false);
    expect(existsSync(value.sentinel)).toBe(false);
  });

  it.each([
    ['UUID divergente', { actualUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }, 'UUID do backing file diverge'],
    ['backing inseguro', { backingMode: '644:0:0' }, 'backing file LUKS precisa ser 0600 root:root'],
    [
      'parent do backing gravável',
      { backingParentMode: '770:0:0' },
      'parent-chain root-owned e sem escrita de grupo/outros',
    ],
    ['loop divergente', { loopBacking: '/var/lib/outro.luks' }, 'loop device ativo aponta'],
    [
      'inode do loop divergente',
      { loopBackingInode: '999999' },
      'device/inode do backing file aberto pelo loop diverge',
    ],
    [
      'device do loop divergente',
      { loopBackingDevice: '8:2' },
      'device/inode do backing file aberto pelo loop diverge',
    ],
    ['mapper divergente', { mountSource: '/dev/mapper/outro' }, 'não usa o mapper LUKS configurado'],
    ['mount somente leitura', { mountOptions: 'ro,nosuid,nodev,noexec,relatime' }, 'mount LUKS precisa da opção rw'],
    ['mount sem noexec', { mountOptions: 'rw,nosuid,nodev,relatime' }, 'mount LUKS precisa da opção noexec'],
    ['mapper não-LUKS2', { cryptType: 'PLAIN' }, 'mapper ativo não foi provado como LUKS2'],
  ] as const)('falha fechado para %s', (_label, options, error) => {
    const value = fixture(options);
    const result = run(value.verifier, value, ['--root-only']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(error);
    expect(existsSync(value.mutationLog)).toBe(false);
  });

  it('aceita host sem swap ativo e recusa swap plaintext', () => {
    const noSwap = fixture();
    const accepted = run(noSwap.verifier, noSwap, ['--root-only']);
    expect(accepted.status, accepted.stderr).toBe(0);

    const plaintext = fixture({ plaintextSwap: true });
    const rejected = run(plaintext.verifier, plaintext, ['--root-only']);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('todo swap ativo precisa estar sobre dm-crypt');
  });

  it('aceita cadeia dm-crypt extensa sem transformar o SIGPIPE do grep em falha', () => {
    const value = fixture();
    writeFileSync(
      path.join(value.bin, 'lsblk'),
      "#!/usr/bin/env bash\nprintf 'crypt\\n'\nprintf 'loop\\n%.0s' {1..20000}\n",
      { mode: 0o755 },
    );

    const result = run(value.verifier, value, ['--root-only']);
    expect(result.status, result.stderr).toBe(0);
  });

  it('recusa hardlink do backing file LUKS', () => {
    const value = fixture();
    writeFileSync(value.hardlinkFlag, value.backingFile);
    const result = run(value.verifier, value, ['--root-only']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('backing file LUKS não pode possuir hardlinks');
  });

  it('recusa backing file sparse ou aparentemente comprimido', () => {
    const value = fixture({ sparseBacking: true });
    const result = run(value.verifier, value, ['--root-only']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('totalmente alocado');
  });

  it('recusa filho em outro mount e sentinel transformada em symlink', () => {
    const value = fixture();
    expect(run(value.prepare, value).status).toBe(0);

    writeFileSync(value.differentMountFlag, '1');
    const differentMount = run(value.verifier, value);
    expect(differentMount.status).not.toBe(0);
    expect(differentMount.stderr).toContain('não está no mesmo mount LUKS');
    unlinkSync(value.differentMountFlag);

    unlinkSync(value.sentinel);
    symlinkSync(value.backingFile, value.sentinel);
    const symlink = run(value.verifier, value);
    expect(symlink.status).not.toBe(0);
    expect(symlink.stderr).toContain('sentinel .kassinao-mounted ausente ou irregular');
  });

  it('recusa segredo com hardlink ou em mount aninhado', () => {
    const value = fixture();
    expect(run(value.prepare, value).status).toBe(0);

    writeFileSync(value.hardlinkFlag, value.appEnv);
    const hardlink = run(value.verifier, value);
    expect(hardlink.status).not.toBe(0);
    expect(hardlink.stderr).toContain('não pode possuir hardlinks');
    unlinkSync(value.hardlinkFlag);

    writeFileSync(value.differentMountFlag, value.tunnelToken);
    const nestedMount = run(value.verifier, value);
    expect(nestedMount.status).not.toBe(0);
    expect(nestedMount.stderr).toContain('não está no mesmo mount LUKS');
  });

  it('exige exatamente uma quebra de linha final na sentinel', () => {
    const value = fixture();
    expect(run(value.prepare, value).status).toBe(0);

    chmodSync(value.sentinel, 0o600);
    writeFileSync(value.sentinel, `kassinao-shared-luks-v1\nuuid=${value.uuid}\nmapper=${value.mapper}`);
    const missingNewline = run(value.verifier, value);
    expect(missingNewline.status).not.toBe(0);
    expect(missingNewline.stderr).toContain('sentinel .kassinao-mounted diverge');

    writeFileSync(value.sentinel, `kassinao-shared-luks-v1\nuuid=${value.uuid}\nmapper=${value.mapper}\n\n`);
    const extraNewline = run(value.verifier, value);
    expect(extraNewline.status).not.toBe(0);
    expect(extraNewline.stderr).toContain('sentinel .kassinao-mounted diverge');
  });

  it('exige root antes de consultar swap global', () => {
    const value = fixture();
    writeFileSync(path.join(value.bin, 'id'), '#!/usr/bin/env bash\n[ "${1:-}" = -u ] && printf "1000\\n"\n', {
      mode: 0o755,
    });
    const result = run(value.verifier, value, ['--root-only']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('execute como root');
    expect(existsSync(value.commandLog)).toBe(false);
  });
});
