import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('isolamento de segredos entre containers', () => {
  it('não entrega o token do túnel ao processo principal', () => {
    const compose = fs.readFileSync(path.join(process.cwd(), 'docker-compose.yml'), 'utf8');
    const serviceBlock = (name: string): string | undefined =>
      new RegExp(`^  ${name}:\\n((?: {4,}.*\\n|[ \\t]*\\n)*)`, 'm').exec(compose)?.[1];
    const appBlock = serviceBlock('kassinao');
    const publicBlock = serviceBlock('kassinao-public');
    const tunnelBlock = serviceBlock('cloudflared');

    expect(appBlock).toBeDefined();
    expect(publicBlock).toBeDefined();
    expect(appBlock).toContain("TUNNEL_TOKEN: ''");
    expect(appBlock).not.toContain('TUNNEL_TOKEN: ${TUNNEL_TOKEN}');
    expect(publicBlock).not.toContain('env_file:');
    expect(publicBlock).not.toContain('TUNNEL_TOKEN');
    expect(tunnelBlock).toContain('TUNNEL_TOKEN: ${TUNNEL_TOKEN}');
  });

  it('não publica a aplicação no IP da VPS e separa cache de modelos', () => {
    const compose = fs.readFileSync(path.join(process.cwd(), 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('127.0.0.1:${KASSINAO_HOST_PORT:-8080}:8080');
    expect(compose).toContain("PORT: '8080'");
    expect(compose).toContain("WEB_BIND_ADDRESS: '0.0.0.0'");
    expect(compose).toContain('XDG_CACHE_HOME: /home/node/.cache');
    expect(compose).toContain('KASSINAO_MODEL_CACHE_DIR:-./cache}:/home/node/.cache:rw');
    expect(compose).not.toContain('XDG_CACHE_HOME: /app/recordings/.cache');
  });

  it('limita a API antes de interpretar JSON anônimo', () => {
    const api = fs.readFileSync(path.join(process.cwd(), 'src/web/api.ts'), 'utf8');
    expect(api.indexOf('api.use(preBodyApiRateGate)')).toBeGreaterThan(-1);
    expect(api.indexOf('api.use(preBodyApiRateGate)')).toBeLessThan(
      api.indexOf("api.use(express.json({ limit: '32kb' }))"),
    );
  });
});
