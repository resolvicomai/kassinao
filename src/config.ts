import './privateUmask';
import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createGuildPolicy } from './guildPolicy';
import { operationalError, operationalFailure } from './operationalLog';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Variável de ambiente obrigatória ausente: ${name}`);
    process.exit(1);
  }
  return value;
}

interface NumberRule {
  min?: number;
  max?: number;
  integer?: boolean;
}

/** Parser puro e estrito: "abc"/NaN/Infinity não podem desligar guardas em silêncio. */
export function parseConfiguredNumber(
  name: string,
  raw: string | undefined,
  fallback: number,
  rule: NumberRule,
): number {
  const value = raw === undefined || raw.trim() === '' ? fallback : Number(raw);
  if (!Number.isFinite(value))
    throw new Error(`${name} precisa ser um número finito (recebido: ${JSON.stringify(raw)})`);
  if (rule.integer && !Number.isInteger(value)) throw new Error(`${name} precisa ser inteiro (recebido: ${value})`);
  if (rule.min !== undefined && value < rule.min)
    throw new Error(`${name} precisa ser >= ${rule.min} (recebido: ${value})`);
  if (rule.max !== undefined && value > rule.max)
    throw new Error(`${name} precisa ser <= ${rule.max} (recebido: ${value})`);
  return value;
}

function numberEnv(name: string, fallback: number, rule: NumberRule): number {
  try {
    return parseConfiguredNumber(name, process.env[name], fallback, rule);
  } catch (err) {
    console.error(`Configuração inválida: ${(err as Error).message}`);
    process.exit(1);
  }
}

function choiceEnv<const T extends readonly string[]>(name: string, fallback: T[number], choices: T): T[number] {
  const value = (process.env[name] || fallback).trim().toLowerCase();
  if (!choices.includes(value)) {
    console.error(`Configuração inválida: ${name} aceita somente ${choices.join(' | ')} (recebido: ${value})`);
    process.exit(1);
  }
  return value as T[number];
}

function booleanEnv(name: string, fallback = false): boolean {
  return choiceEnv(name, fallback ? 'true' : 'false', ['true', 'false'] as const) === 'true';
}

/** URLs públicas são origens, não prefixos: todas as rotas partem de /. */
export function normalizeOrigin(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} precisa ser uma URL absoluta http(s) (recebido: ${JSON.stringify(raw)})`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error(`${name} aceita apenas http:// ou https://`);
  if (url.username || url.password || url.search || url.hash)
    throw new Error(`${name} não pode conter credenciais, query ou hash`);
  if (url.pathname !== '/' && url.pathname !== '')
    throw new Error(`${name} não pode conter caminho; use apenas a origem`);
  return url.origin;
}

/** Mantida como API pública para instalações e testes anteriores. */
export function normalizeBaseUrl(raw: string): string {
  return normalizeOrigin('BASE_URL', raw);
}

export interface ConfiguredOrigins {
  appUrl: string;
  publicUrl: string;
  docsUrl: string;
  mcpUrl: string;
}

export interface OperatorPrivacyConfig {
  operatorName: string;
  operatorContactUrl: string;
  privacyPolicyUrl: string;
  dataDeletionUrl: string;
  termsOfServiceUrl: string;
  privacyEffectiveDate: string;
  privacyPolicyVersion: string;
  privacyAudience: string;
  privacyPurposes: string;
  privacyLawfulBasis: string;
  infrastructureProvider: string;
  infrastructureRegion: string;
  edgeProvider: string;
  edgeRegion: string;
  operationalLogRetention: string;
  backupEnabled: boolean;
  backupProvider: string;
  backupRegion: string;
  backupRetentionDays: number;
  dataRequestProcess: string;
  dataRequestResponseDays: number;
  incidentContactUrl: string;
  incidentProcess: string;
}

type OriginEnvironment = Partial<
  Record<'APP_URL' | 'BASE_URL' | 'PUBLIC_URL' | 'DOCS_URL' | 'MCP_URL', string | undefined>
>;

/** Resolve a topologia sem estado global para que precedência e fallbacks sejam testáveis. */
export function resolveConfiguredOrigins(source: OriginEnvironment, localUrl: string): ConfiguredOrigins {
  const configured = (name: keyof typeof source, fallback: string): string =>
    normalizeOrigin(name, source[name]?.trim() || fallback);
  const rawApp = source.APP_URL?.trim();
  const rawBase = source.BASE_URL?.trim();
  if (rawApp && rawBase) {
    const app = normalizeOrigin('APP_URL', rawApp);
    const base = normalizeOrigin('BASE_URL', rawBase);
    if (app !== base) throw new Error('APP_URL e BASE_URL apontam para origens diferentes');
  }
  const appUrl = rawApp ? configured('APP_URL', localUrl) : configured('BASE_URL', localUrl);
  const publicUrl = configured('PUBLIC_URL', appUrl);
  const docsUrl = configured('DOCS_URL', publicUrl);
  const mcpUrl = configured('MCP_URL', appUrl);
  return { appUrl, publicUrl, docsUrl, mcpUrl };
}

type OperatorPrivacyEnvironment = Partial<
  Record<
    | 'OPERATOR_NAME'
    | 'OPERATOR_CONTACT_URL'
    | 'PRIVACY_POLICY_URL'
    | 'DATA_DELETION_URL'
    | 'TERMS_OF_SERVICE_URL'
    | 'PRIVACY_EFFECTIVE_DATE'
    | 'PRIVACY_POLICY_VERSION'
    | 'PRIVACY_AUDIENCE'
    | 'PRIVACY_PURPOSES'
    | 'PRIVACY_LAWFUL_BASIS'
    | 'INFRASTRUCTURE_PROVIDER'
    | 'INFRASTRUCTURE_REGION'
    | 'EDGE_PROVIDER'
    | 'EDGE_REGION'
    | 'OPERATIONAL_LOG_RETENTION'
    | 'BACKUP_STATUS'
    | 'BACKUP_PROVIDER'
    | 'BACKUP_REGION'
    | 'BACKUP_RETENTION_DAYS'
    | 'DATA_REQUEST_PROCESS'
    | 'DATA_REQUEST_RESPONSE_DAYS'
    | 'INCIDENT_CONTACT_URL'
    | 'INCIDENT_PROCESS',
    string | undefined
  >
>;

/**
 * Text rendered on /privacy is public metadata. Keep it useful without turning
 * the policy into a place to publish infrastructure coordinates or account IDs.
 */
export function normalizePublicStatement(name: string, raw: string, maxLength = 1_000): string {
  const value = raw.trim();
  if (!value) throw new Error(`${name} não pode ficar vazio`);
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (value.length > maxLength || hasControlCharacter) {
    throw new Error(`${name} precisa ter até ${maxLength} caracteres e não pode conter controles`);
  }
  if (
    /https?:\/\/|mailto:|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[0-9a-f]{1,4}:){2,}[0-9a-f:]{1,}\b|\b\d{15,22}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b|\b(?:localhost|(?:[a-z0-9-]+\.)+[a-z]{2,63})\b|@/i.test(
      value,
    )
  ) {
    throw new Error(
      `${name} não pode expor URL, e-mail, IP, hostname interno ou ID; use somente uma descrição pública`,
    );
  }
  return value;
}

function privacyInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = raw?.trim() ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} precisa ser inteiro entre ${minimum} e ${maximum}`);
  }
  return value;
}

function looksLikePublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.test') ||
    host.endsWith('.invalid')
  )
    return false;
  // A política da instância deve continuar alcançável por nome público. Além de
  // evitar RFC1918/loopback, recusar IP literal elimina ambiguidades de IPv6 e
  // certificados improváveis em URLs cadastradas no Discord Developer Portal.
  if (/^[0-9.]+$/.test(host) || /^[0-9a-f:]+$/i.test(host)) return false;
  return host.includes('.') && !host.startsWith('.') && !host.endsWith('.');
}

interface PublicMetadataUrlOptions {
  allowLocalLoopback?: boolean;
  allowHash?: boolean;
  production: boolean;
  requirePath?: boolean;
}

/** Valida URLs públicas de transparência sem aceitar destinos com credenciais. */
export function normalizePublicMetadataUrl(name: string, raw: string, options: PublicMetadataUrlOptions): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} precisa ser uma URL absoluta http(s)`);
  }
  const loopback = isLoopbackOrigin(url.origin);
  const localLoopbackAllowed = loopback && (!options.production || options.allowLocalLoopback === true);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localLoopbackAllowed)) {
    throw new Error(`${name} precisa usar HTTPS público (HTTP só é aceito em localhost no modo local explícito)`);
  }
  if (url.username || url.password || url.search || (!options.allowHash && url.hash)) {
    throw new Error(`${name} não pode conter credenciais, query${options.allowHash ? '' : ' ou hash'}`);
  }
  if (options.production && !localLoopbackAllowed && !looksLikePublicHostname(url.hostname)) {
    throw new Error(`${name} precisa usar um hostname DNS público, não loopback, rede interna ou IP literal`);
  }
  if (options.requirePath && (url.pathname === '/' || url.pathname === '')) {
    throw new Error(`${name} precisa apontar para uma página específica, não apenas para a origem`);
  }
  return url.toString();
}

/** Contato pode ser formulário HTTPS ou um único mailbox, nunca headers mailto. */
export function normalizeOperatorContactUrl(
  raw: string,
  production: boolean,
  allowLocalLoopback = false,
  name = 'OPERATOR_CONTACT_URL',
): string {
  if (raw.toLowerCase().startsWith('mailto:')) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`${name} contém um endereço mailto inválido`);
    }
    const address = decodeURIComponent(url.pathname);
    if (url.search || url.hash || url.username || url.password || !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(address)) {
      throw new Error(`${name} mailto deve conter um único e-mail, sem query, headers ou fragmento`);
    }
    return `mailto:${address}`;
  }
  return normalizePublicMetadataUrl(name, raw, {
    production,
    allowLocalLoopback,
    allowHash: !production || allowLocalLoopback,
    requirePath: true,
  });
}

/** Resolve a política específica de cada operador; produção nunca herda a identidade do projeto. */
export function resolveOperatorPrivacyConfig(
  source: OperatorPrivacyEnvironment,
  origins: ConfiguredOrigins,
  nodeEnv: string | undefined,
  allowLocalAppUrl = false,
): OperatorPrivacyConfig {
  const production = nodeEnv === 'production';
  // A imagem Docker roda com NODE_ENV=production também no quickstart local.
  // A exceção fica presa à flag explícita e à própria APP_URL loopback;
  // ela não libera IP privado, hostname interno ou metadata local para um app público.
  const allowLocalLoopback = production && allowLocalAppUrl && isLoopbackOrigin(origins.appUrl);
  const readRequired = (name: keyof OperatorPrivacyEnvironment): string => {
    const value = source[name]?.trim() || '';
    if (production && !value) throw new Error(`${name} é obrigatória em produção`);
    return value;
  };

  const operatorName = readRequired('OPERATOR_NAME') || 'Operador local do Kassinão';
  const hasControlCharacter = [...operatorName].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (operatorName.length > 160 || hasControlCharacter) {
    throw new Error('OPERATOR_NAME precisa ter até 160 caracteres e não pode conter controles');
  }

  const localPolicyUrl = `${origins.appUrl}/privacy`;
  const privacyPolicyUrl = normalizePublicMetadataUrl(
    'PRIVACY_POLICY_URL',
    readRequired('PRIVACY_POLICY_URL') || localPolicyUrl,
    { production, allowLocalLoopback, requirePath: true },
  );
  const operatorContactUrl = normalizeOperatorContactUrl(
    readRequired('OPERATOR_CONTACT_URL') || `${localPolicyUrl}#contact`,
    production,
    allowLocalLoopback,
  );
  // Exceção deliberada ao bloqueio de fragmentos: o fluxo de exclusão pode ser
  // a seção #data-rights da própria política, sem query nem estado sensível.
  const dataDeletionUrl = normalizePublicMetadataUrl(
    'DATA_DELETION_URL',
    readRequired('DATA_DELETION_URL') || `${localPolicyUrl}#data-rights`,
    { production, allowLocalLoopback, allowHash: true, requirePath: true },
  );
  const rawTerms = source.TERMS_OF_SERVICE_URL?.trim() || '';
  const termsOfServiceUrl = rawTerms
    ? normalizePublicMetadataUrl('TERMS_OF_SERVICE_URL', rawTerms, {
        production,
        allowLocalLoopback,
        requirePath: true,
      })
    : '';

  const readPublicStatement = (name: keyof OperatorPrivacyEnvironment, fallback = '', maxLength = 1_000): string => {
    const value = readRequired(name) || fallback;
    return value ? normalizePublicStatement(name, value, maxLength) : '';
  };

  const privacyEffectiveDate = readRequired('PRIVACY_EFFECTIVE_DATE');
  if (privacyEffectiveDate) {
    const date = new Date(`${privacyEffectiveDate}T00:00:00.000Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(privacyEffectiveDate) ||
      Number.isNaN(date.getTime()) ||
      date.toISOString().slice(0, 10) !== privacyEffectiveDate ||
      date.getTime() > Date.now()
    ) {
      throw new Error('PRIVACY_EFFECTIVE_DATE precisa usar uma data real, não futura, no formato YYYY-MM-DD');
    }
  }

  const privacyPolicyVersion = readRequired('PRIVACY_POLICY_VERSION') || 'local-draft';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(privacyPolicyVersion)) {
    throw new Error('PRIVACY_POLICY_VERSION aceita 1 a 32 caracteres: letras, números, ponto, hífen e underscore');
  }
  if (production && privacyPolicyVersion.toLowerCase() === 'local-draft') {
    throw new Error('PRIVACY_POLICY_VERSION não pode usar local-draft em produção');
  }

  const privacyAudience = readPublicStatement('PRIVACY_AUDIENCE');
  const privacyPurposes = readPublicStatement('PRIVACY_PURPOSES');
  const privacyLawfulBasis = readPublicStatement('PRIVACY_LAWFUL_BASIS');
  const infrastructureProvider = readPublicStatement('INFRASTRUCTURE_PROVIDER', production ? '' : 'local', 160);
  const infrastructureRegion = readPublicStatement('INFRASTRUCTURE_REGION', production ? '' : 'local', 160);
  if (production && /^(?:none|disabled|local)$/i.test(infrastructureProvider)) {
    throw new Error('INFRASTRUCTURE_PROVIDER precisa identificar o provedor real desta instância');
  }
  if (production && /^(?:none|disabled)$/i.test(infrastructureRegion)) {
    throw new Error('INFRASTRUCTURE_REGION precisa identificar a região ou o escopo público real');
  }
  if (production && !allowLocalLoopback && /\blocal (?:machine|device|host|runtime)\b/i.test(infrastructureProvider)) {
    throw new Error('INFRASTRUCTURE_PROVIDER não pode declarar runtime local para uma APP_URL pública');
  }

  const edgeProvider = readPublicStatement('EDGE_PROVIDER', 'none', 160);
  const edgeRegion = readPublicStatement('EDGE_REGION', 'none', 160);
  const edgeDisabled = edgeProvider.toLowerCase() === 'none';
  if (edgeDisabled !== (edgeRegion.toLowerCase() === 'none')) {
    throw new Error('EDGE_PROVIDER e EDGE_REGION precisam ser ambos none ou identificar provider e região');
  }
  if (!edgeDisabled && /^(?:disabled|local)$/i.test(edgeProvider)) {
    throw new Error('EDGE_PROVIDER precisa identificar o provider real ou usar none');
  }
  if (!edgeDisabled && /^(?:disabled|local)$/i.test(edgeRegion)) {
    throw new Error('EDGE_REGION precisa identificar a região/escopo real ou usar none com EDGE_PROVIDER=none');
  }

  const operationalLogRetention = readPublicStatement('OPERATIONAL_LOG_RETENTION');
  const backupStatus = (readRequired('BACKUP_STATUS') || 'disabled').toLowerCase();
  if (backupStatus !== 'enabled' && backupStatus !== 'disabled') {
    throw new Error('BACKUP_STATUS aceita somente enabled ou disabled');
  }
  const backupEnabled = backupStatus === 'enabled';
  let backupProvider = 'none';
  let backupRegion = 'none';
  let backupRetentionDays = 0;
  if (backupEnabled) {
    backupProvider = readPublicStatement('BACKUP_PROVIDER', '', 160);
    backupRegion = readPublicStatement('BACKUP_REGION', '', 160);
    if (/^(?:none|disabled|local)$/i.test(backupProvider)) {
      throw new Error('BACKUP_PROVIDER precisa identificar o provedor real quando BACKUP_STATUS=enabled');
    }
    if (/^(?:none|disabled|local)$/i.test(backupRegion)) {
      throw new Error('BACKUP_REGION precisa identificar a região/escopo real quando BACKUP_STATUS=enabled');
    }
    const rawRetention = readRequired('BACKUP_RETENTION_DAYS');
    backupRetentionDays = privacyInteger('BACKUP_RETENTION_DAYS', rawRetention, 0, 1, 3_650);
  } else {
    for (const name of ['BACKUP_PROVIDER', 'BACKUP_REGION'] as const) {
      const value = source[name]?.trim() || '';
      if (value && value.toLowerCase() !== 'none') {
        throw new Error(`${name} precisa ficar vazio ou usar none quando BACKUP_STATUS=disabled`);
      }
    }
    const rawRetention = source.BACKUP_RETENTION_DAYS?.trim() || '';
    if (rawRetention && rawRetention !== '0') {
      throw new Error('BACKUP_RETENTION_DAYS precisa ficar vazio ou usar 0 quando BACKUP_STATUS=disabled');
    }
  }

  const dataRequestProcess = readPublicStatement('DATA_REQUEST_PROCESS');
  const rawResponseDays = readRequired('DATA_REQUEST_RESPONSE_DAYS');
  const dataRequestResponseDays = privacyInteger('DATA_REQUEST_RESPONSE_DAYS', rawResponseDays, 30, 1, 365);
  const rawIncidentContact = readRequired('INCIDENT_CONTACT_URL');
  const incidentContactUrl = rawIncidentContact
    ? normalizeOperatorContactUrl(rawIncidentContact, production, allowLocalLoopback, 'INCIDENT_CONTACT_URL')
    : operatorContactUrl;
  const incidentProcess = readPublicStatement('INCIDENT_PROCESS');

  // A política operacional precisa ler a configuração privada real. No deploy
  // dividido, landing/docs não recebem providers, retenção nem MCP; copiar um
  // snapshot para lá criaria uma segunda verdade sujeita a drift. Por isso a
  // produção fixa a política canônica no app, mas mantém a rota sem login.
  if (production && privacyPolicyUrl !== `${origins.appUrl}/privacy`) {
    throw new Error('PRIVACY_POLICY_URL precisa ser exatamente APP_URL + /privacy em produção');
  }
  if (production && dataDeletionUrl !== `${origins.appUrl}/privacy#data-rights`) {
    throw new Error('DATA_DELETION_URL precisa ser exatamente APP_URL + /privacy#data-rights em produção');
  }

  return {
    operatorName,
    operatorContactUrl,
    privacyPolicyUrl,
    dataDeletionUrl,
    termsOfServiceUrl,
    privacyEffectiveDate,
    privacyPolicyVersion,
    privacyAudience,
    privacyPurposes,
    privacyLawfulBasis,
    infrastructureProvider,
    infrastructureRegion,
    edgeProvider,
    edgeRegion,
    operationalLogRetention,
    backupEnabled,
    backupProvider,
    backupRegion,
    backupRetentionDays,
    dataRequestProcess,
    dataRequestResponseDays,
    incidentContactUrl,
    incidentProcess,
  };
}

export function normalizeSourceUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`SOURCE_URL precisa ser uma URL absoluta http(s) (recebido: ${JSON.stringify(raw)})`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackOrigin(url.origin))) {
    throw new Error('SOURCE_URL precisa usar HTTPS fora de localhost');
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error('SOURCE_URL não pode conter credenciais, query ou hash');
  if (url.pathname === '/' || url.pathname === '')
    throw new Error('SOURCE_URL precisa apontar para o repositório correspondente, não apenas para uma origem');
  return url.toString().replace(/\/$/, '');
}

