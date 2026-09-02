import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { DiscordCapabilities } from '../i18n';
import { MAX_NOTE_LENGTH } from '../recorder/RecordingSession';
import { currentDiscordCapabilities } from './capabilities';

// ---------- definição dos comandos (pt-BR nativo + localização em inglês) ----------
// Só constrói o JSON dos comandos. O registro via REST continua no boot (index.ts).

function localized<T extends { setNameLocalizations: any; setDescriptionLocalizations: any }>(
  builder: T,
  name: string,
  description: string,
): T {
  builder.setNameLocalizations({ 'en-US': name, 'en-GB': name });
  builder.setDescriptionLocalizations({ 'en-US': description, 'en-GB': description });
  return builder;
}

export function buildCommands(capabilities: DiscordCapabilities = currentDiscordCapabilities()) {
  const recordDescription = capabilities.transcription
    ? capabilities.minutes
      ? '🔴 Grava a call com faixas, notas, transcrição e ata'
      : '🔴 Grava a call com faixas, notas e transcrição'
    : '🔴 Grava a call com faixas separadas e notas';
  const recordDescriptionEn = capabilities.transcription
    ? capabilities.minutes
      ? '🔴 Record the call with tracks, notes, transcript, and minutes'
      : '🔴 Record the call with tracks, notes, and transcript'
    : '🔴 Record the call with separate tracks and notes';
  const gravar = new SlashCommandBuilder()
    .setName('gravar')
    .setDescription(recordDescription)
    .addChannelOption((o) => {
      o.setName('canal')
        .setDescription('Canal de voz a gravar (padrão: o canal onde você está)')
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        .setRequired(false);
      o.setNameLocalizations({ 'en-US': 'channel', 'en-GB': 'channel' });
      o.setDescriptionLocalizations({
        'en-US': 'Voice channel to record (default: the one you are in)',
        'en-GB': 'Voice channel to record (default: the one you are in)',
      });
      return o;
    });
  localized(gravar, 'record', recordDescriptionEn);

  const parar = new SlashCommandBuilder()
    .setName('parar')
    .setDescription('⏹️ Encerra a gravação e disponibiliza os arquivos no app');
  localized(parar, 'stop', '⏹️ Stop recording and make the files available in the app');

  const nota = new SlashCommandBuilder()
    .setName('nota')
    .setDescription('📝 Marca uma nota no tempo atual da gravação')
    .addStringOption((o) => {
      o.setName('texto').setDescription('Texto da nota').setMaxLength(MAX_NOTE_LENGTH).setRequired(true);
      o.setNameLocalizations({ 'en-US': 'text', 'en-GB': 'text' });
      o.setDescriptionLocalizations({ 'en-US': 'Note text', 'en-GB': 'Note text' });
      return o;
    });
  localized(nota, 'note', '📝 Mark a note at the current recording time');

  const status = new SlashCommandBuilder().setName('status').setDescription('ℹ️ Mostra o estado da gravação atual');
  localized(status, 'status', 'ℹ️ Show the current recording status');

  const ajuda = new SlashCommandBuilder()
    .setName('ajuda')
    .setDescription('❓ Como usar o Kassinão (comandos e passo a passo)');
  localized(ajuda, 'help', '❓ How to use Kassinão (commands and quick start)');

  const gravacoes = new SlashCommandBuilder()
    .setName('gravacoes')
    .setDescription('📼 Lista as últimas gravações deste servidor com os links');
  localized(gravacoes, 'recordings', '📼 List the latest recordings in this server with links');

  const autorecord = new SlashCommandBuilder()
    .setName('autorecord')
    .setDescription('🤖 Grava um canal por regra de presença configurada')
    .addSubcommand((sc) => {
      sc.setName('ligar')
        .setDescription('Liga o auto-record em um canal de voz')
        .addChannelOption((o) => {
          o.setName('canal')
            .setDescription('Canal de voz')
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
            .setRequired(true);
          o.setNameLocalizations({ 'en-US': 'channel', 'en-GB': 'channel' });
          o.setDescriptionLocalizations({ 'en-US': 'Voice channel', 'en-GB': 'Voice channel' });
          return o;
        })
        .addIntegerOption((o) => {
          o.setName('minimo')
            .setDescription('Nº mínimo de pessoas para começar a gravar (padrão: 1)')
            .setMinValue(1)
            .setMaxValue(99)
            .setRequired(false);
          o.setNameLocalizations({ 'en-US': 'minimum', 'en-GB': 'minimum' });
          o.setDescriptionLocalizations({
            'en-US': 'Minimum number of people to start recording (default: 1)',
            'en-GB': 'Minimum number of people to start recording (default: 1)',
          });
          return o;
        });
      sc.setNameLocalizations({ 'en-US': 'on', 'en-GB': 'on' });
      sc.setDescriptionLocalizations({
        'en-US': 'Enable auto-record in a voice channel',
        'en-GB': 'Enable auto-record in a voice channel',
      });
      return sc;
    })
    .addSubcommand((sc) => {
      sc.setName('desligar')
        .setDescription('Desliga o auto-record de um canal de voz')
        .addChannelOption((o) => {
          o.setName('canal')
            .setDescription('Canal de voz')
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
            .setRequired(true);
          o.setNameLocalizations({ 'en-US': 'channel', 'en-GB': 'channel' });
          o.setDescriptionLocalizations({ 'en-US': 'Voice channel', 'en-GB': 'Voice channel' });
          return o;
        });
      sc.setNameLocalizations({ 'en-US': 'off', 'en-GB': 'off' });
      sc.setDescriptionLocalizations({
        'en-US': 'Disable auto-record in a voice channel',
        'en-GB': 'Disable auto-record in a voice channel',
      });
      return sc;
    })
    .addSubcommand((sc) => {
      sc.setName('ver').setDescription('Mostra os auto-records configurados');
      sc.setNameLocalizations({ 'en-US': 'view', 'en-GB': 'view' });
      sc.setDescriptionLocalizations({
        'en-US': 'Show configured auto-records',
        'en-GB': 'Show configured auto-records',
      });
      return sc;
    })
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  localized(autorecord, 'autorecord', '🤖 Record a channel using a configured presence rule');

  const sobre = new SlashCommandBuilder()
    .setName('sobre')
    .setDescription('ℹ️ Operador, privacidade, autoria, licença e código-fonte');
  localized(sobre, 'about', 'ℹ️ Operator, privacy, authorship, license, and source code');

  const privacidade = new SlashCommandBuilder()
    .setName('privacidade')
    .setDescription('🔒 Mostra a política e o contato desta instância');
  localized(privacidade, 'privacy', "🔒 Show this instance's policy and contact");

  const perguntar = new SlashCommandBuilder()
    .setName('perguntar')
    .setDescription('🔎 Encontra evidências nas reuniões que você pode abrir')
    .addStringOption((o) => {
      o.setName('pergunta')
        .setDescription('Pergunte por tema, pessoa ou data (ex.: ações da Ana ontem)')
        .setMaxLength(300)
        .setRequired(true);
      o.setNameLocalizations({ 'en-US': 'question', 'en-GB': 'question' });
      o.setDescriptionLocalizations({
        'en-US': "Ask by topic, person or date (e.g.: Ana's actions yesterday)",
        'en-GB': "Ask by topic, person or date (e.g.: Ana's actions yesterday)",
      });
      return o;
    })
    .addIntegerOption((o) => {
      o.setName('dias')
        .setDescription('Janela de busca em dias (padrão: 30)')
        .setMinValue(1)
        .setMaxValue(365)
        .setRequired(false);
      o.setNameLocalizations({ 'en-US': 'days', 'en-GB': 'days' });
      o.setDescriptionLocalizations({
        'en-US': 'Search window in days (default: 30)',
        'en-GB': 'Search window in days (default: 30)',
      });
      return o;
    });
  localized(perguntar, 'ask', '🔎 Find evidence in meetings you can access');

  const configCmd = new SlashCommandBuilder()
    .setName('config')
    .setDescription('⚙️ Configurações do Kassinão neste servidor (admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) => {
      sc.setName('ata-canal')
        .setDescription('Define (ou limpa) o canal do aviso genérico de processamento')
        .addChannelOption((o) => {
          o.setName('canal')
            .setDescription('Canal de texto (vazio = limpar)')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false);
          o.setNameLocalizations({ 'en-US': 'channel', 'en-GB': 'channel' });
          o.setDescriptionLocalizations({
            'en-US': 'Text channel (empty = clear)',
            'en-GB': 'Text channel (empty = clear)',
          });
          return o;
        });
      sc.setNameLocalizations({ 'en-US': 'minutes-channel', 'en-GB': 'minutes-channel' });
      sc.setDescriptionLocalizations({
        'en-US': 'Set (or clear) the channel for generic processing notices',
        'en-GB': 'Set (or clear) the channel for generic processing notices',
      });
      return sc;
    })
    .addSubcommand((sc) => {
      sc.setName('ver').setDescription('Mostra a configuração atual');
      sc.setNameLocalizations({ 'en-US': 'view', 'en-GB': 'view' });
      sc.setDescriptionLocalizations({
        'en-US': 'Show the current configuration',
        'en-GB': 'Show the current configuration',
      });
      return sc;
    });
  localized(configCmd, 'config', '⚙️ Kassinão settings for this server (admin)');

  const cmds = [gravar, parar, nota, status, ajuda, gravacoes, autorecord, configCmd, privacidade, sobre];

  // /perguntar só existe quando o provider que responde às consultas está ativo.
  if (capabilities.ask) cmds.push(perguntar);

  // /mcp só existe quando o conector de IA está habilitado (MCP_SECRET definido).
  if (capabilities.mcp) {
    const mcp = new SlashCommandBuilder()
      .setName('mcp')
      .setDescription('🔌 Operador: gerencia conexões de clientes MCP compatíveis')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sc) => {
        sc.setName('novo').setDescription('Gera um código de conexão MCP para o operador');
        sc.setNameLocalizations({ 'en-US': 'new', 'en-GB': 'new' });
        sc.setDescriptionLocalizations({
          'en-US': 'Generate an MCP connection code for the operator',
          'en-GB': 'Generate an MCP connection code for the operator',
        });
        return sc;
      })
      .addSubcommand((sc) => {
        sc.setName('revogar-tudo').setDescription('Revoga todas as conexões MCP deste operador');
        sc.setNameLocalizations({ 'en-US': 'revoke-all', 'en-GB': 'revoke-all' });
        sc.setDescriptionLocalizations({
          'en-US': 'Revoke all MCP connections for this operator',
          'en-GB': 'Revoke all MCP connections for this operator',
        });
        return sc;
      });
    localized(mcp, 'mcp', '🔌 Operator: manage compatible MCP client connections');
    cmds.push(mcp);
  }

  return cmds.map((c) => c.toJSON());
}
