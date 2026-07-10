export type AskReservation = 'accepted' | 'busy-user' | 'busy-global' | 'rate-attempt-user' | 'rate-attempt-guild';
export type AskCharge = 'accepted' | 'rate-user' | 'rate-guild' | 'rate-global';

export class AskRateLimitError extends Error {
  constructor(readonly admission: Exclude<AskCharge, 'accepted'>) {
    super(admission);
    this.name = 'AskRateLimitError';
  }
}

interface AskLimiterOptions {
  maxConcurrent: number;
  maxAttemptsPerUser: number;
  maxAttemptsPerGuild: number;
  maxPerUser: number;
  maxPerGuild: number;
  maxGlobal: number;
  windowMs: number;
  maxTrackedUsers?: number;
  maxTrackedGuilds?: number;
}

/**
 * Concorrência e custo são fases diferentes: `reserve` é atômico e barato;
 * `charge` só roda imediatamente antes da chamada ao provedor. Assim, data
 * inválida, ACL vazia e consulta sem evidência não queimam a cota global.
 */
export class AskLimiter {
  private readonly active = new Set<string>();
  private readonly userAttempts = new Map<string, number[]>();
  private readonly guildAttempts = new Map<string, number[]>();
  private readonly userHistory = new Map<string, number[]>();
  private readonly guildHistory = new Map<string, number[]>();
  private globalHistory: number[] = [];

  constructor(private readonly options: AskLimiterOptions) {}

  reserve(userId: string, guildId: string, nowMs = Date.now()): AskReservation {
    if (this.active.has(userId)) return 'busy-user';
    if (this.active.size >= this.options.maxConcurrent) return 'busy-global';
    this.prune(nowMs);
    const userAttempts = this.userAttempts.get(userId) ?? [];
    const guildAttempts = this.guildAttempts.get(guildId) ?? [];
    if (!this.userAttempts.has(userId) && this.userAttempts.size >= (this.options.maxTrackedUsers ?? 500))
      return 'rate-attempt-user';
    if (!this.guildAttempts.has(guildId) && this.guildAttempts.size >= (this.options.maxTrackedGuilds ?? 200))
      return 'rate-attempt-guild';
    if (userAttempts.length >= this.options.maxAttemptsPerUser) return 'rate-attempt-user';
    if (guildAttempts.length >= this.options.maxAttemptsPerGuild) return 'rate-attempt-guild';

    this.active.add(userId);
    userAttempts.push(nowMs);
    guildAttempts.push(nowMs);
    this.userAttempts.set(userId, userAttempts);
    this.guildAttempts.set(guildId, guildAttempts);
    return 'accepted';
  }

  charge(userId: string, guildId: string, nowMs = Date.now()): AskCharge {
    this.prune(nowMs);
    const user = this.userHistory.get(userId) ?? [];
    const guild = this.guildHistory.get(guildId) ?? [];
    if (user.length >= this.options.maxPerUser) return 'rate-user';
    if (guild.length >= this.options.maxPerGuild) return 'rate-guild';
    if (this.globalHistory.length >= this.options.maxGlobal) return 'rate-global';

    user.push(nowMs);
    guild.push(nowMs);
    this.userHistory.set(userId, user);
    this.guildHistory.set(guildId, guild);
    this.globalHistory.push(nowMs);
    return 'accepted';
  }

  release(userId: string): void {
    this.active.delete(userId);
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.options.windowMs;
    this.globalHistory = this.globalHistory.filter((timestamp) => timestamp > cutoff);
    this.pruneMap(this.userAttempts, cutoff);
    this.pruneMap(this.guildAttempts, cutoff);
    this.pruneMap(this.userHistory, cutoff);
    this.pruneMap(this.guildHistory, cutoff);
  }

  private pruneMap(history: Map<string, number[]>, cutoff: number): void {
    for (const [key, timestamps] of history) {
      const recent = timestamps.filter((timestamp) => timestamp > cutoff);
      if (recent.length === 0) history.delete(key);
      else history.set(key, recent);
    }
  }
}
