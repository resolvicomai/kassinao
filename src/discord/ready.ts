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
let ready = false;

export function isClientReady(): boolean {
  return ready;
}

export function markClientReady(): void {
  ready = true;
}
