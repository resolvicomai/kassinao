import type { Locale } from '../i18n';
import { revenueLandingStyles } from './revenueLandingStyles';

const BASE = 'https://kassinao.resolvicomai.app';

const PT = {
  title: 'Kassinão | Memória operacional para calls no Discord',
  description:
    'Grave uma faixa por pessoa, gere transcrição e ata com autoria e recupere decisões, tarefas e fontes depois da call.',
  skip: 'Ir para o conteúdo',
  navLabel: 'Navegação principal',
  nav: ['Problema', 'Como funciona', 'Privacidade', 'Para quem', 'FAQ'],
  locale: 'EN',
  headerCta: 'Ver call pronta',
  hero: {
    eyebrow: 'Memória operacional para calls no Discord',
    line1: 'A call termina.',
    line2: 'O contexto fica.',
    lead: 'Kassinão registra uma faixa por pessoa, transforma a conversa em transcrição e ata com autoria e deixa decisões, tarefas e fontes prontas para recuperar.',
    primary: 'Ver uma call pronta',
    secondary: 'Instalar com Docker',
    micro:
      'Demo pública com dados fictícios, sem login. A instalação exige um app do Discord e infraestrutura própria.',
    noteLabel: 'Depois da call',
    note: 'Pergunte quem decidiu, o que ficou pendente e onde isso foi dito.',
    alt: 'Pessoa em uma conversa de trabalho por voz usando headset',
  },
  facts: [
    ['Open source', 'Licença AGPL-3.0'],
    ['Self-hosted', 'Você opera a instância'],
    ['Autoria preservada', 'Uma faixa por conta do Discord'],
    ['PT e EN', 'Interface e comandos localizados'],
  ],
  problem: {
    kicker: 'O problema real',
    title: 'O áudio guarda a conversa. O time precisa recuperar o que ela decidiu.',
    intro:
      'Depois da call, ninguém quer vasculhar uma hora de gravação. As perguntas são objetivas e precisam voltar à pessoa, ao contexto e à fonte.',
    questions: ['Quem falou isso?', 'O que ficou combinado?', 'Qual trecho comprova?'],
  },
  mechanism: {
    kicker: 'O mecanismo',
    title: 'Uma faixa por pessoa transforma gravação em contexto.',
    intro:
      'A identidade vem da conta que gerou a faixa, não de uma tentativa de adivinhar vozes em um áudio misturado. A partir daí, cada etapa mantém autoria e tempo.',
    steps: [
      ['Comece no Discord', 'Use /gravar. O bot entra no canal e sinaliza que a captura está ativa.'],
      ['Marque o que importa', 'Use /nota ou marque um momento enquanto a conversa acontece.'],
      ['Processe na sua instância', 'VAD, transcrição e ata entram no fluxo conforme os provedores configurados.'],
      ['Recupere com fonte', 'Busque na web, use /perguntar ou conecte um assistente pelo MCP.'],
    ],
    mapLabel: 'Da voz para a memória consultável',
    tracks: ['Priya', 'Rafael', 'Mei'],
    outputs: ['Transcrição com autoria', 'Decisões e tarefas', 'Resposta ligada à fonte'],
  },
  proof: {
    kicker: 'Prova antes da instalação',
    title: 'Pergunte à reunião e volte ao trecho exato.',
    intro:
      'A demo pública mostra uma reunião fictícia completa. Você pode abrir o áudio, a transcrição, a ata e as ações sem expor dados de nenhum servidor real.',
    sideTitle: 'Não imagine a entrega. Abra a entrega.',
    sideBody:
      'O exemplo usa o mesmo conteúdo estruturado que alimenta a página de uma gravação. Explore primeiro, instale depois.',
    cta: 'Abrir demo completa',
    micro: 'Sem cadastro. Somente dados fictícios versionados no projeto.',
    meeting: 'Northwind, product sync',
    duration: '58 min, exemplo fictício',
    question: 'O que bloqueia o lançamento?',
    answer: 'O lançamento de quinta depende do rollback do onboarding e de um teste de carga aprovado.',
    source: 'Priya confirma o gate; Rafael e Mei assumem as duas ações até quarta.',
  },
  privacy: {
    kicker: 'Privacidade sem slogan vazio',
    title: 'Acesso segue o contexto da call.',
    intro:
      'Gravações reais ficam na área privada. O acesso exige vínculo atual com o servidor e respeita as regras do canal no momento da gravação.',
    alt: 'Mesa de trabalho com headset e computador pequeno usados para operar uma instância própria',
    caption: 'A instância pode rodar na infraestrutura escolhida pelo operador.',
    points: [
      'Canais restritos mantêm o histórico limitado a participantes, iniciador e administração.',
      'Sair do servidor remove o acesso, mesmo para quem esteve na call.',
      'A mesma regra de autorização protege a web e o conector MCP.',
      'O operador define retenção e pode remover só o áudio, mantendo o texto.',
    ],
    truth:
      'Self-hosted não significa que nenhum dado sai do servidor. Se você configurar ASR ou IA externos, o conteúdo necessário é enviado ao provedor escolhido. Também é possível configurar transcrição local.',
  },
  fit: {
    kicker: 'Qualificação',
    title: 'Foi feito para o seu servidor?',
    intro:
      'Kassinão prioriza times que trabalham em voz no Discord e querem memória recuperável sem entregar o controle da infraestrutura.',
    yesTitle: 'Faz sentido quando',
    yes: [
      'decisões e tarefas surgem em calls recorrentes',
      'saber quem falou e voltar à fonte importa',
      'Discord já é um ambiente de trabalho do time',
      'alguém pode administrar Docker e o app do Discord',
    ],
    noTitle: 'Talvez não seja para você quando',
    no: [
      'você quer um bot público instalado em um clique',
      'ninguém consulta o conteúdo depois da call',
      'você não quer operar infraestrutura ou provedores',
      'precisa de várias gravações simultâneas no mesmo servidor',
    ],
  },
  faq: {
    kicker: 'Sem letras miúdas',
    title: 'Perguntas antes de subir a instância.',
    items: [
      [
        'É um bot pronto para adicionar ao servidor?',
        'Não no modelo atual. Você cria um app no Discord, configura as credenciais e executa sua própria instância.',
      ],
      [
        'Transcrição e ata já vêm ligadas?',
        'São capacidades configuráveis. A transcrição exige um provedor ou comando local. A ata depende da transcrição e de um provedor de IA configurado.',
      ],
      [
        'O áudio precisa sair do meu servidor?',
        'Não obrigatoriamente. Você pode usar um comando local de transcrição. Com provedores externos, o áudio ou texto necessário é enviado a eles.',
      ],
      [
        'Quem consegue abrir uma gravação?',
        'É preciso continuar no servidor. Em canais restritos, o acesso fica com participantes, iniciador e administradores atuais.',
      ],
      [
        'Quantas calls podem ser gravadas ao mesmo tempo?',
        'Atualmente, uma gravação por servidor. Cada sessão aceita até 25 faixas de participantes.',
      ],
      [
        'O software é gratuito?',
        'O código é open source sob AGPL-3.0. Hospedagem, domínio e provedores externos podem gerar custos.',
      ],
    ],
  },
  final: {
    title: 'Pare de deixar decisões presas no áudio.',
    body: 'Valide o resultado na demo. Depois, siga o guia para criar o app do Discord, subir sua instância e começar com /gravar.',
    primary: 'Ver uma call pronta',
    secondary: 'Instalar com Docker',
    note: 'A implantação requer infraestrutura própria. Custos dependem dos serviços escolhidos.',
  },
  footer: [
    'Código no GitHub',
    'Documentação',
    'Demo pública',
    'Conector MCP',
    'Open source, self-hosted, feito para Discord.',
  ],
} as const;

