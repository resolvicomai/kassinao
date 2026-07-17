import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const audit = readFileSync(path.join(process.cwd(), 'scripts', 'audit-vps-security.sh'), 'utf8');
const readme = readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
const readmePtBr = readFileSync(path.join(process.cwd(), 'README.pt-BR.md'), 'utf8');

describe('auditoria da topologia dedicated', () => {
  it('documenta o contrato host_ingress atual nos dois idiomas', () => {
    expect(readme).toContain('non-internal IPv4 NAT bridge with IPv6 disabled');
    expect(readme).toContain('both its default host binding and the explicit publish locked to `127.0.0.1`');
    expect(readme).toContain('allows only `ESTABLISHED,RELATED` return traffic');
    expect(readmePtBr).toContain('bridge NAT IPv4 não-interna, exclusiva do router');
    expect(readmePtBr).toContain('binding padrão do host quanto o publish explícito presos a `127.0.0.1`');
    expect(readmePtBr).toContain('permite somente o retorno `ESTABLISHED,RELATED`');
    expect(readme).not.toContain('`host0` is an internal, IPv4-NAT-only bridge');
    expect(readmePtBr).not.toContain('A `host0` é uma bridge interna');
  });

  it('exige Engine 28.1.0 e Compose 2.36.0 antes de aprovar o perímetro', () => {
    expect(audit).toContain('parse(sys.argv[1]) < (28, 1, 0)');
    expect(audit).toContain('produção exige Docker Engine >=28.1.0 e Compose >=2.36.0');
    expect(audit).not.toMatch(/\bdocker\s+(?:start|stop|restart|kill|rm|run|create|update|compose\s+up)\b/);
  });

  it('inclui os quatro processos e reserva somente o router como ingress', () => {
    expect(audit).toContain('ROUTER_CONTAINER=kassinao-router');
    expect(audit).toContain('EXPECTED_CONTAINER_NAMES+=("$ROUTER_CONTAINER" "$PUBLIC_CONTAINER")');
    expect(audit).toContain('ROUTER_COMMAND" = \'["/usr/local/bin/node","dist/router.js"]\'');
    expect(audit).toContain('router é o único ingress e publica 8080 somente no loopback IPv4 configurado');
    expect(audit).toContain('core não publica porta no host');
    expect(audit).toContain('processo público não publica porta no host');
    expect(audit).not.toContain('KASSINAO_PUBLIC_HOST_PORT');
  });

  it('prova o ingress host, os três links isolados e as duas saídas exclusivas', () => {
    for (const bridge of ['kas-host0', 'kas-edge0', 'kas-core0', 'kas-public0', 'kas-core-eg0', 'kas-tunnel-eg0']) {
      expect(audit).toContain(bridge);
    }
    expect(audit).toContain('core usa somente link privado e egress exclusivo');
    expect(audit).toContain('router usa somente host ingress, edge ingress, link do core e link público');
    expect(audit).toContain('cloudflared usa somente ingress e egress exclusivo');
    expect(audit).toContain('container_alias_is "$CORE_CONTAINER" "$CORE_LINK_NETWORK" kassinao-core');
    expect(audit).toContain('container_alias_is "$ROUTER_CONTAINER" "$EDGE_NETWORK" kassinao');
    expect(audit).not.toContain('kas-private0');
  });

  it('não confunde falha do inspect com opção de rede ausente', () => {
    const functionSource = audit.match(/network_option_is_absent\(\) \{[\s\S]*?\n\}/)?.[0];
    expect(functionSource).toBeTruthy();
    expect(functionSource).not.toContain('|| true');

    const root = mkdtempSync(path.join(tmpdir(), 'kassinao-audit-network-option-'));
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    const docker = path.join(bin, 'docker');
    writeFileSync(docker, '#!/usr/bin/env bash\nexit 23\n');
    chmodSync(docker, 0o700);
    const probe = path.join(root, 'probe.sh');
    writeFileSync(probe, `#!/usr/bin/env bash\n${functionSource}\nnetwork_option_is_absent fixture option\n`);
    chmodSync(probe, 0o700);
    try {
      const result = spawnSync('bash', [probe], {
        encoding: 'utf8',
        env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
      });
      expect(result.status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('delega a prova exata de firewall ao hardener selado', () => {
    expect(audit).toContain('"$DEPLOY_REAL/scripts/harden-docker-egress.sh" --check');
    expect(audit).toContain(
      'hardener selado aprovou identidade, topologia e policies IPv4/IPv6 das saídas e do host ingress',
    );
    expect(audit).not.toContain('firewall_family_ok()');
    expect(audit).not.toContain('mapfile -t egress_rules');
  });

  it('mantém o router sem mounts, env_file ou configuração privada', () => {
    expect(audit).toContain("app.get('TRUST_PROXY_HOPS') != '1'");
    expect(audit).toContain('"PUBLIC_SURFACES_ENABLED", "TRUST_PROXY_HOPS"');
    expect(audit).toContain("ROUTER_MOUNTS\" = '[]'");
    expect(audit).toContain('ROUTER_ALLOWED_ENV=');
    expect(audit).toContain('router possui somente topologia pública canônica e nenhum segredo');
    for (const secret of ['DISCORD_TOKEN', 'DISCORD_CLIENT_SECRET', 'COOKIE_SECRET', 'TUNNEL_TOKEN', 'GROQ_API_KEY']) {
      const allowedEnvironment = audit.match(/ROUTER_ALLOWED_ENV='([^']+)'/)?.[1] ?? '';
      expect(allowedEnvironment).not.toContain(secret);
    }
  });
});
