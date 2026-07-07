import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';

/** Configurações por servidor (persistidas em recordings/guildconfig.json). */
export interface GuildConfig {
  /** Canal de texto onde a ata resumida é postada quando fica pronta (além do chat do canal de voz). */
  minutesChannelId?: string;
  /** Quem configurou por último (auditoria). */
  updatedBy?: string;
}

type ConfigFile = Record<string, GuildConfig>; // guildId -> config

const FILE = () => path.join(config.recordingsDir, 'guildconfig.json');

function load(): ConfigFile {
  try {
    return JSON.parse(fs.readFileSync(FILE(), 'utf8')) as ConfigFile;
  } catch {
    return {};
  }
}

function save(all: ConfigFile): void {
  fs.mkdirSync(config.recordingsDir, { recursive: true });
  const tmp = FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, FILE());
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
