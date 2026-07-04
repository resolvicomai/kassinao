import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { formatDuration, sanitizeFilename, formatOffset } from '../recorder/RecordingSession';
import { cacheDir, RecordingMeta, tracksDir } from '../store';
import { runFfmpeg } from './ffmpeg';
import { createZip, ZipEntry } from './zip';

export type CookFormat = 'mp3' | 'flac' | 'mix' | 'audacity';

export const COOK_FORMATS: CookFormat[] = ['mp3', 'flac', 'mix', 'audacity'];

export interface CookResult {
  filePath: string;
  fileName: string;
}

const inflight = new Map<string, Promise<CookResult>>();

// No máximo 2 cozimentos simultâneos no processo inteiro: re-encodar horas de
// FLAC é caro, e sem teto um clique-frenesi na página derrubaria o VPS.
const MAX_CONCURRENT_COOKS = 2;
let activeCooks = 0;
const cookWaiters: (() => void)[] = [];

async function acquireCookSlot(): Promise<void> {
  if (activeCooks >= MAX_CONCURRENT_COOKS) {
    await new Promise<void>((resolve) => cookWaiters.push(resolve));
  }
  activeCooks++;
}

function releaseCookSlot(): void {
  activeCooks--;
  cookWaiters.shift()?.();
}

/**
 * Gera o download no formato pedido. Gravações finalizadas são cacheadas;
 * gravações ao vivo processam um snapshot do áudio até o momento — pedidos
 * simultâneos do mesmo formato compartilham o mesmo snapshot.
 */
export function cook(meta: RecordingMeta, format: CookFormat): Promise<CookResult> {
  const live = meta.status === 'recording';
  const dedupeKey = `${meta.id}:${format}${live ? ':live' : ''}`;

  const existing = inflight.get(dedupeKey);
  if (existing) return existing;

  const promise = (async () => {
    await acquireCookSlot();
    try {
      return await doCook(meta, format, live);
    } catch (err) {
      // Ao vivo o snapshot pode ter pego o último frame FLAC pela metade;
      // uma segunda tentativa copia um estado novo (e válido) do master.
      if (live) return await doCook(meta, format, live);
      throw err;
    } finally {
      releaseCookSlot();
    }
  })().finally(() => inflight.delete(dedupeKey));
  inflight.set(dedupeKey, promise);
  return promise;
}

