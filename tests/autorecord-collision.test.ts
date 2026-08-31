import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { autoRecordStore } from '../src/recorder/autorecord';
import {
  beginCollisionEpisode,
  collisionEpisodeStart,
  collisionsLast30d,
  endCollisionEpisode,
  recordCollision,
  resetCollisionEpisodes,
} from '../src/recorder/collisionStats';

const FILE = path.join(config.stateDir, 'autorecord-collisions.json');

describe('colisões de auto-record', () => {
  beforeEach(() => {
    resetCollisionEpisodes();
    fs.rmSync(FILE, { force: true });
  });

  it('avisa uma vez por episódio, não uma vez por evento de voz', () => {
    // A sala cheia gera um evento de voz por pessoa que entra/sai. O aviso não
    // pode acompanhar esse ritmo, senão vira spam no chat.
    expect(beginCollisionEpisode('g1', 'c1')).toBe(true);
    expect(beginCollisionEpisode('g1', 'c1')).toBe(false);
    expect(beginCollisionEpisode('g1', 'c1')).toBe(false);
    // outra sala do mesmo servidor é episódio próprio
    expect(beginCollisionEpisode('g1', 'c2')).toBe(true);
  });

  it('sala esvaziar encerra o episódio, e o próximo enchimento avisa de novo', () => {
    expect(beginCollisionEpisode('g1', 'c1')).toBe(true);
    endCollisionEpisode('g1', 'c1'); // humans < minimum
    expect(beginCollisionEpisode('g1', 'c1')).toBe(true);
  });

  it('o início tardio sabe desde quando a sala esperava', () => {
    beginCollisionEpisode('g1', 'c1', 1_000);
    expect(collisionEpisodeStart('g1', 'c1')).toBe(1_000);
    endCollisionEpisode('g1', 'c1');
    expect(collisionEpisodeStart('g1', 'c1')).toBeUndefined();
  });

  it('conta colisões por servidor na janela de 30 dias', () => {
    const dia = 24 * 60 * 60 * 1000;
    const agora = 100 * dia;
    recordCollision('g1', 'c1', 'busy1', agora - 40 * dia); // fora da janela
    recordCollision('g1', 'c1', 'busy1', agora - 10 * dia);
    recordCollision('g1', 'c2', null, agora - 1 * dia);
    recordCollision('g2', 'c9', 'busy9', agora); // outro servidor não conta

    expect(collisionsLast30d('g1', agora)).toBe(2);
    const { total30d } = recordCollision('g1', 'c1', 'busy1', agora);
    expect(total30d).toBe(3);
  });

  it('sobrevive a arquivo corrompido recomeçando a estatística', () => {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, '{nem json valido');
    expect(collisionsLast30d('g1')).toBe(0);
    const { total30d } = recordCollision('g1', 'c1', null);
    expect(total30d).toBe(1);
  });

  it('remover a regra fecha o episódio na hora, sem depender de evento de voz futuro', () => {
    // Sem isso, religar a regra semanas depois encontraria o episódio velho
    // aberto e o primeiro aviso legítimo de colisão seria suprimido.
    autoRecordStore.set('g1', { channelId: 'c1', minimum: 2, createdBy: 'admin' });
    expect(beginCollisionEpisode('g1', 'c1')).toBe(true);
    autoRecordStore.remove('g1', 'c1');
    expect(collisionEpisodeStart('g1', 'c1')).toBeUndefined();
    expect(beginCollisionEpisode('g1', 'c1')).toBe(true);
  });

  it('não cresce sem limite: descarta o excedente mais antigo', () => {
    const agora = Date.now();
    for (let i = 0; i < 520; i++) recordCollision('g1', 'c1', null, agora - (520 - i) * 1000);
    const registros = JSON.parse(fs.readFileSync(FILE, 'utf8')) as unknown[];
    expect(registros.length).toBeLessThanOrEqual(500);
  });
});
