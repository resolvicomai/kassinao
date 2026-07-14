/**
 * Prontidão do gateway do Discord.
 *
 * O servidor web sobe no boot (para a landing/demo/health ficarem sempre no ar),
 * mas o `checkAccess` depende dos caches de guild/canal do gateway (membros,
 * permissões, "quem enxerga o canal"). Antes do ClientReady esses caches estão
 * vazios — avaliar acesso ali daria um veredito ERRADO (nega quem tinha direito).
 *
 * Por isso as rotas com controle de acesso (e a API do MCP) consultam este sinal
 * e respondem 503 "iniciando" até o gateway ficar pronto — em vez de um 403 falso.
 */
import { Client, Events } from 'discord.js';

let ready = false;
let completedInitialReady = false;
let globallyUnavailable = false;
const unavailableShards = new Set<number>();

export function isClientReady(): boolean {
  return ready;
}

export function markClientReady(): void {
  completedInitialReady = true;
  globallyUnavailable = false;
  unavailableShards.clear();
  ready = true;
}

function markShardUnavailable(shardId: number): void {
  unavailableShards.add(shardId);
  ready = false;
}

function markShardReady(shardId: number): void {
  unavailableShards.delete(shardId);
  if (completedInitialReady && !globallyUnavailable && unavailableShards.size === 0) ready = true;
}

/**
 * Instala o sinal antes do login. Um reconnect volta imediatamente a 503 e,
 * em processo multi-shard, o acesso só reabre depois que todos os shards que
 * caíram retomarem. `invalidated` exige um novo ClientReady completo.
 */
export function observeClientReadiness(client: Client): void {
  ready = false;
  completedInitialReady = false;
  globallyUnavailable = false;
  unavailableShards.clear();

  client.on(Events.ClientReady, markClientReady);
  client.on(Events.ShardDisconnect, (_event, shardId) => markShardUnavailable(shardId));
  client.on(Events.ShardReconnecting, (shardId) => markShardUnavailable(shardId));
  client.on(Events.ShardReady, (shardId) => markShardReady(shardId));
  client.on(Events.ShardResume, (shardId) => markShardReady(shardId));
  client.on(Events.Invalidated, () => {
    globallyUnavailable = true;
    ready = false;
  });
}
