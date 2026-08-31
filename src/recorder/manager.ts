import type { RecordingSession } from './RecordingSession';

export interface StartReservation {
  readonly guildId: string;
  readonly channelId: string;
  readonly channelName: string;
  /** Identidade de voz que fará esta gravação ('default' = bot principal). */
  readonly identityLabel: string;
  readonly signal: AbortSignal;
}

export interface StartingInfo<T> {
  readonly channelId: string;
  readonly channelName: string;
  readonly session?: T;
  readonly cancelRequested: boolean;
}

/** Canal ocupado em qualquer fase — para mensagens de "estou gravando em #X". */
export interface BusyChannel {
  readonly channelId: string;
  readonly channelName: string;
  readonly phase: 'starting' | 'recording' | 'stopping';
}

export type BeginStopResult = 'claimed' | 'already-stopping' | 'not-active';

interface StartingEntry<T> {
  reservation: StartReservation;
  controller: AbortController;
  session?: T;
}

interface SessionEntry<T> {
  session: T;
  guildId: string;
  channelId: string;
  channelName: string;
  identityLabel: string;
}

/**
 * Estado atômico do ciclo de gravação. A chave é guild+CANAL: um mesmo servidor
 * pode ter várias gravações simultâneas, uma por canal, desde que cada uma use
 * uma identidade de voz diferente (um bot user = uma conexão de voz por guild,
 * regra da plataforma). Sem identidades extras configuradas só existe 'default',
 * e por construção vale o comportamento histórico de uma gravação por servidor.
 *
 * A classe é genérica para que as corridas possam ser testadas sem Discord.
 */
export class SessionRegistry<T extends { id?: string }> {
  private readonly active = new Map<string, SessionEntry<T>>();
  private readonly starting = new Map<string, StartingEntry<T>>();
  private readonly stopping = new Map<string, SessionEntry<T>>();

  private key(guildId: string, channelId: string): string {
    return `${guildId}:${channelId}`;
  }

  private guildEntries<E>(map: Map<string, E>, guildId: string): E[] {
    const prefix = `${guildId}:`;
    const found: E[] = [];
    for (const [key, entry] of map) if (key.startsWith(prefix)) found.push(entry);
    return found;
  }

  reserveStart(
    guildId: string,
    channelId: string,
    channelName: string,
    maxBusy = Number.POSITIVE_INFINITY,
    opts: { identityLabel?: string } = {},
  ): StartReservation | undefined {
    const identityLabel = opts.identityLabel ?? 'default';
    // Recusas, na ordem: o canal já tem gravação em alguma fase; a identidade já
    // está em uso neste guild (uma conexão de voz por bot user); teto global.
    if (this.isChannelBusy(guildId, channelId)) return undefined;
    if (this.busyLabels(guildId).has(identityLabel)) return undefined;
    if (this.busyCount() >= maxBusy) return undefined;
    const controller = new AbortController();
    const reservation: StartReservation = {
      guildId,
      channelId,
      channelName,
      identityLabel,
      signal: controller.signal,
    };
    this.starting.set(this.key(guildId, channelId), { reservation, controller });
    return reservation;
  }

  attachStarting(reservation: StartReservation, session: T): boolean {
    const entry = this.starting.get(this.key(reservation.guildId, reservation.channelId));
    if (!entry || entry.reservation !== reservation || entry.controller.signal.aborted) return false;
    entry.session = session;
    return true;
  }

  commitStart(reservation: StartReservation, session: T): boolean {
    const key = this.key(reservation.guildId, reservation.channelId);
    const entry = this.starting.get(key);
    if (!entry || entry.reservation !== reservation || entry.controller.signal.aborted) return false;
    this.starting.delete(key);
    this.active.set(key, {
      session,
      guildId: reservation.guildId,
      channelId: reservation.channelId,
      channelName: reservation.channelName,
      identityLabel: reservation.identityLabel,
    });
    return true;
  }

  releaseStart(reservation: StartReservation): void {
    const key = this.key(reservation.guildId, reservation.channelId);
    const entry = this.starting.get(key);
    if (entry?.reservation === reservation) this.starting.delete(key);
  }

  /** Sem channelId, cancela o único início do guild (compatibilidade N=1). */
  cancelStart(guildId: string, channelId?: string): StartingInfo<T> | undefined {
    const entries =
      channelId !== undefined
        ? [this.starting.get(this.key(guildId, channelId))].filter((e): e is StartingEntry<T> => e !== undefined)
        : this.guildEntries(this.starting, guildId);
    const entry = entries[0];
    if (!entry) return undefined;
    entry.controller.abort();
    return {
      channelId: entry.reservation.channelId,
      channelName: entry.reservation.channelName,
      session: entry.session,
      cancelRequested: entry.controller.signal.aborted,
    };
  }

  cancelAllStarts(): T[] {
    const sessions: T[] = [];
    for (const entry of this.starting.values()) {
      entry.controller.abort();
      if (entry.session) sessions.push(entry.session);
    }
    return sessions;
  }

  /** O primeiro início do guild (compatibilidade N=1). Prefira startingInfos. */
  startingInfo(guildId: string): StartingInfo<T> | undefined {
    return this.startingInfos(guildId)[0];
  }

