import { config } from '../config';
import type { Locale } from '../i18n';

type PrivacyRuntimeConfig = Pick<
  typeof config,
  | 'appUrl'
  | 'operatorName'
  | 'operatorContactUrl'
  | 'privacyPolicyUrl'
  | 'dataDeletionUrl'
  | 'termsOfServiceUrl'
  | 'privacyEffectiveDate'
  | 'privacyPolicyVersion'
  | 'privacyAudience'
  | 'privacyPurposes'
  | 'privacyLawfulBasis'
  | 'infrastructureProvider'
  | 'infrastructureRegion'
  | 'edgeProvider'
  | 'edgeRegion'
  | 'operationalLogRetention'
  | 'rollbackRetentionHours'
  | 'backupEnabled'
  | 'backupProvider'
  | 'backupRegion'
  | 'backupRetentionDays'
  | 'dataRequestProcess'
  | 'dataRequestResponseDays'
  | 'incidentContactUrl'
  | 'incidentProcess'
  | 'sourceUrl'
  | 'logPiiEnabled'
  | 'retentionDays'
  | 'audioRetentionUnlimited'
  | 'textRetentionDays'
  | 'textRetentionUnlimited'
  | 'transcribeProvider'
  | 'transcribeFallbackProvider'
  | 'transcribeSendMeetingContext'
  | 'transcribePrompt'
  | 'transcribeKeyterms'
  | 'minutesEnabled'
  | 'minutesProvider'
  | 'openrouterApiKey'
  | 'groqApiKey'
  | 'minutesWebhookUrl'
  | 'mcpEnabled'
  | 'mcpAccessTtlMin'
  | 'mcpRefreshTtlDays'
>;

export interface PrivacyPageOptions {
  locale: Locale;
  runtime?: PrivacyRuntimeConfig;
}

function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function providerName(provider: string): string {
  const names: Record<string, string> = {
    none: 'None',
    command: 'local command',
    assemblyai: 'AssemblyAI',
    openai: 'OpenAI',
    groq: 'Groq',
    gemini: 'Google Gemini',
    openrouter: 'OpenRouter',
  };
  return names[provider] ?? provider;
}

function minutesAreActive(runtime: PrivacyRuntimeConfig): boolean {
  if (runtime.minutesEnabled === 'false') return false;
  return runtime.minutesProvider === 'openrouter' ? Boolean(runtime.openrouterApiKey) : Boolean(runtime.groqApiKey);
}

function retentionText(locale: Locale, days: number, unlimited: boolean, kind: 'audio' | 'text'): string {
  if (unlimited) {
    return locale === 'pt'
      ? `${kind === 'audio' ? 'Áudio' : 'Texto e metadados'}: sem expiração automática; a exclusão é manual.`
      : `${kind === 'audio' ? 'Audio' : 'Text and metadata'}: no automatic expiry; deletion is manual.`;
  }
  return locale === 'pt'
    ? `${kind === 'audio' ? 'Áudio' : 'Texto e metadados'}: ${days} ${days === 1 ? 'dia' : 'dias'}.`
    : `${kind === 'audio' ? 'Audio' : 'Text and metadata'}: ${days} ${days === 1 ? 'day' : 'days'}.`;
}

