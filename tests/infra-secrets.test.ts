import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('isolamento de segredos entre containers', () => {
  it('não entrega o token do túnel ao processo principal', () => {
    const compose = fs.readFileSync(path.join(process.cwd(), 'docker-compose.yml'), 'utf8');
    const appBlock = /^  kassinao:\n([\s\S]*?)^  cloudflared:/m.exec(compose)?.[1];
    const tunnelBlock = /^  cloudflared:\n([\s\S]*)$/m.exec(compose)?.[1];

    expect(appBlock).toBeDefined();
    expect(appBlock).toContain("TUNNEL_TOKEN: ''");
    expect(appBlock).not.toContain('TUNNEL_TOKEN: ${TUNNEL_TOKEN}');
    expect(tunnelBlock).toContain('TUNNEL_TOKEN: ${TUNNEL_TOKEN}');
  });
});
