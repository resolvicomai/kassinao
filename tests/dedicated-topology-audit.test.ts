import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const audit = readFileSync(path.join(process.cwd(), 'scripts', 'audit-vps-security.sh'), 'utf8');

describe('auditoria da topologia dedicated', () => {
  it('inclui os quatro processos e reserva somente o router como ingress', () => {
    expect(audit).toContain('ROUTER_CONTAINER=kassinao-router');
    expect(audit).toContain('EXPECTED_CONTAINER_NAMES+=("$ROUTER_CONTAINER" "$PUBLIC_CONTAINER")');
    expect(audit).toContain('ROUTER_COMMAND" = \'["/usr/local/bin/node","dist/router.js"]\'');
    expect(audit).toContain('router é o único ingress e publica 8080 somente no loopback IPv4 configurado');
    expect(audit).toContain('core não publica porta no host');
    expect(audit).toContain('processo público não publica porta no host');
    expect(audit).not.toContain('KASSINAO_PUBLIC_HOST_PORT');
  });

  it('prova os três links internos e as duas saídas exclusivas', () => {
    for (const bridge of ['kas-edge0', 'kas-core0', 'kas-public0', 'kas-core-eg0', 'kas-tunnel-eg0']) {
      expect(audit).toContain(bridge);
    }
    expect(audit).toContain('core usa somente link privado e egress exclusivo');
    expect(audit).toContain('router usa somente ingress, link do core e link público');
    expect(audit).toContain('cloudflared usa somente ingress e egress exclusivo');
    expect(audit).toContain('container_alias_is "$CORE_CONTAINER" "$CORE_LINK_NETWORK" kassinao-core');
    expect(audit).toContain('container_alias_is "$ROUTER_CONTAINER" "$EDGE_NETWORK" kassinao');
    expect(audit).not.toContain('kas-private0');
  });

  it('delega a prova exata de firewall ao hardener selado', () => {
    expect(audit).toContain('"$DEPLOY_REAL/scripts/harden-docker-egress.sh" --check');
    expect(audit).toContain('hardener selado aprovou identidade, topologia e policies IPv4/IPv6 das duas saídas');
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
