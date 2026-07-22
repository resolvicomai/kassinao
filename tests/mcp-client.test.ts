import { describe, expect, it } from 'vitest';
import {
  mayFallbackToEnvToken,
  normalizeKassinaoUrl,
  selectBootstrapRefreshToken,
  singleFlight,
  tokenStoreFileName,
} from '../mcp/src/tokenAuth';

describe('URL do conector MCP', () => {
  it('normaliza HTTPS/localhost e nunca envia token por HTTP remoto', () => {
    expect(normalizeKassinaoUrl('https://kassinao.example.com/')).toBe('https://kassinao.example.com');
    expect(normalizeKassinaoUrl('http://localhost:8080')).toBe('http://localhost:8080');
    expect(() => normalizeKassinaoUrl('http://kassinao.example.com')).toThrow(/HTTPS/);
    expect(() => normalizeKassinaoUrl('https://user:pass@example.com')).toThrow(/credentials/);
    expect(() => normalizeKassinaoUrl('https://example.com/sub')).toThrow(/path/);
  });
});

describe('bootstrap do token do conector MCP', () => {
  it('reusa o token salvo somente na mesma instância', () => {
    const stored = { url: 'https://a.example', refreshToken: 'saved-a' };
    expect(selectBootstrapRefreshToken(stored, 'https://a.example', 'env-a')).toBe('saved-a');
    expect(selectBootstrapRefreshToken(stored, 'https://b.example', 'env-b')).toBe('env-b');
  });

  it('só tenta o env quando o servidor confirmou 401; preserva sessão em 429/5xx', () => {
    expect(mayFallbackToEnvToken(401)).toBe(true);
    expect(mayFallbackToEnvToken(400)).toBe(false);
    expect(mayFallbackToEnvToken(429)).toBe(false);
    expect(mayFallbackToEnvToken(503)).toBe(false);
  });

  it('store legado sem URL não envia segredo para um host possivelmente diferente', () => {
    expect(selectBootstrapRefreshToken({ refreshToken: 'legacy' }, 'https://new.example', 'fresh')).toBe('fresh');
    expect(selectBootstrapRefreshToken({ refreshToken: 'legacy' }, 'https://new.example', '')).toBe('');
  });

  it('isola conexões diferentes no mesmo computador sem expor o token no nome', () => {
    const a = tokenStoreFileName('https://a.example', 'refresh-A-super-secreto');
    const b = tokenStoreFileName('https://a.example', 'refresh-B-super-secreto');
    expect(a).toMatch(/^token-[a-f0-9]{24}\.json$/);
    expect(a).not.toContain('refresh-A');
    expect(a).not.toBe(b);
    expect(tokenStoreFileName('https://a.example', 'refresh-A-super-secreto')).toBe(a);
    expect(tokenStoreFileName('https://a.example', '')).toBe('token.json');
  });
});

describe('refresh single-flight do conector MCP', () => {
  it('compartilha uma rotação concorrente e libera a próxima depois de concluir', async () => {
    let calls = 0;
    const refresh = singleFlight(async () => {
      calls++;
      await Promise.resolve();
    });

    const a = refresh();
    const b = refresh();
    expect(a).toBe(b);
    await Promise.all([a, b]);
    expect(calls).toBe(1);

    await refresh();
    expect(calls).toBe(2);
  });

  it('não fica travado numa Promise rejeitada', async () => {
    let calls = 0;
    const refresh = singleFlight(async () => {
      calls++;
      if (calls === 1) throw new Error('falha transitória');
    });
    await expect(refresh()).rejects.toThrow('falha transitória');
    await expect(refresh()).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});
