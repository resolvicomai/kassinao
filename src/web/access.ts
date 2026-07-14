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

interface MembershipBudgetLimits {
  perUserPerMinute: number;
  globalPerMinute: number;
  maxConcurrent: number;
  maxTrackedUsers: number;
}

interface MembershipWindow {
  count: number;
  resetAt: number;
}

/**
 * Limita chamadas REST autoritativas sem reutilizar o resultado de autorização.
 * O orçamento por userId agrega todas as sessões/web requests; o teto global e
 * a concorrência impedem que várias contas saturem o Discord ao mesmo tempo.
 */
export class FreshMembershipBudget {
  private readonly userWindows = new Map<string, MembershipWindow>();
  private globalWindow: MembershipWindow = { count: 0, resetAt: 0 };
  private active = 0;

  constructor(
    private readonly limits: MembershipBudgetLimits = {
      perUserPerMinute: 60,
      globalPerMinute: 600,
      maxConcurrent: 8,
      maxTrackedUsers: 5_000,
    },
    private readonly now: () => number = Date.now,
  ) {}

  get activeChecks(): number {
    return this.active;
  }

  async run<T>(userId: string, task: () => Promise<T>): Promise<T> {
    const now = this.now();
    if (!userId || this.active >= this.limits.maxConcurrent) {
      throw new TransientAccessError('orçamento de membership saturado');
    }

    const current = this.userWindows.get(userId);
    const userWindow = !current || current.resetAt <= now ? { count: 0, resetAt: now + 60_000 } : current;
    if (userWindow.count >= this.limits.perUserPerMinute) {
      throw new TransientAccessError('orçamento de membership do usuário esgotado');
    }
    userWindow.count++;
    if (current !== userWindow) {
      this.userWindows.delete(userId);
      this.userWindows.set(userId, userWindow);
    }

    if (this.globalWindow.resetAt <= now) this.globalWindow = { count: 0, resetAt: now + 60_000 };
    if (this.globalWindow.count >= this.limits.globalPerMinute) {
      throw new TransientAccessError('orçamento global de membership esgotado');
    }
    this.globalWindow.count++;

    while (this.userWindows.size > this.limits.maxTrackedUsers) {
      const oldest = this.userWindows.keys().next().value as string | undefined;
      if (!oldest) break;
      this.userWindows.delete(oldest);
    }

    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
    }
  }
}

const freshMembershipBudget = new FreshMembershipBudget();

export function withFreshMembershipBudget<T>(userId: string, task: () => Promise<T>): Promise<T> {
  return freshMembershipBudget.run(userId, task);
}

// "Definitivamente não é membro daqui" (nega camadas de servidor, sem 503):
//  10007 Unknown Member (saiu do servidor) • 10013 Unknown User (id inexistente).
// Só erro TRANSITÓRIO (429/5xx/timeout/rede) vira 503 retriável.
function isUnknownMember(err: unknown): boolean {
  const code = !!err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  return code === 10007 || code === 10013;
}

/**
 * Deduplica a confirmação REST apenas durante UMA listagem HTTP. Nunca deve ser
 * armazenado em módulo, sessão ou cache compartilhado entre requests: o client
 * não usa GuildMembers intent e não recebe todas as revogações de membership/cargo.
 */
export interface AccessRequestContext {
  readonly memberChecks: Map<string, Promise<GuildMember | null>>;
}

export function createAccessRequestContext(): AccessRequestContext {
  return { memberChecks: new Map() };
}

async function fetchMemberFresh(guildId: string, userId: string): Promise<GuildMember | null> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new TransientAccessError('guild fora do cache (gateway não pronto?)');
  try {
    // `cache:false` também impede que esta consulta autoritativa repovoe um
    // GuildMember obsoleto no cache interno do discord.js.
    return await withFreshMembershipBudget(userId, () =>
      guild.members.fetch({ user: userId, force: true, cache: false }),
    );
  } catch (err) {
    if (isUnknownMember(err)) return null;
    throw new TransientAccessError('members.fetch falhou (transitório)');
  }
}

function fetchMemberForCheck(
  guildId: string,
  userId: string,
  options: AccessCheckOptions,
): Promise<GuildMember | null> {
  if (options.freshMember || !options.requestContext) return fetchMemberFresh(guildId, userId);
  const key = `${guildId}:${userId}`;
  const existing = options.requestContext.memberChecks.get(key);
  if (existing) return existing;
  const check = fetchMemberFresh(guildId, userId);
  options.requestContext.memberChecks.set(key, check);
  return check;
}

/**
 * Pré-valida o escopo explícito de uma consulta MCP antes de olhar o arquivo
 * daquela guild. `false` significa definitivamente "não é membro"; qualquer
 * estado incerto continua sendo 503, nunca uma resposta vazia enganosa.
 *
 * Isso não substitui a ACL por gravação. Com o mesmo requestContext, cada meta
 * ainda passa por checkAccessForMcp reutilizando apenas esta confirmação REST.
 */
export async function prevalidateGuildMembershipForMcp(
  user: AccessIdentity,
  guildId: string,
  requestContext: AccessRequestContext,
): Promise<boolean> {
  if (!user.id || !guildId) return false;
  // Um guildId arbitrário fora do gateway não prova indisponibilidade: para
  // esta consulta ele é um escopo definitivamente inacessível e deve parecer
  // igual a Unknown Member. Só REST falhando numa guild conhecida vira 503.
  if (!client.guilds.cache.has(guildId)) return false;
  return (await fetchMemberForCheck(guildId, user.id, { requestContext })) !== null;
}

export interface AccessCheckOptions {
  /** Deduplica a confirmação por usuário+guild somente dentro desta listagem. */
  requestContext?: AccessRequestContext;
  /** Ignora até o contexto da listagem. Obrigatório antes de apagar dados. */
  freshMember?: boolean;
}

/** Grant ligado à presença histórica; só é aplicado depois de confirmar membership atual. */
export function recordingIdentityGrant(userId: string, meta: RecordingMeta): Access {
  const isInitiator = !!meta.startedBy && meta.startedBy.id === userId;
  const isParticipant = meta.participants.some((p) => p.id === userId);
  const wasPresent = meta.presence?.some((p) => p.id === userId) ?? false;
  return { view: isInitiator || isParticipant || wasPresent, delete: isInitiator };
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
    // Com o gateway global pronto, uma guild ausente significa que o bot não
    // está mais nela. A meta órfã é negação definitiva/404 e não pode derrubar
    // uma varredura multi-tenant com 503. Startup continua coberto pelo readinessGate.
    return { view: false, delete: false, serverLayersUnknown: false };
  }

  let member: GuildMember | null;
  try {
    member = await fetchMemberForCheck(meta.guildId, user.id, options);
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
