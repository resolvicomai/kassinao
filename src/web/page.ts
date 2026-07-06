import { config } from '../config';
import { Locale } from '../i18n';
import { msToClock } from '../processing/transcribe';
import { formatDuration, formatOffset } from '../recorder/RecordingSession';
import { MeetingMinutes, RecordingMeta, TranscriptSegment } from '../store';
import { shortError } from '../util';
import type { WebUser } from './auth';

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
  nobody: { pt: 'Ninguém falou ainda. 🤷', en: 'Nobody spoke yet. 🤷' },
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
  timelineLegend: {
    pt: '● falou · ● entrou · ● saiu · ● nota · ● tópico — clique pra pular',
    en: '● spoke · ● joined · ● left · ● note · ● topic — click to jump',
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
  body { background: #1e1f22; color: #dbdee1; font-family: -apple-system, 'Segoe UI', Roboto, Ubuntu, sans-serif;
         min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 40px 16px; }
  .card { background: #2b2d31; border-radius: 12px; padding: 28px; max-width: 640px; width: 100%;
          box-shadow: 0 8px 24px rgba(0,0,0,.35); }
  h1 { font-size: 22px; color: #f2f3f5; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: #949ba4; margin: 22px 0 10px; }
  .muted { color: #949ba4; font-size: 14px; }
  .grid { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin-top: 14px; font-size: 15px; }
  .grid dt { color: #949ba4; }
  .badge { font-size: 12px; font-weight: 700; padding: 3px 10px; border-radius: 999px; vertical-align: middle; }
  .badge.live { background: #da373c; color: #fff; animation: pulse 1.6s infinite; }
  .badge.done { background: #23a55a; color: #fff; }
  @keyframes pulse { 50% { opacity: .55; } }
  .people { display: flex; flex-wrap: wrap; gap: 8px; }
  .person { display: flex; align-items: center; gap: 8px; background: #232428; padding: 6px 12px 6px 6px;
            border-radius: 999px; font-size: 14px; }
  .person img { width: 26px; height: 26px; border-radius: 50%; }
  .downloads { display: flex; flex-wrap: wrap; gap: 10px; }
  /* .btn cobre <a> E <button> (o connect usa <button class="btn"> — antes caía no botão cinza padrão) */
  .btn { display: inline-flex; flex-direction: column; gap: 2px; text-decoration: none; background: #5865f2;
         color: #fff; padding: 12px 18px; border-radius: 8px; font-size: 15px; font-weight: 600;
         border: 0; cursor: pointer; font-family: inherit; line-height: 1.2; }
  .btn small { font-weight: 400; font-size: 12px; opacity: .8; }
  .btn:hover { background: #4752c4; }
  .btn.secondary { background: #3a3c42; }
  .btn.secondary:hover { background: #45474e; }
  .events { list-style: none; font-size: 14px; display: flex; flex-direction: column; gap: 4px;
            max-height: 220px; overflow-y: auto; }
  .events time { color: #949ba4; font-family: ui-monospace, monospace; margin-right: 8px; }
  .wall { color: #6d7178 !important; font-size: 12px; }
  .transcript { display: flex; flex-direction: column; gap: 14px;
                background: #232428; border-radius: 8px; padding: 14px; font-size: 14px; }
  .transcript p { line-height: 1.5; padding: 2px 6px; border-left: 2px solid transparent; border-radius: 4px; }
  .transcript p.now { background: rgba(88,101,242,.12); border-left-color: #5865f2; }
  .transcript .who { color: #f2f3f5; font-weight: 600; }
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
  .tsearch input { background: #1e1f22; border: 1px solid #3f4147; color: #dbdee1; border-radius: 8px;
                   padding: 9px 12px; font-size: 14px; width: 100%; }
  .tsearch input:focus { outline: none; border-color: #5865f2; }
  .fchips { display: flex; flex-wrap: wrap; gap: 6px; }
  .fchip { background: #2b2d31; border: 1px solid #3f4147; border-radius: 999px; padding: 3px 10px;
           font-size: 12.5px; cursor: pointer; font-family: inherit; }
  .fchip.off { opacity: .35; text-decoration: line-through; }
  .copybtn { background: #3a3c42; border: 0; border-radius: 6px; color: #dbdee1; cursor: pointer;
             font-size: 12px; padding: 3px 8px; vertical-align: middle; margin-left: 6px; }
  .copybtn:hover { background: #45474e; }
  .subline { color: #949ba4; font-size: 14px; margin-top: 6px; }
  .playerwrap { position: sticky; top: 0; z-index: 5; background: #2b2d31; padding: 12px 0 8px;
                margin: 18px 0 6px; border-bottom: 1px solid #3f4147; }
  .playerwrap audio { width: 100%; }
  .pctl { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 6px;
          font-size: 12.5px; color: #949ba4; }
  .speed { display: inline-flex; gap: 4px; }
  .speed button { background: #232428; border: 1px solid #3f4147; color: #b5bac1; border-radius: 6px;
                  padding: 2px 9px; font-size: 12px; cursor: pointer; font-family: inherit; }
  .speed button.on { background: #5865f2; color: #fff; border-color: #5865f2; }
  .follow { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
  .tlbar { position: relative; height: 26px; background: #232428; border-radius: 8px; margin: 4px 0 4px; }
  .tlbar .mk { position: absolute; top: 6px; width: 8px; height: 14px; border-radius: 3px;
               transform: translateX(-50%); text-decoration: none; }
  .tlbar .mk:hover { transform: translateX(-50%) scaleY(1.25); }
  .mk.speak { background: #7b90f7; } .mk.join { background: #3dbf7a; } .mk.leave { background: #6d7178; }
  .mk.note { background: #f0b232; } .mk.topic { background: #a58cf2; top: 3px; height: 20px; }
  .mk.sys { background: #4e5058; }
  .tllegend { font-size: 11.5px; color: #6d7178; margin-bottom: 6px; }
  .evlist summary { cursor: pointer; font-size: 13px; color: #949ba4; margin: 6px 0; }
  .minutes .lead { font-size: 15.5px; line-height: 1.55; color: #f2f3f5; }
  .transcript time { color: #949ba4; font-family: ui-monospace, monospace; font-size: 12px; margin-right: 6px; }
  .tstate { font-size: 14px; color: #949ba4; }
  details.tech { margin-top: 6px; font-size: 12px; color: #6d7178; }
  details.tech summary { cursor: pointer; }
  details.tech code { display: block; margin-top: 6px; padding: 8px 10px; background: #232428;
                      border-radius: 6px; overflow-wrap: anywhere; }
  .tdl { display: flex; gap: 10px; margin-top: 10px; }
  .tdl a { color: #00a8fc; font-size: 13px; text-decoration: none; }
  .tdl a:hover { text-decoration: underline; }
  .notes { list-style: none; font-size: 14px; display: flex; flex-direction: column; gap: 4px; }
  .notes time { color: #949ba4; font-family: ui-monospace, monospace; margin-right: 8px; }
  .minutes { background: #232428; border-radius: 8px; padding: 16px 18px; font-size: 14.5px; line-height: 1.5; }
  .minutes h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: #949ba4; margin: 16px 0 8px; }
  .minutes h3:first-child { margin-top: 0; }
  .minutes ul { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 5px; }
  .minutes .action { display: flex; gap: 8px; align-items: baseline; }
  .minutes .meta2 { color: #949ba4; font-size: 12.5px; }
  .minutes time { color: #949ba4; font-family: ui-monospace, monospace; margin-right: 6px; }
  .minutes .who { color: #f2f3f5; font-weight: 600; margin: 10px 0 4px; }
  .ts { color: #00a8fc; font-family: ui-monospace, monospace; font-size: 12px; margin-right: 8px;
        text-decoration: none; cursor: pointer; }
  .ts:hover { text-decoration: underline; }
  .player { margin: 14px 0 4px; }
  .player audio { width: 100%; }
  .player .hint { font-size: 12.5px; color: #949ba4; margin-top: 4px; }
  form.delete { margin-top: 26px; border-top: 1px solid #3f4147; padding-top: 16px; }
  button.danger { background: none; border: 1px solid #da373c; color: #da373c; padding: 8px 14px;
                  border-radius: 8px; font-size: 14px; cursor: pointer; }
  button.danger:hover { background: #da373c; color: #fff; }
  .topbar { max-width: 640px; width: 100%; display: flex; justify-content: space-between; align-items: center;
            gap: 8px; margin-bottom: 16px; font-size: 13px; color: #949ba4; }
  .topbar .brand { display: inline-flex; align-items: center; gap: 7px; font-weight: 800; font-size: 15px;
                   color: #f2f3f5; text-decoration: none; }
  .topbar .topnav-r { display: inline-flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: flex-end; }
  .topbar .tl { color: #b5bac1; text-decoration: none; }
  .topbar .tl:hover { color: #f2f3f5; }
  .topbar .user { display: inline-flex; align-items: center; gap: 6px; color: #dbdee1; }
  .topbar img { width: 22px; height: 22px; border-radius: 50%; }
  .langtoggle a { color: #949ba4; text-decoration: none; padding: 2px 4px; }
  .langtoggle a.on { color: #f2f3f5; font-weight: 700; }
  .langtoggle a:hover { color: #dbdee1; }
  .langtoggle span { opacity: .5; margin: 0 2px; }
  .topfoot { max-width: 640px; width: 100%; margin-top: 30px; padding-top: 16px; border-top: 1px solid #3f4147;
             font-size: 13px; color: #949ba4; text-align: center; }
  .topfoot a { color: #b5bac1; text-decoration: none; }
  .topfoot a:hover { color: #f2f3f5; }
  .note { background: #232428; border-left: 3px solid #f0b232; padding: 10px 14px; border-radius: 6px;
          font-size: 14px; margin-top: 14px; }
  footer { margin-top: 26px; font-size: 13px; color: #949ba4; }
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
// pular pro momento no player de áudio (no-op se não houver player, ex.: gravação ao vivo)
// o player é sticky no topo — não precisa (nem deve) sequestrar o scroll do leitor
window.kseek = function(ms){
  var p = document.getElementById('kplayer');
  if (!p) return;
  p.currentTime = Math.max(0, ms/1000);
  p.play().catch(function(){});
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
  let player = '';
  if (demo) {
    player = `<h2>${p(l, 'sampleAudio')}</h2>
       <div class="player">
         <audio preload="none" controls src="/demo/audio"></audio>
         <div class="hint">${p(l, 'sampleNote')}</div>
       </div>`;
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
    !demo && meta.participants.length > 0
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
        meta.expiresAt && !live ? `${p(l, 'expires', { date: datetime(meta.expiresAt, l) })} · ` : ''
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

  // barra visual só faz sentido com duração fechada e player pra pular
  let bar = '';
  if (!live && durMs > 0) {
    const markers: string[] = [];
    for (const e of meta.events) {
      const pct = Math.min(100, Math.max(0, (e.atMs / durMs) * 100));
      const kind = e.text.startsWith('🎤')
        ? 'speak'
        : e.text.startsWith('🔊') || e.text.startsWith('👥')
          ? 'join'
          : e.text.startsWith('🚪')
            ? 'leave'
            : e.text.startsWith('📝')
              ? 'note'
              : 'sys';
      const click = seekable ? ` onclick="kseek(${e.atMs});return false" href="#"` : '';
      markers.push(
        `<a class="mk ${kind}" style="left:${pct.toFixed(2)}%" title="${esc(`${formatOffset(e.atMs)} ${e.text}`)}"${click}></a>`,
      );
    }
    for (const tp of minutes?.topicos ?? []) {
      const pct = Math.min(100, Math.max(0, (tp.inicioMs / durMs) * 100));
      const click = seekable ? ` onclick="kseek(${tp.inicioMs});return false" href="#"` : '';
      markers.push(
        `<a class="mk topic" style="left:${pct.toFixed(2)}%" title="${esc(`${formatOffset(tp.inicioMs)} · ${tp.titulo}`)}"${click}></a>`,
      );
    }
    bar = `<div class="tlbar">${markers.join('')}</div>
      <div class="tllegend">${p(l, 'timelineLegend')}</div>`;
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
// .card estreito do shell(). Mesmos tokens de cor do Discord do SHELL_CSS.
// Tudo self-contained (CSP: sem fonte/CSS/JS/imagem externa).
const LANDING_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  /* clip (não hidden): impede scroll horizontal SEM virar container de scroll, senão quebra o position:sticky do topnav */
  html, body { max-width: 100%; overflow-x: clip; }
  body { background: #1e1f22; color: #dbdee1;
         font-family: -apple-system, 'Segoe UI', Roboto, Ubuntu, sans-serif; line-height: 1.55; }
  a { color: inherit; }
  .mono { font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; }
  .wrap { max-width: 960px; margin: 0 auto; padding: 0 20px; }
  section { padding: clamp(44px, 8vw, 92px) 0; border-top: 1px solid #26282c; }
  section.hero { border-top: 0; }
  .center { text-align: center; }
  h1 { font-size: clamp(2rem, 5.4vw, 3.2rem); line-height: 1.08; font-weight: 800; color: #f2f3f5;
       letter-spacing: -0.01em; }
  h2 { font-size: clamp(1.4rem, 3.6vw, 2.05rem); line-height: 1.15; font-weight: 800; color: #f2f3f5;
       letter-spacing: -0.01em; }
  .lead { font-size: clamp(1.02rem, 1.6vw, 1.16rem); color: #949ba4; margin-top: 14px; max-width: 46ch; }
  .hero .lead { max-width: 52ch; }
  .kicker { font-size: 0.78rem; text-transform: uppercase; letter-spacing: .06em; color: #949ba4;
            margin-bottom: 10px; }
  .eyebrow { display: inline-flex; align-items: center; gap: 8px; background: #232428; border: 1px solid #3a3c42;
             color: #b5bac1; font-size: 0.82rem; padding: 6px 13px; border-radius: 999px; margin-bottom: 18px; }
  .eyebrow b { color: #f2f3f5; font-weight: 700; }
  /* topbar */
  .topnav { position: sticky; top: 0; z-index: 20; background: rgba(30,31,34,.86);
            -webkit-backdrop-filter: saturate(140%) blur(8px);
            backdrop-filter: saturate(140%) blur(8px); border-bottom: 1px solid #26282c; }
  .topnav .wrap { display: flex; align-items: center; justify-content: space-between; gap: 12px;
                  height: 56px; }
  .brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 800; color: #f2f3f5;
           text-decoration: none; font-size: 1.02rem; }
  .navlinks { display: flex; align-items: center; gap: 8px; font-size: 0.9rem; }
  .navlinks a { color: #b5bac1; text-decoration: none; padding: 6px 8px; border-radius: 7px; }
  .navlinks a:hover { color: #f2f3f5; background: #2b2d31; }
  .langtoggle a { color: #949ba4; text-decoration: none; padding: 2px 3px; }
  .langtoggle a.on { color: #f2f3f5; font-weight: 700; }
  .langtoggle span { opacity: .4; margin: 0 2px; }
  /* buttons */
  .ctarow { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 26px; }
  .center .ctarow { justify-content: center; }
  .btn { display: inline-flex; align-items: center; gap: 8px; text-decoration: none; font-weight: 700;
         font-size: 1rem; padding: 13px 22px; border-radius: 10px; border: 1px solid transparent;
         transition: background .15s, border-color .15s, transform .15s; }
  .btn:hover { transform: translateY(-1px); }
  .btn-primary { background: #5865f2; color: #fff; }
  .btn-primary:hover { background: #4752c4; }
  .btn-outline { background: #2b2d31; color: #f2f3f5; border-color: #3a3c42; }
  .btn-outline:hover { border-color: #5865f2; }
  .btn-ghost { background: transparent; color: #b5bac1; padding: 13px 10px; }
  .btn-ghost:hover { color: #f2f3f5; }
  .btn-sm { padding: 8px 15px; font-size: 0.9rem; }
  .lead b { color: #f2f3f5; font-weight: 700; }
  .microline { margin-top: 16px; font-size: 0.86rem; color: #949ba4; }
  .microline b { color: #b5bac1; font-weight: 600; }
  /* hero centrado com brilho + energia */
  section.hero { position: relative; overflow: hidden; text-align: center; padding-top: clamp(40px, 7vw, 76px); }
  section.hero::before { content: ''; position: absolute; left: 50%; top: -160px; width: 900px; height: 620px;
    transform: translateX(-50%); pointer-events: none; z-index: 0;
    background: radial-gradient(50% 50% at 50% 40%, rgba(88,101,242,.30), rgba(88,101,242,0) 72%); }
  section.hero .wrap { position: relative; z-index: 1; }
  section.hero .eyebrow { background: rgba(88,101,242,.12); border-color: rgba(88,101,242,.4); color: #c7ccf5; }
  .hero .lead { max-width: 40ch; margin-left: auto; margin-right: auto; color: #b5bac1; font-size: clamp(1.05rem, 1.8vw, 1.28rem); }
  .hero .ctarow { justify-content: center; }
  .accent { background: linear-gradient(92deg, #9aa4ff, #5865f2); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .flow { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; margin-top: 24px; }
  .flow .chip { display: inline-flex; align-items: center; gap: 8px; background: #232428; border: 1px solid #30333a;
    border-radius: 999px; padding: 9px 15px; font-size: 0.9rem; color: #dbdee1; font-weight: 600; }
  .flow .arrow { color: #5865f2; font-weight: 800; align-self: center; }
  .hero .hero-split { max-width: 860px; margin-left: auto; margin-right: auto; text-align: left;
    border-color: #33374a; box-shadow: 0 24px 70px rgba(88,101,242,.18), 0 10px 34px rgba(0,0,0,.5); }
  /* hero split */
  .hero-split { display: flex; gap: 16px; margin-top: 40px; align-items: stretch;
                background: #1a1b1e; border: 1px solid #26282c; border-radius: 16px; padding: 16px;
                position: relative; overflow: hidden; }
  .panel { border-radius: 12px; padding: 15px; min-width: 0; }
  .panel-call { background: #232428; flex: 0 0 40%; }
  .panel-chat { background: #2b2d31; flex: 1 1 60%; }
  .dc-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
  .dc-head .ch { color: #f2f3f5; font-weight: 700; font-size: 0.96rem; }
  .rec-dot { width: 9px; height: 9px; border-radius: 50%; background: #da373c; flex: 0 0 auto;
             animation: recpulse 1.7s ease-in-out infinite; }
  .rec-pill { margin-left: auto; font-size: 0.66rem; font-weight: 800; letter-spacing: .05em;
              color: #f0b232; background: #2b2d31; border: 1px solid #46402a; padding: 3px 8px; border-radius: 6px; }
  .panel-chat .rec-pill { background: #232428; }
  .spk { display: flex; align-items: center; gap: 9px; padding: 6px 0; }
  .avatar { width: 27px; height: 27px; border-radius: 50%; flex: 0 0 auto; color: #fff; font-weight: 700;
            font-size: 0.8rem; display: flex; align-items: center; justify-content: center; }
  .spk .nm { color: #dbdee1; font-size: 0.9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wave { margin-left: auto; display: flex; align-items: flex-end; gap: 2px; height: 18px; flex: 0 0 auto; }
  .wave i { width: 2px; background: #5865f2; border-radius: 2px; display: block; transform-origin: bottom;
            height: 60%; }
  .wave.live i { animation: wave 1.1s ease-in-out infinite; }
  .wave.live i:nth-child(2){ animation-delay:.12s } .wave.live i:nth-child(3){ animation-delay:.24s }
  .wave.live i:nth-child(4){ animation-delay:.36s } .wave.live i:nth-child(5){ animation-delay:.48s }
  .wave i:nth-child(1){height:40%} .wave i:nth-child(2){height:75%} .wave i:nth-child(3){height:100%}
  .wave i:nth-child(4){height:55%} .wave i:nth-child(5){height:80%} .wave i:nth-child(6){height:35%}
  /* beam */
  .beam { position: absolute; left: 40%; top: 50%; transform: translate(-6px,-50%); width: 40px; height: 60px;
          pointer-events: none; opacity: .6; }
  /* chat */
  .chrome { display: flex; align-items: center; gap: 6px; padding-bottom: 10px; margin-bottom: 10px;
            border-bottom: 1px solid #26282c; }
  .chrome i { width: 8px; height: 8px; border-radius: 50%; display: block; }
  .chrome .lbl { margin: 0 auto; color: #949ba4; font-size: 0.76rem; }
  .bubble { border-radius: 12px; padding: 9px 13px; font-size: 0.9rem; max-width: 92%; }
  .bubble-user { background: #5865f2; color: #fff; margin-left: auto; border-bottom-right-radius: 4px; }
  .bubble-ai { background: #232428; color: #dbdee1; margin-top: 10px; border-bottom-left-radius: 4px; max-width: 100%; }
  .toolchip { display: inline-flex; align-items: center; gap: 6px; font-size: 0.74rem; color: #b5bac1;
              background: #2b2d31; border-left: 2px solid #5865f2; padding: 3px 9px; border-radius: 5px; }
  .ans-head { color: #f2f3f5; font-weight: 700; font-size: 0.86rem; margin: 10px 0 8px; }
  .ans-row { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; padding: 7px 0;
             border-top: 1px solid #2b2d31; font-size: 0.85rem; animation: reveal .5s ease both; }
  .ans-row:nth-child(2){animation-delay:.15s} .ans-row:nth-child(3){animation-delay:.3s} .ans-row:nth-child(4){animation-delay:.45s}
  .sdot { width: 7px; height: 7px; border-radius: 50%; background: #f0b232; flex: 0 0 auto; }
  .ans-row .tk { color: #dbdee1; flex: 1 1 60%; min-width: 0; }
  .ans-meta { display: flex; align-items: center; gap: 7px; margin-left: auto; flex-wrap: nowrap; }
  .pill { font-size: 0.72rem; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
  .pill-owner { background: #2b2d31; color: #b5bac1; border: 1px solid #3a3c42; }
  .pill-due { background: #322a12; color: #f0b232; border: 1px solid #46402a; }
  .ts { color: #00a8fc; text-decoration: none; font-size: 0.8rem; white-space: nowrap; }
  .ts:hover { text-decoration: underline; }
  .ans-foot { color: #949ba4; font-size: 0.72rem; margin-top: 10px; }
  /* generic grids */
  .grid-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-top: 34px; }
  .qcard { background: #2b2d31; border: 1px solid #26282c; border-radius: 12px; padding: 15px; }
  .qcard.glow { border-color: #3a41a8; box-shadow: 0 0 0 1px #3a41a8 inset, 0 6px 20px rgba(88,101,242,.12); }
  .qprompt { display: flex; gap: 8px; color: #f2f3f5; font-weight: 600; font-size: 0.95rem; }
  .qprompt .arrow { color: #5865f2; font-weight: 800; }
  .qtool { margin: 11px 0 9px; }
  .qans { color: #b5bac1; font-size: 0.86rem; }
  .qbadge { display: inline-block; margin-top: 10px; font-size: 0.68rem; letter-spacing:.04em; text-transform: uppercase;
            color: #a9b0ff; background: #232a5c; border-radius: 6px; padding: 3px 8px; }
  /* minutes proof */
  .minutes-card { background: #232428; border-radius: 10px; padding: 18px 20px; border-left: 3px solid #5865f2;
                  margin-top: 30px; }
  .mc-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 4px; }
  .mc-head .bc { color: #dbdee1; font-size: 0.9rem; font-weight: 600; }
  .mc-badge { font-size: 0.7rem; font-weight: 800; color: #fff; background: #23a55a; padding: 3px 9px; border-radius: 999px; }
  .ai-pill { margin-left: auto; font-size: 0.7rem; color: #a9b0ff; background: #232a5c; padding: 3px 9px; border-radius: 999px; }
  .mc-h3 { font-size: 0.72rem; text-transform: uppercase; letter-spacing: .05em; color: #949ba4; margin: 16px 0 7px; }
  .mc-sum { color: #dbdee1; font-size: 0.93rem; }
  .mc-ul { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; color: #dbdee1; font-size: 0.92rem; }
  .mc-action { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; padding: 5px 0; font-size: 0.92rem; }
  .mc-action .task { color: #dbdee1; }
  .mc-action .meta2 { color: #949ba4; font-size: 0.8rem; }
  /* receipts */
  .receipts { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 30px; }
  .receipt { background: #2b2d31; border: 1px solid #26282c; border-radius: 12px; padding: 16px; }
  .r-icon { width: 38px; height: 38px; border-radius: 9px; background: #232428; display: flex; align-items: center;
            justify-content: center; font-size: 1.15rem; margin-bottom: 11px; }
  .r-title { color: #f2f3f5; font-weight: 700; font-size: 0.98rem; margin-bottom: 5px; }
  .r-body { color: #949ba4; font-size: 0.87rem; }
  .r-body code, .codechip { font-family: ui-monospace, monospace; font-size: 0.82em; background: #232428; color: #b5bac1;
            padding: 1px 6px; border-radius: 5px; }
  .strike { text-decoration: line-through; color: #6d7178; }
  .pill-link { display: inline-block; margin-top: 9px; font-family: ui-monospace, monospace; font-size: 0.78rem;
               color: #a9b0ff; background: #232428; border: 1px solid #3a3c42; border-radius: 6px; padding: 3px 9px; text-decoration: none; }
  .pill-link:hover { border-color: #5865f2; }
  .inj-banner { margin-top: 16px; background: #232428; border-left: 3px solid #5865f2; border-radius: 8px;
                padding: 13px 16px; color: #b5bac1; font-size: 0.87rem; display: flex; gap: 11px; align-items: flex-start; }
  /* comparison table */
  .cmp-wrap { overflow-x: auto; margin-top: 30px; border: 1px solid #26282c; border-radius: 12px; }
  table.cmp { border-collapse: collapse; width: 100%; min-width: 460px; font-size: 0.9rem; }
  table.cmp th, table.cmp td { padding: 12px 14px; text-align: left; border-bottom: 1px solid #26282c; }
  table.cmp thead th { color: #949ba4; font-size: 0.78rem; text-transform: uppercase; letter-spacing: .04em; font-weight: 700; }
  table.cmp th.us { color: #f2f3f5; }
  table.cmp td.us { background: rgba(88,101,242,.07); }
  table.cmp td.feat { color: #dbdee1; }
  table.cmp .yes { color: #23a55a; font-weight: 700; }
  table.cmp .no { color: #6d7178; }
  table.cmp tbody tr:last-child td { border-bottom: 0; }
  /* steps */
  .steps { display: flex; gap: 16px; margin-top: 32px; }
  .step { flex: 1; background: #2b2d31; border: 1px solid #26282c; border-radius: 12px; padding: 16px; min-width: 0; }
  .step-num { width: 26px; height: 26px; border-radius: 50%; background: #5865f2; color: #fff; font-weight: 800;
              font-size: 0.85rem; display: flex; align-items: center; justify-content: center; margin-bottom: 10px; }
  .step h3 { color: #f2f3f5; font-size: 0.98rem; margin-bottom: 5px; }
  .step p { color: #949ba4; font-size: 0.86rem; }
  .terminal { margin-top: 12px; background: #1a1b1e; border: 1px solid #26282c; border-radius: 9px; overflow: hidden; }
  .term-bar { display: flex; align-items: center; gap: 6px; padding: 8px 11px; border-bottom: 1px solid #26282c; }
  .term-bar i { width: 8px; height: 8px; border-radius: 50%; display: block; }
  .term-bar .cp { margin-left: auto; font-size: 0.72rem; color: #949ba4; background: none; border: 0; cursor: pointer; font-family: inherit; }
  .term-body { padding: 12px; font-family: ui-monospace, monospace; font-size: 0.8rem; color: #b5bac1;
               white-space: pre-wrap; word-break: break-word; }
  .term-body .flag { color: #949ba4; }
  .term-note { color: #949ba4; font-size: 0.78rem; margin-top: 8px; }
  .deploy-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 20px; }
  .dcard { background: #232428; border: 1px solid #26282c; border-radius: 12px; padding: 15px; color: #949ba4; font-size: 0.87rem; }
  .dcard b { color: #dbdee1; }
  /* features */
  .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 16px; margin-top: 32px; }
  .feature { background: #2b2d31; border: 1px solid #26282c; border-radius: 12px; padding: 16px; }
  .f-icon { font-size: 1.5rem; margin-bottom: 9px; }
  .feature h3 { color: #f2f3f5; font-size: 0.96rem; margin-bottom: 5px; }
  .feature p { color: #949ba4; font-size: 0.86rem; }
  /* final cta */
  .final { background: radial-gradient(120% 120% at 50% 0%, rgba(88,101,242,.22) 0%, rgba(30,31,34,0) 60%); }
  .final-card { text-align: center; }
  /* footer */
  footer { border-top: 1px solid #26282c; padding: 26px 0; }
  footer .wrap { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; }
  .sig { color: #949ba4; font-size: 0.82rem; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
                     clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  a:focus-visible, button:focus-visible, .btn:focus-visible, .cp:focus-visible {
    outline: 2px solid #a9b0ff; outline-offset: 2px; border-radius: 4px; }
  /* animations */
  @keyframes recpulse { 0%,100%{opacity:1; box-shadow:0 0 0 0 rgba(218,55,60,.5)} 50%{opacity:.55; box-shadow:0 0 0 5px rgba(218,55,60,0)} }
  @keyframes wave { 0%,100%{transform:scaleY(.4)} 50%{transform:scaleY(1)} }
  @keyframes beamdot { 0%{transform:translateY(0); opacity:0} 20%{opacity:1} 80%{opacity:1} 100%{transform:translateY(46px); opacity:0} }
  @keyframes reveal { from{opacity:0; transform:translateY(6px)} to{opacity:1; transform:none} }
  .beam .d1 { animation: beamdot 2.2s linear infinite; } .beam .d2 { animation: beamdot 2.2s linear infinite 1.1s; }
  @media (max-width: 760px) {
    .hero-split { flex-direction: column; }
    .panel-call { flex-basis: auto; } .panel-chat { flex-basis: auto; }
    .beam { display: none; }
    .wave i { animation: none !important; }
    .steps { flex-direction: column; }
    .receipts, .deploy-cards { grid-template-columns: 1fr; }
    /* nav cabe em 375px: some com os links de texto (estão no herói/rodapé), fica marca + EN·PT */
    .topnav .wrap { gap: 8px; }
    .navlinks { gap: 4px; }
    .navlinks > a { display: none; }
  }
  @media (max-width: 640px) {
    /* tabela vs Craig vira cards empilhados: a coluna Kassinão aparece SEM scroll horizontal */
    .cmp-wrap { overflow-x: visible; border: 0; }
    table.cmp { min-width: 0; }
    table.cmp thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    table.cmp tr { display: block; border: 1px solid #26282c; border-radius: 10px; margin-bottom: 10px; padding: 4px 0; }
    table.cmp td { display: flex; justify-content: space-between; gap: 12px; border: 0; padding: 8px 14px; }
    table.cmp td.feat { font-weight: 700; color: #f2f3f5; border-bottom: 1px solid #26282c; }
    table.cmp td.us { background: none; }
    table.cmp td:not(.feat)::before { content: attr(data-col); color: #949ba4; }
  }
  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; transition: none !important; }
  }
`;

/**
 * Vitrine pública em "/". Documento próprio (full-width), fora do shell() estreito.
 * Indexável, bilíngue (?lang=), self-contained sob a CSP. Direção fixada por um
 * workflow multiagente (divergir→julgar→sintetizar) + teardown adversarial.
 */
export function landingPage(lang: Locale): string {
  const pt = lang === 'pt';
  const T = (ptStr: string, enStr: string): string => (pt ? ptStr : enStr);
  const metaTitle = T(
    'Kassinão — Pare de ler transcrição. Pergunte às suas reuniões.',
    'Kassinão — Stop reading transcripts. Ask your meetings.',
  );
  const metaDesc = T(
    'Gravador de voz do Discord, open-source e no seu servidor, que transforma cada call em memória que a sua IA responde. Pergunte "o que ficou pendente essa semana?" no Claude ou Cursor e receba a decisão, o responsável e um link pro segundo exato — gravação multipista, transcrição por pessoa e ata de IA. O Craig, mas que lembra.',
    'Self-hosted, open-source Discord voice recorder that turns every call into memory your AI assistant can answer. Ask "what\'s pending this week?" from Claude or Cursor and get the decision, the owner, and a link to the exact second — multi-track recording, per-speaker transcript, AI minutes. Craig, but it remembers.',
  );

  const langToggle = `<div class="langtoggle"><a href="?lang=en"${!pt ? ' class="on"' : ''}>EN</a><span>·</span><a href="?lang=pt"${pt ? ' class="on"' : ''}>PT</a></div>`;

  const langUrl = `${config.baseUrl}/?lang=${pt ? 'pt' : 'en'}`;

  const repoPublic = config.repoPublic;
  // "recibo" access.ts: link real só quando o repo é público; senão texto puro (sem 404)
  const accessReceipt = repoPublic
    ? `<a class="pill-link" href="${REPO_URL}/blob/main/src/web/access.ts">&lt;/&gt; checkAccess() · access.ts →</a>`
    : `<span class="pill-link">&lt;/&gt; checkAccess() · src/web/access.ts</span>`;

  // ---- HERO ----
  const avatars: [string, string][] = [
    ['P', '#5865f2'],
    ['R', '#23a55a'],
    ['M', '#f0b232'],
    ['T', '#00a8fc'],
    ['J', '#eb459e'],
    ['S', '#5865f2'],
  ];
  const names = ['Priya', 'Rafael', 'Mei', 'Tobias', 'James', 'Sofia'];
  const wave = (live: boolean): string =>
    `<span class="wave${live ? ' live' : ''}"><i></i><i></i><i></i><i></i><i></i><i></i></span>`;
  const speakers = names
    .map((n, i) => {
      const [ini, bg] = avatars[i];
      return `<div class="spk"><span class="avatar" style="background:${bg}">${ini}</span><span class="nm">${n}</span>${wave(i < 2)}</div>`;
    })
    .join('');

  const beam = `<svg class="beam" viewBox="0 0 40 60" aria-hidden="true"><defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5865f2" stop-opacity="0"/><stop offset="0.5" stop-color="#5865f2" stop-opacity=".9"/><stop offset="1" stop-color="#5865f2" stop-opacity="0"/></linearGradient></defs><line x1="20" y1="6" x2="20" y2="54" stroke="url(#bg)" stroke-width="2"/><path d="M15 48 L20 55 L25 48" fill="none" stroke="#5865f2" stroke-width="2" stroke-opacity=".8"/><circle class="d1" cx="20" cy="8" r="2.5" fill="#a9b0ff"/><circle class="d2" cx="20" cy="8" r="2.5" fill="#a9b0ff"/></svg>`;

  const recTag = T('[GRAVANDO]', '[RECORDING]');
  const chatQuestion = T('o que ficou pra essa semana?', "what's due this week?");
  const ansRow = (task: string, owner: string, due: string, ts: string): string =>
    `<div class="ans-row"><span class="sdot"></span><span class="tk">${task}</span><span class="ans-meta"><span class="pill pill-owner">${owner}</span><span class="pill pill-due">${due}</span><a class="ts" href="/demo">▶ ${ts}</a></span></div>`;
  const answerRows =
    ansRow(
      T('Dar merge no rollback do onboarding + feature-flag', 'Merge the onboarding rollback + feature-flag it'),
      'Rafael',
      T('qua', 'Wed'),
      '16:10',
    ) +
    ansRow(
      T('Rodar o load test no staging e compartilhar os números', 'Run the load test against staging + share numbers'),
      'Mei',
      T('qua', 'Wed EOD'),
      '5:20',
    ) +
    ansRow(
      T('Finalizar e-mail de lançamento + changelog', 'Finalize launch email + changelog'),
      'Priya',
      T('qui', 'Thu'),
      '55:30',
    );

  const flow = `<div class="flow">
      <span class="chip">🎙️ ${T('Grava a call', 'Record the call')}</span>
      <span class="arrow">→</span>
      <span class="chip">✍️ ${T('Transcreve por pessoa', 'One track per person')}</span>
      <span class="arrow">→</span>
      <span class="chip">🤖 ${T('Pergunta pra sua IA', 'Ask in your AI')}</span>
    </div>`;
  const hero = `<section class="hero"><div class="wrap">
    <div class="eyebrow">🎙️ <span>${T('Bot open-source pro seu Discord', 'Open-source bot for your Discord')}</span></div>
    <h1>${T('Grava as calls do Discord.<br><span class="accent">Depois é só perguntar pra IA.</span>', 'Record your Discord calls.<br><span class="accent">Then just ask your AI.</span>')}</h1>
    <p class="lead">${T(
      'O Kassinão grava cada pessoa numa faixa, escreve a transcrição e a ata sozinho, e conecta em qualquer assistente de IA — Claude, Cursor e outros — pra você <b>só perguntar</b> o que foi decidido, em vez de ler.',
      'Kassinão records each caller on their own track, writes the transcript and minutes for you, and plugs into any AI assistant — Claude, Cursor, and more — so you just <b>ask</b> what was decided instead of reading it.',
    )}</p>
    ${flow}
    <div class="ctarow">
      <a class="btn btn-primary" href="/demo">${T('▶️ Ver a demo ao vivo', '▶️ See the live demo')}</a>
      <a class="btn btn-outline" href="${ghHref()}">${T('Rodar no meu servidor →', 'Deploy your own →')}</a>
    </div>
    <div class="microline">${T('Sem login pra ver a demo', 'No login to see the demo')} · <b>${T('roda no seu servidor', 'runs on your box')}</b> · ${T('open-source, AGPL-3.0', 'open-source, AGPL-3.0')}</div>

    <div class="hero-split">
      <div class="panel panel-call">
        <div class="dc-head"><span class="rec-dot"></span><span class="ch">🔊 product-sync</span><span class="rec-pill">${recTag}</span></div>
        ${speakers}
      </div>
      ${beam}
      <div class="panel panel-chat">
        <div class="chrome"><i style="background:#da373c"></i><i style="background:#f0b232"></i><i style="background:#23a55a"></i><span class="lbl mono">Claude · kassinao</span></div>
        <div class="bubble bubble-user">${chatQuestion}</div>
        <div class="bubble bubble-ai">
          <span class="toolchip mono">🔌 kassinao · pending_actions</span>
          <div class="ans-head">${T('3 pra essa semana', '3 due this week')}</div>
          ${answerRows}
          <div class="ans-foot mono">via kassinao-mcp · product-sync · 6 ${T('pessoas', 'speakers')}</div>
        </div>
      </div>
    </div>
  </div></section>`;

  // ---- ASK + TRUST (fundidos: o MCP é o valor E a história de privacidade) ----
  const qcard = (glow: boolean, q: string, tool: string, ans: string, badge?: string): string =>
    `<div class="qcard${glow ? ' glow' : ''}"><div class="qprompt"><span class="arrow">›</span><span>${q}</span></div>
      <div class="qtool"><span class="toolchip mono">🔌 ${tool}</span></div>
      <div class="qans">${ans}</div>${badge ? `<span class="qbadge">${badge}</span>` : ''}</div>`;
  const receipt = (icon: string, title: string, body: string): string =>
    `<div class="receipt"><div class="r-icon">${icon}</div><div class="r-title">${title}</div><div class="r-body">${body}</div></div>`;
  const askSection = `<section><div class="wrap">
    <div class="kicker">${T('O pulo do gato', 'The part nobody else ships')}</div>
    <h2>${T('Suas calls viram memória que a sua IA responde.', 'You ask in plain language. It answers with a timestamp.')}</h2>
    <p class="lead">${T(
      'Gravar todo mundo faz — o diferencial é perguntar. O Kassinão se pluga na sua IA via <b>MCP</b> (o padrão aberto pra conectar ferramentas a assistentes de IA): você fala em português normal e ele puxa a decisão, quem ficou de fazer e o link pro minuto certo. Funciona no Claude, no Cursor e em qualquer cliente MCP — só leitura, e só o que a SUA identidade do Discord já enxergava.',
      'A transcript is a wall of text. Instead, Kassinão plugs into your AI through <b>MCP</b> (the open standard for connecting tools to AI assistants): you ask in plain language and it pulls the decision, the owner, and a link to the exact second. Works in Claude, Cursor, and any MCP client — read-only, and only what your Discord identity can already see.',
    )}</p>
    <div class="grid-cards">
      ${qcard(true, T('⏳ O que tá pendente, e quem ficou de fazer?', "⏳ What's still open, and who owns it?"), 'pending_actions', T('Rollback do onboarding — Rafael, qua · Load test — Mei, qua EOD · E-mail de lançamento — Priya, qui', 'Onboarding rollback — Rafael, Wed · Load test — Mei, Wed EOD · Launch email — Priya, Thu'), T('cruza TODAS as calls', 'across ALL your calls'))}
      ${qcard(false, T('🗣️ Quem falou do pico de churn?', '🗣️ Who brought up the churn spike?'), 'who_said', T('Rafael, sobre o tour de onboarding <a class="ts" href="/demo">▶ 16:10</a>', 'Rafael, on the onboarding tour <a class="ts" href="/demo">▶ 16:10</a>'))}
      ${qcard(false, T('🔎 Onde decidimos subir o preço anual?', '🔎 When did we decide to ship annual pricing?'), 'search_meetings', T('100% — +18% de conversão a 20% de rollout <a class="ts" href="/demo">▶ 29:40</a>', '100% — +18% conversion at 20% rollout <a class="ts" href="/demo">▶ 29:40</a>'))}
      ${qcard(false, T('📅 O que rolou essa semana?', '📅 What happened this week?'), 'list_meetings', T('Todas as calls, da mais nova pra mais velha — e por janela de datas.', 'Every call on record, newest first — date ranges too.'))}
      ${qcard(false, T('📄 Abre a ata inteira da product-sync', '📄 Give me the full product-sync'), 'get_meeting', T('Resumo + decisões + ações + timeline, saltando pra qualquer segundo.', 'Summary + decisions + actions + timeline, jump to any second.'))}
    </div>
    <div class="kicker" style="margin-top:44px">${T('Sem pegadinha', 'Read the source, not the promise')}</div>
    <h2>${T('Sua IA só vê as calls que você já veria. Nunca mais que isso.', 'Your AI sees the calls you could already see. Never more.')}</h2>
    <div class="receipts" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">
      ${receipt('👁️', T('Acesso pela sua identidade do Discord', 'By your Discord identity'), T('Reconferido ao vivo a cada gravação — você iniciou, participou, enxerga o canal ou tem Gerenciar Servidor. Não existe modo "dono vê tudo".', 'Re-checked live per meeting — you started it, you were in it, you can see the channel, or you have Manage-Server. No "operator sees all" mode.') + `<br>${accessReceipt}`)}
      ${receipt('🔒', T('Read-only, revogável', 'Read-only, revocable'), T('O conector não grava, não apaga, não serve áudio. O token gira a cada uso, detecta reuso e trava em 503 (fail-closed). Revoga quando quiser (', 'The connector never writes, deletes, or serves audio. The token rotates each use, trips reuse-detection, and fails closed with a 503. Revoke anytime (') + `<code>/mcp revoke-all</code>).`)}
      ${receipt('🖥️', T('Roda na sua máquina', 'Runs on your box'), T('Áudio e transcrição 100% local (faster-whisper) — a gravação nunca sai daí. Só a ata usa um LLM na nuvem (OpenRouter ou Groq), ou você desliga a ata. Sem fingir que é offline.', "Audio and transcription can run 100% local (faster-whisper) — the recording never leaves your box. Only the AI minutes use a cloud LLM (OpenRouter or Groq), or you turn minutes off. We won't pretend otherwise."))}
    </div>
    <div class="inj-banner"><span>🔓</span><span>${T('Tudo é open-source — o bot, a página web e o conector MCP. Licença AGPL-3.0, no seu servidor. Não confia: lê o código.', "The whole thing is open-source — the bot, the web app, and the MCP connector. AGPL-licensed, on your box. Don't trust it — read it.")} ${repoPublic ? `<a class="pill-link" href="${REPO_URL}">${REPO_URL.replace('https://', '')} →</a>` : `<a class="pill-link" href="${NPM_URL}">npm: kassinao-mcp →</a>`}</span></div>
  </div></section>`;

  // ---- PROOF: real demo minutes ----
  const dec = (ptS: string, enS: string): string => `<li>${T(ptS, enS)}</li>`;
  const mcAction = (task: string, meta: string, ts: string): string =>
    `<div class="mc-action"><a class="ts" href="/demo">${ts}</a><span class="task">${task}</span><span class="meta2">${meta}</span></div>`;
  const proofSection = `<section><div class="wrap">
    <div class="kicker">${T('Não é maquete', 'Not a mockup')}</div>
    <h2>${T('Uma call de verdade, do começo ao fim.', 'Six people, 58 minutes, zero note-taking.')}</h2>
    <p class="lead">${T('Sync de produto da Northwind, 6 pessoas, ~58 min. O Kassinão sozinho fechou as decisões e as ações com dono e prazo — cada item linka pro segundo em que rolou. Ninguém digitou isso. Abre e confere, sem login.', 'The actual output of the public demo — a real Northwind product-sync. Decisions with owners, action items with due dates, every line linked to the second it was said. Open it and pick it apart. No login.')}</p>
    <div class="minutes-card">
      <div class="mc-head"><span class="bc">🎙️ product-sync · Northwind (demo) · 👥 6 · 58:12</span><span class="mc-badge">${T('✅ FINALIZADA', '✅ FINISHED')}</span><span class="ai-pill">${T('gerado por IA', 'AI-generated')}</span></div>
      <div class="mc-h3">${T('RESUMO', 'SUMMARY')}</div>
      <p class="mc-sum">${T(
        'O time revisou a prontidão do lançamento do dashboard v3, ligou o pico de churn ao novo fluxo de onboarding e aprovou o experimento de preço do plano anual.',
        'The team reviewed v3 dashboard launch readiness, traced a churn spike to the new onboarding flow, and green-lit the annual pricing experiment.',
      )}</p>
      <div class="mc-h3">${T('DECISÕES', 'DECISIONS')}</div>
      <ul class="mc-ul">
        ${dec('Dashboard v3 lança na quinta que vem, condicionado à correção do onboarding + load test passando.', 'v3 dashboard launches next Thursday, gated on the onboarding fix + a passing load test.')}
        ${dec('Reverter o tour obrigatório do novo onboarding (bate com o pico de churn).', "Roll back the new onboarding flow's mandatory tour (correlates with the churn spike).")}
        ${dec('Subir o experimento de preço do plano anual pra 100% (era +18% de conversão a 20% de rollout).', 'Ship the annual-plan pricing experiment to 100% (was +18% conversion at 20% rollout).')}
        ${dec('Abrir vaga pra um segundo engenheiro de infra/SRE.', 'Open a headcount for a second infra/SRE engineer.')}
      </ul>
      <div class="mc-h3">${T('ITENS DE AÇÃO', 'ACTION ITEMS')}</div>
      ${mcAction(T('Dar merge no rollback do onboarding + feature-flag', 'Merge the onboarding rollback + feature-flag it'), 'Rafael · ' + T('qua', 'Wed'), '16:10')}
      ${mcAction(T('Rodar o load test no staging e compartilhar os números', 'Run the load test against staging and share numbers'), 'Mei · ' + T('qua', 'Wed EOD'), '5:20')}
      ${mcAction(T('Finalizar e-mail de lançamento + changelog, agendar qui 9h', 'Finalize launch email + changelog, schedule for Thu 9am'), 'Priya · ' + T('qui', 'Thu'), '55:30')}
    </div>
    <div class="ctarow"><a class="btn btn-primary" href="/demo">${T('▶️ Abrir a gravação inteira', '▶️ Open the whole recording')}</a></div>
  </div></section>`;

  // Craig sobrevive só como aside no setup (de-Craig: não é o eixo da landing)
  const craigLine = T(
    'Já grava com o Craig? O Kassinão é a camada de IA que ele manda você comprar em outro lugar.',
    'Already recording with Craig? Kassinão is the memory layer he tells you to buy somewhere else.',
  );

  // ---- SETUP + COST ----
  const cmd = `KASSINAO_URL=${config.baseUrl} npx -y kassinao-mcp exchange <code>`;
  const setupSection = `<section><div class="wrap">
    <div class="kicker">${T('Sobe em 3 passos', "Docker up, and it's yours")}</div>
    <h2>${T('No ar em minutos, no seu servidor.', 'A Discord app, a container, your keys. Done.')}</h2>
    <div class="steps">
      <div class="step"><div class="step-num">1</div><h3>${T('Suba o bot', 'Boot the bot')}</h3><p>${T('Um app do Discord + Docker Compose, ou o blueprint Deploy-to-Render. HTTPS via Cloudflare Tunnel, sem abrir porta.', 'A Discord app + Docker Compose, or the Deploy-to-Render blueprint. HTTPS via Cloudflare Tunnel, no open ports.')}</p></div>
      <div class="step"><div class="step-num">2</div><h3>${T('Grave', 'Record')}</h3><p>${T('Entra na call e /gravar, ou auto-grava quando 2+ pessoas entram — com ' + recTag + ' no apelido e um painel ao vivo. Consentimento visível, nunca secreto.', 'Join the voice channel and /gravar, or auto-record when 2+ people join — with a ' + recTag + ' nickname tag and a live panel. Visible consent, never covert.')}</p></div>
      <div class="step"><div class="step-num">3</div><h3>${T('Conecte', 'Connect')}</h3><p>${T('Abra /conectar-ia, entre com o Discord e rode o comando pra plugar o Claude ou o Cursor:', 'Open /conectar-ia, sign in with Discord, and run the command to connect Claude or Cursor:')}</p>
        <div class="terminal"><div class="term-bar"><i style="background:#da373c"></i><i style="background:#f0b232"></i><i style="background:#23a55a"></i><button class="cp mono" id="kcp" type="button">⧉ ${T('copiar', 'copy')}</button></div><div class="term-body mono" id="kcmd">${esc(cmd)}</div></div>
        <div class="term-note">${T('código válido ~5 min, uso único · ', 'code valid ~5 min, single use · ')}<span class="codechip">npx -y kassinao-mcp</span> · 5 ${T('ferramentas', 'tools')}</div>
      </div>
    </div>
    <div class="deploy-cards">
      <div class="dcard">🐳 <b>Docker Compose</b> · ${repoPublic ? `<a class="ts" href="https://render.com/deploy?repo=${REPO_URL}">🚀 Deploy to Render</a>` : '🚀 Deploy to Render'} · 🔒 Cloudflare Tunnel — 0 ${T('portas abertas', 'open ports')}</div>
      <div class="dcard">${T('Custo, direto: a transcrição é BYO-key e só a FALA é enviada (VAD corta o silêncio) — o custo acompanha o tempo falado, não pessoas × horas; free tiers cobrem times pequenos. A ata roda uma vez, alguns centavos. Ou 100% local (faster-whisper) e some com o custo.', 'Cost, straight: transcription is bring-your-own-key and only SPEECH is sent (VAD trims silence) — cost tracks talk time, not people × hours; free tiers cover small teams. Minutes run once, a few cents. Or go 100% local (faster-whisper) and the bill disappears.')}</div>
    </div>
    <p class="microline" style="margin-top:18px">${craigLine}</p>
  </div></section>`;

  // ---- FINAL CTA ----
  const finalSection = `<section class="final"><div class="wrap final-card">
    <h2>${T('Sua próxima call merece ser lembrada.', 'Your next call is worth remembering.')}</h2>
    <p class="lead" style="margin:14px auto 0">${T('Sobe no seu servidor em minutos, grava a primeira call e pergunta pra sua IA o que ficou combinado. Seu servidor, sua chave, seus dados.', 'Deploy it on your own server in minutes, record your first call, and ask your AI what everyone agreed to. Your server, your keys, your data.')}</p>
    <div class="ctarow">
      <a class="btn btn-primary" href="/demo">${T('▶️ Ver a demo ao vivo', '▶️ See the live demo')}</a>
      <a class="btn btn-outline" href="${ghHref()}">${T('Rodar no meu servidor →', 'Deploy your own →')}</a>
    </div>
  </div></section>`;

  const topnav = `<div class="topnav"><div class="wrap">
    <a class="brand" href="/">🎙️ Kassinão</a>
    <div class="navlinks">
      <a href="/demo">${T('Demo', 'Demo')}</a>
      <a href="${ghHref()}">${repoPublic ? 'GitHub' : 'npm'}</a>
      <a class="btn btn-primary btn-sm" href="/demo">${T('Ver a demo', 'See the demo')}</a>
      ${langToggle}
    </div>
  </div></div>`;

  const footer = `<footer><div class="wrap">
    <span class="sig">${T('AGPL-3.0 · open-source · roda no seu servidor · EN / pt-BR', 'AGPL-3.0 · open-source · runs on your server · EN / pt-BR')}</span>
    <span class="sig">${repoPublic ? `<a href="${REPO_URL}" style="color:inherit">GitHub</a> · ` : ''}<a href="${NPM_URL}" style="color:inherit">npm: kassinao-mcp</a></span>
    ${langToggle}
  </div></footer>`;

  const copyScript = `<script>(function(){var b=document.getElementById('kcp');if(!b)return;b.addEventListener('click',function(){var t=(document.getElementById('kcmd').textContent)||'';navigator.clipboard.writeText(t).then(function(){var o=b.textContent;b.textContent='${T('copiado ✓', 'copied ✓')}';setTimeout(function(){b.textContent=o;},2000);});});})();</script>`;

  return `<!doctype html>
<html lang="${pt ? 'pt-BR' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#1e1f22">
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
${hero}
${askSection}
${proofSection}
${setupSection}
${finalSection}
${footer}
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
