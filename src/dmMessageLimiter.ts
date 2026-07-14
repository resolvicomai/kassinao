interface Bucket {
  count: number;
  resetAt: number;
}

export interface DmMessageLimiterOptions {
  maxPerUser: number;
  maxGlobal: number;
  windowMs: number;
  maxTrackedUsers: number;
}

/**
 * Admissão síncrona e fail-closed para DMs. O bucket global fica fora do mapa
 * controlado por usuários, então churn de IDs nunca reinicia a cota global.
 */
export class DmMessageLimiter {
  private readonly users = new Map<string, Bucket>();
  private global: Bucket | undefined;

  constructor(
    private readonly options: DmMessageLimiterOptions,
    private readonly now: () => number = Date.now,
  ) {
    for (const [name, value] of Object.entries(options)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} precisa ser um inteiro positivo`);
    }
  }

  get trackedUsers(): number {
    return this.users.size;
  }

  admit(userId: string): boolean {
    if (!userId || userId.length > 128) return false;
    const now = this.now();
    this.prune(now);

    const user = this.users.get(userId);
    if (user && user.count >= this.options.maxPerUser) return false;
    if (this.global && this.global.count >= this.options.maxGlobal) return false;
    // Não expulsa bucket vivo: expulsão permitiria que churn reiniciasse a cota.
    if (!user && this.users.size >= this.options.maxTrackedUsers) return false;

    if (user) user.count++;
    else this.users.set(userId, { count: 1, resetAt: now + this.options.windowMs });

    if (this.global) this.global.count++;
    else this.global = { count: 1, resetAt: now + this.options.windowMs };
    return true;
  }

  private prune(now: number): void {
    if (this.global && this.global.resetAt <= now) this.global = undefined;
    for (const [userId, bucket] of this.users) {
      if (bucket.resetAt <= now) this.users.delete(userId);
    }
  }
}
