export type AskAdmission = 'accepted' | 'busy-user' | 'busy-global' | 'rate-user' | 'rate-global';

interface AskLimiterOptions {
  maxConcurrent: number;
  maxPerUser: number;
  maxGlobal: number;
  windowMs: number;
  maxTrackedUsers?: number;
}

/**
 * Reserva a vaga de forma síncrona, antes do primeiro await do handler. Assim,
 * duas interactions que chegam juntas não atravessam o limite em uma corrida.
 */
export class AskLimiter {
  private readonly active = new Set<string>();
  private readonly userHistory = new Map<string, number[]>();
  private globalHistory: number[] = [];

  constructor(private readonly options: AskLimiterOptions) {}

  acquire(userId: string, nowMs = Date.now()): AskAdmission {
    if (this.active.has(userId)) return 'busy-user';
    if (this.active.size >= this.options.maxConcurrent) return 'busy-global';

    this.prune(nowMs);
    const history = this.userHistory.get(userId) ?? [];
    if (history.length >= this.options.maxPerUser) return 'rate-user';
    if (this.globalHistory.length >= this.options.maxGlobal) return 'rate-global';

    // Sem await entre a checagem e estas mutações: a reserva é atômica no event loop.
    this.active.add(userId);
    history.push(nowMs);
    this.userHistory.set(userId, history);
    this.globalHistory.push(nowMs);
    this.evictOldestUserIfNeeded(userId);
    return 'accepted';
  }

  release(userId: string): void {
    this.active.delete(userId);
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.options.windowMs;
    this.globalHistory = this.globalHistory.filter((timestamp) => timestamp > cutoff);
    for (const [userId, timestamps] of this.userHistory) {
      const recent = timestamps.filter((timestamp) => timestamp > cutoff);
      if (recent.length === 0) this.userHistory.delete(userId);
      else this.userHistory.set(userId, recent);
    }
  }

  private evictOldestUserIfNeeded(currentUserId: string): void {
    const max = this.options.maxTrackedUsers ?? 500;
    if (this.userHistory.size <= max) return;
    let oldestUser: string | undefined;
    let oldestTimestamp = Number.POSITIVE_INFINITY;
    for (const [userId, timestamps] of this.userHistory) {
      if (userId === currentUserId || this.active.has(userId)) continue;
      const latest = timestamps[timestamps.length - 1] ?? 0;
      if (latest < oldestTimestamp) {
        oldestTimestamp = latest;
        oldestUser = userId;
      }
    }
    if (oldestUser) this.userHistory.delete(oldestUser);
  }
}
