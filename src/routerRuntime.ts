import { consumePublicNoDumpRuntimeEnvironment } from './publicRuntime';

const ROUTER_RUNTIME_ENV = new Set([
  'NODE_ENV',
  'NODE_VERSION',
  'YARN_VERSION',
  'PYTHONDONTWRITEBYTECODE',
  'PATH',
  'HOME',
  'HOSTNAME',
  'PORT',
  'WEB_BIND_INTERFACE',
  'WEB_HOST_BIND_INTERFACE',
  'APP_URL',
  'PUBLIC_URL',
  'DOCS_URL',
  'MCP_URL',
  'KASSINAO_RELEASE_DIGEST',
  'KASSINAO_DEPLOYMENT_FINGERPRINT',
  'TZ',
  'LANG',
  'LC_ALL',
  'TERM',
  'NO_COLOR',
  'FORCE_COLOR',
]);

export interface RouterRuntimeConfiguration {
  port: number;
  bindInterfaces: readonly [string, string];
  origins: {
    app: string;
    public: string;
    docs: string;
    mcp: string;
  };
  releaseDigest?: string;
  deploymentFingerprint?: string;
}

function privateRouterEnvironmentKeys(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([name, value]) => (name.startsWith('LD_') || Boolean(value?.trim())) && !ROUTER_RUNTIME_ENV.has(name))
    .map(([name]) => name)
    .sort();
}

function requiredValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} é obrigatória no router`);
  return value;
}

function exactOrigin(env: NodeJS.ProcessEnv, name: string): string {
  const raw = requiredValue(env, name);
  const url = new URL(raw);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`${name} precisa usar HTTPS fora de localhost`);
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error(`${name} precisa ser apenas uma origem, sem caminho, credenciais, query ou hash`);
  }
  return url.origin;
}

function optionalFingerprint(env: NodeJS.ProcessEnv, name: string, pattern: RegExp): string | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  if (!pattern.test(raw)) throw new Error(`${name} tem formato inválido`);
  return raw;
}

function bindInterface(env: NodeJS.ProcessEnv, name: string): string {
  const value = requiredValue(env, name);
  if (!/^[A-Za-z0-9_.-]{1,15}$/.test(value)) {
    throw new Error(`${name} precisa ser um nome de interface Linux válido`);
  }
  return value;
}

/**
 * Consome o marcador efêmero do launcher e valida o ambiente antes de importar
 * qualquer módulo do processo privado. Nomes desconhecidos são reportados sem
 * jamais incluir seus valores.
 */
export function readRouterRuntimeConfiguration(
  env: NodeJS.ProcessEnv,
  pid: number = process.pid,
): RouterRuntimeConfiguration {
  consumePublicNoDumpRuntimeEnvironment(env, pid);
  const leaked = privateRouterEnvironmentKeys(env);
  if (leaked.length > 0) {
    throw new Error(
      `O router recebeu configuração fora da allowlist: ${leaked.join(', ')}. ` +
        'Use um container sem env_file, segredos, guilds, providers ou volumes da instância.',
    );
  }
  if (env.NODE_ENV !== 'production') throw new Error('NODE_ENV precisa ser production no router');

  const rawPort = requiredValue(env, 'PORT');
  if (!/^[1-9][0-9]{0,4}$/.test(rawPort)) throw new Error('PORT precisa ser um inteiro entre 1 e 65535');
  const port = Number(rawPort);
  if (port > 65535) throw new Error('PORT precisa ser um inteiro entre 1 e 65535');

  const edgeBindInterface = bindInterface(env, 'WEB_BIND_INTERFACE');
  const hostBindInterface = bindInterface(env, 'WEB_HOST_BIND_INTERFACE');
  if (edgeBindInterface === hostBindInterface) {
    throw new Error('WEB_BIND_INTERFACE e WEB_HOST_BIND_INTERFACE precisam ser distintas');
  }

  return {
    port,
    bindInterfaces: [edgeBindInterface, hostBindInterface],
    origins: {
      app: exactOrigin(env, 'APP_URL'),
      public: exactOrigin(env, 'PUBLIC_URL'),
      docs: exactOrigin(env, 'DOCS_URL'),
      mcp: exactOrigin(env, 'MCP_URL'),
    },
    releaseDigest: optionalFingerprint(env, 'KASSINAO_RELEASE_DIGEST', /^sha256:[0-9a-f]{64}$/),
    deploymentFingerprint: optionalFingerprint(env, 'KASSINAO_DEPLOYMENT_FINGERPRINT', /^[0-9a-f]{32,128}$/),
  };
}
