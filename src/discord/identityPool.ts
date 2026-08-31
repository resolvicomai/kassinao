import type { Client } from 'discord.js';

/**
 * Uma identidade de voz = um bot user capaz de manter UMA conexão de voz por
 * servidor. O pool ordena as identidades ('default' = bot principal sempre
 * primeiro, ajudantes na ordem de configuração) e escolhe, para cada início de
 * gravação, a primeira que esteja pronta, presente no servidor e ainda sem
 * gravação naquele guild.
 *
 * A escolha é SÍNCRONA de propósito: ela roda dentro da janela atômica entre
 * decidir e reservar (nenhum await no meio), senão dois inícios simultâneos
 * escolheriam o mesmo ajudante e a segunda conexão derrubaria a primeira.
 */
export interface VoiceIdentity {
  readonly label: string;
  readonly client: Client;
}

export class IdentityPool {
  private readonly identities: VoiceIdentity[] = [];

  register(identity: VoiceIdentity): void {
    if (this.identities.some((existing) => existing.label === identity.label)) {
      throw new Error(`identidade de voz duplicada: ${identity.label}`);
    }
    this.identities.push(identity);
  }

  size(): number {
    return this.identities.length;
  }

  /**
   * A primeira identidade livre para gravar neste guild, ou undefined quando
   * todas estão ocupadas, caídas ou fora do servidor — este último caso é a
   * colisão de verdade, a que merece aviso na sala.
   */
  choose(guildId: string, busyLabels: ReadonlySet<string>): VoiceIdentity | undefined {
    for (const identity of this.identities) {
      if (busyLabels.has(identity.label)) continue;
      if (!identity.client.isReady()) continue;
      if (!identity.client.guilds.cache.has(guildId)) continue;
      return identity;
    }
    return undefined;
  }

  /** Identidades utilizáveis neste guild agora (prontas e presentes). */
  readyCountFor(guildId: string): number {
    let count = 0;
    for (const identity of this.identities) {
      if (identity.client.isReady() && identity.client.guilds.cache.has(guildId)) count++;
    }
    return count;
  }
}

export const identityPool = new IdentityPool();
