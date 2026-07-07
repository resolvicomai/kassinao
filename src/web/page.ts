import { config } from '../config';
import { Locale } from '../i18n';
import { msToClock } from '../processing/transcribe';
import { formatDuration, formatOffset } from '../recorder/RecordingSession';
import { MeetingMinutes, RecordingMeta, TranscriptSegment } from '../store';
import { shortError } from '../util';
import type { WebUser } from './auth';
import type { WebSearchHit } from './search';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;'); // aspas simples: seguro também em atributos com aspas simples
}

const P: Record<string, { pt: string; en: string }> = {
  live: { pt: '● AO VIVO', en: '● LIVE' },
  done: { pt: 'FINALIZADA', en: 'FINISHED' },
  recording: { pt: 'Gravação', en: 'Recording' },
  server: { pt: 'Servidor', en: 'Server' },
  channel: { pt: 'Canal', en: 'Channel' },
  started: { pt: 'Início', en: 'Started' },
  duration: { pt: 'Duração', en: 'Duration' },
  counting: { pt: ' (e contando…)', en: ' (and counting…)' },
  participants: { pt: 'Participantes', en: 'Participants' },
  nobody: { pt: 'Ninguém falou ainda. 🤷', en: 'Nobody has spoken yet. 🤷' },
  downloads: { pt: 'Downloads', en: 'Downloads' },
  mp3sub: { pt: 'uma faixa por pessoa (ZIP)', en: 'one track per speaker (ZIP)' },
  flacsub: { pt: 'lossless, uma faixa por pessoa (ZIP)', en: 'lossless, one track per speaker (ZIP)' },
  mixsub: { pt: 'todo mundo junto (MP3)', en: 'everyone together (MP3)' },
  audacitysub: { pt: 'FLAC + projeto alinhado + notas', en: 'FLAC + aligned project + notes' },
  transcript: { pt: 'Transcrição', en: 'Transcript' },
  transcriptPending: { pt: '⏳ Transcrição na fila…', en: '⏳ Transcript queued…' },
  transcriptRunning: {
    pt: '⚙️ Transcrevendo… (esta página se atualiza sozinha)',
    en: '⚙️ Transcribing… (this page refreshes itself)',
  },
  transcriptError: { pt: '⚠️ A transcrição falhou: ', en: '⚠️ Transcription failed: ' },
  transcriptEmpty: {
    pt: 'A transcrição terminou sem texto (só silêncio?).',
    en: 'The transcript finished empty (only silence?).',
  },
  transcriptDownload: { pt: '⬇️ Baixar (.md)', en: '⬇️ Download (.md)' },
  transcriptDownloadTxt: { pt: '⬇️ Baixar (.txt)', en: '⬇️ Download (.txt)' },
  notes: { pt: 'Notas', en: 'Notes' },
  minutes: { pt: 'Ata da reunião', en: 'Meeting minutes' },
  minutesPending: { pt: '⏳ Gerando a ata…', en: '⏳ Generating minutes…' },
  minutesRunning: {
    pt: '⚙️ Gerando a ata… (a página se atualiza sozinha)',
    en: '⚙️ Generating minutes… (page refreshes itself)',
  },
  minutesError: { pt: '⚠️ Não consegui gerar a ata: ', en: '⚠️ Could not generate minutes: ' },
  mSummary: { pt: 'Resumo', en: 'Summary' },
  mDecisions: { pt: 'Decisões', en: 'Decisions' },
  mActions: { pt: 'Itens de ação', en: 'Action items' },
  mTopics: { pt: 'Tópicos', en: 'Topics' },
  mOwner: { pt: 'resp.', en: 'owner' },
  mDue: { pt: 'prazo', en: 'due' },
  mPerPerson: { pt: 'Por participante', en: 'By participant' },
  minutesDownload: { pt: '⬇️ Baixar ata (.md)', en: '⬇️ Download minutes (.md)' },
  listen: { pt: '🔊 Ouvir a gravação', en: '🔊 Listen to the recording' },
  seekHint: {
    pt: 'Clique num horário para pular pra aquele momento.',
    en: 'Click a timestamp to jump to that moment.',
  },
  demoBanner: {
    pt: '🎬 <b>Exemplo ao vivo</b> — uma reunião fictícia. Numa gravação real você também tem player com áudio completo, downloads (MP3/FLAC/mix/Audacity) e horários clicáveis, tudo protegido por login.',
    en: '🎬 <b>Live demo</b> — a fictional meeting. On a real recording you also get an audio player, downloads (MP3/FLAC/mix/Audacity) and clickable timestamps, all behind login.',
  },
  sampleAudio: { pt: '🔊 Áudio de amostra (trecho de abertura)', en: '🔊 Sample audio (opening excerpt)' },
  sampleNote: {
    pt: 'Trecho curto e fictício, só pra dar o tom. Numa gravação real o áudio tem a duração completa e os horários acima são clicáveis.',
    en: 'A short, fictional excerpt just to set the tone. On a real recording the audio is full-length and the timestamps are clickable.',
  },
  cooking: {
    pt: 'O player usa um mix pré-processado; os downloads são gerados na hora (gravações longas podem levar alguns segundos).',
    en: 'The player uses a pre-processed mix; downloads are generated on demand (long recordings may take a few seconds).',
  },
  livenote: {
    pt: '🔴 Gravação em andamento: os downloads trazem o áudio <strong>até este momento</strong>. Esta página se atualiza sozinha a cada 30 segundos.',
    en: '🔴 Recording in progress: downloads contain the audio <strong>up to this moment</strong>. This page refreshes itself every 30 seconds.',
  },
  timeline: { pt: 'Linha do tempo', en: 'Timeline' },
  del: { pt: '🗑️ Apagar gravação', en: '🗑️ Delete recording' },
  delconfirm: {
    pt: 'Apagar esta gravação para sempre? Não tem volta.',
    en: 'Delete this recording forever? There is no undo.',
  },
  expires: { pt: '⏳ Esta gravação expira em {date}.', en: '⏳ This recording expires on {date}.' },
  presentAlso: { pt: 'Também estavam na call (sem falar)', en: 'Also in the call (did not speak)' },
  transcriptPartial: {
    pt: '⚠️ Transcrição parcial — ainda faltam: {names}. Vou tentar de novo sozinho (limite por hora do provedor).',
    en: '⚠️ Partial transcript — still missing: {names}. I will retry automatically (provider hourly limit).',
  },
  transcriptPartialFinal: {
    pt: '⚠️ Transcrição parcial — estas faixas não puderam ser transcritas: {names}.',
    en: '⚠️ Partial transcript — these tracks could not be transcribed: {names}.',
  },
  transcriptRetrying: {
    pt: '⏳ O serviço de IA limitou o uso agora há pouco — vou tentar de novo sozinho em alguns minutos.',
    en: '⏳ The AI service rate-limited us just now — I will retry by myself in a few minutes.',
  },
  presentAlsoLive: { pt: '👥 Na call agora (ainda sem falar)', en: '👥 In the call now (no speech yet)' },
  presentOnly: { pt: '👥 Estavam na call, mas ninguém falou', en: '👥 Were in the call, but nobody spoke' },
  nobodyDone: { pt: 'Ninguém falou nesta gravação.', en: 'Nobody spoke in this recording.' },
  follow: { pt: 'seguir o áudio', en: 'follow audio' },
  searchTranscript: { pt: 'Buscar na transcrição…', en: 'Search the transcript…' },
  copyActions: { pt: 'Copiar itens de ação', en: 'Copy action items' },
  timelineAll: { pt: 'Todos os eventos ({n})', en: 'All events ({n})' },
  tlTopics: { pt: 'tópicos da ata', en: 'minutes topics' },
  tlNotes: { pt: 'notas', en: 'notes' },
  tlJoined: { pt: 'entrou', en: 'joined' },
  tlLeft: { pt: 'saiu', en: 'left' },
  tlHint: { pt: 'clique pra pular no áudio', en: 'click to jump in the audio' },
  audioExpired: {
    pt: '🔇 O áudio desta gravação expirou (retenção). A transcrição, a ata e as notas continuam aqui.',
    en: '🔇 The audio of this recording has expired (retention). Transcript, minutes and notes remain here.',
  },
  textExpires: {
    pt: '⏳ Transcrição e ata expiram em {date}. O áudio já expirou.',
    en: '⏳ Transcript and minutes expire on {date}. The audio has already expired.',
  },
};

function p(l: Locale, key: string, vars: Record<string, string> = {}): string {
  let text = P[key]?.[l] ?? key;
  for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, () => value);
  return text;
}

