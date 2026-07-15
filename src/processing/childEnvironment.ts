const SAFE_CHILD_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'XDG_CACHE_HOME'] as const;

const OFFICIAL_NO_DUMP_PRELOAD = '/usr/local/lib/libkassinao-no-dump.so';
const SECRET_LIKE_NAME =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASS|KEY|API_KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?|AUTH|AUTHORIZATION|COOKIE)(?:_|$)/i;
const EXECUTION_CONTROL_NAME =
  /^(?:LD_|DYLD_|NODE_OPTIONS$|NODE_PATH$|NODE_EXTRA_CA_CERTS$|BASH_ENV$|ENV$|ZDOTDIR$|IFS$|CDPATH$|SHELLOPTS$|BASHOPTS$|PROMPT_COMMAND$|PYTHONPATH$|PYTHONHOME$|PYTHONSTARTUP$|PYTHONINSPECT$|PYTHONBREAKPOINT$|PYTHONWARNINGS$|PYTHONPLATLIBDIR$|PYTHONEXECUTABLE$|RUBYOPT$|RUBYLIB$|PERL5OPT$|PERL5LIB$|JAVA_TOOL_OPTIONS$|_JAVA_OPTIONS$|JDK_JAVA_OPTIONS$|CLASSPATH$|GCONV_PATH$|LOCPATH$|NLSPATH$|GLIBC_TUNABLES$|MALLOC_|OPENSSL_CONF$|OPENSSL_CONF_INCLUDE$|OPENSSL_MODULES$|OPENSSL_ENGINES$|SSL_CERT_FILE$|SSL_CERT_DIR$|SSLKEYLOGFILE$|REQUESTS_CA_BUNDLE$|CURL_CA_BUNDLE$|CURL_HOME$|WGETRC$|NETRC$)/i;

/**
 * Ambiente mínimo para subprocessos locais. Credenciais do bot/providers não
 * atravessam por herança; o preload oficial é mantido para reaplicar
 * PR_SET_DUMPABLE depois do execve sem herdar a attestation do PID pai.
 */
export function buildSafeChildEnvironment(
  source: NodeJS.ProcessEnv,
  extraNames: readonly string[] = [],
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of SAFE_CHILD_ENV) {
    if (source[name] !== undefined) environment[name] = source[name];
  }
  for (const name of extraNames) {
    if (
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
      !SECRET_LIKE_NAME.test(name) &&
      !EXECUTION_CONTROL_NAME.test(name) &&
      source[name] !== undefined
    ) {
      environment[name] = source[name];
    }
  }
  if (source.LD_PRELOAD === OFFICIAL_NO_DUMP_PRELOAD) {
    environment.LD_PRELOAD = source.LD_PRELOAD;
  }
  return environment;
}