/** Fingerprint público do artefato em execução; nunca contém identidade da instância. */
export function normalizeReleaseDigest(raw: string | undefined): string {
  const value = raw?.trim() || '';
  if (value && !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error('KASSINAO_RELEASE_DIGEST precisa usar sha256:<64 hex>');
  }
  return value;
}

/** Identificador aleatório e público do deploy; não codifica domínio, guild ou operador. */
export function normalizeDeploymentFingerprint(raw: string | undefined): string {
  const value = raw?.trim() || '';
  if (value && !/^[0-9a-f]{32}$/.test(value)) {
    throw new Error('KASSINAO_DEPLOYMENT_FINGERPRINT precisa usar 32 hex minúsculos');
  }
  return value;
}

function isLoopbackOrigin(origin: string): boolean {
  const host = new URL(origin).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/** Produção local existe, mas precisa ser uma escolha explícita do operador. */
export function validateDeploymentAppOrigin(origin: string, nodeEnv: string | undefined, allowLocal: boolean): void {
  if (nodeEnv === 'production' && isLoopbackOrigin(origin) && !allowLocal) {
    throw new Error(
      'APP_URL localhost em produção exige ALLOW_LOCAL_APP_URL=true explícito. ' +
        'Uma instância exposta à internet precisa usar sua própria origem HTTPS.',
    );
  }
}

/** Segredos HMAC fracos não podem parecer configuração válida. */
export function validateSecret(name: string, value: string, minBytes = 32): string {
  if (Buffer.byteLength(value, 'utf8') < minBytes) {
    throw new Error(`${name} precisa ter ao menos ${minBytes} bytes (gere com: openssl rand -hex 32)`);
  }
  return value;
}

/** Um segredo entregue a outra integração nunca pode reutilizar credenciais internas. */
export function validateDedicatedSecret(
  name: string,
  value: string,
  protectedSecrets: ReadonlyArray<readonly [name: string, value: string]>,
): string {
  const valid = validateSecret(name, value);
  const conflict = protectedSecrets.find(([, protectedValue]) => protectedValue && protectedValue === valid);
  if (conflict) throw new Error(`${name} não pode ser igual a ${conflict[0]} (isolamento de segurança)`);
  return valid;
}

const recordingsDir = path.resolve(process.env.RECORDINGS_DIR || './recordings');
// Instalações antigas continuam válidas porque ambos caem para RECORDINGS_DIR.
// Novas instalações/produção devem apontar cada classe para um volume distinto:
// gravações, estado operacional e autenticação revogável.
const stateDir = path.resolve(process.env.STATE_DIR || recordingsDir);
const authStateDir = path.resolve(process.env.AUTH_STATE_DIR || recordingsDir);
const allowLegacySharedState = booleanEnv('ALLOW_LEGACY_SHARED_STATE', false);

function sameFileSystemObject(left: string, right: string): boolean {
  if (path.resolve(left) === path.resolve(right)) return true;
  try {
    const a = fs.statSync(left);
    const b = fs.statSync(right);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  const aToB = path.relative(a, b);
  const bToA = path.relative(b, a);
  return (
    aToB === '' ||
    (!aToB.startsWith(`..${path.sep}`) && aToB !== '..' && !path.isAbsolute(aToB)) ||
    (!bToA.startsWith(`..${path.sep}`) && bToA !== '..' && !path.isAbsolute(bToA))
  );
}

function regularFileValue(file: string, label: string): string | undefined {
  try {
    const flags =
      fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const descriptor = fs.openSync(file, flags);
    try {
      if (!fs.fstatSync(descriptor).isFile()) throw new Error('não é arquivo regular');
      return fs.readFileSync(descriptor, 'utf8').trim();
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    console.error(`Não foi possível ler ${label}: ${(err as Error).message}`);
    process.exit(1);
  }
}

function stateLayoutIsCurrent(marker: string): boolean {
  const version = regularFileValue(marker, 'o marcador de layout privado');
  if (version === undefined) return false;
  if (version !== '2') {
    console.error('Layout privado inválido: .layout-v2 precisa conter exatamente a versão 2');
    process.exit(1);
  }
  return true;
}

function persistStateLayoutMarker(marker: string): void {
  const temporaryMarker = `${marker}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let failure: unknown;
  try {
    const descriptor = fs.openSync(temporaryMarker, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, '2\n');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    try {
      // link(2) publica o arquivo completo sem substituir um vencedor concorrente.
      fs.linkSync(temporaryMarker, marker);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || !stateLayoutIsCurrent(marker)) throw err;
    }
  } catch (err) {
    failure = err;
  }
  try {
    fs.unlinkSync(temporaryMarker);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && failure === undefined) failure = err;
  }
  if (failure !== undefined) throw failure;
}

/** Lê ou gera em memória; persistência só acontece depois de toda validação. */
function prepareCookieSecret(): string {
  if (process.env.COOKIE_SECRET) {
    try {
      return validateSecret('COOKIE_SECRET', process.env.COOKIE_SECRET);
    } catch (err) {
      console.error(`Configuração inválida: ${(err as Error).message}`);
      process.exit(1);
    }
  }
  const candidates = [path.join(authStateDir, '.cookie-secret'), path.join(recordingsDir, '.cookie-secret')];
  for (const file of candidates) {
    const value = regularFileValue(file, 'o segredo de sessão');
    if (value !== undefined) {
      try {
        return validateSecret('.cookie-secret', value);
      } catch (err) {
        console.error(`Segredo de sessão inválido: ${(err as Error).message}`);
        process.exit(1);
      }
    }
  }
  return crypto.randomBytes(32).toString('hex');
}

function prepareInstanceId(): string {
  const saved = regularFileValue(path.join(authStateDir, '.instance-id'), 'a identidade da instância');
  if (saved === undefined) return crypto.randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved)) {
    console.error('Identidade da instância inválida; não substitua esse arquivo numa instância existente.');
    process.exit(1);
  }
  return saved.toLowerCase();
}

function filesEqual(left: string, right: string): boolean {
  try {
    return fs.readFileSync(left).equals(fs.readFileSync(right));
  } catch {
    return false;
  }
}

/** Migração autenticável move; estado operacional é copiado para permitir rollback de dados. */
function migratePrivateStateFile(source: string, destination: string, removeSource: boolean): void {
  if (path.resolve(source) === path.resolve(destination) || !fs.existsSync(source)) return;
  if (fs.existsSync(destination)) {
    if (sameFileSystemObject(source, destination)) return;
    if (filesEqual(source, destination)) {
      if (removeSource) fs.unlinkSync(source);
      return;
    }
    operationalFailure('Migração de estado ambígua: origem e destino privados já existem');
    process.exit(1);
  }
  try {
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('a origem não é um arquivo regular');
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    if (!filesEqual(source, destination)) throw new Error('a cópia não passou na verificação de bytes');
    if (removeSource) fs.unlinkSync(source);
    if (process.platform !== 'win32') fs.chmodSync(destination, 0o600);
  } catch (err) {
    // Test workers/replicas can race on the same first boot. Quem perdeu a
    // corrida aceita somente o destino já criado; ausência dos dois é erro.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && fs.existsSync(destination)) return;
    operationalFailure(`Não foi possível migrar estado privado: ${operationalError(err)}`);
    process.exit(1);
  }
}

function persistExact(file: string, value: string): void {
  const existing = regularFileValue(file, 'estado privado persistente');
  if (existing !== undefined) {
    if (existing !== value) throw new Error('o valor persistido diverge do valor validado em memória');
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
    return;
  }
  fs.writeFileSync(file, value, { mode: 0o600, flag: 'wx' });
}

function replacePrivateFile(file: string, value: string): void {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temp, value, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function assertDedicatedDataPath(dir: string): void {
  if (process.platform === 'win32') return;
  const resolved = path.resolve(dir);
  const forbidden = new Set([
    '/',
    '/app',
    '/etc',
    '/home',
    '/opt',
    '/root',
    '/run',
    '/srv',
    '/tmp',
    '/usr',
    '/var',
    '/var/lib',
  ]);
  if (forbidden.has(resolved)) throw new Error(`${resolved} é um diretório de sistema, não um volume dedicado`);
}

function assertMigrationPair(source: string, destination: string): void {
  if (!fs.existsSync(source) || !fs.existsSync(destination) || sameFileSystemObject(source, destination)) return;
  if (!filesEqual(source, destination)) {
    throw new Error('origem legada e destino novo divergem; restaure ou reconcilie manualmente antes do boot');
  }
}

/** Único ponto interno de mutação do bootstrap. */
function persistPrivateStateLayout(cookieSecret: string, instanceId: string): void {
  const stateMarker = path.join(stateDir, '.layout-v2');
  try {
    for (const dir of [recordingsDir, stateDir, authStateDir]) assertDedicatedDataPath(dir);
    const overlaps =
      pathsOverlap(recordingsDir, stateDir) ||
      pathsOverlap(recordingsDir, authStateDir) ||
      pathsOverlap(stateDir, authStateDir);
    const intentionalLegacyAlias =
      allowLegacySharedState &&
      sameFileSystemObject(recordingsDir, stateDir) &&
      sameFileSystemObject(recordingsDir, authStateDir);
    if (overlaps && !intentionalLegacyAlias) {
      throw new Error('RECORDINGS_DIR, STATE_DIR e AUTH_STATE_DIR não podem coincidir nem ficar aninhados');
    }
    if (!stateLayoutIsCurrent(stateMarker)) {
      for (const [legacyName, destination] of [
        ['guildconfig.json', path.join(stateDir, 'guildconfig.json')],
        ['autorecord.json', path.join(stateDir, 'autorecord.json')],
        ['.recording-admission.json', path.join(stateDir, 'recording-admission.json')],
        ['.discord-surface-inventory.json', path.join(stateDir, 'discord-surface-inventory.json')],
      ] as const) {
        assertMigrationPair(path.join(recordingsDir, legacyName), destination);
      }
    }
    for (const [legacyName, destination] of [
      ['.cookie-secret', path.join(authStateDir, '.cookie-secret')],
      ['.web-sessions.json', path.join(authStateDir, 'web-sessions.json')],
      ['.mcp-sessions.json', path.join(authStateDir, 'mcp-sessions.json')],
    ] as const) {
      assertMigrationPair(path.join(recordingsDir, legacyName), destination);
    }
  } catch (err) {
    console.error(`Layout privado inválido: ${(err as Error).message}`);
    process.exit(1);
  }

  for (const [label, dir] of [
    ['gravações', recordingsDir],
    ['estado operacional', stateDir],
    ['estado de autenticação', authStateDir],
  ] as const) {
    try {
      if (process.env.NODE_ENV === 'production' && !fs.existsSync(dir)) {
        throw new Error('o volume precisa existir antes do boot de produção');
      }
      const existed = fs.existsSync(dir);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('não é diretório regular');
      if (process.platform !== 'win32') {
        const mode = stat.mode & 0o777;
        if (existed && (mode & 0o077) !== 0) {
          throw new Error(`permissão ${mode.toString(8)} expõe o volume; ajuste para 0700 antes do boot`);
        }
        if (!existed) fs.chmodSync(dir, 0o700);
      }
    } catch (err) {
      console.error(`Não foi possível preparar o volume de ${label}: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  if (
    process.env.NODE_ENV === 'production' &&
    !allowLegacySharedState &&
    (sameFileSystemObject(recordingsDir, stateDir) ||
      sameFileSystemObject(recordingsDir, authStateDir) ||
      sameFileSystemObject(stateDir, authStateDir))
  ) {
    console.error(
      'Configuração inválida: RECORDINGS_DIR, STATE_DIR e AUTH_STATE_DIR precisam ser três volumes distintos em produção.',
    );
    process.exit(1);
  }

  if (!stateLayoutIsCurrent(stateMarker)) {
    for (const [legacyName, destination] of [
      ['guildconfig.json', path.join(stateDir, 'guildconfig.json')],
      ['autorecord.json', path.join(stateDir, 'autorecord.json')],
      ['.recording-admission.json', path.join(stateDir, 'recording-admission.json')],
      ['.discord-surface-inventory.json', path.join(stateDir, 'discord-surface-inventory.json')],
    ] as const) {
      migratePrivateStateFile(path.join(recordingsDir, legacyName), destination, false);
    }
    persistStateLayoutMarker(stateMarker);
  }

  const cookieFile = path.join(authStateDir, '.cookie-secret');
  if (process.env.COOKIE_SECRET) {
    const previous = regularFileValue(cookieFile, 'o segredo de sessão persistido');
    if (previous !== cookieSecret) {
      replacePrivateFile(cookieFile, cookieSecret);
      for (const sessionFile of [
        path.join(authStateDir, 'web-sessions.json'),
        path.join(recordingsDir, '.web-sessions.json'),
      ]) {
        if (fs.existsSync(sessionFile) && !fs.lstatSync(sessionFile).isSymbolicLink()) fs.unlinkSync(sessionFile);
      }
    }
    const legacyCookie = path.join(recordingsDir, '.cookie-secret');
    if (fs.existsSync(legacyCookie) && !sameFileSystemObject(legacyCookie, cookieFile)) fs.unlinkSync(legacyCookie);
  } else {
    migratePrivateStateFile(path.join(recordingsDir, '.cookie-secret'), cookieFile, true);
  }
  for (const [legacyName, destination] of [
    ['.web-sessions.json', path.join(authStateDir, 'web-sessions.json')],
    ['.mcp-sessions.json', path.join(authStateDir, 'mcp-sessions.json')],
  ] as const) {
    migratePrivateStateFile(path.join(recordingsDir, legacyName), destination, true);
  }
  try {
    persistExact(cookieFile, cookieSecret);
    persistExact(path.join(authStateDir, '.instance-id'), instanceId);
  } catch (err) {
    console.error(`Não foi possível persistir a identidade privada da instância: ${(err as Error).message}`);
    process.exit(1);
  }
}

/**
 * Deriva um segredo dedicado por finalidade a partir do MCP_SECRET (HKDF-SHA256).
 * Rótulos distintos ⇒ segredos distintos: um token de refresh apresentado como
 * access (ou vice-versa) QUEBRA o HMAC, não depende só da checagem de `typ`.
 */
function deriveSecret(secret: string, label: string): string {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), Buffer.from(label), 32)).toString(
    'hex',
  );
}

