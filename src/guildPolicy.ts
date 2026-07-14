const DISCORD_SNOWFLAKE = /^\d{17,20}$/;

export type GuildPolicyMode = 'private' | 'all';

/**
 * A única interface que callers precisam conhecer para decidir se uma guild
 * pertence à instância. Parsing, compatibilidade e invariantes ficam aqui.
 */
export interface GuildPolicy {
  readonly mode: GuildPolicyMode;
  readonly allowedGuildIds: readonly string[];
  allows(guildId: string | null | undefined): boolean;
}

export interface GuildPolicyEnvironment {
  ALLOWED_GUILD_IDS?: string;
  ALLOW_ALL_GUILDS?: string;
  GUILD_ID?: string;
}

function parseStrictBoolean(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${name} aceita somente true ou false`);
}

function parseSnowflake(name: string, raw: string): string {
  const value = raw.trim();
  if (!DISCORD_SNOWFLAKE.test(value)) {
    throw new Error(`${name} contém um ID Discord inválido: ${JSON.stringify(value)}`);
  }
  return value;
}

export function createGuildPolicy(source: GuildPolicyEnvironment): GuildPolicy {
  const allowAll = parseStrictBoolean('ALLOW_ALL_GUILDS', source.ALLOW_ALL_GUILDS, false);
  const configuredIds = (source.ALLOWED_GUILD_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => parseSnowflake('ALLOWED_GUILD_IDS', value));
  const allowedGuildIds = [...new Set(configuredIds)];
  const commandGuildId = source.GUILD_ID?.trim() ? parseSnowflake('GUILD_ID', source.GUILD_ID) : undefined;

  if (allowAll && allowedGuildIds.length > 0) {
    throw new Error('ALLOW_ALL_GUILDS=true não pode ser combinado com ALLOWED_GUILD_IDS');
  }
  if (!allowAll && allowedGuildIds.length === 0) {
    throw new Error('Defina ALLOWED_GUILD_IDS para uma instância privada ou ALLOW_ALL_GUILDS=true deliberadamente');
  }
  if (!allowAll && commandGuildId && !allowedGuildIds.includes(commandGuildId)) {
    throw new Error('GUILD_ID precisa estar incluído em ALLOWED_GUILD_IDS; ele não concede acesso');
  }

  const allowed = new Set(allowedGuildIds);
  return Object.freeze({
    mode: allowAll ? 'all' : 'private',
    allowedGuildIds: Object.freeze(allowedGuildIds),
    allows(guildId: string | null | undefined): boolean {
      return typeof guildId === 'string' && guildId.length > 0 && (allowAll || allowed.has(guildId));
    },
  });
}
