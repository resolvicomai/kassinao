import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { McpScopeError, normalizeMcpSessionOptions, scopeAllowsRecording } from '../src/web/mcpScope';
import {
  claimExchangeCode,
  createExchangeCode,
  createSession,
  getMcpSessionOptions,
  isActiveSession,
  listUserSessions,
  mcpSessionAllowsContent,
  recordMcpSessionRead,
  revokeUser,
  rotateSession,
} from '../src/web/mcpTokens';

afterEach(() => vi.restoreAllMocks());

describe('escopo das conexões MCP', () => {
  it('distingue escopo legado, todas as guilds autorizadas e seleção vazia', () => {
    const meta = { guildId: 'g1', voiceChannelId: 'v1', startedAt: 100 };
    expect(scopeAllowsRecording(undefined, meta)).toBe(true);
    expect(scopeAllowsRecording({ content: ['minutes'] }, meta)).toBe(true);
    expect(scopeAllowsRecording({ content: ['minutes'], guildIds: [] }, meta)).toBe(false);
    expect(scopeAllowsRecording({ content: ['minutes'], guildIds: ['g2'] }, meta)).toBe(false);
    expect(scopeAllowsRecording({ content: ['minutes'], channelIds: ['v2'] }, meta)).toBe(false);
    expect(scopeAllowsRecording({ content: ['minutes'], fromMs: 100, toMs: 101 }, meta)).toBe(true);
    expect(scopeAllowsRecording({ content: ['minutes'], toMs: 100 }, meta)).toBe(false);
  });

  it.each([
    { scope: {} },
    { scope: { content: [] } },
    { scope: { content: ['audio'] } },
    { scope: { content: ['minutes'], guildIds: 'g1' } },
    { scope: { content: ['minutes'], channelIds: [null] } },
    { scope: { content: ['minutes'], fromMs: 200, toMs: 100 } },
    { scope: { content: ['minutes'], fromMs: NaN } },
    { scope: { content: ['minutes'], unexpected: true } },
    { absoluteExpiresAt: 0 },
    { unexpected: true },
    null,
  ])('recusa política malformada sem transformá-la em escopo amplo: %j', (value) => {
    expect(() => normalizeMcpSessionOptions(value)).toThrow(McpScopeError);
  });

  it('preserva a seleção durante exchange e protege o registro de mutações do chamador', () => {
    const user = crypto.randomUUID();
    const options = { scope: { guildIds: ['g1'], channelIds: ['v1'], content: ['minutes'] as const } };
    const code = createExchangeCode(user, 'Pessoa', 'Ata', { scope: { ...options.scope, content: ['minutes'] } });
    const claim = claimExchangeCode(code)!;
    expect(claim.scope).toEqual(options.scope);
    const session = createSession(user, claim.name, claim.label, { scope: claim.scope });
    try {
      claim.scope!.guildIds!.push('g2');
      const policy = getMcpSessionOptions(session.sid, user)!;
      expect(policy.scope?.guildIds).toEqual(['g1']);
      policy.scope!.content.push('transcript');
      expect(mcpSessionAllowsContent(session.sid, user, 'transcript')).toBe(false);
      expect(mcpSessionAllowsContent(session.sid, 'outro', 'minutes')).toBe(false);
      const listed = listUserSessions(user);
      listed[0].scope!.guildIds!.push('g3');
      expect(getMcpSessionOptions(session.sid, user)?.scope?.guildIds).toEqual(['g1']);
    } finally {
      revokeUser(user);
    }
  });

  it('separa refresh de consulta e respeita expiração absoluta em qualquer rotação', () => {
    const user = crypto.randomUUID();
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const expiresAt = now + 300_000;
    const session = createSession(user, 'Pessoa', undefined, {
      scope: { content: ['minutes'] },
      absoluteExpiresAt: expiresAt,
    });
    expect(session.exp).toBe(expiresAt);
    expect(listUserSessions(user)[0].lastReadAt).toBeUndefined();
    now += 60_000;
    expect(rotateSession(session.sid, 0)).toMatchObject({ ok: true, exp: expiresAt });
    expect(listUserSessions(user)[0]).toMatchObject({ lastSeenAt: now, absoluteExpiresAt: expiresAt });
    expect(listUserSessions(user)[0].lastReadAt).toBeUndefined();
    recordMcpSessionRead(session.sid, user);
    expect(listUserSessions(user)[0].lastReadAt).toBe(now);
    now = expiresAt;
    expect(isActiveSession(session.sid)).toBe(false);
    expect(rotateSession(session.sid, 1)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('mantém o refresh deslizante dos conectores legados', () => {
    const user = crypto.randomUUID();
    const now = Date.now();
    const session = createSession(user, 'Legado');
    vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);
    try {
      expect(rotateSession(session.sid, 0)).toMatchObject({
        ok: true,
        exp: now + 60_000 + config.mcpRefreshTtlDays * 86400000,
      });
      expect(mcpSessionAllowsContent(session.sid, user, 'transcript')).toBe(true);
      expect(listUserSessions(user)[0].scope).toBeUndefined();
    } finally {
      revokeUser(user);
    }
  });

  it('restaura escopo e saúde do arquivo após reiniciar o módulo', async () => {
    const user = crypto.randomUUID();
    const session = createSession(user, 'Persistido', undefined, { scope: { guildIds: ['g1'], content: ['minutes'] } });
    recordMcpSessionRead(session.sid, user);
    vi.resetModules();
    const restored = await import('../src/web/mcpTokens');
    try {
      expect(restored.getMcpSessionOptions(session.sid, user)?.scope).toEqual({
        guildIds: ['g1'],
        content: ['minutes'],
      });
      expect(restored.listUserSessions(user)[0].lastReadAt).toEqual(expect.any(Number));
      expect(restored.mcpSessionAllowsContent(session.sid, user, 'transcript')).toBe(false);
      const file = path.join(config.authStateDir, 'mcp-sessions.json');
      const persisted = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<{ sid: string; scope?: unknown }>;
      persisted.find((item) => item.sid === session.sid)!.scope = { content: ['audio'] };
      fs.writeFileSync(file, JSON.stringify(persisted));
      vi.resetModules();
      const invalid = await import('../src/web/mcpTokens');
      expect(invalid.isActiveSession(session.sid)).toBe(false);
      expect(invalid.mcpSessionAllowsContent(session.sid, user, 'transcript')).toBe(false);
    } finally {
      restored.revokeUser(user);
    }
  });
});
