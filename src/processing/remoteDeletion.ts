import path from 'node:path';
import { config } from '../config';
import { operationalWarn } from '../operationalLog';
import { readPrivateFileBounded, writeJsonStateAtomic } from '../stateFile';
import { fetchWithDeadline, parseRetryAfterMs } from './http';

const API = 'https://api.assemblyai.com/v2/transcript/';
const MAX_JOBS = 5_000;
const MAX_ATTEMPTS = 12;
const VALID_ID = /^[a-zA-Z0-9-]{1,160}$/;

interface RemoteJob {
  id: string;
  recordingId: string;
  phase: 'active' | 'pending' | 'attention';
  attempts: number;
  createdAt: number;
  nextAttemptAt: number;
  deleteAccepted?: boolean;
}

export interface RemoteDeletionSummary {
  active: number;
  pending: number;
  needsAttention: number;
}

/** Guarda só referências privadas, nunca áudio, transcrição, token ou corpo remoto. */
export class RemoteDeletionQueue {
  private running = false;

  constructor(
    private readonly file: string,
    private readonly apiKey: () => string,
    private readonly request = fetchWithDeadline,
    private readonly now: () => number = Date.now,
  ) {}

  private load(): RemoteJob[] {
    try {
      const jobs = JSON.parse(readPrivateFileBounded(this.file, 2 * 1024 * 1024)) as RemoteJob[];
      if (
        !Array.isArray(jobs) ||
        jobs.length > MAX_JOBS ||
        jobs.some(
          (job) =>
            !job ||
            typeof job.id !== 'string' ||
            typeof job.recordingId !== 'string' ||
            !VALID_ID.test(job.id) ||
            !VALID_ID.test(job.recordingId) ||
            !['active', 'pending', 'attention'].includes(job.phase) ||
            !Number.isInteger(job.attempts) ||
            job.attempts < 0 ||
            job.attempts > MAX_ATTEMPTS ||
            !Number.isFinite(job.createdAt) ||
            !Number.isFinite(job.nextAttemptAt),
        )
      ) {
        throw new Error('invalid remote deletion state');
      }
      return jobs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      // Não transformar falha de leitura em fila vazia e sobrescrever referências.
      // eslint-disable-next-line preserve-caught-error -- A causa pode ecoar job IDs do JSON privado nos logs.
      throw new Error('remote deletion state unavailable');
    }
  }

  track(id: string, recordingId: string): void {
    if (typeof id !== 'string' || typeof recordingId !== 'string' || !VALID_ID.test(id) || !VALID_ID.test(recordingId))
      throw new Error('invalid remote job reference');
    const jobs = this.load();
    if (jobs.some((job) => job.id === id)) return;
    if (jobs.length >= MAX_JOBS) throw new Error('remote deletion queue capacity reached');
    jobs.push({ id, recordingId, phase: 'active', attempts: 0, createdAt: this.now(), nextAttemptAt: this.now() });
    writeJsonStateAtomic(this.file, jobs);
  }

  ensureCapacity(): void {
    const jobs = this.load();
    if (jobs.length >= MAX_JOBS) throw new Error('remote deletion queue capacity reached');
    writeJsonStateAtomic(this.file, jobs);
  }

  /** Executar uma vez no boot, antes de admitir novas transcrições. */
  recover(): void {
    const jobs = this.load();
    for (const job of jobs) if (job.phase === 'active') job.phase = 'pending';
    if (jobs.length) writeJsonStateAtomic(this.file, jobs);
  }

  async requestDeletion(id: string): Promise<void> {
    const jobs = this.load();
    const job = jobs.find((candidate) => candidate.id === id);
    if (!job) return;
    job.phase = 'pending';
    job.nextAttemptAt = this.now();
    writeJsonStateAtomic(this.file, jobs);
    await this.drain();
  }

  retry(recordingId?: string): number {
    const jobs = this.load();
    let count = 0;
    for (const job of jobs) {
      if (job.phase !== 'attention' || (recordingId && job.recordingId !== recordingId)) continue;
      job.phase = 'pending';
      job.attempts = 0;
      job.nextAttemptAt = this.now();
      count++;
    }
    if (count) writeJsonStateAtomic(this.file, jobs);
    return count;
  }

