import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';

export interface AutoRecordRule {
  channelId: string;
  /** Nº mínimo de pessoas (não-bot) no canal para disparar a gravação. */
  minimum: number;
  createdBy: string;
}

type RulesFile = Record<string, AutoRecordRule[]>; // guildId -> regras

const FILE = () => path.join(config.recordingsDir, 'autorecord.json');

function load(): RulesFile {
  try {
    return JSON.parse(fs.readFileSync(FILE(), 'utf8')) as RulesFile;
  } catch {
    return {};
  }
}

function save(rules: RulesFile): void {
  fs.mkdirSync(config.recordingsDir, { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(rules, null, 2));
}

export const autoRecordStore = {
  list(guildId: string): AutoRecordRule[] {
    return load()[guildId] ?? [];
  },
  get(guildId: string, channelId: string): AutoRecordRule | undefined {
    return this.list(guildId).find((r) => r.channelId === channelId);
  },
  set(guildId: string, rule: AutoRecordRule): void {
    const all = load();
    const rules = (all[guildId] ?? []).filter((r) => r.channelId !== rule.channelId);
    rules.push(rule);
    all[guildId] = rules;
    save(all);
  },
  remove(guildId: string, channelId: string): boolean {
    const all = load();
    const before = all[guildId]?.length ?? 0;
    all[guildId] = (all[guildId] ?? []).filter((r) => r.channelId !== channelId);
    save(all);
    armed.delete(`${guildId}:${channelId}`); // não deixa entrada órfã no Map
    return (all[guildId]?.length ?? 0) < before;
  },
};

/**
 * "Armado" = pronto para disparar. Uma regra desarma ao disparar e só
 * rearma quando a população do canal cai abaixo do mínimo — assim um
 * /parar manual com a sala ainda cheia não religa a gravação na hora.
 */
const armed = new Map<string, boolean>(); // `${guildId}:${channelId}`

export function isArmed(guildId: string, channelId: string): boolean {
  return armed.get(`${guildId}:${channelId}`) ?? true;
}

export function setArmed(guildId: string, channelId: string, value: boolean): void {
  armed.set(`${guildId}:${channelId}`, value);
}
