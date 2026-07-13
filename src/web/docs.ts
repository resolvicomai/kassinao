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

const REPO_URL = PUBLIC_LINKS.github;
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
    <div class="code-head"><span>${esc(label)}</span><button type="button" data-copy>${esc(copyLabel)}</button></div>
    <pre tabindex="0"><code>${esc(value)}</code></pre>
  </div>`;
}

const COMMANDS: CommandDoc[] = [
  {
    pt: '/gravar [canal]',
    en: '/record [channel]',
    description: {
      pt: 'Entra no seu canal de voz e começa uma gravação com uma faixa separada por pessoa. Admins podem indicar outro canal visível.',
      en: 'Joins your voice channel and starts a recording with one separate track per person. Admins can target another visible channel.',
    },
    access: { pt: 'Qualquer membro no próprio canal', en: 'Any member in their own channel' },
  },
  {
    pt: '/parar',
    en: '/stop',
    description: {
      pt: 'Encerra a gravação, libera o link privado e inicia a fila de transcrição e ata.',
      en: 'Ends the recording, provides the private link, and starts the transcript and minutes queue.',
    },
    access: { pt: 'Quem ainda enxerga o canal gravado', en: 'Anyone who can still see the recorded channel' },
  },
  {
    pt: '/nota <texto>',
    en: '/note <text>',
    description: {
      pt: 'Salva uma nota no segundo atual. O painel também oferece ações para marcar um momento ou escrever uma nota.',
      en: 'Saves a note at the current second. The panel also includes actions to mark a moment or write a note.',
    },
    access: { pt: 'Quem ainda enxerga o canal gravado', en: 'Anyone who can still see the recorded channel' },
  },
  {
    pt: '/status',
    en: '/status',
    description: {
      pt: 'Mostra o estado da gravação em andamento que você tem permissão para acompanhar.',
      en: 'Shows the current recording state when you have permission to follow it.',
    },
    access: { pt: 'Membro do servidor com acesso', en: 'Server member with access' },
  },
  {
    pt: '/gravacoes',
    en: '/recordings',
    description: {
      pt: 'Lista gravações acessíveis e abre a central privada com busca em transcrições, atas e notas.',
      en: 'Lists accessible recordings and opens the private workspace with search across transcripts, minutes, and notes.',
    },
    access: { pt: 'Resultados filtrados por acesso', en: 'Results filtered by access' },
  },
  {
    pt: '/perguntar <pergunta> [dias]',
    en: '/ask <question> [days]',
    description: {
      pt: 'Busca por tema, pessoa, data da call ou prazo e responde só para você com evidências e links para o segundo exato.',
      en: 'Searches by topic, person, call date, or deadline and replies only to you with evidence and links to the exact second.',
    },
    access: { pt: 'Somente reuniões que você pode abrir', en: 'Only meetings you are allowed to open' },
  },
  {
    pt: '/autorecord ligar|desligar|ver',
    en: '/autorecord on|off|view',
    description: {
      pt: 'Configura a gravação automática por canal e o mínimo de pessoas para iniciar.',
      en: 'Configures automatic recording per channel and the minimum number of people required to start.',
    },
    access: { pt: 'Gerenciar Servidor', en: 'Manage Server' },
  },
  {
    pt: '/config ata-canal|ver',
    en: '/config minutes-channel|view',
    description: {
      pt: 'Escolhe o canal de texto onde a ata resumida será publicada ou consulta a configuração atual.',
      en: 'Chooses the text channel where the minutes summary will be posted or displays the current configuration.',
    },
    access: { pt: 'Gerenciar Servidor', en: 'Manage Server' },
  },
  {
    pt: '/mcp novo|revogar-tudo',
    en: '/mcp new|revoke-all',
    description: {
      pt: 'Gera um código de conexão ou revoga conectores. Só aparece quando o MCP está habilitado. Membros comuns usam a página de conexão.',
      en: 'Generates a connection code or revokes connectors. It only appears when MCP is enabled. Regular members use the connection page.',
    },
    access: { pt: 'Somente IDs em OWNER_IDS', en: 'Only IDs listed in OWNER_IDS' },
  },
  {
    pt: '/ajuda',
    en: '/help',
    description: {
      pt: 'Abre o guia interativo do bot com gravação, downloads, perguntas, privacidade e auto-record.',
      en: 'Opens the interactive bot guide for recording, downloads, questions, privacy, and auto-record.',
    },
    access: { pt: 'Qualquer membro', en: 'Any member' },
  },
  {
    pt: '/sobre',
    en: '/about',
    description: {
      pt: 'Mostra autor, licença AGPL-3.0 e código-fonte.',
      en: 'Shows the author, AGPL-3.0 license, and source code.',
    },
    access: { pt: 'Qualquer membro', en: 'Any member' },
  },
];

const ENV_GROUPS: EnvGroup[] = [
  {
    title: { pt: 'Discord e acesso web', en: 'Discord and web access' },
    summary: {
      pt: 'Identidade do bot, OAuth, URL pública e idioma.',
      en: 'Bot identity, OAuth, public URL, and language.',
    },
    items: [
      {
        name: 'DISCORD_TOKEN',
        fallback: { pt: 'obrigatória', en: 'required' },
        description: {
          pt: 'Token do bot criado no Discord Developer Portal.',
          en: 'Bot token created in the Discord Developer Portal.',
        },
      },
      {
        name: 'APPLICATION_ID',
        fallback: { pt: 'obrigatória', en: 'required' },
        description: {
          pt: 'ID da aplicação usado para registrar os comandos.',
          en: 'Application ID used to register commands.',
        },
      },
      {
        name: 'DISCORD_CLIENT_SECRET',
        fallback: { pt: 'obrigatória', en: 'required' },
        description: {
          pt: 'Client Secret do OAuth usado no login das páginas privadas.',
          en: 'OAuth Client Secret used for private-page login.',
        },
      },
      {
        name: 'APP_URL',
        fallback: { pt: 'BASE_URL ou http://localhost:8080', en: 'BASE_URL or http://localhost:8080' },
        description: {
          pt: 'Origem privada do app, OAuth, gravações e downloads. Cadastre APP_URL/auth/callback como redirect do Discord.',
          en: 'Private origin for the app, OAuth, recordings, and downloads. Register APP_URL/auth/callback as a Discord redirect.',
        },
      },
      {
        name: 'BASE_URL',
        fallback: { pt: 'vazio', en: 'empty' },
        description: {
          pt: 'Alias retrocompatível de APP_URL. Instalações novas devem preferir APP_URL.',
          en: 'Backward-compatible alias for APP_URL. New installations should prefer APP_URL.',
        },
      },
      {
        name: 'PUBLIC_URL',
        fallback: 'APP_URL',
        description: {
          pt: 'Origem da landing e da demo pública. Deixe igual ao app quando usar um único domínio.',
          en: 'Origin for the landing page and public demo. Keep it equal to the app when using one domain.',
        },
      },
      {
        name: 'DOCS_URL',
        fallback: 'PUBLIC_URL',
        description: {
          pt: 'Origem da documentação. Quando separada, português fica em / e inglês em /en.',
          en: 'Documentation origin. When separate, Portuguese lives at / and English at /en.',
        },
      },
      {
        name: 'MCP_URL',
        fallback: 'APP_URL',
        description: {
          pt: 'Origem pública da API MCP. O conector usa este valor em KASSINAO_URL.',
          en: 'Public origin for the MCP API. The connector uses this value as KASSINAO_URL.',
        },
      },
      {
        name: 'LEGACY_URL',
        fallback: { pt: 'vazio', en: 'empty' },
        description: {
          pt: 'Origem anterior durante migração. Mantém links e clientes antigos funcionando até a retirada planejada.',
          en: 'Previous origin during a migration. Keeps old links and clients working until planned retirement.',
        },
      },
      {
        name: 'GUILD_ID',
        fallback: { pt: 'vazio', en: 'empty' },
        description: {
          pt: 'Opcional. Limita o registro imediato de comandos a um servidor.',
          en: 'Optional. Limits immediate command registration to one server.',
        },
      },
      {
        name: 'PORT',
        fallback: '8080',
        description: {
          pt: 'Porta HTTP interna do servidor Express.',
          en: 'Internal HTTP port for the Express server.',
        },
      },
      {
        name: 'TUNNEL_TOKEN',
        fallback: { pt: 'vazio', en: 'empty' },
        description: {
          pt: 'Token do Cloudflare Tunnel. Ative também o profile tunnel.',
          en: 'Cloudflare Tunnel token. Also enable the tunnel profile.',
        },
      },
      {
        name: 'COMPOSE_PROFILES',
        fallback: { pt: 'vazio', en: 'empty' },
        description: {
          pt: 'Use tunnel para subir o Cloudflare Tunnel junto com o bot.',
          en: 'Use tunnel to start Cloudflare Tunnel alongside the bot.',
        },
      },
      {
        name: 'COOKIE_SECRET',
        fallback: { pt: 'gerado e persistido', en: 'generated and persisted' },
        description: {
          pt: 'Segredo de sessão com no mínimo 32 bytes. Se vazio, o bot cria um no volume.',
          en: 'Session secret with at least 32 bytes. When empty, the bot creates one in the volume.',
        },
      },
      {
        name: 'REPO_PUBLIC',
        fallback: 'false',
        description: {
          pt: 'Libera links públicos para o repositório na interface.',
          en: 'Enables public repository links in the interface.',
        },
      },
      {
        name: 'DEFAULT_LOCALE',
        fallback: 'en',
        description: {
          pt: 'Idioma de fallback quando o Discord não fornece o locale.',
          en: 'Fallback language when Discord does not provide a locale.',
        },
      },
      {
        name: 'TZ',
        fallback: 'America/Sao_Paulo',
        description: {
          pt: 'Fuso de fallback para datas. Na web, o navegador tem prioridade.',
          en: 'Fallback timezone for dates. On the web, the browser takes priority.',
        },
      },
    ],
  },
  {
    title: { pt: 'Gravação, retenção e disco', en: 'Recording, retention, and disk' },
    summary: {
      pt: 'Arquivos, duração, qualidade, expiração e guardas operacionais.',
      en: 'Files, duration, quality, expiration, and operational guards.',
    },
    items: [
      {
        name: 'RECORDINGS_DIR',
        fallback: './recordings',
        description: {
          pt: 'Diretório persistente das gravações. No Docker, usa /app/recordings.',
          en: 'Persistent recordings directory. Docker uses /app/recordings.',
        },
      },
      {
        name: 'RETENTION_DAYS',
        fallback: '7',
        description: {
          pt: 'Dias até o áudio expirar. Zero desliga toda expiração automática.',
          en: 'Days until audio expires. Zero disables all automatic expiration.',
        },
      },
      {
        name: 'TEXT_RETENTION_DAYS',
        fallback: '90',
        description: {
          pt: 'Retenção de transcrição, ata e notas. Nunca fica menor que a retenção do áudio.',
          en: 'Retention for transcript, minutes, and notes. Never lower than audio retention.',
        },
      },
      {
        name: 'MAX_RECORDING_HOURS',
        fallback: '6',
        description: { pt: 'Duração máxima de cada gravação.', en: 'Maximum duration of each recording.' },
      },
      {
        name: 'MANUAL_RECORD_USER_COOLDOWN_SEC',
        fallback: '60',
        description: {
          pt: 'Cooldown global por membro comum entre inícios manuais. Admins ignoram.',
          en: 'Global cooldown per regular member between manual starts. Admins bypass it.',
        },
      },
      {
        name: 'MANUAL_RECORD_GUILD_COOLDOWN_SEC',
        fallback: '15',
        description: {
          pt: 'Cooldown do servidor entre inícios manuais de membros comuns.',
          en: 'Server cooldown between manual starts by regular members.',
        },
      },
      {
        name: 'MANUAL_RECORD_GUILD_STARTS_PER_24H',
        fallback: '48',
        description: {
          pt: 'Teto móvel de 24 horas para inícios manuais por servidor. Admins não consomem a quota.',
          en: 'Rolling 24-hour cap for manual starts per server. Admins do not consume the quota.',
        },
      },
      {
        name: 'MP3_BITRATE',
        fallback: '192k',
        description: {
          pt: 'Bitrate dos MP3 individuais e do mix.',
          en: 'Bitrate for individual MP3 files and the mix.',
        },
      },
      {
        name: 'MIN_FREE_MB_START',
        fallback: '500',
        description: {
          pt: 'Espaço livre mínimo para iniciar uma gravação.',
          en: 'Minimum free space required to start a recording.',
        },
      },
      {
        name: 'MIN_FREE_MB_ABORT',
        fallback: '150',
        description: {
          pt: 'Espaço livre que força uma parada segura durante a gravação.',
          en: 'Free-space threshold that triggers a safe stop during recording.',
        },
      },
      {
        name: 'DISK_ALERT_PCT',
        fallback: '85',
        description: {
          pt: 'Percentual de uso que envia alerta por DM aos OWNER_IDS.',
          en: 'Usage percentage that sends a DM alert to OWNER_IDS.',
        },
      },
    ],
  },
  {
    title: { pt: 'Transcrição e ata', en: 'Transcription and minutes' },
    summary: {
      pt: 'Provider de voz, vocabulário, modelo local e geração da ata.',
      en: 'Speech provider, vocabulary, local model, and minutes generation.',
    },
    items: [
      {
        name: 'TRANSCRIBE_PROVIDER',
        fallback: 'none',
        description: {
          pt: 'none, assemblyai, openai, groq, gemini ou command.',
          en: 'none, assemblyai, openai, groq, gemini, or command.',
        },
      },
      {
        name: 'TRANSCRIBE_MODEL',
        fallback: { pt: 'padrão do provider', en: 'provider default' },
        description: {
          pt: 'Sobrescreve o modelo do provider escolhido.',
          en: 'Overrides the selected provider model.',
        },
      },
      {
        name: 'TRANSCRIBE_LANGUAGE',
        fallback: 'pt',
        description: { pt: 'Idioma falado nas calls.', en: 'Language spoken in calls.' },
      },
      {
        name: 'TRANSCRIBE_PROMPT',
        fallback: { pt: 'contexto neutro pt-BR', en: 'neutral pt-BR context' },
        description: {
          pt: 'Contexto de nomes, vocabulário e estilo para o ASR.',
          en: 'Names, vocabulary, and style context for ASR.',
        },
      },
      {
        name: 'TRANSCRIBE_KEYTERMS',
        fallback: { pt: 'vazio', en: 'empty' },
        description: {
          pt: 'Vocabulário fixo separado por vírgulas para AssemblyAI Universal-3.5-Pro.',
          en: 'Comma-separated fixed vocabulary for AssemblyAI Universal-3.5-Pro.',
        },
      },
      {
        name: 'ASSEMBLYAI_API_KEY / OPENAI_API_KEY / GROQ_API_KEY / GEMINI_API_KEY',
        fallback: { pt: 'vazio', en: 'empty' },
        description: {
          pt: 'Defina apenas as chaves dos providers usados.',
          en: 'Set only the keys for providers you use.',
        },
      },
      {
        name: 'TRANSCRIBE_COMMAND',
        fallback: { pt: 'vazio', en: 'empty' },
        description: {
          pt: 'Comando local com os placeholders {input} e {output}.',
          en: 'Local command with {input} and {output} placeholders.',
        },
      },
      {
        name: 'TRANSCRIBE_TIMEOUT_FACTOR',
        fallback: '5',
        description: {
          pt: 'Multiplicador de timeout do transcritor local.',
          en: 'Timeout multiplier for the local transcriber.',
        },
      },
      {
        name: 'WHISPER_MODEL',
        fallback: 'small',
        description: {
          pt: 'Modelo usado pelo wrapper local faster-whisper.',
          en: 'Model used by the local faster-whisper wrapper.',
        },
      },
      {
        name: 'MINUTES_ENABLED',
        fallback: 'auto',
        description: {
          pt: 'auto, true ou false. Auto liga com uma chave OpenRouter ou Groq.',
          en: 'auto, true, or false. Auto enables with an OpenRouter or Groq key.',
        },
      },
      {
        name: 'MINUTES_PROVIDER / MINUTES_MODEL',
        fallback: { pt: 'openrouter ou groq', en: 'openrouter or groq' },
        description: {
          pt: 'Provider e modelo usados para resumo, decisões e tarefas.',
          en: 'Provider and model used for summaries, decisions, and tasks.',
        },
      },
      {
        name: 'OPENROUTER_API_KEY',
        fallback: { pt: 'vazio', en: 'empty' },
        description: { pt: 'Chave para a ata via OpenRouter.', en: 'Key for minutes through OpenRouter.' },
      },
      {
        name: 'MINUTES_MAX_TOKENS',
        fallback: '8192',
        description: { pt: 'Teto de tokens de saída da ata.', en: 'Maximum output tokens for minutes.' },
      },
      {
        name: 'MINUTES_WEBHOOK_URL',
        fallback: { pt: 'vazio', en: 'empty' },
        description: {
          pt: 'Webhook definido só por env. Recebe minutes.ready quando a ata fica pronta.',
          en: 'Env-only webhook. Receives minutes.ready when minutes are ready.',
        },
      },
    ],
  },
  {
    title: { pt: 'Conector MCP', en: 'MCP connector' },
    summary: {
      pt: 'Ativação deliberada, allowlist e validade dos tokens.',
      en: 'Deliberate activation, allowlist, and token lifetimes.',
    },
    items: [
      {
        name: 'MCP_SECRET',
        fallback: { pt: 'desligado', en: 'disabled' },
        description: {
          pt: 'Segredo dedicado com no mínimo 32 bytes. Ativa a API e o conector.',
          en: 'Dedicated secret with at least 32 bytes. Enables the API and connector.',
        },
      },
      {
        name: 'OWNER_IDS',
        fallback: { pt: 'vazio', en: 'empty' },
        description: {
          pt: 'IDs do Discord autorizados a usar /mcp e receber alertas de disco.',
          en: 'Discord IDs allowed to use /mcp and receive disk alerts.',
        },
      },
      {
        name: 'MCP_ACCESS_TTL_MIN',
        fallback: '15',
        description: {
          pt: 'Validade do token curto de acesso, em minutos.',
          en: 'Short-lived access token duration in minutes.',
        },
      },
      {
        name: 'MCP_REFRESH_TTL_DAYS',
        fallback: '30',
        description: {
          pt: 'Validade do refresh token rotativo, em dias.',
          en: 'Rotating refresh-token duration in days.',
        },
      },
    ],
  },
];

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
  margin-left: auto;
  padding: 0 10px;
  border: 1px solid #525357;
  border-radius: 6px;
  background: #28282c;
  color: #f0f1f5;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}

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
  display: grid;
  gap: 10px;
}

.provider {
  display: grid;
  grid-template-columns: 132px minmax(0, 1fr);
  gap: 16px;
  padding: 16px;
  border-radius: var(--radius);
  background: var(--surface);
}

.provider strong { color: var(--text); }

.provider span { color: var(--muted); font-size: 14px; }

.pipeline-note {
  position: sticky;
  top: calc(var(--topbar) + 24px);
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--accent) 10%, var(--surface));
  padding: 22px;
}

.pipeline-note h3 { margin-top: 0; }

.pipeline-note p { color: var(--muted); }

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
  .provider-layout,
  .privacy-layout {
    grid-template-columns: 1fr;
  }

  .install-step { grid-template-columns: 1fr; gap: 8px; }

  .env-list,
  .command-grid,
  .mcp-tools,
  .link-grid { grid-template-columns: 1fr; }

  .provider { grid-template-columns: 1fr; gap: 4px; }

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

function renderCommands(lang: DocsLang): string {
  return COMMANDS.map(
    (command) => `<article class="command-card">
      <code>${esc(command[lang])}</code>
      <p>${esc(text(lang, command.description))}</p>
      <div class="command-meta">${esc(lang === 'pt' ? 'Acesso: ' : 'Access: ')}${esc(text(lang, command.access))}</div>
    </article>`,
  ).join('');
}

function renderEnvGroups(lang: DocsLang): string {
  return ENV_GROUPS.map(
    (group, index) => `<details class="env-group"${index === 0 ? ' open' : ''}>
      <summary>
        <span class="env-title"><strong>${esc(text(lang, group.title))}</strong><span>${esc(text(lang, group.summary))}</span></span>
      </summary>
      <dl class="env-list">
        ${group.items
          .map(
            (item) => `<div class="env-item">
              <dt>${esc(item.name)}</dt>
              <dd>
                <span class="env-default">${esc(lang === 'pt' ? 'Padrão: ' : 'Default: ')}${esc(localValue(lang, item.fallback))}</span>
                <span class="env-description">${esc(text(lang, item.description))}</span>
              </dd>
            </div>`,
          )
          .join('')}
      </dl>
    </details>`,
  ).join('');
}

function docsScript(lang: DocsLang): string {
  const messages =
    lang === 'pt'
      ? {
          copied: 'Copiado',
          copy: 'Copiar',
          result: 'seção encontrada',
          results: 'seções encontradas',
          noResults: 'Nenhuma seção encontrada',
        }
      : {
          copied: 'Copied',
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
      body.classList.toggle('nav-open', open);
      menuButton.setAttribute('aria-expanded', String(open));
      syncSidebar(open);
      if (open) search.focus();
    }

    function syncViewport() {
      if (window.innerWidth > 980) body.classList.remove('nav-open');
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

    Array.prototype.slice.call(document.querySelectorAll('[data-copy]')).forEach(function(button){
      button.addEventListener('click', function(){
        var code = button.closest('.code-block').querySelector('code').textContent || '';
        navigator.clipboard.writeText(code).then(function(){
          button.textContent = '${messages.copied}';
          window.setTimeout(function(){ button.textContent = '${messages.copy}'; }, 1400);
        }).catch(function(){ button.textContent = '${messages.copy}'; });
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
  const ptDocs = publicSite('docs', 'pt', config).canonicalUrl;
  const enDocs = publicSite('docs', 'en', config).canonicalUrl;
  const altDocs = site.links.alternate;
  const title = T('Documentação do Kassinão', 'Kassinão documentation');
  const copyLabel = T('Copiar', 'Copy');
  const description = T(
    'Instale e opere o bot de Discord que grava calls, transcreve cada pessoa e gera atas, decisões e tarefas.',
    'Install and operate the Discord bot that records calls, transcribes each person, and creates minutes, decisions, and tasks.',
  );
  const canonical = site.canonicalUrl;

  const clone = codeBlock(
    l === 'pt' ? 'Terminal' : 'Terminal',
    `git clone https://github.com/resolvicomai/kassinao.git
