export interface ManualRecordingStartLimits {
  userCooldownMs: number;
  guildCooldownMs: number;
  maxStartsPerGuild24h: number;
}

export type ManualStartReservation =
  | { ok: true; commit(): void; rollback(): void }
  | { ok: false; reason: 'user-cooldown' | 'guild-cooldown' | 'guild-daily-limit'; retryAfterMs: number };

const MAX_TRACKED_IDENTITIES = 5_000;

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_TRACKED_IDENTITIES) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export class ManualRecordingStartLimiter {
  private readonly lastUserStart = new Map<string, number>();
  private readonly lastGuildStart = new Map<string, number>();
  private readonly guildStarts = new Map<string, number[]>();
  private readonly pending = new Map<number, { guildId: string; userId: string; at: number }>();
  private nextReservationId = 1;

  constructor(private readonly limits: ManualRecordingStartLimits) {}

  reserve(guildId: string, userId: string, isAdmin: boolean, now = Date.now()): ManualStartReservation {
    const windowStart = now - 86_400_000;
    const recent = [
      ...(this.guildStarts.get(guildId) ?? []).filter((at) => at > windowStart),
      ...[...this.pending.values()]
        .filter((entry) => entry.guildId === guildId && entry.at > windowStart)
        .map((entry) => entry.at),
    ].sort((a, b) => a - b);
    if (isAdmin && recent.length >= this.limits.maxStartsPerGuild24h) {
      return { ok: false, reason: 'guild-daily-limit', retryAfterMs: recent[0] + 86_400_000 - now };
    }

    if (!isAdmin) {
      const userAt = this.latestStart(this.lastUserStart.get(userId), ({ userId: pendingUserId }) => {
        return pendingUserId === userId;
      });
      if (userAt !== undefined && now - userAt < this.limits.userCooldownMs) {
        return { ok: false, reason: 'user-cooldown', retryAfterMs: this.limits.userCooldownMs - (now - userAt) };
      }

      const guildAt = this.latestStart(this.lastGuildStart.get(guildId), ({ guildId: pendingGuildId }) => {
        return pendingGuildId === guildId;
      });
      if (guildAt !== undefined && now - guildAt < this.limits.guildCooldownMs) {
        return { ok: false, reason: 'guild-cooldown', retryAfterMs: this.limits.guildCooldownMs - (now - guildAt) };
      }
    }
    if (recent.length >= this.limits.maxStartsPerGuild24h) {
      return { ok: false, reason: 'guild-daily-limit', retryAfterMs: recent[0] + 86_400_000 - now };
    }

    const reservationId = this.nextReservationId++;
    this.pending.set(reservationId, { guildId, userId, at: now });
    let settled = false;
    return {
      ok: true,
      commit: () => {
        if (settled) return;
        settled = true;
        if (!this.pending.delete(reservationId)) return;
        this.commitStart(guildId, userId, now);
      },
      rollback: () => {
        if (settled) return;
        settled = true;
        this.pending.delete(reservationId);
      },
    };
  }

  private latestStart(
    committed: number | undefined,
    matches: (entry: { guildId: string; userId: string; at: number }) => boolean,
  ): number | undefined {
    let latest = committed;
    for (const entry of this.pending.values()) {
      if (matches(entry) && (latest === undefined || entry.at > latest)) latest = entry.at;
    }
    return latest;
  }

  private commitStart(guildId: string, userId: string, at: number): void {
    if ((this.lastUserStart.get(userId) ?? -Infinity) <= at) remember(this.lastUserStart, userId, at);
    if ((this.lastGuildStart.get(guildId) ?? -Infinity) <= at) remember(this.lastGuildStart, guildId, at);
    const windowStart = at - 86_400_000;
    const recent = (this.guildStarts.get(guildId) ?? []).filter((startedAt) => startedAt > windowStart);
    recent.push(at);
    recent.sort((a, b) => a - b);
    remember(this.guildStarts, guildId, recent);
  }
}
