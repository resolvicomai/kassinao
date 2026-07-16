/**
 * Contrato positivo do processo público: qualquer variável nova é privada até
 * revisão explícita. Além da topologia pública, só entram chaves injetadas pela
 * imagem base em todos os processos. Assim não dependemos de adivinhar nomes
 * futuros como AWS_SECRET_ACCESS_KEY, DATABASE_URL ou PRIVATE_KEY.
 */
export const PUBLIC_RUNTIME_ENV = new Set([
  'NODE_ENV',
  'NODE_VERSION',
  'YARN_VERSION',
  'PYTHONDONTWRITEBYTECODE',
  'PATH',
  'HOME',
  'HOSTNAME',
  'PORT',
  'WEB_BIND_ADDRESS',
  'PUBLIC_URL',
  'DOCS_URL',
  'SOURCE_URL',
  'KASSINAO_RELEASE_DIGEST',
  'KASSINAO_DEPLOYMENT_FINGERPRINT',
  'TRUST_PROXY_HOPS',
  'REPO_PUBLIC',
  'TZ',
  'LANG',
  'LC_ALL',
  'TERM',
  'NO_COLOR',
  'FORCE_COLOR',
]);

const NO_DUMP_PRELOAD = '/usr/local/lib/libkassinao-no-dump.so';

/**
 * The production image entrypoint adds these two values after Docker has
 * created the container environment. Accept only the exact launcher contract,
 * then remove both names before applying the public-process allowlist.
 */
export function consumePublicNoDumpRuntimeEnvironment(env: NodeJS.ProcessEnv, pid: number = process.pid): void {
  const hasMarker = Object.prototype.hasOwnProperty.call(env, 'KASSINAO_NO_DUMP_ACTIVE');
  const hasPreload = Object.prototype.hasOwnProperty.call(env, 'LD_PRELOAD');
  if (!hasMarker && !hasPreload) return;
  if (
    !hasMarker ||
    !hasPreload ||
    env.KASSINAO_NO_DUMP_ACTIVE !== `prctl-v1:${pid}` ||
    env.LD_PRELOAD !== NO_DUMP_PRELOAD
  ) {
    throw new Error('A proteção no-dump do processo público está ausente ou inválida');
  }
  delete env.KASSINAO_NO_DUMP_ACTIVE;
  delete env.LD_PRELOAD;
}

export function privateRuntimeEnvironmentKeys(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([name, value]) => (name.startsWith('LD_') || Boolean(value?.trim())) && !PUBLIC_RUNTIME_ENV.has(name))
    .map(([name]) => name)
    .sort();
}

export function assertPublicRuntimeEnvironment(env: NodeJS.ProcessEnv): void {
  const leaked = privateRuntimeEnvironmentKeys(env);
  if (leaked.length > 0) {
    throw new Error(
      `O processo público recebeu configuração fora da allowlist: ${leaked.join(', ')}. ` +
        'Use um container sem env_file, segredos, guilds, providers ou volumes da instância.',
    );
  }
  for (const name of ['PUBLIC_URL', 'DOCS_URL'] as const) {
    const raw = env[name]?.trim();
    if (!raw) throw new Error(`${name} é obrigatória no processo público`);
    const url = new URL(raw);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      throw new Error(`${name} precisa usar HTTPS fora de localhost`);
    }
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
      throw new Error(`${name} precisa ser apenas uma origem, sem caminho, credenciais, query ou hash`);
    }
  }
  const rawSource = env.SOURCE_URL?.trim();
  if (!rawSource) throw new Error('SOURCE_URL é obrigatória no processo público');
  const source = new URL(rawSource);
  const sourceLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(source.hostname);
  if (source.protocol !== 'https:' && !(source.protocol === 'http:' && sourceLoopback)) {
    throw new Error('SOURCE_URL precisa usar HTTPS fora de localhost');
  }
  if (source.username || source.password || source.search || source.hash) {
    throw new Error('SOURCE_URL não pode conter credenciais, query ou hash');
  }
  if (source.pathname === '/' || source.pathname === '') {
    throw new Error('SOURCE_URL precisa apontar para o repositório correspondente');
  }
}
