import { config } from '../config';
import { DiscordCapabilities } from '../i18n';
import { minutesEnabled } from '../processing/minutes';
import { transcriptionEnabled } from '../processing/transcribe';

/**
 * Quais capacidades esta instância expõe no Discord (transcrição, ata,
 * /perguntar, MCP). Leitura pura de configuração: sem estado, sem efeitos.
 */
export function currentDiscordCapabilities(): DiscordCapabilities {
  const transcription = transcriptionEnabled();
  const minutes = minutesEnabled();
  return {
    transcription,
    minutes,
    ask: minutes,
    mcp: config.mcpEnabled,
  };
}
