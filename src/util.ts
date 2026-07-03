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
