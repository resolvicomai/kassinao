import { config } from '../config';
import { Locale } from '../i18n';
import { msToClock } from '../processing/transcribe';
import { formatDuration, formatOffset } from '../recorder/RecordingSession';
import { RecordingMeta, TranscriptSegment } from '../store';
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
  transcriptRunning: { pt: '⚙️ Transcrevendo… (esta página se atualiza sozinha)', en: '⚙️ Transcribing… (this page refreshes itself)' },
  transcriptError: { pt: '⚠️ A transcrição falhou: ', en: '⚠️ Transcription failed: ' },
  transcriptEmpty: { pt: 'A transcrição terminou sem texto (só silêncio?).', en: 'The transcript finished empty (only silence?).' },
  transcriptDownload: { pt: '⬇️ Baixar (.md)', en: '⬇️ Download (.md)' },
  transcriptDownloadTxt: { pt: '⬇️ Baixar (.txt)', en: '⬇️ Download (.txt)' },
  notes: { pt: 'Notas', en: 'Notes' },
  cooking: { pt: 'O arquivo é processado na hora — gravações longas podem levar alguns segundos.', en: 'Files are processed on demand — long recordings may take a few seconds.' },
  livenote: {
    pt: '🔴 Gravação em andamento: os downloads trazem o áudio <strong>até este momento</strong>. Esta página se atualiza sozinha a cada 30 segundos.',
    en: '🔴 Recording in progress: downloads contain the audio <strong>up to this moment</strong>. This page refreshes itself every 30 seconds.',
  },
  timeline: { pt: 'Linha do tempo', en: 'Timeline' },
  del: { pt: '🗑️ Apagar gravação', en: '🗑️ Delete recording' },
  delconfirm: { pt: 'Apagar esta gravação para sempre? Não tem volta.', en: 'Delete this recording forever? There is no undo.' },
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
  form.delete { margin-top: 26px; border-top: 1px solid #3f4147; padding-top: 16px; }
  button.danger { background: none; border: 1px solid #da373c; color: #da373c; padding: 8px 14px;
                  border-radius: 8px; font-size: 14px; cursor: pointer; }
  button.danger:hover { background: #da373c; color: #fff; }
  .userbar { max-width: 640px; width: 100%; display: flex; justify-content: flex-end; align-items: center;
             gap: 8px; margin-bottom: 12px; font-size: 13px; color: #949ba4; }
  .userbar img { width: 22px; height: 22px; border-radius: 50%; }
  .note { background: #232428; border-left: 3px solid #f0b232; padding: 10px 14px; border-radius: 6px;
          font-size: 14px; margin-top: 14px; }
  footer { margin-top: 26px; font-size: 13px; color: #949ba4; }
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
</script>`;

function shell(title: string, body: string, opts: { user?: WebUser; lang?: Locale; refreshSeconds?: number } = {}): string {
  const userbar = opts.user
    ? `<div class="userbar">${opts.user.avatar ? `<img src="${esc(opts.user.avatar)}" alt="">` : ''}${esc(opts.user.name)}</div>`
    : '';
  const refresh = opts.refreshSeconds ? `<meta http-equiv="refresh" content="${opts.refreshSeconds}">` : '';
  return `<!doctype html>
<html lang="${opts.lang === 'en' ? 'en' : 'pt-BR'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${refresh}
<title>${esc(title)} — Kassinão</title>
<style>${SHELL_CSS}</style>
</head>
<body>
${userbar}
<div class="card">${body}</div>
${TZ_SCRIPT}
</body>
</html>`;
}

export function recordingPage(
  meta: RecordingMeta,
  opts: { live: boolean; canDelete: boolean; user: WebUser; lang: Locale; transcript?: TranscriptSegment[] },
): string {
  const { live, lang: l } = opts;
  const endedAt = meta.endedAt ?? Date.now();
  const badge = live ? `<span class="badge live">${p(l, 'live')}</span>` : `<span class="badge done">${p(l, 'done')}</span>`;

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
    meta.participants.length > 0
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

  const transcription = renderTranscription(meta, opts.transcript, l);

  const liveNote = live ? `<div class="note">${p(l, 'livenote')}</div>` : '';

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
    meta.expiresAt && !live
      ? `<footer>${p(l, 'expires', { date: ' ' }).replace(' ', datetime(meta.expiresAt, l))}</footer>`
      : '';

  return shell(
    `${p(l, 'recording')} ${meta.id}`,
    `<h1>🎙️ ${p(l, 'recording')} ${badge}</h1>
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
     ${meta.participants.length > 0 ? `<h2>${p(l, 'downloads')}</h2>` : ''}
     ${downloads}
     ${transcription}
     ${notes}
     ${events}
     ${deleteForm}
     ${expires}`,
    {
      user: opts.user,
      lang: l,
      // ao vivo OU transcrição em andamento: a página se atualiza sozinha
      refreshSeconds:
        live || meta.transcription?.status === 'pending' || meta.transcription?.status === 'running' ? 30 : undefined,
    },
  );
}

function renderTranscription(meta: RecordingMeta, transcript: TranscriptSegment[] | undefined, l: Locale): string {
  const state = meta.transcription;
  if (!state || state.status === 'disabled') return '';
  const title = `<h2>${p(l, 'transcript')}</h2>`;
  if (state.status === 'pending') return `${title}<p class="tstate">${p(l, 'transcriptPending')}</p>`;
  if (state.status === 'running') return `${title}<p class="tstate">${p(l, 'transcriptRunning')}</p>`;
  if (state.status === 'error') return `${title}<p class="tstate">${p(l, 'transcriptError')}${esc(state.error ?? '?')}</p>`;
  if (!transcript || transcript.length === 0) return `${title}<p class="tstate">${p(l, 'transcriptEmpty')}</p>`;

  const body = transcript
    .map(
      (s) =>
        `<p><time>${msToClock(s.startMs)}</time><span class="who">${esc(s.speaker)}:</span> ${esc(s.text)}</p>`,
    )
    .join('');
  return `${title}
    <div class="transcript">${body}</div>
    <div class="tdl">
      <a href="/rec/${meta.id}/transcricao.md">${p(l, 'transcriptDownload')}</a>
      <a href="/rec/${meta.id}/transcricao.txt">${p(l, 'transcriptDownloadTxt')}</a>
    </div>`;
}

export function messagePage(title: string, message: string, user?: WebUser, lang?: Locale): string {
  return shell(title, `<h1>${esc(title)}</h1><p class="muted" style="margin-top:12px">${esc(message)}</p>`, {
    user,
    lang,
  });
}

export function landingPage(lang: Locale): string {
  const text =
    lang === 'pt'
      ? 'Bot de gravação de voz do Discord — uma faixa separada e sincronizada por pessoa. Os links das gravações chegam pelo painel no chat do canal de voz.'
      : 'Discord voice recording bot — one separate, synchronized track per speaker. Recording links are posted on the panel in the voice channel chat.';
  return shell('Kassinão', `<h1>🎙️ Kassinão</h1><p class="muted" style="margin-top:12px">${text}</p>`, { lang });
}