// MCP é OPT-IN: só liga quando MCP_SECRET vem do ambiente. NUNCA auto-gerado em
// disco (como o cookie) — rotacionar o segredo é o botão de pânico que invalida
// todos os tokens de uma vez, então ele tem que ser deliberado e estável.
const mcpSecret = process.env.MCP_SECRET || '';

// Provider da ata, normalizado UMA vez (o default do modelo depende dele).
const minutesProvider = choiceEnv('MINUTES_PROVIDER', process.env.OPENROUTER_API_KEY ? 'openrouter' : 'groq', [
  'openrouter',
  'groq',
] as const);

// Retenção: RETENTION_DAYS=0 desliga a expiração (áudio E texto ficam até alguém
// apagar manualmente). Áudio ilimitado FORÇA texto ilimitado — não faz sentido a
// memória (transcrição/ata) morrer antes do áudio que ela resume.
const retentionDays = numberEnv('RETENTION_DAYS', 7, { min: 0 });
const audioRetentionUnlimited = retentionDays <= 0;
const textRetentionDaysRaw = numberEnv('TEXT_RETENTION_DAYS', 90, { min: 0 });
const textRetentionUnlimited = audioRetentionUnlimited || textRetentionDaysRaw <= 0;

const port = numberEnv('PORT', 8080, { min: 1, max: 65535, integer: true });
const WEB_BIND_ADDRESSES = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0', '::']);

