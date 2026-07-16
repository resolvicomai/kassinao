import { config } from '../config';
import { CSP_NONCE_ATTR } from './csp';
import type { Locale } from '../i18n';
import { publicSite } from './site';

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const LANDING_CSS = `
@font-face {
  font-family: 'Space Grotesk';
  src: url('/assets/space-grotesk.woff2') format('woff2');
  font-style: normal;
  font-weight: 300 700;
  font-display: swap;
}

:root {
  color-scheme: dark;
  --bg: #111214;
  --bg-raised: #17181c;
  --surface: #1e1f22;
  --surface-2: #232428;
  --surface-3: #2b2d31;
  --text: #f2f3f5;
  --text-soft: #dbdee1;
  --muted: #b5bac1;
  --dim: #949ba4;
  --line: #35363c;
  --line-strong: #4e5058;
  --accent: #5865f2;
  --accent-hover: #4752c4;
  --accent-soft: #c9cdfb;
  --link: #00a8fc;
  --page: min(1240px, calc(100vw - 48px));
  --radius: 18px;
  --radius-control: 9px;
  --font: 'Space Grotesk', 'Avenir Next', 'Segoe UI', sans-serif;
  --mono: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
}

* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
  overflow-x: clip;
  background: var(--bg);
}

body {
  margin: 0;
  overflow-x: hidden;
  background:
    radial-gradient(circle at 72% 8%, rgb(88 101 242 / .14), transparent 28rem),
    var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 16px;
  line-height: 1.55;
  text-rendering: optimizeLegibility;
}

a {
  color: inherit;
}

a:focus-visible {
  outline: 3px solid var(--accent-soft);
  outline-offset: 3px;
}

button,
a {
  -webkit-tap-highlight-color: transparent;
}

img,
video {
  display: block;
  max-width: 100%;
}

.skip-link {
  position: fixed;
  top: 10px;
  left: 10px;
  z-index: 100;
  min-height: 44px;
  padding: 9px 13px;
  border-radius: var(--radius-control);
  background: var(--text);
  color: var(--bg);
  font-weight: 700;
  transform: translateY(-160%);
}

.skip-link:focus {
  transform: none;
}

.wrap {
  width: var(--page);
  margin-inline: auto;
}

.site-header {
  position: sticky;
  top: 0;
  z-index: 50;
  border-bottom: 1px solid rgb(78 80 88 / .48);
  background: rgb(17 18 20 / .86);
  backdrop-filter: blur(18px) saturate(145%);
}

.nav {
  display: flex;
  align-items: center;
  min-height: 68px;
  gap: 24px;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  flex: none;
  min-width: 44px;
  min-height: 44px;
  color: var(--text);
  font-size: 17px;
  font-weight: 700;
  text-decoration: none;
}

.brand-mark {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  background: var(--accent);
  color: white;
  font-size: 15px;
  font-weight: 800;
  letter-spacing: -.05em;
}

.nav-links {
  display: flex;
  align-items: center;
  gap: 22px;
  margin-left: auto;
}

.nav-links a {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  min-height: 44px;
  padding-inline: 4px;
}

.nav-links a,
.footer-links a {
  color: var(--muted);
  font-size: 14px;
  font-weight: 650;
  text-decoration: none;
  transition: color 150ms ease;
}

.footer-links a {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  min-height: 44px;
}

.nav-links a:hover,
.footer-links a:hover {
  color: var(--text);
}

.language {
  display: inline-flex;
  align-items: center;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  background: var(--surface);
}

.language a {
  display: grid;
  place-items: center;
  min-width: 44px;
  min-height: 44px;
  border-radius: 6px;
  color: var(--dim);
  font-size: 11px;
  font-weight: 800;
  text-decoration: none;
}

.language a[aria-current='page'] {
  background: var(--accent);
  color: white;
}

.hero {
  display: grid;
  grid-template-columns: minmax(0, .9fr) minmax(520px, 1.1fr);
  align-items: center;
  gap: clamp(42px, 6vw, 84px);
  min-height: calc(100dvh - 69px);
  padding-block: 64px;
}

.hero-copy {
  position: relative;
  z-index: 2;
}

.eyebrow {
  margin: 0 0 18px;
  color: var(--accent-soft);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: .09em;
  text-transform: uppercase;
}

.hero h1 {
  max-width: 13.5ch;
  margin: 0;
  font-size: clamp(3.25rem, 5.3vw, 5.25rem);
  line-height: .98;
  letter-spacing: -.065em;
}

.hero-sub {
  max-width: 33rem;
  margin: 25px 0 0;
  color: var(--muted);
  font-size: clamp(1.05rem, 1.45vw, 1.25rem);
  line-height: 1.48;
}

.hero-actions,
.section-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 11px;
  margin-top: 30px;
}

.hero-note {
  max-width: 34rem;
  margin: 13px 0 0;
  color: var(--dim);
  font-size: 12px;
  line-height: 1.5;
}

.product-hunt-badge {
  display: inline-flex;
  align-items: center;
  gap: 11px;
  width: min(100%, 250px);
  min-height: 54px;
  margin-top: 18px;
  padding: 8px 14px 8px 9px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  background: var(--surface);
  color: var(--text);
  text-decoration: none;
  transition:
    transform 160ms ease,
    background 160ms ease,
    border-color 160ms ease;
}

.product-hunt-badge img {
  width: 36px;
  height: 36px;
  flex: none;
}

.product-hunt-copy {
  display: grid;
  gap: 1px;
  min-width: 0;
}

.product-hunt-copy span {
  color: var(--muted);
  font-size: 10px;
  font-weight: 650;
  line-height: 1.2;
}

.product-hunt-copy strong {
  font-size: 13px;
  line-height: 1.25;
}

.product-hunt-badge:hover {
  transform: translateY(-2px);
  border-color: rgb(218 85 47 / .8);
  background: var(--surface-2);
}

.product-hunt-badge:active,
.button:active {
  transform: scale(.98);
}

.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 46px;
  padding: 0 18px;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  font-size: 14px;
  font-weight: 750;
  line-height: 1;
  text-decoration: none;
  white-space: nowrap;
  transition:
    transform 160ms ease,
    background 160ms ease,
    border-color 160ms ease;
}

.button:hover {
  transform: translateY(-2px);
}

.button-primary {
  background: var(--accent);
  color: white;
}

.button-primary:hover {
  background: var(--accent-hover);
}

.button-secondary {
  border-color: var(--line-strong);
  background: var(--surface);
  color: var(--text);
}

.button-secondary:hover {
  border-color: var(--muted);
  background: var(--surface-2);
}

.hero-proof {
  position: relative;
  min-width: 0;
}

.hero-proof::before {
  content: '';
  position: absolute;
  inset: -18px;
  z-index: -1;
  border-radius: 30px;
  background: radial-gradient(circle at 50% 20%, rgb(88 101 242 / .25), transparent 62%);
  filter: blur(22px);
}

.media-frame {
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: 0 34px 90px rgb(0 0 0 / .36);
}

.media-frame video,
.media-frame img {
  width: 100%;
  height: auto;
  aspect-ratio: 1270 / 760;
  object-fit: cover;
}

.motion-poster {
  display: none;
}

.media-caption {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 12px 4px 0;
  color: var(--dim);
  font-size: 12px;
}

.proof-line {
  border-block: 1px solid var(--line);
  background: rgb(30 31 34 / .76);
}

.proof-items {
  display: grid;
  grid-template-columns: 1.05fr .95fr 1.25fr .75fr;
}

.proof-item {
  min-width: 0;
  padding: 22px 26px;
  border-right: 1px solid var(--line);
}

.proof-item:first-child {
  padding-left: 0;
}

.proof-item:last-child {
  border-right: 0;
  padding-right: 0;
}

.proof-item strong,
.proof-item span {
  display: block;
}

.proof-item strong {
  color: var(--text);
  font-size: 15px;
}

.proof-item span {
  margin-top: 2px;
  color: var(--dim);
  font-size: 12px;
}

.section {
  padding-block: clamp(82px, 9vw, 126px);
  border-bottom: 1px solid var(--line);
}

.section-head {
  max-width: 820px;
  margin-bottom: 44px;
}

.section-head h2,
.trust-intro h2,
.final-cta h2 {
  margin: 0;
  font-size: clamp(2.4rem, 4.5vw, 4.7rem);
  line-height: 1.02;
  letter-spacing: -.055em;
}

.section-head p,
.trust-intro p {
  max-width: 680px;
  margin: 18px 0 0;
  color: var(--muted);
  font-size: 18px;
}

.identity-stage {
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background:
    linear-gradient(140deg, rgb(88 101 242 / .11), transparent 38%),
    var(--bg-raised);
}

.identity-axis {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr) minmax(280px, .88fr);
  align-items: center;
  min-height: 64px;
  padding-inline: 28px;
  border-bottom: 1px solid var(--line);
  color: var(--dim);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: .07em;
  text-transform: uppercase;
}

.identity-row {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr) minmax(280px, .88fr);
  align-items: center;
  gap: 22px;
  min-height: 118px;
  padding: 20px 28px;
  border-bottom: 1px solid var(--line);
}

.identity-row:last-child {
  border-bottom: 0;
}

.person {
  display: flex;
  align-items: center;
  gap: 12px;
}

.person-avatar {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  flex: none;
  border-radius: 50%;
  background: var(--accent);
  color: white;
  font-weight: 800;
}

.person strong,
.person > span:not(.person-avatar) {
  display: block;
}

.person > span:not(.person-avatar) > span {
  color: var(--dim);
  font-size: 12px;
}

.track {
  position: relative;
  display: grid;
  grid-template-columns: 86px 1fr;
  align-items: center;
  gap: 14px;
}

.track code {
  color: var(--accent-soft);
  font-family: var(--mono);
  font-size: 11px;
}

.wave {
  display: flex;
  align-items: center;
  gap: 3px;
  height: 34px;
  overflow: hidden;
}

.wave i {
  width: 3px;
  height: var(--h);
  border-radius: 3px;
  background: var(--accent);
  opacity: .9;
  transform-origin: center;
  animation: voice 1.8s ease-in-out infinite alternate;
  animation-delay: calc(var(--i) * -55ms);
}

.transcript-line {
  padding-left: 14px;
  border-left: 3px solid var(--accent);
  color: var(--text-soft);
  font-size: 14px;
}

.transcript-line strong {
  color: var(--accent-soft);
}

.transcript-line time {
  display: block;
  color: var(--dim);
  font-family: var(--mono);
  font-size: 10px;
}

@keyframes voice {
  from { transform: scaleY(.48); opacity: .55; }
  to { transform: scaleY(1); opacity: 1; }
}

.discord-story {
  display: grid;
  grid-template-columns: minmax(300px, .72fr) minmax(0, 1.28fr);
  gap: clamp(40px, 7vw, 96px);
  align-items: start;
}

.story-copy {
  position: sticky;
  top: 110px;
}

.story-copy h2 {
  margin: 0;
  font-size: clamp(2.7rem, 4.6vw, 4.8rem);
  line-height: 1.01;
  letter-spacing: -.055em;
}

.story-copy p {
  margin: 18px 0 0;
  color: var(--muted);
  font-size: 18px;
}

.command-journey {
  border-top: 1px solid var(--line-strong);
}

.command-step {
  display: grid;
  grid-template-columns: 118px 1fr;
  gap: 30px;
  padding: 30px 0;
  border-bottom: 1px solid var(--line);
}

.command-step code {
  align-self: start;
  color: var(--accent-soft);
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 700;
}

.command-step strong,
.command-step span {
  display: block;
}

.command-step strong {
  font-size: 18px;
}

.command-step span {
  max-width: 34rem;
  margin-top: 6px;
  color: var(--muted);
  font-size: 14px;
}

.meeting-section {
  background:
    linear-gradient(180deg, transparent, rgb(88 101 242 / .055) 50%, transparent),
    var(--bg);
}

.meeting-frame {
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: 0 28px 80px rgb(0 0 0 / .28);
}

.meeting-frame img {
  width: 100%;
  aspect-ratio: 1255 / 751;
  object-fit: cover;
}

.meeting-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 28px;
  padding: 22px 24px;
  border-top: 1px solid var(--line);
}

.meeting-foot p {
  max-width: 700px;
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}

.answer-stage {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(300px, .75fr);
  gap: 18px;
  align-items: stretch;
}

.discord-answer,
.mcp-window {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}

.discord-answer {
  display: grid;
  align-content: center;
  min-height: 440px;
  padding: clamp(28px, 5vw, 58px);
}

.chat-line {
  display: grid;
  grid-template-columns: 42px 1fr;
  gap: 12px;
}

.chat-line + .chat-line {
  margin-top: 28px;
}

.chat-avatar {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--line-strong);
  font-size: 12px;
  font-weight: 800;
}

.chat-avatar.bot {
  background: var(--accent);
}

.chat-meta {
  color: var(--text);
  font-size: 14px;
  font-weight: 750;
}

.chat-meta span {
  margin-left: 7px;
  color: var(--dim);
  font-size: 10px;
  font-weight: 500;
}

.chat-meta .ephemeral {
  padding: 2px 5px;
  border-radius: 4px;
  background: rgb(88 101 242 / .16);
  color: var(--accent-soft);
  font-weight: 750;
  letter-spacing: .02em;
  text-transform: uppercase;
}

.chat-copy {
  margin: 5px 0 0;
  color: var(--text-soft);
  font-size: 15px;
}

.slash-command {
  color: var(--accent-soft);
  font-family: var(--mono);
  font-weight: 750;
}

.source-answer {
  margin-top: 8px;
  padding: 16px;
  border-left: 3px solid var(--accent);
  border-radius: 4px;
  background: var(--surface-2);
  color: var(--text-soft);
  font-size: 14px;
}

.source-answer a {
  color: var(--link);
  font-weight: 750;
  text-decoration: none;
}

.mcp-window {
  display: grid;
  grid-template-rows: auto 1fr;
  overflow: hidden;
}

.window-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--line);
  color: var(--dim);
  font-family: var(--mono);
  font-size: 11px;
}

.mcp-body {
  display: grid;
  align-content: center;
  gap: 18px;
  padding: 26px;
  font-family: var(--mono);
  font-size: 12px;
}

.mcp-query,
.mcp-response {
  padding: 14px;
  border-radius: 8px;
  background: var(--bg-raised);
  color: var(--text-soft);
}

.mcp-query::before {
  content: 'you';
  display: block;
  margin-bottom: 6px;
  color: var(--accent-soft);
  font-size: 10px;
}

.mcp-response::before {
  content: 'kassinao';
  display: block;
  margin-bottom: 6px;
  color: var(--link);
  font-size: 10px;
}

.mcp-note {
  margin: 0;
  color: var(--dim);
  font-family: var(--font);
  font-size: 12px;
}

.trust-layout {
  display: grid;
  grid-template-columns: minmax(280px, .72fr) minmax(0, 1.28fr);
  gap: clamp(52px, 9vw, 120px);
  align-items: start;
}

.trust-intro p {
  max-width: 30rem;
}

.trust-list {
  border-top: 1px solid var(--line-strong);
}

.trust-row {
  display: grid;
  grid-template-columns: 155px 1fr;
  gap: 28px;
  padding: 28px 0;
  border-bottom: 1px solid var(--line);
}

.trust-row strong {
  font-size: 15px;
}

.trust-row p {
  max-width: 42rem;
  margin: 0;
  color: var(--muted);
  font-size: 14px;
}

.final-section {
  padding-block: clamp(92px, 11vw, 150px);
}

.final-cta {
  position: relative;
  overflow: hidden;
  padding: clamp(42px, 7vw, 84px);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius);
  background:
    radial-gradient(circle at 80% 20%, rgb(88 101 242 / .34), transparent 24rem),
    var(--surface);
}

.final-cta h2 {
  max-width: 13ch;
}

.final-cta p {
  max-width: 40rem;
  margin: 18px 0 0;
  color: var(--muted);
  font-size: 18px;
}

.launch-line {
  margin-top: 28px;
  color: var(--dim);
  font-size: 12px;
}

.site-footer {
  border-top: 1px solid var(--line);
}

.footer-inner {
  display: flex;
  align-items: center;
  min-height: 94px;
  gap: 24px;
}

.footer-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--muted);
  font-size: 13px;
}

.footer-links {
  display: flex;
  gap: 20px;
  margin-left: auto;
}

[data-reveal] {
  opacity: 0;
  transform: translateY(22px);
  transition:
    opacity 650ms cubic-bezier(.22, 1, .36, 1),
    transform 650ms cubic-bezier(.22, 1, .36, 1);
}

[data-reveal].is-visible {
  opacity: 1;
  transform: none;
}

.hero-copy,
.hero-proof {
  animation: hero-enter 700ms cubic-bezier(.22, 1, .36, 1) both;
}

.hero-proof {
  animation-delay: 110ms;
}

@keyframes hero-enter {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: none; }
}

@media (max-width: 1040px) {
  .hero {
    grid-template-columns: 1fr;
    min-height: 0;
    padding-block: 74px;
  }

  .hero h1 {
    max-width: 15ch;
  }

  .hero-proof {
    max-width: 880px;
  }

  .proof-items {
    grid-template-columns: repeat(2, 1fr);
  }

  .proof-item:nth-child(2) {
    border-right: 0;
  }

  .proof-item:nth-child(-n + 2) {
    border-bottom: 1px solid var(--line);
  }

  .proof-item:first-child,
  .proof-item:nth-child(3) {
    padding-left: 0;
  }

  .identity-axis,
  .identity-row {
    grid-template-columns: 180px minmax(0, 1fr) minmax(250px, .9fr);
  }

  .discord-story,
  .trust-layout {
    grid-template-columns: 1fr;
  }

  .story-copy {
    position: static;
    max-width: 760px;
  }
}

@media (max-width: 780px) {
  :root {
    --page: min(100% - 32px, 1240px);
  }

  .nav {
    gap: 12px;
  }

  .brand span:last-child {
    display: none;
  }

  .nav-links {
    gap: 2px;
  }

  .nav-links a {
    font-size: 12px;
  }

  .hero {
    gap: 44px;
    padding-block: 54px 68px;
  }

  .hero h1 {
    font-size: clamp(3rem, 13vw, 4.8rem);
  }

  .proof-items {
    grid-template-columns: 1fr;
  }

  .proof-item,
  .proof-item:first-child,
  .proof-item:nth-child(3),
  .proof-item:last-child {
    padding: 17px 0;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }

  .proof-item:last-child {
    border-bottom: 0;
  }

  .section {
    padding-block: 76px;
  }

  .identity-axis {
    display: none;
  }

  .identity-row {
    grid-template-columns: 1fr;
    gap: 18px;
    padding: 26px 22px;
  }

  .track {
    grid-template-columns: 72px 1fr;
  }

  .command-step {
    grid-template-columns: 1fr;
    gap: 9px;
  }

  .meeting-foot {
    align-items: flex-start;
    flex-direction: column;
  }

  .answer-stage {
    grid-template-columns: 1fr;
  }

  .discord-answer {
    min-height: 0;
  }

  .trust-row {
    grid-template-columns: 1fr;
    gap: 8px;
  }

  .footer-inner {
    align-items: flex-start;
    flex-direction: column;
    padding-block: 28px;
  }

  .footer-links {
    margin-left: 0;
  }
}

@media (max-width: 520px) {
  .nav {
    min-height: 62px;
  }

  .hero-actions,
  .section-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .button {
    width: 100%;
  }

  .product-hunt-badge {
    width: 100%;
  }

  .meeting-frame {
    margin-inline: -8px;
  }

  .meeting-frame img {
    aspect-ratio: 4 / 3;
    object-position: left top;
  }

  .answer-stage {
    margin-inline: -4px;
  }
}

@media (max-width: 360px) {
  .nav {
    gap: 8px;
  }

  .nav-links {
    gap: 0;
  }

  .nav-links a {
    min-width: 40px;
    min-height: 40px;
    padding-inline: 2px;
  }

  .language a {
    min-width: 38px;
    min-height: 38px;
  }
}

@media (prefers-reduced-motion: reduce) {
  html {
    scroll-behavior: auto;
  }

  *,
  *::before,
  *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
  }

  [data-reveal] {
    opacity: 1;
    transform: none;
  }

  .motion-video {
    display: none;
  }

  .motion-poster {
    display: block;
  }
}
`;