const SHELL_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { background: #101012; color: #b6b4b2; font-family: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
         min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 40px 16px; }
  .card { background: #17171a; border: 1px solid rgba(255,255,255,.13); border-radius: 6px;
          padding: 28px; max-width: 640px; width: 100%; }
  h1 { font-size: 22px; color: #f1eeec; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: #8a888c; margin: 22px 0 10px; }
  .muted { color: #8a888c; font-size: 14px; }
  .grid { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin-top: 14px; font-size: 15px; }
  .grid dt { color: #8a888c; }
  .badge { font-size: 12px; font-weight: 700; padding: 3px 10px; border-radius: 999px; vertical-align: middle; }
  .badge.live { background: #da373c; color: #fff; animation: pulse 1.6s infinite; }
  .badge.done { background: #23a55a; color: #fff; }
  @keyframes pulse { 50% { opacity: .55; } }
  .people { display: flex; flex-wrap: wrap; gap: 8px; }
  .person { display: flex; align-items: center; gap: 8px; background: #101012; border: 1px solid rgba(255,255,255,.1); padding: 6px 12px 6px 6px;
            border-radius: 999px; font-size: 14px; }
  .person img { width: 26px; height: 26px; border-radius: 50%; }
  .downloads { display: flex; flex-wrap: wrap; gap: 10px; }
  /* .btn cobre <a> E <button> (o connect usa <button class="btn"> — antes caía no botão cinza padrão) */
  .btn { display: inline-flex; flex-direction: column; gap: 2px; text-decoration: none; background: #5865f2;
         color: #fff; padding: 12px 18px; border-radius: 8px; font-size: 15px; font-weight: 600;
         border: 0; cursor: pointer; font-family: inherit; line-height: 1.2; }
  .btn small { font-weight: 400; font-size: 12px; opacity: .8; }
  .btn:hover { background: #4752c4; }
  .btn.secondary { background: #232327; }
  .btn.secondary:hover { background: #2a2a2f; }
  .events { list-style: none; font-size: 14px; display: flex; flex-direction: column; gap: 4px;
            max-height: 220px; overflow-y: auto; }
  .events time { color: #8a888c; font-family: ui-monospace, monospace; margin-right: 8px; }
  .wall { color: #6d7178 !important; font-size: 12px; }
  .transcript { display: flex; flex-direction: column; gap: 14px;
                background: #101012; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; padding: 14px; font-size: 14px; }
  .transcript p { line-height: 1.5; padding: 2px 6px; border-left: 2px solid transparent; border-radius: 4px; }
  .transcript p.now { background: rgba(88,101,242,.12); border-left-color: #5865f2; }
  .transcript .who { color: #f1eeec; font-weight: 600; }
  .tblock .thead { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
  .tblock .thead img { width: 22px; height: 22px; border-radius: 50%; }
  .tblock .thead .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; background: currentColor; }
  /* paleta estável por falante */
  .c0 { color: #7b90f7; } .c1 { color: #3dbf7a; } .c2 { color: #f0b232; } .c3 { color: #eb6ab5; }
  .c4 { color: #29b0e8; } .c5 { color: #e8735a; } .c6 { color: #a58cf2; } .c7 { color: #4fd1c5; }
  .tblock .thead .dot.c0 { background:#7b90f7 } .tblock .thead .dot.c1 { background:#3dbf7a }
  .tblock .thead .dot.c2 { background:#f0b232 } .tblock .thead .dot.c3 { background:#eb6ab5 }
  .tblock .thead .dot.c4 { background:#29b0e8 } .tblock .thead .dot.c5 { background:#e8735a }
  .tblock .thead .dot.c6 { background:#a58cf2 } .tblock .thead .dot.c7 { background:#4fd1c5 }
  .tsearch { display: flex; flex-direction: column; gap: 8px; margin: 8px 0 10px; }
  .tsearch input { background: #101012; border: 1px solid rgba(255,255,255,.13); color: #c9c7c5; border-radius: 8px;
                   padding: 9px 12px; font-size: 14px; width: 100%; }
  .tsearch input:focus { outline: none; border-color: #5865f2; }
  .fchips { display: flex; flex-wrap: wrap; gap: 6px; }
  .fchip { background: #17171a; border: 1px solid rgba(255,255,255,.13); border-radius: 999px; padding: 3px 10px;
           font-size: 12.5px; cursor: pointer; font-family: inherit; }
  .fchip.off { opacity: .35; text-decoration: line-through; }
  .copybtn { background: #232327; border: 0; border-radius: 6px; color: #c9c7c5; cursor: pointer;
             font-size: 12px; padding: 3px 8px; vertical-align: middle; margin-left: 6px; }
  .copybtn:hover { background: #2a2a2f; }
  .subline { color: #8a888c; font-size: 14px; margin-top: 6px; }
  .playerwrap { position: sticky; top: 0; z-index: 5; background: #17171a; padding: 12px 0 8px;
                margin: 18px 0 6px; border-bottom: 1px solid rgba(255,255,255,.13); }
  .playerwrap audio { width: 100%; }
  .pctl { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 6px;
          font-size: 12.5px; color: #8a888c; }
  .speed { display: inline-flex; gap: 4px; }
  .speed button { background: #101012; border: 1px solid rgba(255,255,255,.13); color: #b6b4b2; border-radius: 6px;
                  padding: 2px 9px; font-size: 12px; cursor: pointer; font-family: inherit; }
  .speed button.on { background: #5865f2; color: #fff; border-color: #5865f2; }
  .follow { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
  /* linha do tempo: capítulos (blocos) + ticks (notas/entra-sai) + eixo + legenda */
  .tl2 { margin: 6px 0 10px; }
  .tl-ch { position: relative; height: 26px; }
  .tl-seg { position: absolute; top: 0; height: 22px; border-radius: 4px; overflow: hidden;
            text-decoration: none; display: flex; align-items: center; padding: 0 6px; }
  .tl-seg.s0 { background: rgba(88,101,242,.28); }
  .tl-seg.s1 { background: rgba(88,101,242,.16); }
  .tl-seg:hover { background: rgba(88,101,242,.45); }
  .tl-seg span { font-size: 10px; color: #c9cdfb; font-family: ui-monospace, monospace;
                 width: 100%; text-align: center; overflow: hidden; }
  .tl-chlist { list-style: none; margin-top: 12px; display: grid;
               grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 4px 22px; }
  .tl-chlist a { display: flex; align-items: baseline; gap: 8px; text-decoration: none;
                 color: #c9c7c5; font-size: 13px; line-height: 1.5; padding: 2px 4px; border-radius: 4px; }
  .tl-chlist a:hover { background: rgba(88,101,242,.12); color: #f1eeec; }
  .tl-chlist b { color: #7b90f7; font-weight: 600; font-size: 11px; }
  .tl-chlist time { color: #8a888c; font-family: ui-monospace, monospace; font-size: 11.5px; flex-shrink: 0; }
  .tl-chlist span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tl-ticks { position: relative; height: 14px; margin-top: 3px; }
  .tl-tk { position: absolute; top: 1px; width: 4px; height: 12px; border-radius: 2px;
           transform: translateX(-50%); }
  .tl-tk.tnote { background: #f0b232; width: 5px; }
  .tl-tk.join { background: #3fbf7a; opacity: .75; }
  .tl-tk.leave { background: #6d7178; opacity: .75; }
  .tl-tk:hover { transform: translateX(-50%) scaleY(1.3); }
  .tl-ax { display: flex; justify-content: space-between; font-size: 11px; color: #6d7178;
           font-family: ui-monospace, monospace; border-top: 1px solid rgba(255,255,255,.13);
           padding-top: 4px; margin-top: 4px; }
  .tl-lg { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 11.5px; color: #8a888c;
           margin-top: 6px; align-items: center; }
  .tl-lg i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px;
             vertical-align: -1px; }
  .tl-lg .lg-ch { background: rgba(88,101,242,.55); }
  .tl-lg .lg-note { background: #f0b232; }
  .tl-lg .lg-join { background: #3fbf7a; }
  .tl-lg .lg-leave { background: #6d7178; }
  .tl-lg .lg-hint { margin-left: auto; color: #6d7178; }
  .evlist summary { cursor: pointer; font-size: 13px; color: #8a888c; margin: 6px 0; }
  .minutes .lead { font-size: 15.5px; line-height: 1.55; color: #f1eeec; }
  /* índice de gravações */
  .isearch { display: flex; gap: 8px; margin: 14px 0 4px; }
  .isearch input { flex: 1; background: #101012; border: 1px solid rgba(255,255,255,.13); color: #c9c7c5;
                   border-radius: 8px; padding: 10px 12px; font-size: 14px; }
  .isearch input:focus { outline: none; border-color: #5865f2; }
  .isearch .btn { flex-direction: row; align-items: center; padding: 10px 16px; }
  .rlist { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
  .rcard { display: block; background: #101012; border: 1px solid rgba(255,255,255,.13); border-radius: 10px;
           padding: 12px 14px; text-decoration: none; color: #c9c7c5; }
  .rcard:hover { border-color: #5865f2; }
  .rcard .rrow1 { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
  .rcard .rrow2 { color: #8a888c; font-size: 13px; margin-top: 4px; }
  .wb { font-size: 11.5px; background: #17171a; border-radius: 999px; padding: 2px 9px; color: #8a888c; }
  .wb.ok { color: #3dbf7a; } .wb.warn { color: #f0b232; } .wb.live { color: #fff; background: #da373c; }
  .hits { list-style: none; display: flex; flex-direction: column; gap: 10px; font-size: 14px; margin-top: 8px; }
  .hits a { color: #00a8fc; text-decoration: none; }
  .hits a:hover { text-decoration: underline; }
  .transcript time { color: #8a888c; font-family: ui-monospace, monospace; font-size: 12px; margin-right: 6px; }
  .tstate { font-size: 14px; color: #8a888c; }
  details.tech { margin-top: 6px; font-size: 12px; color: #6d7178; }
  details.tech summary { cursor: pointer; }
  details.tech code { display: block; margin-top: 6px; padding: 8px 10px; background: #101012; border: 1px solid rgba(255,255,255,.1);
                      border-radius: 6px; overflow-wrap: anywhere; }
  .tdl { display: flex; gap: 10px; margin-top: 10px; }
  .tdl a { color: #00a8fc; font-size: 13px; text-decoration: none; }
  .tdl a:hover { text-decoration: underline; }
  .notes { list-style: none; font-size: 14px; display: flex; flex-direction: column; gap: 4px; }
  .notes time { color: #8a888c; font-family: ui-monospace, monospace; margin-right: 8px; }
  .minutes { background: #101012; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; padding: 16px 18px; font-size: 14.5px; line-height: 1.5; }
  .minutes h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: #8a888c; margin: 16px 0 8px; }
  .minutes h3:first-child { margin-top: 0; }
  .minutes ul { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 5px; }
  .minutes .action { display: flex; gap: 8px; align-items: baseline; }
  .minutes .meta2 { color: #8a888c; font-size: 12.5px; }
  .minutes time { color: #8a888c; font-family: ui-monospace, monospace; margin-right: 6px; }
  .minutes .who { color: #f1eeec; font-weight: 600; margin: 10px 0 4px; }
  .ts { color: #00a8fc; font-family: ui-monospace, monospace; font-size: 12px; margin-right: 8px;
        text-decoration: none; cursor: pointer; }
  .ts:hover { text-decoration: underline; }
  .player { margin: 14px 0 4px; }
  .player audio { width: 100%; }
  .player .hint { font-size: 12.5px; color: #8a888c; margin-top: 4px; }
  form.delete { margin-top: 26px; border-top: 1px solid rgba(255,255,255,.13); padding-top: 16px; }
  button.danger { background: none; border: 1px solid #da373c; color: #da373c; padding: 8px 14px;
                  border-radius: 8px; font-size: 14px; cursor: pointer; }
  button.danger:hover { background: #da373c; color: #fff; }
  .topbar { max-width: 640px; width: 100%; display: flex; justify-content: space-between; align-items: center;
            gap: 8px; margin-bottom: 16px; font-size: 13px; color: #8a888c; }
  .topbar .brand { display: inline-flex; align-items: center; gap: 7px; font-weight: 800; font-size: 15px;
                   color: #f1eeec; text-decoration: none; }
  .topbar .topnav-r { display: inline-flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: flex-end; }
  .topbar .tl { color: #b6b4b2; text-decoration: none; }
  .topbar .tl:hover { color: #f1eeec; }
  .topbar .user { display: inline-flex; align-items: center; gap: 6px; color: #c9c7c5; }
  .topbar img { width: 22px; height: 22px; border-radius: 50%; }
  .langtoggle a { color: #8a888c; text-decoration: none; padding: 2px 4px; }
  .langtoggle a.on { color: #f1eeec; font-weight: 700; }
  .langtoggle a:hover { color: #c9c7c5; }
  .langtoggle span { opacity: .5; margin: 0 2px; }
  .topfoot { max-width: 640px; width: 100%; margin-top: 30px; padding-top: 16px; border-top: 1px solid rgba(255,255,255,.13);
             font-size: 13px; color: #8a888c; text-align: center; }
  .topfoot a { color: #b6b4b2; text-decoration: none; }
  .topfoot a:hover { color: #f1eeec; }
  .note { background: #101012; border: 1px solid rgba(255,255,255,.1); border-left: 3px solid #f0b232; padding: 10px 14px; border-radius: 6px;
          font-size: 14px; margin-top: 14px; }
  footer { margin-top: 26px; font-size: 13px; color: #8a888c; }
  /* nada de imagem/palavra longa forçando scroll horizontal no celular */
  img { max-width: 100%; height: auto; }
  .transcript p, .minutes, .note, .muted, .events li, h1 { overflow-wrap: anywhere; }
  @media (max-width: 480px) {
    body { padding: 20px 10px; }
    .card { padding: 18px; }
    h1 { font-size: 19px; }
    .downloads .btn { flex: 1 1 auto; text-align: center; align-items: center; }
    /* leitura longa no celular: um pouco mais de corpo e respiro */
    .transcript { font-size: 15px; padding: 12px 10px; }
    .transcript p { line-height: 1.6; }
    .pctl { gap: 10px; }
  }
`;

/**
 * Data localizada: renderiza no fuso do SERVIDOR como fallback (config.timezone,
 * default America/Sao_Paulo) e marca o epoch para o script no navegador reescrever
 * no fuso de quem abre a página — como o Discord faz.
 */
function datetime(ms: number, lang: Locale): string {
  const dateLocale = lang === 'pt' ? 'pt-BR' : 'en-US';
  const fallback = new Date(ms).toLocaleString(dateLocale, {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: config.timezone,
  });
  return `<time data-ts="${ms}">${esc(fallback)}</time>`;
}

/** Hora do relógio (HH:MM) no fuso do servidor, reescrita pro fuso do navegador via data-fmt="clock". */
function clockTime(ms: number, lang: Locale): string {
  const dateLocale = lang === 'pt' ? 'pt-BR' : 'en-US';
  const fallback = new Date(ms).toLocaleTimeString(dateLocale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: config.timezone,
  });
  return `<time class="wall" data-ts="${ms}" data-fmt="clock">${esc(fallback)}</time>`;
}

const TZ_SCRIPT = `<script>
document.querySelectorAll('time[data-ts]').forEach(function(el){
  try {
    var opts = el.dataset.fmt === 'clock' ? {timeStyle:'short'} : {dateStyle:'long', timeStyle:'short'};
    el.textContent = new Date(+el.dataset.ts).toLocaleString(navigator.language, opts);
  } catch(e){}
});
// pular pro momento no player de áudio; sem player (ex.: áudio expirado),
// rola até o trecho correspondente da transcrição — o deep link continua útil
window.kseek = function(ms){
  var p = document.getElementById('kplayer');
  if (p) {
    p.currentTime = Math.max(0, ms/1000);
    p.play().catch(function(){});
    return;
  }
  var paras = document.querySelectorAll('.transcript p[data-s]');
  for (var i = 0; i < paras.length; i++) {
    if (+paras[i].dataset.s >= ms) { paras[i].scrollIntoView({block:'center', behavior:'smooth'}); return; }
  }
};
// deep link do MCP/transcrição: #t=<segundos> pula pro momento ao abrir (e ao trocar o hash).
// preload=none: se os metadados ainda não carregaram, espera loadedmetadata antes de buscar.
function kseekFromHash(){
  var m = /#t=(\\d+)/.exec(location.hash);
  if (!m) return;
  var p = document.getElementById('kplayer');
  if (!p) return;
  var secs = +m[1];
  if (p.readyState >= 1) { window.kseek(secs*1000); }
  else { p.addEventListener('loadedmetadata', function(){ window.kseek(secs*1000); }, {once:true}); try { p.load(); } catch(e){} }
}
kseekFromHash();
window.addEventListener('hashchange', kseekFromHash);
</script>`;

/** Horário clicável que pula o player de áudio; `seekable=false` (ex.: demo) rende só o texto. */
function tsLink(ms: number, seekable = true): string {
  const v = Math.max(0, Math.floor(ms));
  if (!seekable) return `<time class="ts" style="cursor:default">${msToClock(v)}</time>`;
  return `<a class="ts" href="#" onclick="kseek(${v});return false">${msToClock(v)}</a>`;
}

function shell(
  title: string,
  body: string,
  opts: { user?: WebUser; lang?: Locale; refreshSeconds?: number; noindex?: boolean } = {},
): string {
  const lang = opts.lang === 'pt' ? 'pt' : 'en';
  // Toggle de idioma (fica salvo via cookie); links relativos preservam a rota atual.
  const langToggle = `<div class="langtoggle"><a href="?lang=en"${lang === 'en' ? ' class="on"' : ''}>EN</a><span>·</span><a href="?lang=pt"${lang === 'pt' ? ' class="on"' : ''}>PT</a></div>`;
  const repoLabel = config.repoPublic ? 'GitHub' : 'npm';
  // Cabeçalho de marca: dá contexto + saída (home) a TODA página do shell (demo, conectar-ia, gravações, erro).
  const userbar = `<header class="topbar">
    <a class="brand" href="/">🎙️ Kassinão</a>
    <span class="topnav-r">
      ${opts.user ? `<a class="tl" href="/gravacoes">${lang === 'pt' ? '📼 Gravações' : '📼 Recordings'}</a>` : ''}
      <a class="tl" href="/demo">Demo</a>
      <a class="tl" href="${ghHref()}">${repoLabel}</a>
      ${langToggle}
      ${opts.user ? `<span class="user">${opts.user.avatar ? `<img src="${esc(opts.user.avatar)}" alt="">` : ''}${esc(opts.user.name)}</span>` : ''}
    </span>
  </header>`;
  const foot = `<footer class="topfoot"><a href="/">🎙️ Kassinão</a> · AGPL-3.0 · open-source · <a href="${ghHref()}">${repoLabel}</a></footer>`;
  // Auto-refresh (enquanto transcrição/ata processam) via JS em vez de <meta refresh>,
  // pra NÃO recarregar e cortar o áudio enquanto a pessoa está ouvindo o player.
  // Preserva a posição de leitura (scrollY) entre os reloads.
  const refresh = opts.refreshSeconds
    ? `<script>
try { var ky = sessionStorage.getItem('k-scroll'); if (ky) { window.scrollTo(0, +ky); sessionStorage.removeItem('k-scroll'); } } catch(e){}
setTimeout(function(){var p=document.getElementById('kplayer');if(p&&!p.paused)return;try{sessionStorage.setItem('k-scroll', String(window.scrollY));}catch(e){}location.reload();},${opts.refreshSeconds * 1000});</script>`
    : '';
  return `<!doctype html>
<html lang="${lang === 'pt' ? 'pt-BR' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${opts.noindex ? '<meta name="robots" content="noindex">' : ''}
<title>${esc(title)} — Kassinão</title>
<link rel="icon" href="${FAVICON}">
<style>${SHELL_CSS}</style>
</head>
<body>
${userbar}
<div class="card">${body}</div>
${foot}
${TZ_SCRIPT}
${refresh}
</body>
</html>`;
}

/** Cor estável por falante (paleta Discord-friendly, 8 tons). */
const SPEAKER_COLORS = 8;
function speakerColorIdx(name: string, order: Map<string, number>): number {
  const idx = order.get(name);
  if (idx !== undefined) return idx % SPEAKER_COLORS;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % SPEAKER_COLORS;
}

export function recordingPage(
  meta: RecordingMeta,
  opts: {
    live: boolean;
    canDelete: boolean;
    user?: WebUser;
    lang: Locale;
    transcript?: TranscriptSegment[];
    minutes?: MeetingMinutes;
    demo?: boolean;
  },
): string {
  const { live, lang: l } = opts;
  const demo = opts.demo ?? false;
  const seekable = !demo; // no modo demo o áudio é só um trecho, então horários não pulam
  const endedAt = meta.endedAt ?? Date.now();
  const durMs = endedAt - meta.startedAt;
  const badge = live
    ? `<span class="badge live">${p(l, 'live')}</span>`
    : `<span class="badge done">${p(l, 'done')}</span>`;

  // ---------- cabeçalho: o QUE é esta gravação, numa linha ----------
  const nPeople = meta.participants.length;
  const subline = `<p class="subline">${esc(meta.guildName)} · ${datetime(meta.startedAt, l)} · ${formatDuration(durMs)}${
    live ? p(l, 'counting') : ''
  }${nPeople > 0 ? ` · 🎙️ ${nPeople}` : ''}</p>`;

  const people =
    meta.participants.length > 0
      ? `<div class="people">${meta.participants
          .map(
            (pt, i) =>
              `<span class="person">${pt.avatar ? `<img src="${esc(pt.avatar)}" alt="">` : '🎤'}<span class="who c${i % SPEAKER_COLORS}">${esc(pt.name)}</span></span>`,
          )
          .join('')}</div>`
      : `<p class="muted">${live ? p(l, 'nobody') : p(l, 'nobodyDone')}</p>`;

  // quem esteve na call mas nunca falou (presença ≠ faixa): frase certa por estado
  const spokeIds = new Set(meta.participants.map((pt) => pt.id));
  const silent = (meta.presence ?? []).filter((pr) => !spokeIds.has(pr.id));
  const silentLabel =
    meta.participants.length === 0 ? p(l, 'presentOnly') : live ? p(l, 'presentAlsoLive') : `👥 ${p(l, 'presentAlso')}`;
  const presentAlso =
    silent.length > 0
      ? `<p class="muted" style="margin-top:8px">${silentLabel}: ${silent.map((pr) => esc(pr.name)).join(', ')}</p>`
      : '';

  // ---------- player (sticky + velocidade + seguir) ----------
  const audioGone = !!meta.audioDeleted;
  let player = '';
  if (demo) {
    player = `<h2>${p(l, 'sampleAudio')}</h2>
       <div class="player">
         <audio preload="none" controls src="/demo/audio"></audio>
         <div class="hint">${p(l, 'sampleNote')}</div>
       </div>`;
  } else if (audioGone) {
    player = `<div class="note" style="border-left-color:#6d7178;margin-top:14px">${p(l, 'audioExpired')}</div>`;
  } else if (!live && meta.participants.length > 0) {
    player = `<div class="playerwrap">
         <audio id="kplayer" preload="none" controls src="/rec/${meta.id}/audio"></audio>
         <div class="pctl">
           <span class="speed">
             <button type="button" data-r="1" class="on">1×</button>
             <button type="button" data-r="1.5">1.5×</button>
             <button type="button" data-r="2">2×</button>
           </span>
           <label class="follow"><input type="checkbox" id="kfollow"> ${p(l, 'follow')}</label>
           <span class="hint">${p(l, 'seekHint')}</span>
         </div>
       </div>`;
  }

  const liveNote = live ? `<div class="note">${p(l, 'livenote')}</div>` : '';
  const demoNote = demo ? `<div class="note">${p(l, 'demoBanner')}</div>` : '';

  const minutes = renderMinutes(meta, opts.minutes, l, seekable);
  const transcription = renderTranscription(meta, opts.transcript, l, seekable);

  const notes =
    meta.notes.length > 0
      ? `<h2 id="notas">${p(l, 'notes')}</h2><ul class="notes">${meta.notes
          .map(
            (n) =>
              `<li>${seekable ? `<a class="ts" href="#" onclick="kseek(${n.atMs});return false">${formatOffset(n.atMs)}</a>` : `<time>${formatOffset(n.atMs)}</time>`}${clockTime(meta.startedAt + n.atMs, l)}<strong>${esc(n.author)}:</strong> ${esc(n.text)}</li>`,
          )
          .join('')}</ul>`
      : '';

  // ---------- linha do tempo: barra visual clicável + lista dobrável ----------
  const events = renderTimeline(meta, opts.minutes, l, durMs, live, seekable);

  // ---------- exportar (uso raro → rebaixado pra baixo, estilo secundário) ----------
  const downloads =
    !demo && !audioGone && meta.participants.length > 0
      ? `<h2 id="exportar">${p(l, 'downloads')}</h2>
        <div class="downloads">
          <a class="btn secondary" href="/rec/${meta.id}/download/mp3">🎵 MP3 <small>${p(l, 'mp3sub')}</small></a>
          <a class="btn secondary" href="/rec/${meta.id}/download/flac">💎 FLAC <small>${p(l, 'flacsub')}</small></a>
          <a class="btn secondary" href="/rec/${meta.id}/download/mix">🎧 Mix <small>${p(l, 'mixsub')}</small></a>
          <a class="btn secondary" href="/rec/${meta.id}/download/audacity">🎚️ Audacity <small>${p(l, 'audacitysub')}</small></a>
        </div>
        <p class="muted" style="margin-top:10px">${p(l, 'cooking')}</p>`
      : '';

  const deleteForm =
    opts.canDelete && !live
      ? `<form class="delete" method="post" action="/rec/${meta.id}/delete"
         onsubmit="return confirm('${p(l, 'delconfirm')}')">
         <button class="danger" type="submit">${p(l, 'del')}</button>
       </form>`
      : '';

  const pageFoot = !demo
    ? `<footer>${
        !live
          ? audioGone
            ? meta.textExpiresAt
              ? `${p(l, 'textExpires', { date: datetime(meta.textExpiresAt, l) })} · `
              : ''
            : meta.expiresAt
              ? `${p(l, 'expires', { date: datetime(meta.expiresAt, l) })} · `
              : ''
          : ''
      }ID <code>${esc(meta.id)}</code></footer>`
    : '';

  // Demo é a vitrine: depois da prova, um CTA de conversão (fim do beco sem saída).
  const demoCta = demo
    ? `<div class="note" style="border-left-color:#5865f2;margin-top:28px">${
        l === 'pt'
          ? 'Curtiu? É exatamente assim que uma call de verdade fica — a ata e a transcrição saem sozinhas, com o nome de quem falou. <strong>Rode o seu:</strong> é open-source e roda no seu próprio servidor.'
          : 'Like what you see? This is exactly what a real call looks like — minutes and transcript write themselves, with exact speaker names. <strong>Deploy your own:</strong> it is open-source and runs on your server.'
      }</div>
     <div class="downloads" style="margin-top:14px">
       <a class="btn" href="${ghHref()}">${l === 'pt' ? '🚀 Rodar o meu Kassinão' : '🚀 Deploy your own'}</a>
       <a class="btn secondary" href="/">${l === 'pt' ? '← Início' : '← Home'}</a>
     </div>`
    : '';
  const title = `🔊 #${esc(meta.voiceChannelName)}`;

  return shell(
    demo ? `#${meta.voiceChannelName} (demo)` : `#${meta.voiceChannelName} — ${p(l, 'recording')}`,
    `<h1>${title} ${badge}</h1>
     ${subline}
     ${demoNote}
     ${liveNote}
     <h2>${p(l, 'participants')}</h2>
     ${people}
     ${presentAlso}
     ${player}
     ${minutes}
     ${transcription}
     ${notes}
     ${events}
     ${downloads}
     ${deleteForm}
     ${pageFoot}
     ${demoCta}
     ${RECORDING_SCRIPT}`,
    {
      user: opts.user,
      lang: l,
      noindex: !demo, // gravações reais (/rec/:id) fora de busca; a demo pública é indexável
      // ao vivo OU transcrição/ata em andamento: a página se atualiza sozinha
      refreshSeconds:
        live ||
        meta.transcription?.status === 'pending' ||
        meta.transcription?.status === 'running' ||
        // parcial/erro só re-atualizam enquanto há rodada automática agendada
        (meta.transcription?.status === 'partial' && meta.transcription.retryScheduled) ||
        (meta.transcription?.status === 'error' && meta.transcription.retryScheduled) ||
        meta.minutes?.status === 'pending' ||
        meta.minutes?.status === 'running'
          ? 30
          : undefined,
    },
  );
}

/** Barra do tempo clicável (marcadores por tipo) + lista completa dobrável. */
function renderTimeline(
  meta: RecordingMeta,
  minutes: MeetingMinutes | undefined,
  l: Locale,
  durMs: number,
  live: boolean,
  seekable: boolean,
): string {
  if (meta.events.length === 0) return '';

  const list = `<details class="evlist"${live ? ' open' : ''}><summary>${p(l, 'timelineAll', { n: String(meta.events.length) })}</summary><ul class="events">${meta.events
    .map((e) => `<li><time>${formatOffset(e.atMs)}</time>${clockTime(meta.startedAt + e.atMs, l)}${esc(e.text)}</li>`)
    .join('')}</ul></details>`;

  // Barra visual só com duração fechada. Desenho: CAPÍTULOS da ata como blocos
  // clicáveis (estilo YouTube) + notas/entra-sai como ticks discretos noutra
  // pista. "Falou pela primeira vez" fica só na lista (na barra é ruído).
  let bar = '';
  if (!live && durMs > 0) {
    const pct = (ms: number) => Math.min(100, Math.max(0, (ms / durMs) * 100)).toFixed(2);
    const click = (ms: number) => (seekable ? ` onclick="kseek(${Math.floor(ms)});return false" href="#"` : '');

    // capítulos: do início de um tópico até o início do próximo. Com MUITOS
    // tópicos os blocos ficam finos demais pra rótulo — então a barra mostra só
    // o NÚMERO (posição/duração) e a leitura acontece na lista logo abaixo.
    const topics = [...(minutes?.topicos ?? [])]
      .filter((tp) => tp.inicioMs >= 0 && tp.inicioMs < durMs) // LLM pode inventar tempo além do fim
      .sort((a, b) => a.inicioMs - b.inicioMs);
    let chapters = '';
    let chapterList = '';
    if (topics.length > 0) {
      const segs = topics.map((tp, i) => {
        const start = tp.inicioMs;
        const end = Math.min(i + 1 < topics.length ? topics[i + 1].inicioMs : durMs, durMs);
        const left = Number(pct(start));
        const w = Math.min(100 - left, Math.max(0.6, ((end - start) / durMs) * 100));
        return `<a class="tl-seg s${i % 2}" style="left:${left.toFixed(2)}%;width:${w.toFixed(2)}%"
          title="${esc(`${formatOffset(start)} · ${tp.titulo}`)}"${click(start)}><span>${i + 1}</span></a>`;
      });
      chapters = `<div class="tl-ch">${segs.join('')}</div>`;
      chapterList = `<ol class="tl-chlist">${topics
        .map(
          (tp, i) =>
            `<li><a${click(tp.inicioMs) || ' href="#"'}><b>${String(i + 1).padStart(2, '0')}</b><time>${formatOffset(tp.inicioMs)}</time><span>${esc(tp.titulo)}</span></a></li>`,
        )
        .join('')}</ol>`;
    }

    // ticks: notas (amarelo, por cima) + entrou/saiu (verde/cinza, discretos)
    const ticks: string[] = [];
    for (const n of meta.notes) {
      ticks.push(
        `<a class="tl-tk tnote" style="left:${pct(n.atMs)}%" title="${esc(`${formatOffset(n.atMs)} 📝 ${n.author}: ${n.text.slice(0, 80)}`)}"${click(n.atMs)}></a>`,
      );
    }
    for (const e of meta.events) {
      const kind = e.text.startsWith('🔊') || e.text.startsWith('👥') ? 'join' : e.text.startsWith('🚪') ? 'leave' : '';
      if (!kind) continue;
      ticks.push(
        `<a class="tl-tk ${kind}" style="left:${pct(e.atMs)}%" title="${esc(`${formatOffset(e.atMs)} ${e.text}`)}"${click(e.atMs)}></a>`,
      );
    }
    const tickRow = ticks.length > 0 ? `<div class="tl-ticks">${ticks.join('')}</div>` : '';

    if (chapters || tickRow) {
      // legenda só do que está NA barra, com as cores reais
      const legend: string[] = [];
      if (topics.length > 0) legend.push(`<span><i class="lg-ch"></i>${p(l, 'tlTopics')}</span>`);
      if (meta.notes.length > 0) legend.push(`<span><i class="lg-note"></i>${p(l, 'tlNotes')}</span>`);
      if (ticks.length > meta.notes.length)
        legend.push(
          `<span><i class="lg-join"></i>${p(l, 'tlJoined')}</span><span><i class="lg-leave"></i>${p(l, 'tlLeft')}</span>`,
        );
      bar = `<div class="tl2">
        ${chapters}
        ${tickRow}
        <div class="tl-ax"><span>0:00</span><span>${formatOffset(durMs)}</span></div>
        <div class="tl-lg">${legend.join('')}${seekable ? `<span class="lg-hint">${p(l, 'tlHint')}</span>` : ''}</div>
        ${chapterList}
      </div>`;
    }
  }

  return `<h2 id="timeline">${p(l, 'timeline')}</h2>${bar}${list}`;
}

/** Script da página de gravação: velocidade, seguir-áudio (karaoke) e busca na transcrição. */
const RECORDING_SCRIPT = `<script>
(function(){
  var player = document.getElementById('kplayer');
  // velocidade
  document.querySelectorAll('.speed button').forEach(function(b){
    b.addEventListener('click', function(){
      if (!player) return;
      player.playbackRate = +b.dataset.r;
      document.querySelectorAll('.speed button').forEach(function(x){ x.classList.toggle('on', x===b); });
    });
  });
  // karaoke-follow: destaca o trecho tocando; com "seguir" ligado, rola junto
  var paras = Array.prototype.slice.call(document.querySelectorAll('.transcript p[data-s]'));
  var current = null;
  if (player && paras.length) {
    player.addEventListener('timeupdate', function(){
      var ms = player.currentTime * 1000, hit = null;
      for (var i = 0; i < paras.length; i++) {
        var s = +paras[i].dataset.s;
        if (s > ms) break;
        if (ms <= +paras[i].dataset.e + 1500) hit = paras[i];
      }
      if (hit === current) return;
      if (current) current.classList.remove('now');
      current = hit;
      if (current) {
        current.classList.add('now');
        var f = document.getElementById('kfollow');
        if (f && f.checked) current.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    });
  }
  // busca + filtro por falante
  var input = document.getElementById('ksearch');
  function applyFilter(){
    var q = input ? input.value.trim().toLowerCase() : '';
    var off = {};
    document.querySelectorAll('.fchip.off').forEach(function(c){ off[c.dataset.sp] = true; });
    document.querySelectorAll('.transcript .tblock').forEach(function(b){
      if (off[b.dataset.sp]) { b.style.display = 'none'; return; }
      var any = false;
      b.querySelectorAll('p').forEach(function(pp){
        var show = !q || pp.textContent.toLowerCase().indexOf(q) !== -1;
        pp.style.display = show ? '' : 'none';
        if (show) any = true;
      });
      b.style.display = any ? '' : 'none';
    });
  }
  if (input) input.addEventListener('input', applyFilter);
  document.querySelectorAll('.fchip').forEach(function(c){
    c.addEventListener('click', function(){ c.classList.toggle('off'); applyFilter(); });
  });
  // copiar itens de ação
  var cp = document.getElementById('kcopyact');
  if (cp) cp.addEventListener('click', function(){
    navigator.clipboard.writeText(cp.dataset.txt).then(function(){
      var old = cp.textContent; cp.textContent = '✓'; setTimeout(function(){ cp.textContent = old; }, 1200);
    }).catch(function(){});
  });
})();
</script>`;

function renderMinutes(meta: RecordingMeta, minutes: MeetingMinutes | undefined, l: Locale, seekable = true): string {
  const state = meta.minutes;
  if (!state || state.status === 'disabled') return '';
  const title = `<h2 id="ata">📋 ${p(l, 'minutes')}</h2>`;
  if (state.status === 'pending') return `${title}<p class="tstate">${p(l, 'minutesPending')}</p>`;
  if (state.status === 'running') return `${title}<p class="tstate">${p(l, 'minutesRunning')}</p>`;
  if (state.status === 'error')
    return `${title}<p class="tstate">${p(l, 'minutesError')}${esc(shortError(state.error, l))}</p>${techDetails(state.error, l)}`;
  if (!minutes) return '';

  const parts: string[] = [];
  // o resumo é o TL;DR — destaque tipográfico próprio
  if (minutes.resumo) parts.push(`<h3 id="resumo">${p(l, 'mSummary')}</h3><p class="lead">${esc(minutes.resumo)}</p>`);
  if (minutes.decisoes.length) {
    parts.push(
      `<h3 id="decisoes">${p(l, 'mDecisions')}</h3><ul>${minutes.decisoes.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>`,
    );
  }
  if (minutes.acoes.length) {
    // texto plano pro botão copiar (colar no chat do time é o fluxo nº 1 pós-call)
    const plain = minutes.acoes
      .map((a) => {
        const extra = [a.responsavel, a.prazo].filter(Boolean).join(' — ');
        return `- [ ] ${a.tarefa}${extra ? ` (${extra})` : ''}`;
      })
      .join('\n');
    parts.push(
      `<h3 id="acoes">${p(l, 'mActions')} <button type="button" class="copybtn" id="kcopyact" data-txt="${esc(plain)}" title="${p(l, 'copyActions')}">📋</button></h3><ul>${minutes.acoes
        .map((a) => {
          const bits = [
            a.responsavel ? `${p(l, 'mOwner')}: ${esc(a.responsavel)}` : '',
            a.prazo ? `${p(l, 'mDue')}: ${esc(a.prazo)}` : '',
          ].filter(Boolean);
          const meta2 = bits.length ? ` <span class="meta2">(${bits.join(' • ')})</span>` : '';
          return `<li class="action">☐ <span>${esc(a.tarefa)}${meta2}</span></li>`;
        })
        .join('')}</ul>`,
    );
  }
  if (minutes.topicos.length) {
    parts.push(
      `<h3 id="topicos">${p(l, 'mTopics')}</h3><ul>${minutes.topicos
        .map((tp) => `<li>${tsLink(tp.inicioMs, seekable)}${esc(tp.titulo)}</li>`)
        .join('')}</ul>`,
    );
  }
  if (minutes.porParticipante?.length) {
    parts.push(
      `<h3>${p(l, 'mPerPerson')}</h3>${minutes.porParticipante
        .map(
          (pp) => `<p class="who">${esc(pp.nome)}</p><ul>${pp.pontos.map((pt) => `<li>${esc(pt)}</li>`).join('')}</ul>`,
        )
        .join('')}`,
    );
  }
  if (parts.length === 0) return '';

  // Download .md vai pela rota protegida /rec/:id — no modo demo (público) omitimos.
  const dl = seekable ? `<div class="tdl"><a href="/rec/${meta.id}/ata.md">${p(l, 'minutesDownload')}</a></div>` : '';
  return `${title}<div class="minutes">${parts.join('')}</div>${dl}`;
}

function renderTranscription(
  meta: RecordingMeta,
  transcript: TranscriptSegment[] | undefined,
  l: Locale,
  seekable = true,
): string {
  const state = meta.transcription;
  if (!state || state.status === 'disabled') return '';
  const title = `<h2 id="transcricao">${p(l, 'transcript')}</h2>`;
  const hasContent = !!transcript && transcript.length > 0;

  // Banner de estado (mostrado ACIMA do conteúdo, se houver conteúdo — texto
  // já entregue nunca some da página durante uma rodada de retry).
  let note = '';
  if (state.status === 'pending') note = `<p class="tstate">${p(l, 'transcriptPending')}</p>`;
  else if (state.status === 'running') note = `<p class="tstate">${p(l, 'transcriptRunning')}</p>`;
  else if (state.status === 'error') {
    // erro com retry agendado NÃO é falha definitiva — não assustar o usuário
    note = state.retryScheduled
      ? `<p class="tstate">${p(l, 'transcriptRetrying')}</p>`
      : `${title}<p class="tstate">${p(l, 'transcriptError')}${esc(shortError(state.error, l))}</p>${techDetails(state.error, l)}`;
    if (!state.retryScheduled) return note; // erro final substitui a seção
  } else if (state.status === 'partial') {
    const names =
      (state.pendingTracks ?? []).map((n) => esc(n)).join(', ') || (l === 'pt' ? 'algumas faixas' : 'some tracks');
    note = `<p class="tstate" style="margin-bottom:8px">${p(
      l,
      state.retryScheduled ? 'transcriptPartial' : 'transcriptPartialFinal',
      { names },
    )}</p>`;
  }

  if (!hasContent) {
    if (state.status === 'done') return `${title}<p class="tstate">${p(l, 'transcriptEmpty')}</p>`;
    return `${title}${note || `<p class="tstate">${p(l, 'transcriptPending')}</p>`}`;
  }

  // ---------- agrupamento por falante + cor estável + busca/filtro ----------
  const order = new Map<string, number>();
  meta.participants.forEach((pt, i) => order.set(pt.name, i));
  const avatarOf = new Map(meta.participants.map((pt) => [pt.name, pt.avatar]));

  const blocks: string[] = [];
  let curSpeaker = '';
  let curParas: string[] = [];
  const flush = () => {
    if (!curParas.length) return;
    const ci = speakerColorIdx(curSpeaker, order);
    const av = avatarOf.get(curSpeaker);
    blocks.push(
      `<div class="tblock" data-sp="${esc(curSpeaker)}">
        <div class="thead">${av ? `<img src="${esc(av)}" alt="">` : `<span class="dot c${ci}"></span>`}<span class="who c${ci}">${esc(curSpeaker)}</span></div>
        ${curParas.join('')}
      </div>`,
    );
    curParas = [];
  };
  for (const s of transcript!) {
    if (s.speaker !== curSpeaker) {
      flush();
      curSpeaker = s.speaker;
    }
    curParas.push(
      `<p data-s="${Math.floor(s.startMs)}" data-e="${Math.floor(s.endMs)}">${tsLink(s.startMs, seekable)}${esc(s.text)}</p>`,
    );
  }
  flush();

  const speakers = [...new Set(transcript!.map((s) => s.speaker))];
  const chips = speakers
    .map(
      (sp) =>
        `<button type="button" class="fchip c${speakerColorIdx(sp, order)}" data-sp="${esc(sp)}">${esc(sp)}</button>`,
    )
    .join('');
  const search = `<div class="tsearch">
      <input id="ksearch" type="search" placeholder="${p(l, 'searchTranscript')}" autocomplete="off">
      ${speakers.length > 1 ? `<div class="fchips">${chips}</div>` : ''}
    </div>`;

  // Downloads .md/.txt vão pelas rotas protegidas /rec/:id — no modo demo (público) omitimos.
  const dl = seekable
    ? `<div class="tdl">
      <a href="/rec/${meta.id}/transcricao.md">${p(l, 'transcriptDownload')}</a>
      <a href="/rec/${meta.id}/transcricao.txt">${p(l, 'transcriptDownloadTxt')}</a>
    </div>`
    : '';
  return `${title}${note}${search}<div class="transcript">${blocks.join('')}</div>${dl}`;
}

/** Detalhe técnico dobrado (o erro cru fica disponível, mas fora da cara do usuário). */
function techDetails(error: string | undefined, l: Locale): string {
  if (!error) return '';
  return `<details class="tech"><summary>${l === 'pt' ? 'detalhes técnicos' : 'technical details'}</summary><code>${esc(error)}</code></details>`;
}

/** Selo de estado pra lista de gravações (espelho do badge do /gravacoes no Discord). */
function webBadge(m: RecordingMeta, l: Locale): string {
  const pt = l === 'pt';
  if (m.status === 'recording') return `<span class="wb live">🔴 ${pt ? 'ao vivo' : 'live'}</span>`;
  if (m.minutes?.status === 'done') return `<span class="wb ok">📋 ${pt ? 'ata pronta' : 'minutes ready'}</span>`;
  const ts = m.transcription?.status;
  if (ts === 'partial' && !m.transcription?.retryScheduled)
    return `<span class="wb warn">📝 ${pt ? 'transcrição parcial' : 'partial transcript'}</span>`;
  if (ts === 'pending' || ts === 'running' || ((ts === 'partial' || ts === 'error') && m.transcription?.retryScheduled))
    return `<span class="wb">⏳ ${pt ? 'processando' : 'processing'}</span>`;
  if (ts === 'done') return `<span class="wb ok">📝 ${pt ? 'transcrição pronta' : 'transcript ready'}</span>`;
  if (ts === 'error') return `<span class="wb warn">⚠️ ${pt ? 'transcrição falhou' : 'transcription failed'}</span>`;
  return `<span class="wb">🔇 ${pt ? 'sem transcrição' : 'no transcript'}</span>`;
}

/** Índice web "minhas gravações": tudo que a pessoa pode acessar + busca. */
export function recordingsIndexPage(
  metas: RecordingMeta[],
  opts: { user: WebUser; lang: Locale; q?: string; hits?: WebSearchHit[] },
): string {
  const l = opts.lang;
  const pt = l === 'pt';
  const q = opts.q ?? '';

  const searchForm = `<form class="isearch" method="get" action="/gravacoes">
      <input name="q" type="search" value="${esc(q)}" placeholder="${pt ? 'Buscar em transcrições, atas e notas…' : 'Search transcripts, minutes and notes…'}" autocomplete="off">
      <button class="btn" type="submit">🔎 ${pt ? 'Buscar' : 'Search'}</button>
    </form>`;

  let hitsHtml = '';
  if (q) {
    const hits = opts.hits ?? [];
    hitsHtml =
      hits.length === 0
        ? `<p class="muted" style="margin:14px 0">${pt ? 'Nada encontrado para' : 'Nothing found for'} “${esc(q)}”.</p>`
        : `<h2>${pt ? 'Resultados' : 'Results'} (${hits.length})</h2>
           <ul class="hits">${hits
             .map((h) => {
               const link =
                 h.atMs !== undefined ? `/rec/${h.metaId}#t=${Math.floor(h.atMs / 1000)}` : `/rec/${h.metaId}`;
               const icon = h.kind === 'minutes' ? '📋' : h.kind === 'note' ? '📝' : '💬';
               const when = h.atMs !== undefined ? ` <a class="ts" href="${link}">${msToClock(h.atMs)}</a>` : '';
               return `<li>${icon} <a href="${link}"><strong>#${esc(h.channelName)}</strong></a> · ${datetime(h.startedAt, l)}${when}<br>
                 <span class="muted">${h.speaker ? `<strong>${esc(h.speaker)}:</strong> ` : ''}${esc(h.snippet)}</span></li>`;
             })
             .join('')}</ul>`;
  }

  const channels = [...new Set(metas.map((m) => m.voiceChannelName))];
  const chips =
    channels.length > 1
      ? `<div class="fchips" style="margin:10px 0 2px">${channels
          .map((c) => `<button type="button" class="fchip" data-ch="${esc(c)}">#${esc(c)}</button>`)
          .join('')}</div>`
      : '';

  const cards =
    metas.length === 0
      ? `<p class="muted" style="margin-top:16px">${
          pt
            ? 'Nenhuma gravação acessível ainda. Grave uma call com /gravar no Discord!'
            : 'No accessible recordings yet. Record a call with /record on Discord!'
        }</p>`
      : `<div class="rlist">${metas
          .map((m) => {
            const dur = m.endedAt ? formatDuration(m.endedAt - m.startedAt) : pt ? 'ao vivo' : 'live';
            return `<a class="rcard" href="/rec/${m.id}" data-ch="${esc(m.voiceChannelName)}">
              <div class="rrow1"><strong>#${esc(m.voiceChannelName)}</strong> ${webBadge(m, l)}</div>
              <div class="rrow2">${datetime(m.startedAt, l)} · ${dur} · 🎙️ ${m.participants.length}${
                m.audioDeleted ? ` · <span class="muted">🔇 ${pt ? 'áudio expirado' : 'audio expired'}</span>` : ''
              }</div>
            </a>`;
          })
          .join('')}</div>
        <script>
        document.querySelectorAll('.fchip[data-ch]').forEach(function(c){
          c.addEventListener('click', function(){
            c.classList.toggle('off');
            var off = {};
            document.querySelectorAll('.fchip.off').forEach(function(x){ off[x.dataset.ch] = true; });
            var any = document.querySelectorAll('.fchip.off').length > 0;
            document.querySelectorAll('.rcard').forEach(function(r){
              r.style.display = any && off[r.dataset.ch] ? 'none' : '';
            });
          });
        });
        </script>`;

  return shell(
    pt ? 'Minhas gravações' : 'My recordings',
    `<h1>📼 ${pt ? 'Minhas gravações' : 'My recordings'}</h1>
     <p class="subline">${pt ? 'Tudo que você pode acessar, em todos os servidores.' : 'Everything you can access, across servers.'}</p>
     ${searchForm}
     ${hitsHtml}
     ${chips}
     ${cards}`,
    { user: opts.user, lang: l, noindex: true },
  );
}

export function messagePage(title: string, message: string, user?: WebUser, lang?: Locale): string {
  // Páginas de mensagem/erro (404/403/etc.) não devem ser indexadas.
  // Link de saída pra não virar beco sem saída.
  const back = lang === 'pt' ? '← Início' : '← Home';
  const body =
    `<h1>${esc(title)}</h1><p class="muted" style="margin-top:12px">${esc(message)}</p>` +
    `<div class="downloads" style="margin-top:18px"><a class="btn" href="/">${back}</a></div>`;
  return shell(title, body, { user, lang, noindex: true });
}

const REPO_URL = 'https://github.com/resolvicomai/kassinao';
const NPM_URL = 'https://www.npmjs.com/package/kassinao-mcp';
// Enquanto o repo é privado, links "GitHub" apontam pro npm (público) pra não dar 404.
const ghHref = (): string => (config.repoPublic ? REPO_URL : NPM_URL);

// favicon inline (marca "K" em blurple) — data: URI permitido pela CSP (img-src data:), sem asset externo
const FAVICON =
  "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E%3Crect%20width='32'%20height='32'%20rx='7'%20fill='%235865F2'/%3E%3Ctext%20x='16'%20y='23'%20font-size='19'%20font-weight='bold'%20text-anchor='middle'%20fill='white'%20font-family='sans-serif'%3EK%3C/text%3E%3C/svg%3E";

// CSS da landing (vitrine pública). Documento próprio, full-width — NÃO usa o
// .card do shell(). Estética dev-tool: tudo monospace, quase acromático, bordas
// de 1px como único divisor, um accent usado com parcimônia. Self-contained
// (CSP: sem fonte/CSS/JS/imagem externa); respeita prefers-reduced-motion.
const LANDING_CSS = `
  :root {
    color-scheme: dark;
    --bg: #101012;
    --bg-weak: #17171a;
    --bg-hover: #1e1e22;
    --bg-strong: #f1eeec;
    --bg-strong-hover: #dfdcda;
    --text: #b6b4b2;
    --text-weak: #78767a;
    --text-strong: #f1eeec;
    --text-inverted: #131316;
    --border: rgba(255,255,255,.13);
    --border-strong: rgba(255,255,255,.22);
    --accent: #5865f2;
    --accent-soft: rgba(88,101,242,.16);
    --ok: #3fbf7a;
    --warn: #e0b34c;
    --mono: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  ::selection { background: var(--accent-soft); color: var(--text-strong); }
  html { -webkit-text-size-adjust: 100%; }
  body { background: var(--bg); color: var(--text); font-family: var(--mono); font-size: 15px;
         line-height: 1.9; -webkit-font-smoothing: antialiased; }
  a { color: var(--text-strong); text-decoration: underline; text-underline-offset: 4px;
      text-decoration-thickness: 1px; text-decoration-color: var(--border-strong); }
  a:hover { text-decoration-color: var(--text-strong); }
  strong { color: var(--text-strong); font-weight: 600; }
  .container { max-width: 1020px; margin: 0 auto; border-left: 1px solid var(--border);
               border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); }
  section { border-top: 1px solid var(--border); padding: 48px 56px; }
  @media (max-width: 1040px) { .container { border-left: 0; border-right: 0; } }
  @media (max-width: 700px) { section { padding: 34px 20px; } body { font-size: 14px; } }

  /* reveal sutil ao rolar — só quando JS está ativo (html.js): sem JS, tudo visível */
  html.js .rv { opacity: 0; transform: translateY(14px); transition: opacity .55s ease, transform .55s ease; }
  html.js .rv.in { opacity: 1; transform: none; }
  @media (prefers-reduced-motion: reduce) { html.js .rv { opacity: 1; transform: none; transition: none; } }

  /* ---------- topo ---------- */
  .top { position: sticky; top: 0; z-index: 10; background: var(--bg);
         border-bottom: 1px solid var(--border); }
  .top-in { max-width: 1020px; margin: 0 auto; display: flex; align-items: center;
            justify-content: space-between; gap: 10px; padding: 0 56px; height: 64px;
            border-left: 1px solid var(--border); border-right: 1px solid var(--border); }
  @media (max-width: 1040px) { .top-in { border-left: 0; border-right: 0; } }
  @media (max-width: 700px) { .top-in { padding: 0 20px; } }
  .brand { display: inline-flex; align-items: baseline; gap: 2px; font-weight: 700;
           color: var(--text-strong); text-decoration: none; font-size: 16px; letter-spacing: .02em; }
  .brand .cur { color: var(--accent); animation: blink 1.2s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .brand .cur { animation: none; } }
  .nav { display: flex; align-items: center; gap: 22px; font-size: 13.5px; }
  .nav a { color: var(--text); text-decoration: none; }
  .nav a:hover { color: var(--text-strong); text-decoration: underline; text-underline-offset: 4px; }
  .nav .lt a { color: var(--text-weak); padding: 0 2px; }
  .nav .lt a.on { color: var(--text-strong); font-weight: 700; }
  .nav .lt span { color: var(--text-weak); opacity: .5; }
  .btnp, .nav a.btnp { display: inline-flex; align-items: center; gap: 10px; background: var(--bg-strong);
          color: var(--text-inverted); text-decoration: none; font-weight: 600; font-size: 13.5px;
          padding: 8px 14px 8px 16px; border-radius: 4px; white-space: nowrap; }
  .btnp:hover, .nav a.btnp:hover { background: var(--bg-strong-hover); color: var(--text-inverted); text-decoration: none; }
  @media (max-width: 700px) {
    .nav .hidesm { display: none; }
    .top-in { height: auto; min-height: 56px; padding: 8px 20px; flex-wrap: wrap; }
    .nav { gap: 14px; }
    .btnp, .nav a.btnp { padding: 6px 10px; font-size: 12.5px; gap: 6px; }
  }

  /* ---------- herói (2 colunas: pitch + terminal) ---------- */
  .hero { position: relative; overflow: hidden; }
  .hero::before { content: ''; position: absolute; inset: -40% -20% auto -20%; height: 90%;
                  background: radial-gradient(ellipse at 30% 0%, rgba(88,101,242,.09), transparent 60%);
                  pointer-events: none; }
  .hgrid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 44px;
           align-items: start; position: relative; }
  @media (max-width: 900px) { .hgrid { grid-template-columns: 1fr; } }
  .hero h1 { color: var(--text-strong); font-size: 34px; line-height: 1.25; font-weight: 700;
             letter-spacing: -.01em; }
  @media (max-width: 700px) { .hero h1 { font-size: 26px; } }
  .hero .sub { margin-top: 16px; }
  .badge { display: inline-flex; align-items: center; gap: 10px; margin-bottom: 22px;
           font-size: 12.5px; color: var(--text-weak); }
  .badge b { background: var(--bg-strong); color: var(--text-inverted); font-weight: 700;
             padding: 2px 8px; font-size: 12px; }
  .badge a { color: var(--text); }
  .installer { margin-top: 26px; border: 1px solid var(--border); border-radius: 6px;
               background: var(--bg-weak); }
  .installer .tab { display: flex; align-items: center; justify-content: space-between;
                    padding: 9px 14px; border-bottom: 1px solid var(--border);
                    color: var(--text-weak); font-size: 12.5px; }
  .installer pre { padding: 13px 14px; overflow-x: auto; font-size: 13px; line-height: 1.8;
                   font-family: var(--mono); }
  .installer .pr { color: var(--text-weak); user-select: none; }
  .installer .hl { color: var(--text-strong); font-weight: 600; }
  .cp { background: none; border: 1px solid var(--border); color: var(--text-weak);
        font-family: var(--mono); font-size: 12px; padding: 3px 10px; border-radius: 4px;
        cursor: pointer; transition: border-color .15s ease, color .15s ease; }
  .cp:hover { color: var(--text-strong); border-color: var(--border-strong); }
  .cp.ok { color: var(--ok); border-color: var(--ok); }
  /* faixa de chips abaixo do herói (preenche e reforça os recibos) */
  .strip { display: flex; flex-wrap: wrap; gap: 8px 22px; margin-top: 34px; font-size: 12.5px;
           color: var(--text-weak); position: relative; }
  .strip span::before { content: '[*] '; color: var(--accent); opacity: .75; }

  /* ---------- terminal (a prova, dentro do herói) ---------- */
  .term { border: 1px solid var(--border); border-radius: 6px; background: var(--bg-weak);
          font-size: 12.5px; line-height: 1.95; overflow: hidden; }
  .term .tbar { display: flex; align-items: center; gap: 6px; padding: 9px 14px;
                border-bottom: 1px solid var(--border); color: var(--text-weak); font-size: 12px; }
  .term .tbar i { width: 9px; height: 9px; border-radius: 50%; background: var(--border-strong); display: inline-block; }
  .term .tbody { padding: 14px 16px; overflow-x: auto; min-height: 330px; }
  .term .ln { white-space: pre-wrap; }
  /* animação de digitação: linhas entram uma a uma (JS); reduced-motion mostra tudo */
  .term.typing .ln { visibility: hidden; }
  .term.typing .ln.on { visibility: visible; }
  .term .p { color: var(--accent); user-select: none; }
  .term .c { color: var(--text-strong); font-weight: 600; }
  .term .ok { color: var(--ok); }
  .term .dim { color: var(--text-weak); }
  .term .ans { color: var(--text-strong); }
  .term .ts { color: var(--accent); text-decoration: none; }
  .term .ts:hover { text-decoration: underline; }
  .term .cursor { display: inline-block; width: 8px; height: 14px; background: var(--text-strong);
                  vertical-align: -2px; animation: blink 1.2s steps(1) infinite; }
  @media (prefers-reduced-motion: reduce) { .term .cursor { animation: none; } }
  .term-cap { padding: 10px 16px; font-size: 12px; color: var(--text-weak);
              border-top: 1px solid var(--border); }

  /* ---------- listas [*] ---------- */
  h3 { color: var(--text-strong); font-size: 16px; font-weight: 700; margin-bottom: 18px; }
  h3::before { content: '## '; color: var(--text-weak); font-weight: 400; }
  .stars { list-style: none; }
  .stars li { padding-left: 34px; position: relative; margin-bottom: 10px; }
  .stars li::before { content: '[*]'; position: absolute; left: 0; color: var(--text-weak); }
  .more { margin-top: 22px; font-size: 13.5px; }

  /* ---------- figuras ---------- */
  .figs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin-top: 30px; }
  @media (max-width: 700px) { .figs { grid-template-columns: 1fr; } }
  .figs figure { border: 1px solid var(--border); padding: 18px; border-radius: 6px; background: var(--bg-weak);
                 transition: border-color .2s ease, transform .2s ease; }
  .figs figure:hover { border-color: rgba(88,101,242,.5); transform: translateY(-2px); }
  @media (prefers-reduced-motion: reduce) { .figs figure, .figs figure:hover { transform: none; transition: none; } }
  .figs svg { width: 100%; height: 96px; display: block; }
  .figs figcaption { margin-top: 12px; font-size: 12.5px; color: var(--text-weak); line-height: 1.6; }
  .figs figcaption b { color: var(--text); font-weight: 600; }

  /* ---------- perguntar ---------- */
  .qa { border: 1px solid var(--border); border-radius: 6px; background: var(--bg-weak);
        padding: 18px 20px; margin-top: 26px; max-width: 720px; font-size: 13.5px; line-height: 2; }
  .qa .q { color: var(--text-strong); }
  .qa .p { color: var(--accent); }

  /* ---------- tabela ---------- */
  table { border-collapse: collapse; width: 100%; margin-top: 24px; font-size: 13.5px; }
  th, td { border: 1px solid var(--border); padding: 10px 14px; text-align: left; }
  th { color: var(--text-strong); font-weight: 600; background: var(--bg-weak); }
  td:first-child { color: var(--text); }
  .yes { color: var(--ok); } .no { color: var(--text-weak); } .half { color: var(--warn); }

  /* ---------- passos ---------- */
  .steps { counter-reset: st; margin-top: 8px; }
  .step { border: 1px solid var(--border); border-radius: 6px; background: var(--bg-weak);
          padding: 18px 20px; margin-top: 18px; max-width: 760px; }
  .step .st-t { color: var(--text-strong); font-weight: 600; margin-bottom: 6px; }
  .step .st-t::before { counter-increment: st; content: counter(st, decimal-leading-zero) '  ';
                        color: var(--text-weak); font-weight: 400; }
  .step pre { margin-top: 10px; overflow-x: auto; font-size: 13px; line-height: 1.8;
              border-top: 1px solid var(--border); padding-top: 12px; }
  .step .pr { color: var(--text-weak); user-select: none; }
  .step p { font-size: 13.5px; line-height: 1.8; }

  /* ---------- rodapé ---------- */
  .cells { display: flex; border-top: 1px solid var(--border); }
  .cells a { flex: 1; text-align: center; padding: 22px 8px; text-decoration: none;
             color: var(--text); font-size: 13.5px; border-left: 1px solid var(--border);
             transition: background .15s ease; }
  .cells a:first-child { border-left: 0; }
  .cells a:hover { background: var(--bg-weak); color: var(--text-strong); }
  .cells .k { color: var(--text-weak); }
  @media (max-width: 700px) { .cells { flex-wrap: wrap; } .cells a { flex: 1 1 50%; border-top: 1px solid var(--border); margin-top: -1px; } }
  .legal { max-width: 1020px; margin: 0 auto; padding: 26px 20px 40px; text-align: center;
           color: var(--text-weak); font-size: 12.5px; }
  .legal a { color: var(--text-weak); }
`;

export function landingPage(lang: Locale): string {
  const pt = lang === 'pt';
  const T = (ptStr: string, enStr: string): string => (pt ? ptStr : enStr);
  const metaTitle = T(
    'Kassinão — Grava as calls do Discord. Depois é só perguntar.',
    'Kassinão — Record your Discord calls. Then just ask.',
  );
  const metaDesc = T(
    'Gravador de voz do Discord, open-source e self-hosted: uma faixa por pessoa, transcrição com nome exato de quem falou, ata por IA e memória que responde — /perguntar no Discord, índice web com busca ou qualquer assistente com MCP.',
    'Open-source, self-hosted Discord voice recorder: one track per speaker, transcripts with exact speaker names, AI minutes, and memory that answers — /ask in Discord, web search, or any MCP-capable AI assistant.',
  );

  const langUrl = `${config.baseUrl}/?lang=${pt ? 'pt' : 'en'}`;
  const repoPublic = config.repoPublic;
  const codeHref = repoPublic ? REPO_URL : NPM_URL;
  const codeLabel = repoPublic ? 'GitHub' : 'npm';

  // ---------- topo ----------
  const topnav = `<header class="top"><div class="top-in">
    <a class="brand" href="/">kassinao<span class="cur">▌</span></a>
    <nav class="nav">
      <a href="/demo">${T('demo', 'demo')}</a>
      <a href="${codeHref}" class="hidesm">${codeLabel.toLowerCase()}</a>
      ${repoPublic ? `<a href="${REPO_URL}/blob/main/CHANGELOG.md" class="hidesm">changelog</a>` : ''}
      <span class="lt"><a href="?lang=en"${pt ? '' : ' class="on"'}>EN</a><span>·</span><a href="?lang=pt"${pt ? ' class="on"' : ''}>PT</a></span>
      <a class="btnp" href="#deploy">${T('rodar o meu', 'deploy')} <span class="ar">↓</span></a>
    </nav>
  </div></header>`;

  // ---------- herói (2 colunas: pitch/instalação + terminal ao vivo) ----------
  const installCmd = repoPublic
    ? `git clone ${REPO_URL}.git && cd kassinao\ncp .env.example .env   ${T('# token do bot + chaves de IA', '# bot token + AI keys')}\ndocker compose up -d`
    : `npx -y kassinao-mcp   ${T('# conector de IA (o bot é self-hosted)', '# AI connector (the bot is self-hosted)')}`;

  const termLines = `
<div class="ln"><span class="p">discord&gt;</span> <span class="c">/${T('gravar', 'record')}</span></div>
<div class="ln"><span class="dim">●</span> ${T('gravando <span class="c">#daily</span> — 1 faixa FLAC por pessoa', 'recording <span class="c">#daily</span> — one FLAC track per person')}</div>
<div class="ln"><span class="dim">  painel: [⏹ ${T('parar', 'stop')}] [📌 ${T('marcar', 'mark')}] [📝 ${T('nota', 'note')}]</span></div>
<div class="ln">&nbsp;</div>
<div class="ln"><span class="p">discord&gt;</span> <span class="c">/${T('parar', 'stop')}</span></div>
<div class="ln"><span class="ok">✓</span> ${T('transcrição — 5 pessoas, nome exato em cada fala', 'transcript — 5 people, exact name on every line')}</div>
<div class="ln"><span class="dim">  ${T('só a fala vai pra API: o VAD corta o silêncio', 'only speech hits the API: VAD trims the silence')}</span></div>
<div class="ln"><span class="ok">✓</span> ${T('ata — resumo · decisões · ações (responsável + prazo)', 'minutes — summary · decisions · actions (owner + due)')}</div>
<div class="ln"><span class="ok">✓</span> ${T('postada no canal + página com player e busca', 'posted to the channel + page with player and search')}</div>
<div class="ln">&nbsp;</div>
<div class="ln"><span class="p">discord&gt;</span> <span class="c">/${T('perguntar', 'ask')}</span> ${T('o que decidimos sobre o rollback?', 'what did we decide about the rollback?')}</div>
<div class="ln"><span class="ans">${T(
    'Rafael assumiu o merge do rollback (com feature flag) até quarta',
    'Rafael owns merging the rollback behind a feature flag by Wednesday',
  )} — <a class="ts" href="/demo">[16:10]</a></span></div>
<div class="ln"><span class="dim">  ${T('só reuniões que VOCÊ pode acessar · cita o segundo exato', 'only meetings YOU can access · cites the exact second')}</span></div>
<div class="ln">&nbsp;</div>
<div class="ln"><span class="p">discord&gt;</span> <span class="cursor"></span></div>`;

  const hero = `<section class="hero">
    <div class="hgrid">
      <div>
        <div class="badge"><b>v1.2.0</b><span>${T(
          '/perguntar · índice web com busca · retenção em camadas',
          '/ask · web index with search · tiered retention',
        )}</span></div>
        <h1>${T('Grava as calls do Discord. Depois é só perguntar.', 'Record your Discord calls. Then just ask.')}</h1>
        <p class="sub">${T(
          'Uma faixa de áudio por pessoa — a transcrição sai com o <strong>nome exato de quem falou</strong>, sem IA chutando quem falou. A ata se escreve sozinha. E as reuniões viram memória que responde: no Discord, na web ou no seu assistente de IA.',
          'One audio track per speaker — transcripts carry the <strong>exact name of who said what</strong>, no diarization guesswork. Minutes write themselves. Your meetings become memory that answers: in Discord, on the web, or in your AI assistant.',
        )}</p>
        <div class="installer">
          <div class="tab"><span>${T('self-hosted · docker', 'self-hosted · docker')}</span>
            <button class="cp" type="button" data-copy="kcmd">${T('copiar', 'copy')}</button></div>
          <pre id="kcmd">${installCmd
            .split('\n')
            .map((l) => `<span class="pr">$ </span>${l.replace(/(#.*)$/, '<span class="pr">$1</span>')}`)
            .join('\n')}</pre>
        </div>
      </div>
      <div class="term" id="kterm">
        <div class="tbar"><i></i><i></i><i></i>&nbsp; kassinao — discord</div>
        <div class="tbody">${termLines}</div>
        <div class="term-cap">${T('sessão de exemplo — veja a página completa na', 'example session — see the full page on the')} <a href="/demo">${T('demo ao vivo →', 'live demo →')}</a></div>
      </div>
    </div>
    <div class="strip">
      <span>${T('open source (AGPL-3.0)', 'open source (AGPL-3.0)')}</span>
      <span>${T('roda no seu servidor', 'runs on your server')}</span>
      <span>${T('custo pelo tempo de fala', 'cost tracks talk time')}</span>
      <span>MCP · Claude · Cursor</span>
      <span>pt-BR / EN</span>
    </div>
  </section>`;

  // ---------- o que é ----------
  const what = `<section class="rv">
    <h3>${T('O que é o Kassinão?', 'What is Kassinão?')}</h3>
    <ul class="stars">
      <li><strong>${T('Multipista de verdade.', 'True multi-track.')}</strong> ${T(
        'Cada pessoa vira um FLAC alinhado — atribuição perfeita de quem falou, exportável pra MP3, mix ou projeto Audacity.',
        'Every speaker becomes an aligned FLAC — perfect attribution, exportable to MP3, a single mix, or an Audacity project.',
      )}</li>
      <li><strong>${T('Transcrição que não alucina.', "Transcripts that don't hallucinate.")}</strong> ${T(
        'VAD corta o silêncio antes da API (AssemblyAI, Groq, OpenAI, Gemini ou 100% local) e o custo acompanha o tempo de fala, não pessoas × horas.',
        'VAD trims silence before the API (AssemblyAI, Groq, OpenAI, Gemini, or 100% local) and cost tracks talk time — not people × hours.',
      )}</li>
      <li><strong>${T('Ata por IA no canal.', 'AI minutes in the channel.')}</strong> ${T(
        'Resumo, decisões e ações (com responsável e prazo) postados no Discord e na página — sem ninguém pedir.',
        'Summary, decisions and action items (owner + due) posted to Discord and the page — nobody has to ask.',
      )}</li>
      <li><strong>${T('Pergunte às suas reuniões.', 'Ask your meetings.')}</strong> ${T(
        '/perguntar no Discord, busca full-text na web e conector MCP pro seu assistente — o áudio expira, o texto fica (retenção em camadas).',
        '/ask in Discord, full-text web search, and an MCP connector for your assistant — audio expires, text stays (tiered retention).',
      )}</li>
      <li><strong>${T('Acesso que tranca de verdade.', 'Access control that actually locks.')}</strong> ${T(
        'Login com Discord: só abre pra quem estava na call (mesmo mutado), enxerga o canal, iniciou ou é admin. Link vazado não abre nada.',
        'Discord login: opens only for people who were in the call (even muted), can see the channel, started it, or are admins. A leaked link opens nothing.',
      )}</li>
    </ul>
    <p class="more"><a href="${repoPublic ? `${REPO_URL}#readme` : NPM_URL}">${T('Leia o README →', 'Read the README →')}</a></p>
  </section>`;

  // ---------- figuras ----------
  const lanes = [22, 46, 70]
    .map(
      (y, i) =>
        `<rect x="4" y="${y - 7}" width="192" height="14" fill="none" stroke="rgba(255,255,255,.14)"/>` +
        [8, 30, 58, 92, 118, 150, 172]
          .filter((_, j) => (j + i) % 3 !== 0)
          .map(
            (x) =>
              `<rect x="${x}" y="${y - 5}" width="${10 + ((x * (i + 2)) % 16)}" height="10" fill="rgba(255,255,255,.34)"/>`,
          )
          .join(''),
    )
    .join('');
  const vad = [4, 22, 34, 58, 76, 96, 110, 128, 152, 170, 184]
    .map((x, i) => {
      const h = [8, 30, 6, 38, 10, 44, 8, 34, 6, 26, 8][i];
      const speech = h > 12;
      return `<rect x="${x}" y="${48 - h / 2}" width="8" height="${h}" fill="${speech ? 'rgba(255,255,255,.42)' : 'rgba(255,255,255,.12)'}"/>${speech ? '' : `<line x1="${x - 1}" y1="58" x2="${x + 9}" y2="58" stroke="rgba(255,255,255,.2)" stroke-dasharray="2 2"/>`}`;
    })
    .join('');
  const marks = [14, 38, 52, 90, 108, 146, 178]
    .map(
      (x, i) =>
        `<rect x="${x}" y="${i % 2 ? 36 : 30}" width="5" height="${i % 2 ? 24 : 36}" fill="rgba(255,255,255,${i % 3 ? '.32' : '.5'})"/>`,
    )
    .join('');
  const figs = `<section class="rv">
    <h3>${T('Como ele acerta o que os outros chutam', 'How it gets right what others guess')}</h3>
    <div class="figs">
      <figure><svg viewBox="0 0 200 96" aria-hidden="true">${lanes}</svg>
        <figcaption><b>Fig 1.</b> ${T(
          'Uma faixa por pessoa, perfeitamente sincronizadas — identificar quem falou não é chute, é arquitetura.',
          "One track per speaker, sample-aligned — diarization isn't guesswork, it's architecture.",
        )}</figcaption></figure>
      <figure><svg viewBox="0 0 200 96" aria-hidden="true">${vad}</svg>
        <figcaption><b>Fig 2.</b> ${T(
          'Só a fala é enviada à API (VAD): sem alucinação de silêncio, sem pagar por hora vazia.',
          'Only speech is sent to the API (VAD): no silence hallucinations, no paying for empty hours.',
        )}</figcaption></figure>
      <figure><svg viewBox="0 0 200 96" aria-hidden="true"><line x1="4" y1="66" x2="196" y2="66" stroke="rgba(255,255,255,.2)"/>${marks}</svg>
        <figcaption><b>Fig 3.</b> ${T(
          'Tudo tem timestamp clicável: ata, busca e respostas pulam pro segundo exato do áudio.',
          'Everything carries a clickable timestamp: minutes, search and answers jump to the exact second.',
        )}</figcaption></figure>
    </div>
  </section>`;

  // ---------- perguntar em 3 lugares ----------
  const ask = `<section class="rv">
    <h3>${T('Pergunte da ferramenta que você já usa', 'Ask from the tools you already use')}</h3>
    <ul class="stars">
      <li><strong>Discord</strong> — <span class="dim">/${T('perguntar', 'ask')}</span> ${T(
        'responde na hora, só pra você, com citações. Zero setup pro time.',
        'answers on the spot, only to you, with citations. Zero setup for the team.',
      )}</li>
      <li><strong>Web</strong> — ${T(
        'índice de tudo que você pode acessar, com busca em transcrições, atas e notas.',
        'an index of everything you can access, with search across transcripts, minutes and notes.',
      )}</li>
      <li><strong>${T('Seu assistente de IA', 'Your AI assistant')}</strong> — ${T(
        'conector MCP (padrão aberto) pra Claude, Cursor e o que vier: ações pendentes entre reuniões, quem disse o quê, busca por período.',
        'MCP connector (open standard) for Claude, Cursor and whatever comes next: pending actions across meetings, who said what, time-window search.',
      )}</li>
    </ul>
    <div class="qa">
      <div><span class="p">claude&gt;</span> <span class="q">${T(
        'o que ficou pendente das reuniões dessa semana?',
        'what is still pending from this week’s meetings?',
      )}</span></div>
      <div>${T(
        '3 itens: load test no staging (<strong>Mei</strong>, qua) · e-mail de lançamento (<strong>Priya</strong>, qui) · rollback do onboarding (<strong>Rafael</strong>, qua)',
        '3 items: staging load test (<strong>Mei</strong>, Wed) · launch email (<strong>Priya</strong>, Thu) · onboarding rollback (<strong>Rafael</strong>, Wed)',
      )} <span class="dim">— product-sync</span> <a class="ts" href="/demo">[5:20]</a></div>
    </div>
  </section>`;

  // ---------- privacidade ----------
  const accessReceipt = repoPublic
    ? `<a href="${REPO_URL}/blob/main/src/web/access.ts">src/web/access.ts →</a>`
    : `<span>src/web/access.ts</span>`;
  const privacy = `<section class="rv">
    <h3>${T('Privacidade não é promessa, é arquitetura', 'Privacy is architecture, not a promise')}</h3>
    <ul class="stars">
      <li>${T(
        '<strong>Roda no SEU servidor.</strong> Áudio e transcrição podem ser 100% locais (faster-whisper); a ata usa um LLM na nuvem (OpenRouter ou Groq) — ou é só desligar.',
        '<strong>Runs on YOUR server.</strong> Audio and transcription can be 100% local (faster-whisper); minutes use a cloud LLM (OpenRouter or Groq) — or you turn them off.',
      )}</li>
      <li>${T(
        '<strong>Consentimento visível:</strong> apelido [GRAVANDO] + painel no canal enquanto grava.',
        '<strong>Visible consent:</strong> a [RECORDING] nickname + a panel in the channel while recording.',
      )}</li>
      <li>${T(
        `<strong>Cada acesso é re-checado no Discord</strong> a cada visita — a regra inteira cabe num arquivo: ${accessReceipt}`,
        `<strong>Every access is re-checked against Discord</strong> on every visit — the whole rule fits in one file: ${accessReceipt}`,
      )}</li>
      <li>${T(
        '<strong>Retenção em camadas:</strong> o áudio (pesado, sensível) expira em dias; transcrição e ata vivem o quanto você configurar.',
        '<strong>Tiered retention:</strong> audio (heavy, sensitive) expires in days; transcript and minutes live as long as you configure.',
      )}</li>
      <li>${T(
        '<strong>Open source sob AGPL-3.0</strong> — quem hospedar uma versão modificada é obrigado a abrir o código também.',
        '<strong>Open source under AGPL-3.0</strong> — anyone hosting a modified version must open their code too.',
      )}</li>
    </ul>
  </section>`;

  // ---------- comparação ----------
  const compare = `<section class="rv">
    <h3>${T('Craig grava. Otter resume. O Kassinão lembra.', 'Craig records. Otter summarizes. Kassinão remembers.')}</h3>
    <table>
      <tr><th></th><th>Kassinão</th><th>Craig</th><th>Otter/Fireflies</th></tr>
      <tr><td>${T('Multipista (1 faixa/pessoa)', 'Multi-track (1 file/speaker)')}</td><td class="yes">✓</td><td class="yes">✓</td><td class="no">—</td></tr>
      <tr><td>${T('Identifica quem falou', 'Speaker attribution')}</td><td class="yes">${T('exato', 'exact')}</td><td class="yes">${T('exato', 'exact')}</td><td class="half">${T('chute (IA)', 'guessed (AI)')}</td></tr>
      <tr><td>${T('Ata por IA (decisões + ações)', 'AI minutes (decisions + actions)')}</td><td class="yes">✓</td><td class="no">—</td><td class="yes">✓</td></tr>
      <tr><td>${T('Perguntar às reuniões (Discord/web/MCP)', 'Ask your meetings (Discord/web/MCP)')}</td><td class="yes">✓</td><td class="no">—</td><td class="half">${T('só no app deles', 'their app only')}</td></tr>
      <tr><td>${T('Seus dados, seu servidor', 'Your data, your server')}</td><td class="yes">✓</td><td class="half">${T('parcial', 'partial')}</td><td class="no">—</td></tr>
      <tr><td>${T('Preço', 'Price')}</td><td class="yes">${T('grátis (AGPL)', 'free (AGPL)')}</td><td>freemium</td><td>${T('pago', 'paid')}</td></tr>
    </table>
  </section>`;

  // ---------- deploy ----------
  const deploy = `<section id="deploy" class="rv">
    <h3>${T('Rode o seu em 3 passos', 'Deploy yours in 3 steps')}</h3>
    <div class="steps">
      <div class="step"><div class="st-t">${T('Crie o app no Discord', 'Create the Discord app')}</div>
        <p>${T(
          'Developer Portal → New Application → Bot. Copie token, application id e client secret. (~1 minuto)',
          'Developer Portal → New Application → Bot. Copy the token, application id and client secret. (~1 minute)',
        )}</p></div>
      <div class="step"><div class="st-t">${T('Suba com Docker', 'Bring it up with Docker')}</div>
        <pre><span class="pr">$ </span>git clone ${repoPublic ? `${REPO_URL}.git` : 'https://github.com/resolvicomai/kassinao.git'} && cd kassinao
<span class="pr">$ </span>cp .env.example .env && $EDITOR .env
<span class="pr">$ </span>docker compose up -d</pre>
        <p>${T(
          'HTTPS sem abrir porta: Cloudflare Tunnel (TUNNEL_TOKEN + COMPOSE_PROFILES=tunnel). Ou 1-clique no Render.',
          'HTTPS without opening ports: Cloudflare Tunnel (TUNNEL_TOKEN + COMPOSE_PROFILES=tunnel). Or 1-click on Render.',
        )}</p></div>
      <div class="step"><div class="st-t">${T('Ligue a IA (opcional)', 'Turn on the AI (optional)')}</div>
        <pre><span class="pr"># </span>TRANSCRIBE_PROVIDER=assemblyai   <span class="pr">${T('# ou groq (free tier) / local', '# or groq (free tier) / local')}</span>
<span class="pr"># </span>OPENROUTER_API_KEY=sk-or-...     <span class="pr">${T('# ata + /perguntar (~centavos/reunião)', '# minutes + /ask (~cents/meeting)')}</span></pre>
        <p>${T(
          'Depois /gravar num canal de voz — o resto acontece sozinho.',
          'Then /record in a voice channel — everything else just happens.',
        )}</p></div>
    </div>
  </section>`;

  // ---------- rodapé ----------
  const footer = `<div class="cells">
    <a href="${codeHref}">${codeLabel} <span class="k">[AGPL]</span></a>
    <a href="${NPM_URL}">npm <span class="k">[kassinao-mcp]</span></a>
    <a href="/demo">${T('demo ao vivo', 'live demo')}</a>
    <a href="/gravacoes">${T('minhas gravações', 'my recordings')}</a>
    <a href="/conectar-ia">${T('conectar IA', 'connect AI')}</a>
  </div>`;

  const copyScript = `<script>(function(){
    document.documentElement.classList.add('js'); // habilita as animações só com JS vivo
    document.querySelectorAll('.cp[data-copy]').forEach(function(b){
      b.addEventListener('click', function(){
        var el = document.getElementById(b.dataset.copy);
        if (!el) return;
        navigator.clipboard.writeText(el.textContent.replace(/^\\$ /gm, '')).then(function(){
          var o = b.textContent; b.textContent = '${T('copiado ✓', 'copied ✓')}'; b.classList.add('ok');
          setTimeout(function(){ b.textContent = o; b.classList.remove('ok'); }, 2000);
        });
      });
    });
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // terminal "digitando": as linhas entram uma a uma (uma vez, ao carregar)
    var term = document.getElementById('kterm');
    if (term && !reduce) {
      term.classList.add('typing');
      var lns = term.querySelectorAll('.ln');
      var i = 0;
      (function next(){
        if (i >= lns.length) { term.classList.remove('typing'); return; }
        lns[i].classList.add('on');
        var txt = lns[i].textContent || '';
        i++;
        setTimeout(next, txt.trim() ? Math.min(90 + txt.length * 6, 520) : 140);
      })();
    }
    // reveal ao rolar
    var rvs = document.querySelectorAll('.rv');
    if ('IntersectionObserver' in window && !reduce) {
      var io = new IntersectionObserver(function(es){
        es.forEach(function(e){ if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
      }, { rootMargin: '0px 0px -8% 0px' });
      rvs.forEach(function(el){ io.observe(el); });
    } else {
      rvs.forEach(function(el){ el.classList.add('in'); });
    }
  })();</script>`;

  return `<!doctype html>
<html lang="${pt ? 'pt-BR' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#101012">
<link rel="icon" href="${FAVICON}">
<title>${esc(metaTitle)}</title>
<meta name="description" content="${esc(metaDesc)}">
<link rel="canonical" href="${esc(langUrl)}">
<link rel="alternate" hreflang="en" href="${esc(config.baseUrl)}/?lang=en">
<link rel="alternate" hreflang="pt-BR" href="${esc(config.baseUrl)}/?lang=pt">
<link rel="alternate" hreflang="x-default" href="${esc(config.baseUrl)}/">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(metaTitle)}">
<meta property="og:description" content="${esc(metaDesc)}">
<meta property="og:url" content="${esc(langUrl)}">
<meta property="og:image" content="${esc(config.baseUrl)}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(metaTitle)}">
<meta name="twitter:description" content="${esc(metaDesc)}">
<meta name="twitter:image" content="${esc(config.baseUrl)}/og.png">
<style>${LANDING_CSS}</style>
</head>
<body>
${topnav}
<div class="container">
${hero}
${what}
${figs}
${ask}
${privacy}
${compare}
${deploy}
${footer}
</div>
<div class="legal">© 2026 resolvicomai · AGPL-3.0-or-later · <a href="/demo">demo</a> · <a href="${codeHref}">${codeLabel}</a></div>
${copyScript}
</body>
</html>`;
}

/**
 * Página "Conectar assistente de IA" (/conectar-ia): o usuário loga com Discord,
 * gera um token pessoal e cola no Claude Desktop/Cursor. O token só enxerga o que
 * a pessoa já veria no site. Sempre noindex (é conteúdo por-usuário, com segredo).
 */
export function connectPage(opts: {
  lang: Locale;
  user?: WebUser;
  refreshToken?: string;
  sessionCount?: number;
  revoked?: boolean;
}): string {
  const pt = opts.lang === 'pt';
  const T = (a: string, b: string): string => (pt ? a : b);
  const title = T('Conectar assistente de IA', 'Connect your AI assistant');

  if (!opts.user) {
    const body = `<h1>🔌 ${esc(title)}</h1>
      <p class="muted" style="margin-top:12px">${esc(
        T(
          'Conecte suas reuniões do Kassinão ao seu assistente de IA (Claude Desktop, Cursor…). Entre com o Discord — você só verá as gravações que já pode ver no site.',
          'Connect your Kassinão meetings to your AI assistant (Claude Desktop, Cursor…). Sign in with Discord — you will only see recordings you can already see on the site.',
        ),
      )}</p>
      <div class="downloads" style="margin-top:18px">
        <a class="btn" href="/auth/login?next=%2Fconectar-ia">${esc(T('Entrar com Discord', 'Sign in with Discord'))}</a>
      </div>`;
    return shell(title, body, { lang: opts.lang, noindex: true });
  }

  if (opts.refreshToken) {
    const cfg = JSON.stringify(
      {
        mcpServers: {
          kassinao: {
            command: 'npx',
            args: ['-y', 'kassinao-mcp'],
            env: { KASSINAO_URL: config.baseUrl, KASSINAO_REFRESH_TOKEN: opts.refreshToken },
          },
        },
      },
      null,
      2,
    );
    const localhostWarn = config.baseUrl.startsWith('http://localhost')
      ? `<p style="color:#f0553a;margin-top:12px">🚫 ${esc(
          T(
            'Este servidor está com BASE_URL de localhost — o token gerado NÃO vai funcionar de outra máquina. Defina BASE_URL (a URL pública do bot) no servidor antes de gerar tokens de verdade.',
            'This server has a localhost BASE_URL — the generated token will NOT work from another machine. Set BASE_URL (the bot public URL) on the server before generating real tokens.',
          ),
        )}</p>`
      : '';
    const body = `<h1>✅ ${esc(T('Token gerado', 'Token generated'))}</h1>
      ${localhostWarn}
      <p style="color:#ffb454;margin-top:12px">⚠️ ${esc(
        T(
          'Copie agora — este token NÃO será mostrado de novo. Ele dá ao SEU assistente de IA acesso às gravações que VOCÊ pode ver.',
          'Copy it now — this token will NOT be shown again. It gives YOUR AI assistant access to the recordings YOU can see.',
        ),
      )}</p>
      <p class="muted" style="margin-top:12px">${esc(
        T(
          '1) Copie o bloco abaixo. 2) Cole no arquivo de config do seu app. 3) Reinicie o app e pergunte.',
          '1) Copy the block below. 2) Paste it into your app config file. 3) Restart the app and ask.',
        ),
      )}</p>
      <p class="muted" style="margin-top:10px">${esc(T('Onde fica esse arquivo:', 'Where that config file lives:'))}</p>
      <ul class="muted" style="margin:6px 0 0 18px;font-size:13.5px;line-height:1.8">
        <li>Claude Desktop · macOS: <span style="font-family:ui-monospace,monospace">~/Library/Application Support/Claude/claude_desktop_config.json</span></li>
        <li>Claude Desktop · Windows: <span style="font-family:ui-monospace,monospace">%APPDATA%\\Claude\\claude_desktop_config.json</span></li>
        <li>Cursor: <span style="font-family:ui-monospace,monospace">~/.cursor/mcp.json</span></li>
      </ul>
      <div style="margin-top:14px"><button id="kcopy" class="btn" type="button" style="border:0;cursor:pointer;font:inherit">📋 ${esc(T('Copiar config', 'Copy config'))}</button></div>
      <pre id="kcfg" style="background:#111;padding:14px;border-radius:8px;overflow-x:auto;white-space:pre;font-size:13px;margin-top:10px">${esc(cfg)}</pre>
      <p class="muted" style="margin-top:8px">${esc(
        T(
          'Já usa outros MCP servers? Cole só o bloco "kassinao" dentro do seu "mcpServers" — não substitua o arquivo inteiro. Requer o conector instalado (Node 20+): "npx -y kassinao-mcp", ou do código-fonte (veja o repo).',
          'Already have other MCP servers? Paste only the "kassinao" block inside your existing "mcpServers" — do not replace the whole file. Requires the connector (Node 20+): "npx -y kassinao-mcp", or from source (see the repo).',
        ),
      )}</p>
      <p class="muted" style="margin-top:12px">${esc(
        T(
          'Depois reinicie o Claude Desktop/Cursor e pergunte: "o que ficou pendente essa semana?"',
          'Then restart Claude Desktop/Cursor and ask: "what is pending this week?"',
        ),
      )}</p>
      <div class="downloads" style="margin-top:18px"><a class="btn" href="/conectar-ia">${esc(T('Voltar', 'Back'))}</a></div>
      <script>(function(){var b=document.getElementById('kcopy');if(!b)return;b.addEventListener('click',function(){var t=(document.getElementById('kcfg').textContent)||'';navigator.clipboard.writeText(t).then(function(){var o=b.textContent;b.textContent='${esc(T('Copiado ✓', 'Copied ✓'))}';setTimeout(function(){b.textContent=o;},2000);});});})();</script>`;
    return shell(title, body, { lang: opts.lang, user: opts.user, noindex: true });
  }

  const count = opts.sessionCount ?? 0;
  const revokedMsg = opts.revoked
    ? `<p style="color:#8f8;margin-top:12px">✅ ${esc(T('Todos os seus conectores foram revogados.', 'All your connectors were revoked.'))}</p>`
    : '';
  const btnStyle = 'border:0;cursor:pointer;font:inherit';
  const body = `<h1>🔌 ${esc(title)}</h1>
    ${revokedMsg}
    <p class="muted" style="margin-top:12px">${esc(
      T(
        'Ligue o Kassinão em qualquer assistente de IA (Claude, Cursor e outros) para perguntar sobre as suas calls em linguagem natural.',
        'Plug Kassinão into any AI assistant (Claude, Cursor, and more) to ask about your calls in natural language.',
      ),
    )}</p>
    <ol class="muted" style="margin:12px 0 0 18px;line-height:1.9">
      <li>${esc(T('Clique em Gerar conexão — sai uma configuração pronta.', 'Click Generate connection — you get a ready-to-paste config.'))}</li>
      <li>${esc(T('Cole no arquivo de config do seu app (a gente diz onde).', 'Paste it into your app config file (we tell you where).'))}</li>
      <li>${esc(T('Reinicie o app e pergunte: "o que ficou pra essa semana?"', 'Restart the app and ask: "what\'s due this week?"'))}</li>
    </ol>
    <p class="muted" style="margin-top:12px">🔒 ${esc(
      T(
        'A conexão só enxerga as gravações que VOCÊ já pode ver — e você revoga quando quiser.',
        'The connection only sees recordings YOU can already see — and you can revoke it anytime.',
      ),
    )} ${esc(T('Conexões ativas', 'Active connections'))}: ${count}</p>
    <div class="downloads" style="margin-top:18px">
      <form method="post" action="/conectar-ia/gerar" style="display:inline"><button class="btn" type="submit" style="${btnStyle}">🔌 ${esc(T('Gerar conexão', 'Generate connection'))}</button></form>
      ${
        count > 0
          ? `<form method="post" action="/conectar-ia/revogar" style="display:inline"><button class="btn" type="submit" style="${btnStyle};background:#5a2a2a">${esc(T('Revogar todas', 'Revoke all'))}</button></form>`
          : ''
      }
    </div>`;
  return shell(title, body, { lang: opts.lang, user: opts.user, noindex: true });
}