/**
 * O listener bare-node fecha em loopback por padrão. Wildcards continuam
 * disponíveis, mas exigem uma escolha explícita do operador (container
 * usam isso dentro do isolamento do container).
 */
export function normalizeWebBindAddress(raw: string | undefined): string {
  const value = raw?.trim() || '127.0.0.1';
  if (!WEB_BIND_ADDRESSES.has(value)) {
    throw new Error(
      `WEB_BIND_ADDRESS aceita somente 127.0.0.1, ::1, localhost, 0.0.0.0 ou :: (recebido: ${JSON.stringify(value)})`,
    );
  }
  return value;
}

let webBindAddress: string;
try {
  webBindAddress = normalizeWebBindAddress(process.env.WEB_BIND_ADDRESS);
} catch (err) {
  console.error(`Configuração inválida: ${(err as Error).message}`);
  process.exit(1);
}
const localUrl = `http://localhost:${port}`;
if (process.env.NODE_ENV === 'production' && !process.env.APP_URL?.trim() && !process.env.BASE_URL?.trim()) {
  console.error('Configuração inválida: APP_URL é obrigatória em produção');
  process.exit(1);
}
// APP_URL é a origem canônica do produto privado (OAuth, gravações e downloads).
// BASE_URL continua aceito como alias retrocompatível para instalações existentes.
let configuredOrigins: ConfiguredOrigins;
try {
  configuredOrigins = resolveConfiguredOrigins(process.env, localUrl);
} catch (err) {
  console.error(`Configuração inválida: ${(err as Error).message}`);
  process.exit(1);
}
const { appUrl, publicUrl, docsUrl, mcpUrl } = configuredOrigins;
for (const [name, origin] of Object.entries({
  APP_URL: appUrl,
  PUBLIC_URL: publicUrl,
  DOCS_URL: docsUrl,
  MCP_URL: mcpUrl,
})) {
  if (origin.startsWith('http:') && !isLoopbackOrigin(origin)) {
    console.error(`Configuração inválida: ${name} precisa usar HTTPS fora de localhost`);
    process.exit(1);
  }
}
const allowLocalAppUrl = booleanEnv('ALLOW_LOCAL_APP_URL', false);
try {
  for (const origin of [appUrl, publicUrl, docsUrl, mcpUrl]) {
    validateDeploymentAppOrigin(origin, process.env.NODE_ENV, allowLocalAppUrl);
  }
} catch (err) {
  console.error(`Configuração inválida: ${(err as Error).message}`);
  process.exit(1);
}
if (process.env.BASE_URL?.trim()) {
  console.warn('⚠️  BASE_URL é legado. Migre para APP_URL; quando ambos existem, precisam ser idênticos.');
}

