import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalRecordingsDir = process.env.RECORDINGS_DIR;
const temporaryDirectories: string[] = [];

afterEach(() => {
  if (originalRecordingsDir === undefined) delete process.env.RECORDINGS_DIR;
  else process.env.RECORDINGS_DIR = originalRecordingsDir;
  vi.resetModules();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('persistência do retry idempotente MCP', () => {
  it('reemite a mesma geração depois de reiniciar o módulo do servidor', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kassinao-mcp-server-restart-'));
    temporaryDirectories.push(root);
    process.env.RECORDINGS_DIR = root;
    vi.resetModules();

    const beforeRestart = await import('../src/web/mcpTokens');
    const userId = `u-restart-${crypto.randomUUID()}`;
    const session = beforeRestart.createSession(userId, 'Lia');
    const attemptId = '0123456789abcdef0123456789abcdef';
    const first = beforeRestart.rotateSession(session.sid, 0, attemptId);
    expect(first).toMatchObject({ ok: true, gen: 1, replayed: false });

    const persisted = JSON.parse(fs.readFileSync(path.join(root, '.mcp-sessions.json'), 'utf8')) as Array<{
      lastRefreshAttempt?: { id: string; fromGen: number; replayUntil: number };
    }>;
    expect(persisted[0]?.lastRefreshAttempt).toMatchObject({ id: attemptId, fromGen: 0 });

    vi.resetModules();
    const afterRestart = await import('../src/web/mcpTokens');
    const retry = afterRestart.rotateSession(session.sid, 0, attemptId);

    expect(retry).toMatchObject({ ok: true, gen: 1, replayed: true });
    expect(afterRestart.isActiveSession(session.sid)).toBe(true);
    afterRestart.revokeUser(userId);
  });
});