cd kassinao
cp .env.example .env`,
    copyLabel,
  );
  const start = codeBlock(
    l === 'pt' ? 'Terminal' : 'Terminal',
    `docker compose up -d --build
docker compose logs -f`,
    copyLabel,
  );
  const requiredEnv = codeBlock(
    '.env',
    `DISCORD_TOKEN=${T('cole_o_token_do_bot', 'paste_the_bot_token')}
APPLICATION_ID=${T('cole_o_id_da_aplicacao', 'paste_the_application_id')}
DISCORD_CLIENT_SECRET=${T('cole_o_client_secret', 'paste_the_client_secret')}
APP_URL=${T('https://kassinao.seu-dominio.com', 'https://kassinao.your-domain.com')}`,
    copyLabel,
  );
  const localTranscription = codeBlock(
    '.env',
    `TRANSCRIBE_PROVIDER=command
TRANSCRIBE_COMMAND=python3 ./scripts/transcribe-local.py {input} {output}
WHISPER_MODEL=small`,
    copyLabel,
  );
  const mcpConfig = codeBlock(
    'JSON',
    `{
  "mcpServers": {
    "kassinao": {
      "command": "npx",
      "args": ["-y", "kassinao-mcp"],
      "env": {
        "KASSINAO_URL": "${T('https://SEU-KASSINAO', 'https://YOUR-KASSINAO')}",
        "KASSINAO_REFRESH_TOKEN": "${T('COLE_O_TOKEN', 'PASTE_THE_TOKEN')}"
      }
    }
  }
}`,
    copyLabel,
  );

  const nav = [
    ['inicio', T('Início rápido', 'Quick start')],
    ['requisitos', T('Requisitos', 'Requirements')],
    ['docker', T('Instalação com Docker', 'Docker installation')],
    ['configuracao', T('Variáveis e configuração', 'Variables and configuration')],
    ['comandos', T('Comandos', 'Commands')],
    ['fluxo', T('Fluxo de gravação', 'Recording flow')],
    ['transcricao', T('Transcrição e IA', 'Transcription and AI')],
    ['privacidade', T('Privacidade e permissões', 'Privacy and permissions')],
    ['mcp', T('Conector MCP', 'MCP connector')],
    ['problemas', T('Troubleshooting', 'Troubleshooting')],
    ['links', T('Links', 'Links')],
  ];

  return `<!doctype html>
