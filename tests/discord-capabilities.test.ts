import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({
  client: {
    once: vi.fn(),
    on: vi.fn(),
    login: vi.fn(() => Promise.resolve()),
    destroy: vi.fn(),
    guilds: { cache: new Map() },
  },
}));

vi.mock('../src/discord/client', () => ({ client: runtimeMocks.client }));
vi.mock('../src/web/server', () => ({ startWebServer: vi.fn() }));
vi.mock('../src/cleanup', () => ({ startCleanupJob: vi.fn() }));
vi.mock('../src/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/store')>()),
  recoverInterruptedRecordings: vi.fn(() => []),
  listMetas: vi.fn(() => []),
}));

import {
  buildAboutEmbed,
  buildCommands,
  buildHelpPayload,
  buildHelpTopicContent,
  buildPrivacyCommandContent,
  buildPrivacyCommandPayload,
  buildWelcomeEmbed,
} from '../src/index';
import { DiscordCapabilities } from '../src/i18n';

const recordingOnly: DiscordCapabilities = {
  transcription: false,
  minutes: false,
  ask: false,
  mcp: false,
};

const transcriptOnly: DiscordCapabilities = {
  transcription: true,
  minutes: false,
  ask: false,
  mcp: false,
};

const fullAi: DiscordCapabilities = {
  transcription: true,
  minutes: true,
  ask: true,
  mcp: true,
};

function commandByName(capabilities: DiscordCapabilities, name: string) {
  return buildCommands(capabilities).find((command) => command.name === name);
}

describe('capacidades nas superfícies do Discord', () => {
  it('registra /perguntar e /mcp somente quando os recursos correspondentes estão ativos', () => {
    const baseNames = buildCommands(recordingOnly).map((command) => command.name);
    const transcriptNames = buildCommands(transcriptOnly).map((command) => command.name);
    const fullNames = buildCommands(fullAi).map((command) => command.name);

    expect(baseNames).not.toContain('perguntar');
    expect(baseNames).not.toContain('mcp');
    expect(transcriptNames).not.toContain('perguntar');
    expect(fullNames).toContain('perguntar');
    expect(fullNames).toContain('mcp');
    expect(baseNames).toContain('privacidade');
    expect(commandByName(recordingOnly, 'privacidade')?.name_localizations?.['en-US']).toBe('privacy');
  });

  it('mantém /mcp como atalho do operador, oculto por padrão de membros comuns e sem acoplar cliente', () => {
    const command = commandByName(fullAi, 'mcp');
    const serialized = JSON.stringify(command);

    expect(command?.default_member_permissions).toBe(PermissionFlagsBits.ManageGuild.toString());
    expect(serialized).toContain('MCP');
    expect(serialized).toContain('compatíveis');
  });

  it('mantém descrições curtas e só anuncia os artefatos habilitados', () => {
    const base = commandByName(recordingOnly, 'gravar');
    const transcript = commandByName(transcriptOnly, 'gravar');
    const full = commandByName(fullAi, 'gravar');

    expect(base?.description).toContain('faixas separadas e notas');
    expect(base?.description).not.toContain('transcrição');
    expect(transcript?.description).toContain('transcrição');
    expect(transcript?.description).not.toContain('ata');
    expect(full?.description).toContain('transcrição e ata');
    expect(commandByName(fullAi, 'perguntar')?.description).toContain('evidências');

    for (const command of buildCommands(fullAi)) {
      expect(command.description.length).toBeLessThanOrEqual(100);
      for (const localized of Object.values(command.description_localizations ?? {})) {
        expect(localized.length).toBeLessThanOrEqual(100);
      }
    }
  });

  it('remove linha, botão e tópico de perguntas da ajuda quando /perguntar está desligado', () => {
    const base = buildHelpPayload('pt', recordingOnly);
    const baseJson = JSON.stringify(base);
    const baseButtons = base.components[0].toJSON().components.map((component) => component.custom_id);

    expect(baseJson).toContain('transcrição automática de novas calls está desligada');
    expect(baseJson).not.toContain('**/perguntar**');
    expect(baseButtons).not.toContain('kassinao_help:ask');
    expect(buildHelpTopicContent('pt', 'ask', recordingOnly)).not.toContain('/perguntar');

    const enabled = buildHelpPayload('pt', fullAi);
    const enabledJson = JSON.stringify(enabled);
    const enabledButtons = enabled.components[0].toJSON().components.map((component) => component.custom_id);
    expect(enabledJson).toContain('**/perguntar**');
    expect(enabledButtons).toContain('kassinao_help:ask');
    expect(buildHelpTopicContent('pt', 'ask', fullAi)).toContain('**/perguntar**');
  });

  it('adapta o welcome sem prometer IA automática ou prazo', () => {
    const base = JSON.stringify(buildWelcomeEmbed('pt', recordingOnly));
    const enabled = JSON.stringify(buildWelcomeEmbed('en', fullAi));

    expect(base).toContain('transcrição automática de novas calls está desligada');
    expect(base).not.toContain('/perguntar');
    expect(enabled).toContain('transcript enters the queue');
    expect(enabled).toContain('/ask');
    for (const copy of [base, enabled]) {
      expect(copy).not.toMatch(/~1 min|perfect|perfeit|durante a call|during the call|sem saber|unknowingly/i);
    }
  });

  it('expõe a identidade e os fluxos de privacidade da instância no comando, ajuda e sobre', () => {
    const privacyCommand = buildPrivacyCommandContent('pt');
    const privacyPayload = buildPrivacyCommandPayload('pt');
    const privacyHelp = buildHelpTopicContent('en', 'privacy', recordingOnly);
    const about = JSON.stringify(buildAboutEmbed('pt'));

    for (const copy of [privacyCommand, privacyHelp, about]) {
      expect(copy).toContain('http://localhost:8080/privacy');
      expect(copy).toContain('http://localhost:8080/privacy#data-rights');
      expect(copy).toContain('http://localhost:8080/privacy#contact');
    }
    expect(privacyCommand).toContain('Operador local do Kassinão');
    expect(privacyPayload).toEqual({ content: privacyCommand, ephemeral: true });
    expect(privacyHelp).toContain('Operator:');
    expect(about).toContain('Operador desta instância');
  });
});
