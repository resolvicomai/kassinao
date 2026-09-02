import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Rede de segurança do refactor de src/index.ts: cada módulo extraído precisa
 * poder ser importado sem disparar o boot do bot (mkdir, validação com
 * process.exit, servidor web, login no Discord). Aqui cada módulo é carregado
 * num processo Node real e o teste falha se src/index.ts entrar no require.cache
 * ou se o processo tentar sair. A lista cresce um módulo por PR do refactor.
 */
const MODULES = ['src/discord/capabilities.ts', 'src/discord/commands.ts', 'src/discord/minutesEmbed.ts'];

describe('módulos extraídos do index não disparam o boot ao serem importados', () => {
  it.each(MODULES)(
    '%s',
    (relative) => {
      const file = path.resolve(__dirname, '..', relative);
      const probe = `
      const exits = [];
      process.exit = (code) => { exits.push(code); throw new Error('process.exit chamado'); };
      require(${JSON.stringify(file)});
      const loaded = Object.keys(require.cache).filter((f) => /[\\/]src[\\/]index[.]ts$/.test(f));
      process.stdout.write(JSON.stringify({ exits, loaded }));
    `;
      const tsx = path.resolve(__dirname, '../node_modules/.bin/tsx');
      const result = spawnSync(tsx, ['-e', probe], { encoding: 'utf8', env: process.env, timeout: 60_000 });
      expect(result.status, result.stderr).toBe(0);
      const outcome = JSON.parse(result.stdout || '{}') as { exits: number[]; loaded: string[] };
      expect(outcome.exits).toEqual([]);
      expect(outcome.loaded).toEqual([]);
    },
    90_000,
  );
});
