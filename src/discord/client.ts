import { Client, GatewayIntentBits, Partials } from 'discord.js';

/**
 * Instância única do client, em módulo próprio para que o servidor web
 * possa consultar permissões sem import circular com o index.
 *
 * DirectMessages + Partials.Channel: para responder o guia quando alguém
 * manda DM ao bot (não lemos o conteúdo — só respondemos, então NÃO precisa
 * da intent privilegiada MessageContent).
 */
export const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel],
  // Nunca dispara @everyone/@here/menção de role a partir de conteúdo (defesa contra
  // regressão: um nome/apelido malicioso jamais vira ping em massa).
  allowedMentions: { parse: [] },
});