async function doCook(meta: RecordingMeta, format: CookFormat, live: boolean): Promise<CookResult> {
  const fileName = format === 'mix' ? `kassinao-${meta.id}-mix.mp3` : `kassinao-${meta.id}-${format}.zip`;

  if (!live) {
    const cached = path.join(cacheDir(meta.id), fileName);
    if (fs.existsSync(cached)) return { filePath: cached, fileName };
  }

  // Snapshot dos masters: para gravações ao vivo os arquivos estão crescendo,
  // então copiamos o estado atual antes de processar.
  const work = path.join(cacheDir(meta.id), `work-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(work, { recursive: true });

  try {
    const sources: { name: string; flac: string }[] = [];
    const missing: typeof meta.participants = [];
    for (const p of meta.participants) {
      const master = path.join(tracksDir(meta.id), p.trackFile);
      // Faixa ausente OU vazia/corrompida (crash no meio) não pode derrubar o
      // export inteiro: pula, registra, e o info.txt/mix avisam da lacuna.
      if (!fs.existsSync(master) || fs.statSync(master).size < 128) {
        missing.push(p);
        continue;
      }
      const snapshot = path.join(work, `src-${p.index}.flac`);
      fs.copyFileSync(master, snapshot);
      try {
        // valida o snapshot (header/streams ok) antes de contar com ele
        await runFfmpeg(['-i', snapshot, '-t', '0.01', '-f', 'null', '-']);
      } catch {
        console.error(`Faixa ${p.index} (${p.name}) da gravação ${meta.id} está corrompida — excluída do export.`);
        missing.push(p);
        continue;
      }
      sources.push({ name: `${p.index}-${sanitizeFilename(p.name)}`, flac: snapshot });
    }
    if (sources.length === 0) throw new Error('nenhuma faixa de áudio utilizável nesta gravação');
    if (missing.length > 0) {
      console.warn(
        `Gravação ${meta.id}: ${missing.length} faixa(s) fora do export (${missing.map((p) => p.name).join(', ')}).`,
      );
    }

    let outPath: string;
    if (format === 'mix') {
      outPath = path.join(work, fileName);
      await cookMix(
        sources.map((s) => s.flac),
        outPath,
      );
    } else {
      const entries: ZipEntry[] = [];
      for (const src of sources) {
        if (format === 'flac' || format === 'audacity') {
          // Re-mux para um FLAC "limpo" (com header/duração corretos, importante nos snapshots ao vivo)
          const out = path.join(work, `${src.name}.flac`);
          await runFfmpeg(['-i', src.flac, '-c:a', 'flac', '-y', out]);
          entries.push({ path: out, name: `${src.name}.flac` });
        } else {
          const out = path.join(work, `${src.name}.mp3`);
          await runFfmpeg(['-i', src.flac, '-codec:a', 'libmp3lame', '-b:a', config.mp3Bitrate, '-y', out]);
          entries.push({ path: out, name: `${src.name}.mp3` });
        }
      }

      if (format === 'audacity') {
        // .lof: abrir no Audacity carrega todas as faixas já alinhadas.
        const lofPath = path.join(work, 'projeto.lof');
        fs.writeFileSync(lofPath, sources.map((s) => `file "${s.name}.flac" offset 0.000000\n`).join(''));
        entries.push({ path: lofPath, name: 'projeto.lof' });

        if (meta.notes.length > 0) {
          // labels padrão do Audacity: início<TAB>fim<TAB>texto (File > Import > Labels)
          const labelsPath = path.join(work, 'notas-labels.txt');
          fs.writeFileSync(
            labelsPath,
            meta.notes
              .map((n) => {
                const t = (n.atMs / 1000).toFixed(6);
                // sanitiza autor+texto juntos: tab/quebra no displayName corromperia o TSV
                const label = `${n.author}: ${n.text}`.replace(/[\r\n\t]+/g, ' ');
                return `${t}\t${t}\t${label}\n`;
              })
              .join(''),
          );
          entries.push({ path: labelsPath, name: 'notas-labels.txt' });
        }

        const readmePath = path.join(work, 'LEIA-ME.txt');
        fs.writeFileSync(
          readmePath,
          [
            'Projeto Audacity — Kassinão 🎙️',
            '',
            '1. Extraia este ZIP inteiro para uma pasta.',
            '2. No Audacity: File > Open... > escolha "projeto.lof".',
            '   Todas as faixas abrem alinhadas na mesma linha do tempo.',
            meta.notes.length > 0 ? '3. Para as notas: File > Import > Labels... > "notas-labels.txt".' : '',
            '',
            '(EN) 1. Extract this whole ZIP. 2. In Audacity: File > Open... > "projeto.lof".',
            meta.notes.length > 0 ? '(EN) 3. Notes: File > Import > Labels... > "notas-labels.txt".' : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
        entries.push({ path: readmePath, name: 'LEIA-ME.txt' });
      }

      const infoPath = path.join(work, 'info.txt');
      fs.writeFileSync(infoPath, buildInfoText(meta, live, missing));
      entries.push({ path: infoPath, name: 'info.txt' });

      outPath = path.join(work, fileName);
      await createZip(entries, outPath);
    }

    if (live) {
      // Sem cache (o conteúdo muda a cada segundo). O diretório de trabalho é
      // apagado com atraso: respostas concorrentes podem estar streamando o
      // mesmo arquivo, então não dá para remover no fim do primeiro envio.
      setTimeout(() => fs.rmSync(work, { recursive: true, force: true }), 15 * 60 * 1000).unref();
      return { filePath: outPath, fileName };
    }

    const finalPath = path.join(cacheDir(meta.id), fileName);
    fs.renameSync(outPath, finalPath);
    fs.rmSync(work, { recursive: true, force: true });
    return { filePath: finalPath, fileName };
  } catch (err) {
    fs.rmSync(work, { recursive: true, force: true });
    throw err;
  }
}

/** Mixa todas as faixas em um MP3 único (soma sem atenuação + limiter contra clipping). */
async function cookMix(flacs: string[], outPath: string): Promise<void> {
  const args: string[] = [];
  for (const f of flacs) args.push('-i', f);
  if (flacs.length === 1) {
    args.push('-codec:a', 'libmp3lame', '-b:a', config.mp3Bitrate, '-y', outPath);
  } else {
    args.push(
      '-filter_complex',
      // level=false: sem ele o alimiter re-normaliza o sinal para 0 dBFS e anula o headroom
      `amix=inputs=${flacs.length}:duration=longest:normalize=0,alimiter=limit=0.9:level=false`,
      '-codec:a',
      'libmp3lame',
      '-b:a',
      config.mp3Bitrate,
      '-y',
      outPath,
    );
  }
  await runFfmpeg(args);
}

function buildInfoText(meta: RecordingMeta, live: boolean, missing: { index: number; name: string }[] = []): string {
  const endedAt = meta.endedAt ?? Date.now();
  const missingIdx = new Set(missing.map((m) => m.index));
  const lines = [
    'Gravação do Kassinão 🎙️',
    '',
    `ID:            ${meta.id}`,
    `Servidor:      ${meta.guildName}`,
    `Canal de voz:  ${meta.voiceChannelName}`,
    `Início:        ${new Date(meta.startedAt).toISOString()}`,
    live
      ? 'Fim:           (gravação ainda em andamento — download parcial)'
      : `Fim:           ${new Date(endedAt).toISOString()}`,
    `Duração:       ${formatDuration(endedAt - meta.startedAt)}`,
    '',
    'Participantes:',
    ...meta.participants.map(
      (p) =>
        `  ${p.index}. ${p.name}${missingIdx.has(p.index) ? '  (faixa indisponível — NÃO incluída neste arquivo)' : ''}`,
    ),
    '',
    ...(meta.notes.length > 0
      ? ['Notas:', ...meta.notes.map((n) => `  [${formatOffset(n.atMs)}] ${n.author}: ${n.text}`), '']
      : []),
    'Eventos:',
    ...meta.events.map((e) => `  [${formatOffset(e.atMs)}] ${e.text}`),
    '',
    missingIdx.size === 0
      ? 'Todas as faixas têm a mesma linha do tempo e estão sincronizadas entre si:\nbasta alinhá-las no início em qualquer editor de áudio.'
      : 'ATENÇÃO: uma ou mais faixas ficaram indisponíveis e NÃO estão neste arquivo\n(nem no mix). As faixas presentes continuam sincronizadas entre si.',
  ];
  return lines.join('\n');
}
