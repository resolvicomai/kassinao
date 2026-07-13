export interface ManualRecordingStartLimits {
  userCooldownMs: number;
  guildCooldownMs: number;
  maxStartsPerGuild24h: number;
}

export type ManualStartAdmission =
  { ok: true } | { ok: false; reason: 'user-cooldown' | 'guild-cooldown' | 'guild-daily-limit'; retryAfterMs: number };

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

  constructor(private readonly limits: ManualRecordingStartLimits) {}

  admit(guildId: string, userId: string, isAdmin: boolean, now = Date.now()): ManualStartAdmission {
    if (isAdmin) return { ok: true };

    const userAt = this.lastUserStart.get(userId);
    if (userAt !== undefined && now - userAt < this.limits.userCooldownMs) {
      return { ok: false, reason: 'user-cooldown', retryAfterMs: this.limits.userCooldownMs - (now - userAt) };
    }

    const guildAt = this.lastGuildStart.get(guildId);
    if (guildAt !== undefined && now - guildAt < this.limits.guildCooldownMs) {
      return { ok: false, reason: 'guild-cooldown', retryAfterMs: this.limits.guildCooldownMs - (now - guildAt) };
    }

    const windowStart = now - 86_400_000;
    const recent = (this.guildStarts.get(guildId) ?? []).filter((at) => at > windowStart);
    if (recent.length >= this.limits.maxStartsPerGuild24h) {
      return { ok: false, reason: 'guild-daily-limit', retryAfterMs: recent[0] + 86_400_000 - now };
    }

    remember(this.lastUserStart, userId, now);
    remember(this.lastGuildStart, guildId, now);
    recent.push(now);
    remember(this.guildStarts, guildId, recent);
    return { ok: true };
  }
}
