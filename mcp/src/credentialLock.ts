import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

interface LockOwner {
  v: 1;
  pid: number;
  nonce: string;
  createdAt: number;
  processIdentity?: string;
}

interface LockState {
  stats: fs.Stats;
  owner?: LockOwner;
}

export interface CredentialLockOptions {
  waitMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  orphanGraceMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  isProcessAlive?: (pid: number) => boolean;
  processIdentity?: (pid: number) => string | undefined;
  nonce?: () => string;
}

export class CredentialStoreBusyError extends Error {
  readonly code = 'ELOCKED';

  constructor() {
    super('The MCP credential store is busy in another process. Try again in a moment.');
    this.name = 'CredentialStoreBusyError';
  }
}

function unsafeLock(message: string): Error {
  return new Error(`Unsafe MCP credential lock: ${message}`);
}

function assertOwned(stats: fs.Stats, label: string): void {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return;
  if (stats.uid !== process.getuid()) throw unsafeLock(`${label} is not owned by the current user.`);
}

function prepareDirectory(directory: string): void {
  try {
    const stats = fs.lstatSync(directory);
    if (stats.isSymbolicLink()) throw unsafeLock('the credential directory cannot be a symbolic link.');
    if (!stats.isDirectory()) throw unsafeLock('the credential path is not a directory.');
    assertOwned(stats, 'the credential directory');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}

function validOwner(value: unknown): value is LockOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const owner = value as Partial<LockOwner>;
  return (
    owner.v === 1 &&
    Number.isInteger(owner.pid) &&
    (owner.pid as number) > 0 &&
    typeof owner.nonce === 'string' &&
    owner.nonce.length >= 8 &&
    typeof owner.createdAt === 'number' &&
    Number.isFinite(owner.createdAt) &&
    (owner.processIdentity === undefined ||
      (typeof owner.processIdentity === 'string' && owner.processIdentity.length >= 3))
  );
}

function readOwner(lockDirectory: string): LockState {
  const stats = fs.lstatSync(lockDirectory);
  if (stats.isSymbolicLink()) throw unsafeLock('the lock path cannot be a symbolic link.');
  if (!stats.isDirectory()) throw unsafeLock('the lock path is not a directory.');
  assertOwned(stats, 'the lock directory');

  const ownerFile = path.join(lockDirectory, 'owner.json');
  const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
  let fd: number;
  try {
    fd = fs.openSync(ownerFile, fs.constants.O_RDONLY | noFollow);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { stats };
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw unsafeLock('the lock owner cannot be a symbolic link.');
    throw err;
  }

  try {
    const ownerStats = fs.fstatSync(fd);
    if (!ownerStats.isFile()) throw unsafeLock('the lock owner is not a regular file.');
    assertOwned(ownerStats, 'the lock owner');
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(fd, 'utf8')) as unknown;
    } catch {
      return { stats };
    }
    return validOwner(parsed) ? { stats, owner: parsed } : { stats };
  } finally {
    fs.closeSync(fd);
  }
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

interface ProcessStartRunner {
  (
    file: string,
    args: string[],
    options: {
      encoding: 'utf8';
      timeout: number;
      stdio: ['ignore', 'pipe', 'ignore'];
      env: NodeJS.ProcessEnv;
    },
  ): string;
}

/** Consulta o nascimento de um PID no macOS sem entregar segredos ao `ps`. */
export function macOsProcessIdentity(
  pid: number,
  run: ProcessStartRunner = execFileSync as ProcessStartRunner,
): string | undefined {
  try {
    const started = run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { LC_ALL: 'C' },
    }).trim();
    return started ? `darwin:${started}` : undefined;
  } catch {
    return undefined;
  }
}

/** Identidade estável da encarnação do PID; undefined mantém o comportamento fail-closed. */
function defaultProcessIdentity(pid: number): string | undefined {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      if (close < 0) return undefined;
      const fields = stat
        .slice(close + 1)
        .trim()
        .split(/\s+/);
      const startTicks = fields[19]; // campo 22; o slice começa no campo 3
      return /^\d+$/.test(startTicks ?? '') ? `linux:${startTicks}` : undefined;
    }
    if (process.platform === 'darwin') {
      return macOsProcessIdentity(pid);
    }
  } catch {
    // Não adivinhe: sem identidade confiável, um PID vivo preserva o lock.
  }
  return undefined;
}