  startingInfos(guildId: string): StartingInfo<T>[] {
    return this.guildEntries(this.starting, guildId).map((entry) => ({
      channelId: entry.reservation.channelId,
      channelName: entry.reservation.channelName,
      session: entry.session,
      cancelRequested: entry.controller.signal.aborted,
    }));
  }

  /** A primeira sessão ativa do guild (compatibilidade N=1). Prefira getByChannel/listByGuild. */
  get(guildId: string): T | undefined {
    return this.guildEntries(this.active, guildId)[0]?.session;
  }

  getByChannel(guildId: string, channelId: string): T | undefined {
    return this.active.get(this.key(guildId, channelId))?.session;
  }

  /** Busca SÓ entre as ativas — é a barreira "ao vivo" do web (mídia/download). */
  getById(sessionId: string): T | undefined {
    for (const entry of this.active.values()) if (entry.session.id === sessionId) return entry.session;
    return undefined;
  }

  listByGuild(guildId: string): T[] {
    return this.guildEntries(this.active, guildId).map((entry) => entry.session);
  }

  /** Mantido para compatibilidade com rotinas de boot/teste. Prefira commitStart. */
  set(
    guildId: string,
    channelId: string,
    session: T,
    opts: { channelName?: string; identityLabel?: string } = {},
  ): void {
    const key = this.key(guildId, channelId);
    this.starting.delete(key);
    this.stopping.delete(key);
    this.active.set(key, {
      session,
      guildId,
      channelId,
      channelName: opts.channelName ?? '',
      identityLabel: opts.identityLabel ?? 'default',
    });
  }

  delete(guildId: string, expected?: T): void {
    for (const [key, entry] of this.active) {
      if (!key.startsWith(`${guildId}:`)) continue;
      if (expected !== undefined && entry.session !== expected) continue;
      this.active.delete(key);
    }
  }

  beginStop(guildId: string, session: T): BeginStopResult {
    for (const entry of this.guildEntries(this.stopping, guildId)) {
      if (entry.session === session) return 'already-stopping';
    }
    for (const [key, entry] of this.active) {
      if (!key.startsWith(`${guildId}:`) || entry.session !== session) continue;
      this.active.delete(key);
      this.stopping.set(key, entry);
      return 'claimed';
    }
    return 'not-active';
  }

  finishStop(guildId: string, session: T): void {
    for (const [key, entry] of this.stopping) {
      if (key.startsWith(`${guildId}:`) && entry.session === session) this.stopping.delete(key);
    }
  }

  /** A primeira sessão encerrando do guild (compatibilidade N=1). Prefira stoppingSessions. */
  stoppingSession(guildId: string): T | undefined {
    return this.guildEntries(this.stopping, guildId)[0]?.session;
  }

  stoppingSessions(guildId: string): T[] {
    return this.guildEntries(this.stopping, guildId).map((entry) => entry.session);
  }

  isBusy(guildId: string): boolean {
    const prefix = `${guildId}:`;
    for (const key of this.active.keys()) if (key.startsWith(prefix)) return true;
    for (const key of this.starting.keys()) if (key.startsWith(prefix)) return true;
    for (const key of this.stopping.keys()) if (key.startsWith(prefix)) return true;
    return false;
  }

  isChannelBusy(guildId: string, channelId: string): boolean {
    const key = this.key(guildId, channelId);
    return this.active.has(key) || this.starting.has(key) || this.stopping.has(key);
  }

  /** Identidades de voz em uso no guild, em qualquer fase. */
  busyLabels(guildId: string): Set<string> {
    const labels = new Set<string>();
    for (const entry of this.guildEntries(this.starting, guildId)) labels.add(entry.reservation.identityLabel);
    for (const entry of this.guildEntries(this.active, guildId)) labels.add(entry.identityLabel);
    for (const entry of this.guildEntries(this.stopping, guildId)) labels.add(entry.identityLabel);
    return labels;
  }

  /** Canais ocupados no guild, com fase — para "estou gravando em #X". */
  busyChannels(guildId: string): BusyChannel[] {
    const channels: BusyChannel[] = [];
    for (const entry of this.guildEntries(this.starting, guildId)) {
      channels.push({
        channelId: entry.reservation.channelId,
        channelName: entry.reservation.channelName,
        phase: 'starting',
      });
    }
    for (const entry of this.guildEntries(this.active, guildId)) {
      channels.push({ channelId: entry.channelId, channelName: entry.channelName, phase: 'recording' });
    }
    for (const entry of this.guildEntries(this.stopping, guildId)) {
      channels.push({ channelId: entry.channelId, channelName: entry.channelName, phase: 'stopping' });
    }
    return channels;
  }

  count(): number {
    return this.active.size;
  }

  /** Sessões que já consomem capacidade, inclusive durante início e encerramento. */
  busyCount(): number {
    return this.starting.size + this.active.size + this.stopping.size;
  }

  all(): T[] {
    return [...this.active.values()].map((entry) => entry.session);
  }

  allStopping(): T[] {
    return [...this.stopping.values()].map((entry) => entry.session);
  }
}

/** Uma gravação por CANAL; por servidor, uma por identidade de voz disponível. */
export const sessionManager = new SessionRegistry<RecordingSession>();
