import { config } from '../config';
import { Locale } from '../i18n';
import { msToClock } from '../processing/transcribe';
import { formatDuration, formatOffset } from '../recorder/RecordingSession';
import { audioExpiryOf, MeetingMinutes, RecordingMeta, textExpiryOf, TranscriptSegment } from '../store';
import { shortError } from '../util';
import type { WebUser } from './auth';
import type { SessionSummary } from './mcpTokens';
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
  searchTranscript: { pt: 'Ache o momento exato…', en: 'Find the exact moment…' },
  copyActions: { pt: 'Copiar itens de ação', en: 'Copy action items' },
  timelineAll: { pt: 'Todos os eventos ({n})', en: 'All events ({n})' },
  tlTopics: { pt: 'tópicos da ata', en: 'minutes topics' },
  tlNotes: { pt: 'notas', en: 'notes' },
  tlJoined: { pt: 'entrou', en: 'joined' },
  tlLeft: { pt: 'saiu', en: 'left' },
  tlHint: { pt: 'clique pra pular no áudio', en: 'click to jump in the audio' },
  audioExpired: {
    pt: '🔇 O áudio desta gravação foi liberado (expirou ou alguém liberou o espaço). A transcrição, a ata e as notas continuam aqui.',
    en: '🔇 The audio of this recording was released (it expired or someone freed the space). Transcript, minutes and notes remain here.',
  },
  textExpires: {
    pt: '⏳ Transcrição e ata expiram em {date}. O áudio já expirou.',
    en: '⏳ Transcript and minutes expire on {date}. The audio has already expired.',
  },
  keptForever: { pt: '♾️ Guardada até alguém apagar', en: '♾️ Kept until someone deletes it' },
  textKeptForever: {
    pt: '♾️ Transcrição, ata e notas ficam até alguém apagar (o áudio já foi liberado)',
    en: '♾️ Transcript, minutes and notes stay until someone deletes them (audio already released)',
  },
  // índice /gravacoes v2 (gestão)
  ixOpen: { pt: 'abrir', en: 'open' },
  ixSort: { pt: 'ordenar:', en: 'sort:' },
  ixSortRecent: { pt: 'recentes', en: 'recent' },
  ixSortOldest: { pt: 'antigas', en: 'oldest' },
  ixSortLargest: { pt: 'maiores', en: 'largest' },
  ixAudioOnDisk: { pt: 'de áudio no disco', en: 'of audio on disk' },
  ixFree: { pt: 'livres no servidor', en: 'free on the server' },
  ixRecordings: { pt: 'gravações', en: 'recordings' },
  ixRecording1: { pt: 'gravação', en: 'recording' },
  ixNotes: { pt: 'notas', en: 'notes' },
  ixFreeSpace: { pt: '🔇 Liberar espaço', en: '🔇 Free up space' },
  ixFreeSpaceConfirm: {
    pt: 'Apagar SÓ o áudio desta gravação (faixas e mix)? Transcrição, ata e notas ficam. Não tem volta.',
    en: 'Delete ONLY the audio of this recording (tracks and mix)? Transcript, minutes and notes stay. No undo.',
  },
  ixDelete: { pt: '🗑️ Apagar tudo', en: '🗑️ Delete all' },
  ixAudioFreed: { pt: '🔇 áudio liberado', en: '🔇 audio released' },
  ixByAuto: { pt: 'auto-record', en: 'auto-record' },
  ixLive: { pt: 'ao vivo', en: 'live' },
  // app shell v2 (cockpit)
  dlFold: { pt: 'Baixar áudio', en: 'Download audio' },
  dlShort: { pt: 'Baixar', en: 'Download' },
  freeWhy: {
    pt: 'apaga só o áudio — transcrição, ata e notas ficam',
    en: 'deletes only the audio — transcript, minutes and notes stay',
  },
  delWhy: {
    pt: 'apaga tudo: áudio, transcrição, ata e notas — sem volta',
    en: 'deletes everything: audio, transcript, minutes and notes — no undo',
  },
  manage: { pt: 'Gerenciar', en: 'Manage' },
};

function p(l: Locale, key: string, vars: Record<string, string> = {}): string {
  let text = P[key]?.[l] ?? key;
  for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, () => value);
  return text;
}

