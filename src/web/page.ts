import { config } from '../config';
import { localizeEvent, Locale } from '../i18n';
import { msToClock } from '../processing/transcribe';
import { formatDuration, formatOffset } from '../recorder/RecordingSession';
import {
  audioExpiryOf,
  MeetingMinutes,
  RecordingMeta,
  textExpiryOf,
  TranscriptSegment,
  transcriptionNeedsAudio,
} from '../store';
import { shortError } from '../util';
import type { WebUser } from './auth';
import type { SessionSummary } from './mcpTokens';
import type { WebSearchHit } from './search';
import { PUBLIC_LINKS, publicPath } from './site';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;'); // aspas simples: seguro também em atributos com aspas simples
}

const P: Record<string, { pt: string; en: string }> = {
  live: { pt: 'AO VIVO', en: 'LIVE' },
  done: { pt: 'FINALIZADA', en: 'FINISHED' },
  recording: { pt: 'Gravação', en: 'Recording' },
  server: { pt: 'Servidor', en: 'Server' },
  channel: { pt: 'Canal', en: 'Channel' },
  started: { pt: 'Início', en: 'Started' },
  duration: { pt: 'Duração', en: 'Duration' },
  counting: { pt: ' (e contando…)', en: ' (and counting…)' },
  participants: { pt: 'Participantes', en: 'Participants' },
  nobody: { pt: 'Ninguém falou ainda.', en: 'Nobody has spoken yet.' },
  downloads: { pt: 'Downloads', en: 'Downloads' },
  mp3sub: { pt: 'uma faixa por pessoa (ZIP)', en: 'one track per speaker (ZIP)' },
  flacsub: { pt: 'lossless, uma faixa por pessoa (ZIP)', en: 'lossless, one track per speaker (ZIP)' },
  mixsub: { pt: 'todo mundo junto (MP3)', en: 'everyone together (MP3)' },
  audacitysub: { pt: 'FLAC + projeto alinhado + notas', en: 'FLAC + aligned project + notes' },
  transcript: { pt: 'Transcrição', en: 'Transcript' },
  transcriptPending: { pt: 'Transcrição na fila…', en: 'Transcript queued…' },
  transcriptRunning: {
    pt: 'Transcrevendo… Esta página se atualiza sozinha.',
    en: 'Transcribing… This page refreshes itself.',
  },
  transcriptError: { pt: 'A transcrição falhou: ', en: 'Transcription failed: ' },
  transcriptEmpty: {
    pt: 'A transcrição terminou sem texto (só silêncio?).',
    en: 'The transcript finished empty (only silence?).',
  },
  transcriptDownload: { pt: 'Baixar .md', en: 'Download .md' },
  transcriptDownloadTxt: { pt: 'Baixar .txt', en: 'Download .txt' },
  notes: { pt: 'Notas', en: 'Notes' },
  minutes: { pt: 'Ata da reunião', en: 'Meeting minutes' },
  minutesPending: { pt: 'Gerando a ata…', en: 'Generating minutes…' },
  minutesRunning: {
    pt: 'Gerando a ata… A página se atualiza sozinha.',
    en: 'Generating minutes… The page refreshes itself.',
  },
  minutesError: { pt: 'Não consegui gerar a ata: ', en: 'Could not generate minutes: ' },
  mSummary: { pt: 'Resumo', en: 'Summary' },
  mDecisions: { pt: 'Decisões', en: 'Decisions' },
  mActions: { pt: 'Itens de ação', en: 'Action items' },
  mTopics: { pt: 'Tópicos', en: 'Topics' },
  mOwner: { pt: 'resp.', en: 'owner' },
  mDue: { pt: 'prazo', en: 'due' },
  mPerPerson: { pt: 'Por participante', en: 'By participant' },
  minutesDownload: { pt: 'Baixar ata .md', en: 'Download minutes .md' },
  listen: { pt: 'Ouvir a gravação', en: 'Listen to the recording' },
  seekHint: {
    pt: 'Clique num horário para pular pra aquele momento.',
    en: 'Click a timestamp to jump to that moment.',
  },
  demoBanner: {
    pt: '<b>Demo pública com dados fictícios.</b> Veja o que o bot entrega depois de uma call. Gravações reais também incluem áudio completo, downloads e horários clicáveis, tudo protegido por login.',
    en: '<b>Public demo with fictional data.</b> See what the bot delivers after a call. Real recordings also include full audio, downloads, and clickable timestamps, all behind login.',
  },
  sampleAudio: { pt: 'Áudio de amostra', en: 'Sample audio' },
  sampleNote: {
    pt: 'Trecho curto e fictício, só pra dar o tom. Numa gravação real o áudio tem a duração completa e os horários acima são clicáveis.',
    en: 'A short, fictional excerpt just to set the tone. On a real recording the audio is full-length and the timestamps are clickable.',
  },
  cooking: {
    pt: 'O player usa um mix pré-processado; os downloads são gerados na hora (gravações longas podem levar alguns segundos).',
    en: 'The player uses a pre-processed mix; downloads are generated on demand (long recordings may take a few seconds).',
  },
  livenote: {
    pt: 'Gravação em andamento. Os downloads trazem o áudio <strong>até este momento</strong>. Esta página se atualiza sozinha a cada 30 segundos.',
    en: 'Recording in progress. Downloads contain the audio <strong>up to this moment</strong>. This page refreshes itself every 30 seconds.',
  },
  timeline: { pt: 'Linha do tempo', en: 'Timeline' },
  del: { pt: 'Apagar gravação', en: 'Delete recording' },
  delconfirm: {
    pt: 'Apagar esta gravação para sempre? Não tem volta.',
    en: 'Delete this recording forever? There is no undo.',
  },
  expires: { pt: 'Esta gravação expira em {date}.', en: 'This recording expires on {date}.' },
  presentAlso: { pt: 'Também estavam na call (sem falar)', en: 'Also in the call (did not speak)' },
  transcriptPartial: {
    pt: 'Transcrição parcial. Ainda faltam: {names}. Vou tentar de novo sozinho por causa do limite do provedor.',
    en: 'Partial transcript. Still missing: {names}. I will retry automatically because of the provider limit.',
  },
  transcriptPartialFinal: {
    pt: 'Transcrição parcial. Estas faixas não puderam ser transcritas: {names}.',
    en: 'Partial transcript. These tracks could not be transcribed: {names}.',
  },
  transcriptRetrying: {
    pt: 'O serviço de IA limitou o uso agora há pouco. Vou tentar de novo sozinho em alguns minutos.',
    en: 'The AI service rate-limited us just now. I will retry automatically in a few minutes.',
  },
  presentAlsoLive: { pt: 'Na call agora (ainda sem falar)', en: 'In the call now (no speech yet)' },
  presentOnly: { pt: 'Estavam na call, mas ninguém falou', en: 'Were in the call, but nobody spoke' },
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
    pt: 'O áudio desta gravação foi liberado (expirou ou alguém liberou o espaço). A transcrição, a ata e as notas continuam aqui.',
    en: 'The audio of this recording was released (it expired or someone freed the space). Transcript, minutes and notes remain here.',
  },
  audioIncomplete: {
    pt: 'Pelo menos uma faixa não fechou limpa. O áudio disponível foi preservado, mas pode estar parcial.',
    en: 'At least one track did not close cleanly. Available audio was preserved, but it may be partial.',
  },
  textExpires: {
    pt: 'Transcrição e ata expiram em {date}. O áudio já expirou.',
    en: 'Transcript and minutes expire on {date}. The audio has already expired.',
  },
  keptForever: { pt: 'Guardada até alguém apagar', en: 'Kept until someone deletes it' },
  textKeptForever: {
    pt: 'Transcrição, ata e notas ficam até alguém apagar (o áudio já foi liberado)',
    en: 'Transcript, minutes and notes stay until someone deletes them (audio already released)',
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
  ixFreeSpace: { pt: 'Liberar áudio', en: 'Release audio' },
  ixFreeSpaceConfirm: {
    pt: 'Apagar SÓ o áudio desta gravação (faixas e mix)? Transcrição, ata e notas ficam. Não tem volta.',
    en: 'Delete ONLY the audio of this recording (tracks and mix)? Transcript, minutes and notes stay. No undo.',
  },
  ixDelete: { pt: 'Apagar tudo', en: 'Delete all' },
  ixAudioFreed: { pt: 'áudio liberado', en: 'audio released' },
  ixByAuto: { pt: 'auto-record', en: 'auto-record' },
  ixLive: { pt: 'ao vivo', en: 'live' },
  // app shell v2 (cockpit)
  dlFold: { pt: 'Baixar áudio', en: 'Download audio' },
  dlShort: { pt: 'Baixar', en: 'Download' },
  freeWhy: {
    pt: 'apaga só o áudio. Transcrição, ata e notas ficam',
    en: 'deletes only the audio. Transcript, minutes and notes stay',
  },
  delWhy: {
    pt: 'apaga áudio, transcrição, ata e notas. Não tem volta',
    en: 'deletes audio, transcript, minutes and notes. There is no undo',
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
// timestamps, IDs, código, caminhos e JSON - nunca em prosa. Self-contained
// (CSP: sem fonte/CSS/JS/imagem externa); respeita prefers-reduced-motion.
const APP_CSS = `
  @font-face {
    font-family: 'Space Grotesk';
    src: url('/assets/space-grotesk.woff2') format('woff2');
    font-style: normal;
    font-weight: 300 700;
    font-display: swap;
  }
  :root {
    color-scheme: dark;
    --bg: #202024;
    --surface: #28282c;
    --surface-2: #303036;
    --surface-3: #36373e;
    --text: #d0d1d5;
    --text-strong: #e1e1e5;
    --text-weak: #a1a1a5;
    --text-dim: #727377;
    --border: #36373e;
    --border-strong: #525357;
    --accent: #5865f2;
    --accent-hover: #4752c4;
    --accent-soft: rgba(88, 101, 242, .14);
    --accent-ink: #ffffff;
    --warn: #f1c75b;
    --danger: #ff8179;
    --danger-soft: rgba(255, 129, 121, .12);
    --live: #ff8179;
    --done: #798df9;
    --ok: #798df9;
    --link: #798df9;
    --c0: #798df9;
    --c1: #79d9c5;
    --c2: #f1c75b;
    --c3: #ef92c9;
    --c4: #85bdf4;
    --c5: #f39b72;
    --c6: #b9a0f5;
    --c7: #9ed68d;
    --sans: 'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --mono: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
    --col: 780px;
    --shell: 1180px;
    --radius-surface: 20px;
    --radius-control: 10px;
    --shadow: 0 28px 90px rgba(12, 13, 17, .34);
  }
  html[data-theme='light'] { color-scheme: light; }
  html[data-theme='light'] body {
    --bg: #ffffff;
    --surface: #ffffff;
    --surface-2: #f5f5fa;
    --surface-3: #f0f1f5;
    --text: #414145;
    --text-strong: #19191e;
    --text-weak: #525357;
    --text-dim: #727377;
    --border: #e1e1e5;
    --border-strong: #d0d1d5;
    --accent-soft: rgba(88, 101, 242, .12);
    --accent-ink: #ffffff;
    --danger: #a92d2a;
    --danger-soft: rgba(169, 45, 42, .08);
    --live: #a92d2a;
    --done: #4752c4;
    --ok: #4752c4;
    --link: #4752c4;
    --c0: #4752c4;
    --c1: #0d7465;
    --c2: #7b5800;
    --c3: #a03878;
    --c4: #245d91;
    --c5: #98442a;
    --c6: #6247a5;
    --c7: #3d7133;
    --shadow: 0 24px 70px rgba(25, 25, 30, .13);
  }
  * { box-sizing: border-box; margin: 0; }
  [hidden] { display: none !important; }
  html { background: var(--bg); }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.58;
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 20px 24px 44px;
    transition: background-color 180ms ease, color 180ms ease;
  }
  body.wide .app-main, body.wide .topbar, body.wide .topfoot { max-width: var(--shell); }
  a { color: inherit; }
  img { max-width: 100%; height: auto; }
  button, input { font: inherit; }
  button { color: inherit; }
  time, .ts, code, pre { font-family: var(--mono); }
  pre { overflow-x: auto; }
  .skip {
    position: fixed;
    z-index: 100;
    top: 10px;
    left: 12px;
    transform: translateY(-160%);
    background: var(--accent);
    color: var(--accent-ink);
    padding: 10px 14px;
    border-radius: var(--radius-control);
    font-weight: 700;
    text-decoration: none;
  }
  .skip:focus { transform: translateY(0); }
  a:focus-visible, button:focus-visible, summary:focus-visible, input:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 3px;
  }
  .app-main { max-width: var(--col); width: 100%; }
  .card {
    width: 100%;
    padding: clamp(22px, 4vw, 38px);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-surface);
    box-shadow: var(--shadow);
    overflow-wrap: anywhere;
  }
  h1 {
    color: var(--text-strong);
    font-size: clamp(1.7rem, 3vw, 2.45rem);
    line-height: 1.06;
    letter-spacing: -.045em;
    font-weight: 650;
  }
  h2 {
    color: var(--text-strong);
    font-size: 1rem;
    line-height: 1.3;
    margin: 28px 0 12px;
    font-weight: 650;
  }
  .muted { color: var(--text-weak); font-size: 14px; }
  .subline { color: var(--text-weak); font-size: 14px; margin-top: 10px; max-width: 72ch; }
  .grid { display: grid; grid-template-columns: minmax(110px, auto) 1fr; gap: 8px 18px; margin-top: 18px; }
  .grid dt { color: var(--text-weak); }
  h2[id], h3[id], details[id] { scroll-margin-top: 170px; }

  .topbar {
    max-width: var(--col);
    width: 100%;
    min-height: 64px;
    display: flex;
    align-items: center;
    flex-wrap: nowrap;
    gap: 22px;
    margin-bottom: 14px;
    padding: 10px 14px 10px 18px;
    color: var(--text-weak);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow: 0 12px 42px rgba(2, 8, 2, .16);
    overflow-wrap: anywhere;
  }
  .topbar .brand {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--text-strong);
    font-size: 17px;
    line-height: 1;
    font-weight: 700;
    letter-spacing: -.035em;
    text-decoration: none;
  }
  .topbar .brand img {
    width: 26px;
    height: 26px;
    display: block;
    flex: 0 0 26px;
    border-radius: 7px;
  }
  .topbar .apptag {
    flex: none;
    color: var(--accent-ink);
    background: var(--accent);
    border-radius: 6px;
    padding: 3px 7px;
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: .04em;
    text-transform: uppercase;
  }
  .topbar nav { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .topbar nav a {
    color: var(--text-weak);
    text-decoration: none;
    padding: 8px 10px;
    border-radius: var(--radius-control);
    font-size: 13px;
    font-weight: 600;
  }
  .topbar nav a:hover { color: var(--text-strong); background: var(--surface-2); }
  .topbar nav a[aria-current='page'] { color: var(--accent-ink); background: var(--accent); }
  .topnav-r {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: nowrap;
    gap: 10px;
    white-space: nowrap;
  }
  .topbar .tl {
    min-height: 38px;
    display: inline-flex;
    align-items: center;
    color: var(--text);
    text-decoration: none;
    padding: 7px 9px;
    border-radius: var(--radius-control);
  }
  .topbar .tl:hover { color: var(--text-strong); background: var(--surface-2); }
  .logout-form { display: inline-flex; margin: 0; }
  .logout-form .tl { border: 0; background: transparent; cursor: pointer; }
  .topbar .user { display: inline-flex; align-items: center; gap: 7px; color: var(--text-strong); font-size: 13px; }
  .topbar img, .user-initial { width: 26px; height: 26px; border-radius: 50%; }
  .user-initial {
    display: inline-grid;
    place-items: center;
    background: var(--surface-3);
    border: 1px solid var(--border-strong);
    color: var(--text-strong);
    font-size: 11px;
    font-weight: 700;
  }
  .thm {
    min-width: 72px;
    min-height: 38px;
    padding: 7px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--surface-2);
    color: var(--text);
    cursor: pointer;
    font-size: 12px;
    font-weight: 650;
  }
  .thm:hover { border-color: var(--border-strong); color: var(--text-strong); }
  .thm .to-dark { display: none; }
  html[data-theme='light'] .thm .to-dark { display: inline; }
  html[data-theme='light'] .thm .to-light { display: none; }
  .langtoggle { display: inline-flex; align-items: center; border: 1px solid var(--border); border-radius: var(--radius-control); padding: 2px; }
  .langtoggle a {
    color: var(--text-weak);
    text-decoration: none;
    min-width: 34px;
    min-height: 32px;
    display: inline-grid;
    place-items: center;
    border-radius: 7px;
    font-size: 11px;
    font-weight: 700;
  }
  .langtoggle a.on { color: var(--accent-ink); background: var(--accent); }
  .topfoot {
    max-width: var(--col);
    width: 100%;
    margin-top: 24px;
    padding: 14px 4px 0;
    color: var(--text-dim);
    font-size: 12px;
    text-align: center;
    overflow-wrap: anywhere;
  }
  .topfoot a { color: var(--text-weak); text-decoration: none; }

  .btn {
    min-height: 44px;
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 2px;
    padding: 10px 16px;
    border: 1px solid var(--accent);
    border-radius: var(--radius-control);
    background: var(--accent);
    color: var(--accent-ink);
    text-decoration: none;
    font-size: 14px;
    line-height: 1.2;
    font-weight: 700;
    cursor: pointer;
    transition: transform 140ms ease, background-color 140ms ease, border-color 140ms ease;
  }
  .btn:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  .btn:active { transform: translateY(1px) scale(.99); }
  .btn small { color: inherit; font-size: 11px; font-weight: 500; opacity: .78; }
  .btn.secondary { background: var(--surface-2); border-color: var(--border); color: var(--text-strong); }
  .btn.secondary:hover { background: var(--surface-3); border-color: var(--border-strong); }
  .downloads { display: flex; flex-wrap: wrap; gap: 10px; }

  .badge, .wb {
    display: inline-flex;
    align-items: center;
    width: max-content;
    padding: 4px 9px;
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 11px;
    line-height: 1.2;
    font-weight: 700;
  }
  .badge.live, .wb.live { color: var(--live); border-color: currentColor; background: transparent; }
  .badge.done, .wb.ok { color: var(--done); border-color: currentColor; background: transparent; }
  .wb.warn { color: var(--warn); border-color: currentColor; }
  .note, .tstate {
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-left: 4px solid var(--warn);
    border-radius: var(--radius-control);
    background: var(--surface-2);
    color: var(--text);
    font-size: 14px;
    margin-top: 14px;
  }

  .people { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
  .person {
    min-height: 38px;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 5px 11px 5px 5px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface-2);
    font-size: 13px;
  }
  .person img, .person-initial { width: 27px; height: 27px; border-radius: 50%; }
  .person-initial { display: inline-grid; place-items: center; background: var(--surface-3); font-size: 11px; font-weight: 700; }
  .recording-head { padding-bottom: 20px; border-bottom: 1px solid var(--border); }
  .recording-titleline { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .recording-layout { display: grid; grid-template-columns: 184px minmax(0, 1fr); gap: 26px; margin-top: 24px; align-items: start; }
  .recording-layout.solo { grid-template-columns: minmax(0, 1fr); }
  .recording-rail { position: sticky; top: 18px; align-self: start; min-width: 0; }
  .recording-stage { min-width: 0; }
  .player-sticky { position: sticky; top: 14px; z-index: 6; margin-bottom: 18px; }
  .playerwrap {
    padding: 14px;
    border: 1px solid var(--border-strong);
    border-radius: 16px;
    background: var(--surface-2);
    box-shadow: 0 14px 36px rgba(2, 8, 2, .2);
  }
  .playerwrap audio, .player audio { width: 100%; display: block; }
  .pctl { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 10px; color: var(--text-weak); font-size: 12px; }
  .speed { display: inline-flex; gap: 5px; }
  .speed button {
    min-width: 44px;
    min-height: 36px;
    padding: 6px 9px;
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    font-family: var(--mono);
    font-size: 11px;
  }
  .speed button.on, .speed button[aria-pressed='true'] { color: var(--accent-ink); background: var(--accent); border-color: var(--accent); }
  .follow { min-height: 36px; display: inline-flex; align-items: center; gap: 7px; cursor: pointer; }
  .follow input { accent-color: var(--accent); width: 17px; height: 17px; }
  .tabbar { display: flex; flex-direction: column; gap: 5px; }
  .tabbar button {
    width: 100%;
    min-height: 44px;
    padding: 10px 12px;
    border: 1px solid transparent;
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--text-weak);
    text-align: left;
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
  }
  .tabbar button:hover { color: var(--text-strong); background: var(--surface-2); border-color: var(--border); }
  .tabbar button[aria-selected='true'] { color: var(--accent-ink); background: var(--accent); border-color: var(--accent); }
  .tpanel[hidden] { display: none; }
  .tpanel > h2:first-child { margin-top: 0; }
  .ktabs .tpanel > h2:first-child { display: none; }
  .ktabs .tpanel { padding-top: 2px; }

  .minutes, .transcript {
    border: 1px solid var(--border);
    border-radius: 18px;
    background: var(--surface-2);
    padding: clamp(16px, 3vw, 24px);
  }
  .minutes { font-size: 14.5px; }
  .minutes h3 { color: var(--text-strong); font-size: 14px; margin: 22px 0 8px; font-weight: 700; }
  .minutes h3:first-child { margin-top: 0; }
  .minutes ul { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 8px; }
  .minutes .lead { color: var(--text-strong); font-size: 17px; line-height: 1.62; }
  .minutes .action { display: flex; gap: 9px; align-items: baseline; }
  .action-mark {
    width: 14px;
    height: 14px;
    flex: none;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    transform: translateY(2px);
  }
  .minutes .meta2 { color: var(--text-weak); font-size: 12px; }
  .minutes .who { color: var(--text-strong); font-weight: 700; margin: 14px 0 5px; }
  .transcript { display: flex; flex-direction: column; gap: 20px; font-size: 15px; }
  .tblock .thead { display: flex; align-items: center; gap: 9px; margin-bottom: 6px; }
  .tblock .thead img, .speaker-initial { width: 28px; height: 28px; border-radius: 50%; }
  .speaker-initial { display: inline-grid; place-items: center; background: var(--surface-3); font-size: 11px; font-weight: 700; }
  .transcript .who { color: var(--text-strong); font-weight: 700; }
  .transcript p { line-height: 1.68; padding: 5px 8px; border-left: 3px solid transparent; border-radius: 7px; }
  .transcript p.now { background: var(--accent-soft); border-left-color: var(--accent); }
  .transcript time { color: var(--text-weak); font-size: 11px; }
  .c0 { color: var(--c0); } .c1 { color: var(--c1); } .c2 { color: var(--c2); } .c3 { color: var(--c3); }
  .c4 { color: var(--c4); } .c5 { color: var(--c5); } .c6 { color: var(--c6); } .c7 { color: var(--c7); }
  .tsearch { display: flex; flex-direction: column; gap: 9px; margin: 4px 0 14px; }
  .field-label { color: var(--text-strong); font-size: 13px; font-weight: 650; }
  .tsearch input, .isearch input, .genform input {
    width: 100%;
    min-height: 46px;
    padding: 10px 13px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-control);
    background: var(--surface-2);
    color: var(--text-strong);
  }
  .tsearch input::placeholder, .isearch input::placeholder, .genform input::placeholder { color: var(--text-dim); opacity: 1; }
  .fchips { display: flex; flex-wrap: wrap; gap: 7px; }
  .fchip {
    min-height: 38px;
    padding: 7px 11px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text);
    cursor: pointer;
    font-size: 12px;
    font-weight: 650;
  }
  .fchip:hover { border-color: var(--border-strong); color: var(--text-strong); }
  .fchip.off, .fchip[aria-pressed='false'] { opacity: .58; text-decoration: line-through; }
  .copybtn {
    min-height: 36px;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--surface-3);
    color: var(--text);
    cursor: pointer;
    font-size: 11px;
    vertical-align: middle;
    margin-left: 6px;
  }
  .copybtn:hover { color: var(--text-strong); border-color: var(--border-strong); }
  .ts { color: var(--link); font-size: 11px; margin-right: 8px; text-decoration: none; cursor: pointer; }
  .ts:hover { text-decoration: underline; }
  .tdl { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 13px; }
  .tdl a { color: var(--link); font-size: 13px; text-underline-offset: 3px; }
  .notes, .events { list-style: none; display: flex; flex-direction: column; gap: 8px; font-size: 14px; }
  .events { max-height: 280px; overflow-y: auto; }
  .notes time, .events time { color: var(--text-weak); margin-right: 8px; }
  .wall { color: var(--text-dim) !important; font-size: 11px; }
  .evlist summary { min-height: 40px; display: flex; align-items: center; cursor: pointer; color: var(--text-weak); font-size: 13px; }
  details.tech { margin-top: 10px; color: var(--text-weak); font-size: 12px; }
  details.tech summary { min-height: 38px; display: flex; align-items: center; cursor: pointer; }
  details.tech code { display: block; margin-top: 6px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-control); background: var(--surface-2); overflow-wrap: anywhere; }

  .tl2 { margin: 8px 0 16px; }
  .tl-ch { position: relative; height: 30px; }
  .tl-seg { position: absolute; top: 0; height: 26px; display: flex; align-items: center; overflow: hidden; padding: 0 6px; border: 1px solid rgba(88, 101, 242, .3); border-radius: 6px; background: var(--accent-soft); text-decoration: none; }
  .tl-seg.s1 { background: rgba(88, 101, 242, .07); }
  .tl-seg:hover { background: rgba(88, 101, 242, .22); }
  .tl-seg span { width: 100%; color: var(--text-strong); text-align: center; overflow: hidden; font: 10px var(--mono); }
  .tl-chlist { list-style: none; margin-top: 14px; display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 6px 14px; }
  .tl-chlist a, .tl-static { min-height: 38px; display: flex; align-items: center; gap: 8px; padding: 5px 7px; border-radius: 8px; color: var(--text); text-decoration: none; font-size: 13px; }
  .tl-chlist a:hover { background: var(--accent-soft); color: var(--text-strong); }
  .tl-chlist b, .tl-chlist time { color: var(--text-weak); flex: none; font: 11px var(--mono); }
  .tl-chlist span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tl-ticks { position: relative; height: 18px; margin-top: 3px; }
  .tl-tk { position: absolute; top: 2px; width: 7px; height: 14px; border-radius: 3px; transform: translateX(-50%); background: var(--text-dim); }
  .tl-tk.tnote { background: var(--warn); }
  .tl-tk.join { background: var(--ok); }
  .tl-tk.leave { background: var(--text-dim); }
  .tl-ax { display: flex; justify-content: space-between; padding-top: 5px; margin-top: 4px; border-top: 1px solid var(--border); color: var(--text-dim); font: 10px var(--mono); }
  .tl-lg { display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; margin-top: 8px; color: var(--text-weak); font-size: 11px; }
  .tl-lg i { display: inline-block; width: 9px; height: 9px; margin-right: 5px; border-radius: 3px; vertical-align: -1px; }
  .tl-lg .lg-ch { background: var(--accent); } .tl-lg .lg-note { background: var(--warn); }
  .tl-lg .lg-join { background: var(--ok); } .tl-lg .lg-leave { background: var(--text-dim); }
  .tl-lg .lg-hint { margin-left: auto; color: var(--text-dim); }

  .index-head { display: grid; gap: 8px; }
  .isearch { display: grid; grid-template-columns: 1fr auto; gap: 8px; margin: 24px 0 0; }
  .isearch .field-label { grid-column: 1 / -1; }
  .isearch .btn { align-items: center; flex-direction: row; padding-inline: 20px; }
  .rstats { display: flex; flex-wrap: wrap; gap: 7px 18px; margin-top: 18px; color: var(--text-weak); font-size: 13px; }
  .rstats strong { color: var(--text-strong); }
  .rsorts { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-top: 12px; color: var(--text-weak); font-size: 12px; }
  .rsorts a, .rsorts .sorton { min-height: 34px; display: inline-flex; align-items: center; padding: 5px 10px; border: 1px solid var(--border); border-radius: 999px; text-decoration: none; }
  .rsorts a:hover { color: var(--text-strong); border-color: var(--border-strong); }
  .rsorts .sorton { color: var(--accent-ink); border-color: var(--accent); background: var(--accent); font-weight: 700; }
  .filterblock { display: grid; gap: 8px; margin-top: 16px; }
  .filterlabel { color: var(--text-weak); font-size: 12px; font-weight: 650; }
  .recording-groups { display: grid; gap: 28px; margin-top: 28px; }
  .recording-group { display: grid; gap: 10px; }
  .dayh { color: var(--text-weak); font-size: 13px; font-weight: 650; }
  .recording-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 12px; }
  .recording-card {
    min-width: 0;
    display: grid;
    grid-template-rows: 1fr auto;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: var(--surface-2);
    overflow: hidden;
    transition: transform 160ms ease, border-color 160ms ease, background-color 160ms ease;
  }
  .recording-card:hover { transform: translateY(-2px); border-color: var(--border-strong); background: var(--surface-3); }
  .recording-card-main { display: grid; gap: 14px; padding: 17px; color: inherit; text-decoration: none; }
  .recording-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
  .recording-channel { min-width: 0; color: var(--text-strong); font-size: 17px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .recording-card-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 9px 14px; color: var(--text-weak); font-size: 12px; }
  .recording-card-meta small { display: block; color: var(--text-dim); font-size: 10px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; }
  .recording-card-meta strong { display: block; color: var(--text-strong); font-size: 13px; font-weight: 600; }
  .recording-card-detail { color: var(--text-weak); font-size: 12px; }
  .recording-card-actions { display: flex; flex-wrap: wrap; gap: 7px; padding: 12px 17px; border-top: 1px solid var(--border); }
  .recording-card-actions form { margin: 0; }
  .rbtn, button.softdanger, button.danger {
    min-height: 38px;
    padding: 7px 11px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--text);
    cursor: pointer;
    font-size: 12px;
    font-weight: 650;
  }
  .rbtn:hover, button.softdanger:hover { color: var(--text-strong); background: var(--surface-3); }
  .rbtn.danger, button.danger { color: var(--danger); border-color: var(--danger); }
  .rbtn.danger:hover, button.danger:hover { background: var(--danger-soft); }
  .hits { list-style: none; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
  .hits li { padding: 14px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface-2); font-size: 13px; }
  .hits a { color: var(--link); text-underline-offset: 3px; }
  .hit-kind { display: block; color: var(--text-dim); font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
  .hit-date { display: block; color: var(--text-weak); margin: 3px 0 7px; font-size: 11px; }
  .empty-state { display: grid; gap: 10px; place-items: start; padding: 24px; margin-top: 22px; border: 1px dashed var(--border-strong); border-radius: 16px; background: var(--surface-2); }
  .empty-state strong { color: var(--text-strong); font-size: 17px; }
  .empty-state.compact { padding: 17px; }

  .dangerzone { display: flex; flex-direction: column; gap: 14px; padding: 18px; border: 1px solid rgba(255, 129, 121, .35); border-radius: 16px; background: var(--danger-soft); }
  .dangerzone form { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 0; }
  .dangerzone .why { color: var(--text-weak); font-size: 12px; }
  .player { margin: 16px 0 4px; }
  .player .hint { color: var(--text-weak); font-size: 12px; margin-top: 7px; }
  .recording-foot { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 18px; padding-top: 18px; border-top: 1px solid var(--border); }
  footer { margin-top: 26px; color: var(--text-weak); font-size: 12px; }

  .genform { display: grid; grid-template-columns: 1fr auto; gap: 8px; margin-top: 18px; }
  .genform .field-label { grid-column: 1 / -1; }
  .tokenbox { margin-top: 12px; padding: 16px; border: 1px solid var(--border); border-radius: 14px; background: #0c0e0b; color: #edf3e4; font-size: 12px; white-space: pre; }
  .connect-intro { max-width: 72ch; margin-top: 12px; color: var(--text-weak); }
  .security-note { display: grid; gap: 4px; margin-top: 14px; padding: 14px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface-2); font-size: 13px; }
  .security-note strong { color: var(--text-strong); }
  .connection-list { display: grid; gap: 10px; margin-top: 12px; }
  .connection-card { display: grid; grid-template-columns: minmax(170px, 1.4fr) repeat(3, minmax(105px, 1fr)) auto; gap: 14px; align-items: center; padding: 15px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface-2); }
  .connection-name { min-width: 0; }
  .connection-name strong { display: block; color: var(--text-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .connection-card small { display: block; color: var(--text-dim); font-size: 10px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; }
  .connection-card code { color: var(--text-weak); font-size: 11px; }
  .connection-card form { margin: 0; }
  .connect-steps { margin: 12px 0 0 20px; color: var(--text-weak); font-size: 13px; }
  .connect-steps li + li { margin-top: 6px; }

  @keyframes enter {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: no-preference) {
    html { scroll-behavior: smooth; }
    .card { animation: enter 360ms cubic-bezier(.2, .8, .2, 1) both; }
    .recording-card { animation: enter 320ms cubic-bezier(.2, .8, .2, 1) both; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; transition-duration: .01ms !important; }
  }
  @media (max-width: 920px) {
    body { padding-inline: 16px; }
    .topbar { gap: 10px; }
    .topbar .user-name { display: none; }
    .recording-grid, .hits { grid-template-columns: 1fr; }
    .connection-card { grid-template-columns: 1fr 1fr; }
    .connection-name { grid-column: 1 / -1; }
  }
  @media (max-width: 760px) {
    body { padding: 12px 10px 32px; }
    .topbar { display: grid; grid-template-columns: auto auto 1fr; min-height: 0; padding: 10px; border-radius: 14px; }
    .topbar nav { grid-column: 1 / -1; grid-row: 2; overflow-x: auto; border-top: 1px solid var(--border); padding-top: 8px; }
    .topnav-r { justify-self: end; gap: 6px; }
    .topbar .user { display: none; }
    .topbar .tl { min-height: 36px; }
    .thm { min-width: 62px; }
    .card { padding: 20px 14px; border-radius: 16px; }
    .recording-layout { display: block; margin-top: 20px; }
    .recording-rail { position: sticky; top: 0; z-index: 8; margin: 0 -14px 12px; padding: 8px 14px; background: var(--surface); border-bottom: 1px solid var(--border); }
    .tabbar { flex-direction: row; gap: 6px; overflow-x: auto; scrollbar-width: thin; }
    .tabbar button { width: auto; flex: none; text-align: center; }
    .player-sticky { top: 60px; }
    .recording-card-meta { grid-template-columns: 1fr; }
    .isearch, .genform { grid-template-columns: 1fr; }
    .isearch .btn, .genform .btn { width: 100%; align-items: center; }
    .grid { grid-template-columns: 1fr; gap: 2px; }
    .downloads .btn { flex: 1 1 170px; align-items: center; text-align: center; }
    .tl-lg .lg-hint { width: 100%; margin-left: 0; }
  }
  @media (max-width: 440px) {
    .topbar { grid-template-columns: auto 1fr; }
    .topbar .apptag { display: none; }
    .topnav-r { max-width: 100%; }
    .thm { display: none; }
    h1 { font-size: 1.65rem; }
    .recording-card-head { display: grid; }
    .recording-card-actions { display: grid; grid-template-columns: 1fr; }
    .recording-card-actions button { width: 100%; }
    .pctl { align-items: flex-start; flex-direction: column; }
    .transcript { padding: 14px 10px; font-size: 15px; }
    .connection-card { grid-template-columns: 1fr; }
    .connection-name { grid-column: auto; }
    .connection-card form, .connection-card button { width: 100%; }
  }
`;

/**
 * Data localizada: renderiza no fuso do SERVIDOR como fallback (config.timezone,
 * default America/Sao_Paulo) e marca o epoch para o script no navegador reescrever
 * no fuso de quem abre a página - como o Discord faz.
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
    el.textContent = new Date(+el.dataset.ts).toLocaleString(document.documentElement.lang || navigator.language, opts);
  } catch(e){}
});
// pular pro momento no player de áudio; sem player (ex.: áudio expirado),
// rola até o trecho correspondente da transcrição - o deep link continua útil
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

// Tema aplicado antes da pintura. Usa a preferência salva ou a do sistema.
const THEME_INIT = `<script>(function(){try{var t=localStorage.getItem('ktheme');if(t!=='light'&&t!=='dark')t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';document.documentElement.dataset.theme=t;}catch(e){}})();</script>`;
const THEME_TOGGLE_SCRIPT = `<script>(function(){var b=document.querySelector('.thm');if(!b)return;var d=document.documentElement;function sync(){var light=d.dataset.theme==='light';b.setAttribute('aria-pressed',String(light));b.setAttribute('aria-label',light?b.dataset.toDark:b.dataset.toLight);}sync();b.addEventListener('click',function(){var t=d.dataset.theme==='light'?'dark':'light';d.dataset.theme=t;try{localStorage.setItem('ktheme',t);}catch(e){}sync();});})();</script>`;
const APP_LOCALE_LINKS_SCRIPT = `<script>(function(){document.querySelectorAll('[data-app-locale]').forEach(function(a){try{var u=new URL(location.href);u.searchParams.set('lang',a.dataset.appLocale);a.href=u.pathname+u.search+u.hash;}catch(e){}});})();</script>`;

function shell(
  title: string,
  body: string,
  opts: {
    user?: WebUser;
    lang?: Locale;
    refreshSeconds?: number;
    active?: 'rec' | 'ai';
    demo?: boolean;
    /** Páginas de trabalho usam a largura completa do shell. */
    wide?: boolean;
    /** Mostra "Conectar IA" na nav só na central e no próprio conectar
     *  (na página de uma gravação é ruído; feedback do Mauro). */
    navAi?: boolean;
  } = {},
): string {
  const lang = opts.lang === 'pt' ? 'pt' : 'en';
  const pt = lang === 'pt';
  const langToggle = opts.demo
    ? `<div class="langtoggle" aria-label="${pt ? 'Idioma' : 'Language'}"><a href="${publicPath('demo', 'en')}"${lang === 'en' ? ' class="on" aria-current="page"' : ''} lang="en">EN</a><a href="${publicPath('demo', 'pt')}"${lang === 'pt' ? ' class="on" aria-current="page"' : ''} lang="pt-BR">PT</a></div>`
    : `<div class="langtoggle" aria-label="${pt ? 'Idioma' : 'Language'}"><a href="?lang=en" data-app-locale="en"${lang === 'en' ? ' class="on" aria-current="page"' : ''}>EN</a><a href="?lang=pt" data-app-locale="pt"${lang === 'pt' ? ' class="on" aria-current="page"' : ''}>PT</a></div>`;
  // A demo é uma prova pública com dados fictícios. O app continua isolado sob
  // /app, com autenticação, ACL e navegação próprias.
  const brand = `<a class="brand" href="${opts.demo ? publicPath('home', lang) : '/app'}"><img src="/assets/kassinao-mark.png" width="26" height="26" alt=""><span>Kassinão</span></a>${opts.demo ? '' : '<span class="apptag">app</span>'}`;
  const nav = opts.demo
    ? `<nav aria-label="${pt ? 'Navegação principal' : 'Main navigation'}"><a href="${publicPath('docs', lang)}">Docs</a><a href="${PUBLIC_LINKS.mcp}" target="_blank" rel="noopener noreferrer">MCP</a><a href="${PUBLIC_LINKS.github}" target="_blank" rel="noopener noreferrer">GitHub</a></nav>`
    : opts.user
      ? `<nav aria-label="${pt ? 'Navegação do app' : 'App navigation'}"><a href="/app"${opts.active === 'rec' ? ' aria-current="page"' : ''}>${pt ? 'Gravações' : 'Recordings'}</a>${
          config.mcpEnabled && (opts.navAi || opts.active === 'ai')
            ? `<a href="/app/conectar-ia"${opts.active === 'ai' ? ' aria-current="page"' : ''}>${pt ? 'Conectar IA' : 'Connect AI'}</a>`
            : ''
        }</nav>`
      : '';
  const themeBtn = `<button type="button" class="thm" aria-pressed="false" data-to-light="${pt ? 'Mudar para tema claro' : 'Switch to light theme'}" data-to-dark="${pt ? 'Mudar para tema escuro' : 'Switch to dark theme'}"><span class="to-light">${pt ? 'Claro' : 'Light'}</span><span class="to-dark">${pt ? 'Escuro' : 'Dark'}</span></button>`;
  const signIn = `<a class="tl" href="/auth/login?next=%2Fapp">${pt ? 'Entrar' : 'Sign in'}</a>`;
  const right = opts.demo
    ? `${themeBtn}${langToggle}`
    : opts.user
      ? `${themeBtn}${langToggle}<span class="user">${opts.user.avatar ? `<img src="${esc(opts.user.avatar)}" alt="">` : `<span class="user-initial" aria-hidden="true">${esc(opts.user.name.slice(0, 1).toUpperCase())}</span>`}<span class="user-name">${esc(opts.user.name)}</span></span><form class="logout-form" method="post" action="/app/logout"><button class="tl" type="submit">${pt ? 'Sair' : 'Sign out'}</button></form>`
      : `${themeBtn}${langToggle}${signIn}`;
  const userbar = `<header class="topbar">${brand}${nav}<span class="topnav-r">${right}</span></header>`;
  const foot = opts.demo
    ? `<footer class="topfoot"><a href="${publicPath('home', lang)}">Kassinão</a>. <a href="${publicPath('docs', lang)}">Docs</a>. Open source. Self-hosted. AGPL-3.0.</footer>`
    : `<footer class="topfoot"><a href="${publicPath('docs', lang)}">Docs</a>. Kassinão. AGPL-3.0.</footer>`;
  const documentTitle = opts.demo
    ? pt
      ? 'Demo do Kassinão: de call no Discord a ata pronta'
      : 'Kassinão demo: from Discord call to meeting notes'
    : `${title} | Kassinão`;
  const demoDescription = pt
    ? 'Veja uma reunião fictícia processada pelo Kassinão, o bot de Discord que grava, transcreve e organiza calls.'
    : 'Explore a fictional meeting processed by Kassinão, the Discord bot that records, transcribes, and organizes calls.';
  const publicMeta = opts.demo
    ? `<meta name="description" content="${esc(demoDescription)}">
<meta property="og:title" content="${esc(documentTitle)}">
<meta property="og:description" content="${esc(demoDescription)}">
<meta property="og:image" content="${config.baseUrl}/og-${lang}.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Kassinão Discord bot">
<meta property="og:url" content="${config.baseUrl}${publicPath('demo', lang)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">`
    : '<meta name="robots" content="noindex">';
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
${publicMeta}
<title>${esc(documentTitle)}</title>
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png" sizes="180x180">
${THEME_INIT}
<style>${APP_CSS}</style>
</head>
<body${opts.wide ? ' class="wide"' : ''}>
<a class="skip" href="#conteudo">${pt ? 'Pular para o conteúdo' : 'Skip to content'}</a>
${userbar}
<main class="app-main" id="conteudo"><div class="card">${body}</div></main>
${foot}
${TZ_SCRIPT}
${THEME_TOGGLE_SCRIPT}
${opts.demo ? '' : APP_LOCALE_LINKS_SCRIPT}
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

  // Cabeçalho: contexto essencial sem competir com o conteúdo da reunião.
  const nPeople = meta.participants.length;
  const subline = `<p class="subline">${esc(meta.guildName)} <span aria-hidden="true">/</span> ${datetime(meta.startedAt, l)} <span aria-hidden="true">/</span> ${formatDuration(durMs)}${
    live ? p(l, 'counting') : ''
  }${nPeople > 0 ? ` <span aria-hidden="true">/</span> ${nPeople} ${nPeople === 1 ? (l === 'pt' ? 'participante' : 'participant') : l === 'pt' ? 'participantes' : 'participants'}` : ''}</p>`;

  const people =
    meta.participants.length > 0
      ? `<div class="people">${meta.participants
          .map(
            (pt, i) =>
              `<span class="person">${pt.avatar ? `<img src="${esc(pt.avatar)}" alt="">` : `<span class="person-initial c${i % SPEAKER_COLORS}" aria-hidden="true">${esc(pt.name.slice(0, 1).toUpperCase())}</span>`}<span class="who c${i % SPEAKER_COLORS}">${esc(pt.name)}</span></span>`,
          )
          .join('')}</div>`
      : `<p class="muted">${live ? p(l, 'nobody') : p(l, 'nobodyDone')}</p>`;

  // Quem esteve na call mas nunca falou (presença diferente de faixa).
  const spokeIds = new Set(meta.participants.map((pt) => pt.id));
  const silent = (meta.presence ?? []).filter((pr) => !spokeIds.has(pr.id));
  const silentLabel =
    meta.participants.length === 0 ? p(l, 'presentOnly') : live ? p(l, 'presentAlsoLive') : p(l, 'presentAlso');
  const presentAlso =
    silent.length > 0
      ? `<p class="muted" style="margin-top:8px">${silentLabel}: ${silent.map((pr) => esc(pr.name)).join(', ')}</p>`
      : '';

  // O player real fica estável no workspace. Demo e áudio expirado ficam no fluxo.
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
             <button type="button" data-r="1" class="on" aria-pressed="true" aria-label="${l === 'pt' ? 'Velocidade normal' : 'Normal speed'}">1x</button>
             <button type="button" data-r="1.5" aria-pressed="false" aria-label="${l === 'pt' ? 'Velocidade uma vez e meia' : 'One and a half speed'}">1.5x</button>
             <button type="button" data-r="2" aria-pressed="false" aria-label="${l === 'pt' ? 'Velocidade dupla' : 'Double speed'}">2x</button>
           </span>
           <label class="follow"><input type="checkbox" id="kfollow"> ${p(l, 'follow')}</label>
           <span class="hint">${p(l, 'seekHint')}</span>
         </div>
       </div>`;
  }

  const liveNote = live ? `<div class="note" role="status" aria-live="polite">${p(l, 'livenote')}</div>` : '';
  const demoNote = demo ? `<div class="note">${p(l, 'demoBanner')}</div>` : '';
  const incompleteNote =
    !demo && meta.audioIncomplete
      ? `<div class="note" style="border-left-color:#f0b232">${p(l, 'audioIncomplete')}</div>`
      : '';

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

  // Linha do tempo: barra visual clicável e lista dobrável.
  const events = renderTimeline(meta, opts.minutes, l, durMs, live, seekable);

  // Exportação vive num painel próprio, fora do caminho da leitura.
  const downloads =
    !demo && !audioGone && meta.participants.length > 0
      ? `<h2>${p(l, 'dlFold')}</h2>
        <div class="downloads">
          <a class="btn secondary" href="/app/rec/${meta.id}/download/mp3">MP3 <small>${p(l, 'mp3sub')}</small></a>
          <a class="btn secondary" href="/app/rec/${meta.id}/download/flac">FLAC <small>${p(l, 'flacsub')}</small></a>
          <a class="btn secondary" href="/app/rec/${meta.id}/download/mix">Mix <small>${p(l, 'mixsub')}</small></a>
          <a class="btn secondary" href="/app/rec/${meta.id}/download/audacity">Audacity <small>${p(l, 'audacitysub')}</small></a>
        </div>
        <p class="muted" style="margin-top:10px">${p(l, 'cooking')}</p>`
      : '';

  // Gestão separada, com a consequência dita antes do clique. O
  // servidor revalida permissão/estado no POST (o confirm() não é a autoridade)
  const manage =
    opts.canDelete && !live && !demo
      ? `<div class="dangerzone">
        ${
          !audioGone && !transcriptionNeedsAudio(meta)
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

  // A configuração atual decide a mensagem de expiração.
  const audioExp = audioExpiryOf(meta);
  const textExp = textExpiryOf(meta);
  const footNote = live
    ? ''
    : audioGone
      ? textExp
        ? p(l, 'textExpires', { date: datetime(textExp, l) })
        : p(l, 'textKeptForever')
      : audioExp
        ? p(l, 'expires', { date: datetime(audioExp, l) })
        : p(l, 'keptForever');
  const pageFoot = !demo
    ? `<footer class="recording-foot">${footNote ? `<span>${footNote}</span>` : ''}<span>ID <code>${esc(meta.id)}</code></span></footer>`
    : '';

  // Demo é a vitrine: depois da prova, um CTA de conversão (fim do beco sem saída).
  const demoCta = demo
    ? `<div class="note" style="border-left-color:var(--accent);margin-top:28px">${
        l === 'pt'
          ? 'O bot transforma a call em transcrição com nomes, ata, decisões e tarefas. <strong>Rode o seu:</strong> é open source e fica na sua infraestrutura.'
          : 'The bot turns the call into a named transcript, meeting notes, decisions, and action items. <strong>Deploy your own:</strong> it is open source and runs on your infrastructure.'
      }</div>
     <div class="downloads" style="margin-top:14px">
       <a class="btn" href="${ghHref()}">${l === 'pt' ? 'Como instalar' : 'Setup guide'}</a>
       <a class="btn secondary" href="${publicPath('home', l)}">${l === 'pt' ? 'Voltar ao início' : 'Back home'}</a>
     </div>`
    : '';
  const title = `#${esc(meta.voiceChannelName)}`;

  // Uma seção por vez. Sem JS, os painéis continuam visíveis e empilhados.
  const panels: Array<[string, string, string]> = [];
  if (minutes) panels.push(['ata', p(l, 'minutes'), minutes]);
  if (transcription) panels.push(['transcricao', p(l, 'transcript'), transcription]);
  if (events) panels.push(['timeline', p(l, 'timeline'), events]);
  if (notes) panels.push(['notas', `${p(l, 'notes')} (${meta.notes.length})`, notes]);
  if (downloads) panels.push(['exportar', p(l, 'dlShort'), downloads]);
  if (manage) panels.push(['gerenciar', p(l, 'manage'), manage]);
  const hasTabs = panels.length >= 2;
  const tabbar = hasTabs
    ? `<div class="tabbar" role="tablist" aria-label="${l === 'pt' ? 'Seções da gravação' : 'Recording sections'}">${panels
        .map(
          ([id, label], i) =>
            `<button type="button" role="tab" id="tab-${id}" data-t="${id}" aria-controls="${id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${label}</button>`,
        )
        .join('')}</div>`
    : '';
  const panelHtml = panels
    .map(([id, , html]) =>
      hasTabs
        ? `<section class="tpanel" id="${id}" role="tabpanel" aria-labelledby="tab-${id}">${html}</section>`
        : `<section class="tpanel" id="${id}">${html}</section>`,
    )
    .join('\n     ');
  const workspace =
    panelHtml || playerDock
      ? `<div class="recording-layout${tabbar ? '' : ' solo'}">
          ${tabbar ? `<aside class="recording-rail" aria-label="${l === 'pt' ? 'Navegação da gravação' : 'Recording navigation'}">${tabbar}</aside>` : ''}
          <div class="recording-stage">
            ${playerDock ? `<div class="player-sticky">${playerDock}</div>` : ''}
            ${panelHtml}
          </div>
        </div>`
      : '';

  return shell(
    demo ? `#${meta.voiceChannelName} (demo)` : `#${meta.voiceChannelName} | ${p(l, 'recording')}`,
    `<header class="recording-head"><div class="recording-titleline"><h1>${title}</h1>${badge}</div>
     ${subline}
     ${demoNote}
     ${liveNote}
     ${incompleteNote}
     ${people}
     ${presentAlso}
     ${playerFlow}</header>
     ${workspace}
     ${pageFoot}
     ${demoCta}
     ${RECORDING_SCRIPT}`,
    {
      user: opts.user,
      lang: l,
      active: 'rec',
      demo,
      wide: true,
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
  const eventLabel = (text: string): string =>
    text.replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]+\s*/u, '');

  const list = `<details class="evlist"${live ? ' open' : ''}><summary>${p(l, 'timelineAll', { n: String(meta.events.length) })}</summary><ul class="events">${meta.events
    .map(
      (e) =>
        `<li><time>${formatOffset(e.atMs)}</time>${clockTime(meta.startedAt + e.atMs, l)}${esc(eventLabel(localizeEvent(e.text, l)))}</li>`,
    )
    .join('')}</ul></details>`;

  // Barra visual só com duração fechada. Desenho: CAPÍTULOS da ata como blocos
  // clicáveis (estilo YouTube) + notas/entra-sai como ticks discretos noutra
  // pista. "Falou pela primeira vez" fica só na lista (na barra é ruído).
  let bar = '';
  if (!live && durMs > 0) {
    const pct = (ms: number) => Math.min(100, Math.max(0, (ms / durMs) * 100)).toFixed(2);
    const click = (ms: number) => (seekable ? ` onclick="kseek(${Math.floor(ms)});return false" href="#"` : '');

    // capítulos: do início de um tópico até o início do próximo. Com MUITOS
    // tópicos os blocos ficam finos demais pra rótulo - então a barra mostra só
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
        const label = esc(`${formatOffset(start)}. ${tp.titulo}`);
        return seekable
          ? `<a class="tl-seg s${i % 2}" style="left:${left.toFixed(2)}%;width:${w.toFixed(2)}%" title="${label}" aria-label="${label}"${click(start)}><span>${i + 1}</span></a>`
          : `<span class="tl-seg s${i % 2}" style="left:${left.toFixed(2)}%;width:${w.toFixed(2)}%" aria-hidden="true"><span>${i + 1}</span></span>`;
      });
      chapters = `<div class="tl-ch">${segs.join('')}</div>`;
      chapterList = `<ol class="tl-chlist">${topics
        .map((tp, i) =>
          seekable
            ? `<li><a${click(tp.inicioMs)}><b>${String(i + 1).padStart(2, '0')}</b><time>${formatOffset(tp.inicioMs)}</time><span>${esc(tp.titulo)}</span></a></li>`
            : `<li><span class="tl-static"><b>${String(i + 1).padStart(2, '0')}</b><time>${formatOffset(tp.inicioMs)}</time><span>${esc(tp.titulo)}</span></span></li>`,
        )
        .join('')}</ol>`;
    }

    // ticks: notas (amarelo, por cima) + entrou/saiu (verde/cinza, discretos)
    const ticks: string[] = [];
    for (const n of meta.notes) {
      const label = esc(`${formatOffset(n.atMs)}. ${n.author}: ${n.text.slice(0, 80)}`);
      ticks.push(
        seekable
          ? `<a class="tl-tk tnote" style="left:${pct(n.atMs)}%" title="${label}" aria-label="${label}"${click(n.atMs)}></a>`
          : `<span class="tl-tk tnote" style="left:${pct(n.atMs)}%" aria-hidden="true"></span>`,
      );
    }
    for (const e of meta.events) {
      const kind =
        e.text.startsWith('\u{1F50A}') || e.text.startsWith('\u{1F465}')
          ? 'join'
          : e.text.startsWith('\u{1F6AA}')
            ? 'leave'
            : '';
      if (!kind) continue;
      const label = esc(`${formatOffset(e.atMs)}. ${eventLabel(localizeEvent(e.text, l))}`);
      ticks.push(
        seekable
          ? `<a class="tl-tk ${kind}" style="left:${pct(e.atMs)}%" title="${label}" aria-label="${label}"${click(e.atMs)}></a>`
          : `<span class="tl-tk ${kind}" style="left:${pct(e.atMs)}%" aria-hidden="true"></span>`,
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
    tabs.forEach(function(b){
      var on = b.dataset.t === id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  };
  tabs.forEach(function(b){
    b.addEventListener('click', function(){
      window.kshow(b.dataset.t);
      try { history.replaceState(null, '', '#' + b.dataset.t); } catch(e){}
    });
    b.addEventListener('keydown', function(e){
      var i = tabs.indexOf(b), next = i;
      if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      else return;
      e.preventDefault();
      window.kshow(tabs[next].dataset.t);
      tabs[next].focus();
      try { history.replaceState(null, '', '#' + tabs[next].dataset.t); } catch(err){}
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
      document.querySelectorAll('.speed button').forEach(function(x){
        var on = x === b;
        x.classList.toggle('on', on);
        x.setAttribute('aria-pressed', String(on));
      });
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
    // Object.create(null): nome de falante vem do Discord - 'constructor'/'toString'
    // num objeto plano seria truthy sem filtro nenhum e sumiria com o bloco
    var off = Object.create(null);
    document.querySelectorAll('.fchip.off').forEach(function(c){ off[c.dataset.sp] = true; });
    var visible = 0;
    document.querySelectorAll('.transcript .tblock').forEach(function(b){
      if (off[b.dataset.sp]) { b.style.display = 'none'; return; }
      var any = false;
      b.querySelectorAll('p').forEach(function(pp){
        var show = !q || pp.textContent.toLowerCase().indexOf(q) !== -1;
        pp.style.display = show ? '' : 'none';
        if (show) any = true;
      });
      b.style.display = any ? '' : 'none';
      if (any) visible++;
    });
    var empty = document.getElementById('ksearch-empty');
    if (empty) empty.hidden = visible > 0;
  }
  if (input) input.addEventListener('input', applyFilter);
  document.querySelectorAll('.fchip').forEach(function(c){
    c.addEventListener('click', function(){
      c.classList.toggle('off');
      c.setAttribute('aria-pressed', String(!c.classList.contains('off')));
      applyFilter();
    });
  });
  // copiar itens de ação
  var cp = document.getElementById('kcopyact');
  if (cp) cp.addEventListener('click', function(){
    navigator.clipboard.writeText(cp.dataset.txt).then(function(){
      var old = cp.textContent; cp.textContent = cp.dataset.done || 'OK'; setTimeout(function(){ cp.textContent = old; }, 1200);
    }).catch(function(){});
  });
})();
</script>`;

function renderMinutes(meta: RecordingMeta, minutes: MeetingMinutes | undefined, l: Locale, seekable = true): string {
  const state = meta.minutes;
  if (!state || state.status === 'disabled') return '';
  const title = `<h2>${p(l, 'minutes')}</h2>`;
  if (state.status === 'pending')
    return `${title}<p class="tstate" role="status" aria-live="polite">${p(l, 'minutesPending')}</p>`;
  if (state.status === 'running')
    return `${title}<p class="tstate" role="status" aria-live="polite">${p(l, 'minutesRunning')}</p>`;
  if (state.status === 'error')
    return `${title}<p class="tstate" role="alert">${p(l, 'minutesError')}${esc(shortError(state.error, l))}</p>${techDetails(state.error, l)}`;
  if (!minutes) return '';

  const parts: string[] = [];
  // O resumo recebe destaque tipográfico próprio.
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
        const extra = [a.responsavel, a.prazo].filter(Boolean).join(', ');
        return `- [ ] ${a.tarefa}${extra ? ` (${extra})` : ''}`;
      })
      .join('\n');
    parts.push(
      `<h3 id="acoes">${p(l, 'mActions')} <button type="button" class="copybtn" id="kcopyact" data-txt="${esc(plain)}" data-done="${l === 'pt' ? 'Copiado' : 'Copied'}" aria-live="polite">${p(l, 'copyActions')}</button></h3><ul>${minutes.acoes
        .map((a) => {
          const bits = [
            a.responsavel ? `${p(l, 'mOwner')}: ${esc(a.responsavel)}` : '',
            a.prazo ? `${p(l, 'mDue')}: ${esc(a.prazo)}` : '',
          ].filter(Boolean);
          const meta2 = bits.length ? ` <span class="meta2">(${bits.join(', ')})</span>` : '';
          return `<li class="action"><span class="action-mark" aria-hidden="true"></span><span>${esc(a.tarefa)}${meta2}</span></li>`;
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

  // Download protegido. No modo demo público, omitimos.
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

  // Banner de estado mostrado antes do conteúdo, se houver conteúdo. O texto
  // já entregue nunca some da página durante uma rodada de retry).
  let note = '';
  if (state.status === 'pending')
    note = `<p class="tstate" role="status" aria-live="polite">${p(l, 'transcriptPending')}</p>`;
  else if (state.status === 'running')
    note = `<p class="tstate" role="status" aria-live="polite">${p(l, 'transcriptRunning')}</p>`;
  else if (state.status === 'error') {
    // Erro com retry agendado não é falha definitiva.
    note = state.retryScheduled
      ? `<p class="tstate" role="status" aria-live="polite">${p(l, 'transcriptRetrying')}</p>`
      : `${title}<p class="tstate" role="alert">${p(l, 'transcriptError')}${esc(shortError(state.error, l))}</p>${techDetails(state.error, l)}`;
    if (!state.retryScheduled) return note; // erro final substitui a seção
  } else if (state.status === 'partial') {
    const names =
      (state.pendingTracks ?? []).map((n) => esc(n)).join(', ') || (l === 'pt' ? 'algumas faixas' : 'some tracks');
    note = `<p class="tstate" role="status" aria-live="polite" style="margin-bottom:8px">${p(
      l,
      state.retryScheduled ? 'transcriptPartial' : 'transcriptPartialFinal',
      { names },
    )}</p>`;
  }

  if (!hasContent) {
    if (state.status === 'done')
      return `${title}<div class="empty-state" role="status"><strong>${p(l, 'transcriptEmpty')}</strong><span class="muted">${l === 'pt' ? 'A ata e as notas continuam disponíveis quando existirem.' : 'Minutes and notes remain available when present.'}</span></div>`;
    return `${title}${note || `<p class="tstate" role="status" aria-live="polite">${p(l, 'transcriptPending')}</p>`}`;
  }

  // Agrupamento por falante, cor estável, busca e filtro.
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
        <div class="thead">${av ? `<img src="${esc(av)}" alt="">` : `<span class="speaker-initial c${ci}" aria-hidden="true">${esc(curSpeaker.slice(0, 1).toUpperCase())}</span>`}<span class="who c${ci}">${esc(curSpeaker)}</span></div>
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
        `<button type="button" class="fchip c${speakerColorIdx(sp, order)}" data-sp="${esc(sp)}" aria-pressed="true">${esc(sp)}</button>`,
    )
    .join('');
  const search = `<div class="tsearch">
      <label class="field-label" for="ksearch">${l === 'pt' ? 'Buscar nesta transcrição' : 'Search this transcript'}</label>
      <input id="ksearch" type="search" placeholder="${p(l, 'searchTranscript')}" autocomplete="off">
      ${speakers.length > 1 ? `<div class="fchips" aria-label="${l === 'pt' ? 'Filtrar por participante' : 'Filter by participant'}">${chips}</div>` : ''}
      <p class="muted" id="ksearch-empty" role="status" hidden>${l === 'pt' ? 'Nenhum trecho corresponde aos filtros.' : 'No transcript segment matches the filters.'}</p>
    </div>`;

  // Downloads protegidos. No modo demo público, omitimos.
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
  if (m.status === 'recording') return `<span class="wb live">${pt ? 'ao vivo' : 'live'}</span>`;
  if (m.minutes?.status === 'done') return `<span class="wb ok">${pt ? 'ata pronta' : 'minutes ready'}</span>`;
  const ts = m.transcription?.status;
  if (ts === 'partial' && !m.transcription?.retryScheduled)
    return `<span class="wb warn">${pt ? 'transcrição parcial' : 'partial transcript'}</span>`;
  if (ts === 'pending' || ts === 'running' || ((ts === 'partial' || ts === 'error') && m.transcription?.retryScheduled))
    return `<span class="wb">${pt ? 'processando' : 'processing'}</span>`;
  if (ts === 'done') return `<span class="wb ok">${pt ? 'transcrição pronta' : 'transcript ready'}</span>`;
  if (ts === 'error') return `<span class="wb warn">${pt ? 'transcrição falhou' : 'transcription failed'}</span>`;
  return `<span class="wb">${pt ? 'sem transcrição' : 'no transcript'}</span>`;
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

/** "há 3 dias" / "3 days ago" - idade aproximada pra decidir o que apagar. */
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
  /** Bytes de áudio no disco - presente só quando o viewer é dono do servidor (OWNER_IDS). */
  audioBytes?: number;
}

export type RecordingsSort = 'recent' | 'oldest' | 'largest';

/** Índice web "minhas gravações": gestão completa - busca, totais, ordenação e ações. */
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

  // Busca primeiro; "/" foca o campo de qualquer lugar da página.
  const searchForm = `<form class="isearch" method="get" action="/app">
      <label class="field-label" for="kq">${pt ? 'Buscar nas suas reuniões' : 'Search your meetings'}</label>
      <input id="kq" name="q" type="search" value="${esc(q)}" placeholder="${pt ? 'Transcrições, atas e notas' : 'Transcripts, minutes and notes'}" autocomplete="off">
      <button class="btn" type="submit">${pt ? 'Buscar' : 'Search'}</button>
    </form>
    <script>document.addEventListener('keydown',function(e){
      if(e.key==='/'&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)){e.preventDefault();var i=document.getElementById('kq');if(i)i.focus();}
    });</script>`;

  let hitsHtml = '';
  if (q) {
    const hits = opts.hits ?? [];
    hitsHtml =
      hits.length === 0
        ? `<div class="empty-state compact" role="status"><strong>${pt ? 'Nenhum resultado' : 'No results'}</strong><span class="muted">${pt ? 'Nada corresponde a' : 'Nothing matches'} “${esc(q)}”.</span></div>`
        : `<section aria-labelledby="search-results"><h2 id="search-results">${pt ? 'Resultados' : 'Results'} (${hits.length})</h2>
           <ul class="hits">${hits
             .map((h) => {
               const link =
                 h.atMs !== undefined ? `/app/rec/${h.metaId}#t=${Math.floor(h.atMs / 1000)}` : `/app/rec/${h.metaId}`;
               const kind =
                 h.kind === 'minutes'
                   ? pt
                     ? 'Ata'
                     : 'Minutes'
                   : h.kind === 'note'
                     ? pt
                       ? 'Nota'
                       : 'Note'
                     : pt
                       ? 'Transcrição'
                       : 'Transcript';
               const when = h.atMs !== undefined ? ` <a class="ts" href="${link}">${msToClock(h.atMs)}</a>` : '';
               return `<li><span class="hit-kind">${kind}</span><a href="${link}"><strong>#${esc(h.channelName)}</strong></a><span class="hit-date">${datetime(h.startedAt, l)}</span>${when}<br>
                 <span class="muted">${h.speaker ? `<strong>${esc(h.speaker)}:</strong> ` : ''}${esc(h.snippet)}</span></li>`;
             })
             .join('')}</ul></section>`;
  }

  // Cabeçalho de gestão: quantas gravações, quanto de áudio no disco, quanto sobra.
  const totalAudio = items.reduce((sum, i) => sum + (i.audioBytes ?? 0), 0);
  const nLabel = items.length === 1 ? p(l, 'ixRecording1') : p(l, 'ixRecordings');
  const statsParts = [`<span><strong>${items.length}</strong> ${nLabel}</span>`];
  if (opts.owner) {
    statsParts.push(`<span><strong>${formatBytes(totalAudio, l)}</strong> ${p(l, 'ixAudioOnDisk')}</span>`);
    if (opts.freeDiskMB !== undefined && opts.freeDiskMB !== Infinity)
      statsParts.push(
        `<span><strong>${formatBytes(opts.freeDiskMB * 1024 * 1024, l)}</strong> ${p(l, 'ixFree')}</span>`,
      );
  }
  const stats = items.length > 0 ? `<div class="rstats">${statsParts.join('')}</div>` : '';

  // Ordenação por link (server-side): recentes, antigas e maiores (esta só para o dono).
  const sortLink = (s: RecordingsSort, label: string) =>
    s === sort
      ? `<span class="sorton" aria-current="page">${label}</span>`
      : `<a href="/app?sort=${s}${q ? `&amp;q=${encodeURIComponent(q)}` : ''}">${label}</a>`;
  const sorts =
    items.length > 1
      ? `<nav class="rsorts" aria-label="${pt ? 'Ordenar gravações' : 'Sort recordings'}"><span>${p(l, 'ixSort')}</span>${sortLink('recent', p(l, 'ixSortRecent'))}${sortLink('oldest', p(l, 'ixSortOldest'))}${opts.owner ? sortLink('largest', p(l, 'ixSortLargest')) : ''}</nav>`
      : '';

  const flash = opts.flash ? `<div class="note" role="status">${esc(opts.flash)}</div>` : '';

  const channels = [...new Set(metas.map((m) => m.voiceChannelName))];
  const chips =
    channels.length > 1
      ? `<div class="filterblock"><span class="filterlabel">${pt ? 'Filtrar por canal' : 'Filter by channel'}</span><div class="fchips">${channels
          .map((c) => `<button type="button" class="fchip" data-ch="${esc(c)}" aria-pressed="true">#${esc(c)}</button>`)
          .join('')}</div></div>`
      : '';

  // Agrupamento por dia no fuso do servidor. Em "maiores", a lista fica plana.
  const dayLabel = (ms: number) =>
    esc(
      new Date(ms).toLocaleDateString(pt ? 'pt-BR' : 'en-US', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: config.timezone,
      }),
    );

  const renderCard = ({ meta: m, canDelete, audioBytes }: RecordingIndexItem): string => {
    const live = m.status === 'recording';
    const dur = m.endedAt
      ? formatDuration(m.endedAt - m.startedAt)
          .replace(/ 0s$/, '')
          .replace(/ 0min$/, '')
      : p(l, 'ixLive');
    const who = m.startedBy ? esc(m.startedBy.name) : p(l, 'ixByAuto');
    // Defesa em profundidade: tamanho só com owner=true, mesmo se bytes vazarem no item.
    const size =
      opts.owner && audioBytes !== undefined && audioBytes > 0 && !m.audioDeleted
        ? `${formatBytes(audioBytes, l)} ${pt ? 'de áudio' : 'of audio'}`
        : '';
    const detailParts = [
      `${m.participants.length} ${
        m.participants.length === 1 ? (pt ? 'participante' : 'participant') : pt ? 'participantes' : 'participants'
      }`,
      m.notes.length > 0
        ? `${m.notes.length} ${m.notes.length === 1 ? (pt ? 'nota' : 'note') : pt ? 'notas' : 'notes'}`
        : '',
      size,
      m.audioDeleted ? p(l, 'ixAudioFreed') : '',
    ].filter(Boolean);
    // Ações só para quem pode apagar e nunca ao vivo. O servidor revalida o POST.
    const actions =
      canDelete && !live
        ? `${
            !m.audioDeleted && !transcriptionNeedsAudio(m)
              ? `<form method="post" action="/app/rec/${m.id}/liberar-audio?back=index" onsubmit="return confirm('${p(l, 'ixFreeSpaceConfirm')}')">
                     <button type="submit" class="rbtn">${p(l, 'ixFreeSpace')}</button></form>`
              : ''
          }
            <form method="post" action="/app/rec/${m.id}/delete?back=index" onsubmit="return confirm('${p(l, 'delconfirm')}')">
              <button type="submit" class="rbtn danger">${p(l, 'ixDelete')}</button></form>`
        : '';
    return `<article class="rrow recording-card" data-ch="${esc(m.voiceChannelName)}" data-href="/app/rec/${m.id}">
        <a class="recording-card-main" href="/app/rec/${m.id}">
          <div class="recording-card-head"><span class="recording-channel">#${esc(m.voiceChannelName)}</span>${webBadge(m, l)}</div>
          <div class="recording-card-meta">
            <span><small>${pt ? 'Início' : 'Started'}</small><strong>${clockTime(m.startedAt, l)} ${relativeAge(m.startedAt, l)}</strong></span>
            <span><small>${pt ? 'Duração' : 'Duration'}</small><strong>${dur}</strong></span>
            <span><small>${pt ? 'Iniciada por' : 'Started by'}</small><strong>${who}</strong></span>
            <span><small>${pt ? 'Servidor' : 'Server'}</small><strong>${esc(m.guildName)}</strong></span>
          </div>
          <p class="recording-card-detail">${detailParts.join(', ')}</p>
        </a>
        ${actions ? `<div class="recording-card-actions">${actions}</div>` : ''}
      </article>`;
  };

  type RecordingDayGroup = { key: string; label: string; at: number; cards: string[] };
  const groups: RecordingDayGroup[] = [];
  for (const item of items) {
    const label = sort === 'largest' ? '' : dayLabel(item.meta.startedAt);
    const key = sort === 'largest' ? 'all' : label;
    let group = groups.at(-1);
    if (!group || group.key !== key) {
      group = { key, label, at: item.meta.startedAt, cards: [] };
      groups.push(group);
    }
    group.cards.push(renderCard(item));
  }

  const groupedCards = groups
    .map(
      (group) => `<section class="recording-group" data-group>
        ${group.label ? `<h2 class="dayh"><time data-ts="${group.at}" data-fmt="day">${group.label}</time></h2>` : ''}
        <div class="recording-grid">${group.cards.join('')}</div>
      </section>`,
    )
    .join('');

  const cards =
    items.length === 0
      ? `<div class="empty-state"><strong>${pt ? 'Nenhuma gravação por aqui' : 'No recordings here yet'}</strong><span class="muted">${
          pt
            ? 'Quando uma call for gravada com /gravar no Discord, ela aparecerá nesta central.'
            : 'When a call is recorded with /record on Discord, it will appear in this workspace.'
        }</span></div>`
      : `<div class="recording-groups">${groupedCards}</div>
        <div class="empty-state compact" id="channel-filter-empty" role="status" hidden><strong>${pt ? 'Nenhuma gravação nos canais selecionados' : 'No recordings in the selected channels'}</strong><span class="muted">${pt ? 'Ative outro canal no filtro acima.' : 'Enable another channel in the filter above.'}</span></div>
        <script>
        // O cartão inteiro navega, com exceção de links, botões e formulários.
        document.querySelectorAll('.rrow[data-href]').forEach(function(r){
          r.addEventListener('click', function(e){
            if (e.target.closest('a,button,form')) return;
            location.href = r.dataset.href;
          });
        });
        document.querySelectorAll('.fchip[data-ch]').forEach(function(c){
          c.addEventListener('click', function(){
            c.classList.toggle('off');
            c.setAttribute('aria-pressed', String(!c.classList.contains('off')));
            var off = Object.create(null);
            document.querySelectorAll('.fchip.off').forEach(function(x){ off[x.dataset.ch] = true; });
            var any = document.querySelectorAll('.fchip.off').length > 0;
            var visible = 0;
            document.querySelectorAll('.rrow').forEach(function(r){
              var show = !(any && off[r.dataset.ch]);
              r.style.display = show ? '' : 'none';
              if (show) visible++;
            });
            document.querySelectorAll('[data-group]').forEach(function(group){
              var groupVisible = Array.prototype.some.call(group.querySelectorAll('.rrow'), function(r){ return r.style.display !== 'none'; });
              group.style.display = groupVisible ? '' : 'none';
            });
            var empty = document.getElementById('channel-filter-empty');
            if (empty) empty.hidden = visible > 0;
          });
        });
        </script>`;

  return shell(
    pt ? 'Minhas gravações' : 'My recordings',
    `<header class="index-head"><h1>${pt ? 'Minhas gravações' : 'My recordings'}</h1>
     <p class="subline">${
       pt
         ? `Você entrou como <strong>${esc(opts.user.name)}</strong>. Esta central reúne tudo que sua conta pode acessar em todos os servidores.`
         : `Signed in as <strong>${esc(opts.user.name)}</strong>. This workspace brings together everything your account can access across servers.`
     }</p></header>
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
  // Páginas de mensagem/erro (404/403/etc.) nunca são beco sem saída - e nunca
  // jogam um usuário LOGADO de volta na landing: a casa dele é /app. Deslogado,
  // a saída é a ponte de login (a única ponte público→app).
  const pt = lang === 'pt';
  const back = user
    ? `<a class="btn" href="/app">${pt ? 'Voltar às gravações' : 'Back to recordings'}</a>`
    : `<a class="btn" href="/auth/login?next=%2Fapp">${pt ? 'Entrar com Discord' : 'Sign in with Discord'}</a>`;
  const body =
    `<h1>${esc(title)}</h1><p class="muted" style="margin-top:12px">${esc(message)}</p>` +
    `<div class="downloads" style="margin-top:18px">${back}</div>`;
  return shell(title, body, { user, lang });
}

const REPO_URL = PUBLIC_LINKS.github;
const NPM_URL = PUBLIC_LINKS.mcp;
// Enquanto o repo é privado, links "GitHub" apontam pro npm (público) pra não dar 404.
const ghHref = (): string => (config.repoPublic ? REPO_URL : NPM_URL);

// CSS da landing (vitrine pública). Documento próprio, full-width - NÃO usa o
// .card do shell(). Voz tipográfica sans real (a mesma família do sistema);
// monoespaçado (.mono) fica reservado a timestamps, nomes de env var, comandos
// e identificadores de licença - nunca em heading/parágrafo de venda. Os tokens
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
  /** conexões ativas DESTE usuário - a lista de gestão. */
  sessions?: SessionSummary[];
  revoked?: 'all' | 'one';
}): string {
  const pt = opts.lang === 'pt';
  const T = (a: string, b: string): string => (pt ? a : b);
  const title = T('Conectar assistente de IA', 'Connect your AI assistant');

  if (!opts.user) {
    const body = `<h1>${esc(title)}</h1>
      <p class="connect-intro">${esc(
        T(
          'Conecte suas reuniões do Kassinão a qualquer assistente de IA com MCP, como Claude Desktop ou Cursor. Entre com o Discord para manter o mesmo acesso que você já tem no site.',
          'Connect your Kassinão meetings to any MCP-capable AI assistant, such as Claude Desktop or Cursor. Sign in with Discord to keep the same access you already have on the site.',
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
      ? `<div class="note" role="alert">${esc(
          T(
            'Este servidor está com BASE_URL de localhost. O token gerado não vai funcionar de outra máquina. Defina a URL pública do bot antes de gerar conexões reais.',
            'This server has a localhost BASE_URL. The generated token will not work from another machine. Set the public bot URL before generating real connections.',
          ),
        )}</div>`
      : '';
    const body = `<h1>${esc(T('Conexão gerada', 'Connection generated'))}</h1>
      ${
        opts.label
          ? `<p class="subline">${esc(T('Apelido', 'Nickname'))}: <strong>${esc(opts.label)}</strong>. ${esc(
              T(
                'É assim que ela aparece na sua lista de conexões.',
                'This is how it appears in your connections list.',
              ),
            )}</p>`
          : ''
      }
      ${localhostWarn}
      <div class="security-note" role="status"><strong>${esc(T('Copie esta configuração agora.', 'Copy this configuration now.'))}</strong><span>${esc(
        T(
          'O token não será mostrado de novo. Ele dá ao seu assistente acesso somente às gravações que sua conta pode ver.',
          'The token will not be shown again. It gives your assistant access only to recordings your account can see.',
        ),
      )}</span></div>
      <ol class="connect-steps">
        <li>${esc(T('Copie o bloco abaixo.', 'Copy the block below.'))}</li>
        <li>${esc(T('Cole no arquivo de configuração de um aplicativo.', 'Paste it into one application configuration file.'))}</li>
        <li>${esc(T('Reinicie o aplicativo e faça uma pergunta.', 'Restart the application and ask a question.'))}</li>
      </ol>
      <h2>${esc(T('Onde fica o arquivo', 'Where the file lives'))}</h2>
      <ul class="connect-steps">
        <li>Claude Desktop, macOS: <code>~/Library/Application Support/Claude/claude_desktop_config.json</code></li>
        <li>Claude Desktop, Windows: <code>%APPDATA%\\Claude\\claude_desktop_config.json</code></li>
        <li>Cursor: <span style="font-family:ui-monospace,monospace">~/.cursor/mcp.json</span></li>
        <li>${esc(T('Outro assistente com MCP: onde a documentação dele indicar', 'Any other MCP-capable assistant: wherever its docs point'))}</li>
      </ul>
      <div class="downloads" style="margin-top:16px"><button id="kcopy" class="btn" type="button">${esc(T('Copiar configuração', 'Copy configuration'))}</button></div>
      <pre id="kcfg" class="tokenbox" tabindex="0" aria-label="${esc(T('Configuração MCP', 'MCP configuration'))}">${esc(cfg)}</pre>
      <p class="connect-intro">${esc(
        T(
          'Já usa outros servidores MCP? Cole só o bloco "kassinao" dentro de "mcpServers". Não substitua o arquivo inteiro. O conector requer Node 20 ou superior e usa "npx -y kassinao-mcp".',
          'Already use other MCP servers? Paste only the "kassinao" block inside "mcpServers". Do not replace the entire file. The connector requires Node 20 or newer and uses "npx -y kassinao-mcp".',
        ),
      )}</p>
      <p class="connect-intro">${esc(
        T(
          'Depois reinicie o app e pergunte: "o que ficou pendente essa semana?"',
          'Then restart the app and ask: "what is pending this week?"',
        ),
      )}</p>
      <div class="downloads" style="margin-top:18px"><a class="btn secondary" href="/app/conectar-ia">${esc(T('Voltar às conexões', 'Back to connections'))}</a></div>
      <script>(function(){var b=document.getElementById('kcopy');if(!b)return;b.addEventListener('click',function(){var t=(document.getElementById('kcfg').textContent)||'';navigator.clipboard.writeText(t).then(function(){var o=b.textContent;b.textContent='${esc(T('Copiado', 'Copied'))}';setTimeout(function(){b.textContent=o;},2000);}).catch(function(){});});})();</script>`;
    return shell(title, body, { lang: opts.lang, user: opts.user, active: 'ai', wide: true });
  }

  // Estado de gestão: lista das conexões da pessoa, com revogação individual.
  const sess = opts.sessions ?? [];
  const revokedMsg =
    opts.revoked === 'all'
      ? `<div class="note" role="status">${esc(T('Todas as suas conexões foram revogadas.', 'All your connections were revoked.'))}</div>`
      : opts.revoked === 'one'
        ? `<div class="note" role="status">${esc(T('Conexão revogada. O token parou de funcionar imediatamente.', 'Connection revoked. Its token stopped working immediately.'))}</div>`
        : '';
  const noName = T('sem apelido', 'unnamed');
  const connections = sess
    .map((s) => {
      const last = s.lastSeenAt
        ? relativeAge(s.lastSeenAt, opts.lang)
        : `<span class="muted">${T('nunca usada', 'never used')}</span>`;
      return `<article class="connection-card">
        <div class="connection-name"><small>${esc(T('Conexão', 'Connection'))}</small><strong>${s.label ? esc(s.label) : `<span class="muted">${noName}</span>`}</strong><code>${esc(s.sid.slice(0, 8))}</code></div>
        <div><small>${esc(T('Criada', 'Created'))}</small>${dateOnly(s.createdAt, opts.lang)}</div>
        <div><small>${esc(T('Último uso', 'Last used'))}</small>${last}</div>
        <div><small>${esc(T('Expira', 'Expires'))}</small>${dateOnly(s.exp, opts.lang)}</div>
        <form method="post" action="/app/conectar-ia/revogar/${esc(s.sid)}"
          onsubmit="return confirm('${esc(T('Revogar esta conexão? O assistente ligado nela para de funcionar na hora.', 'Revoke this connection? The assistant using it stops working immediately.'))}')">
          <button type="submit" class="rbtn danger" aria-label="${esc(T('Revogar esta conexão', 'Revoke this connection'))}">${esc(T('Revogar', 'Revoke'))}</button>
        </form>
      </article>`;
    })
    .join('');
  const list =
    sess.length > 0
      ? `<section aria-labelledby="connections-title"><h2 id="connections-title">${esc(T('Suas conexões', 'Your connections'))} (${sess.length})</h2>
         <div class="connection-list">${connections}</div>
         ${
           sess.length > 1
             ? `<form method="post" action="/app/conectar-ia/revogar" style="margin-top:14px"
                 onsubmit="return confirm('${esc(T('Revogar TODAS as suas conexões de uma vez?', 'Revoke ALL your connections at once?'))}')">
                 <button type="submit" class="danger">${esc(T('Revogar todas', 'Revoke all'))}</button>
               </form>`
             : ''
         }</section>`
      : `<section aria-labelledby="connections-title"><h2 id="connections-title">${esc(T('Suas conexões', 'Your connections'))}</h2>
         <div class="empty-state compact"><strong>${esc(T('Nenhuma conexão ativa', 'No active connections'))}</strong><span class="muted">${esc(T('Gere uma conexão para começar.', 'Generate a connection to get started.'))}</span></div></section>`;
  const body = `<h1>${esc(title)}</h1>
    ${revokedMsg}
    <p class="connect-intro">${esc(
      T(
        'Ligue o Kassinão em qualquer assistente de IA com MCP (Claude, Cursor e outros) para perguntar sobre as suas calls em linguagem natural.',
        'Plug Kassinão into any MCP-capable AI assistant (Claude, Cursor, and more) to ask about your calls in natural language.',
      ),
    )}</p>
    <div class="security-note"><strong>${esc(T('Acesso individual', 'Individual access'))}</strong><span>${esc(
      T(
        'Cada pessoa entra com o próprio Discord, gerencia somente as próprias conexões e mantém o mesmo acesso às gravações.',
        'Each person signs in with their own Discord, manages only their own connections, and keeps the same recording access.',
      ),
    )}</span></div>
    <form class="genform" method="post" action="/app/conectar-ia/gerar">
      <label class="field-label" for="connection-label">${esc(T('Apelido da conexão (opcional)', 'Connection nickname (optional)'))}</label>
      <input id="connection-label" name="label" maxlength="40" autocomplete="off"
        placeholder="${esc(T('Exemplo: Claude do notebook', 'Example: Claude on my laptop'))}">
      <button class="btn" type="submit">${esc(T('Gerar conexão', 'Generate connection'))}</button>
    </form>
    <p class="muted" style="margin-top:8px">${esc(
      T(
        'Você recebe uma configuração pronta para colar. Gere uma conexão por assistente para poder revogar cada acesso separadamente.',
        'You receive a ready-to-paste configuration. Generate one connection per assistant so you can revoke each access separately.',
      ),
    )}</p>
    ${list}`;
  return shell(title, body, { lang: opts.lang, user: opts.user, active: 'ai', wide: true });
}
