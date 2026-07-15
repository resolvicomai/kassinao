import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSafeChildEnvironment } from '../src/processing/childEnvironment';

describe('ambiente dos subprocessos de mídia', () => {
  it('preserva somente runtime não secreto e o preload oficial', () => {
    const environment = buildSafeChildEnvironment({
      PATH: '/usr/bin',
      LANG: 'pt_BR.UTF-8',
      TZ: 'America/Sao_Paulo',
      LD_PRELOAD: '/usr/local/lib/libkassinao-no-dump.so',
      KASSINAO_NO_DUMP_ACTIVE: 'prctl-v1:111',
      DISCORD_TOKEN: 'discord-secret',
      DISCORD_CLIENT_SECRET: 'oauth-secret',
      GROQ_API_KEY: 'provider-secret',
      MCP_SECRET: 'mcp-secret',
      COOKIE_SECRET: 'cookie-secret',
    });

    expect(environment).toEqual({
      PATH: '/usr/bin',
      LANG: 'pt_BR.UTF-8',
      TZ: 'America/Sao_Paulo',
      LD_PRELOAD: '/usr/local/lib/libkassinao-no-dump.so',
    });
  });

  it('usa o ambiente mínimo em ambos os spawns de ffmpeg/nice', () => {
    const source = readFileSync(path.join(process.cwd(), 'src', 'processing', 'ffmpeg.ts'), 'utf8');
    expect(source.match(/env: buildSafeChildEnvironment\(process\.env\)/g)).toHaveLength(2);
  });
});
