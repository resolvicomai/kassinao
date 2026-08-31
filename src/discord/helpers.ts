import { Client, Events, GatewayIntentBits } from 'discord.js';
import { config } from '../config';
import { operationalError, operationalPii, operationalWarn } from '../operationalLog';
import { identityPool } from './identityPool';

/**
 * Bots AJUDANTES: identidades de voz extras para gravar mais de uma sala do
 * mesmo servidor ao mesmo tempo (um bot user = uma conexão de voz por guild).
 *
 * O ajudante é deliberadamente mudo e cego fora da voz: intents mínimas (Guilds
 * + GuildVoiceStates), nenhum comando registrado, nenhuma DM, nenhuma mensagem.
 * Painel, avisos e metadados continuam saindo pelo bot principal. Ele só entra
 * no canal, recebe áudio e usa o apelido [GRAVANDO].
 *
 * Falha de login do ajudante NUNCA derruba o processo: o principal segue
 * sozinho, exatamente como antes da feature existir.
 */

export interface HelperBootResult {
  client: Client;
  label: string;
  login: Promise<boolean>;
}

const booted: Client[] = [];

/** Desliga os ajudantes no shutdown gracioso. Seguro antes/na ausência do boot. */
export function destroyHelpers(): void {
  for (const helper of booted) {
    try {
      helper.destroy();
    } catch {
      // ignore — shutdown segue
    }
  }
}

/** Decisão pura de perímetro, extraída para teste: ajudante sai de guild não autorizada. */
export function helperGuildAllowed(allows: (guildId: string) => boolean, guildId: string): boolean {
  return allows(guildId);
}

export function bootHelpers(
  alert: (key: string, message: string) => Promise<void>,
  allows: (guildId: string) => boolean,
): HelperBootResult[] {
  return config.helperTokens.map((token, index) => {
    const label = `helper-${index + 1}`;
    const helper = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
      allowedMentions: { parse: [] },
    });

    // Mesma fronteira do principal: o ajudante numa guild fora da allowlist é
    // porta lateral (alguém o convida e ele fica lá conectado, com voz). Ele não
    // tem comandos para limpar, então a evicção é só guild.leave().
    const evict = (guildId: string, leave: () => Promise<unknown>): void => {
      if (helperGuildAllowed(allows, guildId)) return;
      void leave().catch((err) =>
        operationalWarn(
          `Ajudante ${label} não conseguiu sair de guild não autorizada guild=${operationalPii(guildId)}: ${operationalError(err)}`,
        ),
      );
    };
    helper.on(Events.ClientReady, () => {
      for (const guild of helper.guilds.cache.values()) evict(guild.id, () => guild.leave());
      console.log(`Identidade de voz ${label} online como ${helper.user?.tag ?? '?'} 🎙️`);
    });
    helper.on(Events.GuildCreate, (guild) => evict(guild.id, () => guild.leave()));

    identityPool.register({ label, client: helper });
    booted.push(helper);

    const login = helper
      .login(token)
      .then(() => true)
      .catch((err) => {
        operationalWarn(`Login do ajudante ${label} falhou: ${operationalError(err)}`);
        void alert(
          `helper-login:${label}`,
          `O bot ajudante **${label}** não conseguiu entrar (token inválido?). O Kassinão segue funcionando com uma sala por vez até isso ser corrigido.`,
        );
        return false;
      });

    return { client: helper, label, login };
  });
}