  summary(recordingId?: string): RemoteDeletionSummary {
    const jobs = this.load().filter((job) => !recordingId || job.recordingId === recordingId);
    return {
      active: jobs.filter((job) => job.phase === 'active').length,
      pending: jobs.filter((job) => job.phase === 'pending').length,
      needsAttention: jobs.filter((job) => job.phase === 'attention').length,
    };
  }

  async drain(): Promise<void> {
    if (this.running || !this.apiKey()) return;
    this.running = true;
    try {
      const due = this.load()
        .filter((job) => job.phase === 'pending' && job.nextAttemptAt <= this.now())
        .slice(0, 4);
      for (const candidate of due) await this.attempt(candidate.id);
    } finally {
      this.running = false;
    }
  }

  private async attempt(id: string): Promise<void> {
    let jobs = this.load();
    const job = jobs.find((candidate) => candidate.id === id);
    if (!job || job.phase !== 'pending') return;
    if (job.attempts >= MAX_ATTEMPTS) {
      job.phase = 'attention';
      writeJsonStateAtomic(this.file, jobs);
      return;
    }
    job.attempts++;
    // O próximo prazo fica persistido antes do HTTP, inclusive se o processo cair.
    job.nextAttemptAt = this.now() + Math.min(24 * 60 * 60_000, 60_000 * 2 ** (job.attempts - 1));
    writeJsonStateAtomic(this.file, jobs);
    let confirmed = false;
    let accepted = job.deleteAccepted === true;
    let retryAfter = 0;
    try {
      const options = { headers: { Authorization: this.apiKey() } };
      const response = await this.request(
        `${API}${id}`,
        { ...options, method: 'DELETE' },
        { timeoutMs: 10_000, maxResponseBytes: 1024 * 1024 },
      );
      retryAfter = parseRetryAfterMs(response.headers, '');
      if (response.ok) {
        accepted = true;
        jobs = this.load();
        const current = jobs.find((candidate) => candidate.id === id);
        if (current) current.deleteAccepted = true;
        writeJsonStateAtomic(this.file, jobs);
      }
      if (accepted && (response.ok || response.status === 404)) {
        const check = await this.request(`${API}${id}`, options, { timeoutMs: 10_000, maxResponseBytes: 1024 * 1024 });
        if (check.status === 404) confirmed = true;
        else if (check.ok) {
          const body = (await check.json()) as { text?: unknown; words?: unknown; status?: unknown };
          confirmed =
            body.text === null && body.words == null && body.status !== 'queued' && body.status !== 'processing';
        }
      }
    } catch {
      // O estado persistido conserva a referência para outra tentativa.
    }
    jobs = this.load();
    const current = jobs.find((candidate) => candidate.id === id);
    if (!current) return;
    if (confirmed) jobs = jobs.filter((candidate) => candidate.id !== id);
    else {
      current.deleteAccepted = accepted;
      if (current.attempts >= MAX_ATTEMPTS) {
        current.phase = 'attention';
        operationalWarn('Exclusão remota AssemblyAI requer atenção; referência preservada no estado privado.');
      } else if (retryAfter > 0) {
        current.nextAttemptAt = Math.max(current.nextAttemptAt, this.now() + Math.min(retryAfter, 24 * 60 * 60_000));
      }
    }
    writeJsonStateAtomic(this.file, jobs);
  }
}

const queue = new RemoteDeletionQueue(
  path.join(config.stateDir, 'remote-deletions.json'),
  () => config.assemblyaiApiKey,
);
export const trackAssemblyAiJob = (jobId: string, recordingId: string): void => queue.track(jobId, recordingId);
export const ensureRemoteDeletionCapacity = (): void => queue.ensureCapacity();
export const requestAssemblyAiDeletion = (jobId: string): Promise<void> => queue.requestDeletion(jobId);
export const getRemoteDeletionSummary = (recordingId?: string): RemoteDeletionSummary => queue.summary(recordingId);
export const retryRemoteDeletions = (recordingId?: string): number => queue.retry(recordingId);

/** Exclusões não usam a lease da guild: remover acesso não impede eliminar a cópia. */
export function startRemoteDeletionRecovery(): () => void {
  queue.recover();
  const tick = () =>
    void queue.drain().catch(() => operationalWarn('Fila de exclusão remota indisponível; estado preservado.'));
  tick();
  const timer = setInterval(tick, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
