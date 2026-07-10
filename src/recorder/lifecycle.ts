import type { StopReason } from './RecordingSession';

export interface ManualStartAccess {
  canView: boolean;
  isPresent: boolean;
  canManageGuild: boolean;
}

/** Membro comum só grava a sala onde está; admin pode operar remotamente. */
export function canManuallyStartRecording(access: ManualStartAccess): boolean {
  return access.canView && (access.isPresent || access.canManageGuild);
}

/** Extrai a sessão de controles no formato `prefixo:id`; IDs antigos ficam inválidos. */
export function controlSessionId(customId: string, prefix: string): string | undefined {
  const parts = customId.split(':');
  return parts.length === 2 && parts[0] === prefix && parts[1] ? parts[1] : undefined;
}

/** Só o corte técnico por duração recomeça sozinho; kick/movimento pode ser moderação. */
export function shouldRearmAutoRecord(eligible: boolean, reason: StopReason): boolean {
  return eligible && reason === 'tempo-maximo';
}

/** Set de deduplicação com descarte do item mais antigo, sem janelas de `clear()` total. */
export class BoundedIdSet {
  private readonly ids = new Set<string>();

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  }

  addOnce(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    while (this.ids.size > this.limit) {
      const oldest = this.ids.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.ids.delete(oldest);
    }
    return true;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  get size(): number {
    return this.ids.size;
  }
}

/** Anti-duplo-clique para o marcador de um toque, isolado por sessão e pessoa. */
export class MarkClickDeduper {
  private readonly last = new Map<string, number>();

  constructor(private readonly windowMs = 1500) {}

  accept(sessionId: string, userId: string, now = Date.now()): boolean {
    const key = `${sessionId}:${userId}`;
    const previous = this.last.get(key);
    if (previous !== undefined && now - previous < this.windowMs) return false;
    this.last.set(key, now);
    if (this.last.size > 1000) {
      const cutoff = now - this.windowMs;
      for (const [candidate, at] of this.last) if (at < cutoff) this.last.delete(candidate);
      while (this.last.size > 1000) {
        const oldest = this.last.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.last.delete(oldest);
      }
    }
    return true;
  }
}