function removeQuarantinedLock(directory: string): void {
  const entries = fs.readdirSync(directory);
  if (entries.some((entry) => entry !== 'owner.json')) {
    throw unsafeLock('an abandoned lock contains unexpected files.');
  }
  const ownerFile = path.join(directory, 'owner.json');
  try {
    fs.unlinkSync(ownerFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  fs.rmdirSync(directory);
}

function quarantineLock(lockDirectory: string, observed: fs.Stats, nonce: () => string): boolean {
  const quarantine = `${lockDirectory}.orphan-${process.pid}-${nonce()}`;
  try {
    fs.renameSync(lockDirectory, quarantine);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }

  const moved = fs.lstatSync(quarantine);
  if (moved.dev !== observed.dev || moved.ino !== observed.ino) {
    try {
      fs.renameSync(quarantine, lockDirectory);
    } catch {
      // Outro processo já avançou. Não apagamos uma identidade que não observamos.
    }
    return false;
  }
  removeQuarantinedLock(quarantine);
  return true;
}

function writeOwner(lockDirectory: string, owner: LockOwner): boolean {
  const ownerFile = path.join(lockDirectory, 'owner.json');
  const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
  let fd: number;
  try {
    fd = fs.openSync(ownerFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOENT') return false;
    throw err;
  }
  try {
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, JSON.stringify(owner));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function releaseLock(lockDirectory: string, owner: LockOwner): void {
  let current: LockState;
  try {
    current = readOwner(lockDirectory);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (!current.owner || current.owner.nonce !== owner.nonce) {
    throw unsafeLock('the lock identity changed before release.');
  }

  // Move primeiro, apague depois. Assim uma troca do caminho entre a validação
  // e o unlink não consegue fazer este processo remover a identidade seguinte.
  const releaseDirectory = `${lockDirectory}.release-${process.pid}-${owner.nonce}`;
  try {
    fs.renameSync(lockDirectory, releaseDirectory);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const moved = fs.lstatSync(releaseDirectory);
  if (moved.dev !== current.stats.dev || moved.ino !== current.stats.ino) {
    try {
      fs.renameSync(releaseDirectory, lockDirectory);
    } catch {
      // Não apagamos a identidade diferente, mesmo que outro processo avance.
    }
    throw unsafeLock('the lock identity changed during release.');
  }
  const confirmed = readOwner(releaseDirectory);
  if (
    confirmed.stats.dev !== moved.dev ||
    confirmed.stats.ino !== moved.ino ||
    !confirmed.owner ||
    confirmed.owner.nonce !== owner.nonce
  ) {
    try {
      fs.renameSync(releaseDirectory, lockDirectory);
    } catch {
      // Mantém a identidade desconhecida intacta para inspeção segura.
    }
    throw unsafeLock('the lock owner changed during release.');
  }
  removeQuarantinedLock(releaseDirectory);
}

/**
 * Serializa a rotação do refresh token entre processos que compartilham um
 * profile local. O callback deve reler o cofre depois que o lock for adquirido.
 */
export async function withCredentialStoreLock<T>(
  storeFile: string,
  task: () => Promise<T>,
  options: CredentialLockOptions = {},
): Promise<T> {
  const waitMs = options.waitMs ?? 30_000;
  const retryMinMs = options.retryMinMs ?? 25;
  const retryMaxMs = Math.max(retryMinMs, options.retryMaxMs ?? 150);
  const orphanGraceMs = options.orphanGraceMs ?? 5_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
  const processIdentity = options.processIdentity ?? defaultProcessIdentity;
  const nonce = options.nonce ?? (() => crypto.randomBytes(16).toString('hex'));
  const lockDirectory = `${storeFile}.lock`;
  prepareDirectory(path.dirname(storeFile));
  const startedAt = now();

  while (true) {
    let acquired = false;
    try {
      fs.mkdirSync(lockDirectory, { mode: 0o700 });
      acquired = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    if (acquired) {
      const owner: LockOwner = {
        v: 1,
        pid: process.pid,
        nonce: nonce(),
        createdAt: now(),
        processIdentity: processIdentity(process.pid),
      };
      if (!writeOwner(lockDirectory, owner)) continue;
      const confirmed = readOwner(lockDirectory).owner;
      if (!confirmed || confirmed.nonce !== owner.nonce) {
        throw unsafeLock('the acquired lock could not be verified.');
      }
      try {
        return await task();
      } finally {
        releaseLock(lockDirectory, owner);
      }
    }

    let state: LockState;
    try {
      state = readOwner(lockDirectory);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    const ageMs = Math.max(0, now() - state.stats.mtimeMs);
    const alive = state.owner ? isProcessAlive(state.owner.pid) : false;
    const currentIdentity =
      state.owner?.processIdentity && alive && ageMs >= orphanGraceMs ? processIdentity(state.owner.pid) : undefined;
    const reusedPid = Boolean(
      state.owner?.processIdentity && currentIdentity && state.owner.processIdentity !== currentIdentity,
    );
    const abandoned = state.owner ? !alive || reusedPid : ageMs >= orphanGraceMs;
    if (abandoned && quarantineLock(lockDirectory, state.stats, nonce)) continue;
    if (now() - startedAt >= waitMs) throw new CredentialStoreBusyError();
    const spread = retryMaxMs - retryMinMs;
    const delay = retryMinMs + (spread > 0 ? Math.floor(Math.random() * (spread + 1)) : 0);
    await sleep(delay);
  }
}