// CSS do app logado (cockpit). Mesma família de marca da landing (tokens de cor
// idênticos), mas OUTRA sala: corpo em sans, coluna de trabalho de 760px, chrome
// persistente de navegação e densidade utilitária. Monoespaçado é rebaixado a
// timestamps, IDs, código, caminhos e JSON — nunca em prosa. Self-contained
// (CSP: sem fonte/CSS/JS/imagem externa); respeita prefers-reduced-motion.
const APP_CSS = `
  :root { color-scheme: dark;
    --bg:#101012; --bg-weak:#17171a; --bg-hover:#1e1e22;
    --text:#b6b4b2; --text-weak:#8a888c; --text-dim:#6d7178; --text-strong:#f1eeec;
    --border:rgba(255,255,255,.13); --border-strong:rgba(255,255,255,.22);
    --accent:#5865f2; --accent-hover:#4752c4; --accent-soft:rgba(88,101,242,.16);
    --warn:#f0b232; --danger:#da373c; --live:#da373c; --done:#23a55a; --ok:#3dbf7a; --link:#00a8fc;
    --c0:#7b90f7; --c1:#3dbf7a; --c2:#f0b232; --c3:#eb6ab5;
    --c4:#29b0e8; --c5:#e8735a; --c6:#a58cf2; --c7:#4fd1c5;
    --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
    --mono:ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace;
    --col:760px;
  }
  /* tema claro: mesmos papéis, outra luz (o data-theme é aplicado no <html>
     por um script no <head>, antes da pintura — sem flash) */
  html[data-theme='light'] { color-scheme: light; }
  html[data-theme='light'] body {
    --bg: #f6f5f3; --bg-weak: #ffffff; --bg-hover: #ececea;
    --text: #55534f; --text-weak: #85837f; --text-dim: #9a9894; --text-strong: #17161a;
    --border: rgba(0,0,0,.12); --border-strong: rgba(0,0,0,.24);
    --accent-soft: rgba(88,101,242,.12); --link: #2456c4;
    --c0: #5568d8; --c1: #22945c; --c2: #a97f0a; --c3: #cc4694;
    --c4: #1585ba; --c5: #c4523c; --c6: #7e60d8; --c7: #1d9c92;
  }
  html[data-theme='light'] .btn.secondary { background: #e9e7e4; color: #2c2b29; }
  html[data-theme='light'] .btn.secondary:hover { background: #dedcd8; }
  html[data-theme='light'] .copybtn { background: #e9e7e4; color: #444; }
  html[data-theme='light'] .rcard .rlink, html[data-theme='light'] .topbar .user,
  html[data-theme='light'] .tl-chlist a, html[data-theme='light'] .langtoggle a:hover { color: #3f3e3c; }
  html[data-theme='light'] .tsearch input, html[data-theme='light'] .isearch input { color: #26251f; }
  html[data-theme='light'] .tl-seg span { color: #3a48a0; }
  html[data-theme='light'] .person, html[data-theme='light'] .transcript, html[data-theme='light'] .minutes,
  html[data-theme='light'] .note, html[data-theme='light'] details.tech code { border-color: rgba(0,0,0,.12); }
  * { box-sizing: border-box; margin: 0; }
  body.wide .card, body.wide .topbar, body.wide .topfoot { max-width: 960px; }
  body { background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 15px; line-height: 1.55;
         min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 26px 16px 40px; }
  .card { background: var(--bg-weak); border: 1px solid var(--border); border-radius: 10px;
          padding: 28px; max-width: var(--col); width: 100%; }
  h1 { font-size: 22px; color: var(--text-strong); display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
       letter-spacing: -.01em; }
  h2 { font-size: 12.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-weak);
       margin: 26px 0 10px; font-weight: 600; }
  .muted { color: var(--text-weak); font-size: 14px; }
  /* mono SÓ onde é dado técnico: horários, IDs, código, caminhos, JSON */
  time, .ts, code, pre { font-family: var(--mono); }
  pre { overflow-x: auto; }
  a:focus-visible, button:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  input:focus-visible { outline: none; }
  /* âncoras do jump-nav param abaixo da pilha sticky (nav + player) */
  h2[id], details[id] { scroll-margin-top: 150px; }
  .grid { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin-top: 14px; font-size: 15px; }
  .grid dt { color: var(--text-weak); }
  .badge { font-size: 12px; font-weight: 700; padding: 3px 10px; border-radius: 999px; vertical-align: middle;
           font-family: var(--sans); }
  .badge.live { background: var(--live); color: #fff; }
  .badge.done { background: var(--done); color: #fff; }
  @keyframes pulse { 50% { opacity: .55; } }
  @media (prefers-reduced-motion: no-preference) {
    .badge.live { animation: pulse 1.6s infinite; }
    html { scroll-behavior: smooth; }
  }
  /* bloco fixo da gravação: player + ABAS — a página mostra UMA seção por vez
     (sem JS os painéis ficam todos visíveis, empilhados como antes) */
  .stick { position: sticky; top: 0; z-index: 7; background: var(--bg-weak); margin: 4px 0 18px; }
  .tabbar { display: flex; gap: 2px; overflow-x: auto; padding-top: 6px; scrollbar-width: none;
            border-bottom: 1px solid var(--border); }
  .tabbar::-webkit-scrollbar { display: none; }
  .tabbar button { font: inherit; font-size: 13px; padding: 9px 14px; background: none; border: 0;
                   border-bottom: 2px solid transparent; margin-bottom: -1px; color: var(--text-weak);
                   cursor: pointer; white-space: nowrap; }
  .tabbar button:hover { color: var(--text-strong); }
  .tabbar button[aria-selected='true'] { color: var(--text-strong); border-bottom-color: var(--accent); font-weight: 600; }
  .tpanel[hidden] { display: none; }
  .tpanel > h2:first-child { margin-top: 6px; }
  /* com abas ativas o título da seção repete o rótulo da aba — some */
  .ktabs .tpanel > h2:first-child { display: none; }
  .ktabs .tpanel { padding-top: 4px; }
  .people { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .person { display: flex; align-items: center; gap: 8px; background: var(--bg); border: 1px solid rgba(255,255,255,.1);
            padding: 6px 12px 6px 6px; border-radius: 999px; font-size: 14px; }
  .person img { width: 26px; height: 26px; border-radius: 50%; }
  .downloads { display: flex; flex-wrap: wrap; gap: 10px; }
  /* .btn cobre <a> E <button> */
  .btn { display: inline-flex; flex-direction: column; gap: 2px; text-decoration: none; background: var(--accent);
         color: #fff; padding: 12px 18px; border-radius: 8px; font-size: 15px; font-weight: 600;
         border: 0; cursor: pointer; font-family: inherit; line-height: 1.2; }
  .btn small { font-weight: 400; font-size: 12px; opacity: .8; }
  .btn:hover { background: var(--accent-hover); }
  .btn.secondary { background: #232327; }
  .btn.secondary:hover { background: #2a2a2f; }
  /* exportar rebaixado: dobrado num details, fora do caminho da leitura */
  details.dlfold { margin-top: 26px; }
  details.dlfold summary { cursor: pointer; font-size: 12.5px; color: var(--text-weak); text-transform: uppercase;
                           letter-spacing: .05em; font-weight: 600; }
  details.dlfold summary small { text-transform: none; letter-spacing: 0; font-weight: 400; color: var(--text-dim); margin-left: 8px; }
  details.dlfold[open] summary { margin-bottom: 12px; }
  .events { list-style: none; font-size: 14px; display: flex; flex-direction: column; gap: 4px;
            max-height: 220px; overflow-y: auto; }
  .events time { color: var(--text-weak); margin-right: 8px; }
  .wall { color: var(--text-dim) !important; font-size: 12px; }
  .transcript { display: flex; flex-direction: column; gap: 14px;
                background: var(--bg); border: 1px solid rgba(255,255,255,.1); border-radius: 8px; padding: 14px;
                font-size: 14.5px; }
  .transcript p { line-height: 1.55; padding: 2px 6px; border-left: 2px solid transparent; border-radius: 4px; }
  .transcript p.now { background: var(--accent-soft); border-left-color: var(--accent); }
  .transcript .who { color: var(--text-strong); font-weight: 600; }
  .transcript time { color: var(--text-weak); font-size: 12px; margin-right: 6px; }
  .tblock .thead { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
  .tblock .thead img { width: 22px; height: 22px; border-radius: 50%; }
  .tblock .thead .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; background: currentColor; }
  /* paleta estável por falante — a MESMA da landing (uma marca só) */
  .c0 { color: var(--c0); } .c1 { color: var(--c1); } .c2 { color: var(--c2); } .c3 { color: var(--c3); }
  .c4 { color: var(--c4); } .c5 { color: var(--c5); } .c6 { color: var(--c6); } .c7 { color: var(--c7); }
  .tblock .thead .dot.c0 { background:var(--c0) } .tblock .thead .dot.c1 { background:var(--c1) }
  .tblock .thead .dot.c2 { background:var(--c2) } .tblock .thead .dot.c3 { background:var(--c3) }
  .tblock .thead .dot.c4 { background:var(--c4) } .tblock .thead .dot.c5 { background:var(--c5) }
  .tblock .thead .dot.c6 { background:var(--c6) } .tblock .thead .dot.c7 { background:var(--c7) }
  .tsearch { display: flex; flex-direction: column; gap: 8px; margin: 8px 0 10px; }
  .tsearch input { background: var(--bg); border: 1px solid var(--border); color: #c9c7c5; border-radius: 8px;
                   padding: 9px 12px; font-size: 14px; width: 100%; font-family: inherit; }
  .tsearch input:focus { outline: none; border-color: var(--accent); }
  .fchips { display: flex; flex-wrap: wrap; gap: 6px; }
  .fchip { background: var(--bg-weak); border: 1px solid var(--border); border-radius: 999px; padding: 3px 10px;
           font-size: 12.5px; cursor: pointer; font-family: inherit; }
  .fchip.off { opacity: .35; text-decoration: line-through; }
  .copybtn { background: #232327; border: 0; border-radius: 6px; color: #c9c7c5; cursor: pointer;
             font-size: 12px; padding: 3px 8px; vertical-align: middle; margin-left: 6px; font-family: inherit; }
  .copybtn:hover { background: #2a2a2f; }
  .subline { color: var(--text-weak); font-size: 14px; margin-top: 6px; }
  .playerwrap { background: var(--bg-weak); padding: 12px 0 6px; }
  .playerwrap audio { width: 100%; }
  .pctl { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 6px;
          font-size: 12.5px; color: var(--text-weak); }
  .speed { display: inline-flex; gap: 4px; }
  .speed button { background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 6px;
                  padding: 2px 9px; font-size: 12px; cursor: pointer; font-family: var(--mono); }
  .speed button.on { background: var(--accent); color: #fff; border-color: var(--accent); }
  .follow { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
  /* linha do tempo: capítulos (blocos) + ticks (notas/entra-sai) + eixo + legenda */
  .tl2 { margin: 6px 0 10px; }
  .tl-ch { position: relative; height: 26px; }
  .tl-seg { position: absolute; top: 0; height: 22px; border-radius: 4px; overflow: hidden;
            text-decoration: none; display: flex; align-items: center; padding: 0 6px; }
  .tl-seg.s0 { background: rgba(88,101,242,.28); }
  .tl-seg.s1 { background: rgba(88,101,242,.16); }
  .tl-seg:hover { background: rgba(88,101,242,.45); }
  .tl-seg span { font-size: 10px; color: #c9cdfb; font-family: var(--mono);
                 width: 100%; text-align: center; overflow: hidden; }
  .tl-chlist { list-style: none; margin-top: 12px; display: grid;
               grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 4px 22px; }
  .tl-chlist a { display: flex; align-items: baseline; gap: 8px; text-decoration: none;
                 color: #c9c7c5; font-size: 13.5px; line-height: 1.5; padding: 2px 4px; border-radius: 4px; }
  .tl-chlist a:hover { background: var(--accent-soft); color: var(--text-strong); }
  .tl-chlist b { color: var(--c0); font-weight: 600; font-size: 11px; font-family: var(--mono); }
  .tl-chlist time { color: var(--text-weak); font-size: 11.5px; flex-shrink: 0; }
  .tl-chlist span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tl-ticks { position: relative; height: 14px; margin-top: 3px; }
  .tl-tk { position: absolute; top: 1px; width: 4px; height: 12px; border-radius: 2px;
           transform: translateX(-50%); }
  .tl-tk.tnote { background: var(--warn); width: 5px; }
  .tl-tk.join { background: var(--ok); opacity: .75; }
  .tl-tk.leave { background: var(--text-dim); opacity: .75; }
  .tl-tk:hover { transform: translateX(-50%) scaleY(1.3); }
  .tl-ax { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-dim);
           font-family: var(--mono); border-top: 1px solid var(--border);
           padding-top: 4px; margin-top: 4px; }
  .tl-lg { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 11.5px; color: var(--text-weak);
           margin-top: 6px; align-items: center; }
  .tl-lg i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px;
             vertical-align: -1px; }
  .tl-lg .lg-ch { background: rgba(88,101,242,.55); }
  .tl-lg .lg-note { background: var(--warn); }
  .tl-lg .lg-join { background: var(--ok); }
  .tl-lg .lg-leave { background: var(--text-dim); }
  .tl-lg .lg-hint { margin-left: auto; color: var(--text-dim); }
  .evlist summary { cursor: pointer; font-size: 13px; color: var(--text-weak); margin: 6px 0; }
  .minutes .lead { font-size: 16px; line-height: 1.6; color: var(--text-strong); }
  /* índice de gravações: buscar primeiro, varrer depois */
  .isearch { position: sticky; top: 0; z-index: 7; display: flex; gap: 8px;
             background: var(--bg-weak); padding: 12px 0 10px; margin: 10px 0 4px; }
  .isearch input { flex: 1; background: var(--bg); border: 1px solid var(--border); color: #c9c7c5;
                   border-radius: 8px; padding: 10px 12px; font-size: 14px; font-family: inherit; min-width: 0; }
  .isearch input:focus { outline: none; border-color: var(--accent); }
  .isearch .btn { flex-direction: row; align-items: center; padding: 10px 16px; }
  .dayh { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-dim);
          margin: 16px 0 2px; }
  .rlist { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
  /* card compacto: 1 linha de essencial, ações discretas à direita (fora do link) */
  .rcard { background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
           display: flex; align-items: center; }
  .rcard:hover { border-color: var(--accent); }
  .rcard .rlink { display: block; padding: 11px 14px; text-decoration: none; color: #c9c7c5;
                  flex: 1; min-width: 0; }
  .rcard .rrow1 { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
  .rcard .rrow1 strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rcard .rrow2 { color: var(--text-weak); font-size: 12.5px; margin-top: 3px;
                  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rstats { margin-top: 14px; font-size: 13.5px; color: var(--text-weak); }
  .rstats strong { color: var(--text-strong); }
  .rsorts { margin-top: 6px; font-size: 12.5px; color: var(--text-dim); }
  .rsorts a { color: var(--link); text-decoration: none; }
  .rsorts a:hover { text-decoration: underline; }
  .rsorts .sorton { color: var(--text-strong); font-weight: 600; }
  .ractions { display: flex; gap: 6px; padding: 0 12px; align-items: center; flex-shrink: 0; }
  .ractions form { margin: 0; }
  .rbtn { background: none; border: 1px solid transparent; color: var(--text-weak); border-radius: 7px;
          padding: 5px 8px; font-size: 14px; cursor: pointer; font-family: inherit; line-height: 1; }
  .rbtn:hover { border-color: var(--border-strong); color: var(--text-strong); }
  .rbtn.danger { border-color: rgba(218,55,60,.5); color: var(--danger); }
  .rbtn.danger:hover { background: var(--danger); border-color: var(--danger); color: #fff; }
  .wb { font-size: 11.5px; background: var(--bg-weak); border-radius: 999px; padding: 2px 9px; color: var(--text-weak); }
  .wb.ok { color: var(--ok); } .wb.warn { color: var(--warn); } .wb.live { color: #fff; background: var(--live); }
  .hits { list-style: none; display: flex; flex-direction: column; gap: 10px; font-size: 14px; margin-top: 8px; }
  .hits a { color: var(--link); text-decoration: none; }
  .hits a:hover { text-decoration: underline; }
  .tstate { font-size: 14px; color: var(--text-weak); }
  details.tech { margin-top: 6px; font-size: 12px; color: var(--text-dim); }
  details.tech summary { cursor: pointer; }
  details.tech code { display: block; margin-top: 6px; padding: 8px 10px; background: var(--bg);
                      border: 1px solid rgba(255,255,255,.1); border-radius: 6px; overflow-wrap: anywhere; }
  .tdl { display: flex; gap: 10px; margin-top: 10px; }
  .tdl a { color: var(--link); font-size: 13px; text-decoration: none; }
  .tdl a:hover { text-decoration: underline; }
  .notes { list-style: none; font-size: 14px; display: flex; flex-direction: column; gap: 4px; }
  .notes time { color: var(--text-weak); margin-right: 8px; }
  .minutes { background: var(--bg); border: 1px solid rgba(255,255,255,.1); border-radius: 8px; padding: 16px 18px;
             font-size: 14.5px; line-height: 1.55; }
  .minutes h3 { font-size: 12.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-weak);
                margin: 16px 0 8px; font-weight: 600; }
  .minutes h3:first-child { margin-top: 0; }
  .minutes ul { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 5px; }
  .minutes .action { display: flex; gap: 8px; align-items: baseline; }
  .minutes .meta2 { color: var(--text-weak); font-size: 12.5px; }
  .minutes time { color: var(--text-weak); margin-right: 6px; }
  .minutes .who { color: var(--text-strong); font-weight: 600; margin: 10px 0 4px; }
  .ts { color: var(--link); font-size: 12px; margin-right: 8px; text-decoration: none; cursor: pointer; }
  .ts:hover { text-decoration: underline; }
  .player { margin: 14px 0 4px; }
  .player audio { width: 100%; }
  .player .hint { font-size: 12.5px; color: var(--text-weak); margin-top: 4px; }
  /* zona de gestão: separada, com a consequência dita em 1 linha antes do clique */
  .dangerzone { margin-top: 30px; border-top: 1px solid var(--border); padding-top: 18px;
                display: flex; flex-direction: column; gap: 12px; }
  /* dentro do painel "Gerenciar" a zona já está isolada — sem borda dupla */
  .tpanel .dangerzone { margin-top: 10px; border-top: 0; padding-top: 0; }
  .dangerzone form { margin: 0; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .dangerzone .why { color: var(--text-dim); font-size: 12.5px; }
  button.danger { background: none; border: 1px solid var(--danger); color: var(--danger); padding: 8px 14px;
                  border-radius: 8px; font-size: 13.5px; cursor: pointer; font-family: inherit; }
  button.danger:hover { background: var(--danger); color: #fff; }
  button.softdanger { background: none; border: 1px solid var(--border-strong); color: var(--text); padding: 8px 14px;
                      border-radius: 8px; font-size: 13.5px; cursor: pointer; font-family: inherit; }
  button.softdanger:hover { border-color: var(--text-strong); color: var(--text-strong); }
  /* chrome do app: marca à esquerda, nav de ação no meio, identidade+saída à direita */
  .topbar { max-width: var(--col); width: 100%; display: flex; align-items: center; gap: 18px;
            margin-bottom: 14px; font-size: 13.5px; color: var(--text-weak); flex-wrap: wrap; }
  .topbar .brand { display: inline-flex; align-items: baseline; font-weight: 800; font-size: 15.5px;
                   color: var(--text-strong); text-decoration: none; letter-spacing: -.02em; }
  .topbar .brand .caret { color: var(--accent); font-family: var(--mono); font-weight: 400; }
  .topbar .apptag { font-family: var(--mono); font-size: 10.5px; color: var(--text-dim);
                    border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; }
  .topbar nav { display: inline-flex; gap: 16px; }
  .topbar nav a { color: var(--text-weak); text-decoration: none; padding: 3px 1px;
                  border-bottom: 2px solid transparent; }
  .topbar nav a:hover { color: var(--text-strong); }
  .topbar nav a[aria-current="page"] { color: var(--text-strong); border-bottom-color: var(--accent); }
  .topnav-r { margin-left: auto; display: inline-flex; align-items: center; gap: 12px; flex-wrap: wrap;
              justify-content: flex-end; }
  .topbar .tl { color: var(--text); text-decoration: none; }
  .topbar .tl:hover { color: var(--text-strong); }
  .topbar .user { display: inline-flex; align-items: center; gap: 6px; color: #c9c7c5; }
  .topbar img { width: 22px; height: 22px; border-radius: 50%; }
  /* tabelas do app (gravações, conexões): scroll próprio no celular, nunca no body */
  .tablewrap { overflow-x: auto; margin-top: 12px; border: 1px solid var(--border); border-radius: 10px; }
  .ktable { width: 100%; border-collapse: collapse; font-size: 13.5px; min-width: 560px; }
  .ktable th { font-family: var(--mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase;
               color: var(--text-dim); text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border);
               font-weight: 600; background: var(--bg); white-space: nowrap; }
  .ktable td { padding: 8px 8px; border-bottom: 1px solid var(--border); vertical-align: middle; white-space: nowrap; }
  .ktable .wb { white-space: nowrap; }
  .ktable tbody tr:last-child td { border-bottom: 0; }
  .ktable time { font-size: 12.5px; }
  .ktable .dayrow td { font-family: var(--mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase;
                       color: var(--text-dim); background: var(--bg); padding: 7px 12px; }
  .rrow { cursor: pointer; }
  .rrow:hover td { background: var(--bg-hover); }
  .rrow .tdch a { color: var(--text-strong); font-weight: 600; text-decoration: none; }
  .rrow .tdch a:hover { text-decoration: underline; }
  .rrow .tdch { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tdmut { color: var(--text-weak); font-size: 12.5px; white-space: nowrap; }
  .tdact { white-space: nowrap; text-align: right; }
  .tdact form { display: inline-block; margin: 0 0 0 2px; }
  /* conexões de IA: revogação individual */
  .genform { display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
  .genform input { flex: 1; min-width: 220px; background: var(--bg); border: 1px solid var(--border);
                   color: var(--text-strong); border-radius: 8px; padding: 10px 12px; font-size: 14px;
                   font-family: inherit; }
  .genform input:focus { outline: none; border-color: var(--accent); }
  /* toggle claro/escuro: mostra o ícone do tema DESTINO */
  .thm { background: none; border: 1px solid var(--border); border-radius: 999px; width: 28px; height: 28px;
         cursor: pointer; font-size: 13px; line-height: 1; padding: 0; display: inline-grid; place-items: center; }
  .thm:hover { border-color: var(--border-strong); }
  .thm .to-dark { display: none; }
  html[data-theme='light'] .thm .to-dark { display: inline; }
  html[data-theme='light'] .thm .to-light { display: none; }
  .langtoggle a { color: var(--text-weak); text-decoration: none; padding: 2px 4px; }
  .langtoggle a.on { color: var(--text-strong); font-weight: 700; }
  .langtoggle a:hover { color: #c9c7c5; }
  .langtoggle span { opacity: .5; margin: 0 2px; }
  .topfoot { max-width: var(--col); width: 100%; margin-top: 30px; padding-top: 16px;
             border-top: 1px solid var(--border); font-size: 13px; color: var(--text-weak); text-align: center; }
  .topfoot a { color: var(--text); text-decoration: none; }
  .topfoot a:hover { color: var(--text-strong); }
  .note { background: var(--bg); border: 1px solid rgba(255,255,255,.1); border-left: 3px solid var(--warn);
          padding: 10px 14px; border-radius: 6px; font-size: 14px; margin-top: 14px; }
  footer { margin-top: 26px; font-size: 13px; color: var(--text-weak); }
  /* nada de imagem/palavra longa forçando scroll horizontal no celular —
     cobre TUDO (nome de guild/canal/pessoa/nota sem espaço vem do Discord) */
  img { max-width: 100%; height: auto; }
  .card, .topbar, .topfoot { overflow-wrap: anywhere; }
  @media (max-width: 480px) {
    body { padding: 16px 10px; }
    .card { padding: 16px 12px; }
    h1 { font-size: 19px; }
    .topbar { gap: 10px 14px; }
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

/** Data sem hora ("2 de julho de 2026"), reescrita pro fuso do navegador. */
function dateOnly(ms: number, lang: Locale): string {
  const fallback = new Date(ms).toLocaleDateString(lang === 'pt' ? 'pt-BR' : 'en-US', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: config.timezone,
  });
  return `<time data-ts="${ms}" data-fmt="day">${esc(fallback)}</time>`;
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
    var opts = el.dataset.fmt === 'clock' ? {timeStyle:'short'}
      : el.dataset.fmt === 'day' ? {dateStyle:'long'}
      : {dateStyle:'long', timeStyle:'short'};
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
  // sem player (áudio expirado/demo): abre a aba da transcrição e rola até o trecho
  if (window.kshow) window.kshow('transcricao');
  var paras = document.querySelectorAll('.transcript p[data-s]');
  var sb = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  for (var i = 0; i < paras.length; i++) {
    if (+paras[i].dataset.s >= ms) { paras[i].scrollIntoView({block:'center', behavior:sb}); return; }
  }
};
// deep link do MCP/transcrição: #t=<segundos> pula pro momento ao abrir (e ao trocar o hash).
// preload=none: se os metadados ainda não carregaram, espera loadedmetadata antes de buscar.
// Sem player (áudio expirado/liberado), o kseek degrada pra rolar até o trecho.
function kseekFromHash(){
  var m = /#t=(\\d+)/.exec(location.hash);
  if (!m) return;
  var secs = +m[1];
  var p = document.getElementById('kplayer');
  if (!p) { window.kseek(secs*1000); return; }
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

// Tema: aplicado ANTES da pintura (head) — salvo em localStorage, senão segue o sistema.
const THEME_INIT = `<script>(function(){try{var t=localStorage.getItem('ktheme');if(t!=='light'&&t!=='dark')t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';document.documentElement.dataset.theme=t;}catch(e){}})();</script>`;
const THEME_TOGGLE_SCRIPT = `<script>(function(){var b=document.querySelector('.thm');if(!b)return;b.addEventListener('click',function(){var d=document.documentElement;var t=d.dataset.theme==='light'?'dark':'light';d.dataset.theme=t;try{localStorage.setItem('ktheme',t);}catch(e){}});})();</script>`;

function shell(
  title: string,
  body: string,
  opts: {
    user?: WebUser;
    lang?: Locale;
    refreshSeconds?: number;
    active?: 'rec' | 'ai';
    demo?: boolean;
    /** páginas de tabela (central): coluna larga de 960px. */
    wide?: boolean;
    /** Mostra "Conectar IA" na nav — só na central e no próprio conectar
     *  (na página de uma gravação é ruído; feedback do Mauro). */
    navAi?: boolean;
  } = {},
): string {
  const lang = opts.lang === 'pt' ? 'pt' : 'en';
  const pt = lang === 'pt';
  // Toggle de idioma (fica salvo via cookie); links relativos preservam a rota atual.
  const langToggle = `<div class="langtoggle"><a href="?lang=en"${lang === 'en' ? ' class="on"' : ''}>EN</a><span>·</span><a href="?lang=pt"${lang === 'pt' ? ' class="on"' : ''}>PT</a></div>`;
  // Dois chromes, um shell. DEMO (público) é vitrine: a marca volta pra landing
  // e o convite é "Entrar". APP (logado) é cockpit: a marca leva pra /app, a nav
  // é só de ação (zero link de marketing — GitHub/demo vivem na landing) e a
  // única saída é "Sair". Deslogado em página do app: a ponte é o login.
  const brand = opts.demo
    ? `<a class="brand" href="/">kassinao<span class="caret">▌</span></a>`
    : `<a class="brand" href="/app">kassinao<span class="caret">▌</span></a><span class="apptag">app</span>`;
  const nav =
    !opts.demo && opts.user
      ? `<nav><a href="/app"${opts.active === 'rec' ? ' aria-current="page"' : ''}>${pt ? 'Gravações' : 'Recordings'}</a>${
          config.mcpEnabled && (opts.navAi || opts.active === 'ai')
            ? `<a href="/app/conectar-ia"${opts.active === 'ai' ? ' aria-current="page"' : ''}>${pt ? 'Conectar IA' : 'Connect AI'}</a>`
            : ''
        }</nav>`
      : '';
  const themeBtn = `<button type="button" class="thm" aria-label="${pt ? 'alternar tema claro/escuro' : 'toggle light/dark theme'}"><span class="to-light">☀️</span><span class="to-dark">🌙</span></button>`;
  const signIn = `<a class="tl" href="/auth/login?next=%2Fapp">${pt ? 'Entrar' : 'Sign in'}</a>`;
  const right =
    !opts.demo && opts.user
      ? `${themeBtn}${langToggle}<span class="user">${opts.user.avatar ? `<img src="${esc(opts.user.avatar)}" alt="">` : ''}${esc(opts.user.name)}</span><a class="tl" href="/auth/logout">${pt ? 'Sair' : 'Sign out'}</a>`
      : `${themeBtn}${langToggle}${signIn}`;
  const userbar = `<header class="topbar">${brand}${nav}<span class="topnav-r">${right}</span></header>`;
  const foot = opts.demo
    ? `<footer class="topfoot"><a href="/">kassinao</a> · AGPL-3.0 · open-source</footer>`
    : `<footer class="topfoot">kassinao · AGPL-3.0</footer>`;
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
${opts.demo ? '' : '<meta name="robots" content="noindex">'}
<title>${esc(title)} — Kassinão</title>
<link rel="icon" href="${FAVICON}">
${THEME_INIT}
<style>${APP_CSS}</style>
</head>
<body${opts.wide ? ' class="wide"' : ''}>
${userbar}
<div class="card">${body}</div>
${foot}
${TZ_SCRIPT}
${THEME_TOGGLE_SCRIPT}
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

  // ---------- player: o dock real vai pro bloco sticky (junto das abas);
  // demo/expirado ficam no fluxo do cabeçalho ----------
  const audioGone = !!meta.audioDeleted;
  let playerDock = '';
  let playerFlow = '';
  if (demo) {
    playerFlow = `<h2>${p(l, 'sampleAudio')}</h2>
       <div class="player">
         <audio preload="none" controls src="/demo/audio"></audio>
         <div class="hint">${p(l, 'sampleNote')}</div>
       </div>`;
  } else if (audioGone) {
    playerFlow = `<div class="note" style="border-left-color:#6d7178;margin-top:14px">${p(l, 'audioExpired')}</div>`;
  } else if (!live && meta.participants.length > 0) {
    playerDock = `<div class="playerwrap">
         <audio id="kplayer" preload="none" controls src="/app/rec/${meta.id}/audio"></audio>
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
      ? `<h2>${p(l, 'notes')}</h2><ul class="notes">${meta.notes
          .map(
            (n) =>
              `<li>${seekable ? `<a class="ts" href="#" onclick="kseek(${n.atMs});return false">${formatOffset(n.atMs)}</a>` : `<time>${formatOffset(n.atMs)}</time>`}${clockTime(meta.startedAt + n.atMs, l)}<strong>${esc(n.author)}:</strong> ${esc(n.text)}</li>`,
          )
          .join('')}</ul>`
      : '';

  // ---------- linha do tempo: barra visual clicável + lista dobrável ----------
  const events = renderTimeline(meta, opts.minutes, l, durMs, live, seekable);

  // ---------- exportar (vira painel de aba — some do caminho da leitura) ----------
  const downloads =
    !demo && !audioGone && meta.participants.length > 0
      ? `<h2>⬇️ ${p(l, 'dlFold')}</h2>
        <div class="downloads">
          <a class="btn secondary" href="/app/rec/${meta.id}/download/mp3">🎵 MP3 <small>${p(l, 'mp3sub')}</small></a>
          <a class="btn secondary" href="/app/rec/${meta.id}/download/flac">💎 FLAC <small>${p(l, 'flacsub')}</small></a>
          <a class="btn secondary" href="/app/rec/${meta.id}/download/mix">🎧 Mix <small>${p(l, 'mixsub')}</small></a>
          <a class="btn secondary" href="/app/rec/${meta.id}/download/audacity">🎚️ Audacity <small>${p(l, 'audacitysub')}</small></a>
        </div>
        <p class="muted" style="margin-top:10px">${p(l, 'cooking')}</p>`
      : '';

  // ---------- gestão: zona separada, consequência dita ANTES do clique; o
  // servidor revalida permissão/estado no POST (o confirm() não é a autoridade)
  const manage =
    opts.canDelete && !live && !demo
      ? `<div class="dangerzone">
        ${
          !audioGone
            ? `<form method="post" action="/app/rec/${meta.id}/liberar-audio"
                 onsubmit="return confirm('${p(l, 'ixFreeSpaceConfirm')}')">
                 <button class="softdanger" type="submit">${p(l, 'ixFreeSpace')}</button><span class="why">${p(l, 'freeWhy')}</span>
               </form>`
            : ''
        }
        <form method="post" action="/app/rec/${meta.id}/delete"
          onsubmit="return confirm('${p(l, 'delconfirm')}')">
          <button class="danger" type="submit">${p(l, 'del')}</button><span class="why">${p(l, 'delWhy')}</span>
        </form>
      </div>`
      : '';

  // rodapé: a config ATUAL decide a mensagem de expiração (ilimitada = "até alguém apagar")
  const audioExp = audioExpiryOf(meta);
  const textExp = textExpiryOf(meta);
  const footNote = live
    ? ''
    : audioGone
      ? textExp
        ? `${p(l, 'textExpires', { date: datetime(textExp, l) })} · `
        : `${p(l, 'textKeptForever')} · `
      : audioExp
        ? `${p(l, 'expires', { date: datetime(audioExp, l) })} · `
        : `${p(l, 'keptForever')} · `;
  const pageFoot = !demo ? `<footer>${footNote}ID <code>${esc(meta.id)}</code></footer>` : '';

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

  // ---------- ABAS: uma seção na tela por vez (nada de rolar até o fim).
  // Sem JS os painéis rendem todos visíveis, empilhados — nada se perde.
  const panels: Array<[string, string, string]> = [];
  if (minutes) panels.push(['ata', `📋 ${p(l, 'minutes')}`, minutes]);
  if (transcription) panels.push(['transcricao', `💬 ${p(l, 'transcript')}`, transcription]);
  if (events) panels.push(['timeline', `⏱️ ${p(l, 'timeline')}`, events]);
  if (notes) panels.push(['notas', `📝 ${p(l, 'notes')} (${meta.notes.length})`, notes]);
  if (downloads) panels.push(['exportar', `⬇️ ${p(l, 'dlShort')}`, downloads]);
  if (manage) panels.push(['gerenciar', `⚙️ ${p(l, 'manage')}`, manage]);
  const tabbar =
    panels.length >= 2
      ? `<div class="tabbar" role="tablist">${panels
          .map(
            ([id, label]) => `<button type="button" role="tab" data-t="${id}" aria-selected="false">${label}</button>`,
          )
          .join('')}</div>`
      : '';
  const panelHtml = panels
    .map(([id, , html]) => `<section class="tpanel" id="${id}" role="tabpanel">${html}</section>`)
    .join('\n     ');
  // player real + abas ficam FIXOS no topo: ouvir e trocar de seção sem rolar
  const stick = playerDock || tabbar ? `<div class="stick">${playerDock}${tabbar}</div>` : '';

  return shell(
    demo ? `#${meta.voiceChannelName} (demo)` : `#${meta.voiceChannelName} — ${p(l, 'recording')}`,
    `<h1>${title} ${badge}</h1>
     ${subline}
     ${demoNote}
     ${liveNote}
     ${people}
     ${presentAlso}
     ${playerFlow}
     ${stick}
     ${panelHtml}
     ${pageFoot}
     ${demoCta}
     ${RECORDING_SCRIPT}`,
    {
      user: opts.user,
      lang: l,
      active: 'rec',
      demo,
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

  return `<h2>${p(l, 'timeline')}</h2>${bar}${list}`;
}

/** Script da página de gravação: abas, velocidade, seguir-áudio (karaoke) e busca na transcrição. */
const RECORDING_SCRIPT = `<script>
(function(){
  // ---------- abas: uma seção por vez; sem JS tudo fica empilhado ----------
  var panels = [].slice.call(document.querySelectorAll('.tpanel'));
  var tabs = [].slice.call(document.querySelectorAll('.tabbar [data-t]'));
  window.kshow = function(id){
    if (!tabs.length) return;
    if (!panels.some(function(p){ return p.id === id; })) return;
    panels.forEach(function(p){ p.hidden = p.id !== id; });
    tabs.forEach(function(b){ b.setAttribute('aria-selected', String(b.dataset.t === id)); });
  };
  tabs.forEach(function(b){
    b.addEventListener('click', function(){
      window.kshow(b.dataset.t);
      try { history.replaceState(null, '', '#' + b.dataset.t); } catch(e){}
    });
  });
  if (tabs.length) {
    document.documentElement.classList.add('ktabs');
    // aba inicial: hash (#transcricao, #t=42 → transcrição) ou a primeira (ata)
    var h = location.hash.slice(1);
    window.kshow(/^t=/.test(h) ? 'transcricao' : (panels.some(function(p){ return p.id === h; }) ? h : panels[0].id));
  }
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
        var sb = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
        if (f && f.checked) current.scrollIntoView({ block: 'center', behavior: sb });
      }
    });
  }
  // busca + filtro por falante
  var input = document.getElementById('ksearch');
  function applyFilter(){
    var q = input ? input.value.trim().toLowerCase() : '';
    // Object.create(null): nome de falante vem do Discord — 'constructor'/'toString'
    // num objeto plano seria truthy sem filtro nenhum e sumiria com o bloco
    var off = Object.create(null);
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
  const title = `<h2>📋 ${p(l, 'minutes')}</h2>`;
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
  const dl = seekable
    ? `<div class="tdl"><a href="/app/rec/${meta.id}/ata.md">${p(l, 'minutesDownload')}</a></div>`
    : '';
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
  const title = `<h2>${p(l, 'transcript')}</h2>`;
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
      <a href="/app/rec/${meta.id}/transcricao.md">${p(l, 'transcriptDownload')}</a>
      <a href="/app/rec/${meta.id}/transcricao.txt">${p(l, 'transcriptDownloadTxt')}</a>
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

/** Bytes → "1,2 GB" / "340 MB" (pt usa vírgula decimal). */
function formatBytes(bytes: number, l: Locale): string {
  const gb = bytes / (1024 * 1024 * 1024);
  const mb = bytes / (1024 * 1024);
  const dec = (n: number) => (l === 'pt' ? n.toFixed(1).replace('.', ',') : n.toFixed(1));
  if (gb >= 1) return `${dec(gb)} GB`;
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** "há 3 dias" / "3 days ago" — idade aproximada pra decidir o que apagar. */
function relativeAge(ts: number, l: Locale): string {
  const pt = l === 'pt';
  const min = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (min < 60) return pt ? `há ${min} min` : `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return pt ? `há ${h}h` : `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return pt ? `há ${d} dias` : `${d} days ago`;
  const mo = Math.round(d / 30);
  return pt ? `há ${mo} meses` : `${mo} months ago`;
}

/** Item do índice v2: meta + o que ESTA pessoa pode fazer + custo em disco (só dono vê). */
export interface RecordingIndexItem {
  meta: RecordingMeta;
  canDelete: boolean;
  /** Bytes de áudio no disco — presente só quando o viewer é dono do servidor (OWNER_IDS). */
  audioBytes?: number;
}

export type RecordingsSort = 'recent' | 'oldest' | 'largest';

/** Índice web "minhas gravações": gestão completa — busca, totais, ordenação e ações. */
export function recordingsIndexPage(
  items: RecordingIndexItem[],
  opts: {
    user: WebUser;
    lang: Locale;
    q?: string;
    hits?: WebSearchHit[];
    /** Dono da VPS (OWNER_IDS): vê tamanhos em disco e ordenação por tamanho. */
    owner?: boolean;
    /** MB livres no volume das gravações (só com owner=true). */
    freeDiskMB?: number;
    sort?: RecordingsSort;
    /** Flash pós-ação (?freed=1 / ?deleted=1). */
    flash?: string;
  },
): string {
  const l = opts.lang;
  const pt = l === 'pt';
  const q = opts.q ?? '';
  const sort: RecordingsSort = opts.sort ?? 'recent';
  const metas = items.map((i) => i.meta);

  // busca primeiro (sticky); "/" foca o campo de qualquer lugar da página
  const searchForm = `<form class="isearch" method="get" action="/app">
      <input id="kq" name="q" type="search" value="${esc(q)}" placeholder="${pt ? 'Buscar em transcrições, atas e notas…  ( / )' : 'Search transcripts, minutes and notes…  ( / )'}" autocomplete="off">
      <button class="btn" type="submit">🔎 ${pt ? 'Buscar' : 'Search'}</button>
    </form>
    <script>document.addEventListener('keydown',function(e){
      if(e.key==='/'&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)){e.preventDefault();var i=document.getElementById('kq');if(i)i.focus();}
    });</script>`;

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
                 h.atMs !== undefined ? `/app/rec/${h.metaId}#t=${Math.floor(h.atMs / 1000)}` : `/app/rec/${h.metaId}`;
               const icon = h.kind === 'minutes' ? '📋' : h.kind === 'note' ? '📝' : '💬';
               const when = h.atMs !== undefined ? ` <a class="ts" href="${link}">${msToClock(h.atMs)}</a>` : '';
               return `<li>${icon} <a href="${link}"><strong>#${esc(h.channelName)}</strong></a> · ${datetime(h.startedAt, l)}${when}<br>
                 <span class="muted">${h.speaker ? `<strong>${esc(h.speaker)}:</strong> ` : ''}${esc(h.snippet)}</span></li>`;
             })
             .join('')}</ul>`;
  }

  // cabeçalho de gestão: quantas gravações, quanto de áudio no disco, quanto sobra
  const totalAudio = items.reduce((sum, i) => sum + (i.audioBytes ?? 0), 0);
  const nLabel = items.length === 1 ? p(l, 'ixRecording1') : p(l, 'ixRecordings');
  const statsParts = [`<strong>${items.length}</strong> ${nLabel}`];
  if (opts.owner) {
    statsParts.push(`💾 <strong>${formatBytes(totalAudio, l)}</strong> ${p(l, 'ixAudioOnDisk')}`);
    if (opts.freeDiskMB !== undefined && opts.freeDiskMB !== Infinity)
      statsParts.push(`📀 <strong>${formatBytes(opts.freeDiskMB * 1024 * 1024, l)}</strong> ${p(l, 'ixFree')}`);
  }
  const stats = items.length > 0 ? `<div class="rstats">${statsParts.join(' · ')}</div>` : '';

  // ordenação por link (server-side): recentes / antigas / maiores (esta só pro dono)
  const sortLink = (s: RecordingsSort, label: string) =>
    s === sort
      ? `<span class="sorton">${label}</span>`
      : `<a href="/app?sort=${s}${q ? `&q=${encodeURIComponent(q)}` : ''}">${label}</a>`;
  const sorts =
    items.length > 1
      ? `<div class="rsorts">${p(l, 'ixSort')} ${sortLink('recent', p(l, 'ixSortRecent'))} · ${sortLink('oldest', p(l, 'ixSortOldest'))}${
          opts.owner ? ` · ${sortLink('largest', p(l, 'ixSortLargest'))}` : ''
        }</div>`
      : '';

  const flash = opts.flash ? `<div class="note" style="margin-top:12px">${esc(opts.flash)}</div>` : '';

  const channels = [...new Set(metas.map((m) => m.voiceChannelName))];
  const chips =
    channels.length > 1
      ? `<div class="fchips" style="margin:10px 0 2px">${channels
          .map((c) => `<button type="button" class="fchip" data-ch="${esc(c)}">#${esc(c)}</button>`)
          .join('')}</div>`
      : '';

  // agrupamento por dia (no fuso do servidor) — vira subtítulo leve entre os
  // cards; em "maiores" a ordem não é cronológica, então a lista fica plana
  const dayLabel = (ms: number) =>
    esc(
      new Date(ms).toLocaleDateString(pt ? 'pt-BR' : 'en-US', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: config.timezone,
      }),
    );
  let lastDay = '';
  // colunas: Canal(+estado) | Início | Duração | Iniciou | Detalhes | ações
  const NCOL = 6;
  const rows = items
    .map(({ meta: m, canDelete, audioBytes }) => {
      let dayh = '';
      if (sort !== 'largest') {
        const day = dayLabel(m.startedAt);
        if (day !== lastDay) {
          lastDay = day;
          // <time data-fmt="day">: o TZ_SCRIPT reescreve pro fuso do navegador
          dayh = `<tr class="dayrow"><td colspan="${NCOL}"><time data-ts="${m.startedAt}" data-fmt="day">${day}</time></td></tr>`;
        }
      }
      const live = m.status === 'recording';
      // "25min 0s" → "25min" (o sufixo zerado é ruído em tabela)
      const dur = m.endedAt
        ? formatDuration(m.endedAt - m.startedAt)
            .replace(/ 0s$/, '')
            .replace(/ 0min$/, '')
        : p(l, 'ixLive');
      const who = m.startedBy ? `👤 ${esc(m.startedBy.name)}` : `🤖 ${p(l, 'ixByAuto')}`;
      // defesa em profundidade: tamanho SÓ com owner=true, mesmo se bytes vazarem no item
      const size =
        opts.owner && audioBytes !== undefined && audioBytes > 0 && !m.audioDeleted
          ? `💾 ${formatBytes(audioBytes, l)}`
          : '';
      const notes = m.notes.length > 0 ? `📝 ${m.notes.length}` : '';
      const freed = m.audioDeleted ? `<span class="muted">${p(l, 'ixAudioFreed')}</span>` : '';
      const extras = [`🎙️ ${m.participants.length}`, notes, size, freed].filter(Boolean).join('&ensp;');
      // ações só pra quem pode apagar (iniciador/admin) e nunca ao vivo —
      // o servidor revalida tudo de novo no POST
      const actions =
        canDelete && !live
          ? `${
              !m.audioDeleted
                ? `<form method="post" action="/app/rec/${m.id}/liberar-audio?back=index" onsubmit="return confirm('${p(l, 'ixFreeSpaceConfirm')}')">
                     <button type="submit" class="rbtn" title="${p(l, 'ixFreeSpace')}" aria-label="${p(l, 'ixFreeSpace')}">🔇</button></form>`
                : ''
            }
            <form method="post" action="/app/rec/${m.id}/delete?back=index" onsubmit="return confirm('${p(l, 'delconfirm')}')">
              <button type="submit" class="rbtn danger" title="${p(l, 'ixDelete')}" aria-label="${p(l, 'ixDelete')}">🗑️</button></form>`
          : '';
      // a linha inteira navega (JS); o link do canal cobre o caso sem JS
      return `${dayh}<tr class="rrow" data-ch="${esc(m.voiceChannelName)}" data-href="/app/rec/${m.id}">
        <td class="tdch"><a href="/app/rec/${m.id}">#${esc(m.voiceChannelName)}</a> ${webBadge(m, l)}</td>
        <td>${clockTime(m.startedAt, l)} <span class="tdmut">· ${relativeAge(m.startedAt, l)}</span></td>
        <td>${dur}</td>
        <td class="tdmut">${who}</td>
        <td class="tdmut">${extras}</td>
        <td class="tdact">${actions}</td>
      </tr>`;
    })
    .join('');
  const th = (a: string, b: string) => (pt ? a : b);
  const cards =
    items.length === 0
      ? `<p class="muted" style="margin-top:16px">${
          pt
            ? 'Nenhuma gravação acessível ainda. Grave uma call com /gravar no Discord!'
            : 'No accessible recordings yet. Record a call with /record on Discord!'
        }</p>`
      : `<div class="tablewrap"><table class="ktable">
          <thead><tr>
            <th>${th('Canal', 'Channel')}</th><th>${th('Início', 'Started')}</th><th>${th('Duração', 'Length')}</th>
            <th>${th('Iniciou', 'By')}</th><th>${th('Detalhes', 'Details')}</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        <script>
        // linha inteira clicável (menos botões/links, que têm ação própria)
        document.querySelectorAll('.rrow[data-href]').forEach(function(r){
          r.addEventListener('click', function(e){
            if (e.target.closest('a,button,form')) return;
            location.href = r.dataset.href;
          });
        });
        document.querySelectorAll('.fchip[data-ch]').forEach(function(c){
          c.addEventListener('click', function(){
            c.classList.toggle('off');
            var off = Object.create(null); // nome de canal é do Discord: sem herdar Object.prototype
            document.querySelectorAll('.fchip.off').forEach(function(x){ off[x.dataset.ch] = true; });
            var any = document.querySelectorAll('.fchip.off').length > 0;
            document.querySelectorAll('.rrow').forEach(function(r){
              r.style.display = any && off[r.dataset.ch] ? 'none' : '';
            });
            // cabeçalho de dia some junto quando o filtro esconde todas as linhas do dia
            document.querySelectorAll('.ktable .dayrow').forEach(function(d){
              var n = d.nextElementSibling, vis = false;
              while (n && !n.classList.contains('dayrow')) {
                if (n.classList.contains('rrow') && n.style.display !== 'none') { vis = true; break; }
                n = n.nextElementSibling;
              }
              d.style.display = vis ? '' : 'none';
            });
          });
        });
        </script>`;

  return shell(
    pt ? 'Minhas gravações' : 'My recordings',
    `<h1>📼 ${pt ? 'Minhas gravações' : 'My recordings'}</h1>
     <p class="subline">${
       pt
         ? `Você é <strong>${esc(opts.user.name)}</strong> · vendo tudo que você já pode acessar, em todos os servidores.`
         : `You are <strong>${esc(opts.user.name)}</strong> · seeing everything you can access, across servers.`
     }</p>
     ${searchForm}
     ${hitsHtml}
     ${flash}
     ${stats}
     ${sorts}
     ${chips}
     ${cards}`,
    { user: opts.user, lang: l, active: 'rec', navAi: true, wide: true },
  );
}

export function messagePage(title: string, message: string, user?: WebUser, lang?: Locale): string {
  // Páginas de mensagem/erro (404/403/etc.) nunca são beco sem saída — e nunca
  // jogam um usuário LOGADO de volta na landing: a casa dele é /app. Deslogado,
  // a saída é a ponte de login (a única ponte público→app).
  const pt = lang === 'pt';
  const back = user
    ? `<a class="btn" href="/app">${pt ? '← Minhas gravações' : '← My recordings'}</a>`
    : `<a class="btn" href="/auth/login?next=%2Fapp">${pt ? 'Entrar com Discord' : 'Sign in with Discord'}</a>`;
  const body =
    `<h1>${esc(title)}</h1><p class="muted" style="margin-top:12px">${esc(message)}</p>` +
    `<div class="downloads" style="margin-top:18px">${back}</div>`;
  return shell(title, body, { user, lang });
}

const REPO_URL = 'https://github.com/resolvicomai/kassinao';
const NPM_URL = 'https://www.npmjs.com/package/kassinao-mcp';
// Enquanto o repo é privado, links "GitHub" apontam pro npm (público) pra não dar 404.
const ghHref = (): string => (config.repoPublic ? REPO_URL : NPM_URL);

// favicon inline (marca "K" em blurple) — data: URI permitido pela CSP (img-src data:), sem asset externo
const FAVICON =
  "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E%3Crect%20width='32'%20height='32'%20rx='7'%20fill='%235865F2'/%3E%3Ctext%20x='16'%20y='23'%20font-size='19'%20font-weight='bold'%20text-anchor='middle'%20fill='white'%20font-family='sans-serif'%3EK%3C/text%3E%3C/svg%3E";

// CSS da landing (vitrine pública). Documento próprio, full-width — NÃO usa o
// .card do shell(). Voz tipográfica sans real (a mesma família do sistema);
// monoespaçado (.mono) fica reservado a timestamps, nomes de env var, comandos
// e identificadores de licença — nunca em heading/parágrafo de venda. Os tokens
// de cor (fundo, cartão, cores de falante .c0-.c7, badges) são os MESMOS do
// APP_CSS/recordingPage() real: a "prova" da landing (.proof) reusa essas
// classes literalmente, não é uma ilustração à parte. Self-contained (CSP: sem
// fonte/CSS/JS/imagem externa); respeita prefers-reduced-motion.
export function connectPage(opts: {
  lang: Locale;
  user?: WebUser;
  refreshToken?: string;
  /** apelido dado à conexão recém-gerada (eco na página do token). */
  label?: string;
  /** conexões ativas DESTE usuário — a lista de gestão. */
  sessions?: SessionSummary[];
  revoked?: 'all' | 'one';
}): string {
  const pt = opts.lang === 'pt';
  const T = (a: string, b: string): string => (pt ? a : b);
  const title = T('Conectar assistente de IA', 'Connect your AI assistant');

  if (!opts.user) {
    const body = `<h1>🔌 ${esc(title)}</h1>
      <p class="muted" style="margin-top:12px">${esc(
        T(
          'Conecte suas reuniões do Kassinão a qualquer assistente de IA com MCP (Claude Desktop, Cursor…). Entre com o Discord — você só verá as gravações que já pode ver no site.',
          'Connect your Kassinão meetings to any MCP-capable AI assistant (Claude Desktop, Cursor…). Sign in with Discord — you will only see recordings you can already see on the site.',
        ),
      )}</p>
      <div class="downloads" style="margin-top:18px">
        <a class="btn" href="/auth/login?next=%2Fapp%2Fconectar-ia">${esc(T('Entrar com Discord', 'Sign in with Discord'))}</a>
      </div>`;
    return shell(title, body, { lang: opts.lang, active: 'ai' });
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
      ${
        opts.label
          ? `<p class="muted" style="margin-top:8px">${esc(T('Apelido', 'Nickname'))}: <strong>${esc(opts.label)}</strong> — ${esc(
              T(
                'é assim que ela aparece na sua lista de conexões.',
                'that is how it shows up in your connections list.',
              ),
            )}</p>`
          : ''
      }
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
        <li>${esc(T('Outro assistente com MCP: onde a documentação dele indicar', 'Any other MCP-capable assistant: wherever its docs point'))}</li>
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
          'Depois reinicie o app e pergunte: "o que ficou pendente essa semana?"',
          'Then restart the app and ask: "what is pending this week?"',
        ),
      )}</p>
      <div class="downloads" style="margin-top:18px"><a class="btn" href="/app/conectar-ia">${esc(T('Voltar', 'Back'))}</a></div>
      <script>(function(){var b=document.getElementById('kcopy');if(!b)return;b.addEventListener('click',function(){var t=(document.getElementById('kcfg').textContent)||'';navigator.clipboard.writeText(t).then(function(){var o=b.textContent;b.textContent='${esc(T('Copiado ✓', 'Copied ✓'))}';setTimeout(function(){b.textContent=o;},2000);});});})();</script>`;
    return shell(title, body, { lang: opts.lang, user: opts.user, active: 'ai' });
  }

  // ---------- estado de gestão: lista das SUAS conexões, cada uma nomeada,
  // com criação/último uso/expiração e revogação individual ----------
  const sess = opts.sessions ?? [];
  const revokedMsg =
    opts.revoked === 'all'
      ? `<div class="note" style="border-left-color:var(--ok)">✅ ${esc(T('Todas as suas conexões foram revogadas.', 'All your connections were revoked.'))}</div>`
      : opts.revoked === 'one'
        ? `<div class="note" style="border-left-color:var(--ok)">✅ ${esc(T('Conexão revogada — o token dela parou de funcionar na hora.', 'Connection revoked — its token stopped working immediately.'))}</div>`
        : '';
  const noName = T('sem apelido', 'unnamed');
  const rows = sess
    .map((s) => {
      const last = s.lastSeenAt
        ? relativeAge(s.lastSeenAt, opts.lang)
        : `<span class="muted">${T('nunca usada', 'never used')}</span>`;
      return `<tr>
        <td class="tdch">🔌 <strong>${s.label ? esc(s.label) : `<span class="muted">${noName}</span>`}</strong> <code>${esc(s.sid.slice(0, 8))}</code></td>
        <td>${dateOnly(s.createdAt, opts.lang)}</td>
        <td>${last}</td>
        <td class="tdmut">${dateOnly(s.exp, opts.lang)}</td>
        <td class="tdact"><form method="post" action="/app/conectar-ia/revogar/${esc(s.sid)}"
          onsubmit="return confirm('${esc(T('Revogar esta conexão? O assistente ligado nela para de funcionar na hora.', 'Revoke this connection? The assistant using it stops working immediately.'))}')">
          <button type="submit" class="rbtn danger" title="${esc(T('Revogar esta conexão', 'Revoke this connection'))}">${esc(T('revogar', 'revoke'))}</button>
        </form></td>
      </tr>`;
    })
    .join('');
  const list =
    sess.length > 0
      ? `<h2>${esc(T('Suas conexões', 'Your connections'))} (${sess.length})</h2>
         <div class="tablewrap"><table class="ktable" style="min-width:560px">
           <thead><tr>
             <th>${esc(T('Conexão', 'Connection'))}</th><th>${esc(T('Criada', 'Created'))}</th>
             <th>${esc(T('Último uso', 'Last used'))}</th><th>${esc(T('Expira', 'Expires'))}</th><th></th>
           </tr></thead>
           <tbody>${rows}</tbody>
         </table></div>
         ${
           sess.length > 1
             ? `<form method="post" action="/app/conectar-ia/revogar" style="margin-top:14px"
                 onsubmit="return confirm('${esc(T('Revogar TODAS as suas conexões de uma vez?', 'Revoke ALL your connections at once?'))}')">
                 <button type="submit" class="danger">${esc(T('Revogar todas', 'Revoke all'))}</button>
               </form>`
             : ''
         }`
      : `<h2>${esc(T('Suas conexões', 'Your connections'))}</h2>
         <p class="muted">${esc(T('Nenhuma conexão ativa no momento.', 'No active connections right now.'))}</p>`;
  const body = `<h1>🔌 ${esc(title)}</h1>
    ${revokedMsg}
    <p class="muted" style="margin-top:12px">${esc(
      T(
        'Ligue o Kassinão em qualquer assistente de IA com MCP (Claude, Cursor e outros) para perguntar sobre as suas calls em linguagem natural.',
        'Plug Kassinão into any MCP-capable AI assistant (Claude, Cursor, and more) to ask about your calls in natural language.',
      ),
    )}</p>
    <p class="muted" style="margin-top:10px">🔒 ${esc(
      T(
        'Esta página é sua: cada pessoa entra com o próprio Discord e só vê — e só pode revogar — as PRÓPRIAS conexões. E cada conexão só enxerga as gravações que o dono dela já pode ver.',
        'This page is yours: each person signs in with their own Discord and only sees — and can only revoke — their OWN connections. And each connection only sees recordings its owner can already see.',
      ),
    )}</p>
    <form class="genform" method="post" action="/app/conectar-ia/gerar">
      <input name="label" maxlength="40" autocomplete="off"
        placeholder="${esc(T('apelido (opcional) — ex.: Claude do notebook', 'nickname (optional) — e.g. Claude on my laptop'))}">
      <button class="btn" type="submit" style="border:0;cursor:pointer;font:inherit">🔌 ${esc(T('Gerar conexão', 'Generate connection'))}</button>
    </form>
    <p class="muted" style="margin-top:8px;font-size:12.5px">${esc(
      T(
        'Sai uma configuração pronta pra colar no seu app (a gente diz onde). O apelido ajuda você a saber qual revogar depois.',
        'You get a ready-to-paste config (we tell you where it goes). The nickname helps you know which one to revoke later.',
      ),
    )}</p>
    ${list}`;
  return shell(title, body, { lang: opts.lang, user: opts.user, active: 'ai', wide: true });
}