function egressItems(locale: Locale, runtime: PrivacyRuntimeConfig): string[] {
  const pt = locale === 'pt';
  const items: string[] = [
    pt
      ? '<strong>Discord:</strong> identidade, servidores autorizados, canais e membership são consultados para operar o bot e revalidar acesso.'
      : '<strong>Discord:</strong> identity, authorized servers, channels, and membership are queried to operate the bot and revalidate access.',
  ];

  if (runtime.transcribeProvider === 'none') {
    items.push(
      pt
        ? '<strong>Transcrição:</strong> desativada; nenhum provider de ASR recebe o áudio.'
        : '<strong>Transcription:</strong> disabled; no ASR provider receives audio.',
    );
  } else if (runtime.transcribeProvider === 'command') {
    items.push(
      pt
        ? '<strong>Transcrição:</strong> entregue a um comando escolhido pelo operador. Esse programa recebe o arquivo de áudio e pode processá-lo localmente ou enviá-lo a outros destinos; o Kassinão não consegue comprovar o comportamento desse comando.'
        : "<strong>Transcription:</strong> handed to a command selected by the operator. That program receives the audio file and may process it locally or send it elsewhere; Kassinão cannot verify the command's behavior.",
    );
  } else {
    items.push(
      pt
        ? `<strong>Transcrição:</strong> áudio é enviado ao ${esc(providerName(runtime.transcribeProvider))}.${runtime.transcribeSendMeetingContext ? ' Nomes de participantes, servidor e canal também podem ser enviados como contexto.' : ' Contexto com nomes de participantes, servidor e canal não é enviado.'}`
        : `<strong>Transcription:</strong> audio is sent to ${esc(providerName(runtime.transcribeProvider))}.${runtime.transcribeSendMeetingContext ? ' Participant, server, and channel names may also be sent as context.' : ' Participant, server, and channel names are not sent as context.'}`,
    );
  }

  if (
    runtime.transcribeProvider !== 'none' &&
    runtime.transcribeProvider !== 'command' &&
    (runtime.transcribePrompt.trim() || runtime.transcribeKeyterms.length > 0)
  ) {
    items.push(
      pt
        ? '<strong>Vocabulário de transcrição:</strong> prompt e termos configurados manualmente pelo operador também podem ser enviados ao ASR, mesmo quando nomes automáticos de participantes, servidor e canal estão desativados.'
        : '<strong>Transcription vocabulary:</strong> a prompt and terms manually configured by the operator may also be sent to ASR even when automatic participant, server, and channel names are disabled.',
    );
  }

  if (
    runtime.transcribeProvider === 'assemblyai' &&
    runtime.transcribeFallbackProvider === 'groq' &&
    runtime.groqApiKey
  ) {
    items.push(
      pt
        ? `<strong>Fallback de transcrição:</strong> ${esc(providerName(runtime.transcribeFallbackProvider))} pode receber chunks elegíveis quando o provider principal falha.`
        : `<strong>Transcription fallback:</strong> ${esc(providerName(runtime.transcribeFallbackProvider))} may receive eligible chunks when the primary provider fails.`,
    );
  }

  if (minutesAreActive(runtime)) {
    items.push(
      locale === 'pt'
        ? `<strong>Ata e perguntas:</strong> transcrições e contexto necessário são enviados ao ${esc(providerName(runtime.minutesProvider))}.`
        : `<strong>Minutes and questions:</strong> transcripts and required context are sent to ${esc(providerName(runtime.minutesProvider))}.`,
    );
  } else {
    items.push(
      pt
        ? '<strong>Ata e perguntas por IA:</strong> desativadas.'
        : '<strong>AI minutes and questions:</strong> disabled.',
    );
  }

  if (runtime.minutesWebhookUrl) {
    items.push(
      pt
        ? '<strong>Webhook:</strong> o ID e link da gravação, servidor, canal, horários, nomes das contas participantes e a ata concluída são enviados a um endpoint HTTPS configurado pelo operador. O endereço não é publicado nesta página.'
        : '<strong>Webhook:</strong> the recording ID and link, server, channel, timestamps, participating account names, and completed minutes are sent to an HTTPS endpoint configured by the operator. Its address is not published on this page.',
    );
  } else {
    items.push(pt ? '<strong>Webhook:</strong> desativado.' : '<strong>Webhook:</strong> disabled.');
  }

  if (runtime.mcpEnabled) {
    items.push(
      pt
        ? '<strong>MCP:</strong> texto e metadados autorizados saem da instância por HTTPS para o dispositivo do membro. O host MCP e o modelo escolhidos por essa pessoa podem receber esses resultados; a política deles também se aplica.'
        : "<strong>MCP:</strong> authorized text and metadata leave the instance over HTTPS for the member's device. The MCP host and model selected by that person may receive those results; their policies also apply.",
    );
  } else {
    items.push(pt ? '<strong>MCP:</strong> desativado.' : '<strong>MCP:</strong> disabled.');
  }

  return items;
}

