import fs from 'node:fs';
import path from 'node:path';
import { PermissionFlagsBits } from 'discord.js';
import express, { Request } from 'express';
import { config } from '../config';
import { client } from '../discord/client';
import { Locale } from '../i18n';
import { cook, CookFormat, COOK_FORMATS } from '../processing/cook';
import { isTranscribing, transcriptToMarkdown } from '../processing/transcribe';
import { minutesToMarkdown } from '../processing/minutes';
import { sessionManager } from '../recorder/manager';
import { deleteRecording, readMeta, readMinutes, readTranscript, RecordingMeta } from '../store';
import { beginLogin, finishLogin, getWebUser, WebUser } from './auth';
import { landingPage, messagePage, recordingPage } from './page';
import { beginDownload, endDownload, hasActiveDownloads } from './tracker';

interface Access {
  view: boolean;
  delete: boolean;
}

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
    pt: 'Esta gravação é restrita: só quem participou da call ou tem acesso ao canal de voz pode abri-la.',
    en: 'This recording is restricted: only call participants or people with access to the voice channel can open it.',
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
} as const;

/**
 * Regra de acesso de uma gravação:
 *  - participou da call OU iniciou a gravação → pode ver
 *  - consegue VER o canal de voz de origem no Discord → pode ver
 *  - tem "Gerenciar Servidor" → pode ver e apagar
 *  - quem iniciou também pode apagar
 * Qualquer outra pessoa (mesmo com o link) não acessa.
 */
async function checkAccess(user: WebUser, meta: RecordingMeta): Promise<Access> {
  // Sem id válido não há acesso a nada — impede que null/undefined "case" com
  // startedBy null (auto-record) ou dispare guild.members.fetch(undefined).
  if (!user.id) return { view: false, delete: false };

  const isInitiator = !!meta.startedBy && meta.startedBy.id === user.id;
  const isParticipant = meta.participants.some((p) => p.id === user.id);
  let canView = isInitiator || isParticipant;
  let canDelete = isInitiator;

  try {
    const guild = client.guilds.cache.get(meta.guildId);
    if (guild) {
      const member = await guild.members.fetch(user.id);
      if (member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        canView = true;
        canDelete = true;
      }
      const channel = guild.channels.cache.get(meta.voiceChannelId);
      if (channel && channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) {
        canView = true;
      }
    }
  } catch {
    // usuário não é (mais) membro do servidor — vale só participante/iniciador
  }

  return { view: canView, delete: canDelete };
}

export function startWebServer(): void {
  const app = express();
  app.disable('x-powered-by');

  // Persiste a escolha de idioma (?lang=en|pt) num cookie de 1 ano.
  app.use((req, res, next) => {
    const q = String(req.query.lang ?? '').toLowerCase();
    if (q === 'pt' || q === 'en') {
      const secure = config.baseUrl.startsWith('https') ? '; Secure' : '';
      res.append('Set-Cookie', `kassinao_lang=${q}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`);
    }
    next();
  });

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
