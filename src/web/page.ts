import { config } from '../config';
import { localizeEvent, Locale } from '../i18n';
import { msToClock } from '../processing/transcribe';
import { formatDuration, formatOffset } from '../recorder/RecordingSession';
import { MAX_NOTES_PER_RECORDING, MAX_PRESENCE_IDENTITIES_PER_RESPONSE } from '../securityLimits';
import {
  audioExpiryOf,
  boundMinutesForResponse,
  MeetingMinutes,
  RecordingMeta,
  textExpiryOf,
  TranscriptSegment,
  transcriptionNeedsAudio,
} from '../store';
import { shortError } from '../util';
import type { WebUser } from './auth';
import { APP_CSS } from './appStyles';
import { CSP_NONCE_ATTR } from './csp';
import type { SessionSummary } from './mcpTokens';
import type { WebSearchHit } from './search';
import { PUBLIC_LINKS, publicSite } from './site';

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
    pt: 'Gravação em andamento. O áudio, a transcrição e a ata aparecem aqui depois que a call terminar. Esta página se atualiza sozinha.',
    en: 'Recording in progress. Audio, transcript, and meeting notes appear here after the call ends. This page refreshes itself automatically.',
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

const TZ_SCRIPT = `<script${CSP_NONCE_ATTR}>
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
  var target = null, next = null;
  for (var i = 0; i < paras.length; i++) {
    var start = +paras[i].dataset.s, end = +paras[i].dataset.e;
    if (start <= ms && ms <= end + 1500) { target = paras[i]; break; }
    if (!next && start >= ms) next = paras[i];
  }
  target = target || next || paras[paras.length - 1];
  if (target) target.scrollIntoView({block:'center', behavior:sb});
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
  return `<a class="ts" href="#" data-seek-ms="${v}">${msToClock(v)}</a>`;
}

// Tema aplicado antes da pintura. Usa a preferência salva ou a do sistema.
const THEME_INIT = `<script${CSP_NONCE_ATTR}>(function(){try{var t=localStorage.getItem('ktheme');if(t!=='light'&&t!=='dark')t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';document.documentElement.dataset.theme=t;}catch(e){}})();</script>`;
const THEME_TOGGLE_SCRIPT = `<script${CSP_NONCE_ATTR}>(function(){var b=document.querySelector('.thm');if(!b)return;var d=document.documentElement;function sync(){var light=d.dataset.theme==='light';b.setAttribute('aria-pressed',String(light));b.setAttribute('aria-label',light?b.dataset.toDark:b.dataset.toLight);}sync();b.addEventListener('click',function(){var t=d.dataset.theme==='light'?'dark':'light';d.dataset.theme=t;try{localStorage.setItem('ktheme',t);}catch(e){}sync();});})();</script>`;
const APP_LOCALE_LINKS_SCRIPT = `<script${CSP_NONCE_ATTR}>(function(){document.querySelectorAll('[data-app-locale]').forEach(function(a){try{var u=new URL(location.href);u.searchParams.set('lang',a.dataset.appLocale);a.href=u.pathname+u.search+u.hash;}catch(e){}});})();</script>`;
const SAFE_INTERACTIONS_SCRIPT = `<script${CSP_NONCE_ATTR}>(function(){
document.addEventListener('click',function(e){
  var link=e.target.closest&&e.target.closest('[data-seek-ms]');
  if(!link)return;
  var ms=Number(link.dataset.seekMs);
  if(!Number.isFinite(ms)||!window.kseek)return;
  e.preventDefault();window.kseek(ms);
});
document.addEventListener('submit',function(e){
  var form=e.target;
  var message=form&&form.dataset&&form.dataset.confirm;
  if(message&&!window.confirm(message))e.preventDefault();
});
})();</script>`;

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
    /** O código MCP aparece uma única vez; trocar idioma nessa resposta o perderia. */
    lockLocale?: boolean;
  } = {},
): string {
  const lang = opts.lang === 'pt' ? 'pt' : 'en';
  const pt = lang === 'pt';
  const publicContext = publicSite(opts.demo ? 'demo' : 'home', lang, config);
  const demoEn = publicSite('demo', 'en', config).canonicalUrl;
  const demoPt = publicSite('demo', 'pt', config).canonicalUrl;
  const langToggle = opts.lockLocale
    ? ''
    : opts.demo
      ? `<div class="langtoggle" aria-label="${pt ? 'Idioma' : 'Language'}"><a href="${demoEn}"${lang === 'en' ? ' class="on" aria-current="page"' : ''} lang="en">EN</a><a href="${demoPt}"${lang === 'pt' ? ' class="on" aria-current="page"' : ''} lang="pt-BR">PT</a></div>`
      : `<div class="langtoggle" aria-label="${pt ? 'Idioma' : 'Language'}"><a href="?lang=en" data-app-locale="en"${lang === 'en' ? ' class="on" aria-current="page"' : ''}>EN</a><a href="?lang=pt" data-app-locale="pt"${lang === 'pt' ? ' class="on" aria-current="page"' : ''}>PT</a></div>`;
  // A demo é uma prova pública com dados fictícios. O app continua isolado sob
  // /app, com autenticação, ACL e navegação próprias.
  const brand = `<a class="brand" href="${opts.demo ? publicContext.links.home : '/app'}"><img src="/assets/kassinao-mark.png" width="26" height="26" alt=""><span>Kassinão</span></a>`;
  const nav = opts.demo
    ? `<nav aria-label="${pt ? 'Navegação principal' : 'Main navigation'}"><a href="${publicContext.links.docs}">Docs</a><a href="${publicContext.links.mcp}" target="_blank" rel="noopener noreferrer">MCP</a><a href="${PUBLIC_LINKS.github}" target="_blank" rel="noopener noreferrer">GitHub</a></nav>`
    : opts.user
      ? `<nav class="sidebar-nav" aria-label="${pt ? 'Navegação do app' : 'App navigation'}"><a href="/app"${opts.active === 'rec' ? ' aria-current="page"' : ''}>${pt ? 'Reuniões' : 'Meetings'}</a>${
          config.mcpEnabled
            ? `<a href="/app/conectar-ia"${opts.active === 'ai' ? ' aria-current="page"' : ''}>${pt ? 'Conectar IA' : 'Connect AI'}</a>`
            : ''
        }</nav>`
      : '';
  const themeBtn = `<button type="button" class="thm" aria-pressed="false" data-to-light="${pt ? 'Mudar para tema claro' : 'Switch to light theme'}" data-to-dark="${pt ? 'Mudar para tema escuro' : 'Switch to dark theme'}"><span class="to-light">${pt ? 'Claro' : 'Light'}</span><span class="to-dark">${pt ? 'Escuro' : 'Dark'}</span></button>`;
  const signIn = `<a class="tl" href="/auth/login?next=%2Fapp">${pt ? 'Entrar' : 'Sign in'}</a>`;
  const userIdentity = opts.user
    ? `<span class="user">${opts.user.avatar ? `<img src="${esc(opts.user.avatar)}" alt="">` : `<span class="user-initial" aria-hidden="true">${esc(opts.user.name.slice(0, 1).toUpperCase())}</span>`}<span class="user-name">${esc(opts.user.name)}</span></span>`
    : '';
  const logout = opts.user
    ? `<form class="logout-form" method="post" action="/app/logout"><button class="tl" type="submit">${pt ? 'Sair' : 'Sign out'}</button></form>`
    : '';
  const right = opts.demo
    ? `${themeBtn}${langToggle}`
    : opts.user
      ? `${themeBtn}${langToggle}${userIdentity}${logout}`
      : `${themeBtn}${langToggle}${signIn}`;
  const userbar = `<header class="topbar">${brand}${nav}<span class="topnav-r">${right}</span></header>`;
  const foot = opts.demo
    ? `<footer class="topfoot"><a href="${publicContext.links.home}">Kassinão</a>. <a href="${publicContext.links.docs}">Docs</a>. Open source. Self-hosted. AGPL-3.0.</footer>`
    : `<footer class="topfoot"><a href="${publicContext.links.docs}">Docs</a>. Kassinão. AGPL-3.0.</footer>`;
  const privateWorkspace = !!opts.user && !opts.demo;
  const shellOpen = privateWorkspace
    ? `<div class="app-shell">
      <aside class="app-sidebar">
        <div class="sidebar-brand">${brand}</div>
        <div class="sidebar-label">${pt ? 'Workspace' : 'Workspace'}</div>
        ${nav}
        <div class="sidebar-spacer"></div>
        <nav class="sidebar-resources" aria-label="${pt ? 'Recursos' : 'Resources'}">
          <span class="sidebar-label">${pt ? 'Recursos' : 'Resources'}</span>
          <a href="${publicContext.links.docs}">Docs</a>
          <a href="${PUBLIC_LINKS.github}" target="_blank" rel="noopener noreferrer">GitHub</a>
        </nav>
        <div class="sidebar-footer">${userIdentity}${logout}</div>
      </aside>
      <section class="app-content">
        <header class="app-topbar">
          <span class="topbar-context">${opts.active === 'ai' ? (pt ? 'Conectar IA' : 'Connect AI') : pt ? 'Reuniões' : 'Meetings'}</span>
          <span class="topbar-product">${pt ? 'Memória das suas calls no Discord' : 'Memory for your Discord calls'}</span>
          <span class="app-topbar-actions">${themeBtn}${langToggle}<span class="mobile-logout">${logout}</span></span>
        </header>`
    : `<div class="public-shell">${userbar}`;
  const shellClose = privateWorkspace ? `${foot}</section></div>` : `${foot}</div>`;
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
<link rel="canonical" href="${publicContext.canonicalUrl}">
<link rel="alternate" hreflang="pt-BR" href="${demoPt}">
<link rel="alternate" hreflang="en" href="${demoEn}">
<link rel="alternate" hreflang="x-default" href="${demoEn}">
<meta property="og:title" content="${esc(documentTitle)}">
<meta property="og:description" content="${esc(demoDescription)}">
<meta property="og:image" content="${config.publicUrl}/og-${lang}.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Kassinão Discord bot">
<meta property="og:url" content="${publicSite('demo', lang, config).canonicalUrl}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">`
    : '<meta name="robots" content="noindex">';
  // Auto-refresh (enquanto transcrição/ata processam) via JS em vez de <meta refresh>,
  // pra NÃO recarregar e cortar o áudio enquanto a pessoa está ouvindo o player.
  // Preserva a posição de leitura (scrollY) entre os reloads.
  const refresh = opts.refreshSeconds
    ? `<script${CSP_NONCE_ATTR}>(function(){
try { var ky = sessionStorage.getItem('k-scroll'); if (ky) { window.scrollTo(0, +ky); sessionStorage.removeItem('k-scroll'); } } catch(e){}
var interval=${opts.refreshSeconds * 1000};
function check(){var p=document.getElementById('kplayer');if(p&&!p.paused&&!p.ended){setTimeout(check,interval);return;}try{sessionStorage.setItem('k-scroll', String(window.scrollY));}catch(e){}location.reload();}
setTimeout(check,interval);})();</script>`
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
<body class="${privateWorkspace ? 'workspace-body' : 'public-body'}${opts.wide ? ' wide' : ''}">
<a class="skip" href="#conteudo">${pt ? 'Pular para o conteúdo' : 'Skip to content'}</a>
${shellOpen}
<main class="app-main" id="conteudo"><div class="page-frame">${body}</div></main>
${shellClose}
${TZ_SCRIPT}
${THEME_TOGGLE_SCRIPT}
${opts.demo || opts.lockLocale ? '' : APP_LOCALE_LINKS_SCRIPT}
${SAFE_INTERACTIONS_SCRIPT}
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
    transcriptNotice?: string;
    minutes?: MeetingMinutes;
    minutesNotice?: string;
    demo?: boolean;
  },
): string {
  const { live, lang: l } = opts;
  const participantCount = meta.participants.length;
  const participantIds = new Set(meta.participants.map((participant) => participant.id));
  const silentPresence = (meta.presence ?? []).filter((presence) => !participantIds.has(presence.id));
  const visibleParticipants = meta.participants.slice(0, MAX_PRESENCE_IDENTITIES_PER_RESPONSE);
  const remainingIdentityNames = Math.max(0, MAX_PRESENCE_IDENTITIES_PER_RESPONSE - visibleParticipants.length);
  const legacyContentTruncated =
    meta.notes.length > MAX_NOTES_PER_RECORDING ||
    meta.participants.length > visibleParticipants.length ||
    silentPresence.length > remainingIdentityNames ||
    meta.events.length > 500;
  meta = {
    ...meta,
    notes: meta.notes.slice(0, MAX_NOTES_PER_RECORDING),
    participants: visibleParticipants,
    presence: silentPresence.slice(0, remainingIdentityNames),
    events: meta.events.slice(0, 500),
  };
  const demo = opts.demo ?? false;
  const minutesView = opts.minutes ? boundMinutesForResponse(opts.minutes) : undefined;
  const visibleMinutes = minutesView?.minutes;
  const seekable = !demo; // no modo demo o áudio é só um trecho, então horários não pulam
  const endedAt = meta.endedAt ?? Date.now();
  const durMs = endedAt - meta.startedAt;
  const badge = live
    ? `<span class="badge live">${p(l, 'live')}</span>`
    : `<span class="badge done">${p(l, 'done')}</span>`;

  // Cabeçalho: contexto essencial sem competir com o conteúdo da reunião.
  const nPeople = participantCount;
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
  const transcriptNotice = opts.transcriptNotice
    ? `<div class="note" style="border-left-color:#f0b232">${esc(opts.transcriptNotice)}</div>`
    : '';
  const minutesNotice = opts.minutesNotice
    ? `<div class="note" style="border-left-color:#f0b232">${esc(opts.minutesNotice)}</div>`
    : minutesView?.truncated
      ? `<div class="note" style="border-left-color:#f0b232">${
          l === 'pt'
            ? 'Parte da ata foi limitada nesta visualização para manter a página estável.'
            : 'Part of the meeting minutes was limited in this view to keep the page stable.'
        }</div>`
      : '';
  const legacyContentNotice =
    !demo && legacyContentTruncated
      ? `<div class="note" style="border-left-color:#f0b232">${
          l === 'pt'
            ? 'Parte do conteúdo histórico foi limitada nesta visualização para manter a página estável.'
            : 'Some historical content was limited in this view to keep the page stable.'
        }</div>`
      : '';

  const minutes = renderMinutes(meta, visibleMinutes, l, seekable);
  const transcription = renderTranscription(meta, opts.transcript, l, seekable);

  const notes =
    meta.notes.length > 0
      ? `<h2>${p(l, 'notes')}</h2><ul class="notes">${meta.notes
          .map(
            (n) =>
              `<li>${seekable ? `<a class="ts" href="#" data-seek-ms="${Math.max(0, Math.floor(n.atMs))}">${formatOffset(n.atMs)}</a>` : `<time>${formatOffset(n.atMs)}</time>`}${clockTime(meta.startedAt + n.atMs, l)}<strong>${esc(n.author)}:</strong> ${esc(n.text)}</li>`,
          )
          .join('')}</ul>`
      : '';

  // Linha do tempo: barra visual clicável e lista dobrável.
  const events = renderTimeline(meta, visibleMinutes, l, durMs, live, seekable);

  // Uma única área de arquivos. O backend bloqueia downloads ao vivo, então a
  // interface não promete nem renderiza ações impossíveis durante a captura.
  const audioFiles =
    !demo && !live && !audioGone && meta.participants.length > 0
      ? `<section class="file-group"><div class="file-group-head"><span>${l === 'pt' ? 'Áudio' : 'Audio'}</span><small>${l === 'pt' ? 'Faixas e mix da call' : 'Tracks and full-call mix'}</small></div>
        <div class="downloads">
          <a class="btn secondary" href="/app/rec/${meta.id}/download/mp3">MP3 <small>${p(l, 'mp3sub')}</small></a>
          <a class="btn secondary" href="/app/rec/${meta.id}/download/flac">FLAC <small>${p(l, 'flacsub')}</small></a>
          <a class="btn secondary" href="/app/rec/${meta.id}/download/mix">Mix <small>${p(l, 'mixsub')}</small></a>
          <a class="btn secondary" href="/app/rec/${meta.id}/download/audacity">Audacity <small>${p(l, 'audacitysub')}</small></a>
        </div>
        <p class="muted">${p(l, 'cooking')}</p></section>`
      : '';
  const textFiles =
    !demo && ((opts.transcript?.length ?? 0) > 0 || !!visibleMinutes)
      ? `<section class="file-group"><div class="file-group-head"><span>${l === 'pt' ? 'Texto' : 'Text'}</span><small>${l === 'pt' ? 'Arquivos leves para compartilhar' : 'Lightweight files to share'}</small></div>
        <div class="downloads">
          ${visibleMinutes && !minutesView?.truncated ? `<a class="btn secondary" href="/app/rec/${meta.id}/ata.md">${p(l, 'minutesDownload')}</a>` : ''}
          ${(opts.transcript?.length ?? 0) > 0 ? `<a class="btn secondary" href="/app/rec/${meta.id}/transcricao.md">${p(l, 'transcriptDownload')}</a><a class="btn secondary" href="/app/rec/${meta.id}/transcricao.txt">${p(l, 'transcriptDownloadTxt')}</a>` : ''}
        </div></section>`
      : '';
  const filesState =
    audioFiles || textFiles
      ? `${audioFiles}${textFiles}`
      : `<div class="panel-state"><strong>${
          live
            ? l === 'pt'
              ? 'Arquivos disponíveis ao encerrar'
              : 'Files available after the call'
            : audioGone
              ? l === 'pt'
                ? 'O áudio já foi liberado'
                : 'Audio has been released'
              : l === 'pt'
                ? 'Nenhum arquivo disponível'
                : 'No files available'
        }</strong><span>${
          live
            ? l === 'pt'
              ? 'Assim que a gravação terminar, o Kassinão prepara áudio, transcrição e ata.'
              : 'As soon as recording ends, Kassinão prepares audio, transcript, and meeting notes.'
            : audioGone
              ? l === 'pt'
                ? 'A memória textual continua disponível nas outras seções.'
                : 'The text memory remains available in the other sections.'
              : l === 'pt'
                ? 'Esta call não gerou material para baixar.'
                : 'This call did not generate downloadable material.'
        }</span></div>`;
  const downloads = `<h2>${l === 'pt' ? 'Arquivos da reunião' : 'Meeting files'}</h2><div class="file-list">${filesState}</div>`;

  // Gestão separada, com a consequência dita antes do clique. O
  // servidor revalida permissão/estado no POST (o confirm() não é a autoridade)
  const manage =
    opts.canDelete && !live && !demo
      ? `<div class="dangerzone">
        ${
          !audioGone && !transcriptionNeedsAudio(meta)
            ? `<form method="post" action="/app/rec/${meta.id}/liberar-audio"
                 data-confirm="${esc(p(l, 'ixFreeSpaceConfirm'))}">
                 <button class="softdanger" type="submit">${p(l, 'ixFreeSpace')}</button><span class="why">${p(l, 'freeWhy')}</span>
               </form>`
            : ''
        }
        <form method="post" action="/app/rec/${meta.id}/delete"
          data-confirm="${esc(p(l, 'delconfirm'))}">
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
       <a class="btn" href="${publicSite('docs', l, config).canonicalUrl}">${l === 'pt' ? 'Como instalar' : 'Setup guide'}</a>
       <a class="btn secondary" href="${publicSite('home', l, config).canonicalUrl}">${l === 'pt' ? 'Voltar ao início' : 'Back home'}</a>
     </div>`
    : '';
  const title = `#${esc(meta.voiceChannelName)}`;

  // A navegação é espacialmente estável em todos os estados: processamento,
  // erro ou ausência de conteúdo mudam o painel, nunca o mapa da reunião.
  const overviewPanel =
    minutes ||
    `<h2>${l === 'pt' ? 'Visão geral' : 'Overview'}</h2><div class="panel-state"><strong>${
      l === 'pt' ? 'A ata não está disponível' : 'Meeting notes are not available'
    }</strong><span>${
      live
        ? l === 'pt'
          ? 'Ela começa a ser preparada quando a call terminar.'
          : 'They start processing after the call ends.'
        : l === 'pt'
          ? 'Você ainda pode consultar transcrição, notas e linha do tempo.'
          : 'You can still check the transcript, notes, and timeline.'
    }</span></div>`;
  const transcriptPanel =
    transcription ||
    `<h2>${p(l, 'transcript')}</h2><div class="panel-state"><strong>${
      l === 'pt' ? 'Sem transcrição nesta call' : 'No transcript for this call'
    }</strong><span>${
      live
        ? l === 'pt'
          ? 'A transcrição começa depois que a gravação termina.'
          : 'Transcription starts after recording ends.'
        : l === 'pt'
          ? 'A reunião pode ter sido gravada sem transcrição habilitada.'
          : 'This meeting may have been recorded with transcription disabled.'
    }</span></div>`;
  const timelinePanel =
    events ||
    `<h2>${p(l, 'timeline')}</h2><div class="panel-state"><strong>${
      l === 'pt' ? 'Nenhum evento registrado' : 'No events recorded'
    }</strong><span>${
      l === 'pt'
        ? 'Entradas, saídas, notas e capítulos aparecem aqui.'
        : 'Joins, leaves, notes, and chapters appear here.'
    }</span></div>`;
  const notesPanel =
    notes ||
    `<h2>${p(l, 'notes')}</h2><div class="panel-state"><strong>${
      l === 'pt' ? 'Nenhuma nota marcada' : 'No notes marked'
    }</strong><span>${
      l === 'pt'
        ? 'Use /nota durante a call para guardar um momento exato.'
        : 'Use /note during the call to save an exact moment.'
    }</span></div>`;
  const panels: Array<[string, string, string]> = [
    ['ata', l === 'pt' ? 'Visão geral' : 'Overview', overviewPanel],
    ['transcricao', p(l, 'transcript'), transcriptPanel],
    ['timeline', p(l, 'timeline'), timelinePanel],
    ['notas', p(l, 'notes'), notesPanel],
    ['exportar', l === 'pt' ? 'Arquivos' : 'Files', downloads],
  ];
  const tabbar = `<div class="tabbar meeting-tabs" role="tablist" aria-label="${
    l === 'pt' ? 'Seções da gravação' : 'Recording sections'
  }">${panels
    .map(
      ([id, label], i) =>
        `<button type="button" role="tab" id="tab-${id}" data-t="${id}" aria-controls="${id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${label}</button>`,
    )
    .join('')}</div>`;
  const panelHtml = panels
    .map(
      ([id, , html]) =>
        `<section class="tpanel" id="${id}" role="tabpanel" aria-labelledby="tab-${id}">${html}</section>`,
    )
    .join('\n');
  const context = `<aside class="recording-context" aria-label="${
    l === 'pt' ? 'Contexto da reunião' : 'Meeting context'
  }">
      <section class="context-section">
        <h2>${l === 'pt' ? 'Sobre a call' : 'About this call'}</h2>
        <dl class="context-facts">
          <div><dt>${p(l, 'server')}</dt><dd>${esc(meta.guildName)}</dd></div>
          <div><dt>${p(l, 'started')}</dt><dd>${datetime(meta.startedAt, l)}</dd></div>
          <div><dt>${p(l, 'duration')}</dt><dd>${formatDuration(durMs)}${live ? p(l, 'counting') : ''}</dd></div>
        </dl>
      </section>
      <section class="context-section">
        <h2>${p(l, 'participants')} <span>${nPeople}</span></h2>
        ${people}${presentAlso}
      </section>
      ${manage ? `<details class="manage-menu"><summary>${l === 'pt' ? 'Gerenciar reunião' : 'Manage meeting'}</summary>${manage}</details>` : ''}
      ${pageFoot}
    </aside>`;
  const workspace = `<div class="recording-layout">
      <div class="recording-stage">
        ${playerDock ? `<div class="player-sticky">${playerDock}</div>` : playerFlow}
        ${tabbar}
        ${panelHtml}
      </div>
      ${context}
    </div>`;

  return shell(
    demo ? `#${meta.voiceChannelName} (demo)` : `#${meta.voiceChannelName} | ${p(l, 'recording')}`,
    `<article class="meeting-page">
      <header class="recording-head">
        <a class="backlink" href="${demo ? publicSite('home', l, config).canonicalUrl : '/app'}">${demo ? (l === 'pt' ? 'Início' : 'Home') : l === 'pt' ? 'Reuniões' : 'Meetings'}</a>
        <div class="recording-titleline"><h1>${title}</h1>${badge}</div>
        ${subline}
        <div class="recording-alerts">${demoNote}${liveNote}${incompleteNote}${transcriptNotice}${minutesNotice}${legacyContentNotice}</div>
      </header>
      ${workspace}
      ${demoCta}
      ${RECORDING_SCRIPT}
    </article>`,
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
    const click = (ms: number) => (seekable ? ` data-seek-ms="${Math.max(0, Math.floor(ms))}" href="#"` : '');

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
const RECORDING_SCRIPT = `<script${CSP_NONCE_ATTR}>
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
  function normalizeText(value){
    try { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
    catch(e) { return value.toLowerCase(); }
  }
  function applyFilter(){
    var q = input ? normalizeText(input.value.trim()) : '';
    // Object.create(null): nome de falante vem do Discord - 'constructor'/'toString'
    // num objeto plano seria truthy sem filtro nenhum e sumiria com o bloco
    var off = Object.create(null);
    document.querySelectorAll('.fchip.off').forEach(function(c){ off[c.dataset.sp] = true; });
    var visible = 0;
    document.querySelectorAll('.transcript .tblock').forEach(function(b){
      if (off[b.dataset.sp]) { b.style.display = 'none'; return; }
      var any = false;
      b.querySelectorAll('p').forEach(function(pp){
        var show = !q || normalizeText(pp.textContent).indexOf(q) !== -1;
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
    return `${title}<p class="tstate" role="alert">${p(l, 'minutesError')}${esc(shortError(state.error, l))}</p>`;
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

  return `${title}<div class="minutes">${parts.join('')}</div>`;
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
      : `${title}<p class="tstate" role="alert">${p(l, 'transcriptError')}${esc(shortError(state.error, l))}</p>`;
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

  return `${title}${note}${search}<div class="transcript">${blocks.join('')}</div>`;
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
    /** Continuação segura da varredura de candidatas/ACL. */
    nextCursor?: string;
    hasPreviousPage?: boolean;
  },
): string {
  const l = opts.lang;
  const pt = l === 'pt';
  const q = opts.q ?? '';
  const sort: RecordingsSort = opts.sort ?? 'recent';
  const metas = items.map((i) => i.meta);

  // Busca primeiro; "/" foca o campo de qualquer lugar da página.
  const searchForm = `<form class="isearch" method="get" action="/app">
      <label class="field-label" for="kq">${pt ? 'Buscar nesta parte do arquivo' : 'Search this part of the archive'}</label>
      <input id="kq" name="q" type="search" value="${esc(q)}" placeholder="${pt ? 'Busque uma decisão, tarefa, pessoa ou assunto' : 'Search for a decision, task, person, or topic'}" autocomplete="off">
      <button class="btn" type="submit">${pt ? 'Buscar' : 'Search'}</button>
      ${q ? `<a class="search-clear" href="/app">${pt ? 'Limpar busca' : 'Clear search'}</a>` : ''}
    </form>
    <script${CSP_NONCE_ATTR}>document.addEventListener('keydown',function(e){
      if(e.key==='/'&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)){e.preventDefault();var i=document.getElementById('kq');if(i)i.focus();}
    });</script>`;

  let hitsHtml = '';
  if (q) {
    const hits = opts.hits ?? [];
    hitsHtml =
      hits.length === 0
        ? `<div class="empty-state search-empty" role="status"><strong>${pt ? 'Nada encontrado' : 'Nothing found'}</strong><span class="muted">${pt ? 'Nenhuma ata, transcrição ou nota corresponde a' : 'No meeting notes, transcript, or note matches'} “${esc(q)}”.</span><a class="btn secondary" href="/app">${pt ? 'Voltar às reuniões' : 'Back to meetings'}</a></div>`
        : `<section class="search-mode" aria-labelledby="search-results"><header class="search-mode-head"><div><span>${pt ? 'BUSCA NESTA PÁGINA' : 'SEARCH THIS PAGE'}</span><h2 id="search-results">${pt ? 'Resultados para' : 'Results for'} “${esc(q)}”</h2></div><a href="/app">${pt ? 'Limpar busca' : 'Clear search'}</a></header>
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
      ? `<nav class="rsorts" aria-label="${pt ? 'Ordenar esta página' : 'Sort this page'}"><span>${pt ? 'Ordenar esta página' : 'Sort this page'}</span>${sortLink('recent', p(l, 'ixSortRecent'))}${sortLink('oldest', p(l, 'ixSortOldest'))}${opts.owner ? sortLink('largest', p(l, 'ixSortLargest')) : ''}</nav>`
      : '';

  const flash = opts.flash ? `<div class="note" role="status">${esc(opts.flash)}</div>` : '';
  const archivePagination =
    opts.nextCursor !== undefined || opts.hasPreviousPage
      ? (() => {
          const next = new URLSearchParams();
          if (q) next.set('q', q);
          if (sort !== 'recent') next.set('sort', sort);
          if (opts.nextCursor !== undefined) next.set('cursor', String(opts.nextCursor));
          return `<nav class="downloads" aria-label="${pt ? 'Paginação do arquivo' : 'Archive pagination'}">
            ${opts.hasPreviousPage ? `<a class="btn secondary" href="/app">${pt ? 'Voltar ao início' : 'Back to start'}</a>` : ''}
            ${opts.nextCursor !== undefined ? `<a class="btn secondary" href="/app?${esc(next.toString())}">${pt ? 'Ver mais reuniões' : 'View more meetings'}</a>` : ''}
            <span class="muted">${pt ? 'O arquivo é verificado em partes para manter a busca e o Discord estáveis.' : 'The archive is checked in bounded pages to keep search and Discord stable.'}</span>
          </nav>`;
        })()
      : '';

  const channelMap = new Map<string, { name: string; guild: string }>();
  for (const m of metas)
    channelMap.set(`${m.guildId}:${m.voiceChannelId}`, { name: m.voiceChannelName, guild: m.guildName });
  const channels = [...channelMap.entries()];
  const duplicateChannelNames = new Set(
    channels
      .filter(([, value], index) => channels.findIndex(([, item]) => item.name === value.name) !== index)
      .map(([, value]) => value.name),
  );
  const chips =
    channels.length > 1
      ? `<div class="filterblock"><span class="filterlabel">${pt ? 'Filtrar por canal' : 'Filter by channel'}</span><div class="fchips">${channels
          .map(
            ([key, channel]) =>
              `<button type="button" class="fchip" data-ch="${esc(key)}" aria-pressed="true">#${esc(channel.name)}${duplicateChannelNames.has(channel.name) ? ` · ${esc(channel.guild)}` : ''}</button>`,
          )
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
    const participantStack =
      m.participants.length > 0
        ? `<span class="row-people" aria-label="${
            pt ? `${m.participants.length} participantes` : `${m.participants.length} participants`
          }">${m.participants
            .slice(0, 4)
            .map((person, index) =>
              person.avatar
                ? `<img src="${esc(person.avatar)}" alt="" title="${esc(person.name)}">`
                : `<span class="row-person-initial c${index % SPEAKER_COLORS}" title="${esc(person.name)}">${esc(person.name.slice(0, 1).toUpperCase())}</span>`,
            )
            .join(
              '',
            )}${m.participants.length > 4 ? `<span class="row-person-more">+${m.participants.length - 4}</span>` : ''}</span>`
        : '';
    // Ações destrutivas ficam fora da leitura principal e continuam POST. O
    // servidor revalida permissão e estado depois do clique.
    const actions =
      canDelete && !live
        ? `<details class="row-menu">
            <summary aria-label="${pt ? 'Ações da reunião' : 'Meeting actions'}">•••</summary>
            <div class="row-menu-popover">
              ${
                !m.audioDeleted && !transcriptionNeedsAudio(m)
                  ? `<form method="post" action="/app/rec/${m.id}/liberar-audio?back=index" data-confirm="${esc(p(l, 'ixFreeSpaceConfirm'))}">
                       <button type="submit" class="rbtn">${p(l, 'ixFreeSpace')}</button></form>`
                  : ''
              }
              <form method="post" action="/app/rec/${m.id}/delete?back=index" data-confirm="${esc(p(l, 'delconfirm'))}">
                <button type="submit" class="rbtn danger">${p(l, 'ixDelete')}</button></form>
            </div>
          </details>`
        : '';
    const channelKey = `${m.guildId}:${m.voiceChannelId}`;
    return `<article class="rrow recording-card" data-ch="${esc(channelKey)}" data-href="/app/rec/${m.id}">
        <a class="recording-card-main" href="/app/rec/${m.id}">
          <div class="recording-card-head"><span class="recording-channel">#${esc(m.voiceChannelName)}</span><span class="recording-server">${esc(m.guildName)}</span>${webBadge(m, l)}</div>
          <div class="recording-card-meta">
            <span><small>${pt ? 'Início' : 'Started'}</small><strong>${clockTime(m.startedAt, l)} ${relativeAge(m.startedAt, l)}</strong></span>
            <span><small>${pt ? 'Duração' : 'Duration'}</small><strong>${dur}</strong></span>
            <span><small>${pt ? 'Iniciada por' : 'Started by'}</small><strong>${who}</strong></span>
            <span><small>${pt ? 'Pessoas' : 'People'}</small><strong>${participantStack || (pt ? 'ninguém falou' : 'no speakers')}</strong></span>
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
      ? `<div class="empty-state library-empty"><span class="empty-kicker">${pt ? 'COMECE NO DISCORD' : 'START IN DISCORD'}</span><strong>${pt ? 'Sua primeira reunião aparece aqui' : 'Your first meeting appears here'}</strong><span class="muted">${
          pt
            ? 'Entre num canal de voz e use /gravar. Quando a call terminar, o Kassinão organiza áudio, transcrição, ata, decisões e tarefas.'
            : 'Join a voice channel and use /record. When the call ends, Kassinão organizes audio, transcript, meeting notes, decisions, and tasks.'
        }</span><div class="empty-actions"><code>${pt ? '/gravar' : '/record'}</code><a class="btn secondary" href="${publicSite('docs', l, config).canonicalUrl}">${pt ? 'Ver como funciona' : 'See how it works'}</a></div></div>`
      : `<div class="recording-groups">${groupedCards}</div>
        <div class="empty-state compact" id="channel-filter-empty" role="status" hidden><strong>${pt ? 'Nenhuma gravação nos canais selecionados' : 'No recordings in the selected channels'}</strong><span class="muted">${pt ? 'Ative outro canal no filtro acima.' : 'Enable another channel in the filter above.'}</span></div>
        <script${CSP_NONCE_ATTR}>
        // O cartão inteiro navega, com exceção de links, botões e formulários.
        document.querySelectorAll('.rrow[data-href]').forEach(function(r){
          r.addEventListener('click', function(e){
            if (e.target.closest('a,button,form,details,summary')) return;
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
  const libraryContent = q ? `${hitsHtml}${archivePagination}` : `${stats}${sorts}${chips}${cards}${archivePagination}`;

  return shell(
    pt ? 'Minhas gravações' : 'My recordings',
    `<section class="index-page">
      <header class="index-head">
        <span class="page-eyebrow">${pt ? 'MEMÓRIA DAS SUAS CALLS' : 'MEMORY FOR YOUR CALLS'}</span>
        <h1>${pt ? 'Minhas gravações' : 'My recordings'}</h1>
        <p class="subline">${
          pt
            ? 'Encontre o que foi dito, decidido e combinado em todas as reuniões que você pode acessar.'
            : 'Find what was said, decided, and assigned across every meeting you can access.'
        }</p>
        ${searchForm}
      </header>
      ${flash}
      ${libraryContent}
    </section>`,
    { user: opts.user, lang: l, active: 'rec', navAi: true, wide: true },
  );
}

export function messagePage(title: string, message: string, user?: WebUser, lang?: Locale): string {
  // Páginas de mensagem/erro (404/403/etc.) nunca são beco sem saída - e nunca
  // jogam um usuário LOGADO de volta na landing: a casa dele é /app. Deslogado,
  // a saída é a ponte de login (a única ponte público→app).
  const pt = lang === 'pt';
  const back = user
    ? `<a class="btn" href="/app">${pt ? 'Voltar às reuniões' : 'Back to meetings'}</a>`
    : `<a class="btn" href="/auth/login?next=%2Fapp">${pt ? 'Entrar com Discord' : 'Sign in with Discord'}</a>`;
  const body =
    `<section class="message-page"><h1>${esc(title)}</h1><p class="muted" style="margin-top:12px">${esc(message)}</p>` +
    `<div class="downloads" style="margin-top:18px">${back}</div></section>`;
  return shell(title, body, { user, lang });
}

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
  exchangeCode?: string;
  /** apelido dado à conexão preparada (eco na página do código). */
  label?: string;
  /** conexões ativas DESTE usuário - a lista de gestão. */
  sessions?: SessionSummary[];
  revoked?: 'all' | 'one';
}): string {
  const pt = opts.lang === 'pt';
  const T = (a: string, b: string): string => (pt ? a : b);
  const title = T('Conectar assistente de IA', 'Connect your AI assistant');

  if (!opts.user) {
    const body = `<section class="connect-page"><h1>${esc(title)}</h1>
      <p class="connect-intro">${esc(
        T(
          'Conecte suas reuniões do Kassinão a qualquer assistente de IA com MCP, como Claude Desktop ou Cursor. Entre com o Discord para manter o mesmo acesso que você já tem no site.',
          'Connect your Kassinão meetings to any MCP-capable AI assistant, such as Claude Desktop or Cursor. Sign in with Discord to keep the same access you already have on the site.',
        ),
      )}</p>
      <div class="downloads" style="margin-top:18px">
        <a class="btn" href="/auth/login?next=%2Fapp%2Fconectar-ia">${esc(T('Entrar com Discord', 'Sign in with Discord'))}</a>
      </div></section>`;
    return shell(title, body, { lang: opts.lang, active: 'ai' });
  }

  if (opts.exchangeCode) {
    const command = `npx -y kassinao-mcp@1.0.5 exchange --stdin --url ${config.mcpUrl}`;
    const localhostWarn = config.mcpUrl.startsWith('http://localhost')
      ? `<div class="note" role="alert">${esc(
          T(
            'Este servidor está com MCP_URL de localhost. O comando gerado não vai funcionar de outra máquina. Defina a URL pública do MCP antes de gerar conexões reais.',
            'This server has a localhost MCP_URL. The generated command will not work from another machine. Set the public MCP URL before generating real connections.',
          ),
        )}</div>`
      : '';
    const body = `<section class="connect-page"><h1>${esc(T('Conexão preparada', 'Connection ready'))}</h1>
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
      <div class="security-note" role="status"><strong>${esc(T('Use este código agora.', 'Use this code now.'))}</strong><span>${esc(
        T(
          'Ele funciona uma vez e expira em cerca de cinco minutos. O comando pede o código sem exibi-lo nem gravá-lo no histórico do terminal.',
          'It works once and expires in about five minutes. The command asks for it without displaying it or saving it in terminal history.',
        ),
      )}</span></div>
      <ol class="connect-steps">
        <li>${esc(T('Copie o código descartável.', 'Copy the one-time code.'))}</li>
        <li>${esc(T('Execute o comando no Terminal, cole o código quando ele pedir e pressione Enter.', 'Run the command in Terminal, paste the code when prompted, and press Enter.'))}</li>
        <li>${esc(T('O token vai para um arquivo local protegido (0600 no macOS/Linux; ACL herdada do perfil no Windows) e a configuração impressa não contém segredo.', 'The token goes to a protected local file (0600 on macOS/Linux; inherited profile ACL on Windows), and the printed config contains no secret.'))}</li>
        <li>${esc(T('Cole a configuração impressa no aplicativo, reinicie e faça uma pergunta.', 'Paste the printed config into the application, restart it, and ask a question.'))}</li>
      </ol>
      <h2>${esc(T('Onde fica o arquivo', 'Where the file lives'))}</h2>
      <ul class="connect-steps">
        <li>Claude Desktop, macOS: <code>~/Library/Application Support/Claude/claude_desktop_config.json</code></li>
        <li>Claude Desktop, Windows: <code>%APPDATA%\\Claude\\claude_desktop_config.json</code></li>
        <li>Cursor: <span style="font-family:ui-monospace,monospace">~/.cursor/mcp.json</span></li>
        <li>${esc(T('Outro assistente com MCP: onde a documentação dele indicar', 'Any other MCP-capable assistant: wherever its docs point'))}</li>
      </ul>
      <div class="downloads" style="margin-top:16px"><button id="kcopycode" class="btn" type="button">${esc(T('Copiar código', 'Copy code'))}</button></div>
      <pre id="kcode" class="tokenbox" tabindex="0" aria-label="${esc(T('Código descartável MCP', 'One-time MCP code'))}">${esc(opts.exchangeCode)}</pre>
      <div class="downloads" style="margin-top:16px"><button id="kcopy" class="btn secondary" type="button">${esc(T('Copiar comando', 'Copy command'))}</button></div>
      <pre id="kcfg" class="tokenbox" tabindex="0" aria-label="${esc(T('Comando de conexão MCP', 'MCP connection command'))}">${esc(command)}</pre>
      <p class="connect-intro">${esc(
        T(
          'Já usa outros servidores MCP? Depois do comando, cole só o bloco "kassinao" impresso dentro de "mcpServers". Não substitua o arquivo inteiro. Requer Node 20 ou superior.',
          'Already use other MCP servers? After running the command, paste only the printed "kassinao" block inside "mcpServers". Do not replace the entire file. Node 20 or newer is required.',
        ),
      )}</p>
      <p class="connect-intro">${esc(
        T(
          'Depois reinicie o app e pergunte: "o que ficou pendente essa semana?"',
          'Then restart the app and ask: "what is pending this week?"',
        ),
      )}</p>
      <div class="downloads" style="margin-top:18px"><a class="btn secondary" href="/app/conectar-ia">${esc(T('Voltar às conexões', 'Back to connections'))}</a></div>
      <script${CSP_NONCE_ATTR}>(function(){function wire(bid,tid){var b=document.getElementById(bid);if(!b)return;b.addEventListener('click',function(){var e=document.getElementById(tid);var t=e?e.textContent:'';navigator.clipboard.writeText(t||'').then(function(){var o=b.textContent;b.textContent='${esc(T('Copiado', 'Copied'))}';setTimeout(function(){b.textContent=o;},2000);}).catch(function(){});});}wire('kcopycode','kcode');wire('kcopy','kcfg');})();</script></section>`;
    return shell(title, body, { lang: opts.lang, user: opts.user, active: 'ai', wide: true, lockLocale: true });
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
          data-confirm="${esc(T('Revogar esta conexão? O assistente ligado nela para de funcionar na hora.', 'Revoke this connection? The assistant using it stops working immediately.'))}">
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
                 data-confirm="${esc(T('Revogar TODAS as suas conexões de uma vez?', 'Revoke ALL your connections at once?'))}">
                 <button type="submit" class="danger">${esc(T('Revogar todas', 'Revoke all'))}</button>
               </form>`
             : ''
         }</section>`
      : `<section aria-labelledby="connections-title"><h2 id="connections-title">${esc(T('Suas conexões', 'Your connections'))}</h2>
         <div class="empty-state compact"><strong>${esc(T('Nenhuma conexão ativa', 'No active connections'))}</strong><span class="muted">${esc(T('Gere uma conexão para começar.', 'Generate a connection to get started.'))}</span></div></section>`;
  const body = `<section class="connect-page"><h1>${esc(title)}</h1>
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
        'Você recebe um comando descartável que instala a conexão sem deixar o token na configuração. Gere uma por assistente para revogar cada acesso separadamente.',
        'You receive a one-time command that installs the connection without leaving the token in the config. Generate one per assistant so you can revoke each access separately.',
      ),
    )}</p>
    ${list}</section>`;
  return shell(title, body, { lang: opts.lang, user: opts.user, active: 'ai', wide: true });
}
