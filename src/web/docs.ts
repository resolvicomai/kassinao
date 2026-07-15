import { config } from '../config';
import { CSP_NONCE_ATTR } from './csp';
import type { Locale } from '../i18n';
import { PUBLIC_LINKS, publicSite } from './site';

type DocsLang = Locale;

interface LocalText {
  pt: string;
  en: string;
}

interface CommandDoc {
  pt: string;
  en: string;
  description: LocalText;
  access: LocalText;
}

interface EnvDoc {
  name: string;
  fallback: string | LocalText;
  description: LocalText;
}

interface EnvGroup {
  title: LocalText;
  summary: LocalText;
  items: EnvDoc[];
}

const NPM_URL = PUBLIC_LINKS.mcp;

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function text(lang: DocsLang, value: LocalText): string {
  return value[lang];
}

function localValue(lang: DocsLang, value: string | LocalText): string {
  return typeof value === 'string' ? value : text(lang, value);
}

function codeBlock(label: string, value: string, copyLabel: string): string {
  return `<div class="code-block">
    <div class="code-head"><span>${esc(label)}</span><div class="copy-controls"><span class="copy-status" data-copy-status role="status" aria-live="polite" aria-atomic="true"></span><button type="button" data-copy>${esc(copyLabel)}</button></div></div>
    <pre tabindex="0"><code>${esc(value)}</code></pre>
  </div>`;
}

const DOCS_CSS = `
@font-face {
  font-family: 'Space Grotesk';
  src: url('/assets/space-grotesk.woff2') format('woff2');
  font-style: normal;
  font-weight: 300 700;
  font-display: swap;
}

:root {
  color-scheme: dark light;
  --bg: #202024;
  --surface: #202024;
  --surface-raised: #28282c;
  --surface-soft: #19191e;
  --text: #e1e1e5;
  --muted: #a1a1a5;
  --subtle: #727377;
  --line: #36373e;
  --line-strong: #525357;
  --accent: #5865f2;
  --accent-strong: #798df9;
  --accent-ink: #ffffff;
  --danger: #ff8a8a;
  --code: #0c0d11;
  --shadow: rgba(5, 6, 9, 0.3);
  --radius: 14px;
  --radius-control: 9px;
  --sidebar: 292px;
  --topbar: 68px;
  --font: 'Space Grotesk', 'Avenir Next', 'Segoe UI', sans-serif;
  --mono: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
}

@media (prefers-color-scheme: light) {
  :root {
    --bg: #ffffff;
    --surface: #ffffff;
    --surface-raised: #ffffff;
    --surface-soft: #f0f1f5;
    --text: #19191e;
    --muted: #525357;
    --subtle: #727377;
    --line: #f0f1f5;
    --line-strong: #d0d1d5;
    --accent: #5865f2;
    --accent-strong: #4752c4;
    --accent-ink: #ffffff;
    --danger: #a42f3c;
    --code: #0c0d11;
    --shadow: rgba(41, 45, 64, 0.12);
  }
}

:root[data-theme='dark'] {
  color-scheme: dark;
  --bg: #202024;
  --surface: #202024;
  --surface-raised: #28282c;
  --surface-soft: #19191e;
  --text: #e1e1e5;
  --muted: #a1a1a5;
  --subtle: #727377;
  --line: #36373e;
  --line-strong: #525357;
  --accent: #5865f2;
  --accent-strong: #798df9;
  --accent-ink: #ffffff;
  --danger: #ff8a8a;
  --code: #0c0d11;
  --shadow: rgba(5, 6, 9, 0.3);
}

:root[data-theme='light'] {
  color-scheme: light;
  --bg: #ffffff;
  --surface: #ffffff;
  --surface-raised: #ffffff;
  --surface-soft: #f0f1f5;
  --text: #19191e;
  --muted: #525357;
  --subtle: #727377;
  --line: #f0f1f5;
  --line-strong: #d0d1d5;
  --accent: #5865f2;
  --accent-strong: #4752c4;
  --accent-ink: #ffffff;
  --danger: #a42f3c;
  --code: #0c0d11;
  --shadow: rgba(41, 45, 64, 0.12);
}

* { box-sizing: border-box; }

html {
  scroll-behavior: smooth;
  scroll-padding-top: calc(var(--topbar) + 28px);
  background: var(--bg);
}

body {
  margin: 0;
  min-width: 300px;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 16px;
  line-height: 1.62;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}

body.nav-open { overflow: hidden; }

button,
input { font: inherit; }

a { color: var(--accent-strong); }

a:hover { text-decoration-thickness: 2px; }

a:focus-visible,
button:focus-visible,
input:focus-visible,
summary:focus-visible,
pre:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 3px;
}

.skip-link {
  position: fixed;
  top: 8px;
  left: 8px;
  z-index: 60;
  padding: 10px 14px;
  border-radius: var(--radius-control);
  background: var(--accent);
  color: var(--accent-ink);
  font-weight: 700;
  transform: translateY(-160%);
}

.skip-link:focus { transform: translateY(0); }

.topbar {
  position: sticky;
  top: 0;
  z-index: 40;
  min-height: var(--topbar);
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
}

.topbar-inner {
  min-height: var(--topbar);
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 22px;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: var(--text);
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.025em;
  text-decoration: none;
  white-space: nowrap;
}

.brand-mark {
  width: 34px;
  height: 34px;
  display: inline-grid;
  place-items: center;
  border-radius: 9px;
  background: var(--accent);
  color: var(--accent-ink);
  font-family: var(--mono);
  font-size: 16px;
  font-weight: 800;
  letter-spacing: -0.1em;
}

.brand-context {
  color: var(--muted);
  font-weight: 500;
}

.topbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.control,
.primary-link {
  min-height: 42px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 13px;
  border-radius: var(--radius-control);
  border: 1px solid var(--line-strong);
  background: var(--surface-raised);
  color: var(--text);
  font-weight: 650;
  line-height: 1;
  text-decoration: none;
  cursor: pointer;
}

.control:hover { border-color: var(--accent); }

.control:active,
.primary-link:active,
.copy-button:active { transform: translateY(1px); }

.primary-link {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-ink);
}

.mobile-menu { display: none; }

.language {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  background: var(--surface-soft);
}

.language a {
  min-width: 38px;
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  color: var(--muted);
  font-size: 13px;
  font-weight: 700;
  text-decoration: none;
}

.language a[aria-current='page'] {
  background: var(--surface-raised);
  color: var(--text);
  box-shadow: 0 2px 8px var(--shadow);
}

.docs-shell { min-height: calc(100dvh - var(--topbar)); }

.sidebar {
  position: fixed;
  top: var(--topbar);
  bottom: 0;
  left: 0;
  z-index: 30;
  width: var(--sidebar);
  overflow-y: auto;
  border-right: 1px solid var(--line);
  background: var(--surface);
  padding: 22px 18px 28px;
}

.search-block {
  display: grid;
  gap: 8px;
  margin-bottom: 18px;
}

.search-block label {
  color: var(--muted);
  font-size: 13px;
  font-weight: 650;
}

.search-input {
  width: 100%;
  min-height: 44px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  background: var(--bg);
  color: var(--text);
  padding: 0 12px;
}

.search-input::placeholder { color: var(--subtle); }

.search-input:focus { border-color: var(--accent); }

.search-status {
  min-height: 20px;
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}

.side-nav {
  display: grid;
  gap: 3px;
}

.side-nav a {
  min-height: 40px;
  display: flex;
  align-items: center;
  padding: 8px 10px;
  border-left: 3px solid transparent;
  border-radius: 0 var(--radius-control) var(--radius-control) 0;
  color: var(--muted);
  font-size: 14px;
  font-weight: 550;
  line-height: 1.25;
  text-decoration: none;
}

.side-nav a:hover {
  background: var(--surface-raised);
  color: var(--text);
}

.side-nav a[aria-current='location'] {
  border-left-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 13%, var(--surface-raised));
  color: var(--text);
  font-weight: 700;
}

.side-note {
  margin: 22px 0 0;
  padding-top: 18px;
  border-top: 1px solid var(--line);
  color: var(--subtle);
  font-size: 12px;
}

.nav-backdrop {
  position: fixed;
  inset: var(--topbar) 0 0;
  z-index: 20;
  display: none;
  border: 0;
  background: rgba(12, 13, 17, 0.68);
}

.docs-main {
  width: min(100% - var(--sidebar), 1180px);
  min-width: 0;
  margin-left: var(--sidebar);
  padding: 52px clamp(32px, 6vw, 88px) 96px;
}

.docs-main-inner {
  width: 100%;
  min-width: 0;
  max-width: 900px;
}

.docs-hero {
  padding-bottom: 38px;
  border-bottom: 1px solid var(--line);
}

.docs-hero h1 {
  max-width: 16ch;
  margin: 0;
  font-size: clamp(38px, 5vw, 66px);
  line-height: 0.98;
  letter-spacing: -0.055em;
}

.docs-hero p {
  max-width: 680px;
  margin: 22px 0 0;
  color: var(--muted);
  font-size: clamp(17px, 2vw, 20px);
  line-height: 1.5;
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 24px;
}

.doc-section {
  min-width: 0;
  padding: 64px 0 8px;
}

.doc-section[hidden] { display: none; }

.section-head {
  max-width: 720px;
  margin-bottom: 26px;
}

.section-head h2 {
  margin: 0;
  font-size: clamp(28px, 4vw, 42px);
  line-height: 1.08;
  letter-spacing: -0.04em;
}

.section-head p {
  margin: 12px 0 0;
  color: var(--muted);
  font-size: 17px;
}

h3 {
  margin: 34px 0 12px;
  font-size: 20px;
  line-height: 1.25;
  letter-spacing: -0.02em;
}

p { max-width: 72ch; }

.quick-layout {
  display: grid;
  grid-template-columns: minmax(0, 0.82fr) minmax(0, 1.18fr);
  gap: 24px;
  align-items: start;
}

.quick-layout > * { min-width: 0; }

.quick-list {
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: quick;
}

.quick-list li {
  position: relative;
  padding: 0 0 22px 46px;
  counter-increment: quick;
}

.quick-list li::before {
  content: counter(quick);
  position: absolute;
  top: 1px;
  left: 0;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: var(--accent);
  color: var(--accent-ink);
  font-size: 13px;
  font-weight: 800;
}

.quick-list strong { display: block; }

.quick-list span {
  display: block;
  margin-top: 3px;
  color: var(--muted);
  font-size: 14px;
}

.code-stack { display: grid; gap: 14px; }

.code-block {
  width: 100%;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius);
  background: var(--code);
  box-shadow: 0 18px 40px var(--shadow);
}

.code-head {
  min-height: 43px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 10px 0 15px;
  border-bottom: 1px solid var(--line-strong);
  color: #d0d1d5;
  font-size: 12px;
  font-weight: 700;
}

.code-head button {
  min-height: 31px;
  padding: 0 10px;
  border: 1px solid #525357;
  border-radius: 6px;
  background: #28282c;
  color: #f0f1f5;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}

.code-head button:disabled {
  cursor: wait;
  opacity: 0.72;
}

.copy-controls {
  min-width: 0;
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 9px;
}

.copy-status {
  color: #b8bac1;
  font-size: 11px;
  font-weight: 650;
  text-align: right;
}

.copy-status[data-state='error'] { color: #ffb1b1; }

pre {
  width: 100%;
  max-width: 100%;
  margin: 0;
  overflow: auto;
  padding: 18px;
  color: #e1e1e5;
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.65;
  tab-size: 2;
}

code {
  font-family: var(--mono);
  font-size: 0.92em;
}

:not(pre) > code {
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface-soft);
  color: var(--text);
  padding: 2px 6px;
  overflow-wrap: anywhere;
}

.callout {
  margin: 22px 0;
  padding: 18px 20px;
  border-left: 4px solid var(--accent);
  border-radius: 0 var(--radius) var(--radius) 0;
  background: color-mix(in srgb, var(--accent) 9%, var(--surface));
}

.callout strong { display: block; margin-bottom: 4px; }

.callout p { margin: 0; color: var(--muted); }

.callout.danger { border-left-color: var(--danger); }

.requirement-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(220px, 0.75fr);
  gap: 18px;
}

.requirement-primary,
.requirement-secondary {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  padding: 24px;
}

.requirement-primary { border-color: var(--accent); }

.requirement-grid h3 { margin-top: 0; }

.check-list {
  display: grid;
  gap: 12px;
  margin: 18px 0 0;
  padding: 0;
  list-style: none;
}

.check-list li {
  position: relative;
  padding-left: 24px;
  color: var(--muted);
}

.check-list li::before {
  content: '';
  position: absolute;
  top: 0.62em;
  left: 1px;
  width: 9px;
  height: 9px;
  border: 2px solid var(--accent);
  border-radius: 3px;
  transform: translateY(-50%);
}

.install-steps {
  display: grid;
  gap: 18px;
}

.install-step {
  width: 100%;
  min-width: 0;
  display: grid;
  grid-template-columns: 170px minmax(0, 1fr);
  gap: 24px;
  padding: 22px 0;
  border-top: 1px solid var(--line);
}

.install-step > * { min-width: 0; }

.install-step:first-child { border-top: 0; }

.install-step h3 { margin: 0; }

.install-step p { margin: 0 0 12px; color: var(--muted); }

.env-groups { display: grid; gap: 12px; }

.env-group {
  overflow: clip;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}

.env-group[open] { border-color: var(--line-strong); }

.env-group summary {
  min-height: 68px;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 18px;
  cursor: pointer;
  list-style: none;
}

.env-group summary::-webkit-details-marker { display: none; }

.env-group summary::after {
  content: '+';
  margin-left: auto;
  color: var(--accent-strong);
  font-size: 24px;
  line-height: 1;
}

.env-group[open] summary::after { content: '-'; }

.env-title { display: grid; gap: 2px; }

.env-title strong { color: var(--text); }

.env-title span { color: var(--muted); font-size: 13px; }

.env-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px;
  margin: 0;
  border-top: 1px solid var(--line);
  background: var(--line);
}

.env-item {
  min-width: 0;
  background: var(--surface-raised);
  padding: 17px;
}

.env-item dt {
  color: var(--accent-strong);
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 750;
  overflow-wrap: anywhere;
}

.env-default {
  display: block;
  margin-bottom: 8px;
  color: var(--muted);
  font-size: 12px;
}

.env-description { display: block; }

.env-item dd {
  margin: 10px 0 0;
  color: var(--muted);
  font-size: 13px;
}

.command-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.command-card {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  padding: 18px;
}

.command-card code {
  display: inline-block;
  color: var(--accent-strong);
  font-size: 14px;
  font-weight: 750;
  overflow-wrap: anywhere;
}

.command-card p {
  margin: 12px 0;
  color: var(--muted);
  font-size: 14px;
}

.command-meta {
  padding-top: 11px;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 12px;
}

.flow {
  position: relative;
  display: grid;
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.flow li {
  position: relative;
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  gap: 16px;
  padding-bottom: 28px;
}

.flow li::after {
  content: '';
  position: absolute;
  top: 38px;
  bottom: 0;
  left: 21px;
  width: 2px;
  background: var(--line);
}

.flow li:last-child::after { display: none; }

.flow-number {
  position: relative;
  z-index: 1;
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border: 1px solid var(--accent);
  border-radius: 12px;
  background: var(--surface-raised);
  color: var(--accent-strong);
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 800;
}

.flow h3 { margin: 2px 0 6px; }

.flow p { margin: 0; color: var(--muted); }

.provider-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(250px, 0.72fr);
  gap: 18px;
  align-items: start;
}

.provider-list {
  min-width: 0;
  display: grid;
  gap: 10px;
}

.provider {
  min-width: 0;
  display: grid;
  grid-template-columns: 132px minmax(0, 1fr);
  gap: 16px;
  padding: 16px;
  border-radius: var(--radius);
  background: var(--surface);
}

.provider strong { color: var(--text); }

.provider span {
  min-width: 0;
  color: var(--muted);
  font-size: 14px;
  overflow-wrap: anywhere;
}

.pipeline-note {
  min-width: 0;
  position: sticky;
  top: calc(var(--topbar) + 24px);
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--accent) 10%, var(--surface));
  padding: 22px;
}

.pipeline-note h3 { margin-top: 0; }

.pipeline-note p {
  min-width: 0;
  color: var(--muted);
  overflow-wrap: anywhere;
}

.privacy-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(250px, 0.62fr);
  gap: 28px;
}

.privacy-rules {
  display: grid;
  gap: 18px;
}

.privacy-rule {
  padding-bottom: 18px;
  border-bottom: 1px solid var(--line);
}

.privacy-rule:last-child { border-bottom: 0; }

.privacy-rule h3 { margin: 0 0 6px; }

.privacy-rule p { margin: 0; color: var(--muted); }

.permission-box {
  align-self: start;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius);
  background: var(--surface);
  padding: 22px;
}

.permission-box h3 { margin-top: 0; }

.permission-box ul {
  margin: 0;
  padding-left: 20px;
  color: var(--muted);
}

.permission-box li + li { margin-top: 9px; }

.mcp-tools {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-top: 20px;
}

.mcp-tool {
  min-width: 0;
  border-left: 3px solid var(--accent);
  background: var(--surface);
  padding: 14px 16px;
}

.mcp-tool code { color: var(--accent-strong); font-weight: 750; }

.mcp-tool p { margin: 5px 0 0; color: var(--muted); font-size: 13px; }

.troubleshooting { display: grid; gap: 10px; }

.trouble {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}

.trouble summary {
  min-height: 56px;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 16px;
  color: var(--text);
  font-weight: 700;
  cursor: pointer;
  list-style: none;
}

.trouble summary::-webkit-details-marker { display: none; }

.trouble summary::after {
  content: '+';
  margin-left: auto;
  color: var(--accent-strong);
  font-size: 22px;
}

.trouble[open] summary::after { content: '-'; }

.trouble-body {
  padding: 0 18px 18px;
  color: var(--muted);
}

.trouble-body p:first-child { margin-top: 0; }

.link-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.resource-link {
  min-height: 92px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  text-decoration: none;
}

.resource-link:hover { border-color: var(--accent); }

.resource-link strong { color: var(--text); }

.resource-link span { margin-top: 3px; color: var(--muted); font-size: 13px; }

.no-results {
  margin-top: 28px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius);
  background: var(--surface);
  padding: 24px;
}

.no-results[hidden] { display: none; }

.no-results h2 { margin: 0 0 6px; font-size: 24px; }

.no-results p { margin: 0; color: var(--muted); }

.docs-footer {
  margin-top: 72px;
  padding-top: 26px;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 13px;
}

@media (max-width: 980px) {
  .mobile-menu { display: inline-flex; }

  .sidebar {
    top: var(--topbar);
    width: min(88vw, 330px);
    transform: translateX(-105%);
    box-shadow: 18px 0 48px var(--shadow);
    transition: transform 180ms ease;
  }

  body.nav-open .sidebar { transform: translateX(0); }

  body.nav-open .nav-backdrop { display: block; }

  .docs-main {
    width: 100%;
    margin-left: 0;
  }
}

@media (max-width: 720px) {
  :root { --topbar: 62px; }

  .topbar-inner { padding: 0 12px; gap: 8px; }

  .brand-context,
  .topbar-actions .primary-link { display: none; }

  .control { padding-inline: 11px; }

  .docs-main { padding: 34px 18px 72px; }

  .docs-hero h1 { font-size: clamp(36px, 12vw, 52px); }

  .quick-layout,
  .requirement-grid,
  .privacy-layout {
    grid-template-columns: 1fr;
  }

  .provider-layout { grid-template-columns: minmax(0, 1fr); }

  .install-step { grid-template-columns: 1fr; gap: 8px; }

  .env-list,
  .command-grid,
  .mcp-tools,
  .link-grid { grid-template-columns: 1fr; }

  .provider { grid-template-columns: minmax(0, 1fr); gap: 4px; }

  .pipeline-note { position: static; }

  .hero-actions a { flex: 1 1 150px; }
}

@media (max-width: 420px) {
  .brand span:first-of-type { display: none; }
  .language a { min-width: 34px; }
}

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

@media print {
  .topbar,
  .sidebar,
  .nav-backdrop,
  .code-head button { display: none !important; }
  .docs-main { width: 100%; margin: 0; padding: 0; }
  .doc-section { break-inside: avoid; padding-top: 34px; }
  .env-group > * { display: block; }
}
`;

