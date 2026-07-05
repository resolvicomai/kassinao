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

export function landingPage(lang: Locale): string {
  const pt = lang === 'pt';
  const text = pt
    ? 'Gravador de voz do Discord, open source e auto-hospedado — uma faixa separada por pessoa, com transcrição e ata geradas por IA.'
    : 'Open-source, self-hosted Discord voice recorder — one separate track per person, with AI-generated transcript and meeting minutes.';
  const demoCta = pt ? '▶️ Ver o exemplo ao vivo' : '▶️ See the live example';
  const repoCta = pt ? '⭐ Código no GitHub' : '⭐ Code on GitHub';
  const mcpCta = pt ? '🔌 Conectar ao Claude/Cursor' : '🔌 Connect Claude/Cursor';
  // CTA do conector de IA só quando ele está ligado neste servidor
  const mcpButton = config.mcpEnabled
    ? `\n      <a class="btn" href="/conectar-ia" style="background:#3a3c42">${mcpCta}</a>`
    : '';
  const body = `<h1>🎙️ Kassinão</h1>
    <p class="muted" style="margin-top:12px">${text}</p>
    <div class="downloads" style="margin-top:18px">
      <a class="btn" href="/demo">${demoCta}</a>
      <a class="btn" href="https://github.com/resolvicomai/kassinao" style="background:#3a3c42">${repoCta}</a>${mcpButton}
    </div>`;
  // landing é indexável (sem noindex) — é a vitrine pública
  return shell('Kassinão', body, { lang });
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