<html lang="${l === 'pt' ? 'pt-BR' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | Kassinão</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<link rel="alternate" hreflang="pt-BR" href="${esc(ptDocs)}">
<link rel="alternate" hreflang="en" href="${esc(enDocs)}">
<link rel="alternate" hreflang="x-default" href="${esc(enDocs)}">
<meta property="og:title" content="${esc(title)} | Kassinão">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(config.publicUrl)}/og-${l}.png">
<meta property="og:url" content="${esc(canonical)}">
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
<header class="topbar">
  <div class="topbar-inner">
    <button class="control mobile-menu" id="mobile-menu" type="button" aria-controls="docs-sidebar" aria-expanded="false">${esc(T('Menu', 'Menu'))}</button>
    <a class="brand" href="${site.links.home}" aria-label="${esc(T('Kassinão, página inicial', 'Kassinão, home page'))}">
      <span class="brand-mark" aria-hidden="true">k/</span>
      <span>Kassinão</span><span class="brand-context">${esc(T('Documentação', 'Docs'))}</span>
    </a>
    <div class="topbar-actions">
      <div class="language" aria-label="${esc(T('Idioma', 'Language'))}">
        <a href="${ptDocs}"${l === 'pt' ? ' aria-current="page"' : ''} lang="pt-BR">PT</a>
        <a href="${enDocs}"${l === 'en' ? ' aria-current="page"' : ''} lang="en">EN</a>
      </div>
      <button class="control" id="theme-toggle" type="button" aria-label="${esc(T('Alternar tema claro e escuro', 'Toggle light and dark theme'))}" aria-pressed="false"><span class="theme-label">${esc(T('Tema', 'Theme'))}</span></button>
      <a class="primary-link" href="${REPO_URL}" target="_blank" rel="noopener noreferrer">GitHub</a>
    </div>
  </div>
