import { describe, expect, it } from 'vitest';
import { buildTranscribeCommandEnvironment } from '../src/processing/transcribe';

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
