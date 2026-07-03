/**
 * Textos do bot em pt-BR e inglês.
 * O idioma é escolhido pelo locale do cliente Discord de quem interage
 * (pt-BR para clientes em português, inglês para o resto).
 */
export type Locale = 'pt' | 'en';

export function localeOf(discordLocale: string | undefined): Locale {
  return discordLocale?.toLowerCase().startsWith('pt') ? 'pt' : 'en';
}

type Strings = Record<string, { pt: string; en: string }>;

const STRINGS: Strings = {
  // erros e avisos
  'err.generic': { pt: '❌ Deu ruim aqui do meu lado. Tenta de novo?', en: '❌ Something went wrong on my end. Try again?' },
  'err.guild-only': { pt: 'Esse comando só funciona dentro de um servidor.', en: 'This command only works inside a server.' },
  'err.not-in-voice': {
    pt: '🎧 Você precisa estar em um canal de voz (ou indicar um no comando) para eu gravar.',
    en: '🎧 You need to be in a voice channel (or pass one to the command) so I can record.',
  },
  'err.already-recording': {
    pt: '⚠️ Já estou gravando **{channel}** neste servidor. Use `/parar` para encerrar primeiro.',
    en: '⚠️ I am already recording **{channel}** in this server. Use `/stop` to end it first.',
  },
  'err.cannot-join': {
    pt: '🔒 Não tenho permissão para entrar em **{channel}** (preciso de Ver canal + Conectar).',
    en: '🔒 I do not have permission to join **{channel}** (I need View Channel + Connect).',
  },
  'err.no-recording': { pt: 'Não há nenhuma gravação em andamento. Use `/gravar` para começar.', en: 'No recording in progress. Use `/record` to start one.' },
  'err.join-failed': { pt: '❌ Não consegui entrar no canal de voz: {reason}', en: '❌ I could not join the voice channel: {reason}' },
  'err.invalid-channel': { pt: 'Esse canal não é um canal de voz.', en: 'That is not a voice channel.' },

  // fluxo de gravação
  'record.started': { pt: '🔴 Gravando **{channel}**! Painel da gravação: {panel}', en: '🔴 Recording **{channel}**! Recording panel: {panel}' },
  'record.started-no-panel': {
    pt: '🔴 Gravando **{channel}**!\n📥 Página da gravação: {url}\n(não consegui postar o painel no chat do canal de voz — confira minhas permissões)',
    en: '🔴 Recording **{channel}**!\n📥 Recording page: {url}\n(I could not post the panel in the voice channel chat — check my permissions)',
  },
  'record.stopped': { pt: '⏹️ Gravação encerrada. Página da gravação: {url}', en: '⏹️ Recording stopped. Recording page: {url}' },

  // painel
  'panel.title-recording': { pt: '🔴 Gravando — {channel}', en: '🔴 Recording — {channel}' },
  'panel.title-done': { pt: '⏹️ Gravação encerrada — {channel}', en: '⏹️ Recording finished — {channel}' },
  'panel.desc-recording': {
    pt: 'Iniciada {rel} por {starter}.\nUma faixa separada e sincronizada por pessoa.\n\n📥 **[Página da gravação]({url})** — dá pra baixar até durante a gravação.',
    en: 'Started {rel} by {starter}.\nOne separate, synchronized track per speaker.\n\n📥 **[Recording page]({url})** — you can download even while recording.',
  },
  'panel.desc-done': {
    pt: '**Duração:** {duration}\n**Participantes:** {participants}\n\n📥 **[Página da gravação]({url})**\n⏳ Expira em {expires}.',
    en: '**Duration:** {duration}\n**Participants:** {participants}\n\n📥 **[Recording page]({url})**\n⏳ Expires {expires}.',
  },
  'panel.no-participants': { pt: 'ninguém falou 🤷', en: 'nobody spoke 🤷' },
  'panel.field-id': { pt: 'ID', en: 'ID' },
  'panel.field-limit': { pt: 'Limite', en: 'Limit' },
  'panel.field-events': { pt: 'Eventos', en: 'Events' },
  'panel.btn-stop': { pt: 'Parar gravação', en: 'Stop recording' },
  'panel.btn-note': { pt: 'Adicionar nota', en: 'Add a note' },
  'panel.btn-page': { pt: 'Página da gravação', en: 'Recording page' },
  'panel.footer': { pt: 'Kassinão 🎙️', en: 'Kassinão 🎙️' },

  // DM para quem iniciou
  'dm.title-start': { pt: '🔴 Gravação iniciada', en: '🔴 Recording started' },
  'dm.desc-start': {
    pt: 'Estou gravando **{channel}** em **{guild}**.\n\n📥 **[Página da gravação]({url})** — downloads funcionam até durante a gravação.\n\n⏱️ Gravarei por até **{hours}h**. A gravação expira **{expiresDays} dias** após terminar.\n🔒 Só quem participou da call ou enxerga o canal consegue abrir o link.',
    en: 'I am recording **{channel}** in **{guild}**.\n\n📥 **[Recording page]({url})** — downloads work even while recording.\n\n⏱️ I will record for up to **{hours}h**. The recording expires **{expiresDays} days** after it ends.\n🔒 Only call participants or people who can see the channel can open the link.',
  },
  'dm.title-stop': { pt: '⏹️ Gravação encerrada', en: '⏹️ Recording finished' },
  'dm.desc-stop': {
    pt: '**{channel}** — duração **{duration}**.\n\n📥 **[Página da gravação]({url})**\n⏳ Expira em {expires}.',
    en: '**{channel}** — duration **{duration}**.\n\n📥 **[Recording page]({url})**\n⏳ Expires {expires}.',
  },

  // notas
  'note.modal-title': { pt: 'Adicionar nota à gravação', en: 'Add a note to the recording' },
  'note.modal-label': { pt: 'Nota (marcada no tempo atual)', en: 'Note (marked at the current time)' },
  'note.added': { pt: '📝 Nota adicionada em `{offset}`!', en: '📝 Note added at `{offset}`!' },
  'note.discarded': {
    pt: '⚠️ A nota não entrou — a gravação estava encerrando (ou o texto ficou vazio).',
    en: '⚠️ The note was not added — the recording was stopping (or the text was empty).',
  },
  'note.no-access': {
    pt: '🔒 Só quem enxerga o canal **{channel}** pode anotar nesta gravação.',
    en: '🔒 Only people who can see **{channel}** can add notes to this recording.',
  },

  // eventos do log
  'event.started': { pt: '▶️ Gravação iniciada por {name}', en: '▶️ Recording started by {name}' },
  'event.started-auto': { pt: '▶️ Gravação iniciada automaticamente (auto-record)', en: '▶️ Recording started automatically (auto-record)' },
  'event.joined': { pt: '🎤 {name} entrou na gravação', en: '🎤 {name} joined the recording' },
  'event.silence': { pt: '🔇 Ninguém fala há 5 minutos', en: '🔇 Nobody has spoken for 5 minutes' },
  'event.stopped-manual': { pt: '⏹️ {name} parou a gravação', en: '⏹️ {name} stopped the recording' },
  'event.stopped-tempo-maximo': { pt: '⏹️ Limite de {hours}h atingido — gravação encerrada', en: '⏹️ {hours}h limit reached — recording stopped' },
  'event.stopped-canal-vazio': { pt: '⏹️ Canal esvaziou — gravação encerrada', en: '⏹️ Channel became empty — recording stopped' },
  'event.stopped-desconectado': { pt: '⏹️ Fui desconectado do canal — gravação encerrada', en: '⏹️ I was disconnected — recording stopped' },
  'event.stopped-reinicio': { pt: '⏹️ Encerrada por reinício do bot', en: '⏹️ Stopped due to bot restart' },
  'event.no-nickname': {
    pt: '⚠️ Sem permissão "Alterar apelido" — gravando sem o indicador [GRAVANDO]',
    en: '⚠️ Missing "Change Nickname" permission — recording without the [RECORDING] indicator',
  },

  // transcrição
  'transcript.ready': { pt: '📝 Transcrição pronta: {url}', en: '📝 Transcript ready: {url}' },
  'transcript.failed': { pt: '⚠️ A transcrição falhou: {error}', en: '⚠️ Transcription failed: {error}' },

  // status
  'status.none': { pt: '💤 Nenhuma gravação em andamento.', en: '💤 No recording in progress.' },
  'status.recording': {
    pt: '🔴 Gravando **{channel}** há **{duration}**.\n{speakers}\n📥 Página: {url}',
    en: '🔴 Recording **{channel}** for **{duration}**.\n{speakers}\n📥 Page: {url}',
  },
  'status.speakers': { pt: 'Falaram até agora: {names}', en: 'Spoke so far: {names}' },
  'status.no-speakers': { pt: 'Ninguém falou ainda.', en: 'Nobody spoke yet.' },

  // /gravacoes
  'recordings.none': { pt: 'Nenhuma gravação encontrada neste servidor.', en: 'No recordings found in this server.' },
  'recordings.title': { pt: '🎙️ Últimas gravações deste servidor', en: '🎙️ Latest recordings in this server' },
  'recordings.live': { pt: '(ao vivo)', en: '(live)' },

  // /autorecord
  'autorecord.only-voice': { pt: 'Escolha um canal de voz.', en: 'Pick a voice channel.' },
  'autorecord.no-permission': {
    pt: 'Você precisa da permissão **Gerenciar Servidor** para configurar o auto-record.',
    en: 'You need the **Manage Server** permission to configure auto-record.',
  },
  'autorecord.enabled': {
    pt: '✅ Auto-record ligado em **{channel}**: começo a gravar quando **{min}+** pessoa(s) entrarem e paro quando esvaziar.',
    en: '✅ Auto-record enabled in **{channel}**: I start recording when **{min}+** person(s) join and stop when it empties.',
  },
  'autorecord.disabled': { pt: '🛑 Auto-record desligado em **{channel}**.', en: '🛑 Auto-record disabled in **{channel}**.' },
  'autorecord.not-set': { pt: 'Não havia auto-record configurado em **{channel}**.', en: 'There was no auto-record configured in **{channel}**.' },
  'autorecord.view-none': { pt: 'Nenhum auto-record configurado neste servidor.', en: 'No auto-record configured in this server.' },
  'autorecord.view-title': { pt: '🤖 Auto-record deste servidor', en: '🤖 Auto-record in this server' },
  'autorecord.view-line': { pt: '{channel} — mínimo de {min} pessoa(s)', en: '{channel} — minimum {min} person(s)' },
};

export function t(locale: Locale, key: string, vars: Record<string, string | number> = {}): string {
  const entry = STRINGS[key];
  let text = entry ? entry[locale] : key;
  for (const [name, value] of Object.entries(vars)) {
    // função como replacement: nomes de usuário contendo "$&" etc. não corrompem o texto
    text = text.replaceAll(`{${name}}`, () => String(value));
  }
  return text;
}
