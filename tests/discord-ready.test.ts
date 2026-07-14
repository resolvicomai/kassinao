import { EventEmitter } from 'node:events';
import { Events, type Client } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { isClientReady, observeClientReadiness } from '../src/discord/ready';

describe('prontidão reversível do gateway', () => {
  it('nega durante reconnect e só reabre quando todos os shards voltam', () => {
    const gateway = new EventEmitter();
    observeClientReadiness(gateway as unknown as Client);

    gateway.emit(Events.ShardReady, 0, undefined);
    expect(isClientReady()).toBe(false);

    gateway.emit(Events.ClientReady, gateway);
    expect(isClientReady()).toBe(true);

    gateway.emit(Events.ShardReconnecting, 0);
    gateway.emit(Events.ShardReconnecting, 1);
    expect(isClientReady()).toBe(false);

    gateway.emit(Events.ShardResume, 0, 3);
    expect(isClientReady()).toBe(false);

    gateway.emit(Events.ShardReady, 1, undefined);
    expect(isClientReady()).toBe(true);

    gateway.emit(Events.Invalidated);
    expect(isClientReady()).toBe(false);
  });
});
