import crypto from 'node:crypto';
import fs from 'node:fs';
import { assertPublicRuntimeEnvironment, consumePublicNoDumpRuntimeEnvironment } from './publicRuntime';

// macOS injeta esta chave de locale mesmo quando o processo recebe um ambiente
// vazio. Ela não é configuração do Kassinão; removê-la mantém a allowlist
// positiva sem impedir a verificação local do mesmo entrypoint usado no Linux.
if (process.platform === 'darwin') delete process.env.__CF_USER_TEXT_ENCODING;

try {
  consumePublicNoDumpRuntimeEnvironment(process.env);
  assertPublicRuntimeEnvironment(process.env);
} catch (err) {
  console.error(`Configuração pública inválida: ${(err as Error).message}`);
  process.exit(1);
}

// `config` continua sendo a fonte de topologia dos renderizadores existentes,
// mas recebe apenas identidades sintéticas e segredos efêmeros. Nenhum deles
// autentica no Discord ou existe fora deste processo público.
const scratch = `/tmp/kassinao-public-${process.pid}`;
for (const name of ['recordings', 'state', 'auth'])
  fs.mkdirSync(`${scratch}/${name}`, { recursive: true, mode: 0o700 });
// `config` carrega dotenv por compatibilidade com o processo privado. Impedir a
// leitura do .env local mantém esta fronteira válida também fora do container.
process.env.DOTENV_CONFIG_PATH = `${scratch}/dotenv-disabled`;
process.env.DISCORD_TOKEN = 'public-surface-disabled';
process.env.APPLICATION_ID = '000000000000000001';
process.env.DISCORD_CLIENT_SECRET = 'public-surface-disabled';
process.env.ALLOWED_GUILD_IDS = '000000000000000001';
process.env.ALLOW_ALL_GUILDS = 'false';
// Renderizadores antigos recebem uma origem sintética local ao processo. A
// landing pública não conhece nem publica APP_URL/MCP_URL do operador.
process.env.APP_URL = process.env.PUBLIC_URL;
process.env.MCP_URL = process.env.PUBLIC_URL;
// O parser de produção exige identidade/política da instância privada. Este
// processo não serve essa política nem recebe os metadados do operador; usa
// valores sintéticos apenas para carregar renderizadores compartilhados. A
// rota pública /privacy continua ausente, evitando uma cópia que possa divergir.
process.env.OPERATOR_NAME = 'Public surface only';
process.env.OPERATOR_CONTACT_URL = `${process.env.PUBLIC_URL}/privacy/contact`;
process.env.PRIVACY_POLICY_URL = `${process.env.PUBLIC_URL}/privacy`;
process.env.DATA_DELETION_URL = `${process.env.PUBLIC_URL}/privacy#data-rights`;
process.env.PRIVACY_EFFECTIVE_DATE = '1970-01-01';
process.env.PRIVACY_POLICY_VERSION = 'public-surface-1';
process.env.PRIVACY_AUDIENCE = 'Synthetic value for the isolated public project surface.';
process.env.PRIVACY_PURPOSES = 'Serve the project landing page, documentation, and fictional demo.';
process.env.PRIVACY_LAWFUL_BASIS = 'Synthetic value; this process does not receive operator meeting data.';
process.env.INFRASTRUCTURE_PROVIDER = 'Isolated public project surface';
process.env.INFRASTRUCTURE_REGION = 'No operator data is processed';
process.env.EDGE_PROVIDER = 'none';
process.env.EDGE_REGION = 'none';
process.env.OPERATIONAL_LOG_RETENTION = 'Managed by the public container runtime.';
process.env.BACKUP_STATUS = 'disabled';
process.env.BACKUP_PROVIDER = 'none';
process.env.BACKUP_REGION = 'none';
process.env.BACKUP_RETENTION_DAYS = '0';
process.env.DATA_REQUEST_PROCESS = 'Not applicable to this synthetic, public-only configuration.';
process.env.DATA_REQUEST_RESPONSE_DAYS = '30';
process.env.INCIDENT_CONTACT_URL = `${process.env.PUBLIC_URL}/privacy/contact`;
process.env.INCIDENT_PROCESS = 'Public surface incidents are handled by the project operator.';
process.env.COOKIE_SECRET = crypto.randomBytes(32).toString('hex');
process.env.RECORDINGS_DIR = `${scratch}/recordings`;
process.env.STATE_DIR = `${scratch}/state`;
process.env.AUTH_STATE_DIR = `${scratch}/auth`;
process.env.MCP_SECRET = '';
process.env.TRANSCRIBE_PROVIDER = 'none';
process.env.TRANSCRIBE_FALLBACK_PROVIDER = 'none';
process.env.MINUTES_ENABLED = 'false';
process.env.PUBLIC_SURFACES_ENABLED = 'true';
process.env.ALLOW_LOCAL_APP_URL = 'true';
process.env.REPO_PUBLIC ||= 'true';

void import('./runtimeBootstrap').then(({ validateAndCommitRuntimeConfiguration }) => {
  const error = validateAndCommitRuntimeConfiguration();
  if (error) {
    console.error(`Configuração pública inválida: ${error}`);
    process.exit(1);
  }
  return import('./web/publicServer').then(({ startPublicServer }) => startPublicServer());
});
