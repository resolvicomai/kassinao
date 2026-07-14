/**
 * Sistema visual da area privada do Kassinao.
 *
 * A paleta parte dos tons usados pelo Discord. O CSS aceita a marcacao legada
 * das paginas server-rendered e os novos containers de shell, dashboard e
 * reuniao, para que a migracao de layout nao altere contratos de dados.
 */
export const APP_CSS = `
  @font-face {
    font-family: 'Space Grotesk';
    src: url('/assets/space-grotesk.woff2') format('woff2');
    font-style: normal;
    font-weight: 300 700;
    font-display: swap;
  }

  :root {
    color-scheme: dark;
    --discord-ink: #1e1f22;
    --discord-sidebar: #2b2d31;
    --discord-canvas: #313338;
    --discord-raised: #383a40;
    --discord-hover: #3f4147;
    --discord-input: #1e1f22;
    --discord-line: #3f4147;
    --discord-line-strong: #4e5058;
    --discord-text: #dbdee1;
    --discord-strong: #f2f3f5;
    --discord-muted: #b5bac1;
    --discord-dim: #949ba4;
    --discord-blurple: #5865f2;
    --discord-blurple-hover: #4752c4;
    --discord-blurple-soft: rgba(88, 101, 242, .18);
    --discord-danger: #ed4245;
    --discord-danger-soft: rgba(237, 66, 69, .12);
    --discord-warning: #fee75c;
    --bg: var(--discord-canvas);
    --surface: var(--discord-sidebar);
    --surface-2: var(--discord-raised);
    --surface-3: var(--discord-hover);
    --text: var(--discord-text);
    --text-strong: var(--discord-strong);
    --text-weak: var(--discord-muted);
    --text-dim: var(--discord-dim);
    --border: var(--discord-line);
    --border-strong: var(--discord-line-strong);
    --accent: var(--discord-blurple);
    --accent-hover: var(--discord-blurple-hover);
    --accent-soft: var(--discord-blurple-soft);
    --accent-ink: #ffffff;
    --danger: var(--discord-danger);
    --danger-soft: var(--discord-danger-soft);
    --live: var(--discord-danger);
    --warn: var(--discord-warning);
    --ok: var(--discord-blurple);
    --done: #7983f5;
    --link: #949cf7;
    --c0: #7983f5;
    --c1: #949cf7;
    --c2: #b3b9fa;
    --c3: #6875f4;
    --c4: #a6adff;
    --c5: #8a94f7;
    --c6: #c5c9ff;
    --c7: #727ff5;
    --sidebar-width: 248px;
    --topbar-height: 64px;
    --content-width: 1440px;
    --content-readable: 860px;
    --radius-control: 6px;
    --radius-panel: 10px;
    --sans: 'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --mono: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
    --shadow-float: 0 14px 38px rgba(0, 0, 0, .26);
  }

  html[data-theme='light'] {
    color-scheme: light;
    --discord-ink: #e3e5e8;
    --discord-sidebar: #f2f3f5;
    --discord-canvas: #ffffff;
    --discord-raised: #f2f3f5;
    --discord-hover: #e3e5e8;
    --discord-input: #e3e5e8;
    --discord-line: #e3e5e8;
    --discord-line-strong: #c4c9ce;
    --discord-text: #313338;
    --discord-strong: #060607;
    --discord-muted: #4e5058;
    --discord-dim: #5c6067;
    --discord-blurple-soft: rgba(88, 101, 242, .11);
    --discord-danger-soft: rgba(237, 66, 69, .08);
    --done: #4752c4;
    --link: #4752c4;
    --c0: #4752c4;
    --c1: #5865f2;
    --c2: #6875d8;
    --c3: #3944a5;
    --c4: #6670c7;
    --c5: #4b57c9;
    --c6: #777fc8;
    --c7: #3642ba;
    --shadow-float: 0 14px 38px rgba(30, 31, 34, .14);
  }

  * { box-sizing: border-box; margin: 0; }
  [hidden] { display: none !important; }
  html { min-width: 320px; background: var(--bg); }
  body {
    min-width: 320px;
    min-height: 100dvh;
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.55;
    text-rendering: optimizeLegibility;
  }
  button, input, select, textarea { color: inherit; font: inherit; }
  button { touch-action: manipulation; }
  img { display: block; max-width: 100%; height: auto; }
  a { color: inherit; }
  time, code, pre, .ts { font-family: var(--mono); }
  pre { overflow-x: auto; }
  ::selection { background: var(--accent); color: #ffffff; }

  .skip {
    position: fixed;
    z-index: 1000;
    top: 10px;
    left: 10px;
    transform: translateY(-150%);
    padding: 10px 14px;
    border-radius: var(--radius-control);
    background: var(--accent);
    color: #ffffff;
    font-weight: 700;
    text-decoration: none;
  }
  .skip:focus { transform: translateY(0); }
  :where(a, button, input, select, textarea, summary):focus-visible {
    outline: 2px solid #ffffff;
    outline-offset: 2px;
    box-shadow: 0 0 0 4px var(--accent);
  }

  h1, h2, h3, h4 { color: var(--text-strong); font-weight: 650; }
  h1 { font-size: clamp(1.65rem, 2.4vw, 2.25rem); line-height: 1.08; letter-spacing: -.04em; }
  h2 { margin: 30px 0 12px; font-size: 1.05rem; line-height: 1.3; letter-spacing: -.015em; }
  h3 { font-size: .92rem; line-height: 1.35; }
  h2[id], h3[id], details[id] { scroll-margin-top: 152px; }
  .muted { color: var(--text-weak); font-size: 13px; }
  .subline { max-width: 74ch; margin-top: 8px; color: var(--text-weak); font-size: 13px; }
  .grid { display: grid; grid-template-columns: minmax(112px, auto) minmax(0, 1fr); gap: 7px 18px; margin-top: 18px; }
  .grid dt { color: var(--text-dim); }

  /* Shell privado */
  .app-shell {
    min-height: 100dvh;
    display: grid;
    grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
    background: var(--bg);
  }
  .app-sidebar {
    position: sticky;
    top: 0;
    z-index: 30;
    width: var(--sidebar-width);
    height: 100dvh;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding: 18px 10px 12px;
    background: var(--surface);
    border-right: 1px solid var(--discord-ink);
    overflow-y: auto;
  }
  .sidebar-brand,
  .app-sidebar .brand {
    min-height: 44px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 9px;
    color: var(--text-strong);
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -.035em;
    text-decoration: none;
  }
  .sidebar-brand img,
  .app-sidebar .brand img { width: 28px; height: 28px; border-radius: 7px; flex: 0 0 28px; }
  .sidebar-brand .apptag,
  .app-sidebar .apptag {
    margin-left: auto;
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--accent);
    color: #ffffff;
    font-family: var(--mono);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: .06em;
    text-transform: uppercase;
  }
  .sidebar-label {
    display: block;
    padding: 0 10px 5px;
    color: var(--text-dim);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: .08em;
    text-transform: uppercase;
  }
  .sidebar-spacer { flex: 1 1 auto; min-height: 18px; }
  .sidebar-nav { display: grid; gap: 3px; }
  .sidebar-nav-label {
    padding: 0 10px 5px;
    color: var(--text-dim);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: .08em;
    text-transform: uppercase;
  }
  .sidebar-nav a,
  .sidebar-nav button {
    min-height: 42px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--text-weak);
    font-size: 14px;
    font-weight: 550;
    text-align: left;
    text-decoration: none;
    cursor: pointer;
  }
  .sidebar-nav a:hover,
  .sidebar-nav button:hover { background: var(--surface-2); color: var(--text-strong); }
  .sidebar-nav a[aria-current='page'],
  .sidebar-nav .active { background: var(--surface-2); color: var(--text-strong); }
  .sidebar-nav .nav-icon { width: 18px; color: var(--text-dim); text-align: center; }
  .sidebar-nav .active .nav-icon,
  .sidebar-nav a:hover .nav-icon { color: var(--text-strong); }
  .sidebar-resources {
    display: grid;
    gap: 2px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .sidebar-resources a {
    min-height: 34px;
    display: flex;
    align-items: center;
    padding: 6px 10px;
    border-radius: 4px;
    color: var(--text-dim);
    font-size: 12px;
    font-weight: 550;
    text-decoration: none;
  }
  .sidebar-resources a:hover { background: var(--surface-2); color: var(--text-strong); }
  .sidebar-footer {
    display: grid;
    gap: 7px;
    margin-top: auto;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .sidebar-footer .user {
    min-width: 0;
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr);
    align-items: center;
    gap: 9px;
    padding: 5px 7px;
    color: var(--text-strong);
    font-size: 12px;
  }
  .sidebar-footer .user img,
  .sidebar-footer .user-initial { width: 32px; height: 32px; border-radius: 50%; }
  .sidebar-footer .user-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .app-content { min-width: 0; min-height: 100dvh; background: var(--bg); }
  .app-topbar {
    position: sticky;
    top: 0;
    z-index: 24;
    height: var(--topbar-height);
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 clamp(20px, 3vw, 40px);
    border-bottom: 1px solid var(--discord-ink);
    background: rgba(49, 51, 56, .94);
    backdrop-filter: blur(14px);
  }
  html[data-theme='light'] .app-topbar { background: rgba(255, 255, 255, .94); }
  .app-topbar-title { min-width: 0; color: var(--text-strong); font-size: 14px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .app-topbar-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
  .mobile-logout { display: none; }
  .mobile-logout .logout-form, .mobile-logout .tl { min-height: 34px; }
  .mobile-logout .tl {
    display: inline-flex;
    align-items: center;
    padding: 6px 9px;
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    color: var(--text-weak);
    font-size: 11px;
    font-weight: 650;
  }
  .mobile-logout .tl:hover { background: var(--surface-2); color: var(--text-strong); }
  .topbar-context {
    color: var(--text-strong);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
  }
  .topbar-product {
    min-width: 0;
    padding-left: 14px;
    border-left: 1px solid var(--border);
    color: var(--text-dim);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .page-frame {
    width: min(100%, var(--content-width));
    margin: 0 auto;
    padding: clamp(24px, 3vw, 42px) clamp(20px, 3.5vw, 52px) 80px;
  }
  .app-content > .topfoot {
    width: min(100%, var(--content-width));
    margin: 0 auto;
    padding: 0 clamp(20px, 3.5vw, 52px) 28px;
  }
  .app-main { width: 100%; min-width: 0; }
  .app-main > .card {
    width: 100%;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }
  .card {
    padding: 20px;
    border: 1px solid var(--border);
    border-radius: var(--radius-panel);
    background: var(--surface);
  }

  /* Shell publico da demo, login e mensagens. */
  .public-shell { min-height: 100dvh; }
  .public-shell > .topbar {
    position: sticky;
    top: 0;
    z-index: 24;
    width: 100%;
    min-height: var(--topbar-height);
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 10px clamp(16px, 4vw, 42px);
    border-bottom: 1px solid var(--discord-ink);
    background: var(--surface);
  }
  .public-shell > .app-main {
    width: min(100%, var(--content-width));
    margin: 0 auto;
  }
  .public-shell > .topfoot { padding: 0 20px 28px; text-align: center; }

  /* Topbar reutilizada por demo/publico */
  .topbar .brand { display: inline-flex; align-items: center; gap: 8px; color: var(--text-strong); font-size: 16px; font-weight: 700; text-decoration: none; }
  .topbar .brand img { width: 27px; height: 27px; border-radius: 7px; }
  .topbar .apptag { padding: 2px 6px; border-radius: 4px; background: var(--accent); color: #ffffff; font: 700 9px var(--mono); letter-spacing: .06em; text-transform: uppercase; }
  .topbar nav { display: flex; align-items: center; gap: 3px; }
  .topbar nav a, .topbar .tl {
    min-height: 36px;
    display: inline-flex;
    align-items: center;
    padding: 7px 9px;
    border-radius: 4px;
    color: var(--text-weak);
    font-size: 12px;
    font-weight: 600;
    text-decoration: none;
  }
  .topbar nav a:hover, .topbar .tl:hover { background: var(--surface-2); color: var(--text-strong); }
  .topbar nav a[aria-current='page'] { background: var(--surface-2); color: var(--text-strong); }
  .topnav-r { margin-left: auto; display: flex; align-items: center; gap: 8px; }
  .topbar .user { display: inline-flex; align-items: center; gap: 7px; color: var(--text-strong); font-size: 12px; }
  .topbar .user img, .user-initial { width: 28px; height: 28px; border-radius: 50%; }
  .user-initial { display: inline-grid; place-items: center; background: var(--surface-2); color: var(--text-strong); font-size: 11px; font-weight: 700; }
  .logout-form { display: inline-flex; }
  .logout-form .tl { border: 0; background: transparent; cursor: pointer; }
  .topfoot { color: var(--text-dim); font-size: 11px; }
  .topfoot a { color: var(--text-weak); text-decoration: none; }

  .thm {
    min-height: 34px;
    padding: 6px 9px;
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--text-weak);
    cursor: pointer;
    font-size: 11px;
    font-weight: 650;
  }
  .thm:hover { background: var(--surface-2); color: var(--text-strong); }
  .thm .to-dark { display: none; }
  html[data-theme='light'] .thm .to-dark { display: inline; }
  html[data-theme='light'] .thm .to-light { display: none; }
  .langtoggle { display: inline-flex; align-items: center; padding: 2px; border: 1px solid var(--border); border-radius: var(--radius-control); }
  .langtoggle a { min-width: 31px; min-height: 29px; display: inline-grid; place-items: center; border-radius: 4px; color: var(--text-weak); font-size: 10px; font-weight: 700; text-decoration: none; }
  .langtoggle a.on { background: var(--accent); color: #ffffff; }

  /* Controles */
  .btn {
    min-height: 40px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 8px 14px;
    border: 1px solid var(--accent);
    border-radius: var(--radius-control);
    background: var(--accent);
    color: #ffffff;
    font-size: 13px;
    line-height: 1.2;
    font-weight: 700;
    text-align: center;
    text-decoration: none;
    cursor: pointer;
    transition: background-color 120ms ease, border-color 120ms ease, transform 120ms ease;
  }
  .btn:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  .btn:active { transform: translateY(1px); }
  :where(button, .btn)[aria-busy='true'], :where(button, .btn):disabled {
    cursor: wait;
    opacity: .68;
    pointer-events: none;
  }
  .btn small { font-size: 10px; font-weight: 500; opacity: .78; }
  .btn.secondary { border-color: var(--border-strong); background: var(--surface-2); color: var(--text-strong); }
  .btn.secondary:hover { border-color: var(--text-dim); background: var(--surface-3); }
  .downloads { display: flex; flex-wrap: wrap; gap: 8px; }

  .field-label { color: var(--text-strong); font-size: 12px; font-weight: 650; }
  .tsearch input, .isearch input, .genform input, .app-input {
    width: 100%;
    min-height: 42px;
    padding: 9px 12px;
    border: 1px solid transparent;
    border-radius: var(--radius-control);
    background: var(--discord-input);
    color: var(--text-strong);
  }
  :where(.tsearch input, .isearch input, .genform input, .app-input)::placeholder { color: var(--text-dim); opacity: 1; }
  :where(.tsearch input, .isearch input, .genform input, .app-input):hover { border-color: var(--border-strong); }
  :where(.tsearch input, .isearch input, .genform input, .app-input):focus { border-color: var(--accent); }
  .fchips { display: flex; flex-wrap: wrap; gap: 6px; }
  .fchip {
    min-height: 34px;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: transparent;
    color: var(--text-weak);
    font-size: 11px;
    font-weight: 650;
    cursor: pointer;
  }
  .fchip:hover { border-color: var(--border-strong); background: var(--surface-2); color: var(--text-strong); }
  .fchip[aria-pressed='true'] { border-color: rgba(88, 101, 242, .55); background: var(--accent-soft); color: var(--text-strong); }
  .fchip.off, .fchip[aria-pressed='false'] { opacity: .52; text-decoration: line-through; }

  .badge, .wb {
    width: max-content;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 7px;
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    color: var(--text-weak);
    font-size: 10px;
    line-height: 1.2;
    font-weight: 700;
    white-space: nowrap;
  }
  .badge.live, .wb.live { border-color: var(--danger); background: var(--danger-soft); color: var(--danger); }
  .badge.live::before, .wb.live::before { width: 6px; height: 6px; border-radius: 50%; background: currentColor; content: ''; }
  .badge.done, .wb.ok { border-color: rgba(88, 101, 242, .6); background: var(--accent-soft); color: var(--done); }
  .wb.warn { border-color: rgba(254, 231, 92, .6); background: rgba(254, 231, 92, .08); color: var(--warn); }
  .note, .tstate {
    margin-top: 14px;
    padding: 11px 13px;
    border: 1px solid var(--border);
    border-left: 3px solid var(--warn);
    border-radius: var(--radius-control);
    background: var(--surface);
    color: var(--text);
    font-size: 13px;
  }

  /* Dashboard */
  .index-page { min-width: 0; }
  .page-eyebrow {
    color: var(--text-dim);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: .09em;
    text-transform: uppercase;
  }
  .index-head {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
    gap: 14px 24px;
    padding-bottom: 24px;
    border-bottom: 1px solid var(--border);
  }
  .index-head > :where(h1, .subline) { grid-column: 1; }
  .index-head .isearch { grid-column: 1 / -1; }
  .isearch {
    width: min(100%, 760px);
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    margin-top: 12px;
  }
  .isearch .field-label { grid-column: 1 / -1; }
  .search-clear {
    grid-column: 1 / -1;
    width: max-content;
    color: var(--text-dim);
    font-size: 11px;
    text-underline-offset: 3px;
  }
  .search-clear:hover { color: var(--text-strong); }
  .rstats {
    display: flex;
    flex-wrap: wrap;
    gap: 0;
    margin-top: 20px;
    border-block: 1px solid var(--border);
    color: var(--text-weak);
    font-size: 12px;
  }
  .rstats > * { padding: 11px 18px 11px 0; }
  .rstats > * + * { padding-left: 18px; border-left: 1px solid var(--border); }
  .rstats strong { color: var(--text-strong); font-size: 14px; }
  .rsorts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 14px; color: var(--text-dim); font-size: 11px; }
  .rsorts a, .rsorts .sorton { min-height: 31px; display: inline-flex; align-items: center; padding: 5px 9px; border-radius: 4px; color: var(--text-weak); text-decoration: none; }
  .rsorts a:hover { background: var(--surface-2); color: var(--text-strong); }
  .rsorts .sorton { background: var(--surface-2); color: var(--text-strong); font-weight: 700; }
  .filterblock { display: grid; gap: 8px; margin-top: 14px; }
  .filterlabel { color: var(--text-dim); font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
  .search-mode { margin-top: 26px; }
  .search-mode-head {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 18px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }
  .search-mode-head span {
    color: var(--text-dim);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: .08em;
  }
  .search-mode-head h2 { margin: 4px 0 0; font-size: 1.15rem; }
  .search-mode-head > a { color: var(--link); font-size: 11px; text-underline-offset: 3px; white-space: nowrap; }
  .recording-groups { display: grid; gap: 26px; margin-top: 28px; }
  .recording-group { min-width: 0; }
  .dayh { margin: 0 0 8px; color: var(--text-dim); font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
  .recording-grid { display: grid; grid-template-columns: minmax(0, 1fr); border-top: 1px solid var(--border); }
  .rrow, .recording-card {
    min-width: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: stretch;
    border-bottom: 1px solid var(--border);
    background: transparent;
    transition: background-color 120ms ease;
  }
  .rrow:hover, .recording-card:hover { background: var(--surface); }
  .recording-card-main {
    min-width: 0;
    display: grid;
    grid-template-columns: minmax(190px, 1.05fr) minmax(280px, 1.6fr) minmax(140px, .8fr);
    align-items: center;
    gap: 16px 24px;
    padding: 15px 12px;
    color: inherit;
    text-decoration: none;
  }
  .recording-card-head { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 7px; }
  .recording-channel { max-width: 100%; color: var(--text-strong); font-size: 15px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .recording-server {
    max-width: 100%;
    color: var(--text-dim);
    font-size: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .recording-card-meta { min-width: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px 18px; color: var(--text-weak); font-size: 11px; }
  .recording-card-meta small { display: block; color: var(--text-dim); font-size: 9px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
  .recording-card-meta strong { display: block; color: var(--text); font-size: 12px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .recording-card-detail { color: var(--text-dim); font-size: 11px; line-height: 1.45; }
  .row-people { display: inline-flex; align-items: center; min-height: 24px; padding-left: 3px; vertical-align: middle; }
  .row-people img, .row-person-initial, .row-person-more {
    width: 23px;
    height: 23px;
    display: inline-grid;
    place-items: center;
    flex: 0 0 23px;
    margin-left: -4px;
    border: 2px solid var(--bg);
    border-radius: 50%;
    background: var(--surface-2);
    font-size: 8px;
    font-weight: 700;
  }
  .recording-card:hover .row-people img,
  .recording-card:hover .row-person-initial,
  .recording-card:hover .row-person-more { border-color: var(--surface); }
  .row-person-more { width: auto; min-width: 23px; padding-inline: 4px; color: var(--text-weak); }
  .recording-card-actions { display: flex; align-items: center; justify-content: flex-end; gap: 5px; padding: 10px 0 10px 12px; }
  .recording-card-actions form { margin: 0; }
  .rbtn, button.softdanger, button.danger {
    min-height: 34px;
    padding: 6px 9px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--text-weak);
    font-size: 11px;
    font-weight: 650;
    cursor: pointer;
  }
  .rbtn:hover, button.softdanger:hover { background: var(--surface-2); color: var(--text-strong); }
  .rbtn.danger, button.danger { border-color: var(--danger); color: var(--danger); }
  .rbtn.danger:hover, button.danger:hover { background: var(--danger-soft); }
  .row-menu { position: relative; }
  .row-menu > summary {
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    border-radius: var(--radius-control);
    color: var(--text-dim);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 1px;
    list-style: none;
    cursor: pointer;
  }
  .row-menu > summary::-webkit-details-marker { display: none; }
  .row-menu > summary:hover, .row-menu[open] > summary { background: var(--surface-2); color: var(--text-strong); }
  .row-menu-popover {
    position: absolute;
    z-index: 32;
    top: calc(100% + 5px);
    right: 0;
    min-width: 170px;
    display: grid;
    gap: 5px;
    padding: 7px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-panel);
    background: var(--discord-ink);
    box-shadow: var(--shadow-float);
  }
  .row-menu-popover form, .row-menu-popover button { width: 100%; }
  .row-menu-popover button { justify-content: flex-start; text-align: left; }
  .hits { list-style: none; display: grid; gap: 0; margin-top: 14px; border-top: 1px solid var(--border); }
  .hits li { padding: 13px 8px; border-bottom: 1px solid var(--border); font-size: 12px; }
  .hits a { color: var(--link); text-underline-offset: 3px; }
  .hit-kind { display: block; color: var(--text-dim); font-size: 9px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
  .hit-date { display: block; margin: 2px 0 5px; color: var(--text-dim); font-size: 10px; }
  .empty-state { min-height: 180px; display: grid; align-content: center; justify-items: start; gap: 7px; padding: 28px; margin-top: 20px; border: 1px dashed var(--border-strong); border-radius: var(--radius-panel); color: var(--text-weak); }
  .empty-state strong { color: var(--text-strong); font-size: 16px; }
  .empty-state.compact { min-height: 0; padding: 16px; }
  .empty-kicker {
    color: var(--text-dim);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: .09em;
  }
  .empty-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 5px; }
  .empty-actions code {
    min-height: 40px;
    display: inline-flex;
    align-items: center;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--discord-input);
    color: var(--text-strong);
    font-size: 12px;
  }

  /* Reuniao */
  .meeting-page, .recording-page { min-width: 0; }
  .recording-head {
    display: grid;
    gap: 8px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--border);
  }
  .backlink {
    width: max-content;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--text-dim);
    font-size: 11px;
    font-weight: 650;
    text-decoration: none;
  }
  .backlink::before { content: '←'; font-family: var(--sans); font-size: 14px; }
  .backlink:hover { color: var(--text-strong); }
  .recording-alerts:empty { display: none; }
  .recording-alerts { display: grid; gap: 7px; }
  .recording-alerts .note { margin-top: 4px; }
  .recording-titleline { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .people { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .person {
    min-height: 32px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 3px 9px 3px 3px;
    border-radius: 999px;
    background: var(--surface);
    color: var(--text-weak);
    font-size: 11px;
  }
  .person img, .person-initial { width: 26px; height: 26px; border-radius: 50%; }
  .person-initial { display: inline-grid; place-items: center; background: var(--surface-2); font-size: 10px; font-weight: 700; }

  .meeting-layout, .recording-layout {
    min-width: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
    gap: 18px;
    margin-top: 18px;
  }
  .meeting-layout:has(.meeting-context),
  .recording-layout:has(.recording-context) { grid-template-columns: minmax(0, 1fr) minmax(250px, 300px); gap: 28px; }
  .recording-layout.solo { grid-template-columns: minmax(0, 1fr); }
  .meeting-main, .recording-stage, .meeting-stage { min-width: 0; }
  .meeting-context, .recording-context, .context-rail {
    position: sticky;
    top: calc(var(--topbar-height) + 18px);
    display: grid;
    gap: 12px;
    min-width: 0;
  }
  .context-card {
    padding: 15px;
    border: 1px solid var(--border);
    border-radius: var(--radius-panel);
    background: var(--surface);
  }
  .context-card h2, .context-card h3 { margin: 0 0 10px; }
  .context-list { list-style: none; display: grid; gap: 8px; color: var(--text-weak); font-size: 12px; }
  .context-section {
    padding: 15px;
    border: 1px solid var(--border);
    border-radius: var(--radius-panel);
    background: var(--surface);
  }
  .context-section h2 { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0 0 11px; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; }
  .context-section h2 > span { color: var(--text-dim); font-size: 10px; }
  .context-section .people { margin-top: 0; }
  .context-facts { display: grid; gap: 9px; }
  .context-facts > div { display: grid; gap: 1px; }
  .context-facts dt { color: var(--text-dim); font-size: 9px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
  .context-facts dd { color: var(--text); font-size: 11px; overflow-wrap: anywhere; }
  .manage-menu {
    border: 1px solid var(--border);
    border-radius: var(--radius-panel);
    background: var(--surface);
    overflow: hidden;
  }
  .manage-menu > summary {
    min-height: 42px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 9px 13px;
    color: var(--text-weak);
    font-size: 11px;
    font-weight: 650;
    cursor: pointer;
  }
  .manage-menu > summary::after { content: '+'; color: var(--text-dim); font: 13px var(--mono); }
  .manage-menu[open] > summary::after { content: '−'; }
  .manage-menu .dangerzone { margin: 0 8px 8px; }

  .recording-rail {
    position: sticky;
    top: var(--topbar-height);
    z-index: 18;
    min-width: 0;
    margin-inline: -2px;
    padding-top: 2px;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
  }
  .meeting-tabs, .tabbar {
    display: flex;
    gap: 2px;
    overflow-x: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--border-strong) transparent;
  }
  .meeting-tabs button, .tabbar button {
    min-height: 44px;
    flex: none;
    padding: 9px 11px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--text-weak);
    font-size: 12px;
    font-weight: 650;
    white-space: nowrap;
    cursor: pointer;
  }
  .meeting-tabs button:hover, .tabbar button:hover { color: var(--text-strong); }
  .meeting-tabs button[aria-selected='true'], .tabbar button[aria-selected='true'] { border-bottom-color: var(--accent); color: var(--text-strong); }
  .tpanel[hidden] { display: none; }
  .tpanel { min-width: 0; padding-top: 22px; }
  .tpanel > h2:first-child { margin-top: 0; }
  .ktabs .tpanel > h2:first-child { display: none; }
  .panel-state {
    min-height: 150px;
    display: grid;
    align-content: center;
    gap: 6px;
    padding: 22px;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-panel);
    color: var(--text-weak);
    font-size: 12px;
  }
  .panel-state strong { color: var(--text-strong); font-size: 14px; }

  .player-sticky {
    position: sticky;
    bottom: 14px;
    z-index: 20;
    margin: 18px 0 4px;
    filter: drop-shadow(0 12px 28px rgba(0, 0, 0, .24));
  }
  .playerwrap {
    padding: 12px 14px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-panel);
    background: rgba(43, 45, 49, .96);
    backdrop-filter: blur(16px);
  }
  html[data-theme='light'] .playerwrap { background: rgba(242, 243, 245, .96); }
  .playerwrap audio, .player audio { width: 100%; display: block; }
  .pctl { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px; color: var(--text-dim); font-size: 10px; }
  .speed { display: inline-flex; gap: 4px; }
  .speed button {
    min-width: 37px;
    min-height: 31px;
    padding: 4px 7px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--discord-input);
    color: var(--text-weak);
    font: 10px var(--mono);
    cursor: pointer;
  }
  .speed button.on, .speed button[aria-pressed='true'] { border-color: var(--accent); background: var(--accent); color: #ffffff; }
  .follow { min-height: 31px; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
  .follow input { width: 15px; height: 15px; accent-color: var(--accent); }

  /* Ata e transcricao */
  .minutes, .transcript {
    min-width: 0;
    padding: clamp(16px, 2.5vw, 24px);
    border: 1px solid var(--border);
    border-radius: var(--radius-panel);
    background: var(--surface);
  }
  .minutes { color: var(--text); font-size: 14px; }
  .minutes h3 { margin: 24px 0 8px; color: var(--text-strong); font-size: 12px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
  .minutes h3:first-child { margin-top: 0; }
  .minutes .lead { color: var(--text-strong); font-size: 16px; line-height: 1.68; }
  .minutes ul { display: grid; gap: 8px; padding-left: 20px; }
  .minutes .action { display: flex; align-items: baseline; gap: 8px; }
  .action-mark { width: 13px; height: 13px; flex: 0 0 13px; border: 1px solid var(--border-strong); border-radius: 3px; transform: translateY(2px); }
  .minutes .meta2 { color: var(--text-dim); font-size: 11px; }
  .minutes .who { margin: 14px 0 4px; color: var(--text-strong); font-weight: 700; }
  .copybtn {
    min-height: 30px;
    margin-left: 5px;
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface-2);
    color: var(--text-weak);
    font-size: 10px;
    vertical-align: middle;
    cursor: pointer;
  }
  .copybtn:hover { border-color: var(--border-strong); color: var(--text-strong); }
  :where(.copybtn, .btn)[data-copy-state='error'] { border-color: var(--danger); color: var(--danger); }
  .media-status { min-height: 20px; margin-top: 8px; }
  .media-status[role='alert'] { color: var(--danger); }
  .tsearch { display: grid; gap: 8px; margin: 2px 0 12px; }
  .transcript { display: grid; gap: 4px; }
  .tblock { padding: 12px 0; border-bottom: 1px solid var(--border); }
  .tblock:last-child { border-bottom: 0; }
  .tblock .thead { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
  .tblock .thead img, .speaker-initial { width: 27px; height: 27px; border-radius: 50%; }
  .speaker-initial { display: inline-grid; place-items: center; background: var(--surface-2); font-size: 10px; font-weight: 700; }
  .transcript .who { color: var(--text-strong); font-size: 12px; font-weight: 700; }
  .transcript p { padding: 4px 8px; border-left: 2px solid transparent; border-radius: 4px; line-height: 1.7; }
  .transcript p:hover { background: var(--surface-2); }
  .transcript p.now { border-left-color: var(--accent); background: var(--accent-soft); }
  .transcript time { color: var(--text-dim); font-size: 10px; }
  .c0 { color: var(--c0); } .c1 { color: var(--c1); } .c2 { color: var(--c2); } .c3 { color: var(--c3); }
  .c4 { color: var(--c4); } .c5 { color: var(--c5); } .c6 { color: var(--c6); } .c7 { color: var(--c7); }
  .ts { margin-right: 7px; color: var(--link); font-size: 10px; text-decoration: none; cursor: pointer; }
  .ts:hover { text-decoration: underline; }
  .tdl { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
  .tdl a { color: var(--link); font-size: 12px; text-underline-offset: 3px; }

  /* Timeline */
  .tl2 { margin: 6px 0 16px; padding: 18px; border: 1px solid var(--border); border-radius: var(--radius-panel); background: var(--surface); }
  .tl-ch { position: relative; height: 30px; }
  .tl-seg { position: absolute; top: 0; height: 26px; display: flex; align-items: center; overflow: hidden; padding: 0 6px; border: 1px solid rgba(88, 101, 242, .5); border-radius: 4px; background: var(--accent-soft); text-decoration: none; }
  .tl-seg.s1 { background: rgba(88, 101, 242, .09); }
  .tl-seg:hover { background: rgba(88, 101, 242, .28); }
  .tl-seg span { width: 100%; overflow: hidden; color: var(--text-strong); font: 9px var(--mono); text-align: center; }
  .tl-chlist { list-style: none; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 4px 12px; margin-top: 12px; }
  .tl-chlist a, .tl-static { min-height: 34px; display: flex; align-items: center; gap: 7px; padding: 4px 6px; border-radius: 4px; color: var(--text); font-size: 12px; text-decoration: none; }
  .tl-chlist a:hover { background: var(--surface-2); color: var(--text-strong); }
  .tl-chlist b, .tl-chlist time { flex: none; color: var(--text-dim); font: 10px var(--mono); }
  .tl-chlist span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tl-ticks { position: relative; height: 18px; margin-top: 3px; }
  .tl-tk { position: absolute; top: 2px; width: 6px; height: 13px; border-radius: 3px; transform: translateX(-50%); background: var(--text-dim); }
  .tl-tk.tnote { background: var(--warn); }
  .tl-tk.join { background: var(--accent); }
  .tl-tk.leave { background: var(--text-dim); }
  .tl-ax { display: flex; justify-content: space-between; padding-top: 5px; margin-top: 4px; border-top: 1px solid var(--border); color: var(--text-dim); font: 9px var(--mono); }
  .tl-lg { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; margin-top: 8px; color: var(--text-dim); font-size: 10px; }
  .tl-lg i { width: 8px; height: 8px; display: inline-block; margin-right: 4px; border-radius: 2px; vertical-align: -1px; }
  .tl-lg .lg-ch, .tl-lg .lg-join { background: var(--accent); }
  .tl-lg .lg-note { background: var(--warn); }
  .tl-lg .lg-leave { background: var(--text-dim); }
  .tl-lg .lg-hint { margin-left: auto; }
  .notes, .events { list-style: none; display: grid; gap: 7px; padding: 0; font-size: 12px; }
  .events { max-height: 300px; overflow-y: auto; }
  .notes time, .events time { margin-right: 7px; color: var(--text-dim); }
  .wall { color: var(--text-dim) !important; font-size: 10px; }
  .evlist summary { min-height: 40px; display: flex; align-items: center; color: var(--text-weak); font-size: 12px; cursor: pointer; }
  details.tech { margin-top: 9px; color: var(--text-dim); font-size: 11px; }
  details.tech summary { min-height: 36px; display: flex; align-items: center; cursor: pointer; }
  details.tech code { display: block; margin-top: 5px; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius-control); background: var(--discord-input); overflow-wrap: anywhere; }

  /* Arquivos e privacidade */
  .file-list { display: grid; gap: 12px; }
  .file-group {
    display: grid;
    grid-template-columns: minmax(150px, 220px) minmax(0, 1fr);
    gap: 18px;
    align-items: start;
    padding: 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius-panel);
    background: var(--surface);
  }
  .file-group-head { display: grid; gap: 2px; }
  .file-group-head span { color: var(--text-strong); font-size: 13px; font-weight: 700; }
  .file-group-head small { color: var(--text-dim); font-size: 10px; }
  .file-group > .muted { grid-column: 2; }
  .file-group .downloads { align-self: center; }
  .downloads-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px; }
  .downloads-grid .btn { min-height: 54px; align-items: flex-start; text-align: left; }
  .dangerzone { display: grid; gap: 12px; padding: 16px; border: 1px solid rgba(237, 66, 69, .45); border-radius: var(--radius-panel); background: var(--danger-soft); }
  .dangerzone form { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .dangerzone .why { color: var(--text-weak); font-size: 11px; }
  .player { margin: 14px 0 4px; }
  .player .hint { margin-top: 6px; color: var(--text-dim); font-size: 11px; }
  .recording-foot { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 16px; padding-top: 18px; border-top: 1px solid var(--border); color: var(--text-dim); font-size: 11px; }

  /* MCP, conexoes e mensagens */
  .connect-page, .message-page { width: min(100%, 980px); }
  .connect-intro { max-width: 72ch; margin-top: 10px; color: var(--text-weak); }
  .connect-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(240px, 300px); gap: 28px; align-items: start; margin-top: 24px; }
  .connect-main, .connect-aside { min-width: 0; }
  .connect-aside { position: sticky; top: calc(var(--topbar-height) + 18px); }
  .security-note { display: grid; gap: 4px; margin-top: 14px; padding: 13px; border: 1px solid var(--border); border-radius: var(--radius-panel); background: var(--surface); font-size: 12px; }
  .security-note strong { color: var(--text-strong); }
  .genform { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; margin-top: 17px; }
  .genform .field-label { grid-column: 1 / -1; }
  .tokenbox { margin-top: 11px; padding: 15px; border: 1px solid var(--border); border-radius: var(--radius-panel); background: var(--discord-ink); color: var(--text-strong); font-size: 11px; white-space: pre; }
  .connect-steps { margin: 11px 0 0 20px; color: var(--text-weak); font-size: 12px; }
  .connect-steps li + li { margin-top: 5px; }
  .connection-list { display: grid; gap: 0; margin-top: 12px; border-top: 1px solid var(--border); }
  .connection-card { min-width: 0; display: grid; grid-template-columns: minmax(170px, 1.5fr) repeat(3, minmax(100px, 1fr)) auto; gap: 13px; align-items: center; padding: 13px 7px; border-bottom: 1px solid var(--border); }
  .connection-name { min-width: 0; }
  .connection-name strong { display: block; color: var(--text-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .connection-card small { display: block; color: var(--text-dim); font-size: 9px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
  .connection-card code { color: var(--text-weak); font-size: 10px; }
  .connection-card form { margin: 0; }
  .message-page { min-height: 52vh; display: grid; align-content: center; justify-items: start; }

  footer { margin-top: 24px; color: var(--text-dim); font-size: 11px; }

  @keyframes surface-in {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes live-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: .45; }
  }
  @media (prefers-reduced-motion: no-preference) {
    html { scroll-behavior: smooth; }
    .page-frame { animation: surface-in 260ms cubic-bezier(.2, .8, .2, 1) both; }
    .badge.live::before, .wb.live::before { animation: live-pulse 1.6s ease-in-out infinite; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      scroll-behavior: auto !important;
      animation-duration: .01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: .01ms !important;
    }
  }

  @media (max-width: 1120px) {
    :root { --sidebar-width: 220px; }
    .recording-card-main { grid-template-columns: minmax(175px, 1fr) minmax(250px, 1.5fr); }
    .recording-card-detail { grid-column: 1 / -1; }
    .meeting-layout:has(.meeting-context), .recording-layout:has(.recording-context) { grid-template-columns: minmax(0, 1fr) 250px; gap: 20px; }
    .connection-card { grid-template-columns: minmax(170px, 1.4fr) repeat(2, minmax(100px, 1fr)) auto; }
    .connection-card > :nth-child(4) { display: none; }
  }

  @media (max-width: 860px) {
    :root { --topbar-height: 56px; }
    .app-shell { display: block; padding-bottom: 62px; }
    .app-sidebar {
      position: fixed;
      inset: auto 0 0;
      z-index: 60;
      width: 100%;
      height: 62px;
      display: block;
      padding: 7px 10px max(7px, env(safe-area-inset-bottom));
      border-top: 1px solid var(--discord-ink);
      border-right: 0;
      overflow: hidden;
    }
    .sidebar-brand, .sidebar-label, .sidebar-nav-label, .sidebar-spacer, .sidebar-resources, .sidebar-footer { display: none; }
    .app-sidebar > .sidebar-nav {
      width: min(100%, 520px);
      height: 48px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(112px, 1fr));
      gap: 5px;
      margin: 0 auto;
      overflow: visible;
    }
    .app-sidebar > .sidebar-nav a,
    .app-sidebar > .sidebar-nav button {
      min-width: 0;
      min-height: 48px;
      justify-content: center;
      gap: 5px;
      padding: 6px 10px;
      font-size: 11px;
      text-align: center;
      white-space: nowrap;
    }
    .sidebar-nav .nav-icon { height: 17px; }
    .app-topbar { height: 56px; padding-inline: 18px; }
    .mobile-logout { display: inline-flex; }
    .page-frame { padding: 24px 18px 44px; }
    .meeting-layout:has(.meeting-context), .recording-layout:has(.recording-context), .connect-layout { grid-template-columns: minmax(0, 1fr); }
    .meeting-context, .recording-context, .context-rail, .connect-aside { position: static; }
    .recording-card-main { grid-template-columns: minmax(160px, 1fr) minmax(220px, 1.5fr); gap: 12px 18px; }
    .rrow, .recording-card { grid-template-columns: minmax(0, 1fr); }
    .recording-card-actions { padding: 0 12px 12px; justify-content: flex-start; }
    .connection-card { grid-template-columns: 1fr 1fr; }
    .connection-name { grid-column: 1 / -1; }
    .public-shell > .topbar { padding-inline: 14px; }
    .topbar .user-name { display: none; }
  }

  @media (max-width: 620px) {
    .public-shell > .topbar { display: grid; grid-template-columns: auto 1fr; gap: 8px; }
    .public-shell > .topbar nav { grid-column: 1 / -1; grid-row: 2; overflow-x: auto; padding-top: 7px; border-top: 1px solid var(--border); }
    .topnav-r { justify-self: end; }
    .topbar-product { display: none; }
    .topbar .user { display: none; }
    .index-head { grid-template-columns: 1fr; }
    .isearch, .genform { grid-template-columns: minmax(0, 1fr); }
    .isearch .btn, .genform .btn { width: 100%; }
    .rstats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .rstats > * { padding: 9px 12px 9px 0; }
    .rstats > * + * { padding-left: 12px; }
    .rstats > :nth-child(odd) { padding-left: 0; border-left: 0; }
    .recording-card-main { grid-template-columns: minmax(0, 1fr); gap: 9px; padding: 14px 8px; }
    .recording-card-meta { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .recording-card-detail { grid-column: auto; }
    .recording-card-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); padding-inline: 8px; }
    .recording-card-actions form, .recording-card-actions button { width: 100%; }
    .row-menu { justify-self: end; }
    .row-menu-popover { right: 0; }
    .recording-rail { top: 56px; }
    .tabbar button, .meeting-tabs button { min-height: 42px; padding-inline: 9px; }
    .player-sticky { bottom: 72px; }
    .minutes, .transcript, .tl2 { padding: 14px 11px; }
    .file-group { grid-template-columns: minmax(0, 1fr); gap: 10px; }
    .file-group > .muted { grid-column: auto; }
    .grid { grid-template-columns: 1fr; gap: 2px; }
    .downloads .btn { flex: 1 1 145px; }
    .connection-card { grid-template-columns: minmax(0, 1fr); }
    .connection-name { grid-column: auto; }
    .connection-card form, .connection-card button { width: 100%; }
    .tl-lg .lg-hint { width: 100%; margin-left: 0; }
  }

  @media (max-width: 420px) {
    .page-frame { padding-inline: 12px; }
    .public-shell > .app-main .page-frame { padding-inline: 12px; }
    .thm { display: none; }
    h1 { font-size: 1.55rem; }
    .topbar-context { font-size: 12px; }
    .app-topbar-actions { gap: 5px; }
    .langtoggle a { min-width: 28px; }
    .rstats { grid-template-columns: minmax(0, 1fr); }
    .rstats > *, .rstats > * + * { padding: 8px 0; border-left: 0; border-bottom: 1px solid var(--border); }
    .recording-card-meta { grid-template-columns: minmax(0, 1fr); }
    .pctl { align-items: flex-start; flex-direction: column; }
    .playerwrap { padding: 10px; }
    .empty-actions { align-items: stretch; flex-direction: column; }
    .empty-actions > * { width: 100%; justify-content: center; }
  }
`;
