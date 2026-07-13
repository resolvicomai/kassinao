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
  'err.recording-starting': {
    pt: '⏳ Já estou iniciando uma gravação em **{channel}**. Não criei outra.',
    en: '⏳ I am already starting a recording in **{channel}**. I did not create another one.',
  },
  'err.recording-stopping': {
    pt: '⏳ A gravação anterior ainda está sendo encerrada. Espere a confirmação antes de começar outra.',
    en: '⏳ The previous recording is still stopping. Wait for confirmation before starting another one.',
  },
  'err.recording-busy': {
    pt: '⚠️ O gravador deste servidor já está ocupado. Não criei outra gravação.',
    en: '⚠️ This server recorder is already busy. I did not create another recording.',
  },
  'err.recording-start-limited': {
    pt: '⏳ Muitas gravações foram iniciadas recentemente. Tente de novo em {wait}. Um admin pode iniciar sem esse limite.',
    en: '⏳ Too many recordings were started recently. Try again in {wait}. An admin can start without this limit.',
  },
  'err.record-no-access': {
    pt: '🔒 Você não pode iniciar uma gravação em **{channel}** porque não enxerga esse canal.',
    en: '🔒 You cannot start a recording in **{channel}** because you cannot see that channel.',
  },
  'err.must-join-target': {
    pt: '🎧 Para gravar **{channel}**, entre nesse canal primeiro. Só quem gerencia o servidor pode iniciar uma gravação remotamente.',
    en: '🎧 Join **{channel}** before recording it. Only people who manage the server can start a recording remotely.',
  },
  'err.cannot-record-here': {
    pt: '🔒 Não consigo gravar em **{channel}** com aviso visível e recuperável. Preciso de Ver Canal, Conectar, Enviar Mensagens, Inserir Links e Ler Histórico de Mensagens.',
    en: '🔒 I cannot record in **{channel}** with a visible, recoverable notice. I need View Channel, Connect, Send Messages, Embed Links, and Read Message History.',
  },
  'err.stale-control': {
    pt: '⌛ Esse botão pertence a uma gravação antiga e não controla a call atual.',
    en: '⌛ This button belongs to an older recording and cannot control the current call.',
  },
  'err.cannot-join': {
    pt: '🔒 Não tenho permissão para entrar em **{channel}** (preciso de Ver canal + Conectar).',
    en: '🔒 I do not have permission to join **{channel}** (I need View Channel + Connect).',
  },
  'err.no-recording': {
    pt: 'Não há nenhuma gravação em andamento. Use `/gravar` para começar.',
    en: 'No recording in progress. Use `/record` to start one.',
  },
  'err.stop-no-access': {
    pt: '🔒 Só quem enxerga o canal **{channel}** (ou o admin) pode encerrar esta gravação.',
    en: '🔒 Only people who can see **{channel}** (or an admin) can stop this recording.',
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
  'record.stopped-empty': {
    pt: '⏹️ Encerrei, mas ninguém falou nessa — então não vou gerar transcrição nem ata. Se foi engano, é só gravar de novo. 🙂',
    en: "⏹️ Stopped, but nobody spoke — so there's no transcript or minutes to generate. If that was a mistake, just record again. 🙂",
  },
  'record.stopped-incomplete': {
    pt: '⚠️ Encerrei, mas pelo menos uma faixa não fechou limpa. Preservei o áudio recuperável e sinalizei a gravação aqui: {url}',
    en: '⚠️ Stopped, but at least one track did not close cleanly. I preserved recoverable audio and flagged the recording here: {url}',
  },
  'record.start-cancelled': {
    pt: '🛑 Cancelei a inicialização. Nenhum áudio foi gravado.',
    en: '🛑 I cancelled startup. No audio was recorded.',
  },
  'record.start-failed': {
    pt: '❌ Não consegui iniciar a gravação. Tenta de novo daqui a pouco.',
    en: "❌ I couldn't start the recording. Try again in a moment.",
  },
  'record.stopping': {
    pt: '⏳ Essa gravação já está sendo encerrada. Não vou finalizar duas vezes.',
    en: '⏳ This recording is already stopping. I will not finalize it twice.',
  },
  'record.stop-failed': {
    pt: '⚠️ A captura parou, mas houve uma falha ao fechar todos os arquivos. Preservei o que consegui aqui: {url}',
    en: '⚠️ Capture stopped, but some files failed to close cleanly. I preserved what I could here: {url}',
  },
  'record.stopped-link-incomplete': {
    pt: '⚠️ Gravação encerrada após **{duration}**, mas uma faixa pode estar parcial. Preservei o que foi possível: {url}',
    en: '⚠️ Recording stopped after **{duration}**, but one track may be partial. I preserved what was recoverable: {url}',
  },

  // painel
  'panel.title-recording': { pt: '🔴 Gravando • {channel}', en: '🔴 Recording • {channel}' },
  'panel.title-done': { pt: '✅ Gravação encerrada • {channel}', en: '✅ Recording finished • {channel}' },
  // saudação amigável (texto acima do painel) — deixa o time à vontade e explica o que rola
  'panel.greeting-recording': {
    pt: '👋 Oi, pessoal! Estou **gravando este canal** — no final eu gero a **ata** e a **transcrição** sozinho. 🔒 Só participantes, quem iniciou e admins atuais abrem depois; é preciso continuar no servidor.',
    en: "👋 Hey everyone! I'm **recording this channel** — I'll generate the **minutes** and **transcript** myself at the end. 🔒 Only participants, the starter, and current admins can open it later; server membership is still required.",
  },
  'panel.greeting-done': {
    pt: '✅ **Gravação encerrada!** Já tô preparando a transcrição e a ata — fica pronto em ~1 min. 🙌',
    en: "✅ **Recording finished!** I'm putting together the transcript and minutes now — ready in ~1 min. 🙌",
  },
  'panel.greeting-done-empty': {
    pt: '⏹️ **Gravação encerrada.** Ninguém falou, então não há transcrição nem ata — só gravar de novo quando quiser. 🙂',
    en: "⏹️ **Recording finished.** Nobody spoke, so there's no transcript or minutes — just record again anytime. 🙂",
  },
  'panel.greeting-done-incomplete': {
    pt: '⚠️ **Gravação encerrada com áudio parcial.** Pelo menos uma faixa não fechou limpa; preservei o que foi possível na página.',
    en: '⚠️ **Recording finished with partial audio.** At least one track did not close cleanly; I preserved what was recoverable on the page.',
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
  'panel.desc-done-unlimited': {
    pt: 'Durou **{duration}** • Participaram: {participants}\n\n📥 **[Abrir a gravação]({url})** — áudio, transcrição e ata\n♾️ Fica guardada até alguém apagar',
    en: 'Lasted **{duration}** • Participants: {participants}\n\n📥 **[Open the recording]({url})** — audio, transcript and minutes\n♾️ Kept until someone deletes it',
  },
  'panel.no-participants': { pt: 'ninguém falou 🤷', en: 'nobody spoke 🤷' },
  'panel.field-id': { pt: 'ID', en: 'ID' },
  'panel.field-limit': { pt: 'Limite', en: 'Limit' },
  'panel.field-events': { pt: 'Eventos', en: 'Events' },
  'panel.btn-stop': { pt: 'Parar gravação', en: 'Stop recording' },
  'panel.btn-note': { pt: 'Adicionar nota', en: 'Add a note' },
  'panel.btn-mark': { pt: 'Marcar momento', en: 'Mark moment' },
  'panel.btn-page': { pt: 'Página da gravação', en: 'Recording page' },
  'panel.footer': { pt: 'Kassinão 🎙️', en: 'Kassinão 🎙️' },
  'panel.recovered-after-restart': {
    pt: '⏹️ **A gravação foi encerrada por um reinício do bot.** Removi os controles antigos para eles não afetarem outra call.\n📥 {url}',
    en: '⏹️ **The recording was stopped by a bot restart.** I removed the old controls so they cannot affect another call.\n📥 {url}',
  },

  // DM para quem iniciou
  'dm.title-start': { pt: '🔴 Gravação iniciada', en: '🔴 Recording started' },
  'dm.desc-start': {
    pt: 'Comecei a gravar **{channel}** em **{guild}**. 👍\n\n📥 **[Página da gravação]({url})** — dá pra baixar até durante a call.\n⏱️ Gravo por até **{hours}h** • fica disponível por **{expiresDays} dias** depois de terminar.\n🔒 Só participantes, quem iniciou e admins atuais abrem; é preciso continuar no servidor.',
    en: 'I started recording **{channel}** in **{guild}**. 👍\n\n📥 **[Recording page]({url})** — you can download even during the call.\n⏱️ I record for up to **{hours}h** • it stays available for **{expiresDays} days** after it ends.\n🔒 Only participants, the starter, and current admins can open it; server membership is still required.',
  },
  'dm.desc-start-unlimited': {
    pt: 'Comecei a gravar **{channel}** em **{guild}**. 👍\n\n📥 **[Página da gravação]({url})** — dá pra baixar até durante a call.\n⏱️ Gravo por até **{hours}h** • a gravação **fica guardada até alguém apagar**.\n🔒 Só participantes, quem iniciou e admins atuais abrem; é preciso continuar no servidor.',
    en: 'I started recording **{channel}** in **{guild}**. 👍\n\n📥 **[Recording page]({url})** — you can download even during the call.\n⏱️ I record for up to **{hours}h** • the recording is **kept until someone deletes it**.\n🔒 Only participants, the starter, and current admins can open it; server membership is still required.',
  },
  'dm.title-stop': { pt: '✅ Gravação encerrada', en: '✅ Recording finished' },
  'dm.desc-stop': {
    pt: 'Fechei a gravação de **{channel}** — durou **{duration}**. ✅\n\n📥 **[Abrir a gravação]({url})** — áudio, transcrição e ata em ~1 min.\n⏳ Disponível até {expires}.',
    en: 'I wrapped up the **{channel}** recording — it lasted **{duration}**. ✅\n\n📥 **[Open the recording]({url})** — audio, transcript and minutes in ~1 min.\n⏳ Available until {expires}.',
  },
  'dm.desc-stop-unlimited': {
    pt: 'Fechei a gravação de **{channel}** — durou **{duration}**. ✅\n\n📥 **[Abrir a gravação]({url})** — áudio, transcrição e ata em ~1 min.\n♾️ Fica guardada até alguém apagar.',
    en: 'I wrapped up the **{channel}** recording — it lasted **{duration}**. ✅\n\n📥 **[Open the recording]({url})** — audio, transcript and minutes in ~1 min.\n♾️ Kept until someone deletes it.',
  },
  'dm.desc-stop-empty': {
    pt: 'Fechei a gravação de **{channel}** — mas ninguém falou, então não gerei transcrição nem ata. Se foi engano, é só gravar de novo. 🙂',
    en: "I wrapped up the **{channel}** recording — but nobody spoke, so I didn't generate a transcript or minutes. If that was a mistake, just record again. 🙂",
  },
  'dm.desc-stop-incomplete': {
    pt: 'Fechei a gravação de **{channel}**, mas pelo menos uma faixa ficou incompleta. Preservei o que deu e sinalizei o problema aqui: {url}',
    en: 'I closed the **{channel}** recording, but at least one track is incomplete. I preserved what I could and flagged the problem here: {url}',
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
  'note.mark-text': { pt: '📌 momento marcado', en: '📌 moment marked' },
  'note.marked': {
    pt: '📌 Momento **{offset}** marcado! Ele vira um marcador na página e entra na ata.',
    en: '📌 Moment **{offset}** marked! It becomes a marker on the page and goes into the minutes.',
  },
  'note.mark-duplicate': {
    pt: '📌 Esse clique já entrou. Ignorei a repetição para não criar dois marcadores iguais.',
    en: '📌 That click was already recorded. I ignored the repeat to avoid duplicate markers.',
  },

  // /config (por servidor)
  'config.no-permission': {
    pt: '🔒 Configurar o Kassinão exige a permissão **Gerenciar Servidor**.',
    en: '🔒 Configuring Kassinão requires the **Manage Server** permission.',
  },
  'config.title': { pt: '⚙️ Configuração deste servidor', en: '⚙️ This server’s configuration' },
  'config.minutes-channel-set': {
    pt: '✅ A ata resumida de cada reunião será postada em {channel} (além do chat do canal de voz pro aviso).',
    en: '✅ The minutes summary of each meeting will be posted in {channel} (the voice channel chat still gets the notice).',
  },
  'config.minutes-channel-cleared': {
    pt: '✅ Canal de ata removido — a ata volta a ser postada só no chat do canal de voz.',
    en: '✅ Minutes channel cleared — summaries go back to the voice channel chat only.',
  },
  'config.view-minutes-channel': { pt: '📋 Canal da ata: {channel}', en: '📋 Minutes channel: {channel}' },
  'config.view-minutes-channel-none': {
    pt: '📋 Canal da ata: *(não configurado — vai pro chat do canal de voz)*',
    en: '📋 Minutes channel: *(not set — goes to the voice channel chat)*',
  },

  // /perguntar (RAG nas reuniões)
  'ask.disabled': {
    pt: '🤖 O /perguntar precisa da ata por IA habilitada (OPENROUTER_API_KEY ou GROQ_API_KEY no servidor do bot).',
    en: '🤖 /ask needs AI minutes enabled (OPENROUTER_API_KEY or GROQ_API_KEY on the bot server).',
  },
  'ask.no-meetings': {
    pt: '🔇 Não encontrei nenhuma reunião transcrita que você possa acessar nos últimos {days} dias.',
    en: '🔇 I found no transcribed meetings you can access in the last {days} days.',
  },
  'ask.no-period': {
    pt: '🔇 Não encontrei nenhuma reunião transcrita que você possa acessar no período **{period}**.',
    en: '🔇 I found no transcribed meetings you can access in **{period}**.',
  },
  'ask.no-evidence': {
    pt: '🔎 Encontrei reuniões nesse período, mas não achei evidência suficiente para responder com segurança.',
    en: '🔎 I found meetings in that period, but not enough evidence to answer safely.',
  },
  'ask.busy': {
    pt: '⏳ Já estou processando o limite de perguntas agora. Tente de novo em instantes.',
    en: '⏳ I am already processing the current question limit. Try again in a moment.',
  },
  'ask.rate-limit': {
    pt: '⏳ O limite temporário do /perguntar foi atingido. Tente novamente mais tarde.',
    en: '⏳ The temporary /ask limit was reached. Try again later.',
  },
  'ask.error': {
    pt: '⚠️ Não consegui responder agora: {error}',
    en: '⚠️ I could not answer right now: {error}',
  },
  'ask.footer': {
    pt: '-# Período: {period}. Baseado em {n} reunião(ões) que você pode acessar. Os links abrem a ata ou o segundo exato.',
    en: '-# Period: {period}. Based on {n} meeting(s) you can access. Links open the minutes or exact second.',
  },
  'ask.period-days': { pt: 'últimos {days} dias', en: 'last {days} days' },

  // eventos do log
  'event.started': { pt: '▶️ Gravação iniciada por {name}', en: '▶️ Recording started by {name}' },
  'event.started-auto': {
    pt: '▶️ Gravação iniciada automaticamente (auto-record)',
    en: '▶️ Recording started automatically (auto-record)',
  },
  'event.joined': { pt: '🎤 {name} falou pela primeira vez', en: '🎤 {name} spoke for the first time' },
  'event.present-initial': { pt: '👥 Na call: {names}', en: '👥 In the call: {names}' },
  'event.voice-joined': { pt: '🔊 {name} entrou na call', en: '🔊 {name} joined the call' },
  'event.voice-left': { pt: '🚪 {name} saiu da call', en: '🚪 {name} left the call' },
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
  'event.stopped-abaixo-minimo': {
    pt: '⏹️ O canal ficou abaixo do mínimo do auto-record — gravação encerrada',
    en: '⏹️ The channel dropped below the auto-record minimum — recording stopped',
  },
  'event.stopped-desconectado': {
    pt: '⏹️ Fui desconectado do canal — gravação encerrada',
    en: '⏹️ I was disconnected — recording stopped',
  },
  'event.stopped-canal-alterado': {
    pt: '⏹️ Fui movido para outro canal — encerrei para não misturar áudio e permissões',
    en: '⏹️ I was moved to another channel — stopped to avoid mixing audio and permissions',
  },
  'event.stopped-reinicio': { pt: '⏹️ Encerrada por reinício do bot', en: '⏹️ Stopped due to bot restart' },
  'event.stopped-disco-cheio': {
    pt: '⏹️ Espaço em disco acabando — encerrei pra não corromper a gravação',
    en: '⏹️ Disk almost full — I stopped to avoid corrupting the recording',
  },
  'event.track-cap': {
    pt: '⚠️ Limite de {max} faixas atingido — novos falantes não estão sendo gravados nesta sessão',
    en: '⚠️ {max}-track limit reached — new speakers are not being recorded in this session',
  },
  'event.audio-incomplete': {
    pt: '⚠️ Pelo menos uma faixa de áudio não fechou limpa e pode estar parcial',
    en: '⚠️ At least one audio track did not close cleanly and may be partial',
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
  'record.stopped-link': {
    pt: '⏹️ Gravação encerrada (**{duration}**). Áudio já disponível — transcrição e ata chegam aqui em alguns minutos: {url}',
    en: '⏹️ Recording ended (**{duration}**). Audio is up — transcript and minutes land here in a few minutes: {url}',
  },
  'transcript.empty-note': {
    pt: '🔇 Gravação processada, mas não detectei fala — sem transcrição/ata desta vez. O áudio está na página: {url}',
    en: '🔇 Recording processed, but I detected no speech — no transcript/minutes this time. The audio is on the page: {url}',
  },
  'transcript.failed': {
    pt: '⚠️ Não consegui transcrever desta vez: {error}\nO áudio continua disponível na página, viu?',
    en: '⚠️ I couldn’t transcribe this time: {error}\nThe audio is still available on the page.',
  },
  'transcript.partial': {
    pt: '📝 Transcrição pronta, mas **parcial** — não consegui transcrever: {names}. O que deu (e a ata, se gerada) já está na página 👉 {url}',
    en: '📝 Transcript ready but **partial** — I could not transcribe: {names}. What I got (and the minutes, if generated) is on the page 👉 {url}',
  },
  'minutes.ready': {
    pt: '📋 Prontinho! A **ata** e a **transcrição** já estão na página 👉 {url}',
    en: '📋 All done! The **minutes** and **transcript** are on the page 👉 {url}',
  },
  'minutes.embed-title': { pt: 'Ata — #{channel}', en: 'Minutes — #{channel}' },
  'minutes.embed-decisions': { pt: '✅ Decisões', en: '✅ Decisions' },
  'minutes.embed-actions': { pt: '📌 Itens de ação', en: '📌 Action items' },

  // sobre / about (autoria + licença + fonte — cumpre a AGPL §13)
  'about.desc': {
    pt: 'Gravador de voz self-hosted para Discord, com transcrição por IA e ata da reunião.',
    en: 'Self-hosted Discord voice recorder with AI transcription and meeting minutes.',
  },
  'about.author': { pt: 'Autor', en: 'Author' },
  'about.license': { pt: 'Licença', en: 'License' },
  'about.source': { pt: 'Código-fonte', en: 'Source code' },
  'about.footer': {
    pt: 'Software livre sob AGPL-3.0 — você tem direito ao código-fonte desta versão.',
    en: 'Free software under AGPL-3.0 — you are entitled to the source of this version.',
  },
  // onboarding / ajuda
  'help.title': { pt: '🎙️ Kassinão — como usar', en: '🎙️ Kassinão — how to use' },
  'help.intro': {
    pt: 'Eu gravo o seu canal de voz com **uma faixa separada por pessoa** e, depois, gero **transcrição** e **ata** (resumo + tarefas + decisões) automaticamente.',
    en: 'I record your voice channel with **one separate track per person** and then generate **transcript** and **minutes** (summary + tasks + decisions) automatically.',
  },
  'help.commands': { pt: 'Comandos', en: 'Commands' },
  'help.cmd-list': {
    pt: '**/gravar** — entra no seu canal de voz e começa a gravar\n**/parar** — encerra e gera o link com áudio, transcrição e ata\n**/perguntar** — pergunte às suas reuniões; a IA responde só pra você, com o segundo exato\n**/nota** — anotação no momento atual (ou 📌 *Marcar momento* no painel, sem digitar)\n**/status** — mostra a gravação em andamento\n**/gravacoes** — suas gravações + link do índice web com busca\n**/autorecord** — (admin) grava sozinho quando entram pessoas num canal\n**/config** — (admin) canal onde a ata é postada\n**/sobre** — autor, licença e código-fonte',
    en: '**/record** — joins your voice channel and starts recording\n**/stop** — ends it and generates the link with audio, transcript and minutes\n**/ask** — ask your meetings; the AI answers only to you, with the exact second\n**/note** — note at the current time (or 📌 *Mark moment* on the panel, no typing)\n**/status** — shows the recording in progress\n**/recordings** — your recordings + link to the searchable web index\n**/autorecord** — (admin) records automatically when people join a channel\n**/config** — (admin) channel where the minutes get posted\n**/about** — author, license and source code',
  },
  'help.flow': { pt: 'Passo a passo', en: 'Quick start' },
  'help.perms': { pt: 'Permissões', en: 'Permissions' },
  'help.perms-body': {
    pt: '• **Gravar**: qualquer membro. **Parar/anotar**: quem enxerga o canal gravado.\n• **Ver uma gravação**: exige continuar membro do servidor e ter **estado na call** (mesmo mutado), iniciado a gravação ou ser admin atual; ganhar acesso ao canal depois não abre o histórico.\n• **Apagar**: quem iniciou ou admin, com permissão revalidada na hora. **/autorecord** e **/config**: exigem *Gerenciar Servidor*.\n• **/perguntar** e a busca só usam reuniões que **você** pode abrir.',
    en: '• **Record**: any member. **Stop/annotate**: whoever can see the recorded channel.\n• **Open a recording**: you must remain a server member and have **joined the call** (even muted), started the recording, or be a current admin; gaining channel access later does not unlock history.\n• **Delete**: starter or admin, with permission revalidated at that moment. **/autorecord** and **/config**: require *Manage Server*.\n• **/ask** and search only use meetings **you** can open.',
  },
  'help.flow-body': {
    pt: '1. Entre num canal de voz e use **/gravar**\n2. Conversem normalmente (📌 marca momentos importantes)\n3. Use **/parar** — a ata resumida chega no canal (quem iniciou recebe o link por DM)\n4. Depois, é só **/perguntar** ("o que decidimos sobre X?") ou buscar no índice web',
    en: '1. Join a voice channel and use **/record**\n2. Talk normally (📌 marks the important moments)\n3. Use **/stop** — the minutes summary lands in the channel (the starter gets the link via DM)\n4. Later, just **/ask** ("what did we decide about X?") or search the web index',
  },
  'help.footer': { pt: 'Kassinão 🎙️ • use /ajuda a qualquer momento', en: 'Kassinão 🎙️ • use /help anytime' },
  // botões e tópicos do /ajuda (onboarding interativo)
  'help.btn-record': { pt: '🎥 Como gravar', en: '🎥 How to record' },
  'help.btn-ask': { pt: '💬 Perguntar às reuniões', en: '💬 Ask your meetings' },
  'help.btn-downloads': { pt: '📥 Downloads e ata', en: '📥 Downloads & minutes' },
  'help.btn-privacy': { pt: '🔒 Privacidade', en: '🔒 Privacy' },
  'help.btn-auto': { pt: '🤖 Auto-record', en: '🤖 Auto-record' },
  'help.topic-record': {
    pt: '🎥 **Como gravar**\n1. Entre num canal de voz e digite **/gravar** — eu entro e fico como `[GRAVANDO]` no apelido, pra todo mundo ver que a call está sendo gravada.\n2. Conversem normalmente. Cada pessoa vira uma **faixa separada** (atribuição perfeita de quem falou).\n3. Marque momentos com o botão **📌 Marcar momento** (um clique, sem digitar) ou **/nota**/📝 pra anotar com texto — tudo entra na transcrição, na ata e nos labels do Audacity.\n4. Encerre com **/parar** (ou o botão). A ata resumida chega no canal — e dá pra **baixar até durante** a gravação.\n\n⏹️ **Eu encerro sozinho** quando: o canal **esvazia**, atinge o **limite de {hours}h**, ou eu sou **desconectado**. (Se ninguém fala por ~5 min, eu só aviso no painel — não paro.)',
    en: "🎥 **How to record**\n1. Join a voice channel and type **/record** — I join and show as `[RECORDING]` in my nickname, so everyone sees the call is being recorded.\n2. Talk normally. Each person becomes a **separate track** (perfect speaker attribution).\n3. Mark moments with the **📌 Mark moment** button (one click, no typing) or **/note**/📝 for a text note — everything flows into the transcript, the minutes and the Audacity labels.\n4. End with **/stop** (or the button). The minutes summary lands in the channel — and you can **download even while** recording.\n\n⏹️ **I stop on my own** when: the channel **empties**, it hits the **{hours}h limit**, or I get **disconnected**. (If nobody speaks for ~5 min I only warn on the panel — I don't stop.)",
  },
  'help.topic-ask': {
    pt: '💬 **Perguntar às reuniões**\n• **/perguntar** entende tema, pessoa e data: "ações da Ana ontem", "o que decidimos semana passada?". A opção `dias:` define a janela quando você não cita uma data (padrão 30).\n• Eu respondo **só pra você** e só uso reuniões que **você pode acessar** — a mesma regra da página.\n• As fontes abrem a **ata** ou pulam pro **segundo exato** da transcrição.\n• Na **web**: o índice em {url}/app lista tudo que você pode abrir, com **busca** em transcrições, atas e notas.\n• No seu **assistente de IA** (qualquer um com MCP: Claude, Cursor…): conector em {url}/app/conectar-ia — ações pendentes entre reuniões, quem disse o quê, busca por período.',
    en: '💬 **Ask your meetings**\n• **/ask** understands topic, person and date: "Ana\'s actions yesterday", "what did we decide last week?". The `days:` option defines the window when no date is mentioned (default 30).\n• I answer **only to you** and only use meetings **you can access** — same rule as the page.\n• Sources open the **minutes** or jump to the **exact second** in the transcript.\n• On the **web**: the index at {url}/app lists everything you can open, with **search** across transcripts, minutes and notes.\n• In your **AI assistant** (anything MCP-capable: Claude, Cursor…): connector at {url}/app/conectar-ia — pending actions across meetings, who said what, time-window search.',
  },
  'help.topic-downloads': {
    pt: '📥 **Downloads e ata** (na página da gravação)\n• **MP3** — uma faixa por pessoa (ZIP). Leve, abre em qualquer player.\n• **FLAC** — uma faixa por pessoa (ZIP), **sem perda** de qualidade; arquivos grandes, ideal pra edição/arquivo.\n• **Mix** — todo mundo junto num **MP3 único**; o player da página usa ele (com velocidade 1×/1.5×/2×).\n• **Audacity** — projeto (`.lof` + labels) que abre no Audacity com as faixas **já alinhadas** e suas notas marcadas.\n• **📝 Transcrição** (.md/.txt) — nome de quem falou, busca, filtro por pessoa e horários clicáveis.\n• **📋 Ata** — resumo, decisões, itens de ação (responsável/prazo) e o que cada um trouxe.\nTudo protegido por login. {retention} — a busca e o /perguntar continuam funcionando.',
    en: '📥 **Downloads & minutes** (on the recording page)\n• **MP3** — one track per person (ZIP). Light, plays anywhere.\n• **FLAC** — one track per person (ZIP), **lossless**; big files, best for editing/archiving.\n• **Mix** — everyone together in a **single MP3**; the page player uses it (with 1×/1.5×/2× speed).\n• **Audacity** — a project (`.lof` + labels) that opens in Audacity with tracks **already aligned** and your notes marked.\n• **📝 Transcript** (.md/.txt) — speaker names, search, per-person filter and clickable timestamps.\n• **📋 Minutes** — summary, decisions, action items (owner/due) and per-person points.\nAll login-protected. {retention} — search and /ask keep working.',
  },
  'help.topic-privacy': {
    pt: '🔒 **Privacidade e acesso**\n• As gravações só abrem com **login no Discord** e membership atual no servidor; saiu, perdeu o acesso.\n• Em qualquer canal, só acessa quem **estava na call** (mesmo mutado), iniciou ou é admin atual. Receber permissão depois não abre o passado.\n• A gravação é **visível**: eu entro na call e fico como `[GRAVANDO]` — ninguém é gravado sem ver.\n• Em canais **restritos**, me libere no canal (**Ver Canal + Conectar**) pra eu entrar.\n• {retentionPrivacy}; dá pra apagar tudo pela página (quem iniciou ou admin).',
    en: '🔒 **Privacy & access**\n• Recordings require **Discord login** and current server membership; leave the server and access ends.\n• In every channel, only whoever **was in the call** (even muted), the starter, or a current admin can access it. Permission granted later does not unlock the past.\n• Recording is **visible**: I join the call and show as `[RECORDING]` — nobody is recorded unknowingly.\n• In **restricted** channels, grant me access (**View Channel + Connect**) so I can join.\n• {retentionPrivacy}; everything can be deleted from the page (starter or admin).',
  },
  // frases de retenção intercambiáveis pros tópicos do /ajuda (config atual manda)
  'help.retention-limited': {
    pt: 'O **áudio expira em {days} dias**; transcrição, ata e notas ficam bem mais (retenção em camadas)',
    en: 'The **audio expires in {days} days**; transcript, minutes and notes live much longer (tiered retention)',
  },
  'help.retention-unlimited': {
    pt: '**Nada expira sozinho** — tudo fica guardado até alguém apagar (dá pra liberar só o áudio na página, mantendo transcrição e ata)',
    en: '**Nothing expires on its own** — everything is kept until someone deletes it (you can free just the audio on the page, keeping transcript and minutes)',
  },
  'help.retention-privacy-limited': {
    pt: 'O **áudio expira em {days} dias** (transcrição e ata vivem mais)',
    en: 'The **audio expires in {days} days** (transcript and minutes live longer)',
  },
  'help.retention-privacy-unlimited': {
    pt: '**Nada expira sozinho** — as gravações ficam até serem apagadas',
    en: '**Nothing expires on its own** — recordings stay until deleted',
  },
  'help.topic-auto': {
    pt: '🤖 **Auto-record** (só admin)\n**/autorecord ligar canal:#daily minimo:2** — começo a gravar sozinho quando **2+** pessoas entram, e **paro quando o canal esvazia** (ou cai abaixo do mínimo).\nSe a reunião passar do limite de **{hours}h**, eu encerro e **recomeço** pra cobrir o resto.\n**/autorecord desligar canal:#daily** — desliga. • **/autorecord ver** — mostra o que está configurado.',
    en: '🤖 **Auto-record** (admin only)\n**/autorecord on channel:#daily minimum:2** — I start recording on my own when **2+** people join, and **stop when the channel empties** (or drops below the minimum).\nIf the meeting passes the **{hours}h** limit, I stop and **start again** to cover the rest.\n**/autorecord off channel:#daily** — turns it off. • **/autorecord view** — shows what is configured.',
  },
  'help.mcp-title': { pt: '🔌 Conectar assistente de IA', en: '🔌 Connect your AI assistant' },
  'help.mcp-body': {
    pt: 'Pergunte sobre suas reuniões por qualquer assistente de IA com MCP — Claude, Cursor e afins ("o que ficou pendente essa semana?"). Gere seu token em {url}/app/conectar-ia.',
    en: 'Ask about your meetings from any MCP-capable AI assistant — Claude, Cursor and the like ("what is pending this week?"). Generate your token at {url}/app/conectar-ia.',
  },
  'help.dm-hint': {
    pt: 'Sou um bot de gravação — me use pelos **comandos dentro do servidor**. Aqui vai o guia rápido:',
    en: "I'm a recording bot — use me via the **commands inside the server**. Here's the quick guide:",
  },
  'help.dm-command': {
    pt: 'O `{cmd}` funciona **dentro do servidor** — é lá que eu consigo checar o que você pode ver, e a resposta sai só pra você. Aqui na DM eu não executo comandos.\n\n🔌 Quer perguntar de fora do Discord? Conecte **qualquer assistente de IA com MCP** (Claude, Cursor…): {url}/app/conectar-ia',
    en: "`{cmd}` works **inside the server** — that's where I can check what you're allowed to see, and the answer stays private to you. I don't run commands here in DMs.\n\n🔌 Want to ask from outside Discord? Connect **any MCP-capable AI assistant** (Claude, Cursor…): {url}/app/conectar-ia",
  },
  'welcome.title': { pt: '👋 Obrigado por me adicionar!', en: '👋 Thanks for adding me!' },
  'welcome.body': {
    pt: 'Eu sou o **Kassinão** 🎙️ — gravo suas calls do Discord com **uma faixa por pessoa**, gero **transcrição** e **ata** (resumo, decisões e tarefas) automaticamente, e depois você **pergunta** o que foi decidido com **/perguntar**.\n\n**Pra começar:** entre num canal de voz e use **/gravar**. Quer ver tudo que eu faço? **/ajuda**.\n\n🔒 Em canais restritos, me dê acesso ao canal (Ver Canal + Conectar) pra eu conseguir entrar.',
    en: "I'm **Kassinão** 🎙️ — I record your Discord calls with **one track per person**, auto-generate **transcript** and **minutes** (summary, decisions and tasks), and later you just **/ask** what was decided.\n\n**To start:** join a voice channel and use **/record**. Want the full tour? **/help**.\n\n🔒 In restricted channels, grant me channel access (View Channel + Connect) so I can join.",
  },

  // status
  'status.none': {
    pt: '💤 Nenhuma gravação rolando agora. Entre num canal de voz e use **/gravar** pra começar.',
    en: '💤 No recording right now. Join a voice channel and use **/record** to start.',
  },
  'status.hidden': {
    pt: '💤 Nenhuma gravação que você possa acompanhar está rolando agora.',
    en: '💤 No recording you can follow is running right now.',
  },
  'status.starting': {
    pt: '⏳ Estou preparando a gravação em **{channel}**. O áudio só começa depois que o aviso aparecer no canal.',
    en: '⏳ I am preparing the recording in **{channel}**. Audio starts only after the notice appears in the channel.',
  },
  'status.recording': {
    pt: '🔴 Gravando **{channel}** há **{duration}**\n👥 {inRoom} na sala · 🎙️ {spoke} já falaram · 📝 {notes} nota(s)\n▶️ Iniciada por **{starter}**\n📥 {url}',
    en: '🔴 Recording **{channel}** for **{duration}**\n👥 {inRoom} in the room · 🎙️ {spoke} spoke · 📝 {notes} note(s)\n▶️ Started by **{starter}**\n📥 {url}',
  },

  // /gravacoes
  'recordings.none': {
    pt: 'Você ainda não tem gravações por aqui. Entre num canal de voz e use **/gravar** pra criar a primeira. 🎙️',
    en: 'You have no recordings here yet. Join a voice channel and use **/record** to create the first one. 🎙️',
  },
  'recordings.title': { pt: '🎙️ Gravações que você pode abrir', en: '🎙️ Recordings you can open' },
  'recordings.live': { pt: 'gravando agora', en: 'recording now' },
  'recordings.open': { pt: '📥 Abrir gravação', en: '📥 Open recording' },
  'recordings.by-auto': { pt: 'auto-record', en: 'auto-record' },
  'recordings.badge-ready': { pt: '📋 ata pronta', en: '📋 minutes ready' },
  'recordings.badge-transcript': { pt: '📝 transcrição pronta', en: '📝 transcript ready' },
  'recordings.badge-partial': { pt: '📝 transcrição parcial', en: '📝 partial transcript' },
  'recordings.badge-processing': { pt: '⏳ processando', en: '⏳ processing' },
  'recordings.badge-failed': { pt: '⚠️ transcrição falhou', en: '⚠️ transcription failed' },
  'recordings.badge-none': { pt: '🔇 sem transcrição', en: '🔇 no transcript' },
  'recordings.more': { pt: '_… e mais {n} mais antiga(s)._', en: '_… and {n} older one(s)._' },
  'recordings.web': {
    pt: '🌐 Todas as suas gravações (com busca): {url}',
    en: '🌐 All your recordings (with search): {url}',
  },

  // /autorecord
  'autorecord.no-permission': {
    pt: 'Você precisa da permissão **Gerenciar Servidor** para configurar o auto-record.',
    en: 'You need the **Manage Server** permission to configure auto-record.',
  },
  'autorecord.enabled': {
    pt: '✅ Auto-record ligado em **{channel}**: começo com **{min}+** pessoa(s) e paro quando ficar abaixo desse mínimo. Se passar de {hours}h, encerro e recomeço automaticamente pra cobrir o resto.',
    en: '✅ Auto-record enabled in **{channel}**: I start with **{min}+** person(s) and stop when it drops below that minimum. Past {hours}h I stop and restart automatically to cover the rest.',
  },
  'autorecord.updated': {
    pt: '✅ Regra de auto-record atualizada em **{channel}**: agora o mínimo é **{min}**. Uma gravação já ativa não será reiniciada por esta alteração.',
    en: '✅ Auto-record rule updated in **{channel}**: the minimum is now **{min}**. An active recording will not be restarted by this change.',
  },
  'autorecord.disabled': {
    pt: '🛑 Auto-record desligado em **{channel}**.',
    en: '🛑 Auto-record disabled in **{channel}**.',
  },
  'autorecord.disabled-live': {
    pt: '🛑 Auto-record desligado em **{channel}**. A gravação em andamento continua até o canal esvaziar — use **/parar** pra encerrar agora.',
    en: '🛑 Auto-record disabled in **{channel}**. The ongoing recording keeps going until the channel empties — use **/stop** to end it now.',
  },
  'autorecord.not-set': {
    pt: 'Não havia auto-record configurado em **{channel}**.',
    en: 'There was no auto-record configured in **{channel}**.',
  },
  'autorecord.view-none': {
    pt: 'Nenhum auto-record ainda. Ligue com **/autorecord ligar canal:#seu-canal minimo:2** — eu passo a gravar sozinho quando o pessoal entrar. 🤖',
    en: 'No auto-record yet. Turn it on with **/autorecord on channel:#your-channel minimum:2** — I record on my own when people join. 🤖',
  },
  'autorecord.view-title': { pt: '🤖 Auto-record deste servidor', en: '🤖 Auto-record in this server' },
  'autorecord.view-line': {
    pt: '{state} {channel} — mín. **{min}** • ligado por {by}',
    en: '{state} {channel} — min. **{min}** • set by {by}',
  },
  'autorecord.state-recording': { pt: '🔴', en: '🔴' },
  'autorecord.state-armed': { pt: '✅', en: '✅' },
  'autorecord.state-waiting': { pt: '💤', en: '💤' },
  'autorecord.view-hint': {
    pt: '_Desligar: **/autorecord desligar canal:#…**_',
    en: '_Turn off: **/autorecord off channel:#…**_',
  },

  // MCP (conector de IA)
  'mcp.web-only': {
    pt: 'O `/mcp novo` é só pra quem administra o bot. Pra você, o caminho é abrir {url}/app/conectar-ia e entrar com o Discord — self-serve, com o seu próprio acesso. 👉',
    en: '`/mcp new` is only for bot admins. For you, just open {url}/app/conectar-ia and sign in with Discord — self-serve, scoped to your own access. 👉',
  },
  'mcp.new': {
    pt: '🔌 **Conectar assistente de IA** (código válido ~5 min, uso único). No terminal:\n```\nKASSINAO_URL={mcpUrl} npx -y kassinao-mcp exchange {code}\n```\nO comando salva o token e imprime a config pra colar no seu assistente de IA (qualquer um com MCP: Claude, Cursor…). Mais fácil ainda: abra {appUrl}/app/conectar-ia no navegador.',
    en: '🔌 **Connect your AI assistant** (code valid ~5 min, single use). In a terminal:\n```\nKASSINAO_URL={mcpUrl} npx -y kassinao-mcp exchange {code}\n```\nIt saves the token and prints the config to paste into your AI assistant (anything MCP-capable: Claude, Cursor…). Even easier: open {appUrl}/app/conectar-ia in the browser.',
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

function templateVariables(template: string, value: string): Record<string, string> | undefined {
  const names: string[] = [];
  const pattern = template
    .split(/(\{[^{}]+\})/u)
    .map((part) => {
      const variable = part.match(/^\{([^{}]+)\}$/u);
      if (variable) {
        names.push(variable[1]);
        return '(.+?)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  const match = value.match(new RegExp(`^${pattern}$`, 'u'));
  if (!match) return undefined;
  return Object.fromEntries(names.map((name, index) => [name, match[index + 1]]));
}

/**
 * Eventos automáticos ficam persistidos no idioma usado no Discord no momento
 * da call. A web reconhece somente os templates conhecidos e os reapresenta no
 * idioma atual; qualquer texto desconhecido continua intacto.
 */
export function localizeEvent(text: string, locale: Locale): string {
  for (const [key, translations] of Object.entries(STRINGS)) {
    if (!key.startsWith('event.')) continue;
    for (const sourceLocale of ['pt', 'en'] as const) {
      const variables = templateVariables(translations[sourceLocale], text);
      if (variables) return t(locale, key, variables);
    }
  }
  return text;
}