let operatorPrivacy: OperatorPrivacyConfig;
try {
  operatorPrivacy = resolveOperatorPrivacyConfig(
    process.env,
    configuredOrigins,
    process.env.NODE_ENV,
    allowLocalAppUrl,
  );
} catch (err) {
  console.error(`Configuração inválida: ${(err as Error).message}`);
  process.exit(1);
}

let guildPolicy: ReturnType<typeof createGuildPolicy>;
try {
  guildPolicy = createGuildPolicy(process.env);
} catch (err) {
  console.error(`Configuração inválida: ${(err as Error).message}`);
  process.exit(1);
}

let sourceUrl: string;
try {
  const configuredSourceUrl = process.env.SOURCE_URL?.trim() || '';
  if (process.env.NODE_ENV === 'production' && !configuredSourceUrl) {
    throw new Error('SOURCE_URL é obrigatória em produção e precisa apontar para o source desta instalação');
  }
  sourceUrl = normalizeSourceUrl(configuredSourceUrl || 'https://github.com/resolvicomai/kassinao');
} catch (err) {
  console.error(`Configuração inválida: ${(err as Error).message}`);
  process.exit(1);
}
let releaseDigest: string;
let deploymentFingerprint: string;
try {
  releaseDigest = normalizeReleaseDigest(process.env.KASSINAO_RELEASE_DIGEST);
  deploymentFingerprint = normalizeDeploymentFingerprint(process.env.KASSINAO_DEPLOYMENT_FINGERPRINT);
} catch (err) {
  console.error(`Configuração inválida: ${(err as Error).message}`);
  process.exit(1);
}
// Vários módulos e integrações self-hosted ainda leem config.baseUrl. Seu
// significado permanece sendo a origem do app, agora também exposta como appUrl.
const baseUrl = appUrl;
const cookieSecret = prepareCookieSecret();
const instanceId = prepareInstanceId();

// Aviso de upgrade: quem rodava RETENTION_DAYS curto (privacidade/compliance) e NÃO
// setou TEXT_RETENTION_DAYS passa a reter transcrição/ata/notas por 90 dias (o default
// da retenção em camadas do #23). É intencional e documentado, mas não pode ser silencioso.
if (!process.env.TEXT_RETENTION_DAYS && !audioRetentionUnlimited && textRetentionDaysRaw > retentionDays) {
  console.warn(
    `⚠️  TEXT_RETENTION_DAYS não definido: transcrição/ata/notas ficam ${textRetentionDaysRaw} dias ` +
      `(padrão da retenção em camadas), enquanto o áudio expira em ${retentionDays}. ` +
      `Defina TEXT_RETENTION_DAYS no .env para alinhar (ex.: =${retentionDays}) se precisa apagar o texto junto com o áudio.`,
  );
}

// O repositório não presume o idioma da instância. Português continua com um
// prompt útil quando o operador escolhe `pt`; o default genérico é inglês.
const transcribeLanguage = process.env.TRANSCRIBE_LANGUAGE || 'en';
const defaultTranscribePrompt = transcribeLanguage.startsWith('pt')
  ? 'Transcrição de uma reunião de trabalho informal em português do Brasil.'
  : '';

const transcribeProvider = choiceEnv('TRANSCRIBE_PROVIDER', 'none', [
  'none',
  'assemblyai',
  'openai',
  'groq',
  'gemini',
  'command',
] as const);
const transcribeFallbackProvider = choiceEnv('TRANSCRIBE_FALLBACK_PROVIDER', 'none', ['none', 'groq'] as const);
const transcribeCommandEnvAllowlist = (process.env.TRANSCRIBE_COMMAND_ENV_ALLOWLIST || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
for (const name of transcribeCommandEnvAllowlist) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    console.error(`Configuração inválida: TRANSCRIBE_COMMAND_ENV_ALLOWLIST contém nome inválido: ${name}`);
    process.exit(1);
  }
}

let openrouterSiteUrl = '';
if (process.env.OPENROUTER_SITE_URL?.trim()) {
  try {
    openrouterSiteUrl = normalizeOrigin('OPENROUTER_SITE_URL', process.env.OPENROUTER_SITE_URL);
  } catch (err) {
    console.error(`Configuração inválida: ${(err as Error).message}`);
    process.exit(1);
  }
}

function normalizeWebhookUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('MINUTES_WEBHOOK_URL precisa ser uma URL absoluta');
  }
  if (url.username || url.password || url.hash || url.search)
    throw new Error('MINUTES_WEBHOOK_URL não pode conter credenciais, query ou hash');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackOrigin(url.origin))) {
    throw new Error('MINUTES_WEBHOOK_URL precisa usar HTTPS fora de localhost');
  }
  return url.toString();
}

let minutesWebhookUrl = '';
let minutesWebhookSecret = '';
if (process.env.MINUTES_WEBHOOK_URL?.trim()) {
  try {
    minutesWebhookUrl = normalizeWebhookUrl(process.env.MINUTES_WEBHOOK_URL);
    minutesWebhookSecret = validateSecret('MINUTES_WEBHOOK_SECRET', process.env.MINUTES_WEBHOOK_SECRET || '');
  } catch (err) {
    console.error(`Configuração inválida: ${(err as Error).message}`);
    process.exit(1);
  }
}

