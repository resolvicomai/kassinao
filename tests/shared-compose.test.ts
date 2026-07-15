import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const BASE_FILE = path.join(ROOT, 'docker-compose.yml');
const SHARED_FILE = path.join(ROOT, 'docker-compose.shared.yml');
const base = readFileSync(BASE_FILE, 'utf8');
const shared = readFileSync(SHARED_FILE, 'utf8');

const dockerComposeAvailable = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

describe('shared-host Compose adapter', () => {
  it('desliga restart autônomo nos três processos da instância', () => {
    expect(shared.match(/^    restart: 'no'$/gm)).toHaveLength(3);
  });

  it('sela memória e exige a sentinel do mount sem criar caminho no host', () => {
    expect(shared).toContain('mem_limit: ${KASSINAO_CORE_MEMORY_LIMIT:?');
    expect(shared).toContain('memswap_limit: ${KASSINAO_CORE_MEMORY_LIMIT:?');
    expect(shared).toContain('cpus: ${KASSINAO_CORE_CPUS:?');
    expect(shared).toContain('mem_limit: ${KASSINAO_PUBLIC_MEMORY_LIMIT:?');
    expect(shared).toContain('cpus: ${KASSINAO_PUBLIC_CPUS:?');
    expect(shared).toContain('mem_limit: ${KASSINAO_TUNNEL_MEMORY_LIMIT:?');
    expect(shared).toContain('cpus: ${KASSINAO_TUNNEL_CPUS:?');
    expect(shared).toContain('mem_swappiness: 0');
    expect(shared).toContain('source: ${KASSINAO_DATA_ROOT}/.kassinao-mounted');
    expect(shared).toContain('target: /run/kassinao/storage-mounted');
    expect(shared).toContain('read_only: true');
    expect(shared).toContain('create_host_path: false');
    expect(shared.match(/memswap_limit:/g)).toHaveLength(3);
    expect(shared.match(/mem_swappiness: 0/g)).toHaveLength(3);
    expect(shared.match(/^    cpus:/gm)).toHaveLength(3);
  });

  it('carrega segredos somente por binds cifrados read-only', () => {
    expect(shared).toContain('env_file: !reset []');
    expect(shared).toContain('DOTENV_CONFIG_PATH: /run/secrets/kassinao-app.env');
    expect(shared).toContain('source: ${KASSINAO_SHARED_APP_ENV_FILE}');
    expect(shared).toContain('target: /run/secrets/kassinao-app.env');
    expect(shared).toContain('environment: !reset {}');
    expect(shared).toContain("'--token-file', '/run/secrets/kassinao-tunnel-token'");
    expect(shared).toContain("entrypoint: ['/usr/local/bin/kassinao-no-dump', '--', '/usr/local/bin/cloudflared']");
    expect(shared).toContain('source: /usr/local/libexec/kassinao/kassinao-no-dump');
    expect(shared).toContain('target: /usr/local/bin/kassinao-no-dump');
    expect(shared).toContain('source: ${KASSINAO_SHARED_TUNNEL_TOKEN_FILE}');
    expect(shared).not.toMatch(/^\s+TUNNEL_TOKEN:/m);
  });

  it('não amplia privilégios nem substitui o perímetro seguro do Compose-base', () => {
    expect(shared).not.toMatch(/\bprivileged\s*:/);
    expect(shared).not.toMatch(/\bcap_add\s*:/);
    expect(shared).not.toMatch(/\bdevices?\s*:/);
    expect(shared).not.toContain('docker.sock');
    expect(shared).not.toMatch(/^\s+ports\s*:/m);
    expect(shared.match(/^    user: '\$\{KASSINAO_UID:\?/gm)).toHaveLength(2);
    expect(shared.match(/^    user: '65532:65532'$/gm)).toHaveLength(1);

    expect(base).toContain("user: '${KASSINAO_UID:-1000}:${KASSINAO_GID:-1000}'");
    expect(base).toContain('- no-new-privileges:true');
    expect(base).toMatch(/cap_drop:\n\s+- ALL/);
    expect(base).toContain("- '127.0.0.1:${KASSINAO_HOST_PORT:-8080}:8080'");
    expect(base).toContain("- '127.0.0.1:${KASSINAO_PUBLIC_HOST_PORT:-8081}:8081'");
  });

  it.skipIf(!dockerComposeAvailable)('produz configuração mesclada válida e sem escalada', () => {
    const result = spawnSync('docker', ['compose', '-f', BASE_FILE, '-f', SHARED_FILE, 'config', '--format', 'json'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        KASSINAO_DATA_ROOT: '/var/lib/kassinao',
        KASSINAO_SHARED_APP_ENV_FILE: '/var/lib/kassinao/config/app.env',
        KASSINAO_SHARED_TUNNEL_TOKEN_FILE: '/var/lib/kassinao/config/cloudflared-token',
        KASSINAO_IMAGE: `ghcr.io/resolvicomai/kassinao@sha256:${'1'.repeat(64)}`,
        KASSINAO_UID: '61050',
        KASSINAO_GID: '61050',
        KASSINAO_RELEASE_DIGEST: `sha256:${'1'.repeat(64)}`,
        KASSINAO_DEPLOYMENT_FINGERPRINT: '2'.repeat(32),
        KASSINAO_CORE_MEMORY_LIMIT: '2g',
        KASSINAO_CORE_CPUS: '1.0',
        KASSINAO_PUBLIC_MEMORY_LIMIT: '384m',
        KASSINAO_PUBLIC_CPUS: '0.2',
        KASSINAO_TUNNEL_MEMORY_LIMIT: '192m',
        KASSINAO_TUNNEL_CPUS: '0.2',
        TUNNEL_TOKEN: 'compose-test-token',
      },
    });

    expect(result.status, result.stderr).toBe(0);
    const config = JSON.parse(result.stdout) as {
      services: Record<string, Record<string, unknown>>;
    };

    for (const serviceName of ['kassinao', 'kassinao-public', 'cloudflared']) {
      const service = config.services[serviceName];
      expect(service.restart, serviceName).toBe('no');
      expect(service.privileged, serviceName).not.toBe(true);
      expect(service.cap_add, serviceName).toBeUndefined();
      expect(service.devices, serviceName).toBeUndefined();
      expect(service.mem_limit, serviceName).toBe(service.memswap_limit);
      expect(service.mem_swappiness, serviceName).toBe(0);
    }

    const core = config.services.kassinao;
    expect(core.user).toBe('61050:61050');
    expect(core.cap_drop).toEqual(['ALL']);
    expect(core.security_opt).toContain('no-new-privileges:true');
    expect(core.mem_limit).toBe(core.memswap_limit);
    expect(core.mem_swappiness).toBe(0);
    expect(JSON.stringify(core)).not.toContain('docker.sock');
    expect(core.env_file).toBeUndefined();
    const coreEnvironment = core.environment as Record<string, string>;
    expect(coreEnvironment.DOTENV_CONFIG_PATH).toBe('/run/secrets/kassinao-app.env');
    expect(JSON.stringify(coreEnvironment)).not.toContain('compose-test-token');

    const ports = core.ports as Array<{ host_ip?: string }>;
    expect(ports.every((port) => port.host_ip === '127.0.0.1')).toBe(true);

    const volumes = core.volumes as Array<{
      type: string;
      source: string;
      target: string;
      read_only?: boolean;
      bind?: { create_host_path?: boolean };
    }>;
    expect(volumes).toContainEqual(
      expect.objectContaining({
        type: 'bind',
        source: '/var/lib/kassinao/.kassinao-mounted',
        target: '/run/kassinao/storage-mounted',
        read_only: true,
        bind: expect.objectContaining({ create_host_path: false }),
      }),
    );
    expect(volumes).toContainEqual(
      expect.objectContaining({
        type: 'bind',
        source: '/var/lib/kassinao/config/app.env',
        target: '/run/secrets/kassinao-app.env',
        read_only: true,
        bind: expect.objectContaining({ create_host_path: false }),
      }),
    );

    const tunnel = config.services.cloudflared;
    expect(tunnel.user).toBe('65532:65532');
    expect(tunnel.environment ?? {}).not.toHaveProperty('TUNNEL_TOKEN');
    expect(tunnel.command).toEqual([
      'tunnel',
      '--no-autoupdate',
      'run',
      '--token-file',
      '/run/secrets/kassinao-tunnel-token',
    ]);
    expect(tunnel.entrypoint).toEqual(['/usr/local/bin/kassinao-no-dump', '--', '/usr/local/bin/cloudflared']);
  });
});
