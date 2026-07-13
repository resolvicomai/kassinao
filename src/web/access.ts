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
 *  - a permissão atual de Ver Canal nunca libera histórico: quem não estava na
 *    call precisa de grant explícito de iniciador ou administrador
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
export const MEMBER_CACHE_MAX_ENTRIES = 5_000;
const memberCache = new Map<string, { member: GuildMember | null; at: number }>();

function cacheMember(key: string, member: GuildMember | null): void {
  // delete + set atualiza a ordem LRU também quando a entrada já existia.
  memberCache.delete(key);
  memberCache.set(key, { member, at: Date.now() });
  while (memberCache.size > MEMBER_CACHE_MAX_ENTRIES) {
    const oldest = memberCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    memberCache.delete(oldest);
  }
}

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
    cacheMember(key, member);
    return member;
  } catch (err) {
    if (isUnknownMember(err)) {
      cacheMember(key, null); // saiu do servidor
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

/** Invalida o cache de um membro (chamado no guildMemberRemove). */
export function forgetMember(guildId: string, userId: string): void {
  memberCache.delete(`${guildId}:${userId}`);
}

/** Remove todas as identidades de um servidor quando o bot sai dele. */
export function forgetGuildMembers(guildId: string): void {
  const prefix = `${guildId}:`;
  for (const key of memberCache.keys()) if (key.startsWith(prefix)) memberCache.delete(key);
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

  return { view, delete: del, serverLayersUnknown: false };
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
