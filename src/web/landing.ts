import { config } from '../config';
import { Locale } from '../i18n';

// ============================================================================
// SITE VITRINE — minimalista, real, com impacto e luxo. Público/indexável.
// Documento próprio, self-contained (CSP: CSS + SVG inline). Bilíngue EN/pt-BR
// independentes. UMA ação: GitHub (open-source; o README tem tudo). Sem pilha de
// botões, sem seção de deploy. O produto se mostra na própria linguagem.
// Separação dura: nenhuma URL de gravação/app aqui; só o link único "entrar"
// (rodapé) leva ao app privado em /app.
// ============================================================================

const REPO_URL = 'https://github.com/resolvicomai/kassinao';
const NPM_URL = 'https://www.npmjs.com/package/kassinao-mcp';
const ghHref = (): string => (config.repoPublic ? REPO_URL : NPM_URL);
const APP_BRIDGE = '/auth/login?next=%2Fapp';

const FAVICON =
  "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E%3Crect%20width='32'%20height='32'%20rx='7'%20fill='%235865F2'/%3E%3Ctext%20x='16'%20y='23'%20font-size='19'%20font-weight='bold'%20text-anchor='middle'%20fill='white'%20font-family='sans-serif'%3EK%3C/text%3E%3C/svg%3E";

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const LANDING_CSS = `
:root{
  --bg:#0d0d0f; --bg-weak:#161619; --text:#a9a7a5; --text-weak:#6f6d71; --text-strong:#f4f2f0;
  --border:rgba(255,255,255,.1); --border-strong:rgba(255,255,255,.2);
  --accent:#5865f2; --accent-h:#4752c4; --accent-soft:rgba(88,101,242,.16); --link:#7f8cff;
  --c0:#7b90f7; --c1:#3dbf7a; --c4:#29b0e8;
  --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Ubuntu,sans-serif;
  --mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  --wrap:1080px; color-scheme:dark;
}
*{box-sizing:border-box;margin:0}
html,body{max-width:100%;overflow-x:clip}
body{background:var(--bg);color:var(--text);font-family:var(--sans);line-height:1.55;-webkit-font-smoothing:antialiased}
a{color:inherit}
.mono{font-family:var(--mono)}
.wrap{max-width:var(--wrap);margin:0 auto;padding:0 28px}
section{padding:clamp(72px,13vw,150px) 0}
section+section{border-top:1px solid var(--border)}
h1,h2{color:var(--text-strong);font-weight:600;letter-spacing:-.025em;line-height:1.05}
h2{font-size:clamp(1.7rem,3.6vw,2.5rem)}
a:focus-visible,button:focus-visible,.btn:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:5px}
.kicker{font-family:var(--mono);font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--text-weak);margin-bottom:20px}
/* nav — mínima: marca + GitHub + idioma */
.nav{position:sticky;top:0;z-index:30;background:rgba(13,13,15,.7);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid var(--border)}
.nav .wrap{display:flex;align-items:center;height:64px}
.brand{font-family:var(--mono);font-weight:500;color:var(--text-strong);text-decoration:none;font-size:15px;letter-spacing:-.01em}
.brand .car{color:var(--accent);animation:blink 1.2s step-end infinite}
.nav .sp{flex:1}
.nav a.gh{color:var(--text-weak);text-decoration:none;font-size:14px;margin-right:20px}
.nav a.gh:hover{color:var(--text-strong)}
.lang a{color:var(--text-weak);text-decoration:none;padding:0 3px;font-size:13px}
.lang a.on{color:var(--text-strong)}
.lang span{opacity:.35}
/* hero */
.hero .wrap{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.12fr);gap:clamp(32px,5vw,72px);align-items:center}
.hero h1{font-size:clamp(2.4rem,5.6vw,4rem);margin-bottom:24px}
.sub{font-size:clamp(1.05rem,1.6vw,1.28rem);color:var(--text);max-width:42ch;line-height:1.5}
.act{display:flex;align-items:center;gap:22px;margin-top:38px}
.btn{display:inline-flex;align-items:center;gap:9px;font:inherit;font-size:15px;font-weight:600;text-decoration:none;padding:13px 24px;border-radius:10px;background:var(--text-strong);color:#0d0d0f;border:1px solid var(--text-strong);transition:transform .15s,opacity .15s}
.btn:hover{transform:translateY(-1px);opacity:.9}
.tlink{color:var(--text-weak);text-decoration:none;font-size:14.5px;border-bottom:1px solid transparent;transition:color .15s,border-color .15s}
.tlink:hover{color:var(--text-strong);border-color:var(--border-strong)}
/* framed product art */
.frame{border:1px solid var(--border);border-radius:16px;background:linear-gradient(180deg,var(--bg-weak),var(--bg));overflow:hidden;min-width:0;box-shadow:0 30px 80px -40px rgba(0,0,0,.9)}
.fictional{font-family:var(--mono);font-size:10.5px;letter-spacing:.04em;color:var(--text-weak);padding:9px 16px;border-top:1px solid var(--border)}
.rail{overflow-x:auto}
.wv{width:100%;height:34px;display:block}
/* architecture contrast */
.two{display:grid;grid-template-columns:1fr 1fr;min-width:520px}
.two>div{padding:20px}
.two .l{border-right:1px solid var(--accent)}
.lbl{font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-weak);margin-bottom:14px}
.two .cap{font-family:var(--mono);font-size:11px;color:var(--text-weak);margin-top:12px}
/* ask / qa */
.qa{border:1px solid var(--border);border-radius:14px;background:var(--bg-weak);padding:20px 22px;box-shadow:0 30px 80px -40px rgba(0,0,0,.9)}
.q{font-size:14px;color:var(--text-strong)}
.q .cmd{font-family:var(--mono);color:var(--accent);margin-right:8px}
.ans{margin-top:12px;display:flex;flex-direction:column;gap:8px}
.ans .it{font-size:14px;display:flex;flex-wrap:wrap;gap:10px;align-items:baseline;color:var(--text)}
.cite{font-family:var(--mono);font-size:11px;color:var(--accent);background:var(--accent-soft);border-radius:6px;padding:2px 9px;text-decoration:none;white-space:nowrap}
.cite:hover,.cite:focus-visible{transform:translateY(-2px);box-shadow:0 0 0 4px var(--accent-soft);outline:none;transition:transform .18s,box-shadow .18s}
/* two-column prose block */
.beat{display:grid;grid-template-columns:minmax(0,.85fr) minmax(0,1.15fr);gap:clamp(28px,5vw,72px);align-items:center}
.beat.rev>div:first-child{order:2}
.beat .txt h2{margin-bottom:16px}
.beat .txt p{max-width:38ch}
/* closing */
.close{text-align:center}
.close .wrap{max-width:720px}
.close p{font-size:clamp(1.05rem,1.7vw,1.3rem);color:var(--text);margin:0 auto 34px;max-width:52ch}
.close .act{justify-content:center}
/* footer */
footer{border-top:1px solid var(--border);padding:40px 0;color:var(--text-weak);font-size:13px}
footer .wrap{display:flex;flex-wrap:wrap;gap:14px 26px;align-items:center;justify-content:space-between}
footer a{color:var(--text-weak);text-decoration:none}
footer a:hover{color:var(--text-strong)}
.endmark{font-family:var(--mono);color:var(--text-strong)}
.endmark .car{color:var(--accent);animation:blink 1.2s step-end infinite}
@keyframes blink{50%{opacity:0}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
@media (max-width:840px){
  .hero .wrap,.beat{grid-template-columns:1fr}
  .beat.rev>div:first-child{order:0}
}
@media (max-width:600px){
  /* o contraste Diarização×Kassinão empilha — lado a lado ele estoura a moldura
     (overflow:hidden cortava o painel direito sem dar scroll) */
  .two{grid-template-columns:1fr;min-width:0}
  .two .l{border-right:0;border-bottom:1px solid var(--accent)}
}
`;

