/*
 * Preview visual isolado do Kassinão.
 *
 * Este processo nunca conecta ao Discord, não lê .env e não usa gravações reais.
 * Ele serve apenas os renderizadores HTML com fixtures locais e estados sintéticos.
 */

const rawPreviewPort = process.env.PREVIEW_PORT ?? '18080';
const previewPort = Number(rawPreviewPort);

if (!Number.isInteger(previewPort) || previewPort < 1 || previewPort > 65_535) {
  throw new Error(`PREVIEW_PORT precisa ser um inteiro entre 1 e 65535 (recebido: ${rawPreviewPort})`);
}

// A configuração é carregada indiretamente pelos renderizadores. Sobrescrever tudo
// antes dos imports dinâmicos garante que nenhum segredo real do shell ou .env seja usado.
Object.assign(process.env, {
  DISCORD_TOKEN: 'preview-only-never-connect',
  APPLICATION_ID: '000000000000000000',
  DISCORD_CLIENT_SECRET: 'preview-only-client-secret',
  COOKIE_SECRET: 'preview-only-cookie-secret-with-more-than-32-bytes',
  BASE_URL: `http://localhost:${previewPort}`,
  PORT: String(previewPort),
  RECORDINGS_DIR: '/tmp/kassinao-preview-recordings',
  RETENTION_DAYS: '7',
  TEXT_RETENTION_DAYS: '90',
  TRANSCRIBE_PROVIDER: 'none',
  DEFAULT_LOCALE: 'pt',
  TZ: 'America/Sao_Paulo',
  REPO_PUBLIC: 'true',
  OWNER_IDS: 'preview-user',
  MCP_SECRET: 'preview-only-mcp-secret-with-more-than-32-bytes',
  OPENAI_API_KEY: '',
  GROQ_API_KEY: '',
  GEMINI_API_KEY: '',
  ASSEMBLYAI_API_KEY: '',
  OPENROUTER_API_KEY: '',
});

type RecordingMeta = import('../src/store').RecordingMeta;
type TranscriptSegment = import('../src/store').TranscriptSegment;
type MeetingMinutes = import('../src/store').MeetingMinutes;
type RecordingIndexItem = import('../src/web/page').RecordingIndexItem;
type WebUser = import('../src/web/auth').WebUser;
type WebSearchHit = import('../src/web/search').WebSearchHit;
type Locale = import('../src/i18n').Locale;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