const EN = {
  title: 'Kassinão | Operational memory for Discord calls',
  description:
    'Record one track per person, generate attributed transcripts and notes, then retrieve decisions, tasks, and sources after the call.',
  skip: 'Skip to content',
  navLabel: 'Main navigation',
  nav: ['Problem', 'How it works', 'Privacy', 'Who it fits', 'FAQ'],
  locale: 'PT',
  headerCta: 'See a finished call',
  hero: {
    eyebrow: 'Operational memory for Discord calls',
    line1: 'The call ends.',
    line2: 'Context stays.',
    lead: 'Kassinão records one track per person, turns the conversation into an attributed transcript and meeting notes, and keeps decisions, tasks, and sources ready to retrieve.',
    primary: 'See a finished call',
    secondary: 'Install with Docker',
    micro:
      'Public demo with fictional data, no login. Installation requires a Discord app and your own infrastructure.',
    noteLabel: 'After the call',
    note: 'Ask who decided, what is still pending, and where it was said.',
    alt: 'Person in a work voice call wearing a headset',
  },
  facts: [
    ['Open source', 'AGPL-3.0 license'],
    ['Self-hosted', 'You operate the instance'],
    ['Attribution preserved', 'One track per Discord account'],
    ['PT and EN', 'Localized interface and commands'],
  ],
  problem: {
    kicker: 'The actual problem',
    title: 'Audio keeps the conversation. Your team needs to retrieve what it decided.',
    intro:
      'After the call, nobody wants to scrub through an hour of audio. The questions are specific and need to lead back to the person, context, and source.',
    questions: ['Who said it?', 'What did we agree on?', 'Which moment proves it?'],
  },
  mechanism: {
    kicker: 'The mechanism',
    title: 'One track per person turns a recording into context.',
    intro:
      'Identity comes from the account that produced the track, not an attempt to guess voices in mixed audio. From there, every step preserves attribution and time.',
    steps: [
      ['Start in Discord', 'Use /record. The bot joins the channel and signals that capture is active.'],
      ['Mark what matters', 'Use /note or mark a moment while the conversation is happening.'],
      [
        'Process on your instance',
        'VAD, transcription, and notes enter the flow according to your configured providers.',
      ],
      ['Retrieve with a source', 'Search on the web, use /ask, or connect an assistant through MCP.'],
    ],
    mapLabel: 'From voice to searchable memory',
    tracks: ['Priya', 'Rafael', 'Mei'],
    outputs: ['Attributed transcript', 'Decisions and tasks', 'Answer linked to source'],
  },
  proof: {
    kicker: 'Proof before installation',
    title: 'Ask the meeting and return to the exact moment.',
    intro:
      'The public demo shows a complete fictional meeting. Open its audio, transcript, notes, and actions without exposing data from a real server.',
    sideTitle: 'Do not imagine the output. Open it.',
    sideBody:
      'The example uses the same structured content that powers a recording page. Explore first, install second.',
    cta: 'Open the full demo',
    micro: 'No signup. Only fictional data versioned with the project.',
    meeting: 'Northwind, product sync',
    duration: '58 min, fictional example',
    question: 'What is blocking the launch?',
    answer: "Thursday's launch depends on rolling back onboarding and passing a load test.",
    source: 'Priya confirms the gate; Rafael and Mei own the two actions by Wednesday.',
  },
  privacy: {
    kicker: 'Privacy without an empty slogan',
    title: 'Access follows the call context.',
    intro:
      'Real recordings stay in the private area. Access requires current server membership and respects the channel rules at recording time.',
    alt: 'Work desk with a headset and small computer used to operate a private instance',
    caption: 'The instance can run on infrastructure selected by the operator.',
    points: [
      'Restricted channels keep history limited to participants, the initiator, and administrators.',
      'Leaving the server removes access, even for someone who joined the call.',
      'The same authorization rule protects the web and the MCP connector.',
      'The operator sets retention and can remove audio while keeping text.',
    ],
    truth:
      'Self-hosted does not mean data can never leave the server. If you configure external ASR or AI, the required content is sent to your selected provider. Local transcription is also supported.',
  },
  fit: {
    kicker: 'Qualification',
    title: 'Is it built for your server?',
    intro:
      'Kassinão prioritizes teams that work in Discord voice and want retrievable memory without giving up infrastructure control.',
    yesTitle: 'It fits when',
    yes: [
      'decisions and tasks emerge from recurring calls',
      'knowing who spoke and returning to the source matters',
      'Discord is already a work environment for the team',
      'someone can manage Docker and the Discord app',
    ],
    noTitle: 'It may not fit when',
    no: [
      'you want a public bot installed with one click',
      'nobody consults the content after a call',
      'you do not want to operate infrastructure or providers',
      'you need several simultaneous recordings in one server',
    ],
  },
  faq: {
    kicker: 'No fine print',
    title: 'Questions before you run the instance.',
    items: [
      [
        'Is this a bot I can add to a server right away?',
        'Not in the current model. You create a Discord app, configure credentials, and run your own instance.',
      ],
      [
        'Are transcription and meeting notes enabled by default?',
        'They are configurable. Transcription requires a provider or local command. Meeting notes depend on a transcript and a configured AI provider.',
      ],
      [
        'Does audio have to leave my server?',
        'Not necessarily. You can use a local transcription command. With external providers, the audio or text required for processing is sent to them.',
      ],
      [
        'Who can open a recording?',
        'The person must remain in the server. In restricted channels, access is limited to participants, the recording initiator, and current administrators.',
      ],
      [
        'How many calls can be recorded at once?',
        'Currently, one recording per server. Each session accepts up to 25 participant tracks.',
      ],
      [
        'Is the software free?',
        'The code is open source under AGPL-3.0. Hosting, domains, and external providers may have costs.',
      ],
    ],
  },
  final: {
    title: 'Stop leaving decisions trapped in audio.',
    body: 'Validate the output in the demo. Then follow the guide to create the Discord app, run your instance, and start with /record.',
    primary: 'See a finished call',
    secondary: 'Install with Docker',
    note: 'Deployment requires your own infrastructure. Costs depend on the services you choose.',
  },
  footer: [
    'Code on GitHub',
    'Documentation',
    'Public demo',
    'MCP connector',
    'Open source, self-hosted, built for Discord.',
  ],
} as const;

