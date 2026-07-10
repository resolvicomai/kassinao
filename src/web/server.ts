import fs from 'node:fs';
import path from 'node:path';
import express, { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { freeMB } from '../disk';
import { isClientReady } from '../discord/ready';
import { Locale } from '../i18n';
import { cook, CookBusyError, CookFormat, COOK_FORMATS } from '../processing/cook';
import { isTranscribing, transcriptToMarkdown } from '../processing/transcribe';
import { minutesToMarkdown } from '../processing/minutes';
import { sessionManager } from '../recorder/manager';
import { cleanInline } from '../sanitize';
import { isLoopbackAddress } from '../util';
import {
  audioBytesOf,
  deleteAudioOnly,
  deleteRecording,
  forgetAudioBytes,
  listMetas,
  readMeta,
  readMinutes,
  readTranscript,
  RecordingMeta,
  transcriptionNeedsAudio,
  transcriptReady,
} from '../store';
import { checkAccess } from './access';
import { mountMcpApi } from './api';
import {
  beginLogin,
  finishLogin,
  getWebUser,
  isAllowedWebMutation,
  logoutWeb,
  scopeWebSessionToApp,
  signMcpRefresh,
  WebUser,
} from './auth';
import { createSession, listUserSessions, revokeUser, revokeUserSession } from './mcpTokens';
import {
  connectPage,
  messagePage,
  recordingPage,
  RecordingIndexItem,
  recordingsIndexPage,
  RecordingsSort,
} from './page';
import { landingPage } from './landing';
import { searchRecordings } from './search';
import { beginDownload, endDownload, hasActiveDownloads } from './tracker';

/** Idioma da página pelo Accept-Language do navegador (pt-BR ou inglês). */
// Idioma da página: escolha explícita (?lang) > cookie salvo > PADRÃO INGLÊS.
// Inglês por padrão pra não misturar idiomas; o usuário troca no toggle e fica salvo.
function pageLang(req: Request): Locale {
  const q = String(req.query.lang ?? '').toLowerCase();
  if (q === 'pt' || q === 'en') return q;
  const m = (req.headers.cookie ?? '').match(/(?:^|;\s*)kassinao_lang=(pt|en)\b/);
  if (m) return m[1] as Locale;
  return 'en';
}

const MSG = {
  notFoundTitle: { pt: 'Gravação não encontrada', en: 'Recording not found' },
  notFound: {
    pt: 'Esta gravação não existe, expirou ou foi apagada.',
    en: 'This recording does not exist, has expired or was deleted.',
  },
  loginFailTitle: { pt: 'Falha no login', en: 'Login failed' },
  loginFail: {
    pt: 'Não deu para confirmar seu login no Discord. Tente abrir o link da gravação de novo.',
    en: 'Could not confirm your Discord login. Try opening the recording link again.',
  },
  errorTitle: { pt: 'Erro', en: 'Error' },
  loginError: { pt: 'Erro inesperado no login. Tente de novo.', en: 'Unexpected login error. Try again.' },
  cookErrorTitle: { pt: 'Erro no processamento', en: 'Processing error' },
  cookError: {
    pt: 'Não consegui gerar esse formato. Tente de novo em instantes.',
    en: 'Could not generate that format. Try again in a moment.',
  },
  deleteLiveTitle: { pt: 'Gravação em andamento', en: 'Recording in progress' },
  deleteLive: { pt: 'Pare a gravação antes de apagá-la.', en: 'Stop the recording before deleting it.' },
  deleteBusyTitle: { pt: 'Download em andamento', en: 'Download in progress' },
  deleteBusy: {
    pt: 'Alguém está baixando esta gravação agora. Tente apagar de novo em instantes.',
    en: 'Someone is downloading this recording right now. Try deleting again in a moment.',
  },
  deletedTitle: { pt: 'Gravação apagada', en: 'Recording deleted' },
  deleted: {
    pt: 'Pronto — os arquivos foram removidos para sempre. 🗑️',
    en: 'Done — the files were removed forever. 🗑️',
  },
  freedFlash: {
    pt: '🔇 Espaço liberado — o áudio foi apagado; transcrição, ata e notas continuam.',
    en: '🔇 Space freed — the audio was deleted; transcript, minutes and notes remain.',
  },
  deletedFlash: { pt: '🗑️ Gravação apagada para sempre.', en: '🗑️ Recording deleted forever.' },
  freeLiveTitle: { pt: 'Gravação em andamento', en: 'Recording in progress' },
  freeLive: { pt: 'Pare a gravação antes de liberar o espaço.', en: 'Stop the recording before freeing space.' },
  freeBusyTitle: { pt: 'Em uso agora', en: 'Busy right now' },
  freeBusy: {
    pt: 'Alguém está baixando ou a transcrição ainda está rodando. Tente de novo em instantes.',
    en: 'Someone is downloading or the transcription is still running. Try again in a moment.',
  },
  freeGoneTitle: { pt: 'Áudio já liberado', en: 'Audio already released' },
  freeGone: {
    pt: 'O áudio desta gravação já tinha sido liberado — nada a fazer.',
    en: 'The audio of this recording was already released — nothing to do.',
  },
  startingTitle: { pt: 'Iniciando…', en: 'Starting up…' },
  starting: {
    pt: 'O Kassinão está conectando ao Discord. Recarregue em alguns segundos.',
    en: 'Kassinão is connecting to Discord. Reload in a few seconds.',
  },
} as const;

/** Inexistente e sem acesso são deliberadamente indistinguíveis. */
function sendRecordingUnavailable(res: Response, l: Locale, user: WebUser): void {
  res
    .status(404)
    .type('html')
    .send(messagePage(MSG.notFoundTitle[l], MSG.notFound[l], user, l));
}

/**
 * Gate de prontidão: enquanto o gateway não está pronto, os caches de guild/canal
 * estão vazios e o checkAccess daria um 403 falso a quem tem direito via "enxerga o
 * canal"/ManageGuild. Responde 503 (retriável) em vez de um veredito de acesso errado.
 * Só entra DEPOIS do login (a rota já resolveu o usuário) — o fluxo OAuth usa REST,
 * não depende do gateway.
 */
function notReady(res: Response, l: Locale, user?: WebUser): boolean {
  if (isClientReady()) return false;
  res
    .status(503)
    .set('Retry-After', '5')
    .type('html')
    .send(messagePage(MSG.startingTitle[l], MSG.starting[l], user, l));
  return true;
}

export function startWebServer(): void {
  const app = express();
  app.disable('x-powered-by');
  // Atrás do Cloudflare Tunnel (1 proxy): faz req.ip refletir o IP real do cliente,
  // pra o rate-limit por IP não ser burlado forjando X-Forwarded-For.
  app.set('trust proxy', 1);

  // Headers de segurança (defesa em profundidade barata). CSP permite o próprio
  // site + avatares do Discord + estilos/scripts inline (a página usa inline).
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' https://cdn.discordapp.com data:; media-src 'self'; " +
        "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; " +
        "base-uri 'none'; form-action 'self'; object-src 'none'",
    );
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (config.baseUrl.startsWith('https')) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  // Remove o cookie legado Path=/ e mantém apenas sessões registradas com jti.
  // Tokens antigos sem revogação server-side são encerrados no primeiro acesso.
  app.use('/app', (req, res, next) => {
    if ((req.headers.cookie ?? '').includes('kassinao_session=')) scopeWebSessionToApp(req, res);
    next();
  });

  // Health check público: só disponibilidade. Contagem de calls ativas e disco
  // são metadados operacionais privados (e não são necessários ao healthcheck).
  app.get('/health', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ ok: true, ready: isClientReady() });
  });

  // Diagnóstico usado antes de deploy/restart, acessível só DENTRO do container
  // (`docker exec ... fetch(localhost/health/details)`). Mantém o stop seguro sem
  // anunciar ao mundo se há uma call ativa nem quanto disco resta.
  app.get('/health/details', (req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.status(404).end();
      return;
    }
    res
      .set('Cache-Control', 'no-store')
      .json({ ok: true, ready: isClientReady(), freeMB: freeMB(), activeRecordings: sessionManager.all().length });
  });

  // Rate-limit leve por IP nas rotas web (a API /api/* tem o dela). Segura
  // brute-force/reconhecimento sem incomodar uso real.
  const webHits = new Map<string, { n: number; reset: number }>();
  app.use((req: Request, res: Response, next: NextFunction) => {
    // /i: o roteamento do Express é case-insensitive por padrão — sem a flag,
    // /APP/rec/... chegaria ao handler sem passar pelo contador
    if (!/^\/(app|rec|auth|demo|conectar-ia|gravacoes)\b/i.test(req.path)) return next();
    const now = Date.now();
    if (webHits.size > 5000) {
      for (const [k, v] of webHits) if (v.reset < now) webHits.delete(k);
      // Mesmo sob ataque distribuído, o mapa não cresce sem limite.
      while (webHits.size > 5000) webHits.delete(webHits.keys().next().value as string);
    }
    const ip = req.ip ?? 'unknown';
    const h = webHits.get(ip);
    if (!h || h.reset < now) {
      webHits.set(ip, { n: 1, reset: now + 60_000 });
    } else if (++h.n > 120) {
      res.status(429).set('Retry-After', '30').send('Muitas requisições — tente de novo em instantes.');
      return;
    }
    next();
  });

  // Persiste a escolha de idioma (?lang=en|pt) num cookie de 1 ano.
  app.use((req, res, next) => {
    const q = String(req.query.lang ?? '').toLowerCase();
    if (q === 'pt' || q === 'en') {
      const secure = config.baseUrl.startsWith('https') ? '; Secure' : '';
      res.append('Set-Cookie', `kassinao_lang=${q}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`);
    }
    next();
  });

  // A superfície privada nunca deve ficar no cache do navegador/proxy. Isso
  // inclui HTML, áudio, downloads e OAuth: sair e apertar "voltar" não pode
  // ressuscitar transcrição/ata de uma página cacheada.
  const privateNoStore = (_req: Request, res: Response, next: NextFunction): void => {
    res.set('Cache-Control', 'private, no-store, max-age=0').set('Pragma', 'no-cache');
    next();
  };
  app.use('/app', privateNoStore);
  app.use('/auth', privateNoStore);

  // SameSite=Lax não basta contra um subdomínio irmão comprometido (same-site).
  // Toda mutação web autenticada exige o Origin exato do Kassinão quando o
  // navegador o envia; requests cross-site são recusados antes do handler.
  app.use('/app', (req: Request, res: Response, next: NextFunction) => {
    if (!isAllowedWebMutation(req)) {
      res.status(403).type('text/plain').send('Origem inválida / invalid origin.');
      return;
    }
    next();
  });

  // API do MCP (/api/*) — só monta quando MCP_SECRET está definido (opt-in).
  mountMcpApi(app);

  // ---------- separação site × app ----------
  // Tudo que é PRIVADO (gravações, conector, gestão) vive sob /app/* — um
  // namespace só, nunca linkado do markup público. Os caminhos ANTIGOS
  // (/gravacoes, /rec/:id, /conectar-ia) já foram enviados em mensagens do
  // Discord e salvos em favoritos: redirect PERMANENTE (308 preserva o método),
  // a proteção continua sendo login+checkAccess no destino.
  const legacyRedirect = (from: string, to: string) => {
    app.use(from, (req: Request, res: Response) => {
      res.redirect(308, to + (req.url === '/' ? '' : req.url));
    });
  };
  legacyRedirect('/gravacoes', '/app');
  legacyRedirect('/rec', '/app/rec');
  legacyRedirect('/conectar-ia', '/app/conectar-ia');

  // Página de onboarding do conector MCP (self-serve por usuário logado).
  if (config.mcpEnabled) {
    app.get('/app/conectar-ia', (req, res) => {
      const l = pageLang(req);
      const user = getWebUser(req);
      const q = String(req.query.revoked ?? '');
      res.type('html').send(
        connectPage({
          lang: l,
          user,
          sessions: user ? listUserSessions(user.id) : undefined,
          revoked: q === '1' ? 'all' : q === 'one' ? 'one' : undefined,
        }),
      );
    });

    app.post('/app/conectar-ia/gerar', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
      const l = pageLang(req);
      const user = getWebUser(req);
      if (!user) {
        beginLogin(res, '/app/conectar-ia');
        return;
      }
      // apelido opcional ("Claude do notebook") — só exibição na lista de gestão
      const label = String((req.body as Record<string, unknown>)?.label ?? '')
        .trim()
        .slice(0, 40);
      // O usuário recebe um REFRESH token (o conector troca por access via /api/mcp/refresh).
      const s = createSession(user.id, user.name, label);
      const refreshToken = signMcpRefresh({ id: user.id, name: user.name, exp: s.exp, jti: s.sid, gen: s.gen });
      console.log(
        `MCP: sessão ${s.sid} criada para ${cleanInline(user.name)} (${user.id}) via web${label ? ` — "${cleanInline(label)}"` : ''}.`,
      );
      res
        .set('Cache-Control', 'no-store')
        .type('html')
        .send(connectPage({ lang: l, user, refreshToken, label }));
    });

    // revoga UMA conexão — só do próprio usuário (revokeUserSession valida o dono)
    app.post('/app/conectar-ia/revogar/:sid', (req, res) => {
      const user = getWebUser(req);
      if (!user) {
        beginLogin(res, '/app/conectar-ia');
        return;
      }
      const ok = revokeUserSession(user.id, req.params.sid);
      // cleanInline também no sid: vem da URL (controlado pelo cliente) — mesmo
      // sendo logado só quando pertence ao usuário, não entra cru no log
      if (ok)
        console.log(
          `MCP: sessão ${cleanInline(req.params.sid)} revogada por ${cleanInline(user.name)} (${user.id}) via web.`,
        );
      res.redirect(ok ? '/app/conectar-ia?revoked=one' : '/app/conectar-ia');
    });

    app.post('/app/conectar-ia/revogar', (req, res) => {
      const user = getWebUser(req);
      if (!user) {
        beginLogin(res, '/app/conectar-ia');
        return;
      }
      const n = revokeUser(user.id);
      console.log(`MCP: ${n} sessão(ões) revogada(s) por ${cleanInline(user.name)} (${user.id}) via web.`);
      res.redirect('/app/conectar-ia?revoked=1');
    });

    // A página do token é resposta direta de POST; o toggle EN/PT do topo faz
    // GET ?lang=… na MESMA URL. Sem este fallback seria um 404 cru do Express —
    // e a página de exibição única sumiria. O cookie de idioma já foi salvo
    // pelo middleware; volta pra página canônica (novo token = gerar de novo).
    app.get(['/app/conectar-ia/gerar', '/app/conectar-ia/revogar', '/app/conectar-ia/revogar/:sid'], (_req, res) => {
      res.redirect('/app/conectar-ia');
    });
  }

  app.get('/', (req, res) => {
    // landing = vitrine pública, cega pra sessão de propósito: a única ponte
    // público→app é o "entrar" do rodapé. O app (/app/*) é mundo à parte.
    res.type('html').send(landingPage(pageLang(req)));
  });

  // Demo PÚBLICA (sem login) — serve SOMENTE os dados fictícios de docs/example.
  // Totalmente separada das rotas /rec/:id (gravações reais), que continuam protegidas.
  const DEMO_DIR = path.join(process.cwd(), 'docs', 'example');
  const readDemo = () => {
    try {
      return {
        meta: JSON.parse(fs.readFileSync(path.join(DEMO_DIR, 'meta.json'), 'utf8')) as RecordingMeta,
        transcript: JSON.parse(fs.readFileSync(path.join(DEMO_DIR, 'transcript.json'), 'utf8')),
        minutes: JSON.parse(fs.readFileSync(path.join(DEMO_DIR, 'minutes.json'), 'utf8')),
      };
    } catch {
      return null;
    }
  };

  app.get('/demo', (req, res) => {
    const l = pageLang(req);
    const d = readDemo();
    if (!d) {
      res
        .status(404)
        .type('html')
        .send(messagePage(MSG.notFoundTitle[l], MSG.notFound[l], undefined, l));
      return;
    }
    res.type('html').send(
      recordingPage(d.meta, {
        live: false,
        canDelete: false,
        lang: l,
        transcript: d.transcript,
        minutes: d.minutes,
        demo: true,
      }),
    );
  });

  app.get('/demo/audio', (_req, res) => {
    const f = path.join(DEMO_DIR, 'sample-audio.mp3');
    if (!fs.existsSync(f)) {
      res.status(404).send('sem áudio de amostra');
      return;
    }
    res.sendFile(f);
  });

  // Cartão de social share (Open Graph / Twitter) da landing — asset estático.
  app.get('/og.png', (_req, res) => {
    const f = path.join(process.cwd(), 'docs', 'og.png');
    if (!fs.existsSync(f)) {
      res.status(404).send('sem og');
      return;
    }
    res.type('png').set('Cache-Control', 'public, max-age=86400').sendFile(f);
  });

  app.get('/auth/login', (req, res) => {
    beginLogin(res, String(req.query.next ?? '/'));
  });

  // Compatibilidade com favoritos antigos: GET nunca muda estado nem encerra a
  // sessão (evita logout CSRF). O controle novo usa POST dentro de /app.
  app.get('/auth/logout', (_req, res) => {
    res.redirect(303, '/app');
  });

  app.get('/auth/callback', async (req, res) => {
    const l = pageLang(req);
    try {
      const next = await finishLogin(req, res);
      if (!next) {
        res
          .status(400)
          .type('html')
          .send(messagePage(MSG.loginFailTitle[l], MSG.loginFail[l], undefined, l));
        return;
      }
      res.redirect(next);
    } catch (err) {
      console.error('Erro no callback OAuth:', err);
      res
        .status(500)
        .type('html')
        .send(messagePage(MSG.errorTitle[l], MSG.loginError[l], undefined, l));
    }
  });

  // A rota vive em /app para o cookie Path=/app viajar na requisição e para
  // herdar a proteção de Origin/Sec-Fetch aplicada a todas as mutações privadas.
  app.post('/app/logout', (req, res) => {
    logoutWeb(req, res);
    res.redirect(303, '/');
  });

  /** Home do app ("minhas gravações"): tudo que ESTA pessoa pode abrir, em todos
   *  os guilds — painel de GESTÃO: totais de disco (só OWNER_IDS), ordenação e ações. */
  app.get('/app', async (req, res) => {
    const l = pageLang(req);
    const q = String(req.query.q ?? '')
      .trim()
      .slice(0, 100);
    const user = getWebUser(req);
    if (!user) {
      // next reconstruído de partes VALIDADAS (nunca originalUrl cru) — preserva a busca
      beginLogin(res, q ? `/app?q=${encodeURIComponent(q)}` : '/app');
      return;
    }
    if (notReady(res, l, user)) return;
    // mesma regra da página individual (checkAccess) aplicada meta a meta —
    // o cache de membership (45s) segura o custo pra listas de um time pequeno
    const all = listMetas()
      .filter((m) => !m.demo)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 300);
    // tamanho em disco é infra, não conteúdo: só o dono da VPS (OWNER_IDS) vê —
    // "quanto custa cada gravação" não é da conta de quem só participou da call
    const owner = config.ownerIds.includes(user.id);
    const items: RecordingIndexItem[] = [];
    for (const m of all) {
      try {
        const access = await checkAccess(user, m);
        if (access.view)
          items.push({ meta: m, canDelete: access.delete, audioBytes: owner ? audioBytesOf(m.id) : undefined });
      } catch {
        // transitório: melhor omitir do índice do que travar a página
      }
    }
    // ordenação server-side; "maiores" precisa dos bytes, então é só pro dono
    const sortQ = String(req.query.sort ?? 'recent');
    const sort: RecordingsSort = sortQ === 'oldest' ? 'oldest' : sortQ === 'largest' && owner ? 'largest' : 'recent';
    if (sort === 'oldest') items.sort((a, b) => a.meta.startedAt - b.meta.startedAt);
    else if (sort === 'largest') items.sort((a, b) => (b.audioBytes ?? 0) - (a.audioBytes ?? 0));
    // busca lê transcript.json (síncrono) — limita às 100 mais recentes pra não
    // segurar o event loop (que também recebe o áudio das gravações ao vivo)
    const hits = q ? searchRecordings(items.map((i) => i.meta).slice(0, 100), q) : undefined;
    const flash = req.query.freed === '1' ? MSG.freedFlash[l] : req.query.deleted === '1' ? MSG.deletedFlash[l] : '';
    res.type('html').send(
      recordingsIndexPage(items, {
        user,
        lang: l,
        q,
        hits,
        owner,
        freeDiskMB: owner ? freeMB() : undefined,
        sort,
        flash,
      }),
    );
  });

  app.get('/app/rec/:id', async (req, res) => {
    const l = pageLang(req);
    // login ANTES de checar existência: não vaza quais IDs existem a quem não logou
    const user = getWebUser(req);
    if (!user) {
      beginLogin(res, `/app/rec/${req.params.id}`);
      return;
    }
    if (notReady(res, l, user)) return;
    const meta = readMeta(req.params.id);
    if (!meta) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    const access = await checkAccess(user, meta);
    if (!access.view) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    const live = meta.status === 'recording' && sessionManager.get(meta.guildId)?.id === meta.id;
    // transcript é lido sempre que existir (mesmo em rodada de retry/parcial):
    // conteúdo já entregue nunca some da página
    const transcript = readTranscript(meta.id);
    const minutes = meta.minutes?.status === 'done' ? readMinutes(meta.id) : undefined;
    res.type('html').send(recordingPage(meta, { live, canDelete: access.delete, user, lang: l, transcript, minutes }));
  });

  app.get('/app/rec/:id/audio', async (req, res) => {
    const l = pageLang(req);
    const user = getWebUser(req);
    if (!user) {
      beginLogin(res, `/app/rec/${req.params.id}`);
      return;
    }
    if (notReady(res, l, user)) return;
    const meta = readMeta(req.params.id);
    if (!meta) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    // checkAccess ANTES de qualquer checagem de estado (ao-vivo) — não vaza a
    // quem não tem acesso se a gravação existe/está ao vivo (oráculo de enumeração).
    const access = await checkAccess(user, meta);
    if (!access.view) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    if (meta.participants.length === 0) {
      res.status(404).send('sem áudio');
      return;
    }
    // ao vivo: o mix seria parcial e não-cacheável (re-cozinha a cada hit) — bloqueia
    const live = meta.status === 'recording' && sessionManager.get(meta.guildId)?.id === meta.id;
    if (live) {
      res.status(409).send('gravação em andamento');
      return;
    }
    // retenção em camadas: o áudio pode já ter expirado (texto continua na página)
    if (meta.audioDeleted) {
      res.status(410).send('o áudio desta gravação expirou');
      return;
    }
    // marca ANTES do cook (que pode levar minutos): delete/cleanup não apagam no meio
    beginDownload(meta.id);
    try {
      const result = await cook(meta, 'mix'); // mp3 único, cacheado após o 1º
      // sendFile já trata Range (seek do player) e Content-Type por extensão
      res.sendFile(result.filePath, (err?: Error) => {
        endDownload(meta.id);
        if (err && !res.headersSent) res.status(500).end();
      });
    } catch (err) {
      endDownload(meta.id);
      if (err instanceof CookBusyError) {
        res.status(503).set('Retry-After', '20').send('processando muitas gravações agora — tente em instantes');
        return;
      }
      console.error(`Erro servindo áudio ${meta.id}:`, err);
      res.status(500).send('erro ao preparar o áudio');
    }
  });

  app.get('/app/rec/:id/ata.md', async (req, res) => {
    const l = pageLang(req);
    const user = getWebUser(req);
    if (!user) {
      beginLogin(res, `/app/rec/${req.params.id}`);
      return;
    }
    if (notReady(res, l, user)) return;
    const meta = readMeta(req.params.id);
    if (!meta) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    // checkAccess ANTES de olhar o estado da ata — senão vaza a terceiros se a ata já ficou pronta
    const access = await checkAccess(user, meta);
    if (!access.view) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    const minutes = meta.minutes?.status === 'done' ? readMinutes(meta.id) : undefined;
    if (!minutes) {
      res
        .status(404)
        .type('html')
        .send(messagePage(MSG.notFoundTitle[l], MSG.notFound[l], user, l));
      return;
    }
    res
      .type('text/markdown; charset=utf-8')
      .attachment(`kassinao-${meta.id}-ata.md`)
      .send(minutesToMarkdown(meta, minutes));
  });

  app.get('/app/rec/:id/transcricao.:ext(md|txt)', async (req, res) => {
    const l = pageLang(req);
    const user = getWebUser(req);
    if (!user) {
      beginLogin(res, `/app/rec/${req.params.id}`);
      return;
    }
    if (notReady(res, l, user)) return;
    const meta = readMeta(req.params.id);
    if (!meta) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    // checkAccess ANTES do estado da transcrição — não vaza a terceiros se já ficou pronta
    const access = await checkAccess(user, meta);
    if (!access.view) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    if (!transcriptReady(meta)) {
      res
        .status(404)
        .type('html')
        .send(messagePage(MSG.notFoundTitle[l], MSG.notFound[l], user, l));
      return;
    }
    const markdown = transcriptToMarkdown(meta, readTranscript(meta.id) ?? []);
    const ext = req.params.ext;
    res
      .type(ext === 'md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8')
      .attachment(`kassinao-${meta.id}-transcricao.${ext}`)
      .send(ext === 'md' ? markdown : markdown.replace(/[*#`]/g, ''));
  });

  app.get('/app/rec/:id/download/:format', async (req, res) => {
    const l = pageLang(req);
    const user = getWebUser(req);
    if (!user) {
      beginLogin(res, `/app/rec/${req.params.id}`);
      return;
    }
    if (notReady(res, l, user)) return;
    const format = req.params.format as CookFormat;
    if (!COOK_FORMATS.includes(format)) {
      res.status(400).send('Formato inválido / invalid format.');
      return;
    }
    const meta = readMeta(req.params.id);
    if (!meta) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    const access = await checkAccess(user, meta);
    if (!access.view) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    // ao vivo: cada formato cozinharia um snapshot completo dos masters (sem dedupe
    // entre formatos), enchendo o disco. Bloqueia igual à rota /audio até encerrar.
    const live = meta.status === 'recording' && sessionManager.get(meta.guildId)?.id === meta.id;
    if (live) {
      res.status(409).send('gravação em andamento — baixe depois de encerrar');
      return;
    }
    if (meta.audioDeleted) {
      res.status(410).send('o áudio desta gravação expirou (a transcrição e a ata continuam na página)');
      return;
    }
    // marca ANTES do cook: o processamento (minutos, em gravações longas) já
    // conta como download em andamento, então delete/cleanup não apagam no meio
    beginDownload(meta.id);
    try {
      const result = await cook(meta, format);
      res.download(result.filePath, result.fileName, () => endDownload(meta.id));
    } catch (err) {
      endDownload(meta.id);
      if (err instanceof CookBusyError) {
        res
          .status(503)
          .set('Retry-After', '20')
          .type('html')
          .send(messagePage(MSG.cookErrorTitle[l], MSG.cookError[l], user, l));
        return;
      }
      console.error(`Erro processando download ${meta.id}/${format}:`, err);
      res
        .status(500)
        .type('html')
        .send(messagePage(MSG.cookErrorTitle[l], MSG.cookError[l], user, l));
    }
  });

  /**
   * "Liberar espaço": apaga SÓ o áudio (tracks + cache), mantém transcrição/ata/notas.
   * O par da retenção ilimitada — a memória fica, os gigas voltam. Mesmas guardas do
   * delete (permissão, ao-vivo, download/transcrição em andamento).
   */
  // Mesmo caso do /gerar: as respostas de POST (delete/liberar e seus 403/409)
  // exibem o toggle EN/PT, que faz GET ?lang=… na URL do POST. Fallback: volta
  // pra página da gravação (ou pro índice, se ela já não existir).
  app.get(['/app/rec/:id/delete', '/app/rec/:id/liberar-audio'], (req, res) => {
    res.redirect(`/app/rec/${encodeURIComponent(req.params.id)}`);
  });

  app.post('/app/rec/:id/liberar-audio', async (req, res) => {
    const l = pageLang(req);
    const user = getWebUser(req);
    if (!user) {
      beginLogin(res, `/app/rec/${req.params.id}`);
      return;
    }
    if (notReady(res, l, user)) return;
    const meta = readMeta(req.params.id);
    if (!meta) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    const access = await checkAccess(user, meta, { freshMember: true });
    if (!access.delete) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    if (meta.status === 'recording') {
      res
        .status(409)
        .type('html')
        .send(messagePage(MSG.freeLiveTitle[l], MSG.freeLive[l], user, l));
      return;
    }
    if (hasActiveDownloads(meta.id) || isTranscribing(meta.id) || transcriptionNeedsAudio(meta)) {
      res
        .status(409)
        .type('html')
        .send(messagePage(MSG.freeBusyTitle[l], MSG.freeBusy[l], user, l));
      return;
    }
    if (meta.audioDeleted) {
      // idempotente: dois cliques/abas não viram erro assustador
      res.type('html').send(messagePage(MSG.freeGoneTitle[l], MSG.freeGone[l], user, l));
      return;
    }
    deleteAudioOnly(meta);
    // cleanInline: nome vem do Discord (controlado pelo usuário) — sem quebra de
    // linha/ANSI forjando entradas de log (log injection)
    console.log(`Áudio da gravação ${meta.id} liberado por ${cleanInline(user.name)} (${user.id}).`);
    res.redirect(req.query.back === 'index' ? '/app?freed=1' : `/app/rec/${meta.id}`);
  });

  app.post('/app/rec/:id/delete', async (req, res) => {
    const l = pageLang(req);
    const user = getWebUser(req);
    if (!user) {
      beginLogin(res, `/app/rec/${req.params.id}`);
      return;
    }
    if (notReady(res, l, user)) return;
    const meta = readMeta(req.params.id);
    if (!meta) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    const access = await checkAccess(user, meta, { freshMember: true });
    if (!access.delete) {
      sendRecordingUnavailable(res, l, user);
      return;
    }
    if (meta.status === 'recording') {
      res
        .status(409)
        .type('html')
        .send(messagePage(MSG.deleteLiveTitle[l], MSG.deleteLive[l], user, l));
      return;
    }
    if (hasActiveDownloads(meta.id) || isTranscribing(meta.id)) {
      res
        .status(409)
        .type('html')
        .send(messagePage(MSG.deleteBusyTitle[l], MSG.deleteBusy[l], user, l));
      return;
    }
    deleteRecording(meta.id);
    forgetAudioBytes(meta.id);
    console.log(`Gravação ${meta.id} apagada por ${cleanInline(user.name)} (${user.id}).`);
    // veio do índice de gestão → volta pra lá (com flash); da página → mensagem clássica
    if (req.query.back === 'index') {
      res.redirect('/app?deleted=1');
      return;
    }
    res.type('html').send(messagePage(MSG.deletedTitle[l], MSG.deleted[l], user, l));
  });

  app.listen(config.port, () => {
    console.log(`Servidor web em ${config.baseUrl} (porta ${config.port})`);
  });
}
