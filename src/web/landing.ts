import { config } from '../config';
import { Locale } from '../i18n';

// ============================================================================
// SITE VITRINE v9 — "O FILME DA CALL". Público/indexável.
// A página não descreve o produto: ela EXECUTA uma reunião enquanto o visitante
// rola. Hero = call começando (avatares entram, REC pulsa). Cena 1 = cada voz
// na própria faixa (waveforms se desenham; duas pessoas falam juntas e nada
// vira ruído). Cena 2 = /nota digita e o pino crava aos 00:14. Cena 3 = a call
// acaba e transcrição+ata se materializam sozinhas. Cena 4 = semanas depois,
// /perguntar responde com o MESMO pino de 00:14 (setup/payoff). Fechamento =
// UMA ação (GitHub). Todo conteúdo é fixture fictícia rotulada.
// Self-contained (CSP: CSS/SVG/JS inline; zero asset externo). Sem JS a página
// renderiza completa e estática; prefers-reduced-motion pula pro estado final.
// A única ponte público→app continua sendo o "entrar" do rodapé (/app).
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
  --c0:#7b90f7; --c1:#3dbf7a; --c4:#29b0e8; --rec:#e5484d;
  --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Ubuntu,sans-serif;
  --mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  --ease-out:cubic-bezier(.22,1,.36,1);
  --ease-spring:cubic-bezier(.34,1.56,.64,1);
  --wrap:880px; color-scheme:dark;
}
*{box-sizing:border-box;margin:0}
html,body{max-width:100%;overflow-x:clip}
body{background:var(--bg);color:var(--text);font-family:var(--sans);line-height:1.55;-webkit-font-smoothing:antialiased}
a{color:inherit}
.wrap{max-width:var(--wrap);margin:0 auto;padding:0 24px}
h1{color:var(--text-strong);font-weight:650;letter-spacing:-.03em;line-height:1.04;font-size:clamp(2.5rem,6.4vw,4.4rem)}
a:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:6px}
.skip{position:absolute;left:-9999px;top:0;background:var(--accent);color:#fff;padding:8px 14px;border-radius:0 0 8px 0;z-index:99}
.skip:focus{left:0}
/* nav mínima */
.nav{position:sticky;top:0;z-index:30;background:rgba(13,13,15,.72);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid var(--border)}
.nav .wrap{display:flex;align-items:center;height:60px}
.brand{font-family:var(--mono);font-weight:500;color:var(--text-strong);text-decoration:none;font-size:15px}
.brand .car{color:var(--accent);animation:blink 1.2s step-end infinite}
.nav .sp{flex:1}
.nav a.gh{color:var(--text-weak);text-decoration:none;font-size:14px;margin-right:20px}
.nav a.gh:hover{color:var(--text-strong)}
.lang a{color:var(--text-weak);text-decoration:none;padding:0 3px;font-size:13px}
.lang a.on{color:var(--text-strong)}
.lang span{opacity:.35}
/* moldura de cena (o "frame" do filme) */
.frame{border:1px solid var(--border);border-radius:16px;background:linear-gradient(180deg,var(--bg-weak),var(--bg));box-shadow:0 30px 80px -40px rgba(0,0,0,.9);padding:22px;position:relative}
.fict{font-family:var(--mono);font-size:10px;letter-spacing:.2em;text-transform:lowercase;color:var(--text-weak);opacity:.75}
.frame>.fict{position:absolute;right:16px;bottom:12px}
.kicker{font-family:var(--mono);font-size:11.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--text-weak);margin-bottom:14px}
.scopy{font-size:clamp(1.02rem,1.5vw,1.18rem);color:var(--text);max-width:52ch;margin:0 0 26px}
.scopy b{color:var(--text-strong);font-weight:600}
section.scene{padding:clamp(64px,10vw,120px) 0;contain:layout paint}
section.scene+section.scene{border-top:1px solid var(--border)}
/* ---------- HERO ---------- */
.hero{padding:clamp(56px,9vw,110px) 0 clamp(56px,8vw,100px);text-align:center;contain:layout paint}
.pains{height:30px;position:relative;margin-bottom:18px}
.pain{position:absolute;left:50%;transform:translateX(-50%);font-family:var(--mono);font-size:12.5px;color:var(--text-weak);white-space:nowrap;opacity:0}
.hero h1 .w{display:inline-block}
.hero .sub{font-size:clamp(1.05rem,1.6vw,1.25rem);color:var(--text);max-width:56ch;margin:22px auto 0;line-height:1.55}
/* cartão do canal de voz */
.vc{max-width:560px;margin:44px auto 0;border:1px solid var(--border);border-radius:16px;background:var(--bg-weak);box-shadow:0 30px 80px -40px rgba(0,0,0,.9);padding:18px 20px;text-align:left}
.vc .vh{display:flex;align-items:center;gap:10px;font-size:14px;color:var(--text-strong);font-weight:600}
.vc .vh .fict{margin-left:auto}
.vc .avs{display:flex;align-items:flex-end;gap:18px;margin-top:18px;flex-wrap:wrap}
.pav{display:flex;flex-direction:column;align-items:center;gap:6px;font-size:12px;color:var(--text-weak)}
.pav i{display:grid;place-items:center;width:44px;height:44px;border-radius:50%;font-style:normal;font-weight:700;font-size:15px;color:var(--pc);background:color-mix(in srgb,var(--pc) 20%,transparent);border:1px solid color-mix(in srgb,var(--pc) 45%,transparent)}
.pav.bot i{color:#fff;background:var(--accent);border-color:var(--accent)}
.vc .rec{display:inline-flex;align-items:center;gap:7px;margin-left:auto;font-family:var(--mono);font-size:11px;font-weight:700;letter-spacing:.08em;color:#fff;background:color-mix(in srgb,var(--rec) 28%,transparent);border:1px solid color-mix(in srgb,var(--rec) 55%,transparent);padding:4px 11px;border-radius:999px;align-self:center}
.rec-dot{width:7px;height:7px;border-radius:50%;background:var(--rec)}
.cue{margin:44px auto 0;color:var(--text-weak);font-family:var(--mono);font-size:11.5px;letter-spacing:.12em}
.cue svg{display:block;margin:8px auto 0;width:16px;height:16px;stroke:var(--text-weak)}
.hero .act{margin:30px auto 0;display:flex;justify-content:center}
/* animações do hero (só com JS) */
html.js .hero .pav{opacity:0}
html.js .hero .rec{opacity:0}
html.js .hero h1 .w{opacity:0}
html.js .hero .sub,html.js .hero .cue,html.js .hero .act{opacity:0}
.hero.on .pav{animation:pop-in 400ms var(--ease-out) both}
.hero.on .pav:nth-child(2){animation-delay:250ms}
.hero.on .pav:nth-child(3){animation-delay:500ms}
.hero.on .pav.bot{animation:pop-in 450ms var(--ease-spring) 750ms both}
.hero.on .rec{animation:fade 300ms linear 1200ms both}
.hero.on .rec-dot{animation:rec-pulse 1.4s ease-in-out 1500ms infinite;will-change:opacity}
.hero.on h1 .w{animation:word-rise 500ms var(--ease-out) both}
.hero.on .sub{animation:fade 400ms linear 1000ms both}
.hero.on .act{animation:fade-rise 500ms var(--ease-out) 1300ms both;--rise:12px}
.hero.on .cue{animation:fade 400ms linear 1600ms both}
.hero.on .cue svg{animation:drift-y 1.6s ease-in-out 2s infinite;will-change:transform}
/* estritamente em sequência: um balão sobe e se desfaz ANTES do próximo
   entrar (todos vivem no mesmo ponto — simultâneos viravam texto empilhado) */
.hero.on .pain.p1{animation:pain-float 2s var(--ease-out) both}
.hero.on .pain.p2{animation:pain-float 2s var(--ease-out) 2.1s both}
.hero.on .pain.p3{animation:pain-float 2s var(--ease-out) 4.2s both}
/* ---------- CENA 1: faixas ---------- */
.ghost{display:flex;align-items:center;gap:12px;margin-bottom:18px}
.ghost svg{flex:1;height:26px;opacity:.4}
.ghost .glbl{font-family:var(--mono);font-size:10.5px;color:var(--text-weak);letter-spacing:.1em;white-space:nowrap}
.track{display:grid;grid-template-columns:86px minmax(0,1fr);align-items:center;gap:12px;margin-bottom:10px}
.track .who{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--text-strong)}
.av{position:relative;display:inline-grid;place-items:center;width:30px;height:30px;border-radius:50%;font-weight:700;font-size:12.5px;font-style:normal;color:var(--pc);background:color-mix(in srgb,var(--pc) 20%,transparent)}
.av::after{content:"";position:absolute;inset:-3px;border-radius:50%;border:2px solid var(--pc);box-shadow:0 0 10px color-mix(in srgb,var(--pc) 55%,transparent);opacity:0;transform:scale(.9)}
.wave{width:100%;height:44px;display:block}
.wv{fill:none;stroke-width:2;stroke-linecap:round;vector-effect:non-scaling-stroke}
.wv-a{stroke:var(--c0)}.wv-b{stroke:var(--c1)}.wv-c{stroke:var(--c4)}
.ruler{display:flex;justify-content:space-between;font-family:var(--mono);font-size:10.5px;color:var(--text-weak);border-top:1px solid var(--border);padding-top:8px;margin-top:6px;margin-left:98px}
.overlap-note{margin:14px 0 0 98px;font-family:var(--mono);font-size:11px;color:var(--text-weak);letter-spacing:.06em}
.overlap-note b{color:var(--text-strong);font-weight:600}
html.js .sc1 .who,html.js .sc1 .ruler,html.js .sc1 .ghost{opacity:0}
html.js .sc1 .wv{stroke-dasharray:1;stroke-dashoffset:1}
html.js .sc1 .overlap-note{opacity:0;transform:translateY(8px)}
.sc1.on .ghost{animation:fade 400ms linear both}
.sc1.on .who{animation:fade 400ms linear 200ms both}
.sc1.on .ruler{animation:fade 400ms linear 400ms both}
.sc1.on .wv{animation:wave-draw 1.8s var(--ease-out) both;will-change:stroke-dashoffset}
.sc1.on .wv-b{animation-delay:300ms}
.sc1.on .wv-c{animation-delay:600ms}
.sc1.on .ring-a::after{animation:ring-live 1.8s ease-in-out both}
.sc1.on .ring-b::after{animation:ring-live 1.8s ease-in-out 300ms both}
.sc1.on .ring-c::after{animation:ring-live-off 1.8s ease-in-out 600ms both}
.sc1.on .overlap-note{animation:fade-rise 400ms var(--ease-out) 2200ms both}
/* ---------- CENA 2: /nota + pino ---------- */
.cmdwrap{contain:layout paint;min-height:1.6em;margin-bottom:20px}
.cmd{display:inline-block;font-family:var(--mono);font-size:14px;color:var(--text-strong);white-space:nowrap;overflow:hidden;border-right:2px solid transparent;max-width:100%}
.cmd .tok{color:var(--c0)}
.pinline{position:relative;padding:34px 0 6px}
.pinline .rail{height:3px;border-radius:2px;background:linear-gradient(90deg,var(--c0),var(--c1) 55%,var(--c4));opacity:.5}
.pin{position:absolute;top:0;left:22%;width:20px;height:26px;transform:translateX(-50%)}
.pin svg{display:block;width:100%;height:100%}
.pin-ripple{position:absolute;top:26px;left:22%;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:2px solid var(--accent);opacity:0;transform:scale(0)}
.pinlbl{position:absolute;top:36px;left:22%;transform:translateX(-50%);font-family:var(--mono);font-size:11px;color:var(--text-weak);white-space:nowrap;background:var(--bg-weak);border:1px solid var(--border);border-radius:6px;padding:3px 9px}
.pinspace{height:34px}
html.js .sc2 .cmd{width:0}
html.js .sc2 .pin{opacity:0;transform:translate(-50%,-24px)}
html.js .sc2 .pinlbl{opacity:0}
.sc2.on .cmd{animation:type-w 1.2s steps(31,end) both,caret-blink 900ms steps(2) 3,caret-off 1ms linear 2.7s both}
.sc2.on .pin{animation:pin-drop 450ms var(--ease-spring) 1350ms both}
.sc2.on .pin-ripple{animation:ripple 700ms ease-out 1800ms both}
.sc2.on .pinlbl{animation:fade 300ms linear 2000ms both}
/* ---------- CENA 3: transcrição + ata ---------- */
.status{display:grid;font-family:var(--mono);font-size:12px;margin-bottom:18px}
.status>span{grid-area:1/1;display:inline-flex;align-items:center;gap:7px}
.st-rec{color:var(--rec)}
.st-done{color:var(--c1);opacity:0}
.ghostq{font-family:var(--mono);font-size:12px;color:var(--text-weak);margin-bottom:16px;position:relative;display:inline-block}
.ghostq::after{content:"";position:absolute;left:0;top:52%;height:1.5px;width:100%;background:var(--text-weak);transform:scaleX(0);transform-origin:left}
.panes{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.pane{border:1px solid var(--border);border-radius:12px;background:var(--bg);padding:16px 18px;min-width:0}
.pane h3{font-family:var(--mono);font-size:10.5px;letter-spacing:.16em;color:var(--text-weak);margin-bottom:10px;font-weight:600}
.ln{font-size:13.5px;line-height:1.6;margin-bottom:8px;overflow-wrap:anywhere}
.ln .meta{font-family:var(--mono);font-size:11.5px;color:var(--mc);font-weight:600;margin-right:6px}
.typed{display:inline-block}
.blk{margin-bottom:14px}
.blk:last-child{margin-bottom:0}
.blk h4{font-family:var(--mono);font-size:10px;letter-spacing:.18em;color:var(--text-weak);margin-bottom:5px;font-weight:600}
.blk p{font-size:13.5px;color:var(--text)}
.blk .act{display:flex;gap:8px;align-items:baseline;margin-bottom:4px}
.blk .tick{font-size:12px}
.blk .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--pc);flex:none;align-self:center}
html.js .sc3 .st-rec{opacity:1}
html.js .sc3 .ln .meta{opacity:0}
html.js .sc3 .typed{clip-path:inset(0 100% 0 0)}
html.js .sc3 .blk{opacity:0;transform:translateY(24px)}
html.js .sc3 .tick{opacity:0;transform:scale(.9)}
html.js .sc3 .ghostq{opacity:0}
.sc3.on .st-rec{animation:fade-out 400ms linear both}
.sc3.on .st-done{animation:fade 400ms linear both}
.sc3.on .ghostq{animation:fade 300ms linear 300ms both}
.sc3.on .ln1 .meta{animation:fade 150ms linear 500ms both}
.sc3.on .ln1 .typed{animation:type-clip 900ms steps(24,end) 600ms both}
.sc3.on .ln2 .meta{animation:fade 150ms linear 1500ms both}
.sc3.on .ln2 .typed{animation:type-clip 900ms steps(18,end) 1600ms both}
.sc3.on .ln3 .meta{animation:fade 150ms linear 2500ms both}
.sc3.on .ln3 .typed{animation:type-clip 900ms steps(30,end) 2600ms both}
.sc3.on .b1{animation:fade-rise 500ms var(--ease-out) 3500ms both}
.sc3.on .b2{animation:fade-rise 500ms var(--ease-out) 3700ms both}
.sc3.on .b3{animation:fade-rise 500ms var(--ease-out) 3900ms both}
.sc3.on .ghostq::after{animation:strike 400ms var(--ease-out) 3600ms both}
.sc3.on .a1 .tick{animation:tick-pop 250ms var(--ease-spring) 4300ms both}
.sc3.on .a2 .tick{animation:tick-pop 250ms var(--ease-spring) 4450ms both}
/* ---------- CENA 4: /perguntar ---------- */
.think{display:inline-flex;gap:5px;margin:2px 0 18px;opacity:0}
.think i{width:6px;height:6px;border-radius:50%;background:var(--text-weak)}
.ansc{border:1px solid var(--border);border-radius:12px;background:var(--bg-weak);padding:18px 20px;max-width:560px}
.ansc p{font-size:14.5px;line-height:1.6;color:var(--text)}
.ansc b{color:var(--text-strong);font-weight:600}
.chip{position:relative;display:inline-block;font-family:var(--mono);font-size:11.5px;color:var(--c4);background:color-mix(in srgb,var(--c4) 14%,transparent);border:1px solid color-mix(in srgb,var(--c4) 45%,transparent);border-radius:6px;padding:2px 9px;text-decoration:none;white-space:nowrap;margin:0 2px}
.chip::after{content:"";position:absolute;inset:-1px;border-radius:6px;box-shadow:0 0 14px color-mix(in srgb,var(--c4) 45%,transparent);opacity:.4;pointer-events:none}
.bars{display:inline-flex;gap:3px;align-items:flex-end;height:14px;margin-left:10px;vertical-align:-2px}
.bars i{width:3px;height:14px;border-radius:2px;background:var(--c4);transform-origin:bottom;transform:scaleY(.4)}
.anslbl{margin-top:12px;font-family:var(--mono);font-size:11px;color:var(--text-weak);letter-spacing:.06em}
.mcpnote{margin-top:22px;font-size:13.5px;color:var(--text-weak);max-width:56ch}
.mcpnote code{font-family:var(--mono);font-size:12px;color:var(--text);background:var(--bg-weak);border:1px solid var(--border);border-radius:5px;padding:1px 6px}
html.js .sc4 .cmd{width:0}
html.js .sc4 .ansc{opacity:0;transform:translateY(16px)}
html.js .sc4 .anslbl,html.js .sc4 .mcpnote{opacity:0}
.sc4.on .cmd{animation:type-w 1.4s steps(32,end) 200ms both,caret-blink 900ms steps(2) 200ms 3,caret-off 1ms linear 3s both}
.sc4.on .think{animation:fade 200ms linear 1600ms both,fade-out 200ms linear 2400ms both}
.sc4.on .think i{animation:dot-think 600ms ease-in-out infinite}
.sc4.on .think i:nth-child(2){animation-delay:150ms}
.sc4.on .think i:nth-child(3){animation-delay:300ms}
.sc4.on .ansc{animation:fade-rise 450ms var(--ease-out) 2500ms both;--rise:16px}
.sc4.on .anslbl{animation:fade 300ms linear 3100ms both}
.sc4.on .mcpnote{animation:fade 400ms linear 3400ms both}
.sc4.on .chip{animation:chip-pulse 1.5s ease-in-out 3s infinite alternate;will-change:transform}
.sc4.on .chip::after{animation:chip-glow 1.5s ease-in-out 3s infinite alternate}
.sc4.on .bars i{animation:bar-bounce 1.2s ease-in-out 3s infinite;will-change:transform}
.sc4.on .bars i:nth-child(2){animation-delay:150ms}
.sc4.on .bars i:nth-child(3){animation-delay:300ms}
/* ---------- CENA 5: os comandos ---------- */
.cmds{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px}
.cmdrow{display:flex;align-items:baseline;gap:12px;border:1px solid var(--border);border-radius:10px;background:var(--bg-weak);padding:12px 16px;min-width:0}
.cmdrow .k{font-family:var(--mono);font-size:13px;color:var(--c0);white-space:nowrap;font-weight:500}
.cmdrow .d{font-size:13px;color:var(--text);overflow-wrap:anywhere}
.cmdsmore{margin-top:16px;font-family:var(--mono);font-size:11px;color:var(--text-weak);letter-spacing:.06em}
html.js .sc5 .cmdrow,html.js .sc5 .cmdsmore{opacity:0;transform:translateY(14px)}
.sc5.on .cmdrow{animation:fade-rise 450ms var(--ease-out) both;--rise:14px}
.sc5.on .cmdrow:nth-child(2){animation-delay:90ms}
.sc5.on .cmdrow:nth-child(3){animation-delay:180ms}
.sc5.on .cmdrow:nth-child(4){animation-delay:270ms}
.sc5.on .cmdrow:nth-child(5){animation-delay:360ms}
.sc5.on .cmdrow:nth-child(6){animation-delay:450ms}
.sc5.on .cmdsmore{animation:fade-rise 400ms var(--ease-out) 600ms both;--rise:8px}
@media (max-width:640px){.cmds{grid-template-columns:1fr}}
/* ---------- FECHAMENTO ---------- */
.close{text-align:center;padding:clamp(72px,11vw,140px) 0}
.reprise{font-family:var(--mono);font-size:11.5px;letter-spacing:.14em;color:var(--text-weak);margin-bottom:26px}
.close p.final{font-size:clamp(1.15rem,2vw,1.5rem);color:var(--text-strong);max-width:46ch;margin:0 auto 36px;line-height:1.5}
.btn{display:inline-flex;align-items:center;gap:9px;font:inherit;font-size:15.5px;font-weight:600;text-decoration:none;padding:14px 28px;border-radius:12px;background:var(--accent);color:#fff;border:0;transition:transform 150ms var(--ease-out),box-shadow 150ms}
.btn:hover{transform:translateY(-1px);box-shadow:0 8px 30px -8px var(--accent)}
.readme-note{margin-top:14px;font-family:var(--mono);font-size:11px;color:var(--text-weak);letter-spacing:.06em}
.demolink{display:inline-block;margin-top:22px;color:var(--text-weak);text-decoration:none;font-size:14px;border-bottom:1px solid transparent}
.demolink:hover{color:var(--text-strong);border-color:var(--border-strong)}
html.js .close .final,html.js .close .btn,html.js .close .reprise,html.js .close .demolink{opacity:0}
.close.on .reprise{animation:fade 400ms linear both}
.close.on .final{animation:fade-rise 600ms var(--ease-out) 150ms both;--rise:16px}
.close.on .btn{animation:fade-rise 500ms var(--ease-out) 400ms both;--rise:16px}
.close.on .demolink{animation:fade 400ms linear 650ms both}
/* footer */
footer{border-top:1px solid var(--border);padding:36px 0;color:var(--text-weak);font-size:13px}
footer .wrap{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:center;justify-content:space-between}
footer a{color:var(--text-weak);text-decoration:none}
footer a:hover{color:var(--text-strong)}
.endmark{font-family:var(--mono);color:var(--text-strong)}
.endmark .car{color:var(--accent);animation:blink 1.2s step-end infinite}
/* ---------- keyframes ---------- */
@keyframes blink{50%{opacity:0}}
@keyframes fade{from{opacity:0}to{opacity:1}}
@keyframes fade-out{from{opacity:1}to{opacity:0}}
@keyframes pop-in{from{opacity:0;transform:scale(.8)}to{opacity:1;transform:scale(1)}}
@keyframes word-rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@keyframes rec-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes drift-y{0%,100%{transform:translateY(0)}50%{transform:translateY(6px)}}
@keyframes pain-float{0%{opacity:0;transform:translate(-50%,10px)}18%{opacity:.85}70%{opacity:.5}100%{opacity:0;transform:translate(-50%,-14px)}}
@keyframes wave-draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@keyframes ring-live{0%{opacity:0;transform:scale(.9)}15%{opacity:1;transform:scale(1.08)}45%{opacity:.5;transform:scale(1)}65%{opacity:1;transform:scale(1.08)}100%{opacity:.5;transform:scale(1)}}
@keyframes ring-live-off{0%{opacity:0;transform:scale(.9)}20%{opacity:1;transform:scale(1.08)}70%{opacity:.8;transform:scale(1)}100%{opacity:0;transform:scale(.95)}}
@keyframes fade-rise{from{opacity:0;transform:translateY(var(--rise,24px))}to{opacity:1;transform:none}}
@keyframes type-w{from{width:0}to{width:var(--w,31ch)}}
@keyframes caret-blink{0%,49%{border-right-color:currentColor}50%,100%{border-right-color:transparent}}
@keyframes caret-off{to{border-right-color:transparent}}
@keyframes pin-drop{from{opacity:0;transform:translate(-50%,-24px)}to{opacity:1;transform:translate(-50%,0)}}
@keyframes ripple{from{opacity:.9;transform:scale(0)}to{opacity:0;transform:scale(1)}}
@keyframes type-clip{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}
@keyframes tick-pop{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:scale(1)}}
@keyframes strike{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes dot-think{0%,100%{opacity:.3}50%{opacity:1}}
@keyframes chip-pulse{from{transform:scale(1)}to{transform:scale(1.06)}}
@keyframes chip-glow{from{opacity:.4}to{opacity:1}}
@keyframes bar-bounce{0%,100%{transform:scaleY(.4)}50%{transform:scaleY(1)}}
/* sem JS: página completa e estática */
html:not(.js) .scene *,html:not(.js) .hero *{opacity:1!important;transform:none!important;animation:none!important}
html:not(.js) .pain{display:none}
html:not(.js) .wv{stroke-dasharray:none!important;stroke-dashoffset:0!important}
html:not(.js) .cmd{width:auto!important}
html:not(.js) .typed{clip-path:none!important}
html:not(.js) .think{display:none}
/* reduced motion: pula pro estado final, nada se move */
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation:none!important;transition:none!important}
  .hero .pav,.hero .rec,.hero h1 .w,.hero .sub,.hero .cue,.hero .act,.sc1 .who,.sc1 .ruler,.sc1 .ghost,
  .sc1 .overlap-note,.sc2 .pin,.sc2 .pinlbl,.sc3 .ln .meta,.sc3 .blk,.sc3 .tick,.sc3 .ghostq,
  .sc4 .ansc,.sc4 .anslbl,.sc4 .mcpnote,.sc5 .cmdrow,.sc5 .cmdsmore,
  .close .final,.close .btn,.close .reprise,.close .demolink{opacity:1!important;transform:none!important}
  .pain,.think{display:none}
  .wv{stroke-dasharray:none!important;stroke-dashoffset:0!important}
  .cmd{width:auto!important;border-right-color:transparent!important}
  .typed{clip-path:none!important}
  .ring-a::after,.ring-b::after{opacity:.5;transform:scale(1)}
  .ghostq::after{transform:scaleX(1)}
  .st-rec{opacity:0!important}.st-done{opacity:1!important}
  .chip::after{opacity:1}
  .bars i:nth-child(1){transform:scaleY(.6)}.bars i:nth-child(2){transform:scaleY(1)}.bars i:nth-child(3){transform:scaleY(.75)}
}
/* mobile */
@media (max-width:640px){
  .panes{grid-template-columns:1fr}
  .track{grid-template-columns:70px minmax(0,1fr)}
  .ruler,.overlap-note{margin-left:82px}
  .vc .avs{gap:12px}
  .frame{padding:16px 14px 30px}
}
`;

export function landingPage(lang: Locale): string {
  const pt = lang === 'pt';
  const T = (p: string, e: string): string => (pt ? p : e);

  const metaTitle = T(
    'Kassinão — grava a reunião do seu time no Discord e entrega a ata pronta',
    'Kassinão — records your Discord meetings and hands you the minutes, done',
  );
  const metaDesc = T(
    'A reunião acaba e a ata já existe. O Kassinão grava cada pessoa numa faixa separada, transcreve com nome, monta a ata com decisões e responsáveis — no seu próprio servidor, código aberto.',
    'The call ends and the notes are already written. Kassinão records each person on their own track, transcribes with real names, builds minutes with decisions and owners — on your own server, open source.',
  );
  const langToggle = `<span class="lang"><a href="?lang=en"${!pt ? ' class="on"' : ''}>EN</a><span>·</span><a href="?lang=pt"${pt ? ' class="on"' : ''}>PT</a></span>`;
  const ghLabel = config.repoPublic ? 'GitHub' : 'npm';
  const fict = `<span class="fict">${T('exemplo fictício', 'fictional example')}</span>`;

  // nomes por idioma (copy independente, não tradução)
  const N = pt ? ['Ana', 'Bea', 'Caio'] : ['Ava', 'Ben', 'Cole'];

  const nav = `<nav class="nav" aria-label="${T('Navegação', 'Navigation')}"><div class="wrap">
    <a class="brand" href="/">kassinao<span class="car">▌</span></a>
    <span class="sp"></span>
    <a class="gh" href="${ghHref()}">${ghLabel}</a>
    ${langToggle}
  </div></nav>`;

  // ---------- HERO: a call começando ----------
  const h1Words = T('A reunião acaba. A ata já existe.', 'The call ends. The notes are already written.')
    .split(' ')
    .map((w, i) => `<span class="w" style="animation-delay:${400 + i * 60}ms">${esc(w)}</span>`)
    .join(' ');
  const pains = pt
    ? ['quem ficou com isso?', 'alguém anotou?', 'que horas a gente decidiu isso?']
    : ['wait, who owns that?', 'did anyone write this down?', 'when did we even decide this?'];
  const hero = `<header class="hero scene" id="conteudo" aria-label="${esc(
    T(
      'Abertura: uma reunião fictícia começando em um canal de voz do Discord',
      'Opening: a fictional meeting starting in a Discord voice channel',
    ),
  )}"><div class="wrap">
    <div class="pains" aria-hidden="true">
      <span class="pain p1">${esc(pains[0])}</span>
      <span class="pain p2">${esc(pains[1])}</span>
      <span class="pain p3">${esc(pains[2])}</span>
    </div>
    <h1>${h1Words}</h1>
    <p class="sub">${esc(
      T(
        'O Kassinão grava a reunião do seu time no Discord e entrega tudo pronto no final: quem falou, o que foi decidido, quem ficou com o quê. Role a página — tem uma reunião começando agora.',
        "Kassinão records your team's Discord calls and hands everything over the moment you hang up: who spoke, what was decided, who owns what. Keep scrolling — there's a meeting starting right now.",
      ),
    )}</p>
    <div class="vc" role="group" aria-label="${esc(
      T(
        'Canal de voz de exemplo chamado planejamento, com participantes e o bot Kassinão gravando',
        'Sample voice channel named planning, with participants and the Kassinão bot recording',
      ),
    )}">
      <div class="vh">🔊 ${T('planejamento', 'planning')} ${fict}</div>
      <div class="avs">
        <span class="pav" style="--pc:var(--c0)"><i>${N[0][0]}</i>${N[0]}</span>
        <span class="pav" style="--pc:var(--c1)"><i>${N[1][0]}</i>${N[1]}</span>
        <span class="pav" style="--pc:var(--c4)"><i>${N[2][0]}</i>${N[2]}</span>
        <span class="pav bot"><i>K</i>Kassinão</span>
        <span class="rec" aria-label="${T('gravando', 'recording')}"><span class="rec-dot"></span>REC</span>
      </div>
    </div>
    <div class="act"><a class="btn" href="${ghHref()}" aria-label="${esc(T('Ver o Kassinão no GitHub', 'View Kassinão on GitHub'))}">${
      config.repoPublic ? T('Ver no GitHub', 'View on GitHub') : T('Ver no npm', 'View on npm')
    } →</a></div>
    <div class="cue" aria-hidden="true">${T('role pra assistir à reunião', 'scroll to watch the meeting')}
      <svg viewBox="0 0 16 16" fill="none" stroke-width="1.5"><path d="M8 3v10M4 9l4 4 4-4"/></svg>
    </div>
  </div></header>`;

  // ---------- CENA 1: cada voz na própria faixa ----------
  const bars = [
    'M0 22 L30 22 40 11 50 33 60 16 70 28 80 22 120 22 130 7 140 37 150 13 160 31 170 20 180 24 220 22 330 22 340 9 350 35 360 15 370 29 380 19 390 26 400 22 600 22',
    'M0 22 L190 22 200 9 210 35 220 15 230 31 240 18 250 27 260 22 330 22 340 11 350 33 360 17 370 27 380 22 600 22',
    'M0 22 L440 22 450 9 460 35 470 13 480 31 490 18 500 27 510 22 600 22',
  ];
  const lane = (name: string, cv: string, ring: string, path: string): string => `<div class="track">
      <div class="who"><i class="av ${ring}" style="--pc:var(${cv})">${name[0]}</i>${name}</div>
      <svg class="wave" viewBox="0 0 600 44" preserveAspectRatio="none" aria-hidden="true">
        <path class="wv wv-${ring.slice(-1) === 'a' ? 'a' : ring.slice(-1) === 'b' ? 'b' : 'c'}" pathLength="1" d="${path}"/>
      </svg>
    </div>`;
  const scene1 = `<section class="scene sc1" data-th="0.4" aria-label="${esc(
    T(
      'Três faixas de áudio separadas, uma por pessoa; em um trecho, duas pessoas falam ao mesmo tempo e as faixas continuam separadas',
      'Three separate audio tracks, one per person; at one point two people talk at once and the tracks stay clean',
    ),
  )}"><div class="wrap">
    <div class="kicker">${T('a conversa', 'the conversation')}</div>
    <p class="scopy">${T(
      'Cada pessoa tem a <b>própria faixa de áudio</b>. Quando duas falam ao mesmo tempo, dá pra ouvir as duas.',
      'Each person gets their <b>own audio track</b>. When two people talk at once, you can hear both.',
    )}</p>
    <figure class="frame">
      <div class="ghost" aria-hidden="true">
        <svg viewBox="0 0 600 26" preserveAspectRatio="none"><polyline points="0,16 20,8 35,22 50,5 65,20 80,10 95,23 110,7 125,18 140,12 155,21 170,6 185,19 200,13 215,22 230,8 245,17 260,11 275,20 290,9 305,18 320,14 335,21 350,7 365,19 380,12 395,22 410,10 425,17 440,13 455,20 470,8 485,18 500,11 515,21 530,9 545,16 560,13 575,19 600,15" fill="none" stroke="#4a4a52" stroke-width="1.3"/></svg>
        <span class="glbl">${T('gravação comum: tudo misturado', 'ordinary recording: everything mixed')}</span>
      </div>
      ${lane(N[0], '--c0', 'ring-a', bars[0])}
      ${lane(N[1], '--c1', 'ring-b', bars[1])}
      ${lane(N[2], '--c4', 'ring-c', bars[2])}
      <div class="ruler" aria-hidden="true"><span>00:00</span><span>00:10</span><span>00:20</span></div>
      <p class="overlap-note">↑ ${T('<b>ao mesmo tempo</b> — e cada voz continua inteira', '<b>at the same time</b> — and each voice stays whole')}</p>
      ${fict}
    </figure>
  </div></section>`;

  // ---------- CENA 2: o momento marcado ----------
  const notaCmd = T('/nota fechamos o preço do plano', '/note locked in the plan pricing');
  const scene2 = `<section class="scene sc2" data-th="0.5" aria-label="${esc(
    T(
      'Durante a reunião, alguém envia o comando /nota e o momento fica marcado na gravação aos 14 segundos',
      'During the meeting, someone sends the /note command and the moment is pinned in the recording at 14 seconds',
    ),
  )}"><div class="wrap">
    <div class="kicker">${T('o momento marcado', 'the pinned moment')}</div>
    <p class="scopy">${T(
      'Aconteceu algo importante? Um comando na hora, e o momento fica guardado <b>com o segundo exato</b>.',
      'Something important just happened? One command, right in the call, and the moment is saved <b>down to the exact second</b>.',
    )}</p>
    <figure class="frame">
      <div class="cmdwrap"><span class="cmd" style="--w:${notaCmd.length + 1}ch"><span class="tok">${esc(notaCmd.split(' ')[0])}</span>${esc(notaCmd.slice(notaCmd.indexOf(' ')))}</span></div>
      <div class="pinline" aria-hidden="true">
        <span class="pin"><svg viewBox="0 0 20 26" fill="var(--accent)"><path d="M10 0c5 0 9 3.8 9 8.6C19 15 10 26 10 26S1 15 1 8.6C1 3.8 5 0 10 0z"/><circle cx="10" cy="8.5" r="3.4" fill="#fff"/></svg></span>
        <span class="pin-ripple"></span>
        <div class="rail"></div>
        <span class="pinlbl">00:14 · ${T('fechamos o preço', 'locked the price')}</span>
      </div>
      <div class="pinspace"></div>
      ${fict}
    </figure>
  </div></section>`;

  // ---------- CENA 3: a call acaba ----------
  const scene3 = `<section class="scene sc3" data-th="0.3" aria-label="${esc(
    T(
      'A reunião termina e aparecem, prontas, a transcrição com o nome de cada pessoa e a ata com resumo, decisões e ações com responsável',
      'The meeting ends and the transcript with real names plus the minutes with summary, decisions and owned action items show up, done',
    ),
  )}"><div class="wrap">
    <div class="kicker">${T('a call acaba', 'the call ends')}</div>
    <p class="scopy">${T(
      'Ninguém digitou nada. A transcrição sai <b>com o nome de quem falou</b>. A ata sai <b>com decisão e responsável</b>.',
      'Nobody typed a thing. The transcript comes out <b>with the name of whoever spoke</b>. The minutes come out <b>with decisions — and who owns them</b>.',
    )}</p>
    <figure class="frame">
      <p class="status" aria-hidden="true">
        <span class="st-rec"><span class="rec-dot"></span>REC</span>
        <span class="st-done">✓ ${T('18:47 · reunião encerrada', '6:47 PM · meeting ended')}</span>
      </p>
      <p class="ghostq" aria-hidden="true">${T('quem ficou com isso?', 'wait, who owns that?')}</p>
      <div class="panes">
        <div class="pane">
          <h3>${T('TRANSCRIÇÃO', 'TRANSCRIPT')}</h3>
          <p class="ln ln1"><span class="meta" style="--mc:var(--c0)">[00:12] ${N[0]}:</span> <span class="typed">${T('então fechamos o preço?', 'so, are we locked on the price?')}</span></p>
          <p class="ln ln2"><span class="meta" style="--mc:var(--c1)">[00:14] ${N[1]}:</span> <span class="typed">${T('fechado. R$ 49.', 'locked. $49.')}</span></p>
          <p class="ln ln3"><span class="meta" style="--mc:var(--c4)">[00:15] ${N[2]}:</span> <span class="typed">${T('coloco no site ainda essa semana.', "I'll have it on the site this week.")}</span></p>
        </div>
        <div class="pane">
          <h3>${T('ATA', 'MINUTES')}</h3>
          <div class="blk b1"><h4>${T('RESUMO', 'SUMMARY')}</h4><p>${T('Definido o preço do plano e o prazo do site.', 'Plan pricing decided; site update scheduled.')}</p></div>
          <div class="blk b2"><h4>${T('DECISÕES', 'DECISIONS')}</h4><p>${T('Plano a R$ 49/mês.', 'Plan priced at $49/month.')}</p></div>
          <div class="blk b3"><h4>${T('AÇÕES', 'ACTION ITEMS')}</h4>
            <p class="act a1"><span class="tick" aria-hidden="true">☐</span><i class="dot" style="--pc:var(--c1)"></i>${N[1]} — ${T('enviar a proposta até sexta', 'send the proposal by Friday')}</p>
            <p class="act a2"><span class="tick" aria-hidden="true">☐</span><i class="dot" style="--pc:var(--c4)"></i>${N[2]} — ${T('atualizar o site', 'update the pricing page')}</p>
          </div>
        </div>
      </div>
      ${fict}
    </figure>
  </div></section>`;

  // ---------- CENA 4: semanas depois ----------
  const askCmd = T('/perguntar o que ficou pendente?', "/ask what's still pending?");
  const scene4 = `<section class="scene sc4" data-th="0.5" aria-label="${esc(
    T(
      'Semanas depois, uma pergunta em português recebe resposta com a citação do momento exato da gravação',
      'Weeks later, a plain-language question gets an answer citing the exact moment of the recording',
    ),
  )}"><div class="wrap">
    <div class="kicker">${T('três semanas depois · no discord', 'three weeks later · in discord')}</div>
    <p class="scopy">${T(
      'Pergunte <b>pro próprio bot, no Discord</b> — em português. A resposta vem <b>com prova</b>: toque no tempo e ouça o momento exato.',
      'Ask <b>the bot itself, right in Discord</b> — in plain English. The answer comes <b>with receipts</b>: tap the timestamp and hear the exact moment.',
    )}</p>
    <figure class="frame">
      <div class="cmdwrap"><span class="cmd" style="--w:${askCmd.length + 1}ch"><span class="tok">${esc(askCmd.split(' ')[0])}</span>${esc(askCmd.slice(askCmd.indexOf(' ')))}</span></div>
      <div class="think" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="ansc">
        <p>${T(
          `A <b>${N[1]}</b> ficou de enviar a proposta até sexta — foi decidido aos`,
          `<b>${N[1]}</b> still owes the proposal — due Friday. Decided at`,
        )} <a class="chip" href="/demo" aria-label="${esc(T('14 segundos — pula pro segundo exato do áudio', '14 seconds — jumps to the exact second of audio'))}">[00:14]</a><span class="bars" aria-hidden="true"><i></i><i></i><i></i></span></p>
      </div>
      <p class="anslbl">${T('o link pula pro segundo exato da gravação', 'the link jumps to the exact second of the recording')}</p>
      ${fict}
    </figure>
    <p class="mcpnote">${T(
      'Prefere perguntar do <b>Claude</b> ou do <b>Cursor</b>? O conector <code>kassinao-mcp</code> liga seu assistente de IA nas mesmas reuniões — cada pessoa só enxerga o que já pode ver.',
      'Rather ask from <b>Claude</b> or <b>Cursor</b>? The <code>kassinao-mcp</code> connector plugs your AI assistant into the same meetings — each person only sees what they already can.',
    )}</p>
  </div></section>`;

  // ---------- CENA 5: os comandos ----------
  const CMDS: Array<[string, string]> = pt
    ? [
        ['/gravar', 'entra no canal de voz e começa a gravar — uma faixa por pessoa'],
        ['/parar', 'encerra e posta o link com áudio, transcrição e ata'],
        ['/nota', 'marca o momento com o segundo exato (ou o botão 📌 no painel)'],
        ['/perguntar', 'pergunta às suas reuniões — a resposta é só pra você, com citação'],
        ['/gravacoes', 'suas gravações + a central web com busca em tudo'],
        ['/autorecord', '(admin) grava sozinho quando o canal enche, para quando esvazia'],
      ]
    : [
        ['/record', 'joins your voice channel and starts recording — one track per person'],
        ['/stop', 'ends it and posts the link with audio, transcript and minutes'],
        ['/note', 'pins the moment down to the exact second (or the 📌 panel button)'],
        ['/ask', 'ask your meetings — the answer is private to you, with citations'],
        ['/recordings', 'your recordings + the web hub with full-text search'],
        ['/autorecord', '(admin) records on its own when the channel fills up'],
      ];
  const scene5 = `<section class="scene sc5" data-th="0.4" aria-label="${esc(
    T('Os comandos do bot no Discord', 'The bot commands in Discord'),
  )}"><div class="wrap">
    <div class="kicker">${T('os comandos', 'the commands')}</div>
    <p class="scopy">${T(
      'Tudo isso acontece com <b>comandos simples dentro do Discord</b> — sem app novo, sem convidado esquisito na call.',
      'All of it happens through <b>simple commands inside Discord</b> — no new app, no weird guest joining your call.',
    )}</p>
    <div class="cmds">
      ${CMDS.map(([k, d]) => `<div class="cmdrow"><span class="k">${esc(k)}</span><span class="d">${esc(d)}</span></div>`).join('\n      ')}
    </div>
    <p class="cmdsmore">${T(
      'e mais /status, /ajuda, /config, /sobre — cada detalhe está no README',
      'plus /status, /help, /config, /about — every detail lives in the README',
    )}</p>
  </div></section>`;

  // ---------- FECHAMENTO ----------
  const closeSec = `<section class="scene close" data-th="0.5">
    <div class="wrap">
      <p class="reprise" aria-hidden="true">${T('call → nota → ata → resposta', 'call → note → minutes → answer')}</p>
      <p class="final">${esc(
        T(
          'Essa reunião foi inventada. As suas ficam só com você — no seu próprio servidor, com o código aberto pra qualquer um conferir.',
          'That meeting was made up. Yours stay yours — recorded on your own server, running code anyone can read.',
        ),
      )}</p>
      <a class="btn" href="${ghHref()}" aria-label="${esc(T('Ver o Kassinão no GitHub', 'View Kassinão on GitHub'))}">${
        config.repoPublic ? T('Ver no GitHub', 'View on GitHub') : T('Ver no npm', 'View on npm')
      } →</a>
      <p class="readme-note">${T('tudo que você precisa pra instalar está no README', 'everything you need to install is in the README')}</p>
      <br><a class="demolink" href="/demo">${T('ou espie a demo →', 'or poke around the demo →')}</a>
    </div>
  </section>`;

  const footer = `<footer><div class="wrap">
    <span class="endmark">kassinao<span class="car">▌</span></span>
    <span>AGPL-3.0 · <a href="${ghHref()}">${ghLabel}</a> · <a href="${NPM_URL}">kassinao-mcp</a> · <a href="${APP_BRIDGE}">${T('entrar', 'sign in')}</a></span>
  </div></footer>`;

  // controller: uma classe .on por cena, uma vez, e html.js pro fallback sem JS
  const script = `<script>(function(){
document.documentElement.classList.add('js');
var hero=document.querySelector('.hero');
if(hero)hero.classList.add('on');
var scenes=document.querySelectorAll('.scene[data-th]');
if(!('IntersectionObserver' in window)){scenes.forEach(function(s){s.classList.add('on');});return;}
var groups={};
scenes.forEach(function(s){var t=s.dataset.th||'0.4';(groups[t]=groups[t]||[]).push(s);});
Object.keys(groups).forEach(function(t){
  var io=new IntersectionObserver(function(es){es.forEach(function(e){
    if(e.isIntersecting){e.target.classList.add('on');io.unobserve(e.target);}
  });},{threshold:parseFloat(t)});
  groups[t].forEach(function(s){io.observe(s);});
});
})();</script>`;

  return `<!doctype html>
<html lang="${pt ? 'pt-BR' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(metaTitle)}</title>
<meta name="description" content="${esc(metaDesc)}">
<meta property="og:title" content="${esc(metaTitle)}">
<meta property="og:description" content="${esc(metaDesc)}">
<meta property="og:image" content="${config.baseUrl}/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${FAVICON}">
<style>${LANDING_CSS}</style>
</head>
<body>
<a class="skip" href="#conteudo">${T('pular pro conteúdo', 'skip to content')}</a>
${nav}
${hero}
${scene1}
${scene2}
${scene3}
${scene4}
${scene5}
${closeSec}
${footer}
${script}
</body>
</html>`;
}
