import path from 'node:path';
import { config } from '../config';
import { readJsonState, writeJsonStateAtomic } from '../stateFile';

/**
 * Colisão de auto-record: uma sala com regra encheu enquanto o bot gravava em
 * outra. O Discord permite UMA conexão de voz por servidor por bot, então a
 * segunda reunião fica sem gravação até a primeira terminar.
 *
 * Este módulo faz duas coisas, separadas de propósito do I/O do Discord para
 * serem testáveis:
 *
 * 1. Episódios (em memória): garante UM aviso por colisão, não um por evento de
 *    voz. O episódio abre quando a sala cheia encontra o bot ocupado e fecha
 *    quando ela esvazia abaixo do mínimo ou quando a gravação enfim começa ali.
 * 2. Contagem (persistida): registra cada colisão para o operador decidir com
 *    número, e não com impressão, se vale investir num segundo bot.
 */

export interface CollisionRecord {
  at: number;
  guildId: string;
  channelId: string;
  /** Canal que segurava o bot; null quando a sessão ainda estava iniciando. */
  busyChannelId: string | null;
}

const FILE = () => path.join(config.stateDir, 'autorecord-collisions.json');
const MAX_RECORDS = 500;
const KEEP_MS = 90 * 24 * 60 * 60 * 1000;
const WINDOW_30D_MS = 30 * 24 * 60 * 60 * 1000;

function validRecord(value: unknown): value is CollisionRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<CollisionRecord>;
  return (
    typeof r.at === 'number' &&
    Number.isFinite(r.at) &&
    typeof r.guildId === 'string' &&
    typeof r.channelId === 'string' &&
    (r.busyChannelId === null || typeof r.busyChannelId === 'string')
  );
}

function load(): CollisionRecord[] {
  // primeiro uso: lista vazia; arquivo corrompido: quarentena com log, estatística recomeça
  const parsed = readJsonState<unknown>(FILE(), []);
  return Array.isArray(parsed) ? parsed.filter(validRecord) : [];
}

function save(records: CollisionRecord[]): void {
  writeJsonStateAtomic(FILE(), records);
}

/** Registra uma colisão e devolve o total do servidor nos últimos 30 dias (incluindo esta). */
export function recordCollision(
  guildId: string,
  channelId: string,
  busyChannelId: string | null,
  now = Date.now(),
): { total30d: number } {
  const records = load()
    .filter((r) => now - r.at < KEEP_MS)
    .slice(-(MAX_RECORDS - 1));
  records.push({ at: now, guildId, channelId, busyChannelId });
  save(records);
  return { total30d: records.filter((r) => r.guildId === guildId && now - r.at < WINDOW_30D_MS).length };
}

export function collisionsLast30d(guildId: string, now = Date.now()): number {
  return load().filter((r) => r.guildId === guildId && now - r.at < WINDOW_30D_MS).length;
}

// ---------- episódios ----------

const episodes = new Map<string, number>(); // `${guildId}:${channelId}` -> quando abriu

/** Abre um episódio; `true` = é novo e o aviso deve ser enviado agora. */
export function beginCollisionEpisode(guildId: string, channelId: string, now = Date.now()): boolean {
  const key = `${guildId}:${channelId}`;
  if (episodes.has(key)) return false;
  episodes.set(key, now);
  return true;
}

/** Quando o episódio em aberto começou; `undefined` se não há episódio. */
export function collisionEpisodeStart(guildId: string, channelId: string): number | undefined {
  return episodes.get(`${guildId}:${channelId}`);
}

export function endCollisionEpisode(guildId: string, channelId: string): void {
  episodes.delete(`${guildId}:${channelId}`);
}

/** Só para testes: zera o estado em memória. */
export function resetCollisionEpisodes(): void {
  episodes.clear();
}
