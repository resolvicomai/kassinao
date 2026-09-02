import path from 'node:path';
import { config } from './config';
import { readJsonState, writeJsonStateAtomic } from './stateFile';

/** Configurações por servidor (persistidas no volume de estado operacional). */
export interface GuildConfig {
  /** Canal de texto do aviso genérico de processamento; detalhes ficam nas DMs autorizadas. */
  minutesChannelId?: string;
  /** Quem configurou por último (auditoria). */
  updatedBy?: string;
}

type ConfigFile = Record<string, GuildConfig>; // guildId -> config

const FILE = () => path.join(config.stateDir, 'guildconfig.json');

function validConfigFile(value: unknown): value is ConfigFile {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function load(): ConfigFile {
  return readJsonState<ConfigFile>(FILE(), {}, validConfigFile);
}

function save(all: ConfigFile): void {
  writeJsonStateAtomic(FILE(), all);
}

export const guildConfigStore = {
  get(guildId: string): GuildConfig {
    return load()[guildId] ?? {};
  },
  set(guildId: string, patch: Partial<GuildConfig>): void {
    const all = load();
    all[guildId] = { ...all[guildId], ...patch };
    // chaves com undefined explícito são REMOÇÃO (limpar configuração)
    for (const [k, v] of Object.entries(all[guildId])) {
      if (v === undefined) delete all[guildId][k as keyof GuildConfig];
    }
    save(all);
  },
};
