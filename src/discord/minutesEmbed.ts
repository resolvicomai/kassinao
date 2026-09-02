import { EmbedBuilder } from 'discord.js';
import { Locale, t } from '../i18n';
import { safeName } from '../sanitize';
import { MeetingMinutes, pageUrl, readMinutes, RecordingMeta } from '../store';
import { safeSlice } from '../util';

const MAX_DECISIONS = 5;
const MAX_ACTIONS = 8;

/** "Decisões (5 de 7)": quem lê a DM precisa saber que a lista continua na página. */
function fieldName(
  locale: Locale,
  key: 'minutes.embed-decisions' | 'minutes.embed-actions',
  shown: number,
  total: number,
): string {
  const base = t(locale, key);
  return total > shown
    ? `${base} (${t(locale, 'minutes.embed-shown', { shown: String(shown), total: String(total) })})`
    : base;
}

/** Embed com o essencial da ata (resumo + decisões + ações), truncado com folga. */
export function buildMinutesEmbed(
  meta: RecordingMeta,
  locale: Locale,
  minutes: MeetingMinutes | undefined = readMinutes(meta.id),
): EmbedBuilder[] {
  if (!minutes) return [];
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(safeSlice(`📋 ${t(locale, 'minutes.embed-title', { channel: safeName(meta.voiceChannelName) })}`, 256))
    .setURL(pageUrl(meta.id));
  if (minutes.resumo) embed.setDescription(safeSlice(safeName(minutes.resumo), 2000));
  if (minutes.decisoes.length > 0) {
    const shown = minutes.decisoes.slice(0, MAX_DECISIONS);
    embed.addFields({
      name: fieldName(locale, 'minutes.embed-decisions', shown.length, minutes.decisoes.length),
      value: safeSlice(shown.map((d) => `• ${safeName(d)}`).join('\n'), 1024),
    });
  }
  if (minutes.acoes.length > 0) {
    const shown = minutes.acoes.slice(0, MAX_ACTIONS);
    embed.addFields({
      name: fieldName(locale, 'minutes.embed-actions', shown.length, minutes.acoes.length),
      value: safeSlice(
        shown
          .map((a) => {
            const extra = [a.responsavel && safeName(a.responsavel), a.prazo && safeName(a.prazo)]
              .filter(Boolean)
              .join(' — ');
            return `☐ ${safeName(a.tarefa)}${extra ? ` *(${extra})*` : ''}`;
          })
          .join('\n'),
        1024,
      ),
    });
  }
  return [embed];
}
