import { GuildMember, PermissionFlagsBits } from 'discord.js';
import { client } from '../discord/client';
import { RecordingMeta } from '../store';
import { AccessIdentity } from './auth';

/**
 * Fonte ÚNICA de controle de acesso — usada tanto pela página web quanto pela API
 * do MCP. Não existe variante "só-disco": a regra "enxerga o canal"/ManageGuild
 * exige o gateway do Discord vivo, então o MCP passa exatamente por aqui.
 *
 * Regra (sempre depois de confirmar membership ATUAL no servidor):
 *  - iniciou a gravação OU esteve na call (falando ou mutado) → vê
 *  - tem "Gerenciar Servidor" AGORA → vê e apaga
 *  - quem iniciou também apaga
 *  - se o canal era público para @everyone no INÍCIO da gravação, quem ainda
 *    enxerga o canal pode ver; canal privado nunca libera o histórico para quem
 *    ganhou permissão só depois da call
 */

export interface Access {
  view: boolean;
  delete: boolean;
}

interface AccessResult extends Access {
  /**
   * Membership/camadas de servidor não puderam ser avaliadas por falha transitória
   * do Discord (cache frio, 429, 5xx, timeout). O caminho web nega por segurança;
   * o MCP transforma em 503 para o cliente tentar novamente.
   */
  serverLayersUnknown: boolean;
}

/** Erro transitório: o chamador (API MCP) deve responder 503 Retry-After, nunca 403. */
export class TransientAccessError extends Error {}

// "Definitivamente não é membro daqui" (nega camadas de servidor, sem 503):
//  10007 Unknown Member (saiu do servidor) • 10013 Unknown User (id inexistente).
// Só erro TRANSITÓRIO (429/5xx/timeout/rede) vira 503 retriável.
function isUnknownMember(err: unknown): boolean {
  const code = !!err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  return code === 10007 || code === 10013;
}

// Cache de membership COMPARTILHADO entre requests (não só intra-request): evita
// cascata de members.fetch ao listar N gravações e protege a gravação ao vivo.
// member === null = "confirmado NÃO-membro". Erro transitório não é cacheado.
const MEMBER_TTL_MS = 45_000;
const memberCache = new Map<string, { member: GuildMember | null; at: number }>();

async function fetchMemberCached(guildId: string, userId: string, forceRefresh = false): Promise<GuildMember | null> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new TransientAccessError('guild fora do cache (gateway não pronto?)');
  const key = `${guildId}:${userId}`;
  const hit = memberCache.get(key);
  if (!forceRefresh && hit && Date.now() - hit.at < MEMBER_TTL_MS) return hit.member;
  try {
    // `members.fetch(userId)` SEM force devolve o GuildMember já presente no
    // cache interno do discord.js. Sem a intent privilegiada GuildMembers, uma
    // remoção de cargo/saída do servidor não atualiza esse objeto e a permissão
    // revogada poderia sobreviver indefinidamente. Toda renovação deste cache é
    // portanto autoritativa via REST.
    const member = await guild.members.fetch({ user: userId, force: true, cache: true });
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

export interface AccessCheckOptions {
  /** Ignora também o TTL local. Obrigatório antes de apagar dados. */
  freshMember?: boolean;
}

/** Grant ligado à presença histórica; só é aplicado depois de confirmar membership atual. */
export function recordingIdentityGrant(userId: string, meta: RecordingMeta): Access {
  const isInitiator = !!meta.startedBy && meta.startedBy.id === userId;
  const isParticipant = meta.participants.some((p) => p.id === userId);
  const wasPresent = meta.presence?.some((p) => p.id === userId) ?? false;
  return { view: isInitiator || isParticipant || wasPresent, delete: isInitiator };
}

/** Só calls públicas no início aceitam o ViewChannel atual como grant histórico. */
export function allowsCurrentChannelGrant(meta: RecordingMeta): boolean {
  return meta.sourceEveryoneViewable === true;
}

/** Invalida o cache de um membro (chamado no guildMemberRemove). */
export function forgetMember(guildId: string, userId: string): void {
  memberCache.delete(`${guildId}:${userId}`);
}

async function computeAccess(
  user: AccessIdentity,
  meta: RecordingMeta,
  options: AccessCheckOptions = {},
): Promise<AccessResult> {
  // Sem id não há acesso a nada (impede null/undefined "casar" com startedBy null).
  if (!user.id) return { view: false, delete: false, serverLayersUnknown: false };

  const guild = client.guilds.cache.get(meta.guildId);
  if (!guild) {
    // Membership atual é pré-condição de TODOS os grants: sem guild, fail-closed.
    return { view: false, delete: false, serverLayersUnknown: true };
  }

  let member: GuildMember | null;
  try {
    member = await fetchMemberCached(meta.guildId, user.id, options.freshMember);
  } catch {
    // Não dá para confirmar que ainda é membro: nenhum grant histórico é aceito.
    return { view: false, delete: false, serverLayersUnknown: true };
  }
  if (member === null) {
    // Saiu do servidor: perde inclusive os grants de participante/iniciador.
    return { view: false, delete: false, serverLayersUnknown: false };
  }

  const identity = recordingIdentityGrant(user.id, meta);
  let view = identity.view;
  let del = identity.delete;

  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    view = true;
    del = true;
  }

  let channelUnknown = false;
  // Participante/iniciador/admin já tem resposta; call privada jamais usa a
  // audiência atual. Só consulta o canal quando ele ainda pode mudar o veredito.
  if (!view && allowsCurrentChannelGrant(meta)) {
    let channel = guild.channels.cache.get(meta.voiceChannelId) ?? null;
    if (!channel) {
      try {
        channel = await guild.channels.fetch(meta.voiceChannelId);
      } catch (err) {
        // canal apagado (10003) = sem grant por canal; transitório = desconhecido
        if (!(err && typeof err === 'object' && (err as { code?: unknown }).code === 10003)) channelUnknown = true;
      }
    }
    if (channel?.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) view = true;
  }

  return { view, delete: del, serverLayersUnknown: channelUnknown && !view };
}

/**
 * Acesso para a PÁGINA WEB: fail-closed. Sem confirmar membership atual, ninguém
 * recebe sequer o grant histórico de participante/iniciador.
 */
export async function checkAccess(
  user: AccessIdentity,
  meta: RecordingMeta,
  options: AccessCheckOptions = {},
): Promise<Access> {
  const r = await computeAccess(user, meta, options);
  return { view: r.view, delete: r.delete };
}

/**
 * Acesso para a API do MCP: se as camadas de servidor ficaram desconhecidas E isso
 * poderia esconder um acesso legítimo (ainda sem `view`), LANÇA TransientAccessError
 * → o endpoint responde 503 (o conector faz backoff), nunca um 403 falso ou um
 * grant indevido. Fail-closed de verdade.
 */
export async function checkAccessForMcp(
  user: AccessIdentity,
  meta: RecordingMeta,
  options: AccessCheckOptions = {},
): Promise<Access> {
  const r = await computeAccess(user, meta, options);
  if (r.serverLayersUnknown && !r.view) {
    throw new TransientAccessError('camadas de acesso indisponíveis no momento');
  }
  return { view: r.view, delete: r.delete };
}
