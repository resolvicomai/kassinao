import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * O processo público (landing, docs, demo) é desenhado para não carregar nada
 * privado: nem discord.js, nem a pilha de voz, nem o client do bot. Este teste
 * carrega src/web/publicServer.ts num processo Node real (tsx) e falha se
 * qualquer módulo do Discord entrar no require.cache. Foi assim que page.ts
 * puxava discord.js inteiro só para formatar uma duração.
 */
describe('fronteira do processo público', () => {
  it('publicServer não carrega discord.js, @discordjs/voice nem src/discord/client', () => {
    const probe = `
      require(${JSON.stringify(path.resolve(__dirname, '../src/web/publicServer.ts'))});
      const loaded = Object.keys(require.cache);
      const leaks = loaded.filter((file) =>
        /node_modules[\\\\/](discord\\.js|@discordjs[\\\\/](voice|ws|rest)|@snazzah[\\\\/]davey|prism-media)[\\\\/]/.test(file) ||
        /[\\\\/]src[\\\\/](discord[\\\\/]client|recorder[\\\\/]RecordingSession|monitor)\\.ts$/.test(file),
      );
      process.stdout.write(JSON.stringify(leaks));
    `;
    const tsx = path.resolve(__dirname, '../node_modules/.bin/tsx');
    const result = spawnSync(tsx, ['-e', probe], { encoding: 'utf8', env: process.env, timeout: 60_000 });
    expect(result.status, result.stderr).toBe(0);
    const leaks = JSON.parse(result.stdout || '[]') as string[];
    expect(leaks).toEqual([]);
  }, 90_000);
});
