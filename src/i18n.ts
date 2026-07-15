/**
 * Textos do bot em pt-BR e inglês.
 * O idioma é escolhido pelo locale do cliente Discord de quem interage
 * (pt-BR para clientes em português, inglês para o resto).
 */
export type Locale = 'pt' | 'en';

/** Capacidades que podem aparecer nas superfícies do Discord desta instância. */
export interface DiscordCapabilities {
  transcription: boolean;
  minutes: boolean;
  ask: boolean;
  mcp: boolean;
}

export type RecordingOutputMode = 'recording' | 'transcript' | 'minutes';

/**
 * A ata de uma gravação nova depende de transcrição. `/perguntar` pode continuar
 * útil sobre o histórico mesmo quando o ASR atual está desligado, por isso `ask`
 * não participa desta decisão.
 */
export function recordingOutputMode(
  capabilities: Pick<DiscordCapabilities, 'transcription' | 'minutes'>,
): RecordingOutputMode {
  if (capabilities.transcription && capabilities.minutes) return 'minutes';
  if (capabilities.transcription) return 'transcript';
  return 'recording';
}

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
    pt: '⏳ Muitas gravações foram iniciadas recentemente. Tente de novo em {wait}.',
    en: '⏳ Too many recordings were started recently. Try again in {wait}.',
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
    pt: '🔒 Só quem iniciou, esteve na call ou gerencia o servidor pode encerrar esta gravação.',
    en: '🔒 Only the starter, people who joined the call, or current server managers can stop this recording.',
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
  'record.stopped.recording': {
    pt: '⏹️ Encerrei! O **áudio**, as faixas e as notas estão na área privada; player e downloads são preparados depois da call 👉 {url}',
    en: '⏹️ Done! The **audio**, tracks, and notes are in the private app; playback and downloads are prepared after the call 👉 {url}',
  },
  'record.stopped.transcript': {
    pt: '⏹️ Encerrei! O **áudio**, as faixas e as notas estão na área privada. A **transcrição entrou na fila**, sem prazo fixo 👉 {url}',
    en: '⏹️ Done! The **audio**, tracks, and notes are in the private app. The **transcript is queued**, with no fixed ETA 👉 {url}',
  },
  'record.stopped.minutes': {
    pt: '⏹️ Encerrei! O **áudio**, as faixas e as notas estão na área privada. A **transcrição entrou na fila** e a ata vem depois dela, sem prazo fixo 👉 {url}',
    en: '⏹️ Done! The **audio**, tracks, and notes are in the private app. The **transcript is queued**, and minutes follow it, with no fixed ETA 👉 {url}',
  },
  'record.stopped-empty': {
    pt: '⏹️ Encerrei, mas ninguém falou nessa — não há faixa de voz para processar. Se foi engano, é só gravar de novo. 🙂',
    en: '⏹️ Stopped, but nobody spoke — there is no voice track to process. If that was a mistake, just record again. 🙂',
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

  // painel
  'panel.title-recording': { pt: '🔴 Gravando • {channel}', en: '🔴 Recording • {channel}' },
  // saudação amigável (texto acima do painel) — deixa o time à vontade e explica o que rola
  'panel.greeting-recording': {
    pt: '👋 Oi, pessoal! Estou **gravando este canal** com faixas separadas e notas marcadas no tempo. {processing}\n🔒 Depois, só participantes, quem iniciou e admins atuais podem abrir; é preciso continuar no servidor.',
    en: "👋 Hey everyone! I'm **recording this channel** with separate tracks and timestamped notes. {processing}\n🔒 Later, only participants, the starter, and current admins can open it; server membership is still required.",
  },
  'panel.processing.recording': {
    pt: 'Áudio, faixas e notas ficam no app privado depois da call.',
    en: 'Audio, tracks, and notes stay in the private app after the call.',
  },
  'panel.processing.transcript': {
    pt: 'Depois da call, a transcrição entra na fila da instância.',
    en: 'After the call, the transcript enters this instance’s queue.',
  },
  'panel.processing.minutes': {
    pt: 'Depois da call, a transcrição entra na fila; a ata é gerada depois que ela termina.',
    en: 'After the call, the transcript enters the queue; minutes are generated after it finishes.',
  },
  'panel.greeting-done-private': {
    pt: '⏹️ **Gravação encerrada.** Detalhes e links ficam somente nas DMs autorizadas e na área privada.',
    en: '⏹️ **Recording finished.** Details and links stay only in authorized DMs and the private app.',
  },
  'panel.desc-recording-private': {
    pt: '🔴 A captura começou depois deste aviso visível. Os controles abaixo funcionam só para pessoas autorizadas; detalhes e links ficam fora do canal.',
    en: '🔴 Capture started after this visible notice. The controls below work only for authorized people; details and links stay out of the channel.',
  },
  'panel.btn-stop': { pt: 'Parar gravação', en: 'Stop recording' },
  'panel.btn-note': { pt: 'Adicionar nota', en: 'Add a note' },
  'panel.btn-mark': { pt: 'Marcar momento', en: 'Mark moment' },
  'panel.footer': { pt: 'Kassinão 🎙️', en: 'Kassinão 🎙️' },
  'panel.recovered-after-restart': {
    pt: '⏹️ **A gravação foi encerrada por um reinício do bot.** Removi os controles antigos; detalhes continuam somente na área privada.',
    en: '⏹️ **The recording was stopped by a bot restart.** I removed the old controls; details remain only in the private app.',
  },

  // DM para quem iniciou
  'dm.title-start': { pt: '🔴 Gravação iniciada', en: '🔴 Recording started' },
  'dm.desc-start': {
    pt: 'Comecei a gravar **{channel}** em **{guild}**. 👍\n\n📥 **[Página da gravação]({url})** — acompanha o estado e as notas agora; player e downloads ficam disponíveis depois de encerrar.\n{processing}\n⏱️ Gravo por até **{hours}h** • o áudio fica disponível por **{expiresDays} dias** depois de terminar.\n🔒 Só participantes, quem iniciou e admins atuais abrem; é preciso continuar no servidor.',
    en: 'I started recording **{channel}** in **{guild}**. 👍\n\n📥 **[Recording page]({url})** — follow status and notes now; playback and downloads become available after it ends.\n{processing}\n⏱️ I record for up to **{hours}h** • audio stays available for **{expiresDays} days** after it ends.\n🔒 Only participants, the starter, and current admins can open it; server membership is still required.',
  },
  'dm.desc-start-unlimited': {
    pt: 'Comecei a gravar **{channel}** em **{guild}**. 👍\n\n📥 **[Página da gravação]({url})** — acompanha o estado e as notas agora; player e downloads ficam disponíveis depois de encerrar.\n{processing}\n⏱️ Gravo por até **{hours}h** • a gravação **fica guardada até alguém apagar**.\n🔒 Só participantes, quem iniciou e admins atuais abrem; é preciso continuar no servidor.',
    en: 'I started recording **{channel}** in **{guild}**. 👍\n\n📥 **[Recording page]({url})** — follow status and notes now; playback and downloads become available after it ends.\n{processing}\n⏱️ I record for up to **{hours}h** • the recording is **kept until someone deletes it**.\n🔒 Only participants, the starter, and current admins can open it; server membership is still required.',
  },
  'dm.processing-start.recording': {
    pt: '🎧 Nesta instância, novas gravações ficam em áudio, faixas e notas; a transcrição automática está desligada.',
    en: '🎧 On this instance, new recordings stay as audio, tracks, and notes; automatic transcription is off.',
  },
  'dm.processing-start.transcript': {
    pt: '📝 Depois do encerramento, a transcrição entra na fila.',
    en: '📝 After recording ends, the transcript enters the queue.',
  },
  'dm.processing-start.minutes': {
    pt: '📝 Depois do encerramento, a transcrição entra na fila e a ata é gerada depois dela.',
    en: '📝 After recording ends, the transcript enters the queue and minutes are generated after it.',
  },
  'dm.title-stop': { pt: '✅ Gravação encerrada', en: '✅ Recording finished' },
  'dm.desc-stop': {
    pt: 'Fechei a gravação de **{channel}** — durou **{duration}**. ✅\n\n📥 **[Abrir a gravação]({url})**\n{processing}\n⏳ O áudio fica disponível até {expires}.',
    en: 'I wrapped up the **{channel}** recording — it lasted **{duration}**. ✅\n\n📥 **[Open the recording]({url})**\n{processing}\n⏳ Audio stays available until {expires}.',
  },
  'dm.desc-stop-unlimited': {
    pt: 'Fechei a gravação de **{channel}** — durou **{duration}**. ✅\n\n📥 **[Abrir a gravação]({url})**\n{processing}\n♾️ Fica guardada até alguém apagar.',
    en: 'I wrapped up the **{channel}** recording — it lasted **{duration}**. ✅\n\n📥 **[Open the recording]({url})**\n{processing}\n♾️ Kept until someone deletes it.',
  },
  'dm.processing-stop.recording': {
    pt: '🎧 Áudio, faixas e notas estão na página; mix e downloads podem precisar de alguns instantes para preparar.',
    en: '🎧 Audio, tracks, and notes are on the page; the mix and downloads may still need time to prepare.',
  },
  'dm.processing-stop.transcript': {
    pt: '🎧 Áudio, faixas e notas estão na página. 📝 A transcrição entrou na fila e não tem prazo fixo.',
    en: '🎧 Audio, tracks, and notes are on the page. 📝 The transcript is queued with no fixed ETA.',
  },
  'dm.processing-stop.minutes': {
    pt: '🎧 Áudio, faixas e notas estão na página. 📝 A transcrição entrou na fila; a ata vem depois dela, sem prazo fixo.',
    en: '🎧 Audio, tracks, and notes are on the page. 📝 The transcript is queued; minutes follow it, with no fixed ETA.',
  },
  'dm.desc-stop-empty': {
    pt: 'Fechei a gravação de **{channel}** — mas ninguém falou, então não há faixa de voz para processar. Se foi engano, é só gravar de novo. 🙂',
    en: 'I wrapped up the **{channel}** recording — but nobody spoke, so there is no voice track to process. If that was a mistake, just record again. 🙂',
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
    pt: '🔒 Só quem iniciou, esteve na call ou é admin atual pode adicionar notas nesta gravação.',
    en: '🔒 Only the starter, people who joined the call, or current admins can add notes to this recording.',
  },
  'note.mark-text': { pt: '📌 momento marcado', en: '📌 moment marked' },
  'note.marked': {
    pt: '📌 Momento **{offset}** marcado! Ele vira um marcador na página e entra na ata se esse artefato for gerado.',
    en: '📌 Moment **{offset}** marked! It becomes a marker on the page and is added to the minutes if that artifact is generated.',
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
    pt: '✅ O aviso genérico de processamento será postado em {channel}. Detalhes e links ficam só nas DMs autorizadas.',
    en: '✅ The generic processing notice will be posted in {channel}. Details and links stay in authorized DMs.',
  },
  'config.minutes-channel-cleared': {
    pt: '✅ Canal de aviso removido — o aviso genérico volta ao chat do canal de voz.',
    en: '✅ Notice channel cleared — the generic notice goes back to the voice channel chat.',
  },
  'config.view-minutes-channel': { pt: '🔔 Canal de aviso: {channel}', en: '🔔 Notice channel: {channel}' },
  'config.view-minutes-channel-none': {
    pt: '🔔 Canal de aviso: *(não configurado — aviso genérico vai pro chat do canal de voz)*',
    en: '🔔 Notice channel: *(not set — the generic notice goes to the voice channel chat)*',
  },

  // /perguntar (RAG nas reuniões)
  'ask.disabled': {
    pt: '🤖 O /perguntar não está habilitado nesta instância.',
    en: '🤖 /ask is not enabled on this instance.',
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
  'ask.scan-truncated': {
    pt: '-# ⚠️ não consegui verificar a janela inteira de uma vez. Este resultado cobre só a parte mais recente; reduza `dias` ou informe uma data/período na pergunta.',
    en: '-# ⚠️ I could not check the entire window at once. This result covers only the most recent portion; reduce `days` or include a date/range in the question.',
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
    pt: '-# Período: {period}. Baseado em {n} reunião(ões) que você pode acessar. Os links abrem a fonte citada; trechos temporais abrem no momento correspondente.',
    en: '-# Period: {period}. Based on {n} meeting(s) you can access. Links open the cited source; time-based excerpts open at the corresponding moment.',
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
  'transcript.private-notice': {
    pt: '🔔 O processamento de uma gravação terminou. O bot tenta avisar pessoas autorizadas por DM; os detalhes continuam na área privada.',
    en: '🔔 A recording finished processing. The bot attempts to notify authorized people by DM; details remain in the private app.',
  },
  'transcript.ready': {
    pt: '📝 Transcrição pronta! Já está na página 👉 {url}',
    en: '📝 Transcript ready! It’s on the page now 👉 {url}',
  },
  'record.stopped-link': {
    pt: '⏹️ Gravação encerrada (**{duration}**). Arquivos e notas ficam na área privada: {url}',
    en: '⏹️ Recording ended (**{duration}**). Files and notes are in the private app: {url}',
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
    pt: 'Gravador de voz self-hosted para Discord, com faixas separadas, notas e processamento opcional.',
    en: 'Self-hosted Discord voice recorder with separate tracks, notes, and optional processing.',
  },
  'about.author': { pt: 'Autor', en: 'Author' },
  'about.operator': { pt: 'Operador desta instância', en: 'Instance operator' },
  'about.license': { pt: 'Licença', en: 'License' },
  'about.source': { pt: 'Código-fonte', en: 'Source code' },
  'about.privacy': { pt: 'Política de privacidade', en: 'Privacy policy' },
  'about.contact': { pt: 'Contato do operador', en: 'Operator contact' },
  'about.data-deletion': { pt: 'Acesso, correção ou exclusão', en: 'Access, correction, or deletion' },
  'about.footer': {
    pt: 'Software livre sob AGPL-3.0 — você tem direito ao código-fonte desta versão.',
    en: 'Free software under AGPL-3.0 — you are entitled to the source of this version.',
  },
  // onboarding / ajuda
  'help.title': { pt: '🎙️ Kassinão — como usar', en: '🎙️ Kassinão — how to use' },
  'help.intro.recording': {
    pt: 'Eu gravo seu canal de voz com **uma faixa por conta do Discord que fala**, guardo notas no momento exato e organizo tudo no app privado. A transcrição automática de novas calls está desligada.',
    en: 'I record your voice channel with **one track per Discord account that speaks**, save notes at the exact moment, and organize everything in the private app. Automatic transcription for new calls is off.',
  },
  'help.intro.transcript': {
    pt: 'Eu gravo seu canal de voz com **uma faixa por conta do Discord que fala**, guardo notas no momento exato e enfileiro a **transcrição** depois da call.',
    en: 'I record your voice channel with **one track per Discord account that speaks**, save notes at the exact moment, and queue the **transcript** after the call.',
  },
  'help.intro.minutes': {
    pt: 'Eu gravo seu canal de voz com **uma faixa por conta do Discord que fala**, guardo notas e enfileiro a **transcrição**; a **ata** vem depois, quando a transcrição termina.',
    en: 'I record your voice channel with **one track per Discord account that speaks**, save notes, and queue the **transcript**; **minutes** follow after the transcript finishes.',
  },
  'help.commands': { pt: 'Comandos', en: 'Commands' },
  'help.cmd-list': {
    pt: '**/gravar** — entra no seu canal de voz e começa a gravar\n**/parar** — encerra e disponibiliza os arquivos no app privado\n**/nota** — salva uma nota no momento atual (ou use 📌 no painel)\n**/status** — mostra a gravação que você pode acompanhar\n**/gravacoes** — lista suas gravações recentes e abre o arquivo privado{ask}\n**/autorecord** — (admin) usa uma regra de presença para gravar um canal\n**/config** — (admin) configura o aviso genérico de processamento\n**/privacidade** — política e contato desta instância\n**/sobre** — operador, autoria, licença e código-fonte',
    en: "**/record** — joins your voice channel and starts recording\n**/stop** — ends recording and makes the files available in the private app\n**/note** — saves a note at the current moment (or use 📌 on the panel)\n**/status** — shows a recording you are allowed to follow\n**/recordings** — lists your recent recordings and opens the private archive{ask}\n**/autorecord** — (admin) uses a presence rule to record a channel\n**/config** — (admin) configures the generic processing notice\n**/privacy** — this instance's policy and contact\n**/about** — operator, authorship, license, and source code",
  },
  'help.cmd-ask': {
    pt: '\n**/perguntar** — encontra evidências nas reuniões que você pode abrir',
    en: '\n**/ask** — finds evidence in meetings you are allowed to open',
  },
  'help.flow': { pt: 'Passo a passo', en: 'Quick start' },
  'help.perms': { pt: 'Permissões', en: 'Permissions' },
  'help.perms-body': {
    pt: '• **Gravar**: qualquer membro. **Parar/anotar**: quem iniciou, esteve na call ou é admin atual.\n• **Ver uma gravação**: exige continuar membro do servidor e ter **estado na call** (mesmo mutado), iniciado a gravação ou ser admin atual; ganhar acesso ao canal depois não abre o histórico.\n• **Apagar**: quem iniciou ou admin, com permissão revalidada na hora. **/autorecord** e **/config**: exigem *Gerenciar Servidor*.{ask}',
    en: '• **Record**: any member. **Stop/annotate**: the starter, people who joined the call, or current admins.\n• **Open a recording**: you must remain a server member and have **joined the call** (even muted), started the recording, or be a current admin; gaining channel access later does not unlock history.\n• **Delete**: starter or admin, with permission revalidated at that moment. **/autorecord** and **/config**: require *Manage Server*.{ask}',
  },
  'help.perms-ask': {
    pt: '\n• **/perguntar** só usa reuniões que **você** pode abrir.',
    en: '\n• **/ask** only uses meetings **you** are allowed to open.',
  },
  'help.flow-body': {
    pt: '1. Entre num canal de voz e use **/gravar**\n2. Conversem normalmente; 📌 marca um momento e **/nota** adiciona contexto\n3. Use **/parar** — o canal recebe um aviso genérico e os detalhes ficam no app privado\n4. {after}',
    en: '1. Join a voice channel and use **/record**\n2. Talk normally; 📌 marks a moment and **/note** adds context\n3. Use **/stop** — the channel gets a generic notice and details stay in the private app\n4. {after}',
  },
  'help.flow-after.recording': {
    pt: 'Abra **/gravacoes** ou o app para ouvir, baixar e revisar as notas.',
    en: 'Open **/recordings** or the app to listen, download, and review notes.',
  },
  'help.flow-after.transcript': {
    pt: 'A transcrição entra na fila; acompanhe o estado pelo app e pesquise quando ficar pronta.',
    en: 'The transcript enters the queue; follow its state in the app and search it when ready.',
  },
  'help.flow-after.minutes': {
    pt: 'A transcrição entra na fila e a ata vem depois; quando prontas, use **/perguntar** ou a busca.',
    en: 'The transcript enters the queue and minutes follow; when ready, use **/ask** or search.',
  },
  'help.footer': { pt: 'Kassinão 🎙️ • use /ajuda a qualquer momento', en: 'Kassinão 🎙️ • use /help anytime' },
  // botões e tópicos do /ajuda (onboarding interativo)
  'help.btn-record': { pt: '🎥 Como gravar', en: '🎥 How to record' },
  'help.btn-ask': { pt: '💬 Perguntar às reuniões', en: '💬 Ask your meetings' },
  'help.btn-downloads': { pt: '📥 Arquivos e downloads', en: '📥 Files & downloads' },
  'help.btn-privacy': { pt: '🔒 Privacidade', en: '🔒 Privacy' },
  'help.btn-auto': { pt: '🤖 Auto-record', en: '🤖 Auto-record' },
  'help.topic-record': {
    pt: '🎥 **Como gravar**\n1. Entre num canal de voz e use **/gravar**. O painel visível precisa ser publicado antes da captura; o apelido `[GRAVANDO]` é usado quando o Discord permite.\n2. Cada conta do Discord que falar gera uma **faixa separada**, dentro dos limites de segurança da instância.\n3. Use 📌 para marcar um momento ou **/nota** para acrescentar texto. As notas ficam na página e nos labels do Audacity.\n4. Encerre com **/parar**. Player e downloads ficam disponíveis depois que a call termina; detalhes ficam no app privado e o bot tenta avisar pessoas autorizadas por DM.\n\n{processing}\n\n⏹️ **Eu encerro sozinho** quando o canal esvazia, atinge o limite de **{hours}h** ou eu sou desconectado. Se ninguém fala por cerca de 5 minutos, eu só aviso no painel.',
    en: '🎥 **How to record**\n1. Join a voice channel and use **/record**. The visible panel must be posted before capture; the `[RECORDING]` nickname is used when Discord allows it.\n2. Each Discord account that speaks creates a **separate track**, within the instance safety limits.\n3. Use 📌 to mark a moment or **/note** to add text. Notes stay on the page and in Audacity labels.\n4. End with **/stop**. Playback and downloads become available after the call ends; details stay in the private app and the bot attempts to notify authorized people by DM.\n\n{processing}\n\n⏹️ **I stop automatically** when the channel empties, reaches the **{hours}h** limit, or I am disconnected. If nobody speaks for about 5 minutes, I only warn on the panel.',
  },
  'help.record-processing.recording': {
    pt: '🎧 Nesta instância, novas calls terminam em áudio, faixas e notas; a transcrição automática está desligada.',
    en: '🎧 On this instance, new calls end as audio, tracks, and notes; automatic transcription is off.',
  },
  'help.record-processing.transcript': {
    pt: '📝 Depois do encerramento, a transcrição entra na fila sem prazo fixo.',
    en: '📝 After recording ends, the transcript enters the queue with no fixed ETA.',
  },
  'help.record-processing.minutes': {
    pt: '📝 Depois do encerramento, a transcrição entra na fila; a ata vem depois que ela termina, sem prazo fixo.',
    en: '📝 After recording ends, the transcript enters the queue; minutes follow after it finishes, with no fixed ETA.',
  },
  'help.topic-ask': {
    pt: '💬 **Perguntar às reuniões**\n• **/perguntar** entende tema, pessoa e data: "ações da Ana ontem", "o que decidimos semana passada?". `dias:` define a janela quando você não cita uma data (padrão 30).\n• Eu seleciono **evidências só das reuniões que você pode abrir** e respondo de forma privada.\n• Fontes da ata abrem a seção correspondente; trechos de transcrição abrem no momento citado.\n• O app em {url}/app lista seu arquivo autorizado e busca na parte carregada.{mcp}',
    en: '💬 **Ask your meetings**\n• **/ask** understands topic, person, and date: "Ana\'s actions yesterday", "what did we decide last week?". `days:` defines the window when no date is mentioned (default 30).\n• I select **evidence only from meetings you can open** and reply privately.\n• Minutes sources open the matching section; transcript excerpts open at the cited moment.\n• The app at {url}/app lists your authorized archive and searches the loaded portion.{mcp}',
  },
  'help.topic-ask-mcp': {
    pt: '\n• Um cliente MCP compatível pode consultar as mesmas reuniões, com a mesma ACL: {url}/app/conectar-ia.',
    en: '\n• A compatible MCP client can query the same meetings under the same ACL: {url}/app/conectar-ia.',
  },
  'help.topic-downloads': {
    pt: '📥 **Arquivos e downloads** (depois de encerrar)\n• **MP3** — faixas capturadas em ZIP.\n• **FLAC** — faixas capturadas sem perda, em ZIP.\n• **Mix** — participantes num MP3 único para o player.\n• **Audacity** — projeto com faixas alinhadas e notas como labels.\n{aiFiles}\nTudo exige login no Discord e a ACL da reunião. {retention}',
    en: '📥 **Files and downloads** (after recording ends)\n• **MP3** — captured tracks in a ZIP.\n• **FLAC** — lossless captured tracks in a ZIP.\n• **Mix** — participants in one MP3 for playback.\n• **Audacity** — project with aligned tracks and notes as labels.\n{aiFiles}\nEverything requires Discord login and the meeting ACL. {retention}',
  },
  'help.downloads-ai.recording': {
    pt: '• A transcrição automática de novas gravações está desligada nesta instância.',
    en: '• Automatic transcription for new recordings is off on this instance.',
  },
  'help.downloads-ai.transcript': {
    pt: '• **Transcrição** (.md/.txt) — aparece quando o processamento terminar; pode ficar parcial.',
    en: '• **Transcript** (.md/.txt) — appears when processing finishes and may be partial.',
  },
  'help.downloads-ai.minutes': {
    pt: '• **Transcrição** (.md/.txt) — aparece quando o processamento terminar; pode ficar parcial.\n• **Ata** — vem depois da transcrição disponível; se ela estiver parcial, a ata também pode omitir pontos.',
    en: '• **Transcript** (.md/.txt) — appears when processing finishes and may be partial.\n• **Minutes** — follow the available transcript; if it is partial, the minutes may also omit details.',
  },
  'help.topic-privacy': {
    pt: '🔒 **Privacidade e acesso**\n• As gravações só abrem com **login no Discord** e membership atual no servidor; saiu, perdeu o acesso.\n• Só acessa quem **esteve na call** (mesmo mutado), iniciou ou é admin atual. Receber permissão depois não abre o passado.\n• O painel precisa aparecer no canal antes da captura. O apelido `[GRAVANDO]` é uma indicação extra usada quando o Discord permite.\n• Em canais restritos, libere **Ver Canal + Conectar + Enviar Mensagens + Inserir Links + Ler Histórico** para o bot.\n• {retentionPrivacy} Quem iniciou ou administra pode apagar pela página.\n\n**Operador:** {operator}\n**Política:** {privacyUrl}\n**Contato:** {contactUrl}\n**Acesso, correção ou exclusão:** {deletionUrl}',
    en: '🔒 **Privacy and access**\n• Recordings require **Discord login** and current server membership; leave the server and access ends.\n• Access is limited to people who **joined the call** (even muted), the starter, or current server managers. Later channel permission does not unlock past meetings.\n• The panel must appear in the channel before capture. The `[RECORDING]` nickname is an extra indicator used when Discord allows it.\n• In restricted channels, grant the bot **View Channel + Connect + Send Messages + Embed Links + Read Message History**.\n• {retentionPrivacy} The starter or a server manager can delete from the page.\n\n**Operator:** {operator}\n**Policy:** {privacyUrl}\n**Contact:** {contactUrl}\n**Access, correction, or deletion:** {deletionUrl}',
  },
  // frases de retenção intercambiáveis pros tópicos do /ajuda (config atual manda)
  'help.retention-limited': {
    pt: 'Retenção local: **áudio por {audioDays} dias** e dados textuais por **{textDays} dias**.',
    en: 'Local retention: **audio for {audioDays} days** and text data for **{textDays} days**.',
  },
  'help.retention-text-unlimited': {
    pt: 'Retenção local: **áudio por {audioDays} dias**; dados textuais não expiram automaticamente.',
    en: 'Local retention: **audio for {audioDays} days**; text data does not expire automatically.',
  },
  'help.retention-unlimited': {
    pt: '**Nada expira automaticamente nesta instância**; quem tem permissão pode liberar só o áudio ou apagar a gravação.',
    en: '**Nothing expires automatically on this instance**; authorized people can release only the audio or delete the recording.',
  },
  'help.retention-privacy-limited': {
    pt: 'O áudio expira em **{audioDays} dias** e os dados textuais em **{textDays} dias**.',
    en: 'Audio expires after **{audioDays} days** and text data after **{textDays} days**.',
  },
  'help.retention-privacy-text-unlimited': {
    pt: 'O áudio expira em **{audioDays} dias**; dados textuais não expiram automaticamente.',
    en: 'Audio expires after **{audioDays} days**; text data does not expire automatically.',
  },
  'help.retention-privacy-unlimited': {
    pt: '**Nada expira sozinho** — as gravações ficam até serem apagadas',
    en: '**Nothing expires on its own** — recordings stay until deleted',
  },
  'help.topic-auto': {
    pt: '🤖 **Auto-record** (só admin)\n**/autorecord ligar canal:#daily minimo:2** — começo a gravar sozinho quando **2+** pessoas entram, e **paro quando o canal esvazia** (ou cai abaixo do mínimo).\nSe a reunião passar do limite de **{hours}h**, eu encerro e **recomeço** pra cobrir o resto.\n**/autorecord desligar canal:#daily** — desliga. • **/autorecord ver** — mostra o que está configurado.',
    en: '🤖 **Auto-record** (admin only)\n**/autorecord on channel:#daily minimum:2** — I start recording on my own when **2+** people join, and **stop when the channel empties** (or drops below the minimum).\nIf the meeting passes the **{hours}h** limit, I stop and **start again** to cover the rest.\n**/autorecord off channel:#daily** — turns it off. • **/autorecord view** — shows what is configured.',
  },
  'help.mcp-title': { pt: '🔌 Conectar cliente MCP', en: '🔌 Connect an MCP client' },
  'help.mcp-body': {
    pt: 'Consulte suas reuniões por um cliente MCP compatível. Gere sua conexão em {url}/app/conectar-ia.',
    en: 'Query your meetings from a compatible MCP client. Create your connection at {url}/app/conectar-ia.',
  },
  'help.dm-hint': {
    pt: 'Sou um bot de gravação — me use pelos **comandos dentro do servidor**. Aqui vai o guia rápido:',
    en: "I'm a recording bot — use me via the **commands inside the server**. Here's the quick guide:",
  },
  'help.dm-command': {
    pt: 'O `{cmd}` funciona **dentro do servidor** — é lá que eu consigo checar o que você pode ver. Aqui na DM eu não executo comandos.{connector}',
    en: "`{cmd}` works **inside the server** — that's where I can check what you're allowed to see. I don't run commands here in DMs.{connector}",
  },
  'help.dm-connector': {
    pt: '\n\n🔌 Clientes MCP compatíveis podem consultar suas reuniões: {url}/app/conectar-ia',
    en: '\n\n🔌 Compatible MCP clients can query your meetings: {url}/app/conectar-ia',
  },
  'help.dm-ask-disabled': {
    pt: 'O **/perguntar** não está habilitado nesta instância. Use **/gravacoes** dentro do servidor para abrir seus arquivos e notas.',
    en: '**/ask** is not enabled on this instance. Use **/recordings** inside the server to open your files and notes.',
  },
  'welcome.title': { pt: '👋 Obrigado por me adicionar!', en: '👋 Thanks for adding me!' },
  'welcome.body.recording': {
    pt: 'Eu sou o **Kassinão** 🎙️ — gravo calls do Discord com **uma faixa por conta que fala**, notas no momento exato e arquivos no app privado. A transcrição automática de novas calls está desligada nesta instância.\n\n**Pra começar:** entre num canal de voz e use **/gravar**. O painel visível aparece antes da captura; player e downloads ficam disponíveis depois de encerrar. Veja **/ajuda**.\n\n🔒 Em canais restritos, preciso ver, conectar e publicar o painel no canal.',
    en: "I'm **Kassinão** 🎙️ — I record Discord calls with **one track per account that speaks**, timestamped notes, and files in the private app. Automatic transcription for new calls is off on this instance.\n\n**To start:** join a voice channel and use **/record**. The visible panel appears before capture; playback and downloads become available after recording ends. See **/help**.\n\n🔒 In restricted channels, I need to view, connect, and post the panel in the channel.",
  },
  'welcome.body.transcript': {
    pt: 'Eu sou o **Kassinão** 🎙️ — gravo calls do Discord com **uma faixa por conta que fala**, notas no momento exato e arquivos no app privado. Depois da call, a **transcrição entra na fila**.\n\n**Pra começar:** entre num canal de voz e use **/gravar**. O painel visível aparece antes da captura; player e downloads ficam disponíveis depois de encerrar. Veja **/ajuda**.\n\n🔒 Em canais restritos, preciso ver, conectar e publicar o painel no canal.',
    en: "I'm **Kassinão** 🎙️ — I record Discord calls with **one track per account that speaks**, timestamped notes, and files in the private app. After the call, the **transcript enters the queue**.\n\n**To start:** join a voice channel and use **/record**. The visible panel appears before capture; playback and downloads become available after recording ends. See **/help**.\n\n🔒 In restricted channels, I need to view, connect, and post the panel in the channel.",
  },
  'welcome.body.minutes': {
    pt: 'Eu sou o **Kassinão** 🎙️ — gravo calls do Discord com **uma faixa por conta que fala**, notas e arquivos no app privado. Depois da call, a **transcrição entra na fila**; a **ata** vem depois e o **/perguntar** encontra evidências quando tudo estiver pronto.\n\n**Pra começar:** entre num canal de voz e use **/gravar**. O painel visível aparece antes da captura; player e downloads ficam disponíveis depois de encerrar. Veja **/ajuda**.\n\n🔒 Em canais restritos, preciso ver, conectar e publicar o painel no canal.',
    en: "I'm **Kassinão** 🎙️ — I record Discord calls with **one track per account that speaks**, notes, and files in the private app. After the call, the **transcript enters the queue**; **minutes** follow, and **/ask** finds evidence when processing is ready.\n\n**To start:** join a voice channel and use **/record**. The visible panel appears before capture; playback and downloads become available after recording ends. See **/help**.\n\n🔒 In restricted channels, I need to view, connect, and post the panel in the channel.",
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
    pt: 'O `/mcp novo` é restrito aos operadores autorizados do bot. Pra conectar a sua conta, abra {url}/app/conectar-ia e entre com o Discord; o acesso continua limitado às suas reuniões. 👉',
    en: '`/mcp new` is restricted to authorized bot operators. To connect your account, open {url}/app/conectar-ia and sign in with Discord; access remains limited to your meetings. 👉',
  },
  'mcp.new': {
    pt: '🔌 **Conectar cliente MCP** (código válido ~5 min, uso único).\n\n**Código:** `{code}`\n\nNo terminal:\n```\nnpx -y kassinao-mcp@1.0.7 exchange --stdin --url {mcpUrl}\n```\nCole o código quando o comando pedir. Ele salva o token fora da configuração e imprime o bloco para um cliente MCP compatível. O fluxo self-service também está em {appUrl}/app/conectar-ia.',
    en: '🔌 **Connect an MCP client** (code valid ~5 min, single use).\n\n**Code:** `{code}`\n\nIn a terminal:\n```\nnpx -y kassinao-mcp@1.0.7 exchange --stdin --url {mcpUrl}\n```\nPaste the code when prompted. It stores the token outside the config and prints the block for a compatible MCP client. The self-service flow is also available at {appUrl}/app/conectar-ia.',
  },
  'privacy.command': {
    pt: '🔒 **Privacidade nesta instância**\n**Operador:** {operator}\n**Política:** {privacyUrl}\n**Contato:** {contactUrl}\n**Acesso, correção ou exclusão:** {deletionUrl}',
    en: '🔒 **Privacy on this instance**\n**Operator:** {operator}\n**Policy:** {privacyUrl}\n**Contact:** {contactUrl}\n**Access, correction, or deletion:** {deletionUrl}',
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

/** Seleciona uma variante de copy conforme os artefatos realmente habilitados. */
export function tCapability(
  locale: Locale,
  keyPrefix: string,
  capabilities: Pick<DiscordCapabilities, 'transcription' | 'minutes'>,
  vars: Record<string, string | number> = {},
): string {
  return t(locale, `${keyPrefix}.${recordingOutputMode(capabilities)}`, vars);
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
