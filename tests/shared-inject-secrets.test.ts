import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
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

function activeEnvironment(source: string): Map<string, string> {
  return new Map(
    [...source.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((match) => [match[1], match[2].trim()] as const),
  );
}

function validInput(botToken: string, oauthSecret: string, tunnelSecret: string): string {
  return [
    botToken,
    '123456789012345678',
    oauthSecret,
    'https://app.example.com',
    'https://www.example.com',
    'https://docs.example.com',
    '',
    'https://github.com/example/kassinao',
    'Example Operator',
    'mailto:privacy@example.com',
    '',
    '987654321098765432',
    tunnelSecret,
    '2026-07-15',
    '1.0',
    'Members of configured Discord servers',
    'Record meetings and provide operator enabled outputs',
    'Operator defined organizational necessity',
    'Example Cloud',
    'Brazil',
    '',
    '',
    'Container host and provider logs expire after thirty days',
    '',
    'Requests are verified through the operator contact',
    '',
    '',
    'Incidents are triaged contained investigated and communicated',
    '',
  ].join('\n');
}

function fixture(
  options: {
    flockFails?: boolean;
    lockMetadata?: string;
    lockSymlink?: boolean;
    mvFailsAt?: number;
    signalAt?: number;
    neighborAuditFails?: boolean;
    storageVerifierFailsAt?: number;
  } = {},
) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'kassinao-shared-inject-')));
  temporaryDirectories.push(directory);
  chmodSync(directory, 0o700);
  const scripts = path.join(directory, 'scripts');
  const dataRoot = path.join(directory, 'mounted-luks');
  const configDir = path.join(dataRoot, 'config');
  const appEnv = path.join(configDir, 'app.env');
  const tunnelToken = path.join(configDir, 'cloudflared-token');
  const composeEnv = path.join(directory, '.env');
  const ignoredOverride = path.join(directory, 'outside.env');
  const bin = path.join(directory, 'bin');
  const auditLog = path.join(directory, 'audit.log');
  const storageLog = path.join(directory, 'storage.log');
  const storageCount = path.join(directory, 'storage.count');
  const traceLog = path.join(directory, 'trace.log');
  const mvCount = path.join(directory, 'mv.count');
  const runtime = path.join(directory, 'runtime');
  const maintenanceLock = path.join(runtime, 'maintenance.lock');
  const inheritedEnvironment = path.join(directory, 'inherited-environment.bin');
  mkdirSync(scripts, { mode: 0o700 });
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(bin, { mode: 0o700 });
  mkdirSync(runtime, { mode: 0o700 });
  chmodSync(configDir, 0o700);
  chmodSync(runtime, 0o700);
  writeFileSync(maintenanceLock, '', { mode: 0o600 });
  chmodSync(maintenanceLock, 0o600);
  if (options.lockSymlink) {
    rmSync(maintenanceLock);
    const outsideLock = path.join(directory, 'outside-maintenance.lock');
    writeFileSync(outsideLock, '', { mode: 0o600 });
    symlinkSync(outsideLock, maintenanceLock);
  }
  const inheritedNames = new Set([
    ...Object.keys(process.env),
    'PATH',
    'HOME',
    'KASSINAO_APP_ENV_FILE',
    'KASSINAO_COMPOSE_ENV_FILE',
    'KASSINAO_RUNTIME_DIR',
    'DISCORD_TOKEN',
    'LUKS_PASSPHRASE',
    'CALLER_CANARY_SECRET',
  ]);
  writeFileSync(inheritedEnvironment, Buffer.from([...inheritedNames].map((name) => `${name}=fixture\0`).join('')));

  const script = path.join(scripts, 'inject-secrets.sh');
  const auditor = path.join(scripts, 'audit-shared-vps-security.sh');
  const storageVerifier = path.join(scripts, 'verify-shared-luks-storage.sh');
  const injectorSource = readFileSync(path.join(ROOT, 'scripts', 'inject-secrets.sh'), 'utf8')
    .replace(
      'SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      `SAFE_SYSTEM_PATH=${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    )
    .replaceAll('/proc/$$/environ', inheritedEnvironment)
    .replace(
      /# KASSINAO_HOST_NO_DUMP_BEGIN[\s\S]*?# KASSINAO_HOST_NO_DUMP_END/,
      '# KASSINAO_HOST_NO_DUMP_BEGIN\nunset LD_PRELOAD\n# KASSINAO_HOST_NO_DUMP_END',
    )
    .replace('RUNTIME_DIR=/run/lock/kassinao', `RUNTIME_DIR=${runtime}`)
    .replace(
      '[ "${KASSINAO_RUNTIME_DIR+x}" != x ] || _runtime_override_present=true',
      '_runtime_override_present=false',
    )
    .replace(
      /# KASSINAO_LOCK_FD_PROOF_BEGIN[\s\S]*?# KASSINAO_LOCK_FD_PROOF_END/,
      '# KASSINAO_LOCK_FD_PROOF_BEGIN\n:\n# KASSINAO_LOCK_FD_PROOF_END',
    );
  writeFileSync(script, injectorSource, { mode: 0o700 });
  writeFileSync(
    auditor,
    `#!/usr/bin/env bash
set -eu
[ "$#" -eq 1 ] && [ "$1" = --neighbors-only ] || exit 90
[ "\${KASSINAO_ENV_FILE:-}" = ${shellLiteral(composeEnv)} ] || exit 91
[ -z "\${DISCORD_TOKEN:-}" ] && [ -z "\${LUKS_PASSPHRASE:-}" ] && [ -z "\${CALLER_CANARY_SECRET:-}" ] || exit 92
printf 'auditor:%s\n' "$*" >> ${shellLiteral(auditLog)}
printf 'auditor\n' >> ${shellLiteral(traceLog)}
[ ${options.neighborAuditFails ? 'true' : 'false'} = false ] || exit 93
`,
    { mode: 0o755 },
  );
  chmodSync(auditor, 0o755);
  writeFileSync(
    storageVerifier,
    `#!/usr/bin/env bash
set -eu
[ "$#" -eq 0 ] || exit 94
[ "\${KASSINAO_ENV_FILE:-}" = ${shellLiteral(composeEnv)} ] || exit 95
[ -z "\${DISCORD_TOKEN:-}" ] && [ -z "\${LUKS_PASSPHRASE:-}" ] && [ -z "\${CALLER_CANARY_SECRET:-}" ] || exit 96
count=0
[ ! -f ${shellLiteral(storageCount)} ] || count="$(cat -- ${shellLiteral(storageCount)})"
count=$((count + 1))
printf '%s\n' "$count" > ${shellLiteral(storageCount)}
printf 'storage:%s\n' "$count" >> ${shellLiteral(storageLog)}
printf 'storage\n' >> ${shellLiteral(traceLog)}
[ "$count" -ne ${options.storageVerifierFailsAt ?? -1} ] || exit 97
`,
    { mode: 0o755 },
  );
  chmodSync(storageVerifier, 0o755);
  writeFileSync(appEnv, 'BASE_URL=https://stale.example\n', { mode: 0o440 });
  writeFileSync(tunnelToken, '', { mode: 0o444 });
  writeFileSync(ignoredOverride, 'DO_NOT_TOUCH=1\n', { mode: 0o600 });
  writeFileSync(
    composeEnv,
    [
      'KASSINAO_DEPLOYMENT_MODE=split',
      'KASSINAO_DEPLOYMENT_FINGERPRINT=',
      'KASSINAO_HOST_SCOPE=shared',
      'KASSINAO_DEDICATED_DOCKER_HOST_ACK=',
      'KASSINAO_ROLLBACK_RETENTION_HOURS=72',
      `KASSINAO_DATA_ROOT=${dataRoot}`,
      `KASSINAO_SHARED_APP_ENV_FILE=${appEnv}`,
      `KASSINAO_SHARED_TUNNEL_TOKEN_FILE=${tunnelToken}`,
      'KASSINAO_UID=61050',
      'KASSINAO_GID=61050',
      'APP_URL=',
      'MCP_URL=',
      'PUBLIC_URL=',
      'DOCS_URL=',
      'SOURCE_URL=',
      'COMPOSE_PROFILES=',
      'TUNNEL_TOKEN=stale-value-must-disappear',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  const manifestEntries = [
    'scripts/inject-secrets.sh',
    'scripts/audit-shared-vps-security.sh',
    'scripts/verify-shared-luks-storage.sh',
  ].map((relative) => {
    const digest = createHash('sha256')
      .update(readFileSync(path.join(directory, relative)))
      .digest('hex');
    return `${digest}  ${relative}`;
  });
  writeFileSync(path.join(directory, 'MANIFEST.sha256'), `${manifestEntries.join('\n')}\n`, { mode: 0o600 });

  const commands: Record<string, string> = {
    id: `#!/usr/bin/env bash
case "\${1:-}" in -u) printf '0\n' ;; -g) printf '0\n' ;; *) exit 2 ;; esac
`,
    readlink: `#!/usr/bin/env bash
printf '%s\n' "\${!#}"
`,
    findmnt: `#!/usr/bin/env bash
printf '%s\n' ${shellLiteral(dataRoot)}
`,
    stat: `#!/usr/bin/env bash
set -eu
target="\${!#}"
format="\${2:-}"
if [ "$format" = %h ]; then printf '1\n'; exit 0; fi
case "$target" in
  ${shellLiteral(composeEnv)}) printf '600:0:0:1\n' ;;
  ${shellLiteral(runtime)}) printf '700:0:0\n' ;;
  ${shellLiteral(maintenanceLock)}) printf '${options.lockMetadata ?? '600:0:0:1'}\n' ;;
  ${shellLiteral(configDir)}) printf '700:0:0\n' ;;
  ${shellLiteral(appEnv)}) printf '440:0:61050\n' ;;
  ${shellLiteral(tunnelToken)}) printf '444:0:0\n' ;;
  ${shellLiteral(auditor)}) printf '755:0:0\n' ;;
  ${shellLiteral(storageVerifier)}) printf '755:0:0\n' ;;
  *) printf '600:0:0\n' ;;
esac
`,
    chown: `#!/usr/bin/env bash
exit 0
`,
    flock: `#!/usr/bin/env bash
printf 'lock\n' >> ${shellLiteral(traceLog)}
exit ${options.flockFails ? '1' : '0'}
`,
    mv: `#!/usr/bin/env bash
set -eu
count=0
[ ! -f ${shellLiteral(mvCount)} ] || count="$(cat -- ${shellLiteral(mvCount)})"
count=$((count + 1))
printf '%s\n' "$count" > ${shellLiteral(mvCount)}
printf 'mv:%s\n' "$count" >> ${shellLiteral(traceLog)}
if [ "$count" -eq ${options.signalAt ?? -1} ]; then
  kill -TERM "$PPID"
  exit 143
fi
[ "$count" -ne ${options.mvFailsAt ?? -1} ] || exit 97
exec /bin/mv "$@"
`,
  };
  for (const [name, source] of Object.entries(commands)) {
    const file = path.join(bin, name);
    writeFileSync(file, source, { mode: 0o755 });
    chmodSync(file, 0o755);
  }

  return {
    directory,
    script,
    auditor,
    storageVerifier,
    dataRoot,
    configDir,
    appEnv,
    tunnelToken,
    composeEnv,
    ignoredOverride,
    bin,
    auditLog,
    storageLog,
    traceLog,
    runtime,
    maintenanceLock,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('injeção de segredos no adapter shared', () => {
  it('sela PATH e hooks de shell antes da primeira resolução externa', () => {
    const source = readFileSync(path.join(ROOT, 'scripts', 'inject-secrets.sh'), 'utf8');
    const safePath = source.indexOf('SAFE_SYSTEM_PATH=/usr/local/sbin:');
    const pathExport = source.indexOf('export PATH', safePath);
    const hookRemoval = source.indexOf('unset CDPATH ENV BASH_ENV', safePath);
    const inheritedScrub = source.indexOf('done < "/proc/$$/environ"');
    const firstExternalLookup = source.indexOf('cd "$ROOT"');
    const identityLookup = source.indexOf('CALLER_UID="$(id -u)"');

    expect(safePath).toBeGreaterThan(0);
    expect(inheritedScrub).toBeGreaterThan(0);
    expect(safePath).toBeGreaterThan(inheritedScrub);
    expect(pathExport).toBeGreaterThan(safePath);
    expect(hookRemoval).toBeGreaterThan(pathExport);
    expect(firstExternalLookup).toBeGreaterThan(hookRemoval);
    expect(identityLookup).toBeGreaterThan(firstExternalLookup);
    expect(source.slice(safePath, firstExternalLookup)).not.toContain('$PATH');
    expect(source.startsWith('#!/bin/bash -p')).toBe(true);
    expect(source).toContain('--bundle-root "$ROOT" --script-relative scripts/inject-secrets.sh');
  });

  it('adquire lock e prova storage/vizinhos antes do primeiro segredo e ao redor da transação', () => {
    const source = readFileSync(path.join(ROOT, 'scripts', 'inject-secrets.sh'), 'utf8');
    const lock = source.indexOf('    acquire_shared_maintenance_lock');
    const firstGate = source.indexOf('    run_shared_seal_gate', lock);
    const prompts = source.indexOf("echo '== Identidade privada");
    const preTransactionGate = source.indexOf('  run_shared_seal_gate', prompts);
    const transaction = source.indexOf('  rewrite_shared_transaction', preTransactionGate);
    const postTransactionGate = source.indexOf('  run_shared_seal_gate', transaction);
    const finalize = source.indexOf('  finalize_shared_transaction', postTransactionGate);
    expect(lock).toBeGreaterThan(0);
    expect(firstGate).toBeGreaterThan(lock);
    expect(prompts).toBeGreaterThan(firstGate);
    expect(preTransactionGate).toBeGreaterThan(prompts);
    expect(transaction).toBeGreaterThan(preTransactionGate);
    expect(postTransactionGate).toBeGreaterThan(transaction);
    expect(finalize).toBeGreaterThan(postTransactionGate);
  });

  it('grava atomically no LUKS e mantém o Compose sem tokens', () => {
    const value = fixture();
    const botToken = 'dummy-bot-secret-not-real';
    const oauthSecret = 'dummy-oauth-secret-not-real';
    const tunnelSecret = 'dummy-tunnel-token-not-real';
    const input = validInput(botToken, oauthSecret, tunnelSecret);

    const result = spawnSync('bash', [value.script], {
      cwd: value.directory,
      input,
      encoding: 'utf8',
      env: {
        PATH: `${value.bin}:${process.env.PATH ?? ''}`,
        HOME: value.directory,
        KASSINAO_APP_ENV_FILE: value.ignoredOverride,
        KASSINAO_COMPOSE_ENV_FILE: value.composeEnv,
        KASSINAO_RUNTIME_DIR: value.runtime,
        DISCORD_TOKEN: 'inherited-secret-must-not-reach-auditor',
        LUKS_PASSPHRASE: 'inherited-secret-must-not-reach-auditor',
        CALLER_CANARY_SECRET: 'must-never-reach-any-child-or-output',
      },
    });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(botToken);
    expect(`${result.stdout}${result.stderr}`).not.toContain(oauthSecret);
    expect(`${result.stdout}${result.stderr}`).not.toContain(tunnelSecret);
    expect(`${result.stdout}${result.stderr}`).not.toContain('must-never-reach-any-child-or-output');
    expect(readFileSync(value.ignoredOverride, 'utf8')).toBe('DO_NOT_TOUCH=1\n');

    const app = activeEnvironment(readFileSync(value.appEnv, 'utf8'));
    const compose = activeEnvironment(readFileSync(value.composeEnv, 'utf8'));
    expect(app.get('DISCORD_TOKEN')).toBe(botToken);
    expect(app.get('DISCORD_CLIENT_SECRET')).toBe(oauthSecret);
    expect(readFileSync(value.tunnelToken, 'utf8')).toBe(tunnelSecret);
    expect(compose.get('KASSINAO_HOST_SCOPE')).toBe('shared');
    expect(compose.get('COMPOSE_PROFILES')).toBe('tunnel,split-public');
    expect(compose.get('TUNNEL_TOKEN')).toBe('');
    expect(readFileSync(value.composeEnv, 'utf8')).not.toContain(tunnelSecret);
    expect(readFileSync(value.auditLog, 'utf8')).toContain('auditor:--neighbors-only');
    expect(readFileSync(value.auditLog, 'utf8').trim().split('\n')).toHaveLength(3);
    expect(readFileSync(value.storageLog, 'utf8').trim().split('\n')).toHaveLength(3);
    const trace = readFileSync(value.traceLog, 'utf8').trim().split('\n');
    expect(trace.indexOf('storage')).toBeLessThan(trace.indexOf('auditor'));
    expect(trace.indexOf('lock')).toBeLessThan(trace.indexOf('auditor'));
    expect(trace.indexOf('auditor')).toBeLessThan(trace.indexOf('mv:1'));
    expect(statSync(value.configDir).mode & 0o777).toBe(0o700);
    expect(statSync(value.appEnv).mode & 0o777).toBe(0o440);
    expect(statSync(value.tunnelToken).mode & 0o777).toBe(0o444);
  });

  it.each([
    ['modo inválido', { lockMetadata: '640:0:0:1' }],
    ['ownership inválido', { lockMetadata: '600:1000:0:1' }],
    ['hardlink', { lockMetadata: '600:0:0:2' }],
    ['symlink', { lockSymlink: true }],
    ['contenção', { flockFails: true }],
  ] as const)('recusa maintenance.lock inseguro ou indisponível: %s', (_label, options) => {
    const value = fixture(options);
    const originalApp = readFileSync(value.appEnv, 'utf8');
    const originalToken = readFileSync(value.tunnelToken, 'utf8');
    const originalCompose = readFileSync(value.composeEnv, 'utf8');

    const result = spawnSync('bash', [value.script], {
      cwd: value.directory,
      encoding: 'utf8',
      env: {
        PATH: `${value.bin}:${process.env.PATH ?? ''}`,
        HOME: value.directory,
        KASSINAO_COMPOSE_ENV_FILE: value.composeEnv,
        KASSINAO_RUNTIME_DIR: value.runtime,
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/maintenance\.lock|outra manutenção/);
    expect(existsSync(value.auditLog)).toBe(false);
    expect(readFileSync(value.appEnv, 'utf8')).toBe(originalApp);
    expect(readFileSync(value.tunnelToken, 'utf8')).toBe(originalToken);
    expect(readFileSync(value.composeEnv, 'utf8')).toBe(originalCompose);
  });

  it.each([
    ['falha no segundo rename', { mvFailsAt: 2 }, 97],
    ['SIGTERM no segundo rename', { signalAt: 2 }, 143],
  ] as const)('restaura os três arquivos após %s', (_label, options, expectedStatus) => {
    const value = fixture(options);
    const originalApp = readFileSync(value.appEnv, 'utf8');
    const originalToken = readFileSync(value.tunnelToken, 'utf8');
    const originalCompose = readFileSync(value.composeEnv, 'utf8');

    const result = spawnSync('bash', [value.script], {
      cwd: value.directory,
      input: validInput('new-bot-secret-not-real', 'new-oauth-secret-not-real', 'new-tunnel-secret-not-real'),
      encoding: 'utf8',
      env: {
        PATH: `${value.bin}:${process.env.PATH ?? ''}`,
        HOME: value.directory,
        KASSINAO_COMPOSE_ENV_FILE: value.composeEnv,
        KASSINAO_RUNTIME_DIR: value.runtime,
      },
    });

    expect(result.status).toBe(expectedStatus);
    expect(readFileSync(value.appEnv, 'utf8')).toBe(originalApp);
    expect(readFileSync(value.tunnelToken, 'utf8')).toBe(originalToken);
    expect(readFileSync(value.composeEnv, 'utf8')).toBe(originalCompose);
    for (const directory of [value.directory, value.configDir]) {
      expect(readdirSync(directory).some((name) => /\.(?:stage|rollback)\./.test(name))).toBe(false);
    }
  });

  it('recusa caminho de segredo fora de DATA_ROOT/config antes de ler prompts', () => {
    const value = fixture();
    const compose = readFileSync(value.composeEnv, 'utf8').replace(
      `KASSINAO_SHARED_APP_ENV_FILE=${value.appEnv}`,
      `KASSINAO_SHARED_APP_ENV_FILE=${value.ignoredOverride}`,
    );
    writeFileSync(value.composeEnv, compose, { mode: 0o600 });

    const result = spawnSync('bash', [value.script], {
      cwd: value.directory,
      encoding: 'utf8',
      env: {
        PATH: `${value.bin}:${process.env.PATH ?? ''}`,
        HOME: value.directory,
        KASSINAO_COMPOSE_ENV_FILE: value.composeEnv,
        KASSINAO_RUNTIME_DIR: value.runtime,
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('caminhos exatos sob DATA_ROOT/config');
  });

  it('recusa auditor divergente do manifesto antes de ler ou gravar segredos', () => {
    const value = fixture();
    const originalApp = readFileSync(value.appEnv, 'utf8');
    const originalToken = readFileSync(value.tunnelToken, 'utf8');
    writeFileSync(value.auditor, `${readFileSync(value.auditor, 'utf8')}# tampered\n`, { mode: 0o755 });

    const result = spawnSync('bash', [value.script], {
      cwd: value.directory,
      encoding: 'utf8',
      env: {
        PATH: `${value.bin}:${process.env.PATH ?? ''}`,
        HOME: value.directory,
        KASSINAO_COMPOSE_ENV_FILE: value.composeEnv,
        KASSINAO_RUNTIME_DIR: value.runtime,
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('diverge do MANIFEST.sha256');
    expect(readFileSync(value.appEnv, 'utf8')).toBe(originalApp);
    expect(readFileSync(value.tunnelToken, 'utf8')).toBe(originalToken);
  });

  it('recusa vizinho inseguro imediatamente antes de gravar qualquer segredo', () => {
    const value = fixture({ neighborAuditFails: true });
    const originalApp = readFileSync(value.appEnv, 'utf8');
    const originalToken = readFileSync(value.tunnelToken, 'utf8');
    const originalCompose = readFileSync(value.composeEnv, 'utf8');
    const result = spawnSync('bash', [value.script], {
      cwd: value.directory,
      input: validInput('dummy-bot-secret-not-real', 'dummy-oauth-secret-not-real', 'dummy-tunnel-not-real'),
      encoding: 'utf8',
      env: {
        PATH: `${value.bin}:${process.env.PATH ?? ''}`,
        HOME: value.directory,
        KASSINAO_COMPOSE_ENV_FILE: value.composeEnv,
        KASSINAO_RUNTIME_DIR: value.runtime,
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('auditoria read-only dos vizinhos recusou');
    expect(readFileSync(value.auditLog, 'utf8')).toContain('auditor:--neighbors-only');
    expect(readFileSync(value.appEnv, 'utf8')).toBe(originalApp);
    expect(readFileSync(value.tunnelToken, 'utf8')).toBe(originalToken);
    expect(readFileSync(value.composeEnv, 'utf8')).toBe(originalCompose);
  });

  it('recusa storage inválido antes de ler o primeiro segredo', () => {
    const value = fixture({ storageVerifierFailsAt: 1 });
    const originalApp = readFileSync(value.appEnv, 'utf8');
    const result = spawnSync('bash', [value.script], {
      cwd: value.directory,
      encoding: 'utf8',
      env: {
        PATH: `${value.bin}:${process.env.PATH ?? ''}`,
        HOME: value.directory,
        KASSINAO_COMPOSE_ENV_FILE: value.composeEnv,
        KASSINAO_RUNTIME_DIR: value.runtime,
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('verificador dm-crypt/LUKS recusou');
    expect(readFileSync(value.appEnv, 'utf8')).toBe(originalApp);
    expect(existsSync(value.auditLog)).toBe(false);
  });

  it('restaura os três arquivos quando o gate pós-transação reprova', () => {
    const value = fixture({ storageVerifierFailsAt: 3 });
    const originalApp = readFileSync(value.appEnv, 'utf8');
    const originalToken = readFileSync(value.tunnelToken, 'utf8');
    const originalCompose = readFileSync(value.composeEnv, 'utf8');
    const result = spawnSync('bash', [value.script], {
      cwd: value.directory,
      input: validInput('new-bot-secret-not-real', 'new-oauth-secret-not-real', 'new-tunnel-secret-not-real'),
      encoding: 'utf8',
      env: {
        PATH: `${value.bin}:${process.env.PATH ?? ''}`,
        HOME: value.directory,
        KASSINAO_COMPOSE_ENV_FILE: value.composeEnv,
        KASSINAO_RUNTIME_DIR: value.runtime,
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('verificador dm-crypt/LUKS recusou');
    expect(readFileSync(value.appEnv, 'utf8')).toBe(originalApp);
    expect(readFileSync(value.tunnelToken, 'utf8')).toBe(originalToken);
    expect(readFileSync(value.composeEnv, 'utf8')).toBe(originalCompose);
  });
});
