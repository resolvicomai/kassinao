import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalRecordingsDir = process.env.RECORDINGS_DIR;
const originalStateDir = process.env.STATE_DIR;
const originalAuthStateDir = process.env.AUTH_STATE_DIR;
const temporaryDirectories: string[] = [];

afterEach(() => {
  if (originalRecordingsDir === undefined) delete process.env.RECORDINGS_DIR;
  else process.env.RECORDINGS_DIR = originalRecordingsDir;
  if (originalStateDir === undefined) delete process.env.STATE_DIR;
  else process.env.STATE_DIR = originalStateDir;
  if (originalAuthStateDir === undefined) delete process.env.AUTH_STATE_DIR;
  else process.env.AUTH_STATE_DIR = originalAuthStateDir;
  vi.resetModules();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('persistência do retry idempotente MCP', () => {
  it('reemite a mesma geração depois de reiniciar o módulo do servidor', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kassinao-mcp-server-restart-'));
    const recordingsRoot = path.join(root, 'recordings');
    const stateRoot = path.join(root, 'state');
    const authRoot = path.join(root, 'auth');
    for (const directory of [recordingsRoot, stateRoot, authRoot]) fs.mkdirSync(directory, { mode: 0o700 });
    temporaryDirectories.push(root);
    process.env.RECORDINGS_DIR = recordingsRoot;
    process.env.STATE_DIR = stateRoot;
    process.env.AUTH_STATE_DIR = authRoot;
    vi.resetModules();

    const beforeRestart = await import('../src/web/mcpTokens');
    const userId = `u-restart-${crypto.randomUUID()}`;
    const session = beforeRestart.createSession(userId, 'Lia');
    const attemptId = '0123456789abcdef0123456789abcdef';
    const first = beforeRestart.rotateSession(session.sid, 0, attemptId);
    expect(first).toMatchObject({ ok: true, gen: 1, replayed: false });

    const sessionFile = path.join(authRoot, 'mcp-sessions.json');
    const persisted = JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as Array<{
      lastRefreshAttempt?: { id: string; fromGen: number; replayUntil?: number };
    }>;
    expect(persisted[0]?.lastRefreshAttempt).toMatchObject({ id: attemptId, fromGen: 0 });

    // Simula o schema anterior já persistido e um notebook que ficou suspenso
    // além da antiga janela de cinco minutos.
    if (!persisted[0]?.lastRefreshAttempt) throw new Error('tentativa não persistida');
    persisted[0].lastRefreshAttempt.replayUntil = Date.now() - 1;
    fs.writeFileSync(sessionFile, JSON.stringify(persisted), { mode: 0o600 });

    vi.resetModules();
    const afterRestart = await import('../src/web/mcpTokens');
    const retry = afterRestart.rotateSession(session.sid, 0, attemptId);

    expect(retry).toMatchObject({ ok: true, gen: 1, replayed: true });
    expect(afterRestart.isActiveSession(session.sid)).toBe(true);
    const migrated = JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as Array<{
      lastRefreshAttempt?: Record<string, unknown>;
    }>;
    expect(migrated[0]?.lastRefreshAttempt).toEqual({ id: attemptId, fromGen: 0 });
    afterRestart.revokeUser(userId);
  });
});
