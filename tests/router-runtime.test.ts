import { describe, expect, it } from 'vitest';
import { readRouterRuntimeConfiguration } from '../src/routerRuntime';

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    PORT: '8080',
    WEB_BIND_INTERFACE: 'ingress0',
    WEB_HOST_BIND_INTERFACE: 'host0',
    APP_URL: 'https://app.example.test',
    PUBLIC_URL: 'https://example.test',
    DOCS_URL: 'https://docs.example.test',
    MCP_URL: 'https://mcp.example.test',
    KASSINAO_RELEASE_DIGEST: `sha256:${'a'.repeat(64)}`,
    KASSINAO_DEPLOYMENT_FINGERPRINT: 'b'.repeat(32),
  };
}

describe('ambiente isolado do edge router', () => {
  it('aceita apenas a topologia pública e consome o contrato exato do launcher', () => {
    const env = {
      ...validEnvironment(),
      KASSINAO_NO_DUMP_ACTIVE: 'prctl-v1:4321',
      LD_PRELOAD: '/usr/local/lib/libkassinao-no-dump.so',
    };

    expect(readRouterRuntimeConfiguration(env, 4321)).toEqual({
      port: 8080,
      bindInterfaces: ['ingress0', 'host0'],
      origins: {
        app: 'https://app.example.test',
        public: 'https://example.test',
        docs: 'https://docs.example.test',
        mcp: 'https://mcp.example.test',
      },
      releaseDigest: `sha256:${'a'.repeat(64)}`,
      deploymentFingerprint: 'b'.repeat(32),
    });
    expect(env).not.toHaveProperty('KASSINAO_NO_DUMP_ACTIVE');
    expect(env).not.toHaveProperty('LD_PRELOAD');
  });

  it.each([
    ['DISCORD_TOKEN', 'discord-secret-value'],
    ['COOKIE_SECRET', 'cookie-secret-value'],
    ['DATABASE_URL', 'postgres://private.example.test/db'],
    ['LD_AUDIT', ''],
  ])('recusa %s sem expor o valor', (name, value) => {
    const env = { ...validEnvironment(), [name]: value };
    expect(() => readRouterRuntimeConfiguration(env)).toThrow(name);
    try {
      readRouterRuntimeConfiguration(env);
    } catch (error) {
      expect((error as Error).message).not.toContain(value || 'private.example.test');
    }
  });

  it('recusa marcador parcial ou divergente do launcher', () => {
    expect(() =>
      readRouterRuntimeConfiguration({ ...validEnvironment(), KASSINAO_NO_DUMP_ACTIVE: 'prctl-v1:1234' }, 1234),
    ).toThrow('proteção no-dump');
    expect(() =>
      readRouterRuntimeConfiguration(
        {
          ...validEnvironment(),
          KASSINAO_NO_DUMP_ACTIVE: 'prctl-v1:1234',
          LD_PRELOAD: '/tmp/other.so',
        },
        1234,
      ),
    ).toThrow('proteção no-dump');
  });

  it('recusa execução fora do modo production', () => {
    expect(() => readRouterRuntimeConfiguration({ ...validEnvironment(), NODE_ENV: 'development' })).toThrow(
      'NODE_ENV precisa ser production no router',
    );
  });

  it.each([
    ['PORT', '0'],
    ['PORT', '65536'],
    ['PORT', '8e3'],
    ['WEB_BIND_INTERFACE', 'interface-name-too-long'],
    ['WEB_HOST_BIND_INTERFACE', 'interface-name-too-long'],
    ['APP_URL', 'http://app.example.test'],
    ['PUBLIC_URL', 'https://example.test/path'],
    ['DOCS_URL', 'https://user:pass@docs.example.test'],
    ['MCP_URL', 'https://mcp.example.test/?secret=value'],
    ['KASSINAO_RELEASE_DIGEST', `sha512:${'a'.repeat(64)}`],
    ['KASSINAO_DEPLOYMENT_FINGERPRINT', 'short'],
  ])('recusa configuração inválida em %s', (name, value) => {
    expect(() => readRouterRuntimeConfiguration({ ...validEnvironment(), [name]: value })).toThrow(name);
  });

  it('recusa reutilizar a mesma interface para túnel e publish do host', () => {
    expect(() =>
      readRouterRuntimeConfiguration({ ...validEnvironment(), WEB_HOST_BIND_INTERFACE: 'ingress0' }),
    ).toThrow('precisam ser distintas');
  });

  it('aceita HTTP somente em origem loopback explícita', () => {
    const env = {
      ...validEnvironment(),
      APP_URL: 'http://localhost:8080',
      PUBLIC_URL: 'http://localhost:8080',
      DOCS_URL: 'http://localhost:8080',
      MCP_URL: 'http://localhost:8080',
    };
    expect(readRouterRuntimeConfiguration(env).origins).toEqual({
      app: 'http://localhost:8080',
      public: 'http://localhost:8080',
      docs: 'http://localhost:8080',
      mcp: 'http://localhost:8080',
    });
  });
});
