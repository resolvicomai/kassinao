import { GuildMember, PermissionFlagsBits } from 'discord.js';
import { client } from '../discord/client';
import { RecordingMeta } from '../store';
import { AccessIdentity } from './auth';

/**
 * Fonte ÚNICA de controle de acesso — usada tanto pela página web quanto pela API
 * do MCP. Não existe variante "só-disco": a regra "enxerga o canal"/ManageGuild
 * exige o gateway do Discord vivo, então o MCP passa exatamente por aqui.
 *
 * Regra:
 *  - iniciou a gravação OU participou (falou) → vê
 *  - enxerga o canal de voz de origem → vê
 *  - tem "Gerenciar Servidor" → vê e apaga
 *  - quem iniciou também apaga
 */

export interface Access {
  view: boolean;
  delete: boolean;
}

interface AccessResult extends Access {
  /**
   * As camadas de SERVIDOR (ManageGuild / enxergar-canal) não puderam ser avaliadas
   * por falha transitória do Discord (cache frio, 429, 5xx, timeout). O caminho web
   * ignora (fica no fail-closed de iniciou/participou); o caminho MCP transforma em
   * 503 quando isso poderia esconder um acesso legítimo.
   */
  serverLayersUnknown: boolean;
}

/** Erro transitório: o chamador (API MCP) deve responder 503 Retry-After, nunca 403. */
export class TransientAccessError extends Error {}

function isUnknownMember(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 10007;
}

// Cache de membership COMPARTILHADO entre requests (não só intra-request): evita
// cascata de members.fetch ao listar N gravações e protege a gravação ao vivo.
// member === null = "confirmado NÃO-membro". Erro transitório não é cacheado.
const MEMBER_TTL_MS = 45_000;
const memberCache = new Map<string, { member: GuildMember | null; at: number }>();

async function fetchMemberCached(guildId: string, userId: string): Promise<GuildMember | null> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new TransientAccessError('guild fora do cache (gateway não pronto?)');
  const key = `${guildId}:${userId}`;
  const hit = memberCache.get(key);
  if (hit && Date.now() - hit.at < MEMBER_TTL_MS) return hit.member;
  try {
    const member = await guild.members.fetch(userId);
    memberCache.set(key, { member, at: Date.now() });
    return member;
  } catch (err) {
    if (isUnknownMember(err)) {
      memberCache.set(key, { member: null, at: Date.now() }); // saiu do servidor
      return null;
    }
    throw new TransientAccessError('members.fetch falhou (transitório)');
  }
}

/** Invalida o cache de um membro (chamado no guildMemberRemove). */
export function forgetMember(guildId: string, userId: string): void {
  memberCache.delete(`${guildId}:${userId}`);
}

async function computeAccess(user: AccessIdentity, meta: RecordingMeta): Promise<AccessResult> {
  // Sem id não há acesso a nada (impede null/undefined "casar" com startedBy null).
  if (!user.id) return { view: false, delete: false, serverLayersUnknown: false };

  const isInitiator = !!meta.startedBy && meta.startedBy.id === user.id;
  const isParticipant = meta.participants.some((p) => p.id === user.id);
  let view = isInitiator || isParticipant;
  let del = isInitiator;

  const guild = client.guilds.cache.get(meta.guildId);
  if (!guild) {
    // não sabemos as camadas de servidor
    return { view, delete: del, serverLayersUnknown: true };
  }

  let member: GuildMember | null;
  try {
    member = await fetchMemberCached(meta.guildId, user.id);
  } catch {
    // transitório: camadas de servidor desconhecidas (participante/iniciador ainda valem)
    return { view, delete: del, serverLayersUnknown: true };
  }
  if (member === null) {
    // não é (mais) membro: camadas de servidor definitivamente NÃO
    return { view, delete: del, serverLayersUnknown: false };
  }

  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    view = true;
    del = true;
  }

  let channelUnknown = false;
  let channel = guild.channels.cache.get(meta.voiceChannelId) ?? null;
  if (!channel) {
    try {
      channel = await guild.channels.fetch(meta.voiceChannelId);
    } catch (err) {
      // canal apagado (10003) = sem grant por canal; transitório = desconhecido
      if (!(err && typeof err === 'object' && (err as { code?: unknown }).code === 10003)) channelUnknown = true;
    }
  }
  if (channel && channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) view = true;

  return { view, delete: del, serverLayersUnknown: channelUnknown && !view };
}

/**
 * Acesso para a PÁGINA WEB: best-effort. Em falha transitória mantém o veredito
 * de iniciou/participou (comportamento histórico; as rotas web já têm readiness-gate).
 */
export async function checkAccess(user: AccessIdentity, meta: RecordingMeta): Promise<Access> {
  const r = await computeAccess(user, meta);
  return { view: r.view, delete: r.delete };
}

/**
 * Acesso para a API do MCP: se as camadas de servidor ficaram desconhecidas E isso
 * poderia esconder um acesso legítimo (ainda sem `view`), LANÇA TransientAccessError
 * → o endpoint responde 503 (o conector faz backoff), nunca um 403 falso ou um
 * grant indevido. Fail-closed de verdade.
 */
export async function checkAccessForMcp(user: AccessIdentity, meta: RecordingMeta): Promise<Access> {
  const r = await computeAccess(user, meta);
  if (r.serverLayersUnknown && !r.view) {
    throw new TransientAccessError('camadas de acesso indisponíveis no momento');
  }
  return { view: r.view, delete: r.delete };
}
