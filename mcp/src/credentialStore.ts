import fs from 'node:fs';
import type { StoredCredentials } from './tokenAuth.js';

function parseCredentials(raw: string): StoredCredentials {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const value = parsed as Record<string, unknown>;
    return {
      url: typeof value.url === 'string' ? value.url : undefined,
      refreshToken: typeof value.refreshToken === 'string' ? value.refreshToken : undefined,
    };
  } catch {
    return {};
  }
}

function unsafeStore(message: string): Error {
  return new Error(`Unsafe MCP token store: ${message}`);
}

function assertOwnedByCurrentUser(stats: fs.Stats, label: string): void {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return;
  if (stats.uid !== process.getuid()) throw unsafeStore(`${label} is not owned by the current user.`);
}

function protectDirectory(directory: string): void {
  try {
    const stats = fs.lstatSync(directory);
    if (stats.isSymbolicLink()) throw unsafeStore('the configuration directory cannot be a symbolic link.');
    if (!stats.isDirectory()) throw unsafeStore('the configuration path is not a directory.');
    assertOwnedByCurrentUser(stats, 'the configuration directory');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}

function openCredentialStore(file: string): number | undefined {
  const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
  try {
    return fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (code === 'ELOOP') throw unsafeStore('token files cannot be symbolic links.');
    throw err;
  }
}

/**
 * Tighten the credential store before reading it. On Unix, refusing symlinks
 * prevents an unexpected path from redirecting the chmod/read operation.
 */
export function loadCredentialStore(directory: string, file: string): StoredCredentials {
  protectDirectory(directory);

  const fd = openCredentialStore(file);
  if (fd === undefined) return {};
  try {
    const openedStats = fs.fstatSync(fd);
    if (!openedStats.isFile()) throw unsafeStore('the token path is not a regular file.');
    assertOwnedByCurrentUser(openedStats, 'the token file');
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
    return parseCredentials(fs.readFileSync(fd, 'utf8'));
  } finally {
    fs.closeSync(fd);
  }
}
