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

function serviceBlock(source: string, service: string): string {
  const marker = `  ${service}:\n`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`serviço ${service} não encontrado`);
  const bodyStart = start + marker.length;
  const rest = source.slice(bodyStart);
  const nextService = rest.search(/^  [A-Za-z0-9_.-]+:\s*$/m);
  const nextSection = rest.search(/^(?:volumes|networks):\s*$/m);
  const ends = [nextService, nextSection].filter((value) => value >= 0);
  return rest.slice(0, ends.length > 0 ? Math.min(...ends) : rest.length);
}

describe('shared-host Compose adapter', () => {
  it('desliga restart autônomo nos quatro processos da instância', () => {
    expect(shared.match(/^    restart: 'no'$/gm)).toHaveLength(4);
  });

  it('sela memória e exige a sentinel do mount sem criar caminho no host', () => {
    expect(shared).toContain('mem_limit: ${KASSINAO_CORE_MEMORY_LIMIT:?');
    expect(shared).toContain('memswap_limit: ${KASSINAO_CORE_MEMORY_LIMIT:?');
    expect(shared).toContain('cpus: ${KASSINAO_CORE_CPUS:?');
    expect(shared).toContain('mem_limit: ${KASSINAO_ROUTER_MEMORY_LIMIT:?');
    expect(shared).toContain('memswap_limit: ${KASSINAO_ROUTER_MEMORY_LIMIT:?');
    expect(shared).toContain('cpus: ${KASSINAO_ROUTER_CPUS:?');
    expect(shared).toContain('mem_limit: ${KASSINAO_PUBLIC_MEMORY_LIMIT:?');
    expect(shared).toContain('cpus: ${KASSINAO_PUBLIC_CPUS:?');
    expect(shared).toContain('mem_limit: ${KASSINAO_TUNNEL_MEMORY_LIMIT:?');
    expect(shared).toContain('cpus: ${KASSINAO_TUNNEL_CPUS:?');
    expect(shared).toContain('mem_swappiness: 0');
    expect(shared).toContain('source: ${KASSINAO_DATA_ROOT}/.kassinao-mounted');
    expect(shared).toContain('target: /run/kassinao/storage-mounted');
    expect(shared).toContain('read_only: true');
    expect(shared.match(/create_host_path: false/g)).toHaveLength(4);
    expect(shared.match(/memswap_limit:/g)).toHaveLength(4);
    expect(shared.match(/mem_swappiness: 0/g)).toHaveLength(4);
    expect(shared.match(/^    cpus:/gm)).toHaveLength(4);
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
    expect(shared.match(/^    user: '\$\{KASSINAO_UID:\?/gm)).toHaveLength(3);
    expect(shared.match(/^    user: '65532:65532'$/gm)).toHaveLength(1);

    expect(base).toContain("user: '${KASSINAO_UID:-1000}:${KASSINAO_GID:-1000}'");
    expect(base).toContain('- no-new-privileges:true');
    expect(base).toMatch(/cap_drop:\n\s+- ALL/);
    expect(base).toContain("- '127.0.0.1:${KASSINAO_HOST_PORT:-8080}:8080'");
    expect(base.match(/^\s+- '127\.0\.0\.1:[^']+'$/gm)).toHaveLength(1);
  });

  it('mantém o router secret-free, preso a edge0 e como único ingress do host/túnel', () => {
    const core = serviceBlock(base, 'kassinao');
    const router = serviceBlock(base, 'kassinao-router');
    const publicProcess = serviceBlock(base, 'kassinao-public');
    const tunnel = serviceBlock(base, 'cloudflared');

    expect(router).toContain("command: ['/usr/local/bin/node', 'dist/router.js']");
    expect(router).toContain('WEB_BIND_INTERFACE: edge0');
    expect(router).toMatch(/edge_ingress:\n\s+interface_name: edge0\n\s+aliases: \[kassinao\]/);
    expect(router).toMatch(/core_link:\n\s+interface_name: core0/);
    expect(router).toMatch(/public_link:\n\s+interface_name: public0/);
    expect(router).not.toMatch(/^\s*env_file:/m);
    expect(router).not.toMatch(/^\s*volumes:/m);
    expect(router).not.toMatch(
      /^\s{6}(?:DISCORD_TOKEN|COOKIE_SECRET|MCP_SECRET|TUNNEL_TOKEN|GROQ_API_KEY|ASSEMBLYAI_API_KEY):/m,
    );
    expect(router).toContain("- '127.0.0.1:${KASSINAO_HOST_PORT:-8080}:8080'");

    expect(core).toContain("PORT: '8082'");
    expect(core).toContain("- '8082'");
    expect(core).toMatch(/core_link:\n\s+interface_name: core0\n\s+aliases: \[kassinao-core\]/);
    expect(core).toMatch(/core_egress:\n\s+interface_name: egress0\n\s+gw_priority: 1/);
    expect(core).not.toMatch(/^\s*ports:/m);
    expect(publicProcess).not.toMatch(/^\s*ports:/m);
    expect(tunnel).not.toMatch(/^\s*ports:/m);
    expect(tunnel).toContain('- kassinao-router');
  });

  it('separa cinco redes e concede egress somente ao core e ao túnel', () => {
    const router = serviceBlock(base, 'kassinao-router');
    const publicProcess = serviceBlock(base, 'kassinao-public');
    const core = serviceBlock(base, 'kassinao');
    const tunnel = serviceBlock(base, 'cloudflared');
    const networkNames = [...base.matchAll(/^  ([a-z][a-z0-9_]+):\n(?=\s{4}(?:internal|driver_opts):)/gm)].map(
      (match) => match[1],
    );

    expect(networkNames).toEqual(['edge_ingress', 'core_link', 'public_link', 'core_egress', 'tunnel_egress']);
    for (const network of ['edge_ingress', 'core_link', 'public_link']) {
      expect(base).toMatch(
        new RegExp(
          `^  ${network}:\\n    internal: true\\n    driver_opts:\\n` +
            `[\\s\\S]*?com\\.docker\\.network\\.bridge\\.gateway_mode_ipv4: isolated\\n` +
            `[\\s\\S]*?com\\.docker\\.network\\.bridge\\.gateway_mode_ipv6: isolated`,
          'm',
        ),
      );
    }
    expect(core).toContain('core_egress:');
    expect(router).not.toContain('core_egress:');
    expect(publicProcess).not.toContain('core_egress:');
    expect(tunnel).not.toContain('core_egress:');
    expect(tunnel).toContain('tunnel_egress:');
    expect(core).not.toContain('tunnel_egress:');
    expect(router).not.toContain('tunnel_egress:');
    expect(publicProcess).not.toContain('tunnel_egress:');
  });

  it.skipIf(!dockerComposeAvailable)('produz configuração mesclada válida e sem escalada', () => {
    const result = spawnSync(
      'docker',
      [
        'compose',
        '-f',
        BASE_FILE,
        '-f',
        SHARED_FILE,
        '--profile',
        'split-public',
        '--profile',
        'tunnel',
        'config',
        '--format',
        'json',
      ],
      {
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
          KASSINAO_ROUTER_MEMORY_LIMIT: '256m',
          KASSINAO_ROUTER_CPUS: '0.1',
          KASSINAO_PUBLIC_MEMORY_LIMIT: '384m',
          KASSINAO_PUBLIC_CPUS: '0.2',
          KASSINAO_TUNNEL_MEMORY_LIMIT: '192m',
          KASSINAO_TUNNEL_CPUS: '0.2',
          APP_URL: 'https://app.example.test',
          MCP_URL: 'https://mcp.example.test',
          PUBLIC_URL: 'https://example.test',
          DOCS_URL: 'https://docs.example.test',
          SOURCE_URL: 'https://github.com/example/kassinao',
          TUNNEL_TOKEN: 'compose-test-token',
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const config = JSON.parse(result.stdout) as {
      services: Record<string, Record<string, unknown>>;
    };

    for (const serviceName of ['kassinao', 'kassinao-router', 'kassinao-public', 'cloudflared']) {
      const service = config.services[serviceName];
      expect(service.restart, serviceName).toBe('no');
      expect(service.privileged, serviceName).not.toBe(true);
      expect(service.cap_add, serviceName).toBeUndefined();
      expect(service.devices, serviceName).toBeUndefined();
      expect(service.mem_limit, serviceName).toBe(service.memswap_limit);
      // Compose implementations may omit an explicit zero from normalized JSON.
      // The source assertion above still requires mem_swappiness: 0 for all services.
      expect(service.mem_swappiness ?? 0, serviceName).toBe(0);
    }

    const core = config.services.kassinao;
    expect(core.user).toBe('61050:61050');
    expect(core.cap_drop).toEqual(['ALL']);
    expect(core.security_opt).toContain('no-new-privileges:true');
    expect(core.mem_limit).toBe(core.memswap_limit);
    expect(core.mem_swappiness ?? 0).toBe(0);
    expect(JSON.stringify(core)).not.toContain('docker.sock');
    expect(core.env_file).toBeUndefined();
    const coreEnvironment = core.environment as Record<string, string>;
    expect(coreEnvironment.DOTENV_CONFIG_PATH).toBe('/run/secrets/kassinao-app.env');
    expect(JSON.stringify(coreEnvironment)).not.toContain('compose-test-token');

    expect(core.ports).toBeUndefined();

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
      }),
    );
    expect(volumes).toContainEqual(
      expect.objectContaining({
        type: 'bind',
        source: '/var/lib/kassinao/config/app.env',
        target: '/run/secrets/kassinao-app.env',
        read_only: true,
      }),
    );
    for (const target of ['/run/kassinao/storage-mounted', '/run/secrets/kassinao-app.env']) {
      const volume = volumes.find((entry) => entry.target === target);
      expect(volume?.bind?.create_host_path ?? false, target).toBe(false);
    }

    const router = config.services['kassinao-router'];
    expect(router.user).toBe('61050:61050');
    expect(router.env_file).toBeUndefined();
    expect(router.volumes).toBeUndefined();
    expect(router.command).toEqual(['/usr/local/bin/node', 'dist/router.js']);
    expect(router.environment).toEqual({
      NODE_ENV: 'production',
      PORT: '8080',
      WEB_BIND_INTERFACE: 'edge0',
      APP_URL: 'https://app.example.test',
      MCP_URL: 'https://mcp.example.test',
      PUBLIC_URL: 'https://example.test',
      DOCS_URL: 'https://docs.example.test',
      KASSINAO_RELEASE_DIGEST: `sha256:${'1'.repeat(64)}`,
      KASSINAO_DEPLOYMENT_FINGERPRINT: '2'.repeat(32),
    });
    expect(router.networks).toMatchObject({
      edge_ingress: { interface_name: 'edge0', aliases: expect.arrayContaining(['kassinao']) },
      core_link: { interface_name: 'core0' },
      public_link: { interface_name: 'public0' },
    });
    const routerPorts = router.ports as Array<{ host_ip?: string; target?: number }>;
    expect(routerPorts).toHaveLength(1);
    expect(routerPorts[0]).toMatchObject({ host_ip: '127.0.0.1', target: 8080 });

    const publicProcess = config.services['kassinao-public'];
    expect(publicProcess.ports).toBeUndefined();
    expect(publicProcess.networks).toMatchObject({ public_link: { interface_name: 'public0' } });

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
    expect(tunnel.networks).toMatchObject({
      edge_ingress: { interface_name: 'edge0' },
      tunnel_egress: { interface_name: 'egress0', gw_priority: 1 },
    });

    expect(Object.keys(config.services).sort()).toEqual([
      'cloudflared',
      'kassinao',
      'kassinao-public',
      'kassinao-router',
    ]);
    expect(Object.keys((config as { networks?: Record<string, unknown> }).networks ?? {}).sort()).toEqual([
      'core_egress',
      'core_link',
      'edge_ingress',
      'public_link',
      'tunnel_egress',
    ]);
  });
});
