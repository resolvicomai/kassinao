import type { RecordingSession } from './RecordingSession';

export interface StartReservation {
  readonly guildId: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly signal: AbortSignal;
}

export interface StartingInfo<T> {
  readonly channelId: string;
  readonly channelName: string;
  readonly session?: T;
  readonly cancelRequested: boolean;
}

export type BeginStopResult = 'claimed' | 'already-stopping' | 'not-active';

interface StartingEntry<T> {
  reservation: StartReservation;
  controller: AbortController;
  session?: T;
}

/**
 * Estado atômico do ciclo por servidor. Uma guild pode estar em exatamente um
 * destes estados: iniciando, gravando ou encerrando.
 *
 * A classe é genérica para que as corridas possam ser testadas sem Discord.
 */
export class SessionRegistry<T> {
  private readonly active = new Map<string, T>();
  private readonly starting = new Map<string, StartingEntry<T>>();
  private readonly stopping = new Map<string, T>();

  reserveStart(guildId: string, channelId: string, channelName: string): StartReservation | undefined {
    if (this.isBusy(guildId)) return undefined;
    const controller = new AbortController();
    const reservation: StartReservation = {
      guildId,
      channelId,
      channelName,
      signal: controller.signal,
    };
    this.starting.set(guildId, { reservation, controller });
    return reservation;
  }

  attachStarting(reservation: StartReservation, session: T): boolean {
    const entry = this.starting.get(reservation.guildId);
    if (!entry || entry.reservation !== reservation || entry.controller.signal.aborted) return false;
    entry.session = session;
    return true;
  }

  commitStart(reservation: StartReservation, session: T): boolean {
    const entry = this.starting.get(reservation.guildId);
    if (!entry || entry.reservation !== reservation || entry.controller.signal.aborted) return false;
    this.starting.delete(reservation.guildId);
    this.active.set(reservation.guildId, session);
    return true;
  }

  releaseStart(reservation: StartReservation): void {
    const entry = this.starting.get(reservation.guildId);
    if (entry?.reservation === reservation) this.starting.delete(reservation.guildId);
  }

  cancelStart(guildId: string): StartingInfo<T> | undefined {
    const entry = this.starting.get(guildId);
    if (!entry) return undefined;
    entry.controller.abort();
    return this.startingInfo(guildId);
  }

  cancelAllStarts(): T[] {
    const sessions: T[] = [];
    for (const entry of this.starting.values()) {
      entry.controller.abort();
      if (entry.session) sessions.push(entry.session);
    }
    return sessions;
  }

  startingInfo(guildId: string): StartingInfo<T> | undefined {
    const entry = this.starting.get(guildId);
    if (!entry) return undefined;
    return {
      channelId: entry.reservation.channelId,
      channelName: entry.reservation.channelName,
      session: entry.session,
      cancelRequested: entry.controller.signal.aborted,
    };
  }

  get(guildId: string): T | undefined {
    return this.active.get(guildId);
  }

  /** Mantido para compatibilidade com rotinas de boot/teste. Prefira commitStart. */
  set(guildId: string, session: T): void {
    this.starting.delete(guildId);
    this.stopping.delete(guildId);
    this.active.set(guildId, session);
  }

  delete(guildId: string, expected?: T): void {
    if (expected !== undefined && this.active.get(guildId) !== expected) return;
    this.active.delete(guildId);
  }

  beginStop(guildId: string, session: T): BeginStopResult {
    if (this.stopping.get(guildId) === session) return 'already-stopping';
    if (this.active.get(guildId) !== session) return 'not-active';
    this.active.delete(guildId);
    this.stopping.set(guildId, session);
    return 'claimed';
  }

  finishStop(guildId: string, session: T): void {
    if (this.stopping.get(guildId) === session) this.stopping.delete(guildId);
  }

  stoppingSession(guildId: string): T | undefined {
    return this.stopping.get(guildId);
  }

  isBusy(guildId: string): boolean {
    return this.active.has(guildId) || this.starting.has(guildId) || this.stopping.has(guildId);
  }

  count(): number {
    return this.active.size;
  }

  all(): T[] {
    return [...this.active.values()];
  }

  allStopping(): T[] {
    return [...this.stopping.values()];
  }
}

/** Uma gravação por servidor, incluindo as fases de início e encerramento. */
export const sessionManager = new SessionRegistry<RecordingSession>();
