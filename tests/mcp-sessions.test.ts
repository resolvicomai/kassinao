import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createSession,
  isActiveSession,
  listUserSessions,
  revokeUser,
  revokeUserSession,
  rotateSession,
} from '../src/web/mcpTokens';

describe('gestão individual de sessões MCP', () => {
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
