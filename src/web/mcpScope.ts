import type { RecordingMeta } from '../store';

export type McpContent = 'minutes' | 'transcript';

export interface McpScope {
  /** Ausente = todas as guilds/canais autorizados; [] = nenhum. */
  guildIds?: string[];
  channelIds?: string[];
  /** Janela de início das reuniões: limite inicial inclusivo, final exclusivo. */
  fromMs?: number;
  toMs?: number;
  /** Transcrição inclui notas manuais/eventos; ata inclui decisões, ações e tópicos. */
  content: McpContent[];
}

export interface McpSessionOptions {
  /** Ausente apenas nos conectores legados ou criados pelo fluxo antigo do operador. */
  scope?: McpScope;
  absoluteExpiresAt?: number;
}

export class McpScopeError extends Error {
  constructor() {
    super('escopo MCP inválido');
    this.name = 'McpScopeError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

/** Valida tanto a seleção web quanto os dados persistidos; nunca amplia um escopo malformado. */
export function normalizeMcpSessionOptions(value: unknown, nowMs = Date.now()): McpSessionOptions {
  if (value === undefined) return {};
  if (!record(value) || Object.keys(value).some((key) => !['scope', 'absoluteExpiresAt'].includes(key)))
    throw new McpScopeError();
  const options: McpSessionOptions = {};
  if (value.absoluteExpiresAt !== undefined) {
    if (!timestamp(value.absoluteExpiresAt) || value.absoluteExpiresAt <= nowMs) throw new McpScopeError();
    options.absoluteExpiresAt = value.absoluteExpiresAt;
  }
  if (value.scope === undefined) return options;
  const scope = value.scope;
  if (
    !record(scope) ||
    Object.keys(scope).some((key) => !['guildIds', 'channelIds', 'fromMs', 'toMs', 'content'].includes(key))
  )
    throw new McpScopeError();
  if (
    !Array.isArray(scope.content) ||
    scope.content.length === 0 ||
    scope.content.length > 2 ||
    scope.content.some((kind) => kind !== 'minutes' && kind !== 'transcript')
  )
    throw new McpScopeError();
  const parsed: McpScope = { content: [...new Set(scope.content)] as McpContent[] };
  for (const key of ['guildIds', 'channelIds'] as const) {
    const ids = scope[key];
    if (ids === undefined) continue;
    if (
      !Array.isArray(ids) ||
      ids.length > 100 ||
      ids.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id))
    )
      throw new McpScopeError();
    parsed[key] = [...new Set(ids)] as string[];
  }
  for (const key of ['fromMs', 'toMs'] as const) {
    if (scope[key] === undefined) continue;
    if (!timestamp(scope[key])) throw new McpScopeError();
    parsed[key] = scope[key];
  }
  if (parsed.fromMs !== undefined && parsed.toMs !== undefined && parsed.fromMs >= parsed.toMs)
    throw new McpScopeError();
  options.scope = parsed;
  return options;
}

export function scopeAllowsRecording(
  scope: McpScope | undefined,
  meta: Pick<RecordingMeta, 'guildId' | 'voiceChannelId' | 'startedAt'>,
): boolean {
  return (
    !scope ||
    ((!scope.guildIds || scope.guildIds.includes(meta.guildId)) &&
      (!scope.channelIds || scope.channelIds.includes(meta.voiceChannelId)) &&
      (scope.fromMs === undefined || meta.startedAt >= scope.fromMs) &&
      (scope.toMs === undefined || meta.startedAt < scope.toMs))
  );
}