</header>
<div class="docs-shell">
  <aside class="sidebar" id="docs-sidebar" aria-label="${esc(T('Navegação da documentação', 'Documentation navigation'))}">
    <div class="search-block">
      <label for="docs-search">${esc(T('Buscar na documentação', 'Search documentation'))}</label>
      <input class="search-input" id="docs-search" type="search" placeholder="${esc(T('Comando, variável ou dúvida', 'Command, variable, or question'))}" autocomplete="off">
      <p class="search-status" id="search-status" aria-live="polite"></p>
    </div>
    <nav class="side-nav">
      ${nav
        .map(
          ([id, label], index) =>
            `<a href="#${id}" data-nav-link${index === 0 ? ' aria-current="location"' : ''}>${esc(label)}</a>`,
        )
        .join('')}
    </nav>
    <p class="side-note">${esc(
      T(
        'Os exemplos desta página não contêm credenciais reais. Nunca compartilhe seu .env.',
        'Examples on this page contain no real credentials. Never share your .env file.',
      ),
    )}</p>
  </aside>
  <button class="nav-backdrop" id="nav-backdrop" type="button" aria-label="${esc(T('Fechar menu', 'Close menu'))}"></button>
  <main class="docs-main" id="conteudo">
    <div class="docs-main-inner">
      <header class="docs-hero">
        <h1>${esc(T('Coloque o Kassinão no seu Discord.', 'Bring Kassinão into your Discord.'))}</h1>
        <p>${esc(description)}</p>
        <div class="hero-actions">
          <a class="primary-link" href="#inicio">${esc(T('Instalar agora', 'Install now'))}</a>
          <a class="control" href="${NPM_URL}" target="_blank" rel="noopener noreferrer">MCP</a>
        </div>
      </header>

      <section class="doc-section" id="inicio" data-doc-section data-keywords="quickstart setup começar iniciar clone discord bot">
        <div class="section-head">
          <h2>${esc(T('Início rápido', 'Quick start'))}</h2>
          <p>${esc(
            T(
              'O caminho mínimo entre um servidor novo e a primeira call gravada.',
              'The shortest path from a new server to your first recorded call.',
            ),
          )}</p>
        </div>
        <div class="quick-layout">
          <ol class="quick-list">
            <li><strong>${esc(T('Crie o app', 'Create the app'))}</strong><span>${esc(T('Copie Application ID, token do bot e Client Secret.', 'Copy the Application ID, bot token, and Client Secret.'))}</span></li>
            <li><strong>${esc(T('Prepare o servidor', 'Prepare the server'))}</strong><span>${esc(T('Clone o projeto e preencha as quatro variáveis obrigatórias.', 'Clone the project and fill in the four required variables.'))}</span></li>
            <li><strong>${esc(T('Suba o Docker', 'Start Docker'))}</strong><span>${esc(T('Acompanhe os logs até aparecer que o Kassinão está online.', 'Follow the logs until Kassinão reports that it is online.'))}</span></li>
            <li><strong>${esc(T('Grave uma call', 'Record a call'))}</strong><span>${esc(T('Entre num canal de voz e use /gravar.', 'Join a voice channel and use /record.'))}</span></li>
          </ol>
          <div class="code-stack">${clone}${requiredEnv}${start}</div>
        </div>
        <div class="callout">
          <strong>${esc(T('O bot já grava sem IA.', 'The bot records without AI.'))}</strong>
          <p>${esc(
            T(
              'Transcrição e ata são opcionais. Configure um provider depois de validar a gravação, o login e os downloads.',
              'Transcription and minutes are optional. Configure a provider after validating recording, login, and downloads.',
            ),
          )}</p>
        </div>
      </section>

      <section class="doc-section" id="requisitos" data-doc-section data-keywords="requirements docker compose https oauth discord permissions intents server vps node">
        <div class="section-head">
          <h2>${esc(T('Requisitos', 'Requirements'))}</h2>
          <p>${esc(T('O Kassinão é um bot persistente de voz. Ele precisa ficar conectado ao Discord.', 'Kassinão is a persistent voice bot. It must stay connected to Discord.'))}</p>
        </div>
        <div class="requirement-grid">
          <article class="requirement-primary">
            <h3>${esc(T('Obrigatório para operar', 'Required to operate'))}</h3>
            <ul class="check-list">
              <li>${esc(T('Servidor ou computador com Docker e Docker Compose.', 'A server or computer with Docker and Docker Compose.'))}</li>
              <li>${esc(T('Aplicação criada no Discord Developer Portal. Nenhuma privileged intent é necessária.', 'An application created in the Discord Developer Portal. No privileged intent is required.'))}</li>
              <li>${esc(T('URL HTTPS pública para login e downloads em produção.', 'A public HTTPS URL for login and downloads in production.'))}</li>
              <li>${esc(T('Volume persistente para o diretório recordings.', 'A persistent volume for the recordings directory.'))}</li>
            </ul>
          </article>
          <article class="requirement-secondary">
            <h3>${esc(T('Opcional', 'Optional'))}</h3>
            <ul class="check-list">
              <li>${esc(T('Cloudflare Tunnel para publicar HTTPS sem abrir portas.', 'Cloudflare Tunnel for HTTPS without opening ports.'))}</li>
              <li>${esc(T('Chave de um provider de transcrição e de ata.', 'A transcription and minutes provider key.'))}</li>
              <li>${esc(T('Node.js 20+ no computador que usar o conector MCP.', 'Node.js 20+ on the computer running the MCP connector.'))}</li>
              <li>${esc(T('Node.js 22+ apenas para desenvolver fora do Docker.', 'Node.js 22+ only for development outside Docker.'))}</li>
            </ul>
          </article>
        </div>
        <div class="callout danger">
          <strong>${esc(T('Não use serverless.', 'Do not use serverless.'))}</strong>
          <p>${esc(T('Vercel e Netlify não mantêm o gateway de voz WebSocket ativo. Use Docker numa máquina persistente.', 'Vercel and Netlify do not keep the voice gateway WebSocket alive. Use Docker on a persistent machine.'))}</p>
        </div>
      </section>

      <section class="doc-section" id="docker" data-doc-section data-keywords="docker compose installation cloudflare tunnel callback oauth invite permissions logs healthcheck">
        <div class="section-head">
          <h2>${esc(T('Instalação com Docker', 'Docker installation'))}</h2>
          <p>${esc(T('Configure primeiro o Discord, depois a URL pública e só então suba o container.', 'Configure Discord first, then the public URL, and only then start the container.'))}</p>
        </div>
        <div class="install-steps">
          <article class="install-step">
            <h3>${esc(T('Crie a aplicação', 'Create the application'))}</h3>
            <div>
              <p>${T(
                'No <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">Discord Developer Portal</a>, crie uma aplicação. Copie o Application ID, gere o token do bot e copie o Client Secret em OAuth2.',
                'In the <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">Discord Developer Portal</a>, create an application. Copy the Application ID, generate the bot token, and copy the OAuth2 Client Secret.',
              )}</p>
              <p>${esc(T('Cadastre exatamente APP_URL/auth/callback em OAuth2 Redirects.', 'Register exactly APP_URL/auth/callback under OAuth2 Redirects.'))}</p>
            </div>
          </article>
          <article class="install-step">
            <h3>${esc(T('Convide o bot', 'Invite the bot'))}</h3>
            <div>
              <p>${esc(T('Use os scopes bot e applications.commands. O número de permissões usado pelo projeto é 68242432.', 'Use the bot and applications.commands scopes. The project permission number is 68242432.'))}</p>
              ${codeBlock(
                l === 'pt' ? 'URL de convite' : 'Invite URL',
                `https://discord.com/oauth2/authorize?client_id=${T('SEU_APP_ID', 'YOUR_APP_ID')}&scope=bot%20applications.commands&permissions=68242432`,
                copyLabel,
              )}
              <p>${esc(T('Permissões: Ver Canais, Enviar Mensagens, Inserir Links, Ler Histórico, Conectar e Alterar Apelido.', 'Permissions: View Channels, Send Messages, Embed Links, Read Message History, Connect, and Change Nickname.'))}</p>
            </div>
          </article>
          <article class="install-step">
            <h3>${esc(T('Publique HTTPS', 'Publish HTTPS'))}</h3>
            <div>
              <p>${esc(T('Com Cloudflare Tunnel, aponte o hostname público para kassinao:8080. Defina TUNNEL_TOKEN e COMPOSE_PROFILES=tunnel.', 'With Cloudflare Tunnel, point the public hostname to kassinao:8080. Set TUNNEL_TOKEN and COMPOSE_PROFILES=tunnel.'))}</p>
              <p>${esc(T('IP direto serve apenas para teste. O OAuth do Discord aceita HTTP somente em localhost.', 'Direct IP is for testing only. Discord OAuth accepts HTTP only on localhost.'))}</p>
            </div>
          </article>
          <article class="install-step">
            <h3>${esc(T('Suba e valide', 'Start and validate'))}</h3>
            <div>
              <p>${esc(T('Suba o compose, acompanhe o log e abra /health. As gravações ficam no volume ./recordings.', 'Start Compose, follow the log, and open /health. Recordings live in the ./recordings volume.'))}</p>
              ${start}
            </div>
          </article>
        </div>
      </section>

      <section class="doc-section" id="configuracao" data-doc-section data-keywords="environment env configuration secret retention provider minutes webhook disk locale">
        <div class="section-head">
          <h2>${esc(T('Variáveis e configuração', 'Variables and configuration'))}</h2>
          <p>${esc(T('Comece pelo bloco obrigatório. Abra os grupos seguintes apenas quando precisar da função.', 'Start with the required block. Open the remaining groups only when you need the feature.'))}</p>
        </div>
        ${renderEnvGroups(l)}
        <div class="callout danger">
          <strong>${esc(T('Segredos não entram no Git.', 'Secrets do not belong in Git.'))}</strong>
          <p>${esc(T('O .env já é ignorado. Gere COOKIE_SECRET e MCP_SECRET com openssl rand -hex 32 e nunca use o mesmo valor nos dois.', 'The .env file is already ignored. Generate COOKIE_SECRET and MCP_SECRET with openssl rand -hex 32 and never reuse the same value.'))}</p>
        </div>
      </section>

      <section class="doc-section" id="comandos" data-doc-section data-keywords="slash commands gravar record parar stop nota status gravacoes recordings perguntar ask autorecord config mcp ajuda help sobre">
        <div class="section-head">
          <h2>${esc(T('Comandos', 'Commands'))}</h2>
          <p>${esc(T('O Discord mostra automaticamente o nome em português ou inglês conforme o idioma do cliente.', 'Discord automatically shows Portuguese or English names based on the client language.'))}</p>
        </div>
        <div class="command-grid">${renderCommands(l)}</div>
        <div class="callout">
          <strong>${esc(T('Use comandos dentro do servidor.', 'Use commands inside the server.'))}</strong>
          <p>${esc(T('É ali que o bot consegue validar servidor, canal e permissões. As respostas de /perguntar são efêmeras e só aparecem para quem perguntou.', 'That is where the bot can validate server, channel, and permissions. Replies from /ask are ephemeral and only visible to the person who asked.'))}</p>
        </div>
      </section>

      <section class="doc-section" id="fluxo" data-doc-section data-keywords="recording flow audio opus pcm flac ffmpeg vad mix download audacity panel consent">
        <div class="section-head">
          <h2>${esc(T('Fluxo de gravação', 'Recording flow'))}</h2>
          <p>${esc(T('Do comando no canal de voz até a central privada.', 'From the voice-channel command to the private workspace.'))}</p>
        </div>
        <ol class="flow">
          <li><span class="flow-number">1</span><div><h3>${esc(T('O aviso aparece antes do áudio', 'The notice appears before audio starts'))}</h3><p>${esc(T('O bot entra no canal, publica o painel e usa o prefixo [GRAVANDO] no apelido. A captura só começa depois do aviso.', 'The bot joins the channel, posts the panel, and adds [RECORDING] to its nickname. Capture starts only after the notice.'))}</p></div></li>
          <li><span class="flow-number">2</span><div><h3>${esc(T('Cada pessoa ganha uma faixa', 'Each person gets a track'))}</h3><p>${esc(T('Os pacotes Opus são decodificados para PCM e um ffmpeg por pessoa grava FLAC contínuo e sincronizado. Não há diarização para adivinhar o falante.', 'Opus packets are decoded to PCM and one ffmpeg process per person records continuous synchronized FLAC. No diarization guesses the speaker.'))}</p></div></li>
          <li><span class="flow-number">3</span><div><h3>${esc(T('Notas preservam o segundo exato', 'Notes preserve the exact second'))}</h3><p>${esc(T('Use /nota ou os botões do painel. As marcações entram na página, na transcrição e nos labels do Audacity.', 'Use /note or the panel buttons. Marks appear on the page, in the transcript, and in Audacity labels.'))}</p></div></li>
          <li><span class="flow-number">4</span><div><h3>${esc(T('A gravação encerra com segurança', 'The recording ends safely'))}</h3><p>${esc(T('Use /parar. O bot também encerra quando o canal esvazia, passa do limite ou é desconectado. Silêncio prolongado gera aviso, não parada.', 'Use /stop. The bot also ends when the channel empties, reaches the limit, or is disconnected. Extended silence triggers a warning, not a stop.'))}</p></div></li>
          <li><span class="flow-number">5</span><div><h3>${esc(T('O áudio fica disponível primeiro', 'Audio becomes available first'))}</h3><p>${esc(T('O mix pré-processado alimenta o player imediatamente. MP3, FLAC, mix e projeto do Audacity são gerados sob demanda e ficam em cache.', 'The preprocessed mix powers the player immediately. MP3, FLAC, mix, and Audacity projects are generated on demand and cached.'))}</p></div></li>
          <li><span class="flow-number">6</span><div><h3>${esc(T('Transcrição e ata entram na fila', 'Transcript and minutes enter the queue'))}</h3><p>${esc(T('O VAD normalmente envia só os trechos com fala; se a detecção falhar, usa blocos fixos para não perder a call. Depois, a ata gera resumo, decisões e tarefas.', 'VAD normally sends only speech segments; if detection fails, fixed chunks keep the call from being lost. Then minutes create a summary, decisions, and tasks.'))}</p></div></li>
        </ol>
      </section>

      <section class="doc-section" id="transcricao" data-doc-section data-keywords="transcription ai assemblyai groq openai gemini command local whisper minutes openrouter vad zdr">
        <div class="section-head">
          <h2>${esc(T('Transcrição e IA', 'Transcription and AI'))}</h2>
          <p>${esc(T('A gravação funciona sem IA. Quando ativada, a IA entra depois da call e nunca decide quem falou.', 'Recording works without AI. When enabled, AI runs after the call and never decides who spoke.'))}</p>
        </div>
        <div class="provider-layout">
          <div class="provider-list">
            <div class="provider"><strong>AssemblyAI</strong><span>${esc(T('Universal-3.5-Pro, keyterms e fallback automático para Groq quando configurado.', 'Universal-3.5-Pro, keyterms, and automatic Groq fallback when configured.'))}</span></div>
            <div class="provider"><strong>Groq</strong><span>${esc(T('Whisper Large V3. Útil para começar com free tier. Ative Zero Data Retention.', 'Whisper Large V3. Useful for starting with a free tier. Enable Zero Data Retention.'))}</span></div>
            <div class="provider"><strong>OpenAI</strong><span>${esc(T('Whisper com segmentos e timestamps.', 'Whisper with segments and timestamps.'))}</span></div>
            <div class="provider"><strong>Gemini</strong><span>${esc(T('Áudio via Gemini. Revise a política de retenção do tier usado.', 'Audio through Gemini. Review the retention policy for your tier.'))}</span></div>
            <div class="provider"><strong>${esc(T('Comando local', 'Local command'))}</strong><span>${esc(T('faster-whisper, whisper.cpp ou outro comando que gere o JSON esperado.', 'faster-whisper, whisper.cpp, or another command that outputs the expected JSON.'))}</span></div>
          </div>
          <aside class="pipeline-note">
            <h3>${esc(T('O que é enviado', 'What gets sent'))}</h3>
            <p>${esc(T('O VAD normalmente corta silêncio por faixa. Se a detecção falhar, blocos fixos preservam a call; nomes e vocabulário configurado ajudam o ASR.', 'VAD normally removes silence per track. If detection fails, fixed chunks preserve the call; participant names and configured vocabulary help ASR.'))}</p>
            <p>${esc(T('A ata recebe apenas texto, nunca áudio. Ela roda uma vez por reunião via OpenRouter ou Groq.', 'Minutes receive text only, never audio. They run once per meeting through OpenRouter or Groq.'))}</p>
          </aside>
        </div>
        <h3>${esc(T('Transcrição totalmente local', 'Fully local transcription'))}</h3>
        <p>${esc(T('Construa a imagem com LOCAL_TRANSCRIBE=1 e use o wrapper incluído. O comando precisa escrever em {output} um array JSON com start, end e text.', 'Build the image with LOCAL_TRANSCRIBE=1 and use the included wrapper. The command must write a JSON array with start, end, and text to {output}.'))}</p>
        ${localTranscription}
        ${codeBlock(
          l === 'pt' ? 'Terminal' : 'Terminal',
          'docker compose build --build-arg LOCAL_TRANSCRIBE=1\ndocker compose up -d',
          copyLabel,
        )}
      </section>

      <section class="doc-section" id="privacidade" data-doc-section data-keywords="privacy permissions oauth access consent restricted channel retention delete fail closed prompt injection personal data">
        <div class="section-head">
          <h2>${esc(T('Privacidade e permissões', 'Privacy and permissions'))}</h2>
          <p>${esc(T('Voz é dado pessoal. O controle de acesso é aplicado no servidor em toda abertura, busca e conexão.', 'Voice is personal data. Server-side access control applies to every open, search, and connection.'))}</p>
        </div>
        <div class="privacy-layout">
          <div class="privacy-rules">
            <article class="privacy-rule"><h3>${esc(T('Consentimento visível', 'Visible consent'))}</h3><p>${esc(T('O bot entra no canal, publica um painel e muda o apelido para [GRAVANDO] antes de capturar áudio.', 'The bot joins the channel, posts a panel, and changes its nickname to [RECORDING] before capturing audio.'))}</p></article>
            <article class="privacy-rule"><h3>${esc(T('Acesso revalidado', 'Revalidated access'))}</h3><p>${esc(T('A página exige OAuth do Discord e participação atual no servidor. Sair do servidor encerra o acesso.', 'The page requires Discord OAuth and current server membership. Leaving the server ends access.'))}</p></article>
            <article class="privacy-rule"><h3>${esc(T('Histórico da gravação', 'Recording history'))}</h3><p>${esc(T('Em qualquer canal, só abre para quem estava na call, mesmo mutado, quem iniciou ou um admin atual. Receber permissão depois não libera o passado.', 'In every channel, only call participants, including muted participants, the starter, or a current admin can open it. Later permission does not unlock the past.'))}</p></article>
            <article class="privacy-rule"><h3>${esc(T('Falha para o lado seguro', 'Fails closed'))}</h3><p>${esc(T('Se o Discord não consegue confirmar o acesso, a página nega. A API do MCP devolve erro temporário quando a checagem está indisponível.', 'If Discord cannot confirm access, the page denies it. The MCP API returns a temporary error when the check is unavailable.'))}</p></article>
            <article class="privacy-rule"><h3>${esc(T('Retenção em camadas', 'Tiered retention'))}</h3><p>${esc(T('O áudio pode expirar antes da transcrição, ata e notas. O operador também pode apagar somente o áudio ou apagar tudo.', 'Audio can expire before transcripts, minutes, and notes. The operator can also delete only audio or delete everything.'))}</p></article>
            <article class="privacy-rule"><h3>${esc(T('Segredos isolados', 'Isolated secrets'))}</h3><p>${esc(T('Cookies e MCP usam segredos diferentes. Girar MCP_SECRET revoga todos os conectores sem invalidar a regra de acesso.', 'Cookies and MCP use different secrets. Rotating MCP_SECRET revokes every connector without changing access rules.'))}</p></article>
          </div>
          <aside class="permission-box">
            <h3>${esc(T('Quem pode fazer o quê', 'Who can do what'))}</h3>
            <ul>
              <li>${esc(T('Gravar: qualquer membro no canal atual.', 'Record: any member in their current channel.'))}</li>
              <li>${esc(T('Indicar outro canal: Gerenciar Servidor.', 'Target another channel: Manage Server.'))}</li>
              <li>${esc(T('Parar e anotar: continuar vendo o canal.', 'Stop and annotate: must still see the channel.'))}</li>
              <li>${esc(T('Auto-record e configuração: Gerenciar Servidor.', 'Auto-record and configuration: Manage Server.'))}</li>
              <li>${esc(T('Apagar: quem iniciou ou admin, com checagem atual.', 'Delete: starter or admin, with a current check.'))}</li>
              <li>${esc(T('Perguntar, busca e MCP: somente reuniões acessíveis.', 'Ask, search, and MCP: accessible meetings only.'))}</li>
            </ul>
          </aside>
        </div>
        <div class="callout danger">
          <strong>${esc(T('Se uma credencial vazar, gire imediatamente.', 'Rotate any exposed credential immediately.'))}</strong>
          <p>${esc(T('Troque DISCORD_TOKEN, DISCORD_CLIENT_SECRET, TUNNEL_TOKEN e chaves de API. Problemas de segurança devem ser reportados em privado.', 'Replace DISCORD_TOKEN, DISCORD_CLIENT_SECRET, TUNNEL_TOKEN, and API keys. Security issues must be reported privately.'))}</p>
        </div>
      </section>

      <section class="doc-section" id="mcp" data-doc-section data-keywords="mcp claude cursor connector token refresh list meetings pending actions search who said get meeting">
        <div class="section-head">
          <h2>${esc(T('Conector MCP', 'MCP connector'))}</h2>
          <p>${esc(T('Leve a memória das reuniões para Claude, Cursor ou outro cliente MCP sem copiar o acervo para a máquina.', 'Bring meeting memory to Claude, Cursor, or another MCP client without copying the archive to the machine.'))}</p>
        </div>
        <div class="callout">
          <strong>${esc(T('MCP é opt-in e somente leitura.', 'MCP is opt-in and read-only.'))}</strong>
          <p>${esc(T('Ele não entrega áudio, não apaga gravações e não amplia permissões. Cada chamada passa pela mesma checagem da web.', 'It does not serve audio, delete recordings, or widen permissions. Every request goes through the same web access check.'))}</p>
        </div>
        <h3>${esc(T('Ative no servidor', 'Enable on the server'))}</h3>
        <p>${esc(T('Defina um MCP_SECRET dedicado com no mínimo 32 bytes e reinicie. A página /app/conectar-ia e a API só existem quando esse segredo está presente.', 'Set a dedicated MCP_SECRET with at least 32 bytes and restart. The /app/conectar-ia page and API exist only when this secret is present.'))}</p>
        ${codeBlock(l === 'pt' ? 'Terminal' : 'Terminal', 'openssl rand -hex 32', copyLabel)}
        <h3>${esc(T('Conecte cada pessoa', 'Connect each person'))}</h3>
        <p>${esc(T('Abra /app/conectar-ia, entre com Discord, gere uma conexão nomeada e copie a configuração exibida uma única vez. O computador cliente precisa de Node.js 20 ou superior.', 'Open /app/conectar-ia, sign in with Discord, create a named connection, and copy the configuration shown once. The client computer needs Node.js 20 or newer.'))}</p>
        ${mcpConfig}
        <p>${esc(T('Em ambiente sem navegador, um ID presente em OWNER_IDS pode gerar um código com /mcp novo e trocar pelo terminal.', 'Without a browser, an ID listed in OWNER_IDS can generate a code with /mcp new and exchange it in the terminal.'))}</p>
        ${codeBlock(
          l === 'pt' ? 'Terminal' : 'Terminal',
          T(
            'KASSINAO_URL=https://SEU-KASSINAO npx -y kassinao-mcp exchange CODIGO',
            'KASSINAO_URL=https://YOUR-KASSINAO npx -y kassinao-mcp exchange CODE',
          ),
          copyLabel,
        )}
        <h3>${esc(T('Ferramentas disponíveis', 'Available tools'))}</h3>
        <div class="mcp-tools">
          <article class="mcp-tool"><code>list_meetings</code><p>${esc(T('Lista reuniões num período.', 'Lists meetings in a time range.'))}</p></article>
          <article class="mcp-tool"><code>pending_actions</code><p>${esc(T('Cruza pendências e prazos.', 'Combines pending actions and deadlines.'))}</p></article>
          <article class="mcp-tool"><code>search_meetings</code><p>${esc(T('Busca em transcrições, atas e notas.', 'Searches transcripts, minutes, and notes.'))}</p></article>
          <article class="mcp-tool"><code>who_said</code><p>${esc(T('Encontra o que uma pessoa disse sobre um tema.', 'Finds what someone said about a topic.'))}</p></article>
          <article class="mcp-tool"><code>get_meeting</code><p>${esc(T('Abre o dossiê completo de uma reunião.', 'Opens a complete meeting dossier.'))}</p></article>
        </div>
        <h3>${esc(T('Tokens e revogação', 'Tokens and revocation'))}</h3>
        <p>${esc(T('O refresh token fica em ~/.config/kassinao-mcp com permissão 0600 e gira a cada renovação. Revogue uma conexão na página, use /mcp revogar-tudo ou gire MCP_SECRET para revogar todos.', 'The refresh token lives under ~/.config/kassinao-mcp with 0600 permissions and rotates on renewal. Revoke one connection on the page, use /mcp revoke-all, or rotate MCP_SECRET to revoke everyone.'))}</p>
      </section>

      <section class="doc-section" id="problemas" data-doc-section data-keywords="troubleshooting error not online commands missing oauth callback tunnel transcript minutes mcp 404 denied disk audio expired">
        <div class="section-head">
          <h2>${esc(T('Troubleshooting', 'Troubleshooting'))}</h2>
          <p>${esc(T('Comece sempre por docker compose logs -f. O bot valida a configuração no boot e explica as variáveis inválidas.', 'Always start with docker compose logs -f. The bot validates configuration on boot and explains invalid variables.'))}</p>
        </div>
        <div class="troubleshooting">
          <details class="trouble"><summary>${esc(T('O container não fica online', 'The container does not stay online'))}</summary><div class="trouble-body"><p>${esc(T('Confirme DISCORD_TOKEN, APPLICATION_ID e DISCORD_CLIENT_SECRET. Verifique também se APP_URL é uma origem HTTP ou HTTPS sem caminho, query ou hash.', 'Confirm DISCORD_TOKEN, APPLICATION_ID, and DISCORD_CLIENT_SECRET. Also verify that APP_URL is an HTTP or HTTPS origin without a path, query, or hash.'))}</p><p><code>docker compose logs --tail=200 kassinao</code></p></div></details>
          <details class="trouble"><summary>${esc(T('Os comandos não aparecem', 'Commands do not appear'))}</summary><div class="trouble-body"><p>${esc(T('Confirme que o convite incluiu applications.commands e que o bot já está no servidor. Reinicie o bot. Se GUILD_ID estiver definido, os comandos só são registrados naquele servidor.', 'Confirm the invite included applications.commands and that the bot is already in the server. Restart the bot. If GUILD_ID is set, commands are registered only in that server.'))}</p></div></details>
          <details class="trouble"><summary>${esc(T('O login do Discord volta com erro', 'Discord login returns an error'))}</summary><div class="trouble-body"><p>${esc(T('Cadastre exatamente APP_URL/auth/callback em OAuth2 Redirects. Em produção, APP_URL precisa usar HTTPS. Depois de mudar a origem, atualize o redirect e reinicie.', 'Register exactly APP_URL/auth/callback under OAuth2 Redirects. In production, APP_URL must use HTTPS. After changing the origin, update the redirect and restart.'))}</p></div></details>
          <details class="trouble"><summary>${esc(T('O Cloudflare Tunnel não sobe', 'Cloudflare Tunnel does not start'))}</summary><div class="trouble-body"><p>${esc(T('O serviço fica num profile. Defina COMPOSE_PROFILES=tunnel ou execute docker compose --profile tunnel up -d. No painel da Cloudflare, o destino interno é kassinao:8080.', 'The service is in a profile. Set COMPOSE_PROFILES=tunnel or run docker compose --profile tunnel up -d. In Cloudflare, the internal target is kassinao:8080.'))}</p></div></details>
          <details class="trouble"><summary>${esc(T('A gravação existe, mas não há transcrição', 'The recording exists, but there is no transcript'))}</summary><div class="trouble-body"><p>${esc(T('Confirme que TRANSCRIBE_PROVIDER não está como none e que a chave do provider existe. Consulte o log da fila. A gravação e os downloads continuam válidos mesmo sem IA.', 'Confirm TRANSCRIBE_PROVIDER is not none and that its provider key exists. Check queue logs. Recording and downloads remain valid without AI.'))}</p></div></details>
          <details class="trouble"><summary>${esc(T('A transcrição saiu, mas a ata não', 'The transcript is ready, but minutes are not'))}</summary><div class="trouble-body"><p>${esc(T('Com MINUTES_ENABLED=auto, a ata só liga quando OPENROUTER_API_KEY ou GROQ_API_KEY está definida. Confirme também MINUTES_PROVIDER e o limite do provider em calls longas.', 'With MINUTES_ENABLED=auto, minutes only enable when OPENROUTER_API_KEY or GROQ_API_KEY is set. Also verify MINUTES_PROVIDER and provider limits for long calls.'))}</p></div></details>
          <details class="trouble"><summary>${esc(T('A página de MCP retorna 404', 'The MCP page returns 404'))}</summary><div class="trouble-body"><p>${esc(T('Isso é esperado quando MCP_SECRET está vazio. Gere um segredo dedicado com 32 bytes ou mais, diferente de COOKIE_SECRET, e reinicie o bot.', 'This is expected when MCP_SECRET is empty. Generate a dedicated secret of at least 32 bytes, different from COOKIE_SECRET, and restart the bot.'))}</p></div></details>
          <details class="trouble"><summary>${esc(T('Uma pessoa recebeu acesso negado', 'Someone received access denied'))}</summary><div class="trouble-body"><p>${esc(T('Confirme que ela continua no servidor. Em qualquer canal, ela precisa ter estado na call, ter iniciado a gravação ou ser admin atual. Ganhar acesso ao canal depois não libera o histórico.', 'Confirm they are still in the server. In every channel, they must have joined the call, started the recording, or be a current admin. Later channel access does not unlock history.'))}</p></div></details>
          <details class="trouble"><summary>${esc(T('O bot recusou ou encerrou por espaço', 'The bot refused or stopped because of disk space'))}</summary><div class="trouble-body"><p>${esc(T('Libere espaço no host ou ajuste MIN_FREE_MB_START e MIN_FREE_MB_ABORT com cuidado. O limite de abortar não pode ser maior que o limite de iniciar.', 'Free disk space on the host or carefully adjust MIN_FREE_MB_START and MIN_FREE_MB_ABORT. The abort threshold cannot exceed the start threshold.'))}</p></div></details>
          <details class="trouble"><summary>${esc(T('O áudio sumiu, mas a ata continua', 'Audio is gone, but minutes remain'))}</summary><div class="trouble-body"><p>${esc(T('É o comportamento da retenção em camadas. RETENTION_DAYS controla o áudio e TEXT_RETENTION_DAYS controla transcrição, ata e notas. Use zero para não expirar automaticamente.', 'This is tiered retention. RETENTION_DAYS controls audio and TEXT_RETENTION_DAYS controls transcript, minutes, and notes. Use zero to disable automatic expiration.'))}</p></div></details>
        </div>
      </section>

      <section class="doc-section" id="links" data-doc-section data-keywords="links github security license issues environment mcp discord cloudflare">
        <div class="section-head">
          <h2>${esc(T('Links', 'Links'))}</h2>
          <p>${esc(T('Código, MCP, configuração e canais corretos para suporte.', 'Code, MCP, configuration, and the right support channels.'))}</p>
        </div>
        <div class="link-grid">
          <a class="resource-link" href="${site.links.demo}"><strong>${esc(T('Demo pública', 'Public demo'))}</strong><span>${esc(T('Reunião fictícia na interface real do produto.', 'Fictional meeting in the real product interface.'))}</span></a>
          <a class="resource-link" href="${NPM_URL}" target="_blank" rel="noopener noreferrer"><strong>kassinao-mcp</strong><span>${esc(T('Pacote publicado do conector MCP.', 'Published MCP connector package.'))}</span></a>
          <a class="resource-link" href="${REPO_URL}" target="_blank" rel="noreferrer"><strong>GitHub</strong><span>${esc(T('Código-fonte e README.', 'Source code and README.'))}</span></a>
          <a class="resource-link" href="${REPO_URL}/blob/main/.env.example" target="_blank" rel="noreferrer"><strong>.env.example</strong><span>${esc(T('Todas as opções comentadas.', 'Every option with comments.'))}</span></a>
          <a class="resource-link" href="${REPO_URL}/tree/main/mcp" target="_blank" rel="noreferrer"><strong>${esc(T('MCP no GitHub', 'MCP on GitHub'))}</strong><span>${esc(T('Cliente e configuração do conector.', 'Connector client and setup.'))}</span></a>
          <a class="resource-link" href="${REPO_URL}/issues" target="_blank" rel="noreferrer"><strong>Issues</strong><span>${esc(T('Bugs e propostas públicas.', 'Public bugs and proposals.'))}</span></a>
          <a class="resource-link" href="${REPO_URL}/security/advisories/new" target="_blank" rel="noreferrer"><strong>${esc(T('Reportar vulnerabilidade', 'Report a vulnerability'))}</strong><span>${esc(T('Canal privado do GitHub.', 'Private GitHub channel.'))}</span></a>
          <a class="resource-link" href="${REPO_URL}/blob/main/LICENSE" target="_blank" rel="noreferrer"><strong>AGPL-3.0</strong><span>${esc(T('Licença do projeto.', 'Project license.'))}</span></a>
          <a class="resource-link" href="https://discord.com/developers/applications" target="_blank" rel="noreferrer"><strong>Discord Developer Portal</strong><span>${esc(T('Aplicação, bot e OAuth2.', 'Application, bot, and OAuth2.'))}</span></a>
        </div>
      </section>

      <section class="no-results" id="no-results" hidden>
        <h2>${esc(T('Nada encontrado', 'Nothing found'))}</h2>
        <p>${esc(T('Tente um comando como gravar, uma variável como APP_URL ou um tema como privacidade.', 'Try a command such as record, a variable such as APP_URL, or a topic such as privacy.'))}</p>
      </section>

      <footer class="docs-footer">
        <p>Kassinão. ${esc(T('Bot de Discord self-hosted sob AGPL-3.0.', 'Self-hosted Discord bot under AGPL-3.0.'))} <a href="${altDocs}">${esc(T('Read in English', 'Ler em português'))}</a>.</p>
      </footer>
    </div>
  </main>
</div>
${docsScript(l)}
</body>
</html>`;
}
