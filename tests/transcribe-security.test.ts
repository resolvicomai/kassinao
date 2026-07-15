import { describe, expect, it } from 'vitest';
import { buildTranscribeCommandEnvironment, parseTranscribeCommandTemplate } from '../src/processing/transcribe';

describe('ambiente do transcritor local', () => {
  it('não herda segredos do processo principal', () => {
    const env = buildTranscribeCommandEnvironment(
      {
        PATH: '/usr/bin',
        HOME: '/home/node',
        XDG_CACHE_HOME: '/home/node/.cache',
        LD_PRELOAD: '/usr/local/lib/libkassinao-no-dump.so',
        KASSINAO_NO_DUMP_ACTIVE: 'prctl-v1:123',
        DISCORD_TOKEN: 'discord-secret',
        MCP_SECRET: 'mcp-secret',
        COOKIE_SECRET: 'cookie-secret',
        GROQ_API_KEY: 'provider-secret',
        CUDA_VISIBLE_DEVICES: '0',
      },
      [],
    );
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/node',
      XDG_CACHE_HOME: '/home/node/.cache',
      LD_PRELOAD: '/usr/local/lib/libkassinao-no-dump.so',
    });
  });

  it('não propaga preload arbitrário nem a attestation do PID pai', () => {
    const env = buildTranscribeCommandEnvironment(
      {
        PATH: '/usr/bin',
        LD_PRELOAD: '/tmp/attacker.so',
        KASSINAO_NO_DUMP_ACTIVE: 'prctl-v1:123',
      },
      [],
    );
    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('entrega somente extras autorizados pelo operador', () => {
    const env = buildTranscribeCommandEnvironment(
      { PATH: '/usr/bin', CUDA_VISIBLE_DEVICES: '0', OMP_NUM_THREADS: '4', DISCORD_TOKEN: 'secret' },
      ['CUDA_VISIBLE_DEVICES', 'OMP_NUM_THREADS'],
    );
    expect(env).toEqual({ PATH: '/usr/bin', CUDA_VISIBLE_DEVICES: '0', OMP_NUM_THREADS: '4' });
  });

  it('não deixa a allowlist do operador reintroduzir credenciais do processo principal', () => {
    const env = buildTranscribeCommandEnvironment(
      {
        PATH: '/usr/bin',
        DISCORD_TOKEN: 'discord-secret',
        DISCORD_CLIENT_SECRET: 'oauth-secret',
        GROQ_API_KEY: 'provider-secret',
        MCP_SECRET: 'mcp-secret',
        COOKIE_SECRET: 'cookie-secret',
        TUNNEL_TOKEN: 'tunnel-secret',
        AWS_SECRET_ACCESS_KEY: 'storage-secret',
        CUSTOM_KEY: 'custom-secret',
        AUTH_HEADER: 'auth-secret',
        SESSION_COOKIE: 'cookie-secret',
      },
      [
        'DISCORD_TOKEN',
        'DISCORD_CLIENT_SECRET',
        'GROQ_API_KEY',
        'MCP_SECRET',
        'COOKIE_SECRET',
        'TUNNEL_TOKEN',
        'AWS_SECRET_ACCESS_KEY',
        'CUSTOM_KEY',
        'AUTH_HEADER',
        'SESSION_COOKIE',
      ],
    );
    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('não aceita variáveis que injetam código ou alteram loaders e runtimes', () => {
    const names = [
      'LD_AUDIT',
      'DYLD_INSERT_LIBRARIES',
      'NODE_OPTIONS',
      'BASH_ENV',
      'PYTHONPATH',
      'PYTHONSTARTUP',
      'RUBYOPT',
      'PERL5OPT',
      'JAVA_TOOL_OPTIONS',
      'GCONV_PATH',
      'GLIBC_TUNABLES',
      'MALLOC_CHECK_',
      'OPENSSL_CONF',
      'OPENSSL_CONF_INCLUDE',
      'OPENSSL_MODULES',
      'OPENSSL_ENGINES',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
      'SSLKEYLOGFILE',
      'REQUESTS_CA_BUNDLE',
      'CURL_CA_BUNDLE',
      'CURL_HOME',
      'WGETRC',
      'NETRC',
      'INVALID-NAME',
    ];
    const source = Object.fromEntries(names.map((name) => [name, '/tmp/operator-controlled']));

    expect(buildTranscribeCommandEnvironment({ PATH: '/usr/bin', ...source }, names)).toEqual({
      PATH: '/usr/bin',
    });
  });
});

describe('template do transcritor local', () => {
  it('preserva argumentos entre aspas sem entregar o comando a um shell', () => {
    expect(
      parseTranscribeCommandTemplate('python3 "./scripts/meu transcritor.py" --model small {input} {output}'),
    ).toEqual({
      executable: 'python3',
      args: ['./scripts/meu transcritor.py', '--model', 'small', '{input}', '{output}'],
    });
  });

  it.each([
    'python3 worker.py {input} {output}; curl attacker.example',
    'python3 worker.py {input} {output} | tee leaked.json',
    'python3 worker.py $HOME {input} {output}',
    'python3 worker-*.py {input} {output}',
    'python3 "worker.py {input} {output}',
    'python3 worker.py --input={input} {output}',
    'python3 worker.py {input} {input} {output}',
    'CUDA_VISIBLE_DEVICES=0 python3 worker.py {input} {output}',
  ])('rejeita sintaxe ambígua ou executável pelo shell: %s', (template) => {
    expect(() => parseTranscribeCommandTemplate(template)).toThrow();
  });
});