function structuredData(locale: Locale, title: string, description: string): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Kassinão',
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Server',
    inLanguage: locale === 'pt' ? 'pt-BR' : 'en',
    headline: title,
    description,
    url: locale === 'pt' ? BASE : `${BASE}/en`,
    license: 'https://www.gnu.org/licenses/agpl-3.0.html',
    codeRepository: 'https://github.com/resolvicomai/kassinao',
  }).replace(/</g, '\\u003c');
}

export function revenueLandingPage(locale: Locale = 'pt'): string {
  const c = locale === 'pt' ? PT : EN;
  const english = locale === 'en';
  const links = {
    home: english ? '/en' : '/',
    alternate: english ? '/' : '/en',
    demo: english ? '/demo?lang=en' : '/demo?lang=pt',
    docs: english
      ? 'https://github.com/resolvicomai/kassinao#quick-start'
      : 'https://github.com/resolvicomai/kassinao/blob/main/README.pt-BR.md#comece-agora',
    github: 'https://github.com/resolvicomai/kassinao',
    mcp: 'https://www.npmjs.com/package/kassinao-mcp',
  };
  const htmlLang = english ? 'en' : 'pt-BR';
  const canonicalUrl = english ? `${BASE}/en` : BASE;
  const og = locale === 'pt' ? '/og-pt.png' : '/og-en.png';
  const altLang = english ? 'pt-BR' : 'en';

  return `<!doctype html>
<html lang="${htmlLang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#171715" media="(prefers-color-scheme:dark)">
  <meta name="theme-color" content="#f2efe8" media="(prefers-color-scheme:light)">
  <title>${c.title}</title>
  <meta name="description" content="${c.description}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Kassinão">
  <meta property="og:locale" content="${english ? 'en_US' : 'pt_BR'}">
  <meta property="og:title" content="${c.title}">
  <meta property="og:description" content="${c.description}">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:image" content="${BASE}${og}">
  <meta property="og:image:alt" content="${c.hero.alt}">
  <meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${c.title}">
  <meta name="twitter:description" content="${c.description}">
  <meta name="twitter:image" content="${BASE}${og}">
  <link rel="canonical" href="${canonicalUrl}">
  <link rel="alternate" hreflang="pt-BR" href="${BASE}/">
  <link rel="alternate" hreflang="en" href="${BASE}/en">
  <link rel="alternate" hreflang="x-default" href="${BASE}/en">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='25' fill='none' stroke='%23171714' stroke-width='5'/%3E%3Ccircle cx='32' cy='32' r='9' fill='%23c13b25'/%3E%3C/svg%3E">
  <style>${revenueLandingStyles}</style>
  <script>document.documentElement.classList.add('js')</script>
  <script type="application/ld+json">${structuredData(locale, c.title, c.description)}</script>
</head>
<body>
  <a class="skip" href="#main">${c.skip}</a>
  <header class="header"><div class="header__in">
    <a class="brand" href="${links.home}" aria-label="Kassinão"><span class="brand__signal" aria-hidden="true"></span>Kassinão</a>
    <nav class="nav" aria-label="${c.navLabel}"><ul>
      <li><a href="#problem">${c.nav[0]}</a></li><li><a href="#mechanism">${c.nav[1]}</a></li>
      <li><a href="#privacy">${c.nav[2]}</a></li><li><a href="#fit">${c.nav[3]}</a></li><li><a href="#faq">${c.nav[4]}</a></li>
    </ul></nav>
    <div class="header__actions"><a class="locale" href="${links.alternate}" hreflang="${altLang}">${c.locale}</a><a class="button button--accent button--small" href="${links.demo}">${c.headerCta}<span class="arrow" aria-hidden="true">→</span></a></div>
  </div></header>
  <main id="main">
    <section class="hero" aria-labelledby="hero-title">
      <div class="hero__copy reveal"><p class="eyebrow">${c.hero.eyebrow}</p><h1 id="hero-title"><span>${c.hero.line1}</span><span>${c.hero.line2}</span></h1><p class="hero__lead">${c.hero.lead}</p>
        <div class="hero__actions"><a class="button button--accent" href="${links.demo}">${c.hero.primary}<span class="arrow" aria-hidden="true">→</span></a><a class="button button--ghost" href="${links.docs}">${c.hero.secondary}</a></div><p class="micro">${c.hero.micro}</p>
      </div>
      <div class="hero__visual reveal"><div class="hero__photo"><img src="/assets/kassinao-revenue-hero.webp" width="960" height="1200" alt="${c.hero.alt}" fetchpriority="high"></div><div class="hero__note"><b>${c.hero.noteLabel}</b><p>${c.hero.note}</p></div></div>
    </section>
    <aside class="facts" aria-label="Kassinão facts"><div class="facts__in">${c.facts.map(([a, b]) => `<div class="fact"><strong>${a}</strong><span>${b}</span></div>`).join('')}</div></aside>
    <section class="section" id="problem" aria-labelledby="problem-title"><div class="problem"><div class="reveal"><p class="kicker">${c.problem.kicker}</p><h2 id="problem-title">${c.problem.title}</h2><p class="intro">${c.problem.intro}</p></div><ol class="questions reveal">${c.problem.questions.map((q, i) => `<li><span>0${i + 1}</span>${q}</li>`).join('')}</ol></div></section>
    <section class="mechanism" id="mechanism" aria-labelledby="mechanism-title"><div class="section"><div class="reveal"><p class="kicker">${c.mechanism.kicker}</p><h2 id="mechanism-title">${c.mechanism.title}</h2><p class="intro">${c.mechanism.intro}</p></div><div class="mechanism__grid"><ol class="steps reveal">${c.mechanism.steps.map(([a, b]) => `<li class="step"><h3>${a}</h3><p>${b}</p></li>`).join('')}</ol><div class="map reveal" aria-label="${c.mechanism.mapLabel}"><p class="map__label">${c.mechanism.mapLabel}</p><div class="tracks">${c.mechanism.tracks.map((n) => `<div class="track"><span>${n}</span><div class="wave" aria-hidden="true"></div></div>`).join('')}</div><div class="outputs">${c.mechanism.outputs.map((o) => `<div class="output">${o}</div>`).join('')}</div></div></div></div></section>
    <section class="section" id="proof" aria-labelledby="proof-title"><div class="reveal"><p class="kicker">${c.proof.kicker}</p><h2 id="proof-title">${c.proof.title}</h2><p class="intro">${c.proof.intro}</p></div><div class="proof"><div class="proof__copy reveal"><h3>${c.proof.sideTitle}</h3><p>${c.proof.sideBody}</p><a class="button button--accent" href="${links.demo}">${c.proof.cta}<span class="arrow" aria-hidden="true">→</span></a><p class="micro">${c.proof.micro}</p></div><article class="sheet reveal" aria-label="${c.proof.meeting}"><div class="sheet__top"><strong>${c.proof.meeting}</strong><span>${c.proof.duration}</span></div><p class="sheet__q">${c.proof.question}</p><p class="sheet__a">${c.proof.answer}</p><div class="source"><time datetime="PT55M34S">55:34</time><p>${c.proof.source}</p></div></article></div></section>
    <section class="section section--rule" id="privacy" aria-labelledby="privacy-title"><div class="privacy"><figure class="reveal"><img src="/assets/kassinao-revenue-after-call.webp" width="1440" height="900" alt="${c.privacy.alt}" loading="lazy"><figcaption>${c.privacy.caption}</figcaption></figure><div class="reveal"><p class="kicker">${c.privacy.kicker}</p><h2 id="privacy-title">${c.privacy.title}</h2><p class="intro">${c.privacy.intro}</p><ul>${c.privacy.points.map((p) => `<li><b aria-hidden="true">✓</b><span>${p}</span></li>`).join('')}</ul><p class="truth">${c.privacy.truth}</p></div></div></section>
    <section class="section section--rule" id="fit" aria-labelledby="fit-title"><div class="reveal"><p class="kicker">${c.fit.kicker}</p><h2 id="fit-title">${c.fit.title}</h2><p class="intro">${c.fit.intro}</p></div><div class="fit reveal"><div class="fit__col"><h3>${c.fit.yesTitle}</h3><ul>${c.fit.yes.map((x) => `<li>${x}</li>`).join('')}</ul></div><div class="fit__col fit__col--not"><h3>${c.fit.noTitle}</h3><ul>${c.fit.no.map((x) => `<li>${x}</li>`).join('')}</ul></div></div></section>
    <section class="section section--rule" id="faq" aria-labelledby="faq-title"><div class="faq"><div class="reveal"><p class="kicker">${c.faq.kicker}</p><h2 id="faq-title">${c.faq.title}</h2></div><div class="faq__list reveal">${c.faq.items.map(([q, a], i) => `<details${i === 0 ? ' open' : ''}><summary>${q}</summary><p>${a}</p></details>`).join('')}</div></div></section>
    <section class="final" aria-labelledby="final-title"><div class="final__in reveal"><h2 id="final-title">${c.final.title}</h2><div class="final__side"><p>${c.final.body}</p><div class="final__actions"><a class="button" href="${links.demo}">${c.final.primary}<span class="arrow" aria-hidden="true">→</span></a><a class="button button--ghost" href="${links.docs}">${c.final.secondary}</a></div><small>${c.final.note}</small></div></div></section>
  </main>
  <footer class="footer"><div class="footer__in"><div class="footer__links"><a href="${links.github}" rel="noopener noreferrer">${c.footer[0]}</a><a href="${links.docs}">${c.footer[1]}</a><a href="${links.demo}">${c.footer[2]}</a><a href="${links.mcp}" rel="noopener noreferrer">${c.footer[3]}</a></div><div class="footer__note">${c.footer[4]}</div></div></footer>
  <script>(()=>{const items=[...document.querySelectorAll('.reveal')];if(!('IntersectionObserver'in window)){items.forEach(x=>x.classList.add('visible'));return}const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('visible');observer.unobserve(entry.target)}}),{rootMargin:'0px 0px -8% 0px',threshold:.08});items.forEach(x=>observer.observe(x))})()</script>
</body></html>`;
}
