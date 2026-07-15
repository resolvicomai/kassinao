import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import {
  claimExchangeCode,
  commitExchangeCode,
  consumeExchangeCode,
  consumeStagedExchangeCode,
  createExchangeCode,
  createSession,
  isActiveSession,
  listUserSessions,
  planSessionCapacity,
  releaseExchangeCode,
  revokeUser,
  revokeUserSession,
  rotateSession,
  stageExchangeCodeForDisplay,
} from '../src/web/mcpTokens';

describe('gestão individual de sessões MCP', () => {
  it('reserva o código uma vez e o libera apenas em falha transitória', () => {
    const code = createExchangeCode(`u-claim-${crypto.randomUUID()}`, 'Lia');
    const first = claimExchangeCode(code);
    expect(first).toBeDefined();
    expect(claimExchangeCode(code)).toBeUndefined();
    expect(first && releaseExchangeCode(first)).toBe(true);

    const retry = claimExchangeCode(code);
    expect(retry).toBeDefined();
    expect(retry && commitExchangeCode(retry)).toBe(true);
    expect(consumeExchangeCode(code)).toBeUndefined();
  });

  it('remove e persiste a remoção ao encontrar uma sessão expirada no uso comum', () => {
    const userId = `u-exp-${crypto.randomUUID()}`;
    const created = createSession(userId, 'Lia');
    const file = path.join(config.authStateDir, 'mcp-sessions.json');

    vi.useFakeTimers();
    try {
      vi.setSystemTime(created.exp + 1);
      expect(isActiveSession(created.sid)).toBe(false);
      const persisted = JSON.parse(fs.readFileSync(file, 'utf8')) as { sid: string }[];
      expect(persisted.some((session) => session.sid === created.sid)).toBe(false);
    } finally {
      vi.useRealTimers();
      revokeUser(userId);
    }
  });

  it('recusa um novo usuário no teto global sem revogar sessões de terceiros', () => {
    const existing = [
      { sid: 'a-old', userId: 'a', createdAt: 1 },
      { sid: 'a-new', userId: 'a', createdAt: 2 },
      { sid: 'b', userId: 'b', createdAt: 3 },
    ];

    expect(planSessionCapacity(existing, 'c', { perUser: 2, total: 3 })).toEqual({
      canCreate: false,
      evictSids: [],
    });
    expect(planSessionCapacity(existing, 'a', { perUser: 2, total: 3 })).toEqual({
      canCreate: true,
      evictSids: ['a-old'],
    });
  });

  it('mantém no máximo dez sessões ativas por usuário', () => {
    const userId = `u-cap-${crypto.randomUUID()}`;
    const created = Array.from({ length: 11 }, (_, index) => createSession(userId, 'Lia', `dispositivo ${index}`));

    expect(listUserSessions(userId)).toHaveLength(10);
    expect(isActiveSession(created[0].sid)).toBe(false);
    expect(isActiveSession(created[10].sid)).toBe(true);
    revokeUser(userId);
  });

  it('lista apelido/último uso e só revoga sessão do próprio usuário', () => {
    const userId = `u-list-${crypto.randomUUID()}`;
    const otherId = `u-other-${crypto.randomUUID()}`;
    const own = createSession(userId, 'Lia', 'notebook');
    const other = createSession(otherId, 'Outra', 'celular');
    const rotated = rotateSession(own.sid, 0);
    expect(rotated.ok).toBe(true);

    const listed = listUserSessions(userId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ sid: own.sid, label: 'notebook' });
    expect(listed[0].lastSeenAt).toEqual(expect.any(Number));
    expect(revokeUserSession(userId, other.sid)).toBe(false);
    expect(isActiveSession(other.sid)).toBe(true);
    expect(revokeUserSession(userId, own.sid)).toBe(true);
    revokeUser(otherId);
  });
});

describe('exibição PRG do código de conexão MCP', () => {
  it('mantém o código no servidor, isolado por usuário, e o exibe uma única vez', () => {
    const owner = `u-display-${crypto.randomUUID()}`;
    const other = `u-display-other-${crypto.randomUUID()}`;
    const exchangeCode = createExchangeCode(owner, 'Lia', 'Notebook');
    stageExchangeCodeForDisplay(owner, exchangeCode, 'Notebook');

    expect(consumeStagedExchangeCode(other)).toBeUndefined();
    expect(consumeStagedExchangeCode(owner)).toEqual({
      exchangeCode,
      label: 'Notebook',
    });
    expect(consumeStagedExchangeCode(owner)).toBeUndefined();
    expect(consumeExchangeCode(exchangeCode)).toEqual({ userId: owner, name: 'Lia', label: 'Notebook' });
  });

  it('não exibe um código depois de expirar', () => {
    const owner = `u-display-exp-${crypto.randomUUID()}`;
    vi.useFakeTimers();
    try {
      const now = Date.now();
      stageExchangeCodeForDisplay(owner, 'codigo-expirado', undefined, now);
      vi.setSystemTime(now + 5 * 60 * 1000 + 1);
      expect(consumeStagedExchangeCode(owner)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
