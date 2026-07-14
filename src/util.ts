/**
 * Corta uma string em até `max` code units SEM partir um surrogate pair no
 * fim (emoji cortado ao meio derruba chamadas à API do Discord com erro 50109).
 */
export function safeSlice(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // high surrogate solto
  return cut;
}

/**
 * Erro de provedor de IA em versão HUMANA para UI (página/DM). O erro cru
 * ("HTTP 413: {json gigante da API}") vai só para o log — usuário leigo não
 * merece stack de provedor no meio da reunião.
 */
export function shortError(error: string | undefined, locale: 'pt' | 'en'): string {
  const raw = (error ?? '').trim();
  if (!raw) return locale === 'pt' ? 'erro desconhecido' : 'unknown error';
  const pt = locale === 'pt';
  if (/413|too large|request too large/i.test(raw)) {
    return pt
      ? 'a reunião é longa demais para o modelo configurado'
      : 'the meeting is too long for the configured model';
  }
  if (/429|rate limit|try again in/i.test(raw)) {
    return pt ? 'o serviço de IA está com limite de uso no momento' : 'the AI service is rate-limited right now';
  }
  if (/401|403|invalid api key|unauthorized/i.test(raw)) {
    return pt
      ? 'a chave da API foi recusada — confira a configuração'
      : 'the API key was rejected — check the configuration';
  }
  if (/timeout|timed out|a tempo|network|fetch failed|econn/i.test(raw)) {
    return pt ? 'o serviço de IA não respondeu a tempo' : 'the AI service did not respond in time';
  }
  // Mensagens desconhecidas podem conter corpo HTTP, caminho interno ou segredo.
  // O erro cru já foi registrado no servidor; a UI recebe apenas uma categoria.
  return pt ? 'o serviço de IA encontrou um erro interno' : 'the AI service encountered an internal error';
}

/** Endereço do socket é loopback real (não confia em X-Forwarded-For). */
export function isLoopbackAddress(address: string | undefined): boolean {
  return !!address && (address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.'));
}