function list(items: string[]): string {
  return `<ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;
}

/** URL canônica sempre pertence ao app privado, embora a página não exija login. */
export function privacyPage(locale: Locale, runtime: PrivacyRuntimeConfig = config): string {
  const pt = locale === 'pt';
  const localDraft = !runtime.privacyEffectiveDate || runtime.privacyPolicyVersion === 'local-draft';
  const canonical = pt ? runtime.privacyPolicyUrl : `${runtime.appUrl}/en/privacy`;
  const alternate = pt ? `${runtime.appUrl}/en/privacy` : runtime.privacyPolicyUrl;
  const egress = egressItems(locale, runtime);
  const termsLink = runtime.termsOfServiceUrl
    ? `<a href="${esc(runtime.termsOfServiceUrl)}" rel="noopener">${pt ? 'Termos de serviço do operador' : "Operator's Terms of Service"}</a>`
    : pt
      ? 'Este operador não configurou termos de serviço separados.'
      : 'This operator has not configured separate Terms of Service.';

  const title = pt ? 'Política de privacidade da instância' : 'Instance Privacy Policy';
  const description = pt
    ? `Como ${runtime.operatorName} trata dados na sua instância self-hosted do Kassinão.`
    : `How ${runtime.operatorName} handles data in its self-hosted Kassinão instance.`;
  const edgeDescription =
    runtime.edgeProvider.toLowerCase() === 'none'
      ? pt
        ? 'Sem túnel ou serviço de borda declarado.'
        : 'No tunnel or edge service declared.'
      : pt
        ? `${runtime.edgeProvider}, região/escopo ${runtime.edgeRegion}.`
        : `${runtime.edgeProvider}, region/scope ${runtime.edgeRegion}.`;
  const backupDescription = runtime.backupEnabled
    ? pt
      ? `${runtime.backupProvider}, região ${runtime.backupRegion}, retenção declarada de ${runtime.backupRetentionDays} dias.`
      : `${runtime.backupProvider}, region ${runtime.backupRegion}, declared retention of ${runtime.backupRetentionDays} days.`
    : pt
      ? 'Backup de conteúdo declarado como desativado.'
      : 'Content backup declared disabled.';

  return `<!doctype html>
<html lang="${pt ? 'pt-BR' : 'en'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)} · Kassinão</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${esc(canonical)}">
  <link rel="alternate" hreflang="${pt ? 'en' : 'pt-BR'}" href="${esc(alternate)}">
  <link rel="icon" href="/favicon-32.png" sizes="32x32">
  <style>
    @font-face{font-family:Space;src:url('/assets/space-grotesk.woff2') format('woff2');font-display:swap;font-weight:300 700}
    :root{color-scheme:dark;--bg:#111214;--panel:#1e1f22;--soft:#2b2d31;--line:#3f4147;--text:#f2f3f5;--muted:#b5bac1;--brand:#5865f2;--brand2:#7983f5;--ok:#23a55a}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 10% -10%,#252a5b55,transparent 36rem),var(--bg);color:var(--text);font:16px/1.65 Space,system-ui,sans-serif}
    a{color:#aeb4ff;text-underline-offset:3px}a:hover{color:#fff}.shell{width:min(980px,calc(100% - 32px));margin:auto}.top{display:flex;align-items:center;justify-content:space-between;padding:24px 0 18px;border-bottom:1px solid var(--line)}
    .brand{display:flex;align-items:center;gap:11px;color:var(--text);text-decoration:none;font-weight:700}.brand img{width:30px;height:30px}.locale{padding:8px 12px;border:1px solid var(--line);border-radius:10px;text-decoration:none;color:var(--muted)}
    main{padding:72px 0 96px}.eyebrow{margin:0 0 14px;color:var(--brand2);font-size:.78rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase}h1{max-width:820px;margin:0;font-size:clamp(2.35rem,7vw,4.8rem);line-height:.98;letter-spacing:-.06em}h2{margin:0 0 12px;font-size:1.35rem;letter-spacing:-.025em}p{margin:0 0 15px}.lead{max-width:780px;margin:24px 0 34px;color:var(--muted);font-size:1.13rem}.operator{display:grid;grid-template-columns:1fr auto;gap:18px;align-items:center;padding:22px;border:1px solid #6672f766;background:linear-gradient(135deg,#5865f222,#1e1f22);border-radius:18px}.operator strong{display:block;font-size:1.1rem}.operator span{color:var(--muted)}.button{display:inline-flex;padding:11px 15px;border-radius:10px;background:var(--brand);color:#fff;text-decoration:none;font-weight:700;white-space:nowrap}.button:hover{background:#6d78f6}
    .policy-meta{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 28px}.policy-meta span{padding:8px 11px;border:1px solid var(--line);border-radius:999px;background:var(--soft);color:var(--muted);font-size:.88rem}.draft{margin:0 0 24px;padding:15px 18px;border:1px solid #d99a3d88;border-radius:12px;background:#d99a3d16;color:#f0c98d}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:38px}.card{padding:26px;border:1px solid var(--line);border-radius:16px;background:var(--panel)}.wide{grid-column:1/-1}.card p,.card li{color:var(--muted)}ul{margin:12px 0 0;padding-left:21px}li+li{margin-top:9px}li strong{color:var(--text)}.retention{display:flex;gap:10px;flex-wrap:wrap}.pill{padding:9px 12px;border:1px solid var(--line);border-radius:999px;background:var(--soft);color:var(--text)!important}.warning{border-left:3px solid var(--brand);padding-left:16px}.storage{border-color:#d99a3d66}.storage h2:before{content:'↳ ';color:#d99a3d}.footer{padding:28px 0 40px;border-top:1px solid var(--line);color:var(--muted);font-size:.9rem}.footer-links{display:flex;gap:18px;flex-wrap:wrap}
    @media(max-width:720px){main{padding-top:48px}.grid{grid-template-columns:1fr}.operator{grid-template-columns:1fr}.button{justify-content:center}.card{padding:21px}}
  </style>
</head>
<body>
  <header class="shell top">
    <a class="brand" href="${esc(runtime.appUrl)}/app"><img src="/assets/kassinao-mark.png" alt=""><span>Kassinão</span></a>
    <a class="locale" href="${esc(alternate)}" lang="${pt ? 'en' : 'pt-BR'}">${pt ? 'Read in English' : 'Ler em português'}</a>
  </header>
  <main class="shell">
    <p class="eyebrow">${pt ? 'Transparência da instância' : 'Instance transparency'}</p>
    <h1>${esc(title)}</h1>
    <p class="lead">${esc(description)} ${pt ? 'Esta política descreve esta implantação, não todas as instalações possíveis do projeto público.' : 'This policy describes this deployment, not every possible installation of the public project.'}</p>
    ${localDraft ? `<p class="draft"><strong>${pt ? 'Rascunho local.' : 'Local draft.'}</strong> ${pt ? 'Os campos obrigatórios do operador ainda não foram preenchidos. Não use esta configuração com dados reais nem publique esta página como política de produção.' : 'Required operator fields are not filled yet. Do not use this configuration with real data or publish this page as a production policy.'}</p>` : ''}
    <div class="policy-meta"><span>${pt ? 'Vigência' : 'Effective'}: ${esc(runtime.privacyEffectiveDate || (pt ? 'não definida' : 'not set'))}</span><span>${pt ? 'Versão' : 'Version'}: ${esc(runtime.privacyPolicyVersion)}</span></div>
    <section class="operator" id="contact">
      <div><strong>${esc(runtime.operatorName)}</strong><span>${pt ? 'Opera esta instância, publica esta política e responde pelo canal abaixo. A base aplicável é declarada na seção seguinte.' : 'Operates this instance, publishes this policy, and responds through the channel below. The applicable basis is declared in the next section.'}</span></div>
      <a class="button" href="${esc(runtime.operatorContactUrl)}" rel="noopener">${pt ? 'Falar com o operador' : 'Contact the operator'}</a>
    </section>

    <div class="grid">
      <section class="card wide">
        <h2>${pt ? 'Aplicação, finalidade e base declarada' : 'Scope, purposes, and declared basis'}</h2>
        ${list([
          pt
            ? `<strong>Público abrangido:</strong> ${esc(runtime.privacyAudience || 'Somente testes locais; não configurado para participantes reais.')}`
            : `<strong>People covered:</strong> ${esc(runtime.privacyAudience || 'Local testing only; not configured for real participants.')}`,
          pt
            ? `<strong>Finalidades:</strong> ${esc(runtime.privacyPurposes || 'Desenvolvimento e validação local sem dados reais.')}`
            : `<strong>Purposes:</strong> ${esc(runtime.privacyPurposes || 'Local development and validation without real data.')}`,
          pt
            ? `<strong>Base legal ou justificativa:</strong> ${esc(runtime.privacyLawfulBasis || 'Não configurada. O operador precisa defini-la antes do uso real.')}`
            : `<strong>Lawful basis or justification:</strong> ${esc(runtime.privacyLawfulBasis || 'Not configured. The operator must define it before real use.')}`,
        ])}
        <p class="warning">${pt ? 'Essa declaração é fornecida pelo operador. O software não determina se ela é suficiente na jurisdição ou no contexto de trabalho aplicável.' : 'The operator provides this statement. The software does not determine whether it is sufficient in the applicable jurisdiction or workplace context.'}</p>
      </section>
      <section class="card">
        <h2>${pt ? 'O que é coletado' : 'Data collected'}</h2>
        ${list(
          pt
            ? [
                'IDs, nomes de exibição e avatar da conta do Discord usados no login e na atribuição.',
                'Servidor e canal de voz, presença na call, horários, eventos operacionais e notas adicionadas.',
                'Uma faixa de áudio por conta do Discord que fala e os arquivos de áudio derivados.',
                'Transcrição, ata, decisões e tarefas somente quando esses recursos estão habilitados.',
                'Registros de sessão web e MCP necessários para autenticação, expiração e revogação.',
              ]
            : [
                'Discord account IDs, display names, and avatar used for login and attribution.',
                'Server and voice channel, call presence, timestamps, operational events, and added notes.',
                'One audio track per Discord account that speaks and derived audio files.',
                'Transcript, minutes, decisions, and tasks only when those features are enabled.',
                'Web and MCP session records needed for authentication, expiry, and revocation.',
              ],
        )}
      </section>
      <section class="card">
        <h2>${pt ? 'Para que os dados são usados' : 'Why data is used'}</h2>
        ${list(
          pt
            ? [
                'Gravar e organizar calls solicitadas dentro dos servidores autorizados.',
                'Entregar reprodução, downloads e artefatos opcionais às pessoas autorizadas.',
                'Revalidar acesso, responder buscas e consultas MCP e proteger a operação contra abuso.',
                'Processar exclusão, diagnóstico de falhas e segurança da instância.',
              ]
            : [
                'Record and organize requested calls inside authorized servers.',
                'Provide playback, downloads, and optional artifacts to authorized people.',
                'Revalidate access, answer searches and MCP queries, and protect operations from abuse.',
                'Process deletion, failure diagnosis, and instance security.',
              ],
        )}
      </section>
      <section class="card wide">
        <h2>${pt ? 'Retenção configurada agora' : 'Retention configured now'}</h2>
        <div class="retention">
          <p class="pill">${esc(retentionText(locale, runtime.retentionDays, runtime.audioRetentionUnlimited, 'audio'))}</p>
          <p class="pill">${esc(retentionText(locale, runtime.textRetentionDays, runtime.textRetentionUnlimited, 'text'))}</p>
        </div>
        <p>${pt ? 'O prazo conta a partir do encerramento da gravação. Uma exclusão autorizada pode remover os dados antes desse limite.' : 'The period starts when the recording ends. An authorized deletion may remove data before that limit.'}</p>
        <p>${pt ? 'Depois da reinicialização, a rotina horária recalcula os prazos das reuniões concluídas a partir da configuração atual e da data de encerramento. Gravações ainda ativas recebem o prazo quando terminam. Download ou transcrição em andamento podem adiar a remoção física até a próxima execução segura da rotina.' : 'After restart, the hourly job recalculates completed-meeting deadlines from the current configuration and end time. Active recordings receive their deadline when they stop. An active download or transcription may delay physical removal until the next safe cleanup run.'}</p>
      </section>
      <section class="card">
        <h2>${pt ? 'Hospedagem e borda' : 'Hosting and edge'}</h2>
        <p><strong>${pt ? 'Infraestrutura:' : 'Infrastructure:'}</strong> ${esc(runtime.infrastructureProvider)}, ${pt ? 'região' : 'region'} ${esc(runtime.infrastructureRegion)}.</p>
        <p>${pt ? 'Esse provedor hospeda o runtime e o armazenamento ativo declarados pelo operador e pode processar metadados operacionais e o conteúdo armazenado conforme o contrato da instância.' : 'This provider hosts the runtime and active storage declared by the operator and may process operational metadata and stored content under the instance contract.'}</p>
        <p><strong>${pt ? 'Túnel/borda:' : 'Tunnel/edge:'}</strong> ${esc(edgeDescription)}</p>
        ${runtime.edgeProvider.toLowerCase() === 'none' ? '' : `<p>${pt ? 'O serviço de borda pode processar IP do visitante, conexão TLS, rota e conteúdo HTTP que passa pelas origens da instância. As regras e a política desse provider também se aplicam.' : 'The edge service may process visitor IP, TLS connection, route, and HTTP content passing through instance origins. That provider’s rules and policy also apply.'}</p>`}
        <p>${pt ? 'A página publica apenas provedor e região/escopo. IPs, hostnames privados, IDs de conta e coordenadas do host não fazem parte da política pública.' : 'This page publishes only provider and region/scope. IPs, private hostnames, account IDs, and host coordinates are not part of the public policy.'}</p>
      </section>
      <section class="card">
        <h2>${pt ? 'Logs operacionais e backup' : 'Operational logs and backup'}</h2>
        <p><strong>${pt ? 'Retenção de logs:' : 'Log retention:'}</strong> ${esc(runtime.operationalLogRetention || (pt ? 'não configurada para este rascunho local' : 'not configured for this local draft'))}</p>
        <p>${runtime.logPiiEnabled ? (pt ? 'LOG_PII está habilitado: identificadores, nomes, origens e mensagens de erro podem aparecer nos logs durante a janela de diagnóstico declarada acima.' : 'LOG_PII is enabled: identifiers, names, origins, and error messages may appear in logs during the diagnostic window declared above.') : pt ? 'LOG_PII está desativado: o limite de logging do app remove identificadores, nomes, origens e mensagens privadas de erro dos eventos operacionais classificados.' : 'LOG_PII is disabled: the app logging boundary removes identifiers, names, origins, and private error messages from classified operational events.'}</p>
        <p>${pt ? `O deploy image-only pode criar, dentro do volume protegido, um snapshot de estado operacional e metadados de gravações, sem o volume de autenticação nem as faixas de áudio. Em sucesso ele é removido imediatamente; se o deploy falhar, o controle do host limita sua existência a ${runtime.rollbackRetentionHours} horas.` : `The image-only deploy may create, inside the protected volume, a snapshot of operational state and recording metadata without the authentication volume or audio tracks. It is removed immediately on success; if deployment fails, the host control limits its lifetime to ${runtime.rollbackRetentionHours} hours.`}</p>
        <p><strong>Backup:</strong> ${esc(backupDescription)}</p>
        <p>${pt ? 'Esses campos descrevem a operação externa declarada; eles não ativam backup nem apagam cópias existentes. Backups históricos podem permanecer até o prazo aplicável à cópia ou até a reconciliação pelo operador.' : 'These fields describe the declared external operation; they do not enable backups or delete existing copies. Historical backups may remain until the deadline applicable to that copy or until operator reconciliation.'}</p>
      </section>
      <section class="card wide">
        <h2>${pt ? 'Serviços externos e saída de dados' : 'External services and data egress'}</h2>
        ${list(egress)}
        <p class="warning">${pt ? 'O projeto público não opera um serviço central que receba as reuniões de todas as instâncias. Os destinos acima são escolhidos e administrados por este operador.' : 'The public project does not operate a central service that receives meetings from every instance. This operator selects and administers the destinations above.'}</p>
      </section>
      <section class="card">
        <h2>${pt ? 'Quem pode acessar' : 'Who can access'}</h2>
        <p>${pt ? 'A URL não é a barreira de segurança. O app exige login Discord, membership atual em um servidor permitido e a ACL da gravação. Em regra, acessam quem iniciou, quem esteve na call ou quem tem Manage Server agora. O acesso é revalidado; falhas do Discord fecham o acesso.' : 'The URL is not the security boundary. The app requires Discord login, current membership in an allowed server, and the recording ACL. As a rule, access is available to the starter, people present in the call, or someone who currently has Manage Server. Access is revalidated; Discord failures close access.'}</p>
      </section>
      <section class="card">
        <h2>${pt ? 'Cookies e MCP' : 'Cookies and MCP'}</h2>
        <p>${pt ? 'O app usa cookies de sessão HttpOnly e SameSite=Lax para login e um cookie de idioma. Sessões podem ser revogadas. Quando MCP está habilitado, tokens de curta duração e sessões revogáveis dão acesso somente às reuniões que a mesma conta já pode ver; MCP não ignora a ACL.' : 'The app uses HttpOnly, SameSite=Lax session cookies for login and a language cookie. Sessions can be revoked. When MCP is enabled, short-lived tokens and revocable sessions provide access only to meetings the same account can already view; MCP does not bypass the ACL.'}</p>
        <p>${runtime.mcpEnabled ? (pt ? `MCP está habilitado. Access tokens expiram em ${runtime.mcpAccessTtlMin} minutos; a sessão de refresh expira em ${runtime.mcpRefreshTtlDays} dias e rotaciona a cada uso.` : `MCP is enabled. Access tokens expire in ${runtime.mcpAccessTtlMin} minutes; the refresh session expires in ${runtime.mcpRefreshTtlDays} days and rotates on use.`) : pt ? 'MCP está desativado nesta instância.' : 'MCP is disabled on this instance.'}</p>
      </section>
      <section class="card wide" id="data-rights">
        <h2>${pt ? 'Acesso, correção e exclusão' : 'Access, correction, and deletion'}</h2>
        <p>${pt ? 'Para pedir uma cópia, corrigir identificação ou solicitar exclusão, use o canal abaixo. Informe sua conta do Discord e dados suficientes para localizar a reunião, mas não publique conteúdo confidencial nem credenciais em issues do projeto.' : 'To request a copy, correct identification, or request deletion, use the channel below. Provide your Discord account and enough information to locate the meeting, but do not publish confidential content or credentials in project issues.'}</p>
        <p><strong>${pt ? 'Processo declarado:' : 'Declared process:'}</strong> ${esc(runtime.dataRequestProcess || (pt ? 'Use o contato do operador; o processo local ainda não foi configurado.' : 'Use the operator contact; the local process is not configured yet.'))}</p>
        <p>${pt ? `O operador declara resposta em até ${runtime.dataRequestResponseDays} dias corridos, sem ampliar prazo menor imposto pela lei aplicável.` : `The operator declares a response within ${runtime.dataRequestResponseDays} calendar days, without extending any shorter deadline imposed by applicable law.`}</p>
        <p><a class="button" href="${esc(runtime.operatorContactUrl)}" rel="noopener">${pt ? 'Solicitar acesso ou exclusão' : 'Request access or deletion'}</a></p>
        <p>${pt ? 'A exclusão pelo app está limitada a quem iniciou a gravação ou tem Manage Server. Participantes sem essa permissão devem usar o fluxo acima.' : 'In-app deletion is limited to the recording starter or someone with Manage Server. Participants without that permission should use the process above.'}</p>
        <p>${pt ? 'Excluir do volume ativo não comprova remoção imediata de backups históricos. O processo declarado acima precisa localizar essas cópias, aplicar a retenção informada e confirmar a resposta dentro do prazo aplicável.' : 'Deleting from the active volume does not prove immediate removal from historical backups. The declared process above must locate those copies, apply the stated retention, and confirm the response within the applicable window.'}</p>
      </section>
      <section class="card storage wide">
        <h2>${pt ? 'Armazenamento em repouso' : 'Data at rest'}</h2>
        <p>${pt ? 'O Kassinão não criptografa o volume ativo na camada da aplicação. Este operador é responsável por configurar e comprovar criptografia em repouso no host ou no provedor, incluindo volumes de gravação, estado, autenticação, cache temporário e swap. Backup criptografado, permissões de arquivo ou flags do container não provam que o armazenamento ativo está criptografado.' : 'Kassinão does not encrypt the active volume at the application layer. This operator is responsible for configuring and proving encryption at rest on the host or provider, including recording, state, authentication, temporary cache, and swap volumes. Encrypted backups, file permissions, or container flags do not prove that active storage is encrypted.'}</p>
      </section>
      <section class="card wide">
        <h2>${pt ? 'Incidentes de segurança' : 'Security incidents'}</h2>
        <p>${esc(runtime.incidentProcess || (pt ? 'O processo de incidente ainda não foi configurado neste rascunho local.' : 'The incident process is not configured in this local draft yet.'))}</p>
        <p><a href="${esc(runtime.incidentContactUrl)}" rel="noopener">${pt ? 'Contato específico para incidente' : 'Dedicated incident contact'}</a></p>
        <p>${pt ? 'Não envie tokens, chaves, gravações ou outros dados sensíveis em issue pública. Revogue a credencial afetada pelo canal operacional adequado e compartilhe evidências somente pelo contato acima.' : 'Do not send tokens, keys, recordings, or other sensitive data in a public issue. Revoke the affected credential through the appropriate operational channel and share evidence only through the contact above.'}</p>
      </section>
      <section class="card wide">
        <h2>${pt ? 'Aviso na call e responsabilidade legal' : 'Call notice and legal responsibility'}</h2>
        <p>${pt ? 'Antes da captura, o bot publica um aviso no chat do canal. Esse aviso é transparência técnica, não coleta aceite individual e não substitui consentimento, base legal, política interna ou obrigações da jurisdição aplicável. O operador deve obter as autorizações necessárias, especialmente antes de ativar gravação automática.' : 'Before capture, the bot posts a notice in the channel chat. That notice is technical disclosure; it does not collect individual acceptance and does not replace consent, a lawful basis, internal policy, or obligations under applicable law. The operator must obtain the required authorization, especially before enabling automatic recording.'}</p>
        <p>${termsLink}</p>
      </section>
    </div>
  </main>
  <footer class="shell footer">
    <div class="footer-links"><a href="${esc(runtime.operatorContactUrl)}" rel="noopener">${pt ? 'Contato do operador' : 'Operator contact'}</a><a href="${esc(runtime.dataDeletionUrl)}" rel="noopener">${pt ? 'Direitos sobre dados' : 'Data rights'}</a><a href="${esc(runtime.sourceUrl)}" rel="noopener">${pt ? 'Código-fonte desta instalação' : 'Source code for this installation'}</a>${runtime.termsOfServiceUrl ? `<a href="${esc(runtime.termsOfServiceUrl)}" rel="noopener">${pt ? 'Termos' : 'Terms'}</a>` : ''}</div>
    <p>${pt ? `Política ${runtime.privacyPolicyVersion}, vigente desde ${runtime.privacyEffectiveDate || 'data não definida'}. Gerada a partir da configuração ativa desta instância. Alterações de provider, retenção, infraestrutura ou integrações aparecem após a reinicialização com a nova configuração.` : `Policy ${runtime.privacyPolicyVersion}, effective ${runtime.privacyEffectiveDate || 'date not set'}. Generated from this instance’s active configuration. Provider, retention, infrastructure, or integration changes appear after restart with the new configuration.`}</p>
  </footer>
</body>
</html>`;
}