function docsScript(lang: DocsLang): string {
  const messages =
    lang === 'pt'
      ? {
          copied: 'Copiado',
          copying: 'Copiando...',
          copyFailed: 'Falha ao copiar',
          copy: 'Copiar',
          result: 'seção encontrada',
          results: 'seções encontradas',
          noResults: 'Nenhuma seção encontrada',
        }
      : {
          copied: 'Copied',
          copying: 'Copying...',
          copyFailed: 'Copy failed',
          copy: 'Copy',
          result: 'section found',
          results: 'sections found',
          noResults: 'No sections found',
        };

  return `<script${CSP_NONCE_ATTR}>(function(){
    var body = document.body;
    var menuButton = document.getElementById('mobile-menu');
    var backdrop = document.getElementById('nav-backdrop');
    var sidebar = document.getElementById('docs-sidebar');
    var search = document.getElementById('docs-search');
    var status = document.getElementById('search-status');
    var noResults = document.getElementById('no-results');
    var links = Array.prototype.slice.call(document.querySelectorAll('[data-nav-link]'));
    var sections = Array.prototype.slice.call(document.querySelectorAll('[data-doc-section]'));
    var themeButton = document.getElementById('theme-toggle');

    function syncSidebar(open) {
      var hidden = window.innerWidth <= 980 && !open;
      if (hidden) {
        sidebar.setAttribute('aria-hidden', 'true');
        sidebar.setAttribute('inert', '');
      } else {
        sidebar.removeAttribute('aria-hidden');
        sidebar.removeAttribute('inert');
      }
    }

    function setMenu(open) {
      var wasOpen = body.classList.contains('nav-open');
      body.classList.toggle('nav-open', open);
      menuButton.setAttribute('aria-expanded', String(open));
      syncSidebar(open);
      if (open) search.focus();
      else if (wasOpen && window.innerWidth <= 980) {
        // O clique no backdrop ainda pode devolver o foco ao próprio botão que
        // acabou de ficar oculto. Espera o evento terminar antes de restaurar.
        window.setTimeout(function(){ menuButton.focus(); }, 0);
      }
    }

    function syncViewport() {
      if (window.innerWidth > 980) {
        body.classList.remove('nav-open');
        menuButton.setAttribute('aria-expanded', 'false');
      }
      syncSidebar(body.classList.contains('nav-open'));
    }

    menuButton.addEventListener('click', function(){ setMenu(!body.classList.contains('nav-open')); });
    backdrop.addEventListener('click', function(){ setMenu(false); });
    document.addEventListener('keydown', function(event){ if (event.key === 'Escape') setMenu(false); });
    window.addEventListener('resize', syncViewport);
    links.forEach(function(link){ link.addEventListener('click', function(){ setMenu(false); }); });

    function fold(value) {
      return value.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '');
    }

    function filterDocs() {
      var query = fold(search.value.trim());
      var visible = 0;
      sections.forEach(function(section){
        var match = !query || fold(section.textContent || '').indexOf(query) !== -1 || fold(section.getAttribute('data-keywords') || '').indexOf(query) !== -1;
        section.hidden = !match;
        if (match) visible += 1;
      });
      links.forEach(function(link){
        var target = document.querySelector(link.getAttribute('href'));
        link.hidden = !!target && target.hidden;
      });
      noResults.hidden = visible !== 0;
      status.textContent = query ? (visible === 0 ? '${messages.noResults}' : visible + ' ' + (visible === 1 ? '${messages.result}' : '${messages.results}')) : '';
    }

    search.addEventListener('input', filterDocs);

    function setActive(id) {
      links.forEach(function(link){
        if (link.getAttribute('href') === '#' + id) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      });
    }

    if ('IntersectionObserver' in window) {
      var observer = new IntersectionObserver(function(entries){
        var current = entries.filter(function(entry){ return entry.isIntersecting; }).sort(function(a,b){ return b.intersectionRatio - a.intersectionRatio; })[0];
        if (current) setActive(current.target.id);
      }, { rootMargin: '-18% 0px -68% 0px', threshold: [0, 0.2, 0.6] });
      sections.forEach(function(section){ observer.observe(section); });
    }

    function legacyCopy(value) {
      return new Promise(function(resolve, reject){
        var area = document.createElement('textarea');
        area.value = value;
        area.setAttribute('readonly', '');
        area.setAttribute('aria-hidden', 'true');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        var copied = false;
        try { copied = document.execCommand('copy'); } catch (error) {}
        area.remove();
        if (copied) resolve();
        else reject(new Error('copy failed'));
      });
    }

    function copyText(value) {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') return legacyCopy(value);
      return new Promise(function(resolve, reject){
        var settled = false;
        var timer = window.setTimeout(function(){
          if (settled) return;
          settled = true;
          legacyCopy(value).then(resolve, reject);
        }, 1200);
        Promise.resolve().then(function(){ return navigator.clipboard.writeText(value); }).then(function(){
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve();
        }, function(){
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          legacyCopy(value).then(resolve, reject);
        });
      });
    }

    Array.prototype.slice.call(document.querySelectorAll('[data-copy]')).forEach(function(button){
      button.addEventListener('click', function(){
        var block = button.closest('.code-block');
        var code = block.querySelector('code').textContent || '';
        var copyStatus = block.querySelector('[data-copy-status]');
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        copyStatus.removeAttribute('data-state');
        copyStatus.textContent = '${messages.copying}';
        copyText(code).then(function(){
          button.removeAttribute('aria-busy');
          copyStatus.textContent = '${messages.copied}';
          window.setTimeout(function(){
            copyStatus.textContent = '';
            button.disabled = false;
          }, 1800);
        }).catch(function(){
          button.disabled = false;
          button.removeAttribute('aria-busy');
          copyStatus.setAttribute('data-state', 'error');
          copyStatus.textContent = '${messages.copyFailed}';
        });
      });
    });

    function currentTheme() {
      var explicit = document.documentElement.getAttribute('data-theme');
      if (explicit) return explicit;
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    themeButton.addEventListener('click', function(){
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      themeButton.setAttribute('aria-pressed', String(next === 'dark'));
      try { localStorage.setItem('kassinao-docs-theme', next); } catch (_) {}
    });

    themeButton.setAttribute('aria-pressed', String(currentTheme() === 'dark'));
    syncViewport();
  })();</script>`;
}

