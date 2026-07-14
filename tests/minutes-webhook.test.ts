import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { webhookSignature } from '../src/minutesWebhook';

describe('assinatura do webhook de atas', () => {
  it('assina timestamp e corpo com HMAC-SHA256 v1', () => {
    const secret = '0123456789abcdef0123456789abcdef';
    const timestamp = '1784044800';
    const body = JSON.stringify({ event: 'minutes.ready', recordingId: 'rec' });
    const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    expect(webhookSignature(secret, timestamp, body)).toBe(`v1=${expected}`);
  });

  it('muda quando timestamp ou payload mudam', () => {
    const secret = '0123456789abcdef0123456789abcdef';
    expect(webhookSignature(secret, '1', '{}')).not.toBe(webhookSignature(secret, '2', '{}'));
    expect(webhookSignature(secret, '1', '{}')).not.toBe(webhookSignature(secret, '1', '{"x":1}'));
  });
});
