import { config } from '../config';
import { Locale } from '../i18n';
import { msToClock } from '../processing/transcribe';
import { formatDuration, formatOffset } from '../recorder/RecordingSession';
import { MeetingMinutes, RecordingMeta, TranscriptSegment } from '../store';
import type { WebUser } from './auth';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
    pt: 'O arquivo é processado na hora — gravações longas podem levar alguns segundos.',
    en: 'Files are processed on demand — long recordings may take a few seconds.',
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
  a.btn { display: inline-flex; flex-direction: column; gap: 2px; text-decoration: none; background: #5865f2;
          color: #fff; padding: 12px 18px; border-radius: 8px; font-size: 15px; font-weight: 600; }
  a.btn small { font-weight: 400; font-size: 12px; opacity: .8; }
  a.btn:hover { background: #4752c4; }
  .events { list-style: none; font-size: 14px; display: flex; flex-direction: column; gap: 4px;
            max-height: 220px; overflow-y: auto; }
  .events time { color: #949ba4; font-family: ui-monospace, monospace; margin-right: 8px; }
  .transcript { display: flex; flex-direction: column; gap: 8px; max-height: 420px; overflow-y: auto;
                background: #232428; border-radius: 8px; padding: 14px; font-size: 14px; }
  .transcript p { line-height: 1.45; }
  .transcript .who { color: #f2f3f5; font-weight: 600; }
  .transcript time { color: #949ba4; font-family: ui-monospace, monospace; font-size: 12px; margin-right: 6px; }
  .tstate { font-size: 14px; color: #949ba4; }
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
            gap: 8px; margin-bottom: 12px; font-size: 13px; color: #949ba4; }
  .topbar .user { display: inline-flex; align-items: center; gap: 8px; }
  .topbar img { width: 22px; height: 22px; border-radius: 50%; }
  .langtoggle a { color: #949ba4; text-decoration: none; padding: 2px 4px; }
  .langtoggle a.on { color: #f2f3f5; font-weight: 700; }
  .langtoggle a:hover { color: #dbdee1; }
  .langtoggle span { opacity: .5; margin: 0 2px; }
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
    .downloads a.btn { flex: 1 1 auto; text-align: center; }
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

const TZ_SCRIPT = `<script>
document.querySelectorAll('time[data-ts]').forEach(function(el){
  try { el.textContent = new Date(+el.dataset.ts).toLocaleString(navigator.language, {dateStyle:'long', timeStyle:'short'}); } catch(e){}
});
// pular pro momento no player de áudio (no-op se não houver player, ex.: gravação ao vivo)
window.kseek = function(ms){
  var p = document.getElementById('kplayer');
  if (!p) return;
  p.currentTime = Math.max(0, ms/1000);
  p.play().catch(function(){});
  p.scrollIntoView({behavior:'smooth', block:'center'});
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
  const userbar = `<div class="topbar">${langToggle}${
    opts.user
      ? `<span class="user">${opts.user.avatar ? `<img src="${esc(opts.user.avatar)}" alt="">` : ''}${esc(opts.user.name)}</span>`
      : ''
  }</div>`;
  // Auto-refresh (enquanto transcrição/ata processam) via JS em vez de <meta refresh>,
  // pra NÃO recarregar e cortar o áudio enquanto a pessoa está ouvindo o player.
  const refresh = opts.refreshSeconds
    ? `<script>setTimeout(function(){var p=document.getElementById('kplayer');if(p&&!p.paused)return;location.reload();},${opts.refreshSeconds * 1000});</script>`
    : '';
  return `<!doctype html>
<html lang="${lang === 'pt' ? 'pt-BR' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${opts.noindex ? '<meta name="robots" content="noindex">' : ''}
<title>${esc(title)} — Kassinão</title>
<style>${SHELL_CSS}</style>
</head>
<body>
${userbar}
<div class="card">${body}</div>
${TZ_SCRIPT}
${refresh}
</body>
</html>`;
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
  const badge = live
    ? `<span class="badge live">${p(l, 'live')}</span>`
    : `<span class="badge done">${p(l, 'done')}</span>`;

  const people =
    meta.participants.length > 0
      ? `<div class="people">${meta.participants
          .map(
            (pt) =>
              `<span class="person">${pt.avatar ? `<img src="${esc(pt.avatar)}" alt="">` : '🎤'}${esc(pt.name)}</span>`,
          )
          .join('')}</div>`
      : `<p class="muted">${p(l, 'nobody')}</p>`;

  const downloads =
    !demo && meta.participants.length > 0
      ? `<div class="downloads">
          <a class="btn" href="/rec/${meta.id}/download/mp3">🎵 MP3 <small>${p(l, 'mp3sub')}</small></a>
          <a class="btn" href="/rec/${meta.id}/download/flac">💎 FLAC <small>${p(l, 'flacsub')}</small></a>
          <a class="btn" href="/rec/${meta.id}/download/mix">🎧 Mix <small>${p(l, 'mixsub')}</small></a>
          <a class="btn" href="/rec/${meta.id}/download/audacity">🎚️ Audacity <small>${p(l, 'audacitysub')}</small></a>
        </div>
        <p class="muted" style="margin-top:10px">${p(l, 'cooking')}</p>`
      : '';

  const notes =
    meta.notes.length > 0
      ? `<h2>${p(l, 'notes')}</h2><ul class="notes">${meta.notes
          .map((n) => `<li><time>${formatOffset(n.atMs)}</time><strong>${esc(n.author)}:</strong> ${esc(n.text)}</li>`)
          .join('')}</ul>`
      : '';

  const minutes = renderMinutes(meta, opts.minutes, l, seekable);
  const transcription = renderTranscription(meta, opts.transcript, l, seekable);

  // Player de áudio. Real: mix cozinhado (id=kplayer, horários pulam pra ali).
  // Demo: um trecho curto de amostra (sem id=kplayer, sem seek).
  let player = '';
  if (demo) {
    player = `<h2>${p(l, 'sampleAudio')}</h2>
       <div class="player">
         <audio preload="none" controls src="/demo/audio"></audio>
         <div class="hint">${p(l, 'sampleNote')}</div>
       </div>`;
  } else if (!live && meta.participants.length > 0) {
    player = `<h2>${p(l, 'listen')}</h2>
       <div class="player">
         <audio id="kplayer" preload="none" controls src="/rec/${meta.id}/audio"></audio>
         <div class="hint">${p(l, 'seekHint')}</div>
       </div>`;
  }

  const liveNote = live ? `<div class="note">${p(l, 'livenote')}</div>` : '';
  const demoNote = demo ? `<div class="note">${p(l, 'demoBanner')}</div>` : '';

  const events =
    meta.events.length > 0
      ? `<h2>${p(l, 'timeline')}</h2><ul class="events">${meta.events
          .map((e) => `<li><time>${formatOffset(e.atMs)}</time>${esc(e.text)}</li>`)
          .join('')}</ul>`
      : '';

  const deleteForm =
    opts.canDelete && !live
      ? `<form class="delete" method="post" action="/rec/${meta.id}/delete"
         onsubmit="return confirm('${p(l, 'delconfirm')}')">
         <button class="danger" type="submit">${p(l, 'del')}</button>
       </form>`
      : '';

  const expires =
    meta.expiresAt && !live && !demo
      ? `<footer>${p(l, 'expires', { date: datetime(meta.expiresAt, l) })}</footer>`
      : '';

  return shell(
    `${p(l, 'recording')} ${meta.id}`,
    `<h1>🎙️ ${p(l, 'recording')} ${badge}</h1>
     ${demoNote}
     <dl class="grid">
       <dt>${p(l, 'server')}</dt><dd>${esc(meta.guildName)}</dd>
       <dt>${p(l, 'channel')}</dt><dd>🔊 ${esc(meta.voiceChannelName)}</dd>
       <dt>${p(l, 'started')}</dt><dd>${datetime(meta.startedAt, l)}</dd>
       <dt>${p(l, 'duration')}</dt><dd>${formatDuration(endedAt - meta.startedAt)}${live ? p(l, 'counting') : ''}</dd>
       <dt>ID</dt><dd><code>${esc(meta.id)}</code></dd>
     </dl>
     ${liveNote}
     <h2>${p(l, 'participants')}</h2>
     ${people}
     ${!demo && meta.participants.length > 0 ? `<h2>${p(l, 'downloads')}</h2>` : ''}
     ${downloads}
     ${player}
     ${minutes}
     ${transcription}
     ${notes}
     ${events}
     ${deleteForm}
     ${expires}`,
    {
      user: opts.user,
      lang: l,
      noindex: !demo, // gravações reais (/rec/:id) fora de busca; a demo pública é indexável
      // ao vivo OU transcrição/ata em andamento: a página se atualiza sozinha
      refreshSeconds:
        live ||
        meta.transcription?.status === 'pending' ||
        meta.transcription?.status === 'running' ||
        meta.minutes?.status === 'pending' ||
        meta.minutes?.status === 'running'
          ? 30
          : undefined,
    },
  );
}

function renderMinutes(meta: RecordingMeta, minutes: MeetingMinutes | undefined, l: Locale, seekable = true): string {
  const state = meta.minutes;
  if (!state || state.status === 'disabled') return '';
  const title = `<h2>📋 ${p(l, 'minutes')}</h2>`;
  if (state.status === 'pending') return `${title}<p class="tstate">${p(l, 'minutesPending')}</p>`;
  if (state.status === 'running') return `${title}<p class="tstate">${p(l, 'minutesRunning')}</p>`;
  if (state.status === 'error')
    return `${title}<p class="tstate">${p(l, 'minutesError')}${esc(state.error ?? '?')}</p>`;
  if (!minutes) return '';

  const parts: string[] = [];
  if (minutes.resumo) parts.push(`<h3>${p(l, 'mSummary')}</h3><p>${esc(minutes.resumo)}</p>`);
  if (minutes.decisoes.length) {
    parts.push(`<h3>${p(l, 'mDecisions')}</h3><ul>${minutes.decisoes.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>`);
  }
  if (minutes.acoes.length) {
    parts.push(
      `<h3>${p(l, 'mActions')}</h3><ul>${minutes.acoes
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
      `<h3>${p(l, 'mTopics')}</h3><ul>${minutes.topicos
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
  const title = `<h2>${p(l, 'transcript')}</h2>`;
  if (state.status === 'pending') return `${title}<p class="tstate">${p(l, 'transcriptPending')}</p>`;
  if (state.status === 'running') return `${title}<p class="tstate">${p(l, 'transcriptRunning')}</p>`;
  if (state.status === 'error')
    return `${title}<p class="tstate">${p(l, 'transcriptError')}${esc(state.error ?? '?')}</p>`;
  if (!transcript || transcript.length === 0) return `${title}<p class="tstate">${p(l, 'transcriptEmpty')}</p>`;

  const body = transcript
    .map((s) => `<p>${tsLink(s.startMs, seekable)}<span class="who">${esc(s.speaker)}:</span> ${esc(s.text)}</p>`)
    .join('');
  // Downloads .md/.txt vão pelas rotas protegidas /rec/:id — no modo demo (público) omitimos.
  const dl = seekable
    ? `<div class="tdl">
      <a href="/rec/${meta.id}/transcricao.md">${p(l, 'transcriptDownload')}</a>
      <a href="/rec/${meta.id}/transcricao.txt">${p(l, 'transcriptDownloadTxt')}</a>
    </div>`
    : '';
  return `${title}<div class="transcript">${body}</div>${dl}`;
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

// CSS da landing (vitrine pública). Documento próprio, full-width — NÃO usa o
// .card estreito do shell(). Mesmos tokens de cor do Discord do SHELL_CSS.
// Tudo self-contained (CSP: sem fonte/CSS/JS/imagem externa).
const LANDING_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  html, body { max-width: 100%; overflow-x: hidden; }
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
  .microline { margin-top: 16px; font-size: 0.86rem; color: #80848e; }
  .microline b { color: #b5bac1; font-weight: 600; }
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
  .pill { font-size: 0.72rem; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
  .pill-owner { background: #2b2d31; color: #b5bac1; border: 1px solid #3a3c42; }
  .pill-due { background: #322a12; color: #f0b232; border: 1px solid #46402a; }
  .ts { color: #00a8fc; text-decoration: none; font-size: 0.8rem; white-space: nowrap; }
  .ts:hover { text-decoration: underline; }
  .ans-foot { color: #80848e; font-size: 0.72rem; margin-top: 10px; }
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
  .step h4 { color: #f2f3f5; font-size: 0.98rem; margin-bottom: 5px; }
  .step p { color: #949ba4; font-size: 0.86rem; }
  .terminal { margin-top: 12px; background: #1a1b1e; border: 1px solid #26282c; border-radius: 9px; overflow: hidden; }
  .term-bar { display: flex; align-items: center; gap: 6px; padding: 8px 11px; border-bottom: 1px solid #26282c; }
  .term-bar i { width: 8px; height: 8px; border-radius: 50%; display: block; }
  .term-bar .cp { margin-left: auto; font-size: 0.72rem; color: #949ba4; background: none; border: 0; cursor: pointer; font-family: inherit; }
  .term-body { padding: 12px; font-family: ui-monospace, monospace; font-size: 0.8rem; color: #b5bac1;
               white-space: pre-wrap; word-break: break-word; }
  .term-body .flag { color: #80848e; }
  .term-note { color: #80848e; font-size: 0.78rem; margin-top: 8px; }
  .deploy-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 20px; }
  .dcard { background: #232428; border: 1px solid #26282c; border-radius: 12px; padding: 15px; color: #949ba4; font-size: 0.87rem; }
  .dcard b { color: #dbdee1; }
  /* features */
  .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 16px; margin-top: 32px; }
  .feature { background: #2b2d31; border: 1px solid #26282c; border-radius: 12px; padding: 16px; }
  .f-icon { font-size: 1.5rem; margin-bottom: 9px; }
  .feature h4 { color: #f2f3f5; font-size: 0.96rem; margin-bottom: 5px; }
  .feature p { color: #949ba4; font-size: 0.86rem; }
  /* final cta */
  .final { background: radial-gradient(120% 120% at 50% 0%, rgba(88,101,242,.22) 0%, rgba(30,31,34,0) 60%); }
  .final-card { text-align: center; }
  /* footer */
  footer { border-top: 1px solid #26282c; padding: 26px 0; }
  footer .wrap { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; }
  .sig { color: #80848e; font-size: 0.82rem; }
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
  const mcpOn = config.mcpEnabled;
  const metaTitle = T(
    'Kassinão — Pare de ler transcrição. Pergunte às suas reuniões.',
    'Kassinão — Stop reading transcripts. Ask your meetings.',
  );
  const metaDesc = T(
    'Gravador de voz do Discord, open-source e no seu servidor, que transforma cada call em memória que a sua IA responde. Pergunte "o que ficou pendente essa semana?" no Claude ou Cursor e receba a decisão, o responsável e um link pro segundo exato — gravação multipista, transcrição por pessoa e ata de IA. O Craig, mas que lembra.',
    'Self-hosted, open-source Discord voice recorder that turns every call into memory your AI assistant can answer. Ask "what\'s pending this week?" from Claude or Cursor and get the decision, the owner, and a link to the exact second — multi-track recording, per-speaker transcript, AI minutes. Craig, but it remembers.',
  );

  const langToggle = `<div class="langtoggle"><a href="?lang=en"${!pt ? ' class="on"' : ''}>EN</a><span>·</span><a href="?lang=pt"${pt ? ' class="on"' : ''}>PT</a></div>`;

  // secondary CTA só quando o MCP está ligado neste servidor (mesmo gate do produto)
  const connectBtn = (cls: string): string =>
    mcpOn
      ? `<a class="btn ${cls}" href="/conectar-ia">${T('🔌 Conectar Claude/Cursor', '🔌 Connect Claude/Cursor')}</a>`
      : '';

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

  const chatQuestion = T('o que ficou pendente essa semana?', "what's pending this week?");
  const ansRow = (task: string, owner: string, due: string, ts: string): string =>
    `<div class="ans-row"><span class="sdot"></span><span class="tk">${task}</span><span class="pill pill-owner">${owner}</span><span class="pill pill-due">${due}</span><a class="ts" href="/demo">▶ ${ts}</a></div>`;
  const answerRows =
    ansRow(
      T('Mergear o rollback do onboarding + feature-flag', 'Merge the onboarding rollback + feature-flag it'),
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

  const hero = `<section class="hero"><div class="wrap">
    <div class="eyebrow">🎙️ <span>${T('O Craig, mas que lembra — e você pode perguntar.', 'Craig, but it remembers — and you can ask it questions.')}</span></div>
    <h1>${T('Pare de ler transcrição.<br>Pergunte às suas reuniões.', 'Stop reading transcripts.<br>Ask your meetings.')}</h1>
    <p class="lead">${T(
      'O Kassinão grava suas calls do Discord — uma faixa por pessoa — e responde de dentro do Claude ou do Cursor: pergunte "o que ficou pendente?" e receba a tarefa, o responsável e um link pro segundo exato. Gravação, transcrição, ata e player funcionam sozinhos — a IA é a parte que ninguém mais tem.',
      'Kassinão records your Discord calls — one track per person — then answers from inside Claude or Cursor: ask "what\'s pending?" and get the task, the owner, and a link to the exact second. The recorder, transcript, minutes and player all work on their own — the AI is the part nobody else has.',
    )}</p>
    <div class="ctarow">
      <a class="btn btn-primary" href="/demo">${T('▶️ Ver o exemplo ao vivo', '▶️ See the live example')}</a>
      ${connectBtn('btn-outline')}
      <a class="btn btn-ghost" href="${REPO_URL}">${T('⭐ GitHub', '⭐ GitHub')}</a>
    </div>
    <div class="microline">${T('Sem login', 'No login')} · <b>${T('roda no seu servidor', 'runs on your server')}</b> · ${T('MIT open-source', 'MIT open-source')}</div>

    <div class="hero-split">
      <div class="panel panel-call">
        <div class="dc-head"><span class="rec-dot"></span><span class="ch">🔊 product-sync</span><span class="rec-pill">[REC]</span></div>
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

  // ---- ASK ANYTHING (5 tools) ----
  const qcard = (glow: boolean, q: string, tool: string, ans: string, badge?: string): string =>
    `<div class="qcard${glow ? ' glow' : ''}"><div class="qprompt"><span class="arrow">›</span><span>${q}</span></div>
      <div class="qtool"><span class="toolchip mono">🔌 ${tool}</span></div>
      <div class="qans">${ans}</div>${badge ? `<span class="qbadge">${badge}</span>` : ''}</div>`;
  const askSection = `<section><div class="wrap">
    <div class="kicker">${T('A parte que ninguém mais tem', 'The part nobody else has')}</div>
    <h2>${T('Você pergunta em linguagem natural. Ele responde com prova.', 'You ask in plain language. It answers with proof.')}</h2>
    <p class="lead">${T('Cinco ferramentas MCP, no formato da pergunta que você digitaria — sem sair do seu assistente.', 'Five MCP tools, framed as the question you actually type — without leaving your assistant.')}</p>
    <div class="grid-cards">
      ${qcard(true, T('⏳ O que ficou pendente essa semana?', "⏳ What's still pending this week?"), 'pending_actions', T('Rollback do onboarding — Rafael, qua · Load test — Mei · E-mail de lançamento — Priya, qui', 'Onboarding rollback — Rafael, Wed · Load test — Mei · Launch email — Priya, Thu'), T('cruza TODAS as calls', 'across ALL your calls'))}
      ${qcard(false, T('🗣️ Quando o Rafael falou do pico de churn?', '🗣️ When did Rafael flag the churn spike?'), 'who_said', T('Investigação do pico de churn (onboarding) <a class="ts" href="/demo">▶ 16:10</a>', 'Churn spike investigation (onboarding) <a class="ts" href="/demo">▶ 16:10</a>'))}
      ${qcard(false, T('🔎 Onde a gente decidiu subir o plano anual?', '🔎 Where did we decide to ship annual pricing?'), 'search_meetings', T('Decisão: subir o plano anual pra 100% (+18% de conversão a 20%) <a class="ts" href="/demo">▶ 29:40</a>', 'Decision: ship annual pricing to 100% (was +18% conversion at 20%) <a class="ts" href="/demo">▶ 29:40</a>'))}
      ${qcard(false, T('📅 Lista as calls de 1 a 30 de junho', '📅 List the calls from June 1–30'), 'list_meetings', T('Janelas de data e "essa semana / semana passada" funcionam.', 'Date ranges and "this week / last week" windows both work.'))}
      ${qcard(false, T('📄 Me dá o dossiê da product-sync', '📄 Give me the product-sync dossier'), 'get_meeting', T('Resumo + decisões + itens de ação + timeline.', 'Summary + decisions + action items + timeline.'))}
    </div>
  </div></section>`;

  // ---- PROOF: real demo minutes ----
  const dec = (ptS: string, enS: string): string => `<li>${T(ptS, enS)}</li>`;
  const mcAction = (task: string, meta: string, ts: string): string =>
    `<div class="mc-action"><a class="ts" href="/demo">${ts}</a><span class="task">${task}</span><span class="meta2">${meta}</span></div>`;
  const proofSection = `<section><div class="wrap">
    <div class="kicker">${T('Prova antes da promessa', 'Proof before the claim')}</div>
    <h2>${T('E o Kassinão escreveu esta ata sozinho.', 'And Kassinão wrote these minutes itself.')}</h2>
    <p class="lead">${T('Ata gerada por IA do exemplo ao vivo — ninguém digitou. Um clique abre a gravação real (sem login).', 'AI-generated minutes from the live example — no one typed it. One click opens the real recording (no login).')}</p>
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
      ${mcAction(T('Mergear o rollback do onboarding + feature-flag', 'Merge the onboarding rollback + feature-flag it'), 'Rafael · ' + T('qua', 'Wed'), '16:10')}
      ${mcAction(T('Rodar o load test no staging e compartilhar os números', 'Run the load test against staging and share numbers'), 'Mei · ' + T('qua', 'Wed EOD'), '5:20')}
      ${mcAction(T('Finalizar e-mail de lançamento + changelog, agendar qui 9h', 'Finalize launch email + changelog, schedule for Thu 9am'), 'Priya · ' + T('qui', 'Thu'), '55:30')}
    </div>
    <div class="ctarow"><a class="btn btn-primary" href="/demo">${T('▶️ Abrir a gravação inteira', '▶️ Open the whole recording')}</a></div>
  </div></section>`;

  // ---- TRUST ----
  const receipt = (icon: string, title: string, body: string): string =>
    `<div class="receipt"><div class="r-icon">${icon}</div><div class="r-title">${title}</div><div class="r-body">${body}</div></div>`;
  const trustSection = `<section><div class="wrap">
    <div class="kicker">${T('Confiança com recibo, não com adjetivo', 'Receipts, not adjectives')}</div>
    <h2>${T('Sua IA só vê as calls que você já veria. Nunca mais que isso.', 'Your AI only sees the calls you could already see. Never more.')}</h2>
    <div class="receipts">
      ${receipt('🔐', T('Acesso pela sua identidade', 'Access by your identity'), T('Reconferido ao vivo contra o Discord por reunião: você iniciou, participou, enxerga o canal ou tem Gerenciar Servidor. Não existe modo "operador vê tudo".', 'Re-checked live against Discord per meeting: you started it, you were in it, you can see the channel, or you have Manage-Server. There is no "operator sees everything" mode.') + `<br><span class="mono strike">// seeAll — ${T('não existe', 'does not exist')}</span><br><a class="pill-link" href="${REPO_URL}/blob/main/src/web/access.ts">&lt;/&gt; checkAccess() · access.ts →</a>`)}
      ${receipt('👁️', T('Somente leitura', 'Read-only'), T('O conector não grava, não apaga e não serve áudio. Cinco ferramentas, todas de leitura.', 'The connector never writes, never deletes, never serves audio. Five tools, all read-only.'))}
      ${receipt('♻️', T('Token rotaciona a cada uso', 'Token rotates every use'), T('O refresh fica em ', 'The refresh token lives at ') + `<code>~/.config/kassinao-mcp/token.json</code> (<code>chmod 0600</code>)` + T('; um token roubado e reapresentado denuncia o reuso e mata a sessão. Fail-closed: sem verificar acesso, o MCP responde 503 — nunca um grant falso.', "; a replayed/stolen token trips reuse-detection and kills the session. Fail-closed: if access can't be verified the MCP returns 503 — never a false grant."))}
      ${receipt('🧨', T('Revogue quando quiser', 'Revoke anytime'), T('Três formas: "Revogar todos" na web, ', 'Three ways: "Revoke all" on the web, ') + `<code>/mcp revoke-all</code>` + T(' no Discord, ou girar o ', ' in Discord, or rotate ') + `<code>MCP_SECRET</code>` + T(' como botão de pânico do admin.', ' as the admin panic button.'))}
    </div>
    <div class="inj-banner"><span>🛡️</span><span>${T('O conteúdo da reunião — transcrição, notas, até apelidos — é tratado como entrada não-confiável e higienizado antes de chegar em qualquer LLM (defesa contra prompt-injection). No seu servidor, MIT open-source, auditável.', 'Meeting content — transcript, notes, even display names — is treated as untrusted input and sanitized before it reaches any LLM (prompt-injection defense). Self-hosted, MIT open-source, auditable.')}</span></div>
  </div></section>`;

  // ---- CRAIG COMPARISON ----
  const yes = '<span class="yes">✅</span>';
  const dash = '<span class="no">—</span>';
  const row = (feat: string, craig: string, us: string): string =>
    `<tr><td class="feat">${feat}</td><td>${craig}</td><td class="us">${us}</td></tr>`;
  const craigSection = `<section><div class="wrap">
    <div class="kicker">${T('Vindo do Craig?', 'Coming from Craig?')}</div>
    <h2>${T('O Craig grava. O Kassinão lembra — e você pergunta.', 'Craig records. Kassinão remembers — and you ask.')}</h2>
    <p class="lead">${T('Cada pessoa numa faixa própria: quem falou é sabido, não chutado por diarização — nunca embola crosstalk nem nome fora do inglês. Você mantém tudo que o Craig faz bem e ganha a camada que ele te manda comprar em outro lugar.', 'Every participant on their own track: who spoke is known, not guessed by diarization — it never garbles crosstalk or non-English names. You keep everything Craig does well and gain the layer Craig sends you elsewhere to buy.')}</p>
    <div class="cmp-wrap"><table class="cmp">
      <thead><tr><th>${T('Recurso', 'Feature')}</th><th>Craig</th><th class="us">Kassinão</th></tr></thead>
      <tbody>
        ${row(T('Multipista — uma faixa por pessoa', 'Multi-track — one track per person'), yes, yes)}
        ${row(T('Export MP3 · FLAC · Mix · Audacity', 'Export MP3 · FLAC · Mix · Audacity'), yes, yes)}
        ${row(T('Transcrição por pessoa', 'Per-speaker transcript'), dash, yes)}
        ${row(T('Ata de IA: decisões + responsáveis + prazos', 'AI minutes: decisions + owners + due dates'), dash, yes)}
        ${row(T('Página web privada com player', 'Private per-recording web page with player'), dash, yes)}
        ${row(T('Perguntar às reuniões pelo Claude/Cursor', 'Ask your meetings from Claude/Cursor'), dash, yes)}
      </tbody>
    </table></div>
    <p class="microline">${T('Otter/Fireflies/Fathom têm IA, mas são SaaS fechado, não vivem num canal de voz do Discord e não rodam na sua máquina.', "Otter/Fireflies/Fathom have AI too, but they are closed SaaS, don't live in a Discord voice channel, and don't run on your box.")}</p>
  </div></section>`;

  // ---- SETUP + COST ----
  const cmd = `KASSINAO_URL=${config.baseUrl} npx -y kassinao-mcp exchange <code>`;
  const setupSection = `<section><div class="wrap">
    <div class="kicker">${T('No ar em minutos', 'Live in minutes')}</div>
    <h2>${T('No seu servidor — e honesto sobre o custo.', 'On your server — and honest about cost.')}</h2>
    <div class="steps">
      <div class="step"><div class="step-num">1</div><h4>${T('Suba o bot', 'Boot the bot')}</h4><p>${T('Docker Compose + um app do Discord, ou o blueprint Deploy-to-Render de um clique. HTTPS via Cloudflare Tunnel, sem abrir portas.', 'Docker Compose + a Discord app, or the one-click Deploy-to-Render blueprint. HTTPS via Cloudflare Tunnel, no open ports.')}</p></div>
      <div class="step"><div class="step-num">2</div><h4>${T('Grave', 'Record')}</h4><p>${T('/gravar num canal de voz, ou auto-grava quando 2+ pessoas entram — com o apelido [REC] e um painel ao vivo. Nunca secreto.', '/gravar in a voice channel, or auto-record when 2+ people join — with a [REC] nickname tag and a live in-channel panel. Never covert.')}</p></div>
      <div class="step"><div class="step-num">3</div><h4>${T('Conecte', 'Connect')}</h4><p>${T('Abra /conectar-ia, entre com o Discord e rode o comando pra plugar o Claude ou o Cursor:', 'Open /conectar-ia, sign in with Discord, and run the command to connect Claude or Cursor:')}</p>
        <div class="terminal"><div class="term-bar"><i style="background:#da373c"></i><i style="background:#f0b232"></i><i style="background:#23a55a"></i><button class="cp mono" id="kcp" type="button">⧉ ${T('copiar', 'copy')}</button></div><div class="term-body mono" id="kcmd">${esc(cmd)}</div></div>
        <div class="term-note">${T('código válido ~5 min, uso único · ', 'code valid ~5 min, single use · ')}<span class="codechip">npx -y kassinao-mcp</span> · 5 ${T('ferramentas', 'tools')}</div>
      </div>
    </div>
    <div class="deploy-cards">
      <div class="dcard">🐳 <b>Docker Compose</b> · 🚀 Deploy to Render · 🔒 Cloudflare Tunnel — 0 ${T('portas abertas', 'open ports')}</div>
      <div class="dcard">${T('Custo, direto: transcrição é BYO-key e multipista, então escala com o nº de pessoas — de alguns centavos a um pouco mais por reunião — ou rode 100% local com faster-whisper (o áudio nunca sai da sua máquina). Ata: alguns centavos.', 'Cost, straight: transcription is bring-your-own-key and multi-track, so it scales with the number of speakers — a few cents to a bit more per meeting — or run it 100% local with faster-whisper (audio never leaves your box). Minutes: a few cents.')} <span class="codechip">[REC]</span></div>
    </div>
  </div></section>`;

  // ---- FEATURES ----
  const feats: [string, string, string][] = [
    [
      '🎙️',
      T('Multipista real — um arquivo por pessoa', 'True multi-track — one file per person'),
      T('Quem falou é sabido, não chutado por diarização.', 'Who spoke is known, not guessed by diarization.'),
    ],
    [
      '🤖',
      T('Ata de IA: decisões + responsáveis + prazos', 'AI minutes: decisions + owners + due dates'),
      T(
        'Resumo, decisões e itens de ação na página da gravação.',
        'A summary, decisions, and action items on the recording page.',
      ),
    ],
    [
      '▶️',
      T('Horários clicáveis pro segundo exato', 'Clickable timestamps to the exact second'),
      T('Toda linha dá deep-link pro momento no player.', 'Every line deep-links to that moment in the player.'),
    ],
    [
      '🔌',
      T('Pergunte pelo Claude ou Cursor', 'Ask from Claude or Cursor'),
      T('5 ferramentas MCP em linguagem natural.', '5 MCP tools in natural language.'),
    ],
    [
      '💾',
      T('Quatro formatos de download', 'Four download formats'),
      T('🎵 MP3 · 💎 FLAC · 🎧 Mix · 🎚️ Audacity.', '🎵 MP3 · 💎 FLAC · 🎧 Mix · 🎚️ Audacity.'),
    ],
    [
      '🔴',
      T('Auto-gravação com consentimento visível', 'Auto-record with visible consent'),
      T('Painel ao vivo + apelido [REC]. Nunca secreto.', 'Live panel + [REC] nickname tag. Never covert.'),
    ],
    [
      '🔒',
      T('Página web privada por gravação', 'Private per-recording web page'),
      T(
        'Player, transcrição, ata e downloads — acesso pela sua identidade.',
        'Player, transcript, minutes, downloads — scoped to your identity.',
      ),
    ],
    [
      '🌎',
      T('Bilíngue de ponta a ponta (EN / pt-BR)', 'Bilingual end to end (EN / pt-BR)'),
      T(
        'Landing, ata e perguntas do MCP em inglês e português.',
        'Landing, minutes, and MCP queries in English and Portuguese.',
      ),
    ],
  ];
  const featSection = `<section><div class="wrap">
    <div class="kicker">${T('Tudo funciona sozinho — a IA é o bônus', 'Everything works standalone — the AI is the bonus')}</div>
    <h2>${T('Um gravador completo. Mais uma memória que responde.', 'A complete recorder. Plus a memory that answers.')}</h2>
    <div class="features">${feats.map(([ic, t, d]) => `<div class="feature"><div class="f-icon">${ic}</div><h4>${t}</h4><p>${d}</p></div>`).join('')}</div>
  </div></section>`;

  // ---- FINAL CTA ----
  const finalSection = `<section class="final"><div class="wrap final-card">
    <h2>${T('Prove sem instalar nada. Depois conecte a sua IA.', 'Prove it without installing anything. Then connect your AI.')}</h2>
    <p class="lead" style="margin:14px auto 0">${T('Abra o exemplo ao vivo — uma product-sync real de ~58 min, 6 pessoas, transcrição por pessoa, ata com decisões e responsáveis, horários clicáveis. Sem login.', 'Open the live example — a real ~58-min product-sync, 6 people, per-speaker transcript, minutes with decisions and owners, clickable timestamps. No login.')}</p>
    <div class="ctarow">
      <a class="btn btn-primary" href="/demo">${T('▶️ Ver o exemplo ao vivo', '▶️ See the live example')}</a>
      ${connectBtn('btn-outline')}
      <a class="btn btn-ghost" href="${REPO_URL}">⭐ GitHub</a>
    </div>
    <div class="microline"><span class="codechip">npm: kassinao-mcp</span></div>
  </div></section>`;

  const topnav = `<div class="topnav"><div class="wrap">
    <a class="brand" href="/">🎙️ Kassinão</a>
    <div class="navlinks">
      <a href="/demo">${T('Exemplo', 'Demo')}</a>
      ${mcpOn ? `<a href="/conectar-ia">${T('Conectar IA', 'Connect AI')}</a>` : ''}
      <a href="${REPO_URL}">GitHub</a>
      ${langToggle}
    </div>
  </div></div>`;

  const footer = `<footer><div class="wrap">
    <span class="sig">${T('MIT · open-source · roda no seu servidor · EN / pt-BR', 'MIT · open-source · runs on your server · EN / pt-BR')}</span>
    ${langToggle}
  </div></footer>`;

  const copyScript = `<script>(function(){var b=document.getElementById('kcp');if(!b)return;b.addEventListener('click',function(){var t=(document.getElementById('kcmd').textContent)||'';navigator.clipboard.writeText(t).then(function(){var o=b.textContent;b.textContent='${T('copiado ✓', 'copied ✓')}';setTimeout(function(){b.textContent=o;},2000);});});})();</script>`;

  return `<!doctype html>
<html lang="${pt ? 'pt-BR' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(metaTitle)}</title>
<meta name="description" content="${esc(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(metaTitle)}">
<meta property="og:description" content="${esc(metaDesc)}">
<meta property="og:url" content="${esc(config.baseUrl)}/">
<meta property="og:image" content="${esc(config.baseUrl)}/og.png">
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
${trustSection}
${craigSection}
${setupSection}
${featSection}
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
          'Cole no claude_desktop_config.json (Claude Desktop) ou no equivalente do Cursor:',
          'Paste into claude_desktop_config.json (Claude Desktop) or the Cursor equivalent:',
        ),
      )}</p>
      <div style="margin-top:12px"><button id="kcopy" class="btn" type="button" style="border:0;cursor:pointer;font:inherit">📋 ${esc(T('Copiar config', 'Copy config'))}</button></div>
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
        'Gere um token para plugar o Kassinão no seu assistente de IA. Cada token só enxerga as gravações que você já pode ver — e pode ser revogado quando quiser.',
        'Generate a token to plug Kassinão into your AI assistant. Each token only sees recordings you can already see — and can be revoked anytime.',
      ),
    )}</p>
    <p class="muted" style="margin-top:8px">${esc(T('Conectores ativos', 'Active connectors'))}: ${count}</p>
    <div class="downloads" style="margin-top:18px">
      <form method="post" action="/conectar-ia/gerar" style="display:inline"><button class="btn" type="submit" style="${btnStyle}">${esc(T('Gerar token de conexão', 'Generate connection token'))}</button></form>
      ${
        count > 0
          ? `<form method="post" action="/conectar-ia/revogar" style="display:inline"><button class="btn" type="submit" style="${btnStyle};background:#5a2a2a">${esc(T('Revogar todos', 'Revoke all'))}</button></form>`
          : ''
      }
    </div>`;
  return shell(title, body, { lang: opts.lang, user: opts.user, noindex: true });
}
