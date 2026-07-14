import { describe, expect, it } from 'vitest';
import { isOpaqueCursorToken, OpaqueCursorError, openOpaqueCursor, sealOpaqueCursor } from '../src/web/opaqueCursor';

const SECRET = 'test-secret-with-enough-entropy';
const OPTIONS = {
  secret: SECRET,
  purpose: 'web-library',
  subject: 'user-123',
  context: 'default-library',
  nowMs: 1_720_000_000_000,
};

describe('cursor opaco autenticado', () => {
  it('faz round-trip sem revelar o payload no token nem no Base64 decodificado', () => {
    const value = { startedAt: 1_719_999_999_000, id: '2026-07-09-private-call' };
    const token = sealOpaqueCursor(value, OPTIONS);
    const decoded = Buffer.from(token, 'base64url').toString('utf8');

    expect(isOpaqueCursorToken(token)).toBe(true);
    expect(token).not.toContain(value.id);
    expect(decoded).not.toContain(value.id);
    expect(openOpaqueCursor<typeof value>(token, OPTIONS)).toEqual(value);
  });

  it.each([
    ['outro usuário', { ...OPTIONS, subject: 'user-456' }],
    ['outro contexto', { ...OPTIONS, context: 'q=segredo' }],
    ['outra finalidade', { ...OPTIONS, purpose: 'mcp-scan' }],
    ['outro segredo', { ...OPTIONS, secret: 'another-secret' }],
  ])('recusa reutilização com %s', (_label, changed) => {
    const token = sealOpaqueCursor({ id: 'private' }, OPTIONS);
    expect(() => openOpaqueCursor(token, changed)).toThrow(OpaqueCursorError);
  });

  it('recusa token expirado, adulterado e codificação não canônica', () => {
    const token = sealOpaqueCursor({ id: 'private' }, { ...OPTIONS, ttlMs: 1_000 });
    const replacement = token.endsWith('A') ? 'B' : 'A';

    expect(() => openOpaqueCursor(token, { ...OPTIONS, nowMs: OPTIONS.nowMs + 1_001 })).toThrow(OpaqueCursorError);
    expect(() => openOpaqueCursor(`${token.slice(0, -1)}${replacement}`, OPTIONS)).toThrow(OpaqueCursorError);
    expect(isOpaqueCursorToken('%%%')).toBe(false);
    expect(() => openOpaqueCursor('%%%', OPTIONS)).toThrow(OpaqueCursorError);
  });
});
