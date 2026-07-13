import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import {
  createSession,
  isActiveSession,
  listUserSessions,
  planSessionCapacity,
  revokeUser,
  revokeUserSession,
  rotateSession,
} from '../src/web/mcpTokens';

describe('gestão individual de sessões MCP', () => {
  it('remove e persiste a remoção ao encontrar uma sessão expirada no uso comum', () => {
    const userId = `u-exp-${crypto.randomUUID()}`;
    const created = createSession(userId, 'Lia');
    const file = path.join(config.recordingsDir, '.mcp-sessions.json');

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