function wave(): string {
  const heights = [9, 18, 12, 25, 16, 29, 11, 22, 15, 30, 18, 25, 10, 20, 14, 27, 17, 23, 9, 19, 12, 26];
  return heights.map((height, index) => `<i style="--h:${height}px;--i:${index}" aria-hidden="true"></i>`).join('');
}

export function landingPage(lang: Locale = 'pt'): string {
  const site = publicSite('home', lang, config);
  const ptHome = publicSite('home', 'pt', config).canonicalUrl;
  const enHome = publicSite('home', 'en', config).canonicalUrl;
  const productHuntUrl =
    'https://www.producthunt.com/products/kassinao?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-kassinao';
  const pt = lang === 'pt';
  const T = (portuguese: string, english: string): string => (pt ? portuguese : english);
  const discordVideo = `/assets/discord-demo-${lang}-v2.webm`;
  const discordPoster = `/assets/discord-demo-${lang}-v2.png`;
  const meetingImage = `/assets/meeting-demo-${lang}.png`;
  const ogImage = `${config.publicUrl}/og-${lang}.png`;
  const title = T(
    'Kassinão: grave calls do Discord em faixas separadas',
    'Kassinão: record Discord calls in separate tracks',
  );
  const description = T(
    'Bot open source e self-hosted que grava uma faixa por conta que fala e guarda notas com timestamp. O operador decide se ativa transcrição, ata, perguntas e MCP.',
    'An open-source, self-hosted bot that records one track per speaking account and saves timestamped notes. The operator decides whether to enable transcripts, meeting notes, questions, and MCP.',
  );
  const language = `<div class="language" aria-label="${esc(T('Idioma', 'Language'))}">
    <a href="${ptHome}"${pt ? ' aria-current="page"' : ''} lang="pt-BR">PT</a>
    <a href="${enHome}"${pt ? '' : ' aria-current="page"'} lang="en">EN</a>
  </div>`;
  const commands = [
    {
      cmd: T('/gravar', '/record'),
      title: T('O bot publica o painel antes de capturar.', 'The bot posts the recording panel before capture.'),
      body: T(
        'Cada conta que falar recebe uma faixa própria ligada ao áudio enviado pelo Discord.',
        'Each account that speaks gets a separate track tied to the audio Discord sends.',
      ),
    },
    {
      cmd: T('/nota', '/note'),
      title: T('Uma observação fica presa ao segundo exato.', 'An observation stays attached to the exact second.'),
      body: T(
        'Marque por comando ou botão sem interromper a conversa.',
        'Mark it with a command or button without interrupting the conversation.',
      ),
    },
    {
      cmd: T('/parar', '/stop'),
      title: T('A reunião vira um artefato navegável.', 'The meeting becomes a navigable artifact.'),
      body: T(
        'Depois de encerrar, faixas, mix, notas e linha do tempo ficam no app privado.',
        'After it ends, tracks, mix, notes, and timeline events stay in the private app.',
      ),
    },
    {
      cmd: T('/perguntar', '/ask'),
      title: T('Com IA habilitada, a memória volta com a fonte.', 'With AI enabled, memory comes back with a source.'),
      body: T(
        'A resposta é privada, respeita o acesso da pessoa e abre a reunião usada como evidência.',
        'The private reply respects each person\u2019s access and opens the meeting used as evidence.',
      ),
    },
  ];
  return `<!doctype html>
<html lang="${site.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(site.canonicalUrl)}">
<link rel="alternate" hreflang="pt-BR" href="${esc(ptHome)}">
<link rel="alternate" hreflang="en" href="${esc(enHome)}">
<link rel="alternate" hreflang="x-default" href="${esc(enHome)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(ogImage)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(T('Kassinão no Discord', 'Kassinão inside Discord'))}">
<meta property="og:url" content="${esc(site.canonicalUrl)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Kassinão">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#111214">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png" sizes="180x180">
<style>${LANDING_CSS}</style>
<script${CSP_NONCE_ATTR} type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'Kassinão', applicationCategory: 'BusinessApplication', operatingSystem: 'Docker, Linux', description, url: site.canonicalUrl, softwareHelp: site.links.docs, codeRepository: site.links.github, license: 'https://www.gnu.org/licenses/agpl-3.0.html' }).replace(/</g, '\\u003c')}</script>
</head>
<body>
<a class="skip-link" href="#conteudo">${esc(T('Pular para o conteúdo', 'Skip to content'))}</a>
<header class="site-header">
  <nav class="wrap nav" aria-label="${esc(T('Navegação principal', 'Main navigation'))}">
    <a class="brand" href="${site.links.home}" aria-label="${esc(T('Kassinão, página inicial', 'Kassinão, home page'))}">
      <span class="brand-mark" aria-hidden="true">k/</span><span>Kassinão</span>
    </a>
    <div class="nav-links">
      <a href="${site.links.docs}">Docs</a>
      <a href="${site.links.mcp}" target="_blank" rel="noopener noreferrer">MCP</a>
      <a href="${site.links.github}" target="_blank" rel="noopener noreferrer">GitHub</a>
    </div>
    ${language}
  </nav>
</header>

<main id="conteudo">
  <section class="wrap hero" aria-labelledby="hero-title">
    <div class="hero-copy">
      <p class="eyebrow">${esc(T('Para equipes que trabalham no Discord', 'For teams that work on Discord'))}</p>
      <h1 id="hero-title">${esc(T('Sua call termina. As decisões não somem.', "Your call ends. The decisions don't disappear."))}</h1>
      <p class="hero-sub">${esc(T('O Kassinão grava cada conta que fala em uma faixa separada, guarda notas no momento da conversa e roda na infraestrutura que você controla. O operador ativa separadamente transcrição, ata, perguntas e MCP.', 'Kassinão records each speaking account in a separate track, saves notes at the moment they happen, and runs on infrastructure you control. The operator enables transcripts, meeting notes, questions, and MCP separately.'))}</p>
      <div class="hero-actions">
        <a class="button button-primary" href="${site.links.demo}">${esc(T('Ver uma reunião pronta', 'See a finished meeting'))}</a>
        <a class="button button-secondary" href="${site.links.docs}">${esc(T('Fazer self-host do Kassinão', 'Self-host Kassinão'))}</a>
      </div>
      <p class="hero-note">${esc(T('Demo pública com dados fictícios e IA habilitada, sem login. Para avaliar localmente, basta Docker e um app Discord de teste; produção pública exige HTTPS, domínio e app próprios.', 'Public demo with fictional data and AI enabled, with no login. Local evaluation needs Docker and a test Discord app; public production requires HTTPS, a domain, and its own app.'))}</p>
      <a class="product-hunt-badge" href="${esc(productHuntUrl)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(T('Abrir o lançamento do Kassinão no Product Hunt', 'Open the Kassinão launch on Product Hunt'))}">
        <img src="/assets/producthunt.svg" width="36" height="36" alt="" aria-hidden="true">
        <span class="product-hunt-copy"><span>${esc(T('Lançamento no Product Hunt', 'Live on Product Hunt'))}</span><strong>${esc(T('Apoiar o Kassinão', 'Support Kassinão'))}</strong></span>
      </a>
    </div>
    <div class="hero-proof">
      <div class="media-frame">
        <video class="motion-video" autoplay muted loop playsinline preload="metadata" poster="${discordPoster}">
          <source src="${discordVideo}" type="video/webm">
        </video>
        <img class="motion-poster" src="${discordPoster}" width="1270" height="760" alt="${esc(T('Fluxo do Kassinão dentro do Discord', 'Kassinão workflow inside Discord'))}">
      </div>
      <p class="media-caption">${esc(T('Exemplo fictício de uma instância com os recursos opcionais de IA ativados.', 'Fictional example of an instance with optional AI features enabled.'))}</p>
    </div>
  </section>

  <div class="proof-line">
    <div class="wrap proof-items" aria-label="${esc(T('Resumo do produto', 'Product summary'))}">
      <div class="proof-item"><strong>${esc(T('Feito para Discord', 'Built for Discord'))}</strong><span>${esc(T('onde a call já acontece', 'where the call already happens'))}</span></div>
      <div class="proof-item"><strong>${esc(T('1 conta falando = 1 faixa', '1 speaking account = 1 track'))}</strong><span>${esc(T('origem da voz preservada', 'voice origin preserved'))}</span></div>
      <div class="proof-item"><strong>${esc(T('IA e MCP opcionais', 'Optional AI and MCP'))}</strong><span>${esc(T('você escolhe se e como ativar', 'you choose whether and how to enable them'))}</span></div>
      <div class="proof-item"><strong>Self-hosted</strong><span>${esc(T('dados sob seu controle', 'data under your control'))}</span></div>
    </div>
  </div>

  <section class="section" aria-labelledby="identity-title">
    <div class="wrap">
      <div class="section-head" data-reveal>
        <h2 id="identity-title">${esc(T('A voz já chega ligada a uma conta.', 'The voice stream already has an account.'))}</h2>
        <p>${esc(T('Quando alguém fala, o Discord envia o fluxo daquela conta separadamente. O Kassinão grava esse vínculo na faixa e, se a transcrição estiver habilitada, leva o mesmo vínculo para o texto.', 'When someone speaks, Discord sends that account\u2019s stream separately. Kassinão preserves that link in the track and, if transcription is enabled, carries it into the text.'))}</p>
      </div>
      <div class="identity-stage" data-reveal>
        <div class="identity-axis" aria-hidden="true"><span>${esc(T('Conta que falou', 'Speaking account'))}</span><span>${esc(T('Faixa recebida', 'Incoming track'))}</span><span>${esc(T('Linha opcional da transcrição', 'Optional transcript line'))}</span></div>
        ${[
          [
            'Luna',
            T('produto', 'product'),
            T('A beta abre para a comunidade na terça.', 'The beta opens to the community on Tuesday.'),
          ],
          [
            T('Íris', 'Iris'),
            T('comunidade', 'community'),
            T('Vou publicar a lista de convites até sexta.', 'I will publish the invite list by Friday.'),
          ],
          [
            'Noah',
            T('engenharia', 'engineering'),
            T('O acesso antecipado começa com 20 pessoas.', 'Early access starts with 20 people.'),
          ],
        ]
          .map(
            ([name, role, quote], index) => `<div class="identity-row">
          <div class="person"><span class="person-avatar">${esc(name.slice(0, 1))}</span><span><strong>${esc(name)}</strong><span>${esc(role)}</span></span></div>
          <div class="track"><code>track_0${index + 1}</code><span class="wave">${wave()}</span></div>
          <div class="transcript-line"><time>${['00:14', '00:22', '00:31'][index]}</time><strong>${esc(name)}:</strong> ${esc(quote)}</div>
        </div>`,
          )
          .join('')}
      </div>
    </div>
  </section>

  <section class="section" aria-labelledby="discord-title">
    <div class="wrap discord-story">
      <div class="story-copy" data-reveal>
        <h2 id="discord-title">${esc(T('Tudo acontece onde a call já está.', 'Everything happens where the call already lives.'))}</h2>
        <p>${esc(T('Comece, marque e encerre sem arrastar o time para outra ferramenta. Se a IA estiver habilitada, consulte o conteúdo depois pelo mesmo Discord.', 'Start, mark, and stop without dragging the team into another tool. If AI is enabled, query the content later from the same Discord server.'))}</p>
      </div>
      <div class="command-journey" data-reveal>
        ${commands.map((step) => `<article class="command-step"><code>${esc(step.cmd)}</code><div><strong>${esc(step.title)}</strong><span>${esc(step.body)}</span></div></article>`).join('')}
      </div>
    </div>
  </section>

  <section class="section meeting-section" aria-labelledby="meeting-title">
    <div class="wrap">
      <div class="section-head" data-reveal>
        <p class="eyebrow">${esc(T('Demo pública', 'Public demo'))}</p>
        <h2 id="meeting-title">${esc(T('Abra uma reunião pronta.', 'Open a finished meeting.'))}</h2>
        <p>${esc(T('Dados fictícios, interface real e IA habilitada: áudio de amostra, transcrição, ata, decisões, tarefas, notas e linha do tempo.', 'Fictional data, real interface, and AI enabled: sample audio, transcript, meeting notes, decisions, tasks, notes, and timeline.'))}</p>
      </div>
      <div class="meeting-frame" data-reveal>
        <img src="${meetingImage}" width="1255" height="751" loading="lazy" alt="${esc(T('Página pública de uma reunião fictícia processada pelo Kassinão', 'Public page for a fictional meeting processed by Kassinão'))}">
        <div class="meeting-foot">
          <p>${esc(T('A call da demo está em inglês e a interface está em português. O idioma da interface muda; o conteúdo original da reunião não é traduzido silenciosamente.', 'The demo call and interface are in English. Switching the interface never silently translates the original meeting content.'))}</p>
          <a class="button button-primary" href="${site.links.demo}">${esc(T('Explorar a reunião', 'Explore the meeting'))}</a>
        </div>
      </div>
    </div>
  </section>

  <section class="section" aria-labelledby="answers-title">
    <div class="wrap">
      <div class="section-head" data-reveal>
        <h2 id="answers-title">${esc(T('Pergunte depois. Receba a fonte.', 'Ask later. Get the source.'))}</h2>
        <p>${esc(T('Quando o operador habilita transcrição, perguntas e MCP, o Discord responde só para quem perguntou e o cliente MCP recebe apenas dados das reuniões que essa pessoa pode abrir.', 'When the operator enables transcription, questions, and MCP, Discord replies only to the person who asked, and the MCP client receives data only from meetings that person can open.'))}</p>
      </div>
      <div class="answer-stage" data-reveal>
        <div class="discord-answer">
          <div class="chat-line"><span class="chat-avatar">L</span><div><div class="chat-meta">Luna <span>11:08</span><span class="ephemeral">${esc(T('só você', 'only you'))}</span></div><p class="chat-copy"><span class="slash-command">${esc(T('/perguntar', '/ask'))}</span> ${esc(T('quem publica a lista da beta?', 'who publishes the beta invite list?'))}</p></div></div>
          <div class="chat-line"><span class="chat-avatar bot">k/</span><div><div class="chat-meta">Kassinão <span>APP</span><span class="ephemeral">${esc(T('resposta efêmera', 'ephemeral reply'))}</span></div><div class="source-answer">${esc(T('Íris vai publicar a lista de convites até sexta.', 'Iris will publish the invite list by Friday.'))} <a href="${site.links.demo}">${esc(T('Fonte: 00:14', 'Source: 00:14'))}</a></div></div></div>
        </div>
        <div class="mcp-window">
          <div class="window-head"><span>MCP · kassinao</span></div>
          <div class="mcp-body">
            <div class="mcp-query">${esc(T('Quais ações ficaram pendentes esta semana?', 'What action items are still pending this week?'))}</div>
            <div class="mcp-response">${esc(T('4 ações em 2 reuniões. Íris e Noah têm prazos até sexta.', '4 action items across 2 meetings. Iris and Noah have deadlines by Friday.'))}</div>
            <p class="mcp-note">${esc(T('Somente leitura, individual e revogável.', 'Read-only, individual, and revocable.'))}</p>
            <a class="button button-secondary" href="${site.links.mcp}">${esc(T('Entender o MCP', 'Understand MCP'))}</a>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section class="section" aria-labelledby="trust-title">
    <div class="wrap trust-layout">
      <div class="trust-intro" data-reveal>
        <p class="eyebrow">${esc(T('Controle', 'Control'))}</p>
        <h2 id="trust-title">${esc(T('Sua instância. Seu histórico. Suas regras.', 'Your instance. Your history. Your rules.'))}</h2>
        <p>${esc(T('A infraestrutura é sua e a política de acesso continua ancorada no Discord.', 'You own the infrastructure, and access policy stays anchored to Discord.'))}</p>
      </div>
      <div class="trust-list" data-reveal>
        <article class="trust-row"><strong>${esc(T('Self-hosted', 'Self-hosted'))}</strong><p>${esc(T('Não existe serviço hospedado nem cadastro público. Você executa seu próprio bot e app privado na sua VPS.', 'There is no hosted service or public signup. You run your own bot and private app on your VPS.'))}</p></article>
        <article class="trust-row"><strong>${esc(T('Acesso revalidado', 'Revalidated access'))}</strong><p>${esc(T('O app revalida o vínculo com o Discord e aplica a permissão de cada reunião. Perguntas e MCP seguem a mesma fronteira quando habilitados.', 'The app revalidates Discord membership and applies each meeting\u2019s permissions. Questions and MCP follow the same boundary when enabled.'))}</p></article>
        <article class="trust-row"><strong>${esc(T('Retenção configurável', 'Configurable retention'))}</strong><p>${esc(T('Áudio e texto podem ter ciclos diferentes. Você pode liberar as faixas pesadas e manter notas e conteúdo já gerado.', 'Audio and text can have different lifecycles. You can release heavy tracks while keeping notes and content already generated.'))}</p></article>
        <article class="trust-row"><strong>${esc(T('IA é opt-in', 'AI is opt-in'))}</strong><p>${esc(T('Gravação, faixas, mix e notas funcionam sem provider. Para IA local, crie uma imagem customizada com o transcritor; com provider externo, o áudio ou texto necessário sai da VPS conforme a configuração.', 'Recording, tracks, mix, and notes work without a provider. For local AI, build a custom image with the transcriber; with an external provider, the required audio or text leaves the VPS according to your configuration.'))}</p></article>
      </div>
    </div>
  </section>

  <section class="wrap final-section">
    <div class="final-cta" data-reveal>
      <h2>${esc(T('Rode na sua infraestrutura. Mantenha o controle.', 'Run it on your infrastructure. Keep control.'))}</h2>
      <p>${esc(T('O Kassinão é open source. Crie seu app do Discord, use seu próprio domínio e comece pela gravação. Depois, ative somente as integrações de IA e MCP que fizerem sentido para a sua operação.', 'Kassinão is open source. Create your Discord app, use your own domain, and start with recording. Then enable only the AI and MCP integrations that fit your operation.'))}</p>
      <div class="section-actions">
        <a class="button button-primary" href="${site.links.docs}">${esc(T('Abrir guia de instalação', 'Open installation guide'))}</a>
        <a class="button button-secondary" href="${site.links.github}" target="_blank" rel="noopener noreferrer">${esc(T('Auditar o código', 'Audit the code'))}</a>
      </div>
      <p class="launch-line">${esc(T('AGPL-3.0 · Docker · HTTPS · app do Discord · infraestrutura e provedores podem ter custo', 'AGPL-3.0 · Docker · HTTPS · Discord app · infrastructure and providers may have costs'))}</p>
    </div>
  </section>
</main>

<footer class="site-footer">
  <div class="wrap footer-inner">
    <div class="footer-brand"><span class="brand-mark" aria-hidden="true">k/</span><span>Kassinão · ${esc(T('feito para o Discord', 'built for Discord'))}</span></div>
    <div class="footer-links">
      <a href="${site.links.docs}">Docs</a>
      <a href="${site.links.mcp}">MCP</a>
      <a href="${site.links.github}" target="_blank" rel="noopener noreferrer">GitHub</a>
    </div>
    ${language}
  </div>
</footer>

<script${CSP_NONCE_ATTR}>(function(){
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-reveal]'));
  if (reduced || !('IntersectionObserver' in window)) {
    nodes.forEach(function(node){ node.classList.add('is-visible'); });
  } else {
    var observer = new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { threshold: .14 });
    nodes.forEach(function(node){ observer.observe(node); });
  }
  if (reduced) {
    var video = document.querySelector('.motion-video');
    if (video) video.pause();
  }
})();</script>
</body>
</html>`;
}