export function docsPage(lang: DocsLang = 'pt'): string {
  const l: DocsLang = lang === 'en' ? 'en' : 'pt';
  const T = (pt: string, en: string): string => (l === 'pt' ? pt : en);
  const site = publicSite('docs', l, config);
  const repoUrl = site.links.github;
  const ptDocs = publicSite('docs', 'pt', config).canonicalUrl;
  const enDocs = publicSite('docs', 'en', config).canonicalUrl;
  const altDocs = site.links.alternate;
  const title = T('Documentação do Kassinão', 'Kassinão documentation');
  const description = T(
    'Instale e opere seu próprio bot de Discord para gravar calls e organizar o áudio. Transcrição, ata, perguntas e MCP são recursos opcionais.',
    'Install and operate your own Discord bot to record calls and organize audio. Transcription, minutes, questions, and MCP are optional features.',
  );
  const copyLabel = T('Copiar', 'Copy');

  const localBuild = codeBlock(
    'Terminal',
    `git clone ${repoUrl}
cd kassinao
cp .env.example .env && chmod 600 .env
mkdir -p data/{recordings,state,auth,cache} && chmod 700 data data/*
docker build -t kassinao-local:dev .`,
    copyLabel,
  );
  const localStart = codeBlock(
    'Terminal',
    `# ${T('Edite .env antes de iniciar.', 'Edit .env before starting.')}
docker compose up -d --no-build
docker compose logs -f kassinao`,
    copyLabel,
  );
  const localEnv = codeBlock(
    '.env',
    `NODE_ENV=development
KASSINAO_IMAGE=kassinao-local:dev
KASSINAO_PULL_POLICY=never
DISCORD_TOKEN=${T('seu_token', 'your_token')}
APPLICATION_ID=${T('seu_application_id', 'your_application_id')}
DISCORD_CLIENT_SECRET=${T('seu_client_secret', 'your_client_secret')}
APP_URL=http://localhost:8080
ALLOW_LOCAL_APP_URL=true
OPERATOR_NAME=${T('Operador local do Kassinão', 'Local Kassinão operator')}
OPERATOR_CONTACT_URL=http://localhost:8080/privacy#contact
PRIVACY_POLICY_URL=http://localhost:8080/privacy
DATA_DELETION_URL=http://localhost:8080/privacy#data-rights
PRIVACY_EFFECTIVE_DATE=2026-07-14
PRIVACY_POLICY_VERSION=local-1
PRIVACY_AUDIENCE=${T('Operador usando dados fictícios no localhost', 'Operator using fictional data on localhost')}
PRIVACY_PURPOSES=${T('Avaliação local sem dados reais de reunião', 'Local evaluation without real meeting data')}
PRIVACY_LAWFUL_BASIS=${T('Avaliação local somente com dados fictícios', 'Local evaluation with fictional data only')}
INFRASTRUCTURE_PROVIDER=${T('Máquina local', 'Local machine')}
INFRASTRUCTURE_REGION=${T('Dispositivo local', 'Local device')}
EDGE_PROVIDER=none
EDGE_REGION=none
OPERATIONAL_LOG_RETENTION=${T('Até a remoção deste teste local', 'Until this local test is removed')}
BACKUP_STATUS=disabled
BACKUP_PROVIDER=none
BACKUP_REGION=none
BACKUP_RETENTION_DAYS=0
DATA_REQUEST_PROCESS=${T('Remover os dados fictícios desta máquina local', 'Remove fictional test data from this local machine')}
DATA_REQUEST_RESPONSE_DAYS=30
INCIDENT_CONTACT_URL=http://localhost:8080/privacy#contact
INCIDENT_PROCESS=${T('Parar a instância e remover credenciais e dados de teste', 'Stop the instance and remove test credentials and data')}
SOURCE_URL=${repoUrl}
ALLOWED_GUILD_IDS=${T('id_do_servidor_de_teste', 'test_server_id')}
ALLOW_ALL_GUILDS=false
TRANSCRIBE_PROVIDER=none
TRANSCRIBE_FALLBACK_PROVIDER=none
MINUTES_ENABLED=false`,
    copyLabel,
  );
  const inviteUrl = codeBlock(
    T('URL de instalação', 'Install URL'),
    'https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&permissions=68242432&integration_type=0&scope=bot+applications.commands',
    copyLabel,
  );
  const productionVerify = codeBlock(
    T('Máquina confiável', 'Trusted workstation'),
    `# ${T('Substitua a tag somente por uma release pública e imutável.', 'Replace the tag only with a public immutable release.')}
TAG=vX.Y.Z
REPO=resolvicomai/kassinao
ARCHIVE="kassinao-ops-$TAG.tar.gz"
CHECKSUM="$ARCHIVE.sha256"
test "$(gh release view "$TAG" --repo "$REPO" --json isDraft,isImmutable --jq '.isDraft == false and .isImmutable == true')" = true
gh release verify "$TAG" --repo "$REPO"
gh release download "$TAG" --repo "$REPO" --pattern "$ARCHIVE" --pattern "$CHECKSUM"
gh release verify-asset "$TAG" "$ARCHIVE" --repo "$REPO"
gh release verify-asset "$TAG" "$CHECKSUM" --repo "$REPO"
if command -v sha256sum >/dev/null; then sha256sum -c "$CHECKSUM"; else shasum -a 256 -c "$CHECKSUM"; fi
SOURCE_SHA="$(gh api "repos/$REPO/commits/$TAG" --jq .sha)"
gh attestation verify "$ARCHIVE" --repo "$REPO" --signer-workflow "github.com/$REPO/.github/workflows/publish-image.yml" --source-ref "refs/tags/$TAG" --source-digest "$SOURCE_SHA" --deny-self-hosted-runners`,
    copyLabel,
  );
  const productionDeploy = codeBlock(
    'VPS',
    `# ${T('Transfira antes o tarball verificado para /tmp por scp ou equivalente.', 'First transfer the verified tarball to /tmp with scp or equivalent.')}
RELEASE_ROOT=/opt/kassinao/releases/kassinao-ops-vX.Y.Z
ARCHIVE=/tmp/kassinao-ops-vX.Y.Z.tar.gz
sudo test ! -e "$RELEASE_ROOT"
sudo install -d -o root -g root -m 0700 /opt/kassinao /opt/kassinao/releases
sudo install -d -o root -g root -m 0700 "$RELEASE_ROOT"
sudo tar -xzf "$ARCHIVE" -C "$RELEASE_ROOT" --strip-components=1 --no-same-owner
sudo chown -R root:root "$RELEASE_ROOT"
sudo chmod -R go-w "$RELEASE_ROOT"
sudo chmod 0700 "$RELEASE_ROOT"
sudo test "$(sudo stat -c '%a:%u:%g' "$RELEASE_ROOT")" = '700:0:0'
sudo install -o root -g root -m 600 "$RELEASE_ROOT/compose.env.example" "$RELEASE_ROOT/.env"
sudo install -o root -g root -m 600 "$RELEASE_ROOT/app.env.example" "$RELEASE_ROOT/app.env"
sudo "$RELEASE_ROOT/scripts/inject-secrets.sh"
sudoedit "$RELEASE_ROOT/.env"
# KASSINAO_DEDICATED_DOCKER_HOST_ACK=I_UNDERSTAND_THIS_VPS_MUST_RUN_ONLY_KASSINAO
sudo "$RELEASE_ROOT/scripts/prepare-storage.sh"
sudo "$RELEASE_ROOT/scripts/install-host-controls.sh"
sudo env KASSINAO_DEPLOY_DIR="$RELEASE_ROOT" "$RELEASE_ROOT/scripts/deploy-release.sh"
sudo "$RELEASE_ROOT/scripts/audit-vps-security.sh"`,
    copyLabel,
  );
  const uninstallHostControls = codeBlock(
    'VPS',
    `# ${T('Primeiro remova os containers com Compose; os dados continuam no DATA_ROOT.', 'First remove the containers with Compose; data remains in DATA_ROOT.')}
sudo docker compose down
sudo ./scripts/uninstall-host-controls.sh --confirm-remove-kassinao-host-controls`,
    copyLabel,
  );
  const mcpSetup = codeBlock(
    'Terminal',
    T(
      'npx -y kassinao-mcp@1.0.7 exchange --stdin --url https://MCP-DA-SUA-INSTANCIA',
      'npx -y kassinao-mcp@1.0.7 exchange --stdin --url https://YOUR-INSTANCE-MCP',
    ),
    copyLabel,
  );

  const commands: CommandDoc[] = [
    {
      pt: '/gravar [canal]',
      en: '/record [channel]',
      description: {
        pt: 'Inicia no seu canal de voz. Quem tem Gerenciar Servidor pode indicar outro canal visível.',
        en: 'Starts in your voice channel. Members with Manage Server may target another visible channel.',
      },
      access: { pt: 'Membro no próprio canal', en: 'Member in their own channel' },
    },
    {
      pt: '/parar',
      en: '/stop',
      description: {
        pt: 'Encerra uma gravação que você pode controlar. O áudio passa a ficar disponível depois da parada.',
        en: 'Ends a recording you are allowed to control. Audio becomes available after recording stops.',
      },
      access: { pt: 'Iniciador, participante ou admin atual', en: 'Starter, participant, or current admin' },
    },
    {
      pt: '/nota <texto>',
      en: '/note <text>',
      description: {
        pt: 'Marca o segundo atual. A nota entra nos artefatos de texto somente quando eles forem gerados.',
        en: 'Marks the current second. The note appears in text artifacts only when those artifacts are generated.',
      },
      access: { pt: 'Iniciador, participante ou admin atual', en: 'Starter, participant, or current admin' },
    },
    {
      pt: '/status',
      en: '/status',
      description: {
        pt: 'Mostra o estado da gravação em andamento depois de validar o seu acesso.',
        en: 'Shows the active recording state after validating your access.',
      },
      access: { pt: 'Acesso validado', en: 'Validated access' },
    },
    {
      pt: '/gravacoes',
      en: '/recordings',
      description: {
        pt: 'Mostra até cinco reuniões acessíveis e o link do app privado.',
        en: 'Shows up to five accessible meetings and the private app link.',
      },
      access: { pt: 'Resultados filtrados por ACL', en: 'ACL-filtered results' },
    },
    {
      pt: '/autorecord ligar|desligar|ver',
      en: '/autorecord on|off|view',
      description: {
        pt: 'Configura início automático por canal e população. Ative apenas com a política interna necessária.',
        en: 'Configures automatic starts by channel and population. Enable it only with the required internal policy.',
      },
      access: { pt: 'Gerenciar Servidor', en: 'Manage Server' },
    },
    {
      pt: '/config ata-canal|ver',
      en: '/config minutes-channel|view',
      description: {
        pt: 'Escolhe o canal do aviso genérico de processamento ou mostra a configuração.',
        en: 'Chooses the generic processing-notice channel or shows the configuration.',
      },
      access: { pt: 'Gerenciar Servidor', en: 'Manage Server' },
    },
    {
      pt: '/perguntar <pergunta> [dias]',
      en: '/ask <question> [days]',
      description: {
        pt: 'Consulta texto já gerado em reuniões acessíveis. Só existe quando o provider de atas e consultas está habilitado.',
        en: 'Queries previously generated text from accessible meetings. It only exists when the minutes and question provider is enabled.',
      },
      access: { pt: 'Recurso opcional', en: 'Optional feature' },
    },
    {
      pt: '/mcp novo|revogar-tudo',
      en: '/mcp new|revoke-all',
      description: {
        pt: 'Administra conectores da instância. Só aparece quando MCP está ligado; membros usam o app privado.',
        en: 'Manages instance connectors. It only appears when MCP is enabled; members use the private app.',
      },
      access: {
        pt: 'Visível com Gerenciar Servidor; execução somente para OWNER_IDS',
        en: 'Visible with Manage Server; execution restricted to OWNER_IDS',
      },
    },
    {
      pt: '/privacidade',
      en: '/privacy',
      description: {
        pt: 'Mostra a política pública e o contato do operador desta instância para solicitações sobre dados.',
        en: 'Shows this instance public operator policy and contact for data requests.',
      },
      access: { pt: 'Qualquer membro', en: 'Any member' },
    },
    {
      pt: '/ajuda e /sobre',
      en: '/help and /about',
      description: {
        pt: 'Explicam os recursos realmente habilitados, a política da instância, a licença e o source correspondente.',
        en: 'Explain the features actually enabled, the instance policy, the license, and corresponding source.',
      },
      access: { pt: 'Qualquer membro', en: 'Any member' },
    },
  ];
  const commandCards = commands
    .map(
      (command) => `<article class="command-card">
        <code>${esc(command[l])}</code>
        <p>${esc(text(l, command.description))}</p>
        <div class="command-meta">${esc(T('Acesso: ', 'Access: '))}${esc(text(l, command.access))}</div>
      </article>`,
    )
    .join('');

  const essentialEnv: EnvGroup[] = [
    {
      title: { pt: 'Identidade e perímetro', en: 'Identity and perimeter' },
      summary: {
        pt: 'Cada operador cria sua própria aplicação, URLs, política e allowlist.',
        en: 'Every operator creates their own application, URLs, policy, and allowlist.',
      },
      items: [
        {
          name: 'APP_URL',
          fallback: { pt: 'obrigatória', en: 'required' },
          description: {
            pt: 'Origem do app privado, OAuth e gravações.',
            en: 'Origin for the private app, OAuth, and recordings.',
          },
        },
        {
          name: 'ALLOWED_GUILD_IDS',
          fallback: { pt: 'obrigatória', en: 'required' },
          description: {
            pt: 'Servidores aceitos pela instância. Produção privada mantém ALLOW_ALL_GUILDS=false.',
            en: 'Servers accepted by the instance. Private production keeps ALLOW_ALL_GUILDS=false.',
          },
        },
        {
          name: 'OPERATOR_NAME',
          fallback: { pt: 'obrigatória em produção', en: 'required in production' },
          description: {
            pt: 'Nome público de quem opera e controla os dados desta instância.',
            en: 'Public name of the entity operating and controlling this instance data.',
          },
        },
        {
          name: 'OPERATOR_CONTACT_URL',
          fallback: { pt: 'obrigatória em produção', en: 'required in production' },
          description: {
            pt: 'Canal público para suporte e solicitações sobre dados.',
            en: 'Public channel for support and data requests.',
          },
        },
        {
          name: 'PRIVACY_POLICY_URL',
          fallback: 'APP_URL/privacy',
          description: {
            pt: 'Política dinâmica da instância. Em produção, aponta para a rota canônica do app.',
            en: 'Dynamic instance policy. In production, it points to the canonical app route.',
          },
        },
        {
          name: 'DATA_DELETION_URL',
          fallback: 'APP_URL/privacy#data-rights',
          description: {
            pt: 'Fluxo público para pedir correção ou exclusão.',
            en: 'Public flow for correction or deletion requests.',
          },
        },
        {
          name: 'TERMS_OF_SERVICE_URL',
          fallback: { pt: 'opcional', en: 'optional' },
          description: {
            pt: 'Termos próprios do operador, quando existirem.',
            en: 'Operator-specific terms, when applicable.',
          },
        },
        {
          name: 'SOURCE_URL',
          fallback: { pt: 'obrigatória em produção', en: 'required in production' },
          description: {
            pt: 'Source correspondente da versão ou fork em execução; somente o desenvolvimento local usa o upstream como fallback.',
            en: 'Corresponding source for the running version or fork; only local development falls back to upstream.',
          },
        },
      ],
    },
    {
      title: { pt: 'Contrato público de privacidade', en: 'Public privacy contract' },
      summary: {
        pt: 'Produção não inicia com declaração incompleta ou coordenadas privadas do host.',
        en: 'Production does not start with an incomplete statement or private host coordinates.',
      },
      items: [
        {
          name: 'PRIVACY_EFFECTIVE_DATE / PRIVACY_POLICY_VERSION',
          fallback: { pt: 'obrigatórias em produção', en: 'required in production' },
          description: {
            pt: 'Data real não futura e identificador público da versão da política.',
            en: 'Real non-future date and public policy-version identifier.',
          },
        },
        {
          name: 'PRIVACY_AUDIENCE / PRIVACY_PURPOSES / PRIVACY_LAWFUL_BASIS',
          fallback: { pt: 'obrigatórias em produção', en: 'required in production' },
          description: {
            pt: 'Público abrangido, finalidades e base ou justificativa declarada pelo operador.',
            en: 'Covered people, purposes, and the basis or justification declared by the operator.',
          },
        },
        {
          name: 'INFRASTRUCTURE_PROVIDER / INFRASTRUCTURE_REGION',
          fallback: { pt: 'obrigatórias em produção', en: 'required in production' },
          description: {
            pt: 'Provider e região/escopo públicos; nunca IP, hostname, ID de conta ou nome da VPS.',
            en: 'Public provider and region/scope; never an IP, hostname, account ID, or VPS name.',
          },
        },
        {
          name: 'EDGE_PROVIDER / EDGE_REGION',
          fallback: 'none / none',
          description: {
            pt: 'Provider de túnel/CDN e região ou escopo; com o profile tunnel, não pode ficar none.',
            en: 'Tunnel/CDN provider and region or scope; it cannot remain none with the tunnel profile.',
          },
        },
        {
          name: 'OPERATIONAL_LOG_RETENTION',
          fallback: { pt: 'obrigatória em produção', en: 'required in production' },
          description: {
            pt: 'Prazo ou processo real de expurgo nos logs do app, host e providers.',
            en: 'Actual expiry period or process for app, host, and provider logs.',
          },
        },
        {
          name: 'BACKUP_STATUS / BACKUP_PROVIDER / BACKUP_REGION / BACKUP_RETENTION_DAYS',
          fallback: 'disabled / none / none / 0',
          description: {
            pt: 'Declara a operação real; esses campos não ligam backup sozinhos.',
            en: 'Declares the actual operation; these fields do not enable backups by themselves.',
          },
        },
        {
          name: 'DATA_REQUEST_PROCESS / DATA_REQUEST_RESPONSE_DAYS',
          fallback: { pt: 'obrigatórias em produção', en: 'required in production' },
          description: {
            pt: 'Verificação, entrega e prazo público para acesso, correção ou exclusão.',
            en: 'Verification, delivery, and public response window for access, correction, or deletion.',
          },
        },
        {
          name: 'INCIDENT_CONTACT_URL / INCIDENT_PROCESS',
          fallback: { pt: 'obrigatórias em produção', en: 'required in production' },
          description: {
            pt: 'Canal e processo público para incidente, sem expor coordenação interna.',
            en: 'Public incident channel and process without exposing internal coordination.',
          },
        },
      ],
    },
    {
      title: { pt: 'Recursos e egress', en: 'Features and egress' },
      summary: {
        pt: 'Cada integração exige configuração explícita; definir MCP_SECRET é o opt-in do MCP.',
        en: 'Every integration requires explicit configuration; setting MCP_SECRET is the MCP opt-in.',
      },
      items: [
        {
          name: 'TRANSCRIBE_PROVIDER',
          fallback: 'none',
          description: {
            pt: 'Provider explícito de transcrição ou comando em imagem customizada.',
            en: 'Explicit transcription provider or command in a custom image.',
          },
        },
        {
          name: 'TRANSCRIBE_FALLBACK_PROVIDER',
          fallback: 'none',
          description: {
            pt: 'Fallback externo deliberado. O padrão não envia áudio.',
            en: 'Deliberate external fallback. The default sends no audio.',
          },
        },
        {
          name: 'TRANSCRIBE_SEND_MEETING_CONTEXT',
          fallback: 'false',
          description: {
            pt: 'Autoriza ou bloqueia nomes e contexto enviados ao ASR.',
            en: 'Allows or blocks names and context sent to ASR.',
          },
        },
        {
          name: 'MINUTES_ENABLED',
          fallback: 'false',
          description: {
            pt: 'Liga ata e perguntas por IA depois que existe transcrição.',
            en: 'Enables AI minutes and questions after a transcript exists.',
          },
        },
        {
          name: 'MCP_SECRET',
          fallback: { pt: 'desligado', en: 'disabled' },
          description: {
            pt: 'Segredo dedicado que habilita API e conexão MCP.',
            en: 'Dedicated secret that enables the MCP API and connection flow.',
          },
        },
        {
          name: 'MINUTES_WEBHOOK_URL / MINUTES_WEBHOOK_SECRET',
          fallback: { pt: 'desligados', en: 'disabled' },
          description: {
            pt: 'Webhook HTTPS opcional, assinado com segredo próprio.',
            en: 'Optional HTTPS webhook signed with its own secret.',
          },
        },
      ],
    },
    {
      title: { pt: 'Dados e operação', en: 'Data and operations' },
      summary: {
        pt: 'Retenção, isolamento e limites que precisam refletir a política do operador.',
        en: 'Retention, isolation, and limits that must match the operator policy.',
      },
      items: [
        {
          name: 'RETENTION_DAYS',
          fallback: '7',
          description: { pt: 'Expiração padrão do áudio.', en: 'Default audio expiration.' },
        },
        {
          name: 'TEXT_RETENTION_DAYS',
          fallback: '90',
          description: {
            pt: 'Expiração de transcrição, ata, notas e metadados textuais.',
            en: 'Expiration for transcripts, minutes, notes, and text metadata.',
          },
        },
        {
          name: 'KASSINAO_DATA_ROOT',
          fallback: '/var/lib/kassinao',
          description: {
            pt: 'Raiz privada do kit de produção, em storage dm-crypt/LUKS.',
            en: 'Private production-bundle root on dm-crypt/LUKS storage.',
          },
        },
        {
          name: 'PUBLIC_SURFACES_ENABLED',
          fallback: 'false',
          description: {
            pt: 'No core de produção, impede servir landing, docs e demo com segredos.',
            en: 'On the production core, prevents serving landing, docs, and demo with secrets.',
          },
        },
        {
          name: 'TRUST_PROXY_HOPS',
          fallback: '1',
          description: {
            pt: 'Contagem exata na topologia do túnel do kit. Não aumente por tentativa.',
            en: 'Exact count for the bundle tunnel topology. Never increase it by trial and error.',
          },
        },
        {
          name: 'LOG_PII',
          fallback: 'false',
          description: {
            pt: 'Mantém identificadores, origens e erros privados fora dos logs operacionais.',
            en: 'Keeps identifiers, origins, and private errors out of operational logs.',
          },
        },
        {
          name: 'KASSINAO_ROLLBACK_RETENTION_HOURS',
          fallback: '72',
          description: {
            pt: 'Janela máxima de snapshot após deploy falho; 1..168 e igual em .env/app.env.',
            en: 'Maximum failed-deploy snapshot window; 1..168 and identical in .env/app.env.',
          },
        },
        {
          name: 'KASSINAO_DEDICATED_DOCKER_HOST_ACK',
          fallback: { pt: 'aceite manual obrigatório no bundle', en: 'manual bundle acknowledgement required' },
          description: {
            pt: 'Confirma que o daemon Docker inteiro pertence somente ao Kassinão.',
            en: 'Confirms that the entire Docker daemon is dedicated to Kassinão.',
          },
        },
      ],
    },
  ];
  const envCards = essentialEnv
    .map(
      (group, index) => `<details class="env-group"${index === 0 ? ' open' : ''}>
        <summary><span class="env-title"><strong>${esc(text(l, group.title))}</strong><span>${esc(text(l, group.summary))}</span></span></summary>
        <dl class="env-list">${group.items
          .map(
            (item) =>
              `<div class="env-item"><dt>${esc(item.name)}</dt><dd><span class="env-default">${esc(T('Padrão: ', 'Default: '))}${esc(localValue(l, item.fallback))}</span><span class="env-description">${esc(text(l, item.description))}</span></dd></div>`,
          )
          .join('')}</dl>
      </details>`,
    )
    .join('');

  const nav = [
    ['visao', T('O que é', 'What it is')],
    ['fluxo', T('Fluxo no Discord', 'Discord flow')],
    ['limites', T('Projeto e instância', 'Project and instance')],
    ['local', T('Teste local', 'Local test')],
    ['producao', T('Produção endurecida', 'Hardened production')],
    ['discord', 'Discord Portal'],
    ['comandos', T('Comandos e recursos', 'Commands and features')],
    ['acesso', T('Acesso, dados e IA', 'Access, data, and AI')],
    ['mcp', 'MCP'],
    ['operacao', T('Operação e mudanças', 'Operations and changes')],
    ['problemas', T('Diagnóstico', 'Troubleshooting')],
    ['links', T('Referências', 'References')],
  ];

  return `<!doctype html>
<html lang="${l === 'pt' ? 'pt-BR' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | Kassinão</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(site.canonicalUrl)}">
<link rel="alternate" hreflang="pt-BR" href="${esc(ptDocs)}">
<link rel="alternate" hreflang="en" href="${esc(enDocs)}">
<link rel="alternate" hreflang="x-default" href="${esc(enDocs)}">
<meta property="og:title" content="${esc(title)} | Kassinão">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(config.publicUrl)}/og-${l}.png">
<meta property="og:url" content="${esc(site.canonicalUrl)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Kassinão">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#202024" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png" sizes="180x180">
<script${CSP_NONCE_ATTR}>try{var theme=localStorage.getItem('kassinao-docs-theme');if(theme==='light'||theme==='dark')document.documentElement.setAttribute('data-theme',theme)}catch(_){}</script>
<style>${DOCS_CSS}</style>
</head>
<body>
<a class="skip-link" href="#conteudo">${esc(T('Pular para o conteúdo', 'Skip to content'))}</a>
<header class="topbar"><div class="topbar-inner">
  <button class="control mobile-menu" id="mobile-menu" type="button" aria-controls="docs-sidebar" aria-expanded="false">${esc(T('Menu', 'Menu'))}</button>
  <a class="brand" href="${site.links.home}" aria-label="${esc(T('Kassinão, página inicial', 'Kassinão, home page'))}"><span class="brand-mark" aria-hidden="true">k/</span><span>Kassinão</span><span class="brand-context">${esc(T('Documentação', 'Docs'))}</span></a>
  <div class="topbar-actions">
    <div class="language" aria-label="${esc(T('Idioma', 'Language'))}"><a href="${ptDocs}"${l === 'pt' ? ' aria-current="page"' : ''} lang="pt-BR">PT</a><a href="${enDocs}"${l === 'en' ? ' aria-current="page"' : ''} lang="en">EN</a></div>
    <button class="control" id="theme-toggle" type="button" aria-label="${esc(T('Alternar tema claro e escuro', 'Toggle light and dark theme'))}" aria-pressed="false"><span class="theme-label">${esc(T('Tema', 'Theme'))}</span></button>
    <a class="primary-link" href="${repoUrl}" target="_blank" rel="noopener noreferrer">GitHub</a>
  </div>
</div></header>
<div class="docs-shell">
  <aside class="sidebar" id="docs-sidebar" aria-label="${esc(T('Navegação da documentação', 'Documentation navigation'))}">
    <div class="search-block"><label for="docs-search">${esc(T('Buscar na documentação', 'Search documentation'))}</label><input class="search-input" id="docs-search" type="search" placeholder="${esc(T('Comando, operação ou dúvida', 'Command, operation, or question'))}" autocomplete="off"><p class="search-status" id="search-status" aria-live="polite"></p></div>
    <nav class="side-nav">${nav.map(([id, label], index) => `<a href="#${id}" data-nav-link${index === 0 ? ' aria-current="location"' : ''}>${esc(label)}</a>`).join('')}</nav>
    <p class="side-note">${esc(T('Nunca copie credenciais, IDs privados, domínios internos ou dados de reunião para Git, issues ou logs públicos.', 'Never copy credentials, private IDs, internal domains, or meeting data into Git, issues, or public logs.'))}</p>
  </aside>
  <button class="nav-backdrop" id="nav-backdrop" type="button" aria-label="${esc(T('Fechar menu', 'Close menu'))}"></button>
  <main class="docs-main" id="conteudo"><div class="docs-main-inner">
    <header class="docs-hero">
      <h1>${esc(T('Seu bot. Sua instância. Suas calls.', 'Your bot. Your instance. Your calls.'))}</h1>
      <p>${esc(description)}</p>
      <div class="hero-actions"><a class="primary-link" href="#local">${esc(T('Testar pelo source', 'Test from source'))}</a><a class="control" href="${site.links.demo}">${esc(T('Ver o fluxo', 'See the flow'))}</a></div>
      <p>${esc(T('O projeto é público. Cada deploy real é uma instância privada, com aplicação Discord, URLs, política, credenciais, guilds e dados próprios.', 'The project is public. Every real deployment is a private instance with its own Discord application, URLs, policy, credentials, guilds, and data.'))}</p>
    </header>

    <section class="doc-section" id="visao" data-doc-section data-keywords="bot discord self hosted audio optional ai core">
      <div class="section-head"><h2>${esc(T('O núcleo funciona sem IA.', 'The core works without AI.'))}</h2><p>${esc(T('Kassinão entra numa call autorizada, registra áudio por stream do Discord, preserva uma faixa por conta do Discord que fala, aceita notas e entrega o histórico no app privado.', 'Kassinão joins an authorized call, records audio by Discord stream, preserves one track per Discord account that speaks, accepts notes, and serves history through the private app.'))}</p></div>
      <div class="requirement-grid">
        <article class="requirement-primary"><h3>${esc(T('Sempre no núcleo', 'Always in the core'))}</h3><ul class="check-list"><li>${esc(T('Gravação e faixas associadas às contas que falam', 'Recording and tracks associated with accounts that speak'))}</li><li>${esc(T('Painel e aviso técnico antes da captura', 'Panel and technical notice before capture'))}</li><li>${esc(T('Notas com timestamp, player e downloads depois da parada', 'Timestamped notes, player, and downloads after stopping'))}</li><li>${esc(T('Login Discord, allowlist de guild e ACL da reunião', 'Discord login, guild allowlist, and meeting ACL'))}</li></ul></article>
        <article class="requirement-secondary"><h3>${esc(T('Opt-in do operador', 'Operator opt-in'))}</h3><ul class="check-list"><li>${esc(T('Transcrição por provider ou imagem customizada', 'Transcription through a provider or custom image'))}</li><li>${esc(T('Ata, decisões, tarefas e perguntas por IA', 'AI minutes, decisions, tasks, and questions'))}</li><li>${esc(T('Webhook assinado e API MCP', 'Signed webhook and MCP API'))}</li></ul></article>
      </div>
      <div class="callout"><strong>${esc(T('Sem promessa de identidade humana ou SLA.', 'No human-identity or processing-time promise.'))}</strong><p>${esc(T('A separação é por conta e stream do Discord. Contas compartilhadas, perda de pacotes, falhas parciais, filas e rate limits continuam possíveis.', 'Separation is based on Discord account and stream. Shared accounts, packet loss, partial failures, queues, and rate limits remain possible.'))}</p></div>
    </section>

    <section class="doc-section" id="fluxo" data-doc-section data-keywords="discord flow panel notice recording tracks note stop transcript minutes dm">
      <div class="section-head"><h2>${esc(T('Fluxo real no Discord', 'The real Discord flow'))}</h2><p>${esc(T('A demo pública usa dados fictícios. O comportamento operacional é este.', 'The public demo uses fictional data. This is the operational behavior.'))}</p></div>
      <ol class="flow">
        <li><span class="flow-number">1</span><div><h3>${esc(T('Um membro inicia', 'A member starts'))}</h3><p>${esc(T('Use /gravar no canal atual. Um admin pode escolher outro canal visível.', 'Use /record in the current channel. An admin may choose another visible channel.'))}</p></div></li>
        <li><span class="flow-number">2</span><div><h3>${esc(T('O aviso técnico vem primeiro', 'The technical notice comes first'))}</h3><p>${esc(T('O bot conecta e publica o painel no chat. Se não conseguir publicar, desfaz o início. A mudança do apelido é apenas um indicador adicional e pode falhar.', 'The bot connects and posts the panel in chat. If posting fails, startup is rolled back. The nickname change is only an extra indicator and may fail.'))}</p></div></li>
        <li><span class="flow-number">3</span><div><h3>${esc(T('Cada conta que fala ganha uma faixa', 'Each speaking account gets a track'))}</h3><p>${esc(T('A presença na call também é registrada para acesso. O limite atual é de 25 faixas; uma falha pode produzir resultado parcial.', 'Call presence is also recorded for access. The current limit is 25 tracks; a failure may produce a partial result.'))}</p></div></li>
        <li><span class="flow-number">4</span><div><h3>${esc(T('Notas marcam o momento', 'Notes mark the moment'))}</h3><p>${esc(T('Use /nota ou o painel. Notas sempre ficam no registro; transcrição, ata e labels só recebem a nota quando esses artefatos existem.', 'Use /note or the panel. Notes always remain in the record; transcripts, minutes, and labels receive the note only when those artifacts exist.'))}</p></div></li>
        <li><span class="flow-number">5</span><div><h3>${esc(T('A parada libera o áudio', 'Stopping releases audio'))}</h3><p>${esc(T('Player e downloads não são servidos durante a captura. O bot também pode encerrar por canal vazio, limite, desconexão ou proteção operacional.', 'Player and downloads are not served while capturing. The bot may also stop for an empty channel, limit, disconnection, or operational protection.'))}</p></div></li>
        <li><span class="flow-number">6</span><div><h3>${esc(T('IA entra somente se habilitada', 'AI runs only when enabled'))}</h3><p>${esc(T('A transcrição é assíncrona e pode tentar novamente. Com MINUTES_ENABLED=true, a ata usa a transcrição disponível; se ela estiver parcial, a ata também pode omitir detalhes. O canal recebe apenas aviso genérico; detalhes ficam no app privado e em DMs autorizadas quando entregues.', 'Transcription is asynchronous and may retry. With MINUTES_ENABLED=true, minutes use the available transcript; if it is partial, the minutes may also omit details. The channel receives only a generic notice; details stay in the private app and authorized DMs when delivered.'))}</p></div></li>
      </ol>
      <div class="callout danger"><strong>${esc(T('Aviso técnico não é consentimento jurídico.', 'A technical notice is not legal consent.'))}</strong><p>${esc(T('O operador precisa definir e cumprir a base legal, as regras internas e as exigências da sua jurisdição, especialmente antes de ativar auto-record.', 'The operator must define and follow the legal basis, internal rules, and jurisdiction requirements, especially before enabling auto-record.'))}</p></div>
    </section>

    <section class="doc-section" id="limites" data-doc-section data-keywords="public project private instance agpl source secrets data url">
      <div class="section-head"><h2>${esc(T('Projeto público, instância privada', 'Public project, private instance'))}</h2><p>${esc(T('Separar essas duas camadas evita credenciais reaproveitadas, links apontando para outro operador e uma VPS que compila o GitHub a cada deploy.', 'Separating these layers prevents reused credentials, links pointing to another operator, and a VPS that rebuilds GitHub on every deployment.'))}</p></div>
      <div class="privacy-layout"><div class="privacy-rules">
        <article class="privacy-rule"><h3>${esc(T('O projeto publica', 'The project publishes'))}</h3><p>${esc(T('Source AGPL, documentação genérica, Dockerfile, workflows, templates sem segredo e demo fictícia.', 'AGPL source, generic documentation, Dockerfile, workflows, secret-free templates, and a fictional demo.'))}</p></article>
        <article class="privacy-rule"><h3>${esc(T('A instância mantém privada', 'The instance keeps private'))}</h3><p>${esc(T('Tokens, Client Secret, IDs de guild e owner, domínios operacionais, gravações, estado auth, tokens MCP, providers, backups e runbooks internos.', 'Tokens, Client Secret, guild and owner IDs, operational domains, recordings, auth state, MCP tokens, providers, backups, and internal runbooks.'))}</p></article>
        <article class="privacy-rule"><h3>${esc(T('Modificações de software', 'Software modifications'))}</h3><p>${esc(T('Quem modifica o programa e oferece interação pela rede precisa cumprir a AGPL e apontar SOURCE_URL para o source correspondente. Dados e segredos de runtime não viram código público.', 'Anyone who modifies the program and offers network interaction must comply with the AGPL and point SOURCE_URL to the corresponding source. Runtime data and secrets do not become public code.'))}</p></article>
      </div><aside class="permission-box"><h3>${esc(T('A URL não é segredo', 'The URL is not a secret'))}</h3><p>${esc(T('O hostname pode ser descoberto. A segurança vem de HTTPS, allowlist de guild, OAuth, membership atual, ACL por gravação, rate limits, firewall e atualizações, não de esconder o domínio.', 'The hostname can be discovered. Security comes from HTTPS, the guild allowlist, OAuth, current membership, per-recording ACLs, rate limits, firewall, and updates, not from hiding the domain.'))}</p></aside></div>
    </section>

    <section class="doc-section" id="local" data-doc-section data-keywords="local source docker build compose localhost quickstart">
      <div class="section-head"><h2>${esc(T('Primeiro, valide pelo source local.', 'First, validate from local source.'))}</h2><p>${esc(T('Este caminho serve para avaliação e desenvolvimento. Ele compila na sua máquina e não deve ser exposto como produção.', 'This path is for evaluation and development. It builds on your machine and must not be exposed as production.'))}</p></div>
      <div class="quick-layout"><ol class="quick-list"><li><strong>${esc(T('Crie um app Discord de teste', 'Create a test Discord app'))}</strong><span>${esc(T('Use uma guild separada e credenciais descartáveis.', 'Use a separate guild and disposable credentials.'))}</span></li><li><strong>${esc(T('Clone e construa', 'Clone and build'))}</strong><span>${esc(T('A imagem local recebe o nome kassinao-local:dev.', 'The local image is named kassinao-local:dev.'))}</span></li><li><strong>${esc(T('Configure o mínimo', 'Configure the minimum'))}</strong><span>${esc(T('Defina o app, localhost e a guild de teste; mantenha todo egress desligado.', 'Set the app, localhost, and test guild; keep all egress disabled.'))}</span></li><li><strong>${esc(T('Suba sem pull', 'Start without pulling'))}</strong><span>${esc(T('Compose usa exatamente a imagem que você acabou de construir.', 'Compose uses the exact image you just built.'))}</span></li></ol><div class="code-stack">${localBuild}${localEnv}${localStart}</div></div>
      <div class="callout"><strong>${esc(T('O quickstart local não valida a operação de uma VPS.', 'The local quickstart does not validate VPS operations.'))}</strong><p>${esc(T('Produção exige domínio HTTPS próprio, política do operador, storage criptografado, bundle verificado, processo público separado e auditoria do host.', 'Production requires your own HTTPS domain, an operator policy, encrypted storage, a verified bundle, a separate public process, and a host audit.'))}</p></div>
    </section>

    <section class="doc-section" id="producao" data-doc-section data-keywords="production release bundle ghcr digest attestation split public luks vps">
      <div class="section-head"><h2>${esc(T('Produção só começa numa release pública verificável.', 'Production starts only from a verifiable public release.'))}</h2><p>${esc(T('O pipeline do repositório está preparado para imagem multiarch, digest, SBOM, attestations e bundle operacional. Isso só existe para uma tag quando os artefatos aparecem publicamente na release e no registry.', 'The repository pipeline is prepared for a multi-architecture image, digest, SBOM, attestations, and an operations bundle. These exist for a tag only when the artifacts are publicly available in the release and registry.'))}</p></div>
      <div class="callout danger"><strong>${esc(T('Não invente uma versão nem use um artefato só porque o workflow existe no source.', 'Never invent a version or use an artifact merely because its workflow exists in source.'))}</strong><p>${esc(T('Antes do deploy, confirme release imutável, checksum, attestation, digest OCI e o commit de origem. Se qualquer peça estiver ausente, o caminho de produção ainda não foi publicado.', 'Before deployment, confirm an immutable release, checksum, attestation, OCI digest, and source commit. If any piece is missing, the production path has not been published yet.'))}</p></div>
      ${productionVerify}
      <div class="install-steps">
        <article class="install-step"><h3>${esc(T('1. Prepare um host dedicado', '1. Prepare a dedicated host'))}</h3><div><p>${esc(T('Use uma VPS Linux exclusiva e atualizada, sem workloads Docker alheios, com systemd 249 ou superior, Docker Engine com Compose v2, iptables/ip6tables, util-linux (flock, findmnt e lsblk), curl, Python 3, tar/gzip, SSH por chave e firewall. Os ExecStartPre do kit governam o docker.service inteiro e o audit exige somente os containers esperados. Monte /var/lib/kassinao num volume dm-crypt/LUKS e deixe a raiz 0700 root:root; o helper prepara somente os quatro filhos depois de provar o mount. O deploy também exige swap desabilitado ou coberto por dm-crypt/LUKS.', 'Use an exclusive, updated Linux VPS with no unrelated Docker workloads, systemd 249 or newer, Docker Engine with Compose v2, iptables/ip6tables, util-linux (flock, findmnt, and lsblk), curl, Python 3, tar/gzip, key-based SSH, and a firewall. The bundle ExecStartPre hooks govern the entire docker.service and the audit requires only expected containers. Mount /var/lib/kassinao on a dm-crypt/LUKS volume and leave its root as 0700 root:root; the helper prepares only the four children after proving the mount. Deployment also requires swap to be disabled or covered by dm-crypt/LUKS.'))}</p></div></article>
        <article class="install-step"><h3>${esc(T('2. Instale o bundle sem source', '2. Install the source-free bundle'))}</h3><div><p>${esc(T('Depois de verificar o tarball numa máquina confiável, transfira-o para /tmp e extraia uma única vez no diretório novo mostrado abaixo. O bloco cria pais root-owned, fixa a raiz em 0700, remove escrita de grupo/outros, confirma 700:0:0 e usa caminhos absolutos. Não extraia por cima de release antiga nem dentro de Git. A VPS puxa a imagem por image@sha256 e não executa git clone, npm install ou docker build.', 'After verifying the tarball on a trusted workstation, transfer it to /tmp and extract it once into the new directory shown below. The block creates root-owned parents, fixes the root at 0700, removes group/other write access, confirms 700:0:0, and uses absolute paths. Never extract over an older release or inside Git. The VPS pulls the image by image@sha256 and does not run git clone, npm install, or docker build.'))}</p></div></article>
        <article class="install-step"><h3>${esc(T('3. Separe público e privado', '3. Separate public and private'))}</h3><div><p>${esc(T('O kit aceita somente topologia split: landing/docs/demo num processo sem segredos; bot, app privado e API MCP no core privado. Landing e docs usam hosts diferentes de app e MCP. No Cloudflare Tunnel do Compose, aponte APP_URL e MCP_URL para http://kassinao:8080; PUBLIC_URL e DOCS_URL para http://kassinao-public:8081. Num proxy instalado no host, use respectivamente http://127.0.0.1:${KASSINAO_HOST_PORT} e http://127.0.0.1:${KASSINAO_PUBLIC_HOST_PORT}. Prepare DNS, certificados e essas quatro rotas HTTPS antes do deploy, porque o gate testa os hosts por fora. Nunca abra 8080/8081 na internet. Ainda não anuncie a instância nem distribua o invite do bot.', 'The bundle accepts split topology only: landing/docs/demo in a secretless process; bot, private app, and MCP API in the private core. Landing and docs use hosts different from app and MCP. In the Compose Cloudflare Tunnel, route APP_URL and MCP_URL to http://kassinao:8080; route PUBLIC_URL and DOCS_URL to http://kassinao-public:8081. With a proxy installed on the host, use http://127.0.0.1:${KASSINAO_HOST_PORT} and http://127.0.0.1:${KASSINAO_PUBLIC_HOST_PORT}, respectively. Prepare DNS, certificates, and these four HTTPS routes before deployment because the gate tests the hosts externally. Never expose 8080/8081 to the internet. Do not announce the instance or distribute the bot invite yet.'))}</p></div></article>
        <article class="install-step"><h3>${esc(T('4. Configure a instância e o storage', '4. Configure the instance and storage'))}</h3><div><p>${esc(T('Copie os dois templates, preencha URLs, guilds, credenciais e o contrato público de privacidade pelo injector. Depois, confirme manualmente no .env que a VPS é dedicada usando a frase KASSINAO_DEDICATED_DOCKER_HOST_ACK mostrada no bloco abaixo. Com o mount LUKS já ativo e a raiz 0700 root:root, prepare-storage.sh valida o bundle e a configuração, prova a criptografia antes de qualquer criação e materializa somente recordings, state, auth e cache como 0700 no UID/GID configurado. Esses valores e diretórios nunca entram na imagem ou no bundle público.', 'Copy both templates, then fill URLs, guilds, credentials, and the public privacy contract through the injector. Next, manually acknowledge in .env that the VPS is dedicated using the KASSINAO_DEDICATED_DOCKER_HOST_ACK phrase shown below. With the LUKS mount already active and its root at 0700 root:root, prepare-storage.sh validates the bundle and configuration, proves encryption before creating anything, and materializes only recordings, state, auth, and cache as 0700 under the configured UID/GID. These values and directories never enter the image or public bundle.'))}</p><p>${esc(T('KASSINAO_ROLLBACK_RETENTION_HOURS precisa existir e coincidir nos dois arquivos. O padrão é 72 horas e a faixa aceita é 1..168.', 'KASSINAO_ROLLBACK_RETENTION_HOURS must exist and match in both files. The default is 72 hours and the accepted range is 1..168.'))}</p></div></article>
        <article class="install-step"><h3>${esc(T('5. Audite antes do lançamento', '5. Audit before launch'))}</h3><div><p>${esc(T('Com DNS e HTTPS já propagados, o deploy valida por fora os quatro hosts, a identidade da release, a política PT/EN, a separação de superfícies e a negação de rotas privadas. O audit também verifica layout, rede, containers, firewall, storage, permissões, listeners e headers. Só depois anuncie as URLs, distribua o invite ou habilite uso real.', 'With DNS and HTTPS already propagated, deployment externally validates all four hosts, release identity, the PT/EN policy, surface separation, and denial of private routes. The audit also verifies layout, networking, containers, firewall, storage, permissions, listeners, and headers. Only then announce the URLs, distribute the invite, or enable real use.'))}</p></div></article>
      </div>
      ${productionDeploy}
      <div class="callout"><strong>${esc(T('Rollback não é backup.', 'Rollback is not a backup.'))}</strong><p>${esc(T('Um deploy saudável apaga o snapshot imediatamente. Se falhar, o snapshot contém somente estado operacional e metadados de gravações, sem auth nem faixas de áudio, e o timer persistente do host o remove dentro da janela declarada mesmo sem outro deploy.', 'A healthy deployment deletes its snapshot immediately. If it fails, the snapshot contains only operational state and recording metadata, without auth or audio tracks, and the persistent host timer removes it within the declared window even if no later deployment runs.'))}</p></div>
    </section>

    <section class="doc-section" id="discord" data-doc-section data-keywords="discord portal guild install bot applications commands permissions 68242432 identify callback privacy public bot">
      <div class="section-head"><h2>${esc(T('Configure o Discord Portal sem permissões extras.', 'Configure the Discord Portal without extra permissions.'))}</h2><p>${esc(T('Cada operador cria sua própria Application. Não reutilize o bot, token ou Client Secret de outra instância.', 'Every operator creates their own Application. Never reuse another instance bot, token, or Client Secret.'))}</p></div>
      <div class="install-steps">
        <article class="install-step"><h3>Installation</h3><div><p>${esc(T('Use Guild Install. Selecione os scopes bot e applications.commands. Em Permissions, use exatamente o bitfield 68242432.', 'Use Guild Install. Select the bot and applications.commands scopes. Under Permissions, use the exact bitfield 68242432.'))}</p><p>${esc(T('Ele soma View Channel, Send Messages, Embed Links, Read Message History, Connect e Change Nickname. A última é recomendada; o apelido não é garantia de captura.', 'It combines View Channel, Send Messages, Embed Links, Read Message History, Connect, and Change Nickname. The last one is recommended; the nickname is not a capture guarantee.'))}</p></div></article>
        <article class="install-step"><h3>OAuth2</h3><div><p>${esc(T('Cadastre exatamente APP_URL/auth/callback em Redirects. O login do app pede somente identify; membership nas guilds permitidas é conferida pelo bot no servidor.', 'Register exactly APP_URL/auth/callback under Redirects. App login requests only identify; membership in allowed guilds is checked server-side by the bot.'))}</p></div></article>
        <article class="install-step"><h3>${esc(T('Política e dados', 'Policy and data'))}</h3><div><p>${esc(T('Em General Information, use APP_URL/privacy como Privacy Policy URL. A mesma política expõe o contato do operador e APP_URL/privacy#data-rights para pedidos de acesso, correção ou exclusão.', 'Under General Information, use APP_URL/privacy as the Privacy Policy URL. The same policy exposes the operator contact and APP_URL/privacy#data-rights for access, correction, or deletion requests.'))}</p></div></article>
        <article class="install-step"><h3>${esc(T('Bot privado', 'Private bot'))}</h3><div><p>${esc(T('Para uma instância empresarial privada, desligue Public Bot. Isso impede instalação por terceiros, mas não substitui ALLOWED_GUILD_IDS e as checagens do runtime.', 'For a private company instance, disable Public Bot. This prevents third-party installation but does not replace ALLOWED_GUILD_IDS and runtime checks.'))}</p></div></article>
        <article class="install-step"><h3>Gateway</h3><div><p>${esc(T('O produto usa Guilds, GuildVoiceStates e DirectMessages. Não habilite Message Content, Guild Members ou Presence. Em DM com o bot, ele lê apenas o necessário para detectar uma tentativa de slash command e orientar.', 'The product uses Guilds, GuildVoiceStates, and DirectMessages. Do not enable Message Content, Guild Members, or Presence. In DMs with the bot, it reads only what is needed to detect a slash-command attempt and provide guidance.'))}</p></div></article>
      </div>
      ${inviteUrl}
      <div class="callout"><strong>${esc(T('Projeto independente.', 'Independent project.'))}</strong><p>${esc(T('Kassinão não é afiliado, patrocinado nem endossado pelo Discord. O operador continua responsável pela própria Application e pelo uso permitido dos dados da API.', 'Kassinão is not affiliated with, sponsored by, or endorsed by Discord. The operator remains responsible for their own Application and permitted use of API data.'))}</p></div>
    </section>

    <section class="doc-section" id="comandos" data-doc-section data-keywords="commands gravar record stop note status recordings autorecord config ask mcp help about">
      <div class="section-head"><h2>${esc(T('Comandos refletem as capacidades ligadas.', 'Commands reflect enabled capabilities.'))}</h2><p>${esc(T('Os nomes aparecem em PT-BR ou inglês conforme o locale do Discord. Recursos opcionais não devem parecer parte automática da gravação.', 'Names appear in PT-BR or English according to the Discord locale. Optional features must not look like an automatic part of recording.'))}</p></div>
      <div class="command-grid">${commandCards}</div>
    </section>

    <section class="doc-section" id="acesso" data-doc-section data-keywords="access acl oauth guild membership retention provider egress privacy deletion backup encryption">
      <div class="section-head"><h2>${esc(T('Acesso e dados são decisões da instância.', 'Access and data are instance decisions.'))}</h2><p>${esc(T('A política pública em APP_URL/privacy abre sem login e é renderizada pelo core com a configuração real do operador. Ela não pode ser substituída por uma política genérica do projeto.', "The public policy at APP_URL/privacy opens without login and is rendered by the core using the operator's actual configuration. It cannot be replaced with a generic project policy."))}</p></div>
      <div class="privacy-layout"><div class="privacy-rules">
        <article class="privacy-rule"><h3>${esc(T('A política descreve os dados reais', 'The policy describes actual data'))}</h3><p>${esc(T('Ela cobre perfil e IDs do Discord, presença na call, áudio, notas, artefatos de texto, metadados, sessões web, tokens MCP, providers, retenção e o processo do operador para responder solicitações.', 'It covers Discord profile and IDs, call presence, audio, notes, text artifacts, metadata, web sessions, MCP tokens, providers, retention, and the operator process for handling requests.'))}</p></article>
        <article class="privacy-rule"><h3>${esc(T('Login e membership atuais', 'Current login and membership'))}</h3><p>${esc(T('O app usa OAuth do Discord e exige vínculo atual com uma guild da allowlist. Sair da guild encerra o acesso.', 'The app uses Discord OAuth and requires current membership in an allowlisted guild. Leaving the guild ends access.'))}</p></article>
        <article class="privacy-rule"><h3>${esc(T('ACL histórica da reunião', 'Historical meeting ACL'))}</h3><p>${esc(T('Abre para quem iniciou, esteve na call ou tem Gerenciar Servidor agora. Ganhar acesso ao canal depois não abre o passado. OWNER_IDS não concede acesso universal às gravações.', 'Access is granted to the starter, call participants, or someone with Manage Server now. Later channel access does not unlock history. OWNER_IDS does not grant universal recording access.'))}</p></article>
        <article class="privacy-rule"><h3>${esc(T('Falha fechada', 'Fail closed'))}</h3><p>${esc(T('Se o Discord não confirma membership ou permissão, web e bot negam; a API MCP responde indisponibilidade temporária quando a checagem falha transitoriamente.', 'If Discord cannot confirm membership or permission, web and bot deny access; the MCP API returns temporary unavailability when the check fails transiently.'))}</p></article>
        <article class="privacy-rule"><h3>${esc(T('Busca limitada e paginada', 'Bounded and paginated search'))}</h3><p>${esc(T('A busca no app opera sobre a página carregada e seus limites. Ela não promete indexação global ilimitada do acervo.', 'Private-app search operates over the loaded page and its limits. It does not promise unlimited global indexing of the archive.'))}</p></article>
        <article class="privacy-rule"><h3>${esc(T('Storage ativo e backup são controles diferentes', 'Active storage and backup are separate controls'))}</h3><p>${esc(T('O kit exige dados ativos, auth e cache em dm-crypt/LUKS, com swap desabilitado ou também criptografado. O backup inclui recordings e state, exclui auth e usa um remote rclone crypt. Um backup criptografado não substitui a criptografia do volume ativo.', 'The bundle requires active data, auth, and cache on dm-crypt/LUKS, with swap disabled or encrypted as well. Backups include recordings and state, exclude auth, and use an rclone crypt remote. An encrypted backup does not replace active-volume encryption.'))}</p></article>
        <article class="privacy-rule"><h3>${esc(T('Direitos sobre dados', 'Data rights'))}</h3><p>${esc(T('A política identifica o operador e oferece um canal para pedir acesso, correção ou exclusão. Solicitações reais nunca devem ser abertas em issue pública do projeto.', 'The policy identifies the operator and offers a channel for access, correction, or deletion requests. Real requests must never be opened in a public project issue.'))}</p></article>
      </div><aside class="permission-box"><h3>${esc(T('Defaults de uma instalação nova', 'New-install defaults'))}</h3><ul><li><code>TRANSCRIBE_PROVIDER=none</code></li><li><code>TRANSCRIBE_FALLBACK_PROVIDER=none</code></li><li><code>MINUTES_ENABLED=false</code></li><li><code>MCP_SECRET</code> ${esc(T('vazio', 'empty'))}</li><li><code>RETENTION_DAYS=7</code></li><li><code>TEXT_RETENTION_DAYS=90</code></li></ul></aside></div>
      <h3>${esc(T('Configuração essencial', 'Essential configuration'))}</h3><p>${esc(T('A lista completa, com limites e providers, fica no .env.example. Aqui estão apenas os controles que mudam a fronteira de produto e segurança.', 'The complete list, including limits and providers, lives in .env.example. These are only the controls that change the product and security boundary.'))}</p><div class="env-groups">${envCards}</div>
      <h3>${esc(T('Egress por provider', 'Provider egress'))}</h3><div class="provider-layout"><div class="provider-list"><div class="provider"><strong>${esc(T('Gravação', 'Recording'))}</strong><span>${esc(T('Fica na instância até a retenção ou exclusão.', 'Stays in the instance until retention or deletion.'))}</span></div><div class="provider"><strong>${esc(T('ASR externo', 'External ASR'))}</strong><span>${esc(T('Recebe áudio quando selecionado. TRANSCRIBE_SEND_MEETING_CONTEXT controla nomes automáticos do Discord; prompt e keyterms configurados manualmente também podem sair. Um comando customizado recebe o áudio e pode usar rede.', 'Receives audio when selected. TRANSCRIBE_SEND_MEETING_CONTEXT controls automatic Discord names; manually configured prompts and keyterms may also leave. A custom command receives audio and may use the network.'))}</span></div><div class="provider"><strong>${esc(T('Ata por IA', 'AI minutes'))}</strong><span>${esc(T('Recebe texto somente com MINUTES_ENABLED=true e provider configurado.', 'Receives text only with MINUTES_ENABLED=true and a configured provider.'))}</span></div><div class="provider"><strong>Webhook</strong><span>${esc(T('Recebe ID e link da gravação, servidor, canal, horários, participantes e ata, com URL HTTPS e HMAC dedicado.', 'Receives recording ID and link, server, channel, timestamps, participants, and minutes, using an HTTPS URL and dedicated HMAC.'))}</span></div><div class="provider"><strong>MCP</strong><span>${esc(T('Entrega texto e metadados autorizados ao dispositivo e ao host MCP escolhido pelo membro.', 'Delivers authorized text and metadata to the member device and chosen MCP host.'))}</span></div></div><aside class="pipeline-note"><h3>${esc(T('Cada integração tem seu próprio opt-in.', 'Each integration has its own opt-in.'))}</h3><p>${esc(T('Transcrição e ata exigem flags explícitas. Definir MCP_SECRET habilita o MCP; URL e segredo habilitam o webhook. Documente os providers realmente usados na política da sua instância.', 'Transcription and minutes require explicit flags. Setting MCP_SECRET enables MCP; URL and secret enable the webhook. Document the providers actually used in your instance policy.'))}</p></aside></div>
    </section>

    <section class="doc-section" id="mcp" data-doc-section data-keywords="mcp connector tools token exchange revoke read only instance url">
      <div class="section-head"><h2>${esc(T('MCP consulta a sua instância, não um serviço central.', 'MCP queries your instance, not a central service.'))}</h2><p>${esc(T('O pacote público kassinao-mcp se conecta ao MCP_URL escolhido pelo operador. KASSINAO_URL é obrigatório e não possui fallback para uma instância oficial.', 'The public kassinao-mcp package connects to the MCP_URL selected by the operator. KASSINAO_URL is required and has no fallback to an official instance.'))}</p></div>
      <div class="callout"><strong>${esc(T('As cinco tools atuais são somente leitura.', 'The current five tools are read-only.'))}</strong><p>${esc(T('Elas não entregam áudio, não iniciam ou apagam gravações e não contornam a ACL. O conector pede dados autorizados à API; ele não monta nem lê diretamente os arquivos do servidor.', 'They do not serve audio, start or delete recordings, or bypass the ACL. The connector requests authorized data from the API; it does not mount or directly read server files.'))}</p></div>
      <div class="mcp-tools"><article class="mcp-tool"><code>list_meetings</code><p>${esc(T('Lista reuniões acessíveis.', 'Lists accessible meetings.'))}</p></article><article class="mcp-tool"><code>pending_actions</code><p>${esc(T('Organiza ações e prazos acessíveis.', 'Organizes accessible actions and deadlines.'))}</p></article><article class="mcp-tool"><code>search_meetings</code><p>${esc(T('Busca texto dentro dos limites da API.', 'Searches text within API limits.'))}</p></article><article class="mcp-tool"><code>who_said</code><p>${esc(T('Busca atribuição por conta do Discord.', 'Searches attribution by Discord account.'))}</p></article><article class="mcp-tool"><code>get_meeting</code><p>${esc(T('Abre os dados autorizados de uma reunião.', 'Returns authorized meeting data.'))}</p></article></div>
      <h3>${esc(T('Conexão e revogação', 'Connection and revocation'))}</h3><p>${esc(T('Ative com MCP_SECRET dedicado. Cada membro gera no app privado um código de troca curto e descartável, salva o refresh token no próprio perfil local e pode revogar a conexão. O slash command fica oculto para quem não tem Gerenciar Servidor e a execução continua restrita a OWNER_IDS.', 'Enable it with a dedicated MCP_SECRET. Each member creates a short-lived one-time exchange code in the private app, stores the refresh token in their own local profile, and can revoke the connection. The slash command is hidden from members without Manage Server and execution remains restricted to OWNER_IDS.'))}</p>${mcpSetup}
      <p>${esc(T('Teste o cliente e a versão que sua organização escolheu antes de declarar compatibilidade. Conteúdo de reunião é marcado como não confiável, mas isso é defesa em profundidade, não garantia contra prompt injection.', 'Test the client and version selected by your organization before claiming compatibility. Meeting content is marked untrusted, but that is defense in depth, not a guarantee against prompt injection.'))}</p>
    </section>

    <section class="doc-section" id="operacao" data-doc-section data-keywords="upgrade backup restore domain migration decommission rotate release audit">
      <div class="section-head"><h2>${esc(T('Opere mudanças como mudanças de segurança.', 'Operate changes as security changes.'))}</h2><p>${esc(T('Upgrade, restauração, troca de domínio e encerramento alteram dados, OAuth ou fronteiras de rede. Faça cada um com janela, backup e validação.', 'Upgrade, restore, domain migration, and shutdown change data, OAuth, or network boundaries. Perform each with a maintenance window, backup, and validation.'))}</p></div>
      <div class="install-steps">
        <article class="install-step"><h3>${esc(T('Upgrade', 'Upgrade'))}</h3><div><p>${esc(T('Verifique a nova release e o bundle numa máquina confiável. Faça backup coerente, instale em novo diretório root-owned, preserve os diretórios de dados, rode deploy e audit, valide /health e um fluxo real, e só então troque o current. Nunca faça build na VPS.', 'Verify the new release and bundle on a trusted workstation. Create a consistent backup, install in a new root-owned directory, preserve data directories, run deploy and audit, validate /health and a real flow, and only then switch current. Never build on the VPS.'))}</p></div></article>
        <article class="install-step"><h3>${esc(T('Backup', 'Backup'))}</h3><div><p>${esc(T('scripts/backup.sh exige o writer parado ou BACKUP_STOP_CONTAINER=true, prova dm-crypt/LUKS e remote rclone crypt. O arquivo contém somente recordings e state; auth, sessões, cache e segredos ficam de fora por construção.', 'scripts/backup.sh requires a stopped writer or BACKUP_STOP_CONTAINER=true, proves dm-crypt/LUKS, and requires an rclone crypt remote. The archive contains only recordings and state; auth, sessions, cache, and secrets are excluded by construction.'))}</p></div></article>
        <article class="install-step"><h3>${esc(T('Restauração', 'Restore'))}</h3><div><p>${esc(T('Restaure somente um archive com manifesto kassinao-backup-v2 em storage LUKS vazio, com o core parado. Recrie auth e credenciais em vez de copiar de outra instância, ajuste owner/mode, suba o mesmo release verificado, audite e faça teste de acesso antes de reabrir.', 'Restore only an archive with a kassinao-backup-v2 manifest into empty LUKS storage with the core stopped. Recreate auth and credentials instead of copying them from another instance, fix ownership and modes, start the same verified release, audit, and test access before reopening.'))}</p></div></article>
        <article class="install-step"><h3>${esc(T('Troca de domínio', 'Domain migration'))}</h3><div><p>${esc(T('Escolha as quatro origens novas, configure DNS/túnel e certificados, atualize APP_URL, MCP_URL, PUBLIC_URL, DOCS_URL, política e contato. No Discord Portal, troque OAuth Redirect para APP_URL/auth/callback e Privacy Policy para APP_URL/privacy. Reinicie, invalide sessões/conectores quando necessário, valide POSTs e só depois remova os hosts antigos.', 'Choose the four new origins, configure DNS or tunnel and certificates, then update APP_URL, MCP_URL, PUBLIC_URL, DOCS_URL, policy, and contact. In the Discord Portal, change OAuth Redirect to APP_URL/auth/callback and Privacy Policy to APP_URL/privacy. Restart, invalidate sessions and connectors when needed, validate POST requests, and only then remove old hosts.'))}</p></div></article>
        <article class="install-step"><h3>${esc(T('Remover controles do host', 'Remove host controls'))}</h3><div><p>${esc(T('Faça isso somente ao mover ou encerrar a instância. Primeiro use docker compose down; alternativamente, todos os containers Kassinão precisam estar parados e com restart=no. O uninstall recusa snapshots pendentes e drift, remove somente os artefatos exatos instalados, não para containers, não reinicia o Docker e nunca apaga KASSINAO_DATA_ROOT. Um snapshot de deploy falho precisa expirar pelo timer ou ser resolvido por um deploy saudável antes da remoção.', 'Do this only when moving or shutting down the instance. First run docker compose down; alternatively, every Kassinão container must be stopped with restart=no. The uninstall rejects pending snapshots and drift, removes only the exact installed artifacts, does not stop containers, does not restart Docker, and never deletes KASSINAO_DATA_ROOT. A failed-deploy snapshot must expire through the timer or be resolved by a healthy deployment before removal.'))}</p></div></article>
        <article class="install-step"><h3>${esc(T('Desativação', 'Decommission'))}</h3><div><p>${esc(T('Pare bot e túnel, confirme zero gravações ativas, revogue token e Client Secret do Discord, MCP, providers, webhook e túnel, remova callbacks e DNS, aplique a política de retenção ao backup e destrua com segurança volumes, snapshots e envs. Preserve apenas o que a política e a obrigação legal exigirem.', 'Stop the bot and tunnel, confirm zero active recordings, revoke Discord token and Client Secret, MCP, providers, webhook, and tunnel credentials, remove callbacks and DNS, apply retention policy to backups, and securely destroy volumes, snapshots, and env files. Preserve only what policy and legal obligations require.'))}</p></div></article>
      </div>
      ${uninstallHostControls}
    </section>

    <section class="doc-section" id="problemas" data-doc-section data-keywords="troubleshooting boot commands oauth origin policy transcript minutes mcp access disk audit">
      <div class="section-head"><h2>${esc(T('Diagnóstico começa pelo gate que falhou.', 'Troubleshooting starts at the failed gate.'))}</h2><p>${esc(T('Não afrouxe firewall, proxy, ACL ou validação de origem para fazer um erro desaparecer.', 'Do not weaken firewall, proxy, ACL, or origin validation to make an error disappear.'))}</p></div>
      <div class="troubleshooting">
        <details class="trouble"><summary>${esc(T('O container não inicia', 'The container does not start'))}</summary><div class="trouble-body"><p>${esc(T('Leia docker compose logs --tail=200 kassinao. Confirme credenciais, APP_URL, allowlist e os campos públicos do operador. Em produção, URLs exigidas usam HTTPS e host público.', 'Read docker compose logs --tail=200 kassinao. Confirm credentials, APP_URL, allowlist, and public operator fields. In production, required URLs use HTTPS and a public host.'))}</p></div></details>
        <details class="trouble"><summary>${esc(T('Os comandos não aparecem', 'Commands do not appear'))}</summary><div class="trouble-body"><p>${esc(T('Confirme Guild Install, scopes bot e applications.commands, guild na allowlist e registro concluído. /perguntar e /mcp dependem das respectivas capacidades.', 'Confirm Guild Install, bot and applications.commands scopes, the guild allowlist, and completed registration. /ask and /mcp depend on their respective capabilities.'))}</p></div></details>
        <details class="trouble"><summary>${esc(T('OAuth retorna origem inválida', 'OAuth returns invalid origin'))}</summary><div class="trouble-body"><p>${esc(T('APP_URL é uma origem sem caminho. O Redirect cadastrado é exatamente APP_URL/auth/callback. Depois de trocar domínio, atualize Portal, env e processo antes de testar novamente.', 'APP_URL is a pathless origin. The registered Redirect is exactly APP_URL/auth/callback. After a domain change, update the Portal, env, and process before testing again.'))}</p></div></details>
        <details class="trouble"><summary>${esc(T('Há áudio, mas não transcrição ou ata', 'Audio exists, but transcript or minutes do not'))}</summary><div class="trouble-body"><p>${esc(T('Isso é normal com os defaults. Transcrição exige provider explícito; ata exige alguma transcrição disponível, MINUTES_ENABLED=true, provider e chave. Uma transcrição parcial pode gerar uma ata incompleta. Consulte a fila sem habilitar LOG_PII fora de uma janela controlada.', 'This is normal with defaults. Transcription requires an explicit provider; minutes require some available transcript, MINUTES_ENABLED=true, a provider, and a key. A partial transcript can produce incomplete minutes. Inspect the queue without enabling LOG_PII outside a controlled window.'))}</p></div></details>
        <details class="trouble"><summary>${esc(T('MCP retorna 404 ou 503', 'MCP returns 404 or 503'))}</summary><div class="trouble-body"><p>${esc(T('404 é esperado quando MCP_SECRET está vazio ou a rota não pertence ao host MCP. 503 indica que o Discord não confirmou membership de forma transitória; não transforme isso em allow.', '404 is expected when MCP_SECRET is empty or the route is not on the MCP host. 503 means Discord did not confirm membership transiently; never turn it into allow.'))}</p></div></details>
        <details class="trouble"><summary>${esc(T('O audit da VPS falha', 'The VPS audit fails'))}</summary><div class="trouble-body"><p>${esc(T('Corrija o item relatado. O audit reprova, entre outros, checkout Git, imagem sem digest, storage sem LUKS, topologia não split, portas externas, permissões frouxas e segredos no processo público.', 'Fix the reported item. The audit rejects, among other issues, a Git checkout, an image without a digest, storage without LUKS, non-split topology, external ports, loose permissions, and secrets in the public process.'))}</p></div></details>
      </div>
    </section>

    <section class="doc-section" id="links" data-doc-section data-keywords="links demo github env privacy security license discord npm">
      <div class="section-head"><h2>${esc(T('Referências e canais corretos', 'References and proper channels'))}</h2><p>${esc(T('Use links públicos para o projeto. Dados e solicitações de uma instância vão para o contato do operador, nunca para uma issue.', 'Use public links for the project. Instance data and requests go to the operator contact, never to an issue.'))}</p></div>
      <div class="link-grid"><a class="resource-link" href="${site.links.demo}"><strong>${esc(T('Demo pública', 'Public demo'))}</strong><span>${esc(T('Fluxo fictício na interface real.', 'Fictional flow in the real interface.'))}</span></a><a class="resource-link" href="${repoUrl}" target="_blank" rel="noreferrer"><strong>GitHub</strong><span>${esc(T('Source e README.', 'Source and README.'))}</span></a><a class="resource-link" href="${repoUrl}/blob/main/.env.example" target="_blank" rel="noreferrer"><strong>.env.example</strong><span>${esc(T('Referência completa de configuração.', 'Complete configuration reference.'))}</span></a><a class="resource-link" href="${NPM_URL}" target="_blank" rel="noopener noreferrer"><strong>kassinao-mcp</strong><span>${esc(T('Pacote público do conector.', 'Public connector package.'))}</span></a><a class="resource-link" href="${repoUrl}/blob/main/SECURITY.md" target="_blank" rel="noreferrer"><strong>SECURITY.md</strong><span>${esc(T('Reporte vulnerabilidades em privado.', 'Report vulnerabilities privately.'))}</span></a><a class="resource-link" href="${repoUrl}/blob/main/PRIVACY.md" target="_blank" rel="noreferrer"><strong>PRIVACY.md</strong><span>${esc(T('Política do projeto e responsabilidade do operador.', 'Project policy and operator responsibility.'))}</span></a><a class="resource-link" href="${repoUrl}/blob/main/LICENSE" target="_blank" rel="noreferrer"><strong>AGPL-3.0</strong><span>${esc(T('Licença e source correspondente.', 'License and corresponding source.'))}</span></a><a class="resource-link" href="https://discord.com/developers/applications" target="_blank" rel="noreferrer"><strong>Discord Developer Portal</strong><span>${esc(T('Application, bot, instalação e OAuth.', 'Application, bot, installation, and OAuth.'))}</span></a></div>
    </section>

    <section class="no-results" id="no-results" hidden><h2>${esc(T('Nada encontrado', 'Nothing found'))}</h2><p>${esc(T('Tente gravar, OAuth, privacidade, retenção, backup ou domínio.', 'Try record, OAuth, privacy, retention, backup, or domain.'))}</p></section>
    <footer class="docs-footer"><p>Kassinão. ${esc(T('Bot de Discord self-hosted sob AGPL-3.0.', 'Self-hosted Discord bot under AGPL-3.0.'))} <a href="${altDocs}">${esc(T('Read in English', 'Ler em português'))}</a>.</p></footer>
  </div></main>
</div>
${docsScript(l)}
</body>
</html>`;
}
