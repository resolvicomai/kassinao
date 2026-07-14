import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type RecordingOrigin = 'manual' | 'auto';

export interface RecordingAdmissionLimits {
  maxStartsPerGuild24h: number;
  maxStartsGlobalPerHour: number;
  maxStartsGlobal24h: number;
  maxPendingProcessing: number;
}

export interface PendingRecordingWork {
  guildId: string;
  startedAt: number;
}

export type RecordingAdmissionDenial =
  'guild-daily-limit' | 'global-hourly-limit' | 'global-daily-limit' | 'processing-capacity' | 'storage-unavailable';

export type RecordingAdmissionResult =
  | { ok: true; reservation: RecordingAdmissionReservation }
  | { ok: false; reason: RecordingAdmissionDenial; retryAfterMs?: number };

interface AdmissionEntry {
  reservationId: string;
  guildId: string;
  origin: RecordingOrigin;
  createdAt: number;
  status: 'reserved' | 'started';
  startedAt?: number;
  recordingId?: string;
  processingPending: boolean;
}

interface AdmissionState {
  version: 1;
  entries: AdmissionEntry[];
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_STATE_ENTRIES = 10_000;

function validId(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function parseState(raw: string): AdmissionState {
  const candidate = JSON.parse(raw) as Partial<AdmissionState>;
  if (candidate.version !== 1 || !Array.isArray(candidate.entries) || candidate.entries.length > MAX_STATE_ENTRIES) {
    throw new Error('estado de admissão inválido');
  }
  const reservations = new Set<string>();
  const recordings = new Set<string>();
  for (const entry of candidate.entries as AdmissionEntry[]) {
    if (
      !entry ||
      !validId(entry.reservationId, 128) ||
      reservations.has(entry.reservationId) ||
      !validId(entry.guildId, 128) ||
      (entry.origin !== 'manual' && entry.origin !== 'auto') ||
      !Number.isFinite(entry.createdAt) ||
      (entry.status !== 'reserved' && entry.status !== 'started') ||
      typeof entry.processingPending !== 'boolean' ||
      (entry.startedAt !== undefined && !Number.isFinite(entry.startedAt)) ||
      (entry.recordingId !== undefined && !validId(entry.recordingId, 256)) ||
      (entry.status === 'started' && (entry.startedAt === undefined || entry.recordingId === undefined))
    ) {
      throw new Error('entrada de admissão inválida');
    }
    if (entry.recordingId && recordings.has(entry.recordingId)) throw new Error('gravação duplicada na admissão');
    reservations.add(entry.reservationId);
    if (entry.recordingId) recordings.add(entry.recordingId);
  }
  return { version: 1, entries: candidate.entries as AdmissionEntry[] };
}

function cloneState(state: AdmissionState): AdmissionState {
  return { version: 1, entries: state.entries.map((entry) => ({ ...entry })) };
}

function retryAfter(entries: AdmissionEntry[], now: number, windowMs: number): number {
  const first = Math.min(...entries.map((entry) => entry.startedAt ?? entry.createdAt));
  return Math.max(1, first + windowMs - now);
}

export class RecordingAdmissionReservation {
  constructor(
    private readonly guard: RecordingAdmissionGuard,
    readonly id: string,
  ) {}

  bindRecording(recordingId: string): boolean {
    return this.guard.bind(this.id, recordingId);
  }

  commit(now = Date.now()): boolean {
    return this.guard.commit(this.id, now);
  }

  rollback(): boolean {
    return this.guard.rollback(this.id);
  }
}

/**
 * Cotas e vagas do pipeline persistidas antes de qualquer captura de áudio.
 * Erro/corrupção do arquivo fecha a admissão, sem tentar "se recuperar" zerando cotas.
 */
export class RecordingAdmissionGuard {
  private state: AdmissionState = { version: 1, entries: [] };
  private storageHealthy = true;

  constructor(
    private readonly file: string,
    private readonly limits: RecordingAdmissionLimits,
  ) {
    try {
      this.validateLimits();
      this.state = this.load();
    } catch (err) {
      this.storageHealthy = false;
      console.error(`Proteção de admissão de gravações indisponível: ${(err as Error).message}`);
    }
  }

  reserve(guildId: string, origin: RecordingOrigin, now = Date.now()): RecordingAdmissionResult {
    if (!this.storageHealthy || !validId(guildId, 128) || !Number.isFinite(now)) {
      return { ok: false, reason: 'storage-unavailable' };
    }
    const candidate = cloneState(this.state);
    this.pruneCompletedHistory(candidate, now);
    const dayStart = now - DAY_MS;
    const hourStart = now - HOUR_MS;
    const inDay = candidate.entries.filter((entry) => (entry.startedAt ?? entry.createdAt) > dayStart);
    const inGuildDay = inDay.filter((entry) => entry.guildId === guildId);
    if (inGuildDay.length >= this.limits.maxStartsPerGuild24h) {
      return {
        ok: false,
        reason: 'guild-daily-limit',
        retryAfterMs: retryAfter(inGuildDay, now, DAY_MS),
      };
    }
    const inHour = inDay.filter((entry) => (entry.startedAt ?? entry.createdAt) > hourStart);
    if (inHour.length >= this.limits.maxStartsGlobalPerHour) {
      return {
        ok: false,
        reason: 'global-hourly-limit',
        retryAfterMs: retryAfter(inHour, now, HOUR_MS),
      };
    }
    if (inDay.length >= this.limits.maxStartsGlobal24h) {
      return {
        ok: false,
        reason: 'global-daily-limit',
        retryAfterMs: retryAfter(inDay, now, DAY_MS),
      };
    }
    if (candidate.entries.filter((entry) => entry.processingPending).length >= this.limits.maxPendingProcessing) {
      return { ok: false, reason: 'processing-capacity' };
    }

    const reservationId = crypto.randomUUID();
    candidate.entries.push({
      reservationId,
      guildId,
      origin,
      createdAt: now,
      status: 'reserved',
      processingPending: true,
    });
    if (!this.replaceState(candidate)) return { ok: false, reason: 'storage-unavailable' };
    return { ok: true, reservation: new RecordingAdmissionReservation(this, reservationId) };
  }

  complete(recordingId: string): boolean {
    if (!validId(recordingId, 256)) return false;
    return this.mutate((candidate) => {
      const entry = candidate.entries.find((item) => item.recordingId === recordingId);
      if (!entry) return false;
      entry.processingPending = false;
      return true;
    });
  }

  /** Recupera reservas após crash e libera apenas trabalhos comprovadamente terminais. */
  reconcile(
    pendingRecordings: ReadonlySet<string> | ReadonlyMap<string, PendingRecordingWork>,
    now = Date.now(),
  ): boolean {
    if (!this.storageHealthy || !Number.isFinite(now)) return false;
    const pendingRecordingIds =
      pendingRecordings instanceof Map ? new Set(pendingRecordings.keys()) : pendingRecordings;
    const candidate = cloneState(this.state);
    candidate.entries = candidate.entries.flatMap((entry) => {
      if (entry.status === 'reserved') {
        if (!entry.recordingId || !pendingRecordingIds.has(entry.recordingId)) return [];
        return [{ ...entry, status: 'started' as const, startedAt: entry.createdAt, processingPending: true }];
      }
      if (entry.recordingId && !pendingRecordingIds.has(entry.recordingId)) entry.processingPending = false;
      return [entry];
    });
    if (pendingRecordings instanceof Map) {
      const known = new Set(candidate.entries.flatMap((entry) => (entry.recordingId ? [entry.recordingId] : [])));
      for (const [recordingId, work] of pendingRecordings) {
        if (
          known.has(recordingId) ||
          !validId(recordingId, 256) ||
          !validId(work.guildId, 128) ||
          !Number.isFinite(work.startedAt)
        ) {
          continue;
        }
        candidate.entries.push({
          reservationId: crypto.randomUUID(),
          guildId: work.guildId,
          origin: 'manual',
          createdAt: work.startedAt,
          status: 'started',
          startedAt: work.startedAt,
          recordingId,
          processingPending: true,
        });
      }
    }
    this.pruneCompletedHistory(candidate, now);
    return this.replaceState(candidate);
  }

  pendingProcessingCount(): number {
    return this.state.entries.filter((entry) => entry.processingPending).length;
  }

  isHealthy(): boolean {
    return this.storageHealthy;
  }

  bind(reservationId: string, recordingId: string): boolean {
    if (!validId(recordingId, 256)) return false;
    return this.mutate((candidate) => {
      if (
        candidate.entries.some((entry) => entry.recordingId === recordingId && entry.reservationId !== reservationId)
      ) {
        return false;
      }
      const entry = candidate.entries.find((item) => item.reservationId === reservationId);
      if (!entry || entry.status !== 'reserved') return false;
      if (entry.recordingId && entry.recordingId !== recordingId) return false;
      entry.recordingId = recordingId;
      return true;
    });
  }

  commit(reservationId: string, now: number): boolean {
    if (!Number.isFinite(now)) return false;
    return this.mutate((candidate) => {
      const entry = candidate.entries.find((item) => item.reservationId === reservationId);
      if (!entry || !entry.recordingId) return false;
      if (entry.status === 'started') return true;
      entry.status = 'started';
      entry.startedAt = now;
      return true;
    });
  }

  rollback(reservationId: string): boolean {
    return this.mutate((candidate) => {
      const index = candidate.entries.findIndex((item) => item.reservationId === reservationId);
      if (index < 0 || candidate.entries[index].status !== 'reserved') return false;
      candidate.entries.splice(index, 1);
      return true;
    });
  }

  private mutate(change: (candidate: AdmissionState) => boolean): boolean {
    if (!this.storageHealthy) return false;
    const candidate = cloneState(this.state);
    if (!change(candidate)) return false;
    return this.replaceState(candidate);
  }

  private replaceState(candidate: AdmissionState): boolean {
    try {
      this.persist(candidate);
      this.state = candidate;
      return true;
    } catch (err) {
      this.storageHealthy = false;
      console.error(`Falha persistindo proteção de admissão: ${(err as Error).message}`);
      return false;
    }
  }

  private pruneCompletedHistory(state: AdmissionState, now: number): void {
    const dayStart = now - DAY_MS;
    state.entries = state.entries.filter((entry) => {
      if (entry.status === 'reserved' || entry.processingPending) return true;
      return (entry.startedAt ?? entry.createdAt) > dayStart;
    });
  }

  private validateLimits(): void {
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isInteger(value) || value < 1) throw new Error(`${name} precisa ser inteiro positivo`);
    }
  }

  private load(): AdmissionState {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(this.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, entries: [] };
      throw err;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('arquivo de estado não é regular');
    if (stat.size > MAX_STATE_BYTES) throw new Error('arquivo de estado excede o limite');
    if (process.platform !== 'win32') fs.chmodSync(this.file, 0o600);
    return parseState(fs.readFileSync(this.file, 'utf8'));
  }

  private persist(state: AdmissionState): void {
    const directory = path.dirname(this.file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
    try {
      const existing = fs.lstatSync(this.file);
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('arquivo de estado não é regular');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const payload = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(payload) > MAX_STATE_BYTES) throw new Error('estado de admissão excede o limite');
    const temporary = path.join(directory, `.${path.basename(this.file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, payload, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, this.file);
      if (process.platform !== 'win32') fs.chmodSync(this.file, 0o600);
      const directoryFd = fs.openSync(directory, 'r');
      try {
        fs.fsyncSync(directoryFd);
      } finally {
        fs.closeSync(directoryFd);
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temporary, { force: true });
    }
  }
}
