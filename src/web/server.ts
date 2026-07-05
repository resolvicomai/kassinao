import fs from 'node:fs';
import path from 'node:path';
import express, { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { freeMB } from '../disk';
import { isClientReady } from '../discord/ready';
import { Locale } from '../i18n';
import { cook, CookFormat, COOK_FORMATS } from '../processing/cook';
import { isTranscribing, transcriptToMarkdown } from '../processing/transcribe';
import { minutesToMarkdown } from '../processing/minutes';
import { sessionManager } from '../recorder/manager';
import { deleteRecording, readMeta, readMinutes, readTranscript, RecordingMeta } from '../store';
import { checkAccess } from './access';
import { mountMcpApi } from './api';
import { beginLogin, finishLogin, getWebUser, signMcpRefresh, WebUser } from './auth';
import { countUserSessions, createSession, revokeUser } from './mcpTokens';
import { connectPage, landingPage, messagePage, recordingPage } from './page';
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
  forbiddenTitle: { pt: 'Sem acesso', en: 'No access' },
  forbidden: {
    pt: 'Esta gravação é restrita. Você abre se participou da call, se enxerga o canal de voz de origem, ou se administra o servidor — caso contrário, peça o acesso a quem iniciou.',
    en: 'This recording is restricted. You can open it if you joined the call, can see the source voice channel, or manage the server — otherwise ask whoever started it for access.',
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
  deleteDeniedTitle: { pt: 'Sem permissão', en: 'No permission' },
  deleteDenied: {
    pt: 'Só quem iniciou a gravação ou administra o servidor pode apagá-la.',
    en: 'Only whoever started the recording or a server manager can delete it.',
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
  startingTitle: { pt: 'Iniciando…', en: 'Starting up…' },
  starting: {
    pt: 'O Kassinão está conectando ao Discord. Recarregue em alguns segundos.',
    en: 'Kassinão is connecting to Discord. Reload in a few seconds.',
  },
} as const;

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
        "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    );
    if (config.baseUrl.startsWith('https')) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  // Health check público (sem segredos) — pra um uptime monitor (ex.: UptimeRobot).
  app.get('/health', (_req, res) => {
    res.json({ ok: true, ready: isClientReady(), freeMB: freeMB(), activeRecordings: sessionManager.all().length });
  });

  // Rate-limit leve por IP nas rotas web (a API /api/* tem o dela). Segura
  // brute-force/reconhecimento sem incomodar uso real.
  const webHits = new Map<string, { n: number; reset: number }>();
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!/^\/(rec|auth|demo)\b/.test(req.path)) return next();
    const now = Date.now();
    if (webHits.size > 5000) for (const [k, v] of webHits) if (v.reset < now) webHits.delete(k);
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

  // API do MCP (/api/*) — só monta quando MCP_SECRET está definido (opt-in).
  mountMcpApi(app);

  // Página de onboarding do conector MCP (self-serve por usuário logado).
  if (config.mcpEnabled) {
    app.get('/conectar-ia', (req, res) => {
      const l = pageLang(req);
      const user = getWebUser(req);
      const sessionCount = user ? countUserSessions(user.id) : 0;
      res.type('html').send(connectPage({ lang: l, user, sessionCount, revoked: req.query.revoked === '1' }));
    });

    app.post('/conectar-ia/gerar', (req, res) => {
      const l = pageLang(req);
      const user = getWebUser(req);
      if (!user) {
        beginLogin(res, '/conectar-ia');
        return;
      }
      // O usuário recebe um REFRESH token (o conector troca por access via /api/mcp/refresh).
      const s = createSession(user.id, user.name);
      const refreshToken = signMcpRefresh({ id: user.id, name: user.name, exp: s.exp, jti: s.sid, gen: s.gen });
      console.log(`MCP: sessão ${s.sid} criada para ${user.name} (${user.id}) via web.`);
      res.type('html').send(connectPage({ lang: l, user, refreshToken }));
    });

    app.post('/conectar-ia/revogar', (req, res) => {
      const user = getWebUser(req);
      if (!user) {
        beginLogin(res, '/conectar-ia');
        return;
      }
      const n = revokeUser(user.id);
      console.log(`MCP: ${n} sessão(ões) revogada(s) por ${user.name} (${user.id}) via web.`);
      res.redirect('/conectar-ia?revoked=1');
    });
  }

  app.get('/', (req, res) => {
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

  app.get('/auth/login', (req, res) => {
    beginLogin(res, String(req.query.next ?? '/'));
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

  app.get('/rec/:id', async (req, res) => {
    const l = pageLang(req);
    // login ANTES de checar existência: não vaza quais IDs existem a quem não logou
    const user = getWebUser(req);
    if (!user) {
      beginLogin(res, `/rec/${req.params.id}`);
      return;
    }
    if (notReady(res, l, user)) return;
    const meta = readMeta(req.params.id);
    if (!meta) {
      res
        .status(404)
        .type('html')
        .send(messagePage(MSG.notFoundTitle[l], MSG.notFound[l], user, l));
      return;
    }
    const access = await checkAccess(user, meta);
    if (!access.view) {
      res
        .status(403)
        .type('html')
        .send(messagePage(MSG.forbiddenTitle[l], MSG.forbidden[l], user, l));
      return;
    }
    const live = meta.status === 'recording' && sessionManager.get(meta.guildId)?.id === meta.id;
    const transcript = meta.transcription?.status === 'done' ? readTranscript(meta.id) : undefined;
    const minutes = meta.minutes?.status === 'done' ? readMinutes(meta.id) : undefined;
    res.type('html').send(recordingPage(meta, { live, canDelete: access.delete, user, lang: l, transcript, minutes }));
  });

  app.get('/rec/:id/audio', async (req, res) => {
    const l = pageLang(req);
    const user = getWebUser(req);
    if (!user) {
      beginLogin(res, `/rec/${req.params.id}`);
      return;
    }
    if (notReady(res, l, user)) return;
    const meta = readMeta(req.params.id);
    if (!meta || meta.participants.length === 0) {
      res.status(404).send('sem áudio');
      return;
    }
    // checkAccess ANTES de qualquer checagem de estado (ao-vivo) — não vaza a
    // quem não tem acesso se a gravação existe/está ao vivo (oráculo de enumeração).
    const access = await checkAccess(user, meta);
    if (!access.view) {
      res
        .status(403)
        .type('html')
        .send(messagePage(MSG.forbiddenTitle[l], MSG.forbidden[l], user, l));
      return;
    }
    // ao vivo: o mix seria parcial e não-cacheável (re-cozinha a cada hit) — bloqueia
    const live = meta.status === 'recording' && sessionManager.get(meta.guildId)?.id === meta.id;
    if (live) {
      res.status(409).send('gravação em andamento');
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
      console.error(`Erro servindo áudio ${meta.id}:`, err);
      res.status(500).send('erro ao preparar o áudio');
    }
  });

  app.get('/rec/:id/ata.md', async (req, res) => {
    const l = pageLang(req);
    const user = getWebUser(req);
    if (!user) {
      beginLogin(res, `/rec/${req.params.id}`);
      return;
    }
    if (notReady(res, l, user)) return;
    const meta = readMeta(req.params.id);
    const minutes = meta && meta.minutes?.status === 'done' ? readMinutes(meta.id) : undefined;
    if (!meta || !minutes) {
      res
        .status(404)
        .type('html')
        .send(messagePage(MSG.notFoundTitle[l], MSG.notFound[l], user, l));
      return;
    }
    const access = await checkAccess(user, meta);
    if (!access.view) {
      res
        .status(403)
        .type('html')
        .send(messagePage(MSG.forbiddenTitle[l], MSG.forbidden[l], user, l));
      return;
    }
    res
      .type('text/markdown; charset=utf-8')
      .attachment(`kassinao-${meta.id}-ata.md`)
      .send(minutesToMarkdown(meta, minutes));
  });

  app.get('/rec/:id/transcricao.:ext(md|txt)', async (req, res) => {
    const l = pageLang(req);
    const user = getWebUser(req);
    if (!user) {
      beginLogin(res, `/rec/${req.params.id}`);
      return;
    }
    if (notReady(res, l, user)) return;
    const meta = readMeta(req.params.id);
    if (!meta || meta.transcription?.status !== 'done') {
      res
        .status(404)
        .type('html')
        .send(messagePage(MSG.notFoundTitle[l], MSG.notFound[l], user, l));
      return;
    }
    const access = await checkAccess(user, meta);
    if (!access.view) {
      res
        .status(403)
        .type('html')
        .send(messagePage(MSG.forbiddenTitle[l], MSG.forbidden[l], user, l));
      return;
    }
    const markdown = transcriptToMarkdown(meta, readTranscript(meta.id) ?? []);
    const ext = req.params.ext;
    res
      .type(ext === 'md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8')
      .attachment(`kassinao-${meta.id}-transcricao.${ext}`)
      .send(ext === 'md' ? markdown : markdown.replace(/[*#`]/g, ''));
  });

  app.get('/rec/:id/download/:format', async (req, res) => {
    const l = pageLang(req);
    const user = getWebUser(req);
    if (!user) {
      beginLogin(res, `/rec/${req.params.id}`);
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
      res
        .status(404)
        .type('html')
        .send(messagePage(MSG.notFoundTitle[l], MSG.notFound[l], user, l));
      return;
    }
    const access = await checkAccess(user, meta);
    if (!access.view) {
      res
        .status(403)
        .type('html')
        .send(messagePage(MSG.forbiddenTitle[l], MSG.forbidden[l], user, l));
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
      console.error(`Erro processando download ${meta.id}/${format}:`, err);
      res
        .status(500)
        .type('html')
        .send(messagePage(MSG.cookErrorTitle[l], MSG.cookError[l], user, l));
    }
  });

  app.post('/rec/:id/delete', async (req, res) => {
    const l = pageLang(req);
    const user = getWebUser(req);
    if (!user) {
      beginLogin(res, `/rec/${req.params.id}`);
      return;
    }
    if (notReady(res, l, user)) return;
    const meta = readMeta(req.params.id);
    if (!meta) {
      res
        .status(404)
        .type('html')
        .send(messagePage(MSG.notFoundTitle[l], MSG.notFound[l], user, l));
      return;
    }
    const access = await checkAccess(user, meta);
    if (!access.delete) {
      res
        .status(403)
        .type('html')
        .send(messagePage(MSG.deleteDeniedTitle[l], MSG.deleteDenied[l], user, l));
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
    console.log(`Gravação ${meta.id} apagada por ${user.name} (${user.id}).`);
    res.type('html').send(messagePage(MSG.deletedTitle[l], MSG.deleted[l], user, l));
  });

  app.listen(config.port, () => {
    console.log(`Servidor web em ${config.baseUrl} (porta ${config.port})`);
  });
}
