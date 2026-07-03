import { Client, GatewayIntentBits } from 'discord.js';

/**
 * Instância única do client, em módulo próprio para que o servidor web
 * possa consultar permissões sem import circular com o index.
 */
export const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
