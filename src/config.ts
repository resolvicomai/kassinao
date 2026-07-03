import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Variável de ambiente obrigatória ausente: ${name}`);
    process.exit(1);
  }
  return value;
}

const recordingsDir = path.resolve(process.env.RECORDINGS_DIR || './recordings');

/**
 * Segredo usado para assinar os cookies de sessão da página web.
 * Se não vier do ambiente, gera um e persiste em disco para que
 * as sessões sobrevivam a reinícios do bot.
 */
function loadCookieSecret(): string {
  if (process.env.COOKIE_SECRET) return process.env.COOKIE_SECRET;
  const secretFile = path.join(recordingsDir, '.cookie-secret');
  try {
    return fs.readFileSync(secretFile, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(recordingsDir, { recursive: true });
    fs.writeFileSync(secretFile, secret, { mode: 0o600 });
    return secret;
  }
}

export const config = {
  token: required('DISCORD_TOKEN'),
  applicationId: required('APPLICATION_ID'),
  /** Client Secret do OAuth2 (Developer Portal > OAuth2) — usado no login da página de downloads. */
  clientSecret: required('DISCORD_CLIENT_SECRET'),
  /** Se definido, registra os comandos só nesse servidor (atualização instantânea). */
  guildId: process.env.GUILD_ID || undefined,
  port: Number(process.env.PORT || 8080),
  /** URL pública usada nos links (ex.: https://kassinao.suaempresa.com). */
  baseUrl: (process.env.BASE_URL || `http://localhost:${process.env.PORT || 8080}`).replace(/\/$/, ''),
  recordingsDir,
  retentionDays: Number(process.env.RETENTION_DAYS || 7),
  maxRecordingHours: Number(process.env.MAX_RECORDING_HOURS || 6),
  mp3Bitrate: process.env.MP3_BITRATE || '192k',
  cookieSecret: loadCookieSecret(),
  /** Fuso para datas no transcript .md e fallback da página (o navegador tem prioridade na web). */
  timezone: process.env.TZ || 'America/Sao_Paulo',

  /**
   * Motor de transcrição: 'none' | 'openai' | 'groq' | 'gemini' | 'command'.
   * 'command' roda um executável local (faster-whisper, whisper.cpp, Parakeet...)
   * definido em TRANSCRIBE_COMMAND com os placeholders {input} e {output}.
   */
  transcribeProvider: (process.env.TRANSCRIBE_PROVIDER || 'none').toLowerCase(),
  transcribeModel: process.env.TRANSCRIBE_MODEL || '',
  transcribeLanguage: process.env.TRANSCRIBE_LANGUAGE || 'pt',
  transcribeCommand: process.env.TRANSCRIBE_COMMAND || '',
  /** Timeout do provider 'command' = max(10min, duração do chunk × este fator). */
  transcribeTimeoutFactor: Number(process.env.TRANSCRIBE_TIMEOUT_FACTOR || 5),
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  groqApiKey: process.env.GROQ_API_KEY || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
};
