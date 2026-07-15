import type { Locale } from '../i18n';

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export type DiscordDemoPhase = 0 | 1 | 2 | 3 | 4 | 5 | 'auto';

export function discordDemoPage(locale: Locale, phase: DiscordDemoPhase = 'auto'): string {
  const pt = locale === 'pt';
  const T = (portuguese: string, english: string): string => (pt ? portuguese : english);
  const safePhase = phase === 'auto' ? 'auto' : String(Math.max(0, Math.min(5, phase)));

  const command = (name: string, detail?: string): string =>
    `<span class="slash">/${esc(name)}</span>${detail ? `<span class="command-detail">${esc(detail)}</span>` : ''}`;

  return `<!doctype html>
<html lang="${pt ? 'pt-BR' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(T('Demo fictícia do Kassinão no Discord', 'Fictional Kassinão Discord demo'))}</title>
<style>
  * { box-sizing: border-box; }
  html, body { width: 100%; height: 100%; }
  body {
    margin: 0;
    overflow: hidden;
    background: #111214;
    color: #f2f3f5;
    font-family: "gg sans", "Noto Sans", "Helvetica Neue", Arial, sans-serif;
  }
  .discord {
    display: grid;
    grid-template-columns: 72px 244px minmax(0, 1fr);
    width: 100vw;
    height: 100vh;
    min-width: 980px;
    min-height: 620px;
    background: #313338;
  }
  .servers {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 12px 0;
    background: #1e1f22;
  }
  .server {
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    border-radius: 16px;
    background: #313338;
    color: #dbdee1;
    font-weight: 800;
  }
  .server.active { border-radius: 14px; background: #5865f2; color: white; }
  .server.active::before {
    content: "";
    position: absolute;
    left: 0;
    width: 4px;
    height: 40px;
    border-radius: 0 4px 4px 0;
    background: white;
  }
  .server.small { width: 40px; height: 40px; border-radius: 50%; color: #949ba4; font-size: 12px; }
  .channels { display: grid; grid-template-rows: 48px 1fr 52px; background: #2b2d31; }
  .server-name {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    border-bottom: 1px solid #1f2023;
    box-shadow: 0 1px 0 rgb(0 0 0 / .2);
    font-size: 15px;
    font-weight: 700;
  }
  .channel-list { padding: 18px 8px; }
  .category { margin: 0 8px 8px; color: #949ba4; font-size: 11px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; }
  .channel {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    padding: 0 10px;
    border-radius: 4px;
    color: #949ba4;
    font-size: 15px;
    font-weight: 600;
  }
  .channel::before { content: "#"; color: #80848e; font-size: 20px; font-weight: 400; }
  .channel.active { background: #404249; color: #f2f3f5; }
  .voice::before { content: "◖"; font-size: 18px; }
  .voice-user { margin: 3px 0 3px 35px; color: #b5bac1; font-size: 13px; }
  .voice-user.bot-voice { display: flex; align-items: center; gap: 5px; color: #f2f3f5; }
  .voice-user.bot-voice strong { color: #f23f43; font-size: 9px; font-weight: 800; }
  .voice-bot-mark { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: #5865f2; color: white; font-size: 8px; font-weight: 800; }
  .profile { display: flex; align-items: center; gap: 9px; padding: 0 9px; background: #232428; }
  .profile-avatar { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; background: #5865f2; font-size: 12px; font-weight: 800; }
  .profile-copy { min-width: 0; }
  .profile-copy strong, .profile-copy span { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .profile-copy strong { font-size: 12px; }
  .profile-copy span { color: #949ba4; font-size: 10px; }
  .chat { display: grid; grid-template-rows: 48px 1fr 54px; min-width: 0; background: #313338; }
  .chat-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 18px;
    border-bottom: 1px solid #26272b;
    box-shadow: 0 1px 0 rgb(0 0 0 / .18);
  }
  .chat-head .hash { color: #80848e; font-size: 24px; }
  .chat-head strong { font-size: 15px; }
  .chat-head span:last-child { color: #949ba4; font-size: 13px; }
  .fixture {
    margin-left: auto;
    padding: 5px 8px;
    border: 1px solid #4e5058;
    border-radius: 5px;
    color: #b5bac1 !important;
    font-size: 10px !important;
    font-weight: 800;
    letter-spacing: .04em;
    text-transform: uppercase;
  }
  .messages {
    align-self: end;
    overflow: hidden;
    padding: 8px 20px;
  }
  .message { display: none; grid-template-columns: 34px minmax(0, 1fr); gap: 10px; padding: 3px 0; }
  .avatar { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; background: #4e5058; font-size: 11px; font-weight: 800; }
  .avatar.bot { background: #5865f2; color: white; }
  .meta { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
  .meta strong { font-size: 14px; }
  .meta time { color: #949ba4; font-size: 10px; }
  .bot-tag { padding: 1px 4px; border-radius: 3px; background: #5865f2; color: white; font-size: 9px; font-weight: 800; }
  .privacy-label {
    display: inline-flex;
    align-items: center;
    width: fit-content;
    margin-top: 6px;
    padding: 3px 6px;
    border-radius: 4px;
    background: rgb(88 101 242 / .18);
    color: #c9cdfb;
    font-size: 9px;
    font-weight: 800;
    letter-spacing: .04em;
    text-transform: uppercase;
  }
  .channel-label { margin-left: auto; color: #949ba4; font-size: 9px; font-weight: 700; text-transform: uppercase; }
  .copy { margin: 3px 0 0; color: #dbdee1; font-size: 14px; line-height: 1.35; }
  .command-line { display: flex; align-items: center; gap: 8px; margin-top: 5px; }
  .slash { color: #c9cdfb; font-size: 15px; font-weight: 800; }
  .command-detail { color: #dbdee1; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .embed {
    max-width: 720px;
    margin-top: 4px;
    padding: 8px 11px;
    border-left: 4px solid #5865f2;
    border-radius: 4px;
    background: #2b2d31;
  }
  .embed-title { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 800; }
  .rec-dot { width: 8px; height: 8px; border-radius: 50%; background: #f23f43; box-shadow: 0 0 0 4px rgb(242 63 67 / .12); }
  .embed p { margin: 3px 0 0; color: #b5bac1; font-size: 11px; line-height: 1.35; }
  .actions { display: flex; gap: 8px; margin-top: 5px; }
  .action { padding: 5px 9px; border-radius: 4px; background: #5865f2; color: white; font-size: 10px; font-weight: 700; }
  .action.secondary { background: #4e5058; }
  .answer { max-width: 760px; margin-top: 7px; padding: 10px 12px; border-radius: 5px; background: #2b2d31; color: #dbdee1; font-size: 12px; line-height: 1.45; }
  .answer a { color: #00a8fc; font-weight: 700; text-decoration: none; }
  .dm-preview {
    max-width: 720px;
    margin-top: 4px;
    padding: 6px 10px;
    border: 1px solid #4e5058;
    border-radius: 5px;
    background: #232428;
  }
  .dm-preview p { margin: 3px 0 0; color: #b5bac1; font-size: 10px; line-height: 1.35; }
  .composer { display: flex; align-items: center; margin: 5px 20px 10px; padding: 0 15px; border-radius: 8px; background: #383a40; color: #949ba4; font-size: 12px; }
  .composer::before { content: "+"; margin-right: 12px; color: #b5bac1; font-size: 22px; }

  body[data-phase="0"] .s0,
  body[data-phase="1"] .s0, body[data-phase="1"] .s1,
  body[data-phase="2"] .s0, body[data-phase="2"] .s1, body[data-phase="2"] .s2,
  body[data-phase="3"] .s0, body[data-phase="3"] .s1, body[data-phase="3"] .s2, body[data-phase="3"] .s3,
  body[data-phase="4"] .s0, body[data-phase="4"] .s1, body[data-phase="4"] .s2, body[data-phase="4"] .s3, body[data-phase="4"] .s4,
  body[data-phase="5"] .s0, body[data-phase="5"] .s1, body[data-phase="5"] .s2, body[data-phase="5"] .s3, body[data-phase="5"] .s4, body[data-phase="5"] .s5 {
    display: grid;
  }
  body[data-phase="auto"] .message { display: grid; animation: reveal 12s infinite both; }
  body[data-phase="auto"] .s0 { animation-delay: 0s; }
  body[data-phase="auto"] .s1 { animation-delay: .7s; }
  body[data-phase="auto"] .s2 { animation-delay: 1.7s; }
  body[data-phase="auto"] .s3 { animation-delay: 2.7s; }
  body[data-phase="auto"] .s4 { animation-delay: 3.7s; }
  body[data-phase="auto"] .s5 { animation-delay: 4.9s; }
  @keyframes reveal {
    0%, 4% { opacity: 0; transform: translateY(8px); }
    8%, 86% { opacity: 1; transform: none; }
    94%, 100% { opacity: 0; transform: translateY(-4px); }
  }
  @media (prefers-reduced-motion: reduce) {
    body[data-phase="auto"] .message { animation: none; opacity: 1; }
  }
</style>
</head>
<body data-phase="${safePhase}">
  <main class="discord" aria-label="${esc(T('Demonstração fictícia do fluxo do Kassinão dentro do Discord', 'Fictional demo of Kassinão inside Discord'))}">
    <aside class="servers" aria-hidden="true">
      <span class="server">D</span>
      <span class="server active">k/</span>
      <span class="server small">AI</span>
      <span class="server small">+</span>
    </aside>
    <aside class="channels">
      <div class="server-name">Nebula Lab <span>⌄</span></div>
      <div class="channel-list">
        <p class="category">${esc(T('Canais de texto', 'Text channels'))}</p>
        <div class="channel">${esc(T('geral', 'general'))}</div>
        <div class="channel active">aurora-launch</div>
        <p class="category" style="margin-top:20px">${esc(T('Canais de voz', 'Voice channels'))}</p>
        <div class="channel voice active">${esc(T('Beta Aurora', 'Aurora beta'))}</div>
        <div class="voice-user">Luna</div>
        <div class="voice-user">${esc(T('Íris', 'Iris'))}</div>
        <div class="voice-user">Noah</div>
        <div class="voice-user bot-voice"><span class="voice-bot-mark">k/</span>Kassinão</div>
      </div>
      <div class="profile"><span class="profile-avatar">L</span><span class="profile-copy"><strong>Luna</strong><span>${esc(T('Disponível', 'Online'))}</span></span></div>
    </aside>
    <section class="chat">
      <header class="chat-head"><span class="hash">#</span><strong>aurora-launch</strong><span>${esc(T('A call vira memória do time', 'The call becomes team memory'))}</span><span class="fixture">${esc(T('demo fictícia', 'fictional demo'))}</span></header>
      <div class="messages">
        <article class="message s0">
          <span class="avatar">L</span>
          <div><div class="meta"><strong>Luna</strong><time>10:00</time></div><span class="privacy-label">${esc(T('só você', 'only you'))}</span><div class="command-line">${command(T('gravar', 'record'), T('Beta Aurora', 'Aurora beta'))}</div></div>
        </article>
        <article class="message s1">
          <span class="avatar bot">k/</span>
          <div><div class="meta"><strong>Kassinão</strong><span class="bot-tag">APP</span><time>10:00</time></div>
            <div class="embed"><div class="embed-title"><span class="rec-dot"></span>${esc(T('Gravando Beta Aurora', 'Recording Aurora beta'))}<span class="channel-label">${esc(T('visível no canal', 'visible in channel'))}</span></div><p>${esc(T('A captura está ativa e o painel deixa o aviso visível. Cada conta que falar gera uma faixa separada; os controles funcionam só para pessoas autorizadas.', 'Capture is active and the panel keeps the notice visible. Each account that speaks creates a separate track; controls work only for authorized people.'))}</p><div class="actions"><span class="action">${esc(T('Marcar momento', 'Mark moment'))}</span><span class="action secondary">${esc(T('Parar', 'Stop'))}</span></div></div>
          </div>
        </article>
        <article class="message s2">
          <span class="avatar">I</span>
          <div><div class="meta"><strong>${esc(T('Íris', 'Iris'))}</strong><time>10:14</time></div><span class="privacy-label">${esc(T('só você', 'only you'))}</span><div class="command-line">${command(T('nota', 'note'), T('Publicar a lista de convites até sexta', 'Publish the invite list by Friday'))}</div></div>
        </article>
        <article class="message s3">
          <span class="avatar">L</span>
          <div><div class="meta"><strong>Luna</strong><time>10:47</time></div><span class="privacy-label">${esc(T('só você', 'only you'))}</span><div class="command-line">${command(T('parar', 'stop'))}</div></div>
        </article>
        <article class="message s4">
          <span class="avatar bot">k/</span>
          <div><div class="meta"><strong>Kassinão</strong><span class="bot-tag">APP</span><time>10:48</time></div>
            <div class="embed"><div class="embed-title">${esc(T('Processamento concluído', 'Processing finished'))}<span class="channel-label">${esc(T('aviso genérico no canal', 'generic channel notice'))}</span></div><p>${esc(T('O processamento de uma gravação terminou. O bot tenta avisar pessoas autorizadas por DM; os detalhes continuam no app privado.', 'A recording finished processing. The bot attempts to notify authorized people by DM; details remain in the private app.'))}</p></div>
            <aside class="dm-preview" aria-label="${esc(T('Prévia da DM autorizada', 'Authorized DM preview'))}"><span class="privacy-label">${esc(T('DM autorizada · só você', 'authorized DM · only you'))}</span><p>${esc(T('Faixas, mix, nota no minuto 14 e, nesta instância com IA habilitada, transcrição e ata estão no app privado.', 'Tracks, mix, the note at minute 14, and, in this AI-enabled instance, transcript and meeting notes are in the private app.'))}</p><div class="actions"><span class="action">${esc(T('Abrir app privado', 'Open private app'))}</span></div></aside>
          </div>
        </article>
        <article class="message s5">
          <span class="avatar">L</span>
          <div><div class="meta"><strong>Luna</strong><time>11:08</time></div><span class="privacy-label">${esc(T('pergunta e resposta efêmeras · só você', 'ephemeral question and reply · only you'))}</span><div class="command-line">${command(T('perguntar', 'ask'), T('quem publica a lista da beta?', 'who publishes the beta invite list?'))}</div>
            <div class="answer"><strong>Kassinão:</strong> ${esc(T('Íris vai publicar a lista de convites até sexta.', 'Iris will publish the invite list by Friday.'))} <a href="#">${esc(T('Fonte: 00:14', 'Source: 00:14'))}</a></div>
          </div>
        </article>
      </div>
      <div class="composer">${esc(T('Conversar em #aurora-launch', 'Message #aurora-launch'))}</div>
    </section>
  </main>
</body>
</html>`;
}
