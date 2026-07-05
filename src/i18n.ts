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
  'err.generic': {
    pt: '❌ Deu ruim aqui do meu lado. Tenta de novo?',
    en: '❌ Something went wrong on my end. Try again?',
  },
  'err.guild-only': {
    pt: 'Esse comando só funciona dentro de um servidor.',
    en: 'This command only works inside a server.',
  },
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
  'err.no-recording': {
    pt: 'Não há nenhuma gravação em andamento. Use `/gravar` para começar.',
    en: 'No recording in progress. Use `/record` to start one.',
  },
  'err.join-failed': {
    pt: '❌ Não consegui entrar no canal de voz: {reason}',
    en: '❌ I could not join the voice channel: {reason}',
  },
  'err.invalid-channel': { pt: 'Esse canal não é um canal de voz.', en: 'That is not a voice channel.' },

  // fluxo de gravação
  'record.started': {
    pt: '🔴 Pronto, tô gravando **{channel}**! Postei o painel aqui 👉 {panel}',
    en: "🔴 All set — I'm recording **{channel}**! I posted the panel here 👉 {panel}",
  },
  'record.started-no-panel': {
    pt: '🔴 Tô gravando **{channel}**!\n📥 Página da gravação: {url}\n_(não consegui postar o painel no chat do canal de voz — dá uma olhada nas minhas permissões)_',
    en: "🔴 I'm recording **{channel}**!\n📥 Recording page: {url}\n_(I couldn't post the panel in the voice channel chat — check my permissions)_",
  },
  'record.stopped': {
    pt: '⏹️ Encerrei! Em ~1 min a **ata** e a **transcrição** ficam prontas aqui 👉 {url}',
    en: '⏹️ Done! In ~1 min the **minutes** and **transcript** will be ready here 👉 {url}',
  },

  // painel
  'panel.title-recording': { pt: '🔴 Gravando • {channel}', en: '🔴 Recording • {channel}' },
  'panel.title-done': { pt: '✅ Gravação encerrada • {channel}', en: '✅ Recording finished • {channel}' },
  // saudação amigável (texto acima do painel) — deixa o time à vontade e explica o que rola
  'panel.greeting-recording': {
    pt: '👋 Oi, pessoal! Estou **gravando este canal** — no final eu gero a **ata** e a **transcrição** sozinho. 🔒 Só quem participa da call ou enxerga o canal consegue abrir depois.',
    en: "👋 Hey everyone! I'm **recording this channel** — I'll generate the **minutes** and **transcript** myself at the end. 🔒 Only people in the call or who can see the channel can open it afterward.",
  },
  'panel.greeting-done': {
    pt: '✅ **Gravação encerrada!** Já tô preparando a transcrição e a ata — fica pronto em ~1 min. 🙌',
    en: "✅ **Recording finished!** I'm putting together the transcript and minutes now — ready in ~1 min. 🙌",
  },
  'panel.by-user': { pt: 'a pedido de {user}', en: 'requested by {user}' },
  'panel.by-auto': { pt: 'automaticamente (auto-record)', en: 'automatically (auto-record)' },
  'panel.desc-recording': {
    pt: 'Comecei {rel}, {starter}.\n\n🎧 Uma faixa separada e sincronizada por pessoa\n🤖 Transcrição e ata geradas sozinhas no final\n📥 **[Abrir a página da gravação]({url})** — dá pra acompanhar e baixar até durante a call',
    en: 'Started {rel}, {starter}.\n\n🎧 One separate, synced track per person\n🤖 Transcript and minutes generated automatically at the end\n📥 **[Open the recording page]({url})** — follow along and download even during the call',
  },
  'panel.desc-done': {
    pt: 'Durou **{duration}** • Participaram: {participants}\n\n📥 **[Abrir a gravação]({url})** — áudio, transcrição e ata\n⏳ Disponível até {expires}',
    en: 'Lasted **{duration}** • Participants: {participants}\n\n📥 **[Open the recording]({url})** — audio, transcript and minutes\n⏳ Available until {expires}',
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
    pt: 'Comecei a gravar **{channel}** em **{guild}**. 👍\n\n📥 **[Página da gravação]({url})** — dá pra baixar até durante a call.\n⏱️ Gravo por até **{hours}h** • fica disponível por **{expiresDays} dias** depois de terminar.\n🔒 Só quem participou ou enxerga o canal abre o link.',
    en: 'I started recording **{channel}** in **{guild}**. 👍\n\n📥 **[Recording page]({url})** — you can download even during the call.\n⏱️ I record for up to **{hours}h** • it stays available for **{expiresDays} days** after it ends.\n🔒 Only participants or people who can see the channel can open the link.',
  },
  'dm.title-stop': { pt: '✅ Gravação encerrada', en: '✅ Recording finished' },
  'dm.desc-stop': {
    pt: 'Fechei a gravação de **{channel}** — durou **{duration}**. ✅\n\n📥 **[Abrir a gravação]({url})** — áudio, transcrição e ata em ~1 min.\n⏳ Disponível até {expires}.',
    en: 'I wrapped up the **{channel}** recording — it lasted **{duration}**. ✅\n\n📥 **[Open the recording]({url})** — audio, transcript and minutes in ~1 min.\n⏳ Available until {expires}.',
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
  'event.started-auto': {
    pt: '▶️ Gravação iniciada automaticamente (auto-record)',
    en: '▶️ Recording started automatically (auto-record)',
  },
  'event.joined': { pt: '🎤 {name} entrou na gravação', en: '🎤 {name} joined the recording' },
  'event.silence': { pt: '🔇 Ninguém fala há 5 minutos', en: '🔇 Nobody has spoken for 5 minutes' },
  'event.stopped-manual': { pt: '⏹️ {name} parou a gravação', en: '⏹️ {name} stopped the recording' },
  'event.stopped-tempo-maximo': {
    pt: '⏹️ Limite de {hours}h atingido — gravação encerrada',
    en: '⏹️ {hours}h limit reached — recording stopped',
  },
  'event.stopped-canal-vazio': {
    pt: '⏹️ Canal esvaziou — gravação encerrada',
    en: '⏹️ Channel became empty — recording stopped',
  },
  'event.stopped-desconectado': {
    pt: '⏹️ Fui desconectado do canal — gravação encerrada',
    en: '⏹️ I was disconnected — recording stopped',
  },
  'event.stopped-reinicio': { pt: '⏹️ Encerrada por reinício do bot', en: '⏹️ Stopped due to bot restart' },
  'event.stopped-disco-cheio': {
    pt: '⏹️ Espaço em disco acabando — encerrei pra não corromper a gravação',
    en: '⏹️ Disk almost full — I stopped to avoid corrupting the recording',
  },
  'event.no-nickname': {
    pt: '⚠️ Sem permissão "Alterar apelido" — gravando sem o indicador [GRAVANDO]',
    en: '⚠️ Missing "Change Nickname" permission — recording without the [RECORDING] indicator',
  },

  // transcrição
  'transcript.ready': {
    pt: '📝 Transcrição pronta! Já está na página 👉 {url}',
    en: '📝 Transcript ready! It’s on the page now 👉 {url}',
  },
  'transcript.failed': {
    pt: '⚠️ Não consegui transcrever desta vez: {error}\nO áudio continua disponível na página, viu?',
    en: '⚠️ I couldn’t transcribe this time: {error}\nThe audio is still available on the page.',
  },
  'minutes.ready': {
    pt: '📋 Prontinho! A **ata** e a **transcrição** já estão na página 👉 {url}',
    en: '📋 All done! The **minutes** and **transcript** are on the page 👉 {url}',
  },

  // onboarding / ajuda
  'help.title': { pt: '🎙️ Kassinão — como usar', en: '🎙️ Kassinão — how to use' },
  'help.intro': {
    pt: 'Eu gravo o seu canal de voz com **uma faixa separada por pessoa** e, depois, gero **transcrição** e **ata** (resumo + tarefas + decisões) automaticamente.',
    en: 'I record your voice channel with **one separate track per person** and then generate **transcript** and **minutes** (summary + tasks + decisions) automatically.',
  },
  'help.commands': { pt: 'Comandos', en: 'Commands' },
  'help.cmd-list': {
    pt: '**/gravar** — entra no seu canal de voz e começa a gravar\n**/parar** — encerra e gera o link com áudio, transcrição e ata\n**/nota** — marca uma anotação no momento atual da call\n**/status** — mostra a gravação em andamento\n**/gravacoes** — lista suas últimas gravações com os links\n**/autorecord** — (admin) grava sozinho quando entram pessoas num canal',
    en: '**/record** — joins your voice channel and starts recording\n**/stop** — ends it and generates the link with audio, transcript and minutes\n**/note** — marks a note at the current time of the call\n**/status** — shows the recording in progress\n**/recordings** — lists your latest recordings with links\n**/autorecord** — (admin) records automatically when people join a channel',
  },
  'help.flow': { pt: 'Passo a passo', en: 'Quick start' },
  'help.flow-body': {
    pt: '1. Entre num canal de voz e use **/gravar**\n2. Conversem normalmente (o painel mostra quem entrou)\n3. Use **/parar** — em ~1 min chega o link pronto\n4. Abra o link, faça login com Discord e baixe/leia a ata',
    en: '1. Join a voice channel and use **/record**\n2. Talk normally (the panel shows who joined)\n3. Use **/stop** — in ~1 min the ready link arrives\n4. Open the link, log in with Discord and download/read the minutes',
  },
  'help.privacy': { pt: '🔒 Privacidade', en: '🔒 Privacy' },
  'help.privacy-body': {
    pt: 'Só quem participou da call, enxerga o canal ou é admin consegue abrir as gravações (protegido por login). Em canais **restritos**, me libere no canal (permissão Ver Canal + Conectar) para eu poder gravar.',
    en: 'Only call participants, people who can see the channel, or admins can open recordings (login-protected). In **restricted** channels, grant me access (View Channel + Connect) so I can record.',
  },
  'help.footer': { pt: 'Kassinão 🎙️ • use /ajuda a qualquer momento', en: 'Kassinão 🎙️ • use /help anytime' },
  // botões e tópicos do /ajuda (onboarding interativo)
  'help.btn-record': { pt: '🎥 Como gravar', en: '🎥 How to record' },
  'help.btn-downloads': { pt: '📥 Downloads e ata', en: '📥 Downloads & minutes' },
  'help.btn-privacy': { pt: '🔒 Privacidade', en: '🔒 Privacy' },
  'help.btn-auto': { pt: '🤖 Auto-record', en: '🤖 Auto-record' },
  'help.topic-record': {
    pt: '🎥 **Como gravar**\n1. Entre num canal de voz.\n2. Digite **/gravar** (eu entro e apareço como `[GRAVANDO]`).\n3. Conversem normalmente. No painel do canal dá pra clicar em **Adicionar nota** pra marcar um momento importante (ou use **/nota**).\n4. Digite **/parar** (ou o botão do painel).\n5. Em ~1 min chega o link com áudio, transcrição e ata.',
    en: '🎥 **How to record**\n1. Join a voice channel.\n2. Type **/record** (I join and show as `[RECORDING]`).\n3. Talk normally. On the channel panel you can click **Add a note** to mark an important moment (or use **/note**).\n4. Type **/stop** (or the panel button).\n5. In ~1 min the link with audio, transcript and minutes arrives.',
  },
  'help.topic-downloads': {
    pt: '📥 **Downloads e ata**\nNa página da gravação você tem:\n• **MP3 / FLAC** — uma faixa por pessoa\n• **Mix** — todo mundo num arquivo só\n• **Audacity** — projeto pronto pra editar\n• **📝 Transcrição** — com o nome de quem falou e horários clicáveis\n• **📋 Ata** — resumo, decisões, tarefas e o que cada um trouxe\n• **🔊 Player** — ouça ali mesmo e clique num horário pra pular',
    en: '📥 **Downloads & minutes**\nOn the recording page you get:\n• **MP3 / FLAC** — one track per person\n• **Mix** — everyone in one file\n• **Audacity** — ready-to-edit project\n• **📝 Transcript** — with speaker names and clickable timestamps\n• **📋 Minutes** — summary, decisions, tasks and per-person points\n• **🔊 Player** — listen right there and click a timestamp to jump',
  },
  'help.topic-privacy': {
    pt: '🔒 **Privacidade e acesso**\n• As gravações só abrem com login no Discord.\n• Só acessa quem **participou da call**, **enxerga o canal**, **iniciou** ou é **admin**.\n• Em canais **restritos**, me libere no canal (permissão **Ver Canal + Conectar**) pra eu poder entrar.\n• Cada gravação expira automaticamente e pode ser apagada pela página.',
    en: '🔒 **Privacy & access**\n• Recordings only open with Discord login.\n• Access only for whoever **joined the call**, **can see the channel**, **started it** or is an **admin**.\n• In **restricted** channels, grant me access (**View Channel + Connect**) so I can join.\n• Each recording auto-expires and can be deleted from its page.',
  },
  'help.topic-auto': {
    pt: '🤖 **Auto-record** (só admin)\n**/autorecord ligar canal:#daily minimo:2** — eu começo a gravar sozinho quando 2+ pessoas entram no canal, e paro quando esvazia.\n**/autorecord desligar canal:#daily** — desliga.\n**/autorecord ver** — mostra o que está configurado.',
    en: '🤖 **Auto-record** (admin only)\n**/autorecord on channel:#daily minimum:2** — I start recording by myself when 2+ people join, and stop when it empties.\n**/autorecord off channel:#daily** — turns it off.\n**/autorecord view** — shows what is configured.',
  },
  'help.dm-hint': {
    pt: 'Sou um bot de gravação — me use pelos **comandos dentro do servidor**. Aqui vai o guia rápido:',
    en: "I'm a recording bot — use me via the **commands inside the server**. Here's the quick guide:",
  },
  'welcome.title': { pt: '👋 Obrigado por me adicionar!', en: '👋 Thanks for adding me!' },
  'welcome.body': {
    pt: 'Eu sou o **Kassinão** 🎙️ — gravo suas calls do Discord com **uma faixa por pessoa** e gero **transcrição** e **ata** (resumo, decisões e tarefas) automaticamente.\n\n**Pra começar:** entre num canal de voz e use **/gravar**. Quer ver tudo que eu faço? **/ajuda**.\n\n🔒 Em canais restritos, me dê acesso ao canal (Ver Canal + Conectar) pra eu conseguir entrar.',
    en: "I'm **Kassinão** 🎙️ — I record your Discord calls with **one track per person** and auto-generate **transcript** and **minutes** (summary, decisions and tasks).\n\n**To start:** join a voice channel and use **/record**. Want the full tour? **/help**.\n\n🔒 In restricted channels, grant me channel access (View Channel + Connect) so I can join.",
  },

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
  'autorecord.disabled': {
    pt: '🛑 Auto-record desligado em **{channel}**.',
    en: '🛑 Auto-record disabled in **{channel}**.',
  },
  'autorecord.not-set': {
    pt: 'Não havia auto-record configurado em **{channel}**.',
    en: 'There was no auto-record configured in **{channel}**.',
  },
  'autorecord.view-none': {
    pt: 'Nenhum auto-record configurado neste servidor.',
    en: 'No auto-record configured in this server.',
  },
  'autorecord.view-title': { pt: '🤖 Auto-record deste servidor', en: '🤖 Auto-record in this server' },
  'autorecord.view-line': { pt: '{channel} — mínimo de {min} pessoa(s)', en: '{channel} — minimum {min} person(s)' },

  // MCP (conector de IA)
  'mcp.web-only': {
    pt: '🔌 Para conectar seu assistente de IA, abra {url} e entre com o Discord (é self-serve, com o seu acesso).',
    en: '🔌 To connect your AI assistant, open {url} and sign in with Discord (self-serve, scoped to you).',
  },
  'mcp.new': {
    pt: '🔌 **Conectar assistente de IA** (código válido por ~5 min, uso único):\n```\nnpx -y @kassinao/mcp exchange {code}\n```\nDepois cole a config que o comando imprimir no Claude Desktop/Cursor. Ou, mais fácil, use {url}/conectar-ia no navegador.',
    en: '🔌 **Connect your AI assistant** (code valid ~5 min, single use):\n```\nnpx -y @kassinao/mcp exchange {code}\n```\nThen paste the config it prints into Claude Desktop/Cursor. Or, easier, use {url}/conectar-ia in the browser.',
  },
  'mcp.revoked': {
    pt: '🔒 Pronto — revoguei {n} conector(es) de IA seu(s). Os tokens deixaram de funcionar na hora.',
    en: '🔒 Done — revoked {n} of your AI connector(s). The tokens stopped working immediately.',
  },
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