async function main(): Promise<void> {
  const [expressModule, fsModule, pathModule, landingModule, docsModule, pageModule, siteModule, discordDemoModule] =
    await Promise.all([
      import('express'),
      import('node:fs'),
      import('node:path'),
      import('../src/web/landing'),
      import('../src/web/docs'),
      import('../src/web/page'),
      import('../src/web/site'),
      import('../src/web/discordDemo'),
    ]);

  const express = expressModule.default;
  const fs = fsModule.default;
  const path = pathModule.default;
  const { landingPage } = landingModule;
  const { docsPage } = docsModule;
  const { connectPage, recordingPage, recordingsIndexPage } = pageModule;
  const { localeCookie, localeFromValue, resolveWebLocale } = siteModule;
  const { discordDemoPage } = discordDemoModule;

  const rootDir = path.resolve(__dirname, '..');
  const exampleDir = path.join(rootDir, 'docs', 'example');
  const fontPath = path.join(
    rootDir,
    'node_modules',
    '@fontsource-variable',
    'space-grotesk',
    'files',
    'space-grotesk-latin-wght-normal.woff2',
  );
  const demoAudioPath = path.join(exampleDir, 'sample-audio.mp3');
  const ogPath = path.join(rootDir, 'docs', 'og.png');
  const brandDir = path.join(rootDir, 'docs', 'brand');
  const brandMarkPath = path.join(brandDir, 'kassinao-mark-64.png');
  const faviconPath = path.join(brandDir, 'favicon-32.png');
  const appleTouchIconPath = path.join(brandDir, 'apple-touch-icon-180.png');

  for (const requiredFile of [fontPath, demoAudioPath, ogPath, brandMarkPath, faviconPath, appleTouchIconPath]) {
    if (!fs.existsSync(requiredFile)) throw new Error(`Fixture obrigatória ausente: ${requiredFile}`);
  }

  const [fixtureMeta, fixtureTranscript, fixtureMinutes, fixtureTranscriptPt, fixtureMinutesPt] = await Promise.all([
    fs.promises.readFile(path.join(exampleDir, 'meta.json'), 'utf8').then((raw) => JSON.parse(raw) as RecordingMeta),
    fs.promises
      .readFile(path.join(exampleDir, 'transcript.json'), 'utf8')
      .then((raw) => JSON.parse(raw) as TranscriptSegment[]),
    fs.promises
      .readFile(path.join(exampleDir, 'minutes.json'), 'utf8')
      .then((raw) => JSON.parse(raw) as MeetingMinutes),
    fs.promises
      .readFile(path.join(exampleDir, 'transcript.pt.json'), 'utf8')
      .then((raw) => JSON.parse(raw) as TranscriptSegment[]),
    fs.promises
      .readFile(path.join(exampleDir, 'minutes.pt.json'), 'utf8')
      .then((raw) => JSON.parse(raw) as MeetingMinutes),
  ]);

  const now = Date.now();
  const previewUser: WebUser = {
    typ: 'session',
    id: 'preview-user',
    name: 'Pessoa Preview',
    avatar: null,
    exp: now + DAY,
    jti: 'preview-session-never-persisted',
  };

  function makeMeta(
    id: string,
    channelName: string,
    startedAt: number,
    endedAt: number | undefined,
    overrides: Partial<RecordingMeta> = {},
  ): RecordingMeta {
    const participants = structuredClone(fixtureMeta.participants.slice(0, 4));
    const duration = Math.max(MINUTE, (endedAt ?? now) - startedAt);

    return {
      id,
      guildId: 'preview-guild',
      guildName: 'Time Kassinão · preview fictício',
      voiceChannelId: `preview-${id}`,
      voiceChannelName: channelName,
      sourceEveryoneViewable: false,
      startedBy: { id: previewUser.id, name: previewUser.name },
      locale: 'pt',
      startedAt,
      endedAt,
      status: endedAt ? 'done' : 'recording',
      participants,
      presence: [
        ...participants.map((participant) => ({
          id: participant.id,
          name: participant.name,
          joinedAtMs: 0,
        })),
        { id: 'silent-preview', name: 'Lina', joinedAtMs: 2 * MINUTE },
      ],
      events: [
        { atMs: 0, text: `▶️ Gravação fictícia iniciada por ${previewUser.name}` },
        { atMs: Math.min(4 * MINUTE, duration / 3), text: '📌 Decisão importante marcada no preview' },
        { atMs: Math.max(1_000, duration - 1_000), text: endedAt ? '⏹️ Gravação finalizada' : '🔴 Ainda ao vivo' },
      ],
      notes: [
        {
          atMs: Math.min(12 * MINUTE, duration / 2),
          author: 'Priya',
          text: 'Confirmar responsável e prazo antes da próxima reunião.',
        },
      ],
      transcription: { status: 'done', provider: 'preview' },
      minutes: { status: 'done', model: 'preview' },
      expiresAt: now + 7 * DAY,
      textExpiresAt: now + 90 * DAY,
      notifiedAt: endedAt ? endedAt + MINUTE : undefined,
      demo: false,
      ...overrides,
    };
  }

  const previewChannels: Record<string, { pt: string; en: string }> = {
    'preview-done': { pt: 'produto-semanal', en: 'weekly-product' },
    'preview-live': { pt: 'sala-de-incidente', en: 'war-room' },
    'preview-partial': { pt: 'pesquisa-clientes', en: 'customer-research' },
    'preview-error': { pt: 'incidente-api', en: 'api-incident' },
    'preview-audio-gone': { pt: 'planejamento-trimestral', en: 'quarterly-planning' },
    'preview-incomplete': { pt: 'sync-operacoes', en: 'operations-sync' },
  };

  const previewUserFor = (locale: Locale): WebUser => ({
    ...previewUser,
    name: locale === 'pt' ? 'Pessoa Preview' : 'Preview User',
  });

  function localizedPreviewMeta(meta: RecordingMeta, locale: Locale): RecordingMeta {
    const localized = structuredClone(meta);
    const userName = previewUserFor(locale).name;
    const duration = Math.max(MINUTE, (localized.endedAt ?? now) - localized.startedAt);
    localized.locale = locale;
    localized.guildName = locale === 'pt' ? 'Time Kassinão · preview fictício' : 'Kassinão Team · fictional preview';
    localized.voiceChannelName = previewChannels[localized.id]?.[locale] ?? localized.voiceChannelName;
    if (localized.startedBy) localized.startedBy.name = userName;
    localized.events = [
      {
        atMs: 0,
        text:
          locale === 'pt'
            ? `▶️ Gravação fictícia iniciada por ${userName}`
            : `▶️ Fictional recording started by ${userName}`,
      },
      {
        atMs: Math.min(4 * MINUTE, duration / 3),
        text:
          locale === 'pt' ? '📌 Decisão importante marcada no preview' : '📌 Important decision marked in the preview',
      },
      {
        atMs: Math.max(1_000, duration - 1_000),
        text:
          localized.status === 'done'
            ? locale === 'pt'
              ? '⏹️ Gravação finalizada'
              : '⏹️ Recording finished'
            : locale === 'pt'
              ? '🔴 Ainda ao vivo'
              : '🔴 Still live',
      },
    ];
    localized.notes = localized.notes.map((note) => ({
      ...note,
      text:
        locale === 'pt'
          ? 'Confirmar responsável e prazo antes da próxima reunião.'
          : 'Confirm the owner and deadline before the next meeting.',
    }));
    if (localized.transcription?.error) {
      localized.transcription.error =
        locale === 'pt'
          ? 'Falha fictícia do provedor para validar o estado visual de erro.'
          : 'Fictional provider failure used to validate the error state.';
    }
    if (localized.minutes?.error) {
      localized.minutes.error =
        locale === 'pt'
          ? 'Ata fictícia indisponível porque a transcrição falhou.'
          : 'Fictional minutes unavailable because transcription failed.';
    }
    return localized;
  }

  const doneMeta = makeMeta('preview-done', 'produto-semanal', now - 4 * HOUR, now - 3 * HOUR, {
    transcription: { status: 'done', provider: 'preview' },
    minutes: { status: 'done', model: 'preview' },
  });
  const liveMeta = makeMeta('preview-live', 'war-room', now - 28 * MINUTE, undefined, {
    transcription: { status: 'pending', provider: 'preview' },
    minutes: { status: 'pending', model: 'preview' },
  });
  const partialMeta = makeMeta('preview-partial', 'pesquisa-clientes', now - DAY, now - DAY + 52 * MINUTE, {
    transcription: {
      status: 'partial',
      provider: 'preview',
      pendingTracks: ['Lina', 'Rafael'],
      retryScheduled: false,
    },
    minutes: { status: 'disabled' },
  });
  const errorMeta = makeMeta('preview-error', 'incidente-api', now - 2 * DAY, now - 2 * DAY + 41 * MINUTE, {
    transcription: {
      status: 'error',
      provider: 'preview',
      error: 'Falha fictícia do provedor para validar o estado visual de erro.',
      retryScheduled: false,
    },
    minutes: { status: 'error', error: 'Ata fictícia indisponível porque a transcrição falhou.' },
  });
  const audioGoneMeta = makeMeta(
    'preview-audio-gone',
    'planejamento-trimestral',
    now - 10 * DAY,
    now - 10 * DAY + 75 * MINUTE,
    {
      audioDeleted: true,
      expiresAt: now - 3 * DAY,
      textExpiresAt: now + 80 * DAY,
      transcription: { status: 'done', provider: 'preview' },
      minutes: { status: 'done', model: 'preview' },
    },
  );
  const incompleteMeta = makeMeta(
    'preview-incomplete',
    'sync-operacoes',
    now - 18 * DAY,
    now - 18 * DAY + 33 * MINUTE,
    {
      startedBy: null,
      audioIncomplete: true,
      transcription: { status: 'disabled' },
      minutes: { status: 'disabled' },
    },
  );

  const previewItems: RecordingIndexItem[] = [
    { meta: liveMeta, canDelete: false, audioBytes: 384 * 1024 * 1024 },
    { meta: doneMeta, canDelete: true, audioBytes: 912 * 1024 * 1024 },
    { meta: partialMeta, canDelete: true, audioBytes: 488 * 1024 * 1024 },
    { meta: errorMeta, canDelete: true, audioBytes: 306 * 1024 * 1024 },
    { meta: audioGoneMeta, canDelete: true, audioBytes: 0 },
    { meta: incompleteMeta, canDelete: true, audioBytes: 221 * 1024 * 1024 },
  ];

  const detailData = new Map<
    string,
    { meta: RecordingMeta; transcript?: TranscriptSegment[]; minutes?: MeetingMinutes }
  >([
    [doneMeta.id, { meta: doneMeta, transcript: fixtureTranscript, minutes: fixtureMinutes }],
    [liveMeta.id, { meta: liveMeta, transcript: fixtureTranscript.slice(0, 5) }],
    [partialMeta.id, { meta: partialMeta, transcript: fixtureTranscript.slice(0, 9) }],
    [errorMeta.id, { meta: errorMeta }],
    [audioGoneMeta.id, { meta: audioGoneMeta, transcript: fixtureTranscript, minutes: fixtureMinutes }],
    [incompleteMeta.id, { meta: incompleteMeta }],
  ]);

  const app = express();
  app.disable('x-powered-by');

  const pageLang = (req: import('express').Request): Locale =>
    resolveWebLocale({
      query: req.query.lang,
      cookie: req.headers.cookie,
      acceptLanguage: req.headers['accept-language'],
      fallback: 'pt',
    });

  app.use((req, res, next) => {
    const queryLocale = localeFromValue(req.query.lang);
    if (queryLocale) res.append('Set-Cookie', localeCookie(queryLocale, false));
    next();
  });

  const sendPublicPage = (res: import('express').Response, locale: Locale, html: string): void => {
    res.append('Set-Cookie', localeCookie(locale, false)).type('html').send(html);
  };

  app.get('/assets/space-grotesk.woff2', (_req, res) => {
    res.type('font/woff2').set('Cache-Control', 'public, max-age=3600').sendFile(fontPath);
  });
  app.get('/demo/audio', (_req, res) => {
    res.type('audio/mpeg').set('Cache-Control', 'public, max-age=3600').sendFile(demoAudioPath);
  });

  app.get('/og.png', (_req, res) => {
    res.type('png').set('Cache-Control', 'public, max-age=3600').sendFile(ogPath);
  });

  app.get('/og-:locale(pt|en).png', (req, res) => {
    const localizedOg = path.join(rootDir, 'docs', `og-${req.params.locale}.png`);
    if (!fs.existsSync(localizedOg)) {
      res.status(404).end();
      return;
    }
    res.type('png').set('Cache-Control', 'public, max-age=3600').sendFile(localizedOg);
  });

  app.get('/assets/kassinao-mark.png', (_req, res) => {
    res.type('png').set('Cache-Control', 'public, max-age=3600').sendFile(brandMarkPath);
  });

  app.get('/favicon-32.png', (_req, res) => {
    res.type('png').set('Cache-Control', 'public, max-age=3600').sendFile(faviconPath);
  });

  app.get('/assets/apple-touch-icon.png', (_req, res) => {
    res.type('png').set('Cache-Control', 'public, max-age=3600').sendFile(appleTouchIconPath);
  });

  const publicVisuals = new Map<string, string>([
    ['discord-demo-pt.webm', 'video/webm'],
    ['discord-demo-en.webm', 'video/webm'],
    ['discord-demo-pt.png', 'image/png'],
    ['discord-demo-en.png', 'image/png'],
    ['discord-demo-pt.gif', 'image/gif'],
    ['discord-demo-en.gif', 'image/gif'],
    ['meeting-demo-pt.png', 'image/png'],
    ['meeting-demo-en.png', 'image/png'],
  ]);
  app.get('/assets/:visual', (req, res, next) => {
    const contentType = publicVisuals.get(req.params.visual);
    if (!contentType) {
      next();
      return;
    }
    res.type(contentType).set('Cache-Control', 'public, max-age=3600').sendFile(path.join(brandDir, req.params.visual));
  });

  app.get('/', (req, res) => {
    if (localeFromValue(req.query.lang) === 'en') {
      res.redirect(302, '/en');
      return;
    }
    sendPublicPage(res, 'pt', landingPage('pt'));
  });

  app.get('/en', (_req, res) => {
    sendPublicPage(res, 'en', landingPage('en'));
  });

  app.get('/docs', (req, res) => {
    if (localeFromValue(req.query.lang) === 'en') {
      res.redirect(302, '/en/docs');
      return;
    }
    sendPublicPage(res, 'pt', docsPage('pt'));
  });

  app.get('/en/docs', (_req, res) => {
    sendPublicPage(res, 'en', docsPage('en'));
  });

  const renderDemo = (locale: Locale): string =>
    recordingPage(fixtureMeta, {
      live: false,
      canDelete: false,
      lang: locale,
      transcript: locale === 'pt' ? fixtureTranscriptPt : fixtureTranscript,
      minutes: locale === 'pt' ? fixtureMinutesPt : fixtureMinutes,
      demo: true,
    });

  app.get('/demo', (req, res) => {
    if (localeFromValue(req.query.lang) === 'en') {
      res.redirect(302, '/en/demo');
      return;
    }
    sendPublicPage(res, 'pt', renderDemo('pt'));
  });

  app.get('/en/demo', (_req, res) => {
    sendPublicPage(res, 'en', renderDemo('en'));
  });

  app.get('/preview/discord-demo', (req, res) => {
    const locale = localeFromValue(req.query.lang) ?? 'pt';
    const rawPhase = String(req.query.phase ?? 'auto');
    const phase = rawPhase === 'auto' ? 'auto' : Math.max(0, Math.min(4, Number(rawPhase) || 0));
    res.type('html').send(discordDemoPage(locale, phase));
  });

  function renderIndex(req: import('express').Request): string {
    const locale = pageLang(req);
    const q = String(req.query.q ?? '')
      .trim()
      .slice(0, 100);
    const sort = req.query.sort === 'oldest' ? 'oldest' : req.query.sort === 'largest' ? 'largest' : 'recent';
    const items = previewItems.map((item) => ({ ...item, meta: localizedPreviewMeta(item.meta, locale) }));

    if (sort === 'oldest') items.sort((a, b) => a.meta.startedAt - b.meta.startedAt);
    else if (sort === 'largest') items.sort((a, b) => (b.audioBytes ?? 0) - (a.audioBytes ?? 0));
    else items.sort((a, b) => b.meta.startedAt - a.meta.startedAt);

    const noPreviewHits = /^(semresultado|no-results|zzzz)$/i.test(q);
    const hits: WebSearchHit[] | undefined = q
      ? noPreviewHits
        ? []
        : [
            {
              metaId: doneMeta.id,
              channelName: localizedPreviewMeta(doneMeta, locale).voiceChannelName,
              startedAt: doneMeta.startedAt,
              atMs: 12 * MINUTE,
              speaker: 'Priya',
              snippet:
                locale === 'pt'
                  ? `Resultado fictício para “${q}”: responsável confirmado e prazo registrado na reunião.`
                  : `Fictional result for “${q}”: owner confirmed and deadline captured in the meeting.`,
              kind: 'transcript',
            },
          ]
      : undefined;

    return recordingsIndexPage(items, {
      user: previewUserFor(locale),
      lang: locale,
      q,
      hits,
      owner: true,
      freeDiskMB: 42 * 1024,
      sort,
      flash:
        req.query.flash === '1'
          ? locale === 'pt'
            ? 'Estado fictício atualizado com sucesso.'
            : 'Fictional state updated successfully.'
          : undefined,
    });
  }

  app.get('/preview/app', (req, res) => {
    res.type('html').send(renderIndex(req));
  });

  // O HTML real usa /app nos links, filtros e navegação. Este alias mantém o
  // preview navegável sem mudar o renderer nem fingir que é uma rota de produção.
  app.get('/app', (req, res) => {
    res.type('html').send(renderIndex(req));
  });

  app.get('/preview/empty', (req, res) => {
    const locale = pageLang(req);
    res.type('html').send(
      recordingsIndexPage([], {
        user: previewUserFor(locale),
        lang: locale,
        owner: true,
        freeDiskMB: 42 * 1024,
      }),
    );
  });

  const previewConnections = [
    {
      sid: 'preview-claude-desktop',
      label: 'Claude do notebook',
      createdAt: now - 8 * DAY,
      lastSeenAt: now - 35 * MINUTE,
      exp: now + 82 * DAY,
    },
    {
      sid: 'preview-cursor-work',
      label: 'Cursor do trabalho',
      createdAt: now - 3 * DAY,
      exp: now + 87 * DAY,
    },
  ];

  app.get(['/preview/connect', '/app/conectar-ia'], (req, res) => {
    const locale = pageLang(req);
    res.type('html').send(
      connectPage({
        lang: locale,
        user: previewUserFor(locale),
        sessions: previewConnections,
      }),
    );
  });

  app.get('/preview/connect-token', (req, res) => {
    const locale = pageLang(req);
    res.type('html').send(
      connectPage({
        lang: locale,
        user: previewUserFor(locale),
        refreshToken: 'preview-only-token-never-valid',
        label: locale === 'pt' ? 'Claude do notebook' : 'Claude on my laptop',
      }),
    );
  });

  function renderDetail(
    req: import('express').Request,
    meta: RecordingMeta,
    transcript?: TranscriptSegment[],
    minutes?: MeetingMinutes,
  ): string {
    const locale = pageLang(req);
    const localizedMeta = localizedPreviewMeta(meta, locale);
    const localizedTranscript =
      locale === 'pt' && transcript ? fixtureTranscriptPt.slice(0, transcript.length) : transcript;
    const localizedMinutes = locale === 'pt' && minutes ? fixtureMinutesPt : minutes;
    return recordingPage(localizedMeta, {
      live: localizedMeta.status === 'recording',
      canDelete: localizedMeta.status !== 'recording',
      user: previewUserFor(locale),
      lang: locale,
      transcript: localizedTranscript,
      minutes: localizedMinutes,
    });
  }

  app.get('/preview/live', (req, res) => {
    res.type('html').send(renderDetail(req, liveMeta, fixtureTranscript.slice(0, 5)));
  });

  app.get('/preview/audio-gone', (req, res) => {
    res.type('html').send(renderDetail(req, audioGoneMeta, fixtureTranscript, fixtureMinutes));
  });

  app.get('/app/rec/:id', (req, res) => {
    const detail = detailData.get(req.params.id);
    if (!detail) {
      res.status(404).type('text').send('Estado sintético não encontrado no preview.');
      return;
    }
    res.type('html').send(renderDetail(req, detail.meta, detail.transcript, detail.minutes));
  });

  app.get('/app/rec/:id/audio', (req, res) => {
    if (!detailData.has(req.params.id)) {
      res.status(404).end();
      return;
    }
    res.type('audio/mpeg').set('Cache-Control', 'no-store').sendFile(demoAudioPath);
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, preview: true, fixtures: previewItems.length });
  });

  app.use((_req, res) => {
    res.status(404).type('text').send('Rota não disponível no preview visual.');
  });

  const server = app.listen(previewPort, '127.0.0.1', () => {
    console.log(`Preview visual do Kassinão: http://localhost:${previewPort}`);
    console.log(
      'Rotas: / · /en · /docs · /en/docs · /demo · /en/demo · /preview/app · /preview/discord-demo · /preview/empty · /preview/live · /preview/audio-gone · /preview/connect · /preview/connect-token',
    );
  });

  const close = () => server.close(() => process.exit(0));
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

void main().catch((error: unknown) => {
  console.error('Falha ao iniciar o preview visual:', error);
  process.exit(1);
});