export function landingPage(lang: Locale): string {
  const pt = lang === 'pt';
  const T = (p: string, e: string): string => (pt ? p : e);

  const metaTitle = T('Kassinão — quem falou é fato, não chute', 'Kassinão — who spoke is a fact, not a guess');
  const metaDesc = T(
    'Gravador de voz do Discord, open-source e no seu servidor. Uma faixa por pessoa: quem falou é garantido pela captação, não pela diarização. Transcrição, ata por IA e /perguntar. AGPL.',
    'Open-source, self-hosted Discord voice recorder. One track per person, so attribution is structural — not diarization. Transcript, AI minutes, and ask-your-meetings. AGPL.',
  );
  const langUrl = `${config.baseUrl}/?lang=${pt ? 'pt' : 'en'}`;
  const langToggle = `<span class="lang"><a href="?lang=en"${!pt ? ' class="on"' : ''}>EN</a><span>·</span><a href="?lang=pt"${pt ? ' class="on"' : ''}>PT</a></span>`;
  const ghLabel = config.repoPublic ? 'GitHub' : 'npm';

  const nav = `<nav class="nav"><div class="wrap">
    <a class="brand" href="/">kassinao<span class="car">▌</span></a>
    <span class="sp"></span>
    <a class="gh" href="${ghHref()}">${ghLabel}</a>
    ${langToggle}
  </div></nav>`;

  // ---- product art: a gravação na linguagem do próprio produto ----
  const line = (t: string, nm: string, cv: string, txt: string): string =>
    `<div class="kh-ln"><time>${t}</time><b style="color:var(${cv})">${nm}</b><span>${txt}</span></div>`;
  const bars = [
    '<rect x="8" y="10" width="8" height="8" rx="2"/><rect x="26" y="6" width="8" height="16" rx="2"/><rect x="44" y="3" width="8" height="22" rx="2"/><rect x="62" y="8" width="8" height="12" rx="2"/><rect x="80" y="11" width="8" height="6" rx="2"/><rect x="98" y="12" width="8" height="4" rx="2"/><rect x="116" y="12" width="8" height="4" rx="2"/><rect x="134" y="11" width="8" height="6" rx="2"/><rect x="152" y="9" width="8" height="10" rx="2"/><rect x="188" y="5" width="8" height="18" rx="2"/><rect x="206" y="2" width="8" height="24" rx="2"/><rect x="224" y="4" width="8" height="20" rx="2"/><rect x="248" y="11" width="8" height="6" rx="2"/><rect x="266" y="12" width="8" height="4" rx="2"/>',
    '<rect x="8" y="13" width="8" height="3" rx="1.5"/><rect x="26" y="12" width="8" height="4" rx="2"/><rect x="44" y="12" width="8" height="4" rx="2"/><rect x="62" y="11" width="8" height="6" rx="2"/><rect x="80" y="8" width="8" height="12" rx="2"/><rect x="98" y="5" width="8" height="18" rx="2"/><rect x="116" y="4" width="8" height="20" rx="2"/><rect x="134" y="7" width="8" height="14" rx="2"/><rect x="188" y="6" width="8" height="16" rx="2"/><rect x="206" y="3" width="8" height="22" rx="2"/><rect x="224" y="4" width="8" height="20" rx="2"/><rect x="248" y="10" width="8" height="8" rx="2"/><rect x="266" y="12" width="8" height="4" rx="2"/>',
    '<rect x="8" y="10" width="8" height="8" rx="2"/><rect x="26" y="7" width="8" height="14" rx="2"/><rect x="44" y="4" width="8" height="20" rx="2"/><rect x="62" y="3" width="8" height="22" rx="2"/><rect x="80" y="6" width="8" height="16" rx="2"/><rect x="98" y="10" width="8" height="8" rx="2"/><rect x="116" y="12" width="8" height="4" rx="2"/><rect x="134" y="12" width="8" height="4" rx="2"/><rect x="152" y="13" width="8" height="3" rx="1.5"/><rect x="188" y="13" width="8" height="3" rx="1.5"/><rect x="206" y="12" width="8" height="4" rx="2"/><rect x="224" y="12" width="8" height="4" rx="2"/><rect x="248" y="9" width="8" height="10" rx="2"/><rect x="266" y="6" width="8" height="16" rx="2"/>',
  ];
  const wave = (cv: string, cross: boolean, b: string): string =>
    `<svg class="wv" viewBox="0 0 285 28" preserveAspectRatio="none" style="color:var(${cv})" aria-hidden="true">${cross ? '<rect x="182" y="0" width="60" height="28" fill="var(--accent)" opacity=".1"/><rect x="212" y="0" width="1.4" height="28" fill="var(--accent)" opacity=".45"/>' : ''}<g fill="currentColor">${b}</g></svg>`;

  // role="group" (não "img"): img é children-presentational e ESCONDERIA o link
  // /demo interno de leitores de tela; group mantém o rótulo e expõe o conteúdo
  const heroArt = `<figure class="frame kh" role="group" aria-label="${esc(
    T(
      'Gravação ao vivo de #estrategia: três pessoas, cada uma na própria faixa; às 00:14 duas falam juntas e cada linha da transcrição fica na cor de quem falou. Dados fictícios.',
      'Live recording of #estrategia: three people, each on their own track; at 00:14 two speak at once and each transcript line keeps the color of who spoke. Sample data.',
    ),
  )}">
    <style>
      .kh .b{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border)}
      .kh .b .d{display:inline-flex;gap:6px}.kh .b .d i{width:9px;height:9px;border-radius:50%;background:var(--border)}
      .kh .b .id{font-family:var(--mono);font-size:12px;color:var(--text-weak);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.kh .b .id b{color:var(--text-strong);font-weight:600}
      .kh .b .rec{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:10px;font-weight:700;letter-spacing:.05em;color:#fff;background:#da373c;padding:3px 9px;border-radius:999px}.kh .b .rec i{width:6px;height:6px;border-radius:50%;background:#fff;animation:khp 1.6s ease-in-out infinite}
      .kh .tk{padding:16px 16px 8px}
      .kh .lane{display:grid;grid-template-columns:72px minmax(0,1fr);align-items:center;gap:12px;margin-bottom:9px}
      .kh .nm{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.kh .nm i{width:7px;height:7px;border-radius:50%;flex:none}
      .kh .sc{border-top:1px solid var(--border);padding:14px 16px}
      .kh-ln{display:grid;grid-template-columns:auto auto minmax(0,1fr);gap:9px;align-items:baseline;font-size:12.5px;line-height:1.5;padding:3px 0}.kh-ln time{font-family:var(--mono);font-size:11px;color:var(--text-weak)}.kh-ln b{font-weight:600;white-space:nowrap}
      .kh .as{border-top:1px solid var(--border);padding:14px 16px}
      .kh .q{font-size:12.5px;color:var(--text-strong)}.kh .q .cmd{font-family:var(--mono);color:var(--accent);margin-right:6px}
      .kh .a{font-size:12.5px;line-height:1.55;margin-top:9px}.kh .a b{color:var(--text-strong);font-weight:600}
      .kh .cite{display:inline-block;font-family:var(--mono);font-size:11px;color:var(--accent);background:var(--accent-soft);border-radius:6px;padding:1px 8px;text-decoration:none}
      @keyframes khp{50%{opacity:.25}}
      @media (max-width:420px){.kh .lane{grid-template-columns:54px minmax(0,1fr)}}
    </style>
    <div class="b"><span class="d"><i></i><i></i><i></i></span><span class="id"><b>#estrategia</b> · rec_8f2a1c</span><span class="rec"><i></i>REC</span></div>
    <div class="tk">
      <div class="lane"><span class="nm" style="color:var(--c4)"><i style="background:var(--c4)"></i>Priscila</span>${wave('--c4', true, bars[0])}</div>
      <div class="lane"><span class="nm" style="color:var(--c1)"><i style="background:var(--c1)"></i>Rafael</span>${wave('--c1', true, bars[1])}</div>
      <div class="lane"><span class="nm" style="color:var(--c0)"><i style="background:var(--c0)"></i>Marina</span>${wave('--c0', false, bars[2])}</div>
    </div>
    <div class="sc">
      ${line('00:11', 'Marina', '--c0', T('então o rollback fica pra depois do freeze?', 'so the rollback waits until after the freeze?'))}
      ${line('00:14', 'Priscila', '--c4', T('não — eu já subi o hotfix', 'no — I already pushed the hotfix'))}
      ${line('00:14', 'Rafael', '--c1', T('espera, subiu em prod?', 'wait, pushed to prod?'))}
    </div>
    <div class="as">
      <div class="q"><span class="cmd">/${T('perguntar', 'ask')}</span>${T('o que ficou decidido sobre o rollback?', 'what did we decide about the rollback?')}</div>
      <div class="a">${T(
        'Segurar até depois do freeze; o hotfix da Priscila já subiu e fica em observação — <b>responsável: Priscila</b>.',
        "Hold it until after the freeze; Priscila's hotfix already shipped and stays under watch — <b>owner: Priscila</b>.",
      )} <a class="cite" href="/demo">00:14 ↩</a></div>
    </div>
    <figcaption class="fictional">${T('dados fictícios', 'sample data')}</figcaption>
  </figure>`;

  const hero = `<section class="hero"><div class="wrap">
    <div>
      <h1>${T('Quem falou<br>é fato.<br>Não chute.', 'Who spoke<br>is a fact.<br>Not a guess.')}</h1>
      <p class="sub">${T(
        'Open-source, no seu servidor. Cada pessoa grava na própria faixa — então a transcrição, a ata por IA e o /perguntar já nascem sabendo de quem é cada linha.',
        'Open-source, self-hosted. Each person records on their own track — so the transcript, the AI minutes, and /ask already know whose every line is.',
      )}</p>
      <div class="act">
        <a class="btn" href="${ghHref()}">${config.repoPublic ? T('Ver no GitHub', 'View on GitHub') : T('Ver no npm', 'View on npm')} →</a>
        <a class="tlink" href="/demo">${T('ver uma gravação de exemplo', 'see a sample recording')}</a>
      </div>
    </div>
    ${heroArt}
  </div></section>`;

  // architecture — uma linha, o contraste faz o argumento
  const barsGrey =
    '<polyline points="0,23 14,12 26,30 40,10 54,33 68,16 82,28 96,14 110,31 124,18 138,27 152,12 166,30 180,15 194,29 208,17 222,26 240,22" fill="none" stroke="var(--text-weak)" stroke-width="1.5"/><line x1="120" y1="2" x2="120" y2="44" stroke="var(--accent)" stroke-width="1.4" stroke-dasharray="4 4"/>';
  const architecture = `<section><div class="wrap">
    <div class="beat">
      <div class="txt">
        <div class="kicker">${T('O mecanismo', 'The mechanism')}</div>
        <h2>${T('Não é diarização.<br>É arquitetura.', 'Not diarization.<br>Architecture.')}</h2>
        <p>${T(
          'Uma faixa misturada faz de "quem falou" um chute — e ela erra justo na conversa cruzada, no sotaque e no nome fora do inglês. Faixas separadas fazem disso uma propriedade da captação.',
          'One mixed track makes "who spoke" a guess — and it fails exactly on crosstalk, accents, and non-English names. Separate tracks make it a property of the wiring.',
        )}</p>
      </div>
      <div class="rail"><figure class="frame"><div class="two">
        <div class="l"><div class="lbl">${T('Diarização', 'Diarization')}</div>
          <svg width="100%" height="46" viewBox="0 0 240 46" preserveAspectRatio="none" aria-hidden="true">${barsGrey}</svg>
          <div class="cap">${T('1 faixa · quem falou = chute', '1 track · who spoke = a guess')} <span style="color:var(--accent)">?</span></div></div>
        <div><div class="lbl" style="color:var(--text-strong)">Kassinão</div>
          ${wave('--c4', false, bars[0])}${wave('--c1', false, bars[1])}${wave('--c0', false, bars[2])}
          <div class="cap">${T('FLAC · 1 faixa/pessoa · sincronizado', 'FLAC · 1 track/speaker · sample-synced')}</div></div>
      </div><figcaption class="fictional">${T('dados fictícios', 'sample data')}</figcaption></figure></div>
    </div>
  </div></section>`;

  // ask — uma linha + a resposta que aponta pro minuto
  const ask = `<section><div class="wrap">
    <div class="beat rev">
      <div class="qa">
        <div class="q"><span class="cmd">/${T('perguntar', 'ask')}</span>${T('o que ficou pendente essa semana?', "what's still pending this week?")}</div>
        <div class="ans">
          <div class="it"><span>${T('Acompanhar o hotfix em prod — Priscila', 'Watch the hotfix in prod — Priscila')}</span><a class="cite" href="/demo">#estrategia 00:14 ↩</a></div>
          <div class="it"><span>${T('Rodar o load test — Mei', 'Run the load test — Mei')}</span><a class="cite" href="/demo">#sprint 12:19 ↩</a></div>
        </div>
      </div>
      <div class="txt">
        <div class="kicker">${T('A resposta', 'The answer')}</div>
        <h2>${T('Pergunte.<br>Ele cita o segundo.', 'Ask.<br>It cites the second.')}</h2>
        <p>${T(
          'Em linguagem normal, no Discord, na web ou em qualquer cliente MCP (Claude, Cursor) — e toda resposta aponta pro instante exato em que foi dito, sob a mesma regra de acesso.',
          'In plain language — on Discord, the web, or any MCP client (Claude, Cursor) — and every answer points at the exact moment it was said, under the same access rule.',
        )}</p>
      </div>
    </div>
  </div></section>`;

  // closing — honesto, uma linha, uma ação
  const closing = `<section class="close"><div class="wrap">
    <div class="kicker">${T('É open-source', "It's open source")}</div>
    <h2>${T('É seu. Roda na sua máquina.', "It's yours. It runs on your box.")}</h2>
    <p>${T(
      'Um projeto solo, self-hosted, sem SaaS e sem assinatura. Sem app de celular, sem linha de suporte. Setup e o resto: está tudo no README.',
      "A solo, self-hosted project — no SaaS, no subscription. No mobile app, no support line. Setup and everything else: it's all in the README.",
    )}</p>
    <div class="act">
      <a class="btn" href="${ghHref()}">${config.repoPublic ? T('Ver no GitHub', 'View on GitHub') : T('Ver no npm', 'View on npm')} →</a>
      <a class="tlink" href="/demo">${T('ver uma gravação de exemplo', 'see a sample recording')}</a>
    </div>
  </div></section>`;

  const footer = `<footer><div class="wrap">
    <span class="endmark">kassinao<span class="car">▌</span></span>
    <span>AGPL-3.0 · <a href="${ghHref()}">${ghLabel}</a> · <a href="${NPM_URL}" class="mono">kassinao-mcp</a> · <a href="${APP_BRIDGE}">${T('entrar', 'sign in')}</a></span>
    ${langToggle}
  </div></footer>`;

  return `<!doctype html>
<html lang="${pt ? 'pt-BR' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0d0d0f">
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
${nav}
${hero}
${architecture}
${ask}
${closing}
${footer}
</body>
</html>`;
}
