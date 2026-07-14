import type { GuildPolicy } from '../guildPolicy';

/**
 * Estado efêmero do perímetro de guild. A allowlist decide quem PODE usar esta
 * instância; o gateway decide onde o bot está operacional neste momento.
 *
 * `GuildUnavailable` não é remoção definitiva: apenas pausa efeitos externos
 * até `GuildAvailable`. `GuildDelete` usa a mesma pausa, e `GuildCreate` libera
 * novamente quando a guild continua autorizada.
 */
export class GuildRuntimeBoundary {
  private readonly unavailableGuildIds = new Set<string>();

  constructor(
    private readonly policy: GuildPolicy,
    private readonly isConnected: (guildId: string) => boolean,
  ) {}

  allows(guildId: string | null | undefined): boolean {
    return this.policy.allows(guildId);
  }

  isOperational(guildId: string | null | undefined): boolean {
    return (
      this.policy.allows(guildId) &&
      typeof guildId === 'string' &&
      !this.unavailableGuildIds.has(guildId) &&
      this.isConnected(guildId)
    );
  }

  markUnavailable(guildId: string): void {
    this.unavailableGuildIds.add(guildId);
  }

  markAvailable(guildId: string): void {
    if (this.policy.allows(guildId)) this.unavailableGuildIds.delete(guildId);
  }

  commandTargets(cachedGuildIds: Iterable<string>, configuredGuildId?: string): string[] {
    const cached = [...cachedGuildIds];
    if (configuredGuildId) {
      return this.policy.allows(configuredGuildId) && cached.includes(configuredGuildId) ? [configuredGuildId] : [];
    }
    return cached.filter((guildId) => this.policy.allows(guildId));
  }
}
