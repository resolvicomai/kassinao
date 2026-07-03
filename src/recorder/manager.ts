import { RecordingSession } from './RecordingSession';

/** Uma gravação ativa por servidor. */
const sessions = new Map<string, RecordingSession>();

export const sessionManager = {
  get(guildId: string): RecordingSession | undefined {
    return sessions.get(guildId);
  },
  set(guildId: string, session: RecordingSession): void {
    sessions.set(guildId, session);
  },
  delete(guildId: string): void {
    sessions.delete(guildId);
  },
  count(): number {
    return sessions.size;
  },
  all(): RecordingSession[] {
    return [...sessions.values()];
  },
};
