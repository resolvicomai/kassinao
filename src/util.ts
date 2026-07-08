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
 * Decide se a ata pode ir pro canal CONFIGURADO (/config ata-canal), cuja audiência
 * pode exceder quem tem acesso à gravação. Regra, em ordem:
 *  1. checagem AO VIVO do canal de voz de origem venceu sempre que existe (permissões
 *     podem ter apertado depois da call — respeita o estado atual);
 *  2. canal DELETADO (efêmero): vale o snapshot tirado no início da gravação
 *     (audiência do consentimento) — metas antigos sem snapshot ficam restritos;
 *  3. indeterminado (erro transitório, guild fora do cache): fail-closed.
 */
export function allowMinutesBroadcast(opts: {
  /** ViewChannel de @everyone no canal de voz AGORA; undefined = canal não avaliável. */
  liveEveryoneViewable?: boolean;
  /** true só quando o Discord confirmou que o canal não existe mais (10003). */
  channelDeleted: boolean;
  /** Snapshot persistido no meta no início da gravação (undefined em metas antigos). */
  snapshotEveryoneViewable?: boolean;
}): boolean {
  if (opts.liveEveryoneViewable !== undefined) return opts.liveEveryoneViewable;
  if (opts.channelDeleted) return opts.snapshotEveryoneViewable === true;
  return false;
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
  // desconhecido: corta no primeiro '{' (fora o JSON do provedor) e limita o tamanho
  const cut = raw
    .split('{')[0]
    .trim()
    .replace(/[:—-]\s*$/, '');
  return safeSlice(cut || raw, 140);
}