export const config = {
  token: required('DISCORD_TOKEN'),
  applicationId: required('APPLICATION_ID'),
  /** Client Secret do OAuth2 (Developer Portal > OAuth2) — usado no login da página de downloads. */
  clientSecret: required('DISCORD_CLIENT_SECRET'),
  /** Se definido, registra os comandos só nesse servidor (atualização instantânea). */
  guildId: process.env.GUILD_ID || undefined,
  /** Política de tenancy usada por Discord, web, MCP e recuperação. */
  guildPolicy,
  port,
  /** Interface do listener HTTP. Loopback por padrão; container opta por wildcard internamente. */
  webBindAddress,
  /** Quantidade exata de proxies confiáveis entre cliente e Express. 0 = nenhum. */
  trustProxyHops: numberEnv('TRUST_PROXY_HOPS', 0, { min: 0, max: 10, integer: true }),
  /** Origem canônica do app privado, OAuth, gravações e downloads. Alias compatível de appUrl. */
  baseUrl,
  /** Origem canônica do app privado. APP_URL cai para BASE_URL e depois localhost. */
  appUrl,
  /** Exceção explícita para executar a imagem de produção somente em localhost. */
  allowLocalAppUrl,
  /** Compatibilidade temporária; produção nova mantém dados, estado e autenticação separados. */
  allowLegacySharedState,
  /** Origem da landing e da demo pública. Cai para appUrl em instalações de origem única. */
  publicUrl,
  /** Origem da documentação. Cai para publicUrl; quando separada, PT vive em / e EN em /en. */
  docsUrl,
  /** Origem da API MCP. Cai para appUrl em instalações de origem única. */
  mcpUrl,
  /** Identidade pública de quem controla os dados desta instância. */
  operatorName: operatorPrivacy.operatorName,
  /** Canal HTTPS público para solicitações de privacidade ao operador. */
  operatorContactUrl: operatorPrivacy.operatorContactUrl,
  /** Política específica da instância, cadastrada também no Discord Developer Portal. */
  privacyPolicyUrl: operatorPrivacy.privacyPolicyUrl,
  /** Fluxo público de acesso, correção e exclusão de dados. */
  dataDeletionUrl: operatorPrivacy.dataDeletionUrl,
  /** Termos próprios do operador; vazio quando ele não os adota. */
  termsOfServiceUrl: operatorPrivacy.termsOfServiceUrl,
  /** Data e versão públicas do texto aplicável nesta instância. */
  privacyEffectiveDate: operatorPrivacy.privacyEffectiveDate,
  privacyPolicyVersion: operatorPrivacy.privacyPolicyVersion,
  /** Escopo e justificativa declarados pelo operador; o projeto não infere base legal. */
  privacyAudience: operatorPrivacy.privacyAudience,
  privacyPurposes: operatorPrivacy.privacyPurposes,
  privacyLawfulBasis: operatorPrivacy.privacyLawfulBasis,
  /** Localização pública em nível de provedor/região, nunca host, IP ou conta. */
  infrastructureProvider: operatorPrivacy.infrastructureProvider,
  infrastructureRegion: operatorPrivacy.infrastructureRegion,
  edgeProvider: operatorPrivacy.edgeProvider,
  edgeRegion: operatorPrivacy.edgeRegion,
  /** Política operacional declarada e publicada por esta instalação. */
  operationalLogRetention: operatorPrivacy.operationalLogRetention,
  /** Janela máxima para snapshot operacional preservado por deploy image-only que falhou. */
  rollbackRetentionHours: numberEnv('KASSINAO_ROLLBACK_RETENTION_HOURS', 72, {
    min: 1,
    max: 168,
    integer: true,
  }),
  backupEnabled: operatorPrivacy.backupEnabled,
  backupProvider: operatorPrivacy.backupProvider,
  backupRegion: operatorPrivacy.backupRegion,
  backupRetentionDays: operatorPrivacy.backupRetentionDays,
  dataRequestProcess: operatorPrivacy.dataRequestProcess,
  dataRequestResponseDays: operatorPrivacy.dataRequestResponseDays,
  incidentContactUrl: operatorPrivacy.incidentContactUrl,
  incidentProcess: operatorPrivacy.incidentProcess,
  /** Identidade local persistida no volume de autenticação; nunca vem do Git. */
  instanceId,
  /** Repositório-fonte exibido por /sobre e pelas superfícies públicas. Não recebe dados. */
  sourceUrl,
  /** Digest OCI não secreto usado para provar qual release respondeu ao healthcheck. */
  releaseDigest,
  /** Nonce público que prova qual deploy/túnel respondeu, sem identificar o operador. */
  deploymentFingerprint,
  /**
   * Permite landing/docs/demo dentro do processo privado. Conveniente para uma
   * instalação simples de origem única; a operação separada deve definir false
   * e publicar as superfícies públicas num processo sem segredos nem volumes.
   */
  publicSurfacesEnabled: booleanEnv('PUBLIC_SURFACES_ENABLED', true),
  /** true quando o repo do GitHub está público — libera os links "GitHub"/access.ts e a afirmação "auditável" na landing. Padrão false pra nunca servir link 404. */
  repoPublic: process.env.REPO_PUBLIC === 'true',
  recordingsDir,
  /** Estado operacional que pode ser restaurado sem restaurar credenciais. */
  stateDir,
  /** Cookies, sessões web e sessões MCP. Nunca entra no backup de gravações. */
  authStateDir,
  /** Dias até o ÁUDIO expirar. 0 = nunca (delete só manual). */
  retentionDays,
  /** true quando RETENTION_DAYS=0 — nada de áudio expira sozinho. */
  audioRetentionUnlimited,
  /**
   * Retenção em camadas: o ÁUDIO expira em RETENTION_DAYS (pesado), mas
   * transcrição + ata + metadados vivem TEXT_RETENTION_DAYS (leve) — a memória
   * das reuniões (busca, MCP, /perguntar) não pode evaporar em 1 semana.
   * Nunca menor que RETENTION_DAYS. 0 (ou RETENTION_DAYS=0) = nunca expira.
   */
  textRetentionDays: Math.max(textRetentionDaysRaw, retentionDays),
  /** true quando texto (transcrição/ata/meta) nunca expira sozinho. */
  textRetentionUnlimited,
  maxRecordingHours: numberEnv('MAX_RECORDING_HOURS', 6, { min: Number.EPSILON }),
  /** Sessões globais consumindo recursos, inclusive durante início/encerramento. */
  recordingMaxConcurrent: numberEnv('RECORDING_MAX_CONCURRENT', 2, { min: 1, integer: true }),
  /** Cota dura móvel por servidor, somando inícios manuais e automáticos; admin não ignora. */
  recordingGuildStartsPer24h: numberEnv('RECORDING_GUILD_STARTS_PER_24H', 12, { min: 1, integer: true }),
  /** Cotas duras globais contra churn e custo externo. */
  recordingStartsGlobalPerHour: numberEnv('RECORDING_STARTS_GLOBAL_PER_HOUR', 8, { min: 1, integer: true }),
  recordingStartsGlobal24h: numberEnv('RECORDING_STARTS_GLOBAL_PER_24H', 32, { min: 1, integer: true }),
  /** Vagas reservadas antes da captura até cook + ASR + ata terminarem. */
  recordingMaxPendingProcessing: numberEnv('RECORDING_MAX_PENDING_PROCESSING', 12, {
    min: 1,
    integer: true,
  }),
  /** Cooldown global por membro comum entre inícios manuais; admin ignora. */
  manualRecordUserCooldownSec: numberEnv('MANUAL_RECORD_USER_COOLDOWN_SEC', 60, { min: 0, integer: true }),
  /** Cooldown do servidor entre inícios manuais de membros comuns; admin ignora. */
  manualRecordGuildCooldownSec: numberEnv('MANUAL_RECORD_GUILD_COOLDOWN_SEC', 15, { min: 0, integer: true }),
  mp3Bitrate: process.env.MP3_BITRATE || '192k',
  cookieSecret,
  /** Fuso para datas no transcript .md e fallback da página (o navegador tem prioridade na web). */
  /** O repositório não incorpora o fuso da instância oficial. */
  timezone: process.env.TZ || 'UTC',
  /** Idioma padrão onde não há locale do usuário (ex.: DM). 'pt' se DEFAULT_LOCALE começar com "pt", senão 'en'. */
  defaultLocale: ((process.env.DEFAULT_LOCALE || '').toLowerCase().startsWith('pt') ? 'pt' : 'en') as 'pt' | 'en',
  /** Expõe na política se identificadores e mensagens privadas entraram nos logs. */
  logPiiEnabled: booleanEnv('LOG_PII', false),

  /**
   * Motor de transcrição: 'none' | 'assemblyai' | 'openai' | 'groq' | 'gemini' | 'command'.
   * 'assemblyai' (Universal) só usa fallback Groq quando o operador define
   * TRANSCRIBE_FALLBACK_PROVIDER=groq e fornece GROQ_API_KEY.
   * 'command' roda um executável local (faster-whisper, whisper.cpp, Parakeet...)
   * definido em TRANSCRIBE_COMMAND com os placeholders {input} e {output}.
   */
  transcribeProvider,
  /** Fallback externo precisa ser autorizado explicitamente; uma chave isolada não o liga. */
  transcribeFallbackProvider,
  /** Autoriza enviar nomes de participantes/servidor/canal ao provider ASR. */
  transcribeSendMeetingContext: booleanEnv('TRANSCRIBE_SEND_MEETING_CONTEXT', false),
  transcribeModel: process.env.TRANSCRIBE_MODEL || '',
  transcribeLanguage,
  /** Prompt de contexto pro ASR (vocabulário/estilo) — reduz alucinação e melhora jargão. Whisper e Universal-3.5-Pro usam. */
  transcribePrompt: process.env.TRANSCRIBE_PROMPT ?? defaultTranscribePrompt,
  /**
   * Termos fixos do time (produtos, siglas, nomes) pro keyterms_prompt do
   * Universal-3.5-Pro da AssemblyAI — separados por vírgula. Com
   * TRANSCRIBE_SEND_MEETING_CONTEXT=true, os nomes dos participantes de cada
   * gravação também entram; isto é o vocabulário extra configurado pelo operador.
   */
  transcribeKeyterms: (process.env.TRANSCRIBE_KEYTERMS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  transcribeCommand: process.env.TRANSCRIBE_COMMAND || '',
  /** Variáveis adicionais que o operador decidiu entregar ao comando local. */
  transcribeCommandEnvAllowlist,
  /** Timeout do provider 'command' = max(10min, duração do chunk × este fator). */
  transcribeTimeoutFactor: numberEnv('TRANSCRIBE_TIMEOUT_FACTOR', 5, { min: Number.EPSILON }),
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  groqApiKey: process.env.GROQ_API_KEY || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  assemblyaiApiKey: process.env.ASSEMBLYAI_API_KEY || '',
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  /** Referer opcional enviado ao OpenRouter. Vazio por padrão em self-host. */
  openrouterSiteUrl,

  /**
   * Ata com IA (resumo + decisões + tarefas) gerada após a transcrição.
   * 'false' (padrão) desliga. 'true' liga deliberadamente. 'auto' existe apenas
   * para compatibilidade com instalações antigas e liga quando encontra chave.
   * Provider: MINUTES_PROVIDER = openrouter | groq. Padrão: openrouter se houver
   * OPENROUTER_API_KEY, porque o caminho suporta contexto maior antes de recorrer
   * a truncamento; senão usa groq com o map-reduce conservador do pipeline.
   */
  minutesEnabled: choiceEnv('MINUTES_ENABLED', 'false', ['true', 'false', 'auto'] as const),
  minutesProvider,
  minutesModel:
    process.env.MINUTES_MODEL || (minutesProvider === 'groq' ? 'llama-3.3-70b-versatile' : 'google/gemini-2.5-flash'),
  /** Teto de tokens de saída da ata. 8192 cobre reuniões longas. */
  minutesMaxTokens: numberEnv('MINUTES_MAX_TOKENS', 8192, { min: 1, integer: true }),
  /**
   * Webhook opcional (URL definida pelo OPERADOR via env — nunca via Discord,
   * senão viraria vetor de SSRF): recebe um POST JSON com a ata de cada reunião
   * ao ficar pronta. Útil para n8n/Zapier self-hosted → Notion/Jira/etc.
   */
  minutesWebhookUrl,
  /** HMAC dedicado ao webhook; obrigatório quando a URL está configurada. */
  minutesWebhookSecret,

  // ---------- MCP (conector para assistentes de IA) — opt-in via MCP_SECRET ----------
  /** Liga a API /api/* e o comando /mcp quando há MCP_SECRET. */
  mcpEnabled: !!mcpSecret,
  mcpSecret,
  /** Segredos dedicados por finalidade (HKDF do MCP_SECRET) — isolados do cookieSecret. */
  mcpAccessSecret: mcpSecret ? deriveSecret(mcpSecret, 'kassinao-mcp-access-v1') : '',
  mcpRefreshSecret: mcpSecret ? deriveSecret(mcpSecret, 'kassinao-mcp-refresh-v1') : '',
  /** IDs Discord autorizados a emitir/revogar tokens pelo comando /mcp (allowlist explícita). */
  ownerIds: (process.env.OWNER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** Vida do access token (curto: se vazar, morre sozinho). */
  mcpAccessTtlMin: numberEnv('MCP_ACCESS_TTL_MIN', 15, { min: Number.EPSILON }),
  /** Vida do refresh token (rotacionado a cada uso). */
  mcpRefreshTtlDays: numberEnv('MCP_REFRESH_TTL_DAYS', 30, { min: Number.EPSILON }),

  // ---------- guarda de disco e monitoramento ----------
  /** Espaço livre mínimo (MB) para INICIAR uma gravação; abaixo disso, recusa com aviso. */
  minFreeMbStart: numberEnv('MIN_FREE_MB_START', 500, { min: 0 }),
  /** Espaço livre mínimo (MB) DURANTE a gravação; abaixo disso, encerra pra não corromper a faixa. */
  minFreeMbAbort: numberEnv('MIN_FREE_MB_ABORT', 150, { min: 0 }),
  /** % de uso de disco que dispara alerta por DM ao(s) dono(s). */
  diskAlertPct: numberEnv('DISK_ALERT_PCT', 85, { min: Number.EPSILON, max: 100 }),
};

if (config.minFreeMbAbort > config.minFreeMbStart) {
  console.error(
    'MIN_FREE_MB_ABORT não pode ser maior que MIN_FREE_MB_START (senão a gravação aborta logo após iniciar).',
  );
  process.exit(1);
}

// Isolamento de blast-radius: o segredo do MCP não pode coincidir com o dos
// cookies (senão um token de sessão web e um token de MCP se forjariam entre si,
// exatamente a classe de bug do crítico histórico #1).
if (config.mcpEnabled) {
  try {
    validateSecret('MCP_SECRET', config.mcpSecret);
  } catch (err) {
    console.error(`Configuração inválida: ${(err as Error).message}`);
    process.exit(1);
  }
  if (config.mcpSecret === config.cookieSecret) {
    console.error('MCP_SECRET não pode ser igual ao COOKIE_SECRET (isolamento de segurança).');
    process.exit(1);
  }
  if (config.mcpAccessSecret === config.mcpRefreshSecret || !config.mcpAccessSecret || !config.mcpRefreshSecret) {
    console.error('Erro interno: derivação dos segredos MCP falhou.');
    process.exit(1);
  }
}

if (config.minutesWebhookUrl) {
  try {
    validateDedicatedSecret('MINUTES_WEBHOOK_SECRET', config.minutesWebhookSecret, [
      ['COOKIE_SECRET', config.cookieSecret],
      ['MCP_SECRET', config.mcpSecret],
      ['DISCORD_TOKEN', config.token],
      ['DISCORD_CLIENT_SECRET', config.clientSecret],
      ['ASSEMBLYAI_API_KEY', config.assemblyaiApiKey],
      ['OPENAI_API_KEY', config.openaiApiKey],
      ['GROQ_API_KEY', config.groqApiKey],
      ['GEMINI_API_KEY', config.geminiApiKey],
      ['OPENROUTER_API_KEY', config.openrouterApiKey],
    ]);
  } catch (err) {
    console.error(`Configuração inválida: ${(err as Error).message}`);
    process.exit(1);
  }
}

if (allowLegacySharedState) {
  console.warn(
    'ALERTA: ALLOW_LEGACY_SHARED_STATE=true reduz o isolamento entre gravações, estado e autenticação; use apenas durante migração supervisionada.',
  );
}

let privateStateLayoutCommitted = false;

/**
 * Persiste a identidade e migra o layout somente quando o entrypoint já
 * validou também providers e demais configuração de runtime.
 */
export function commitPrivateStateLayout(): void {
  if (privateStateLayoutCommitted) return;
  persistPrivateStateLayout(config.cookieSecret, config.instanceId);
  privateStateLayoutCommitted = true;
}
