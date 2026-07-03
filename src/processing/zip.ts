import fs from 'node:fs';
import archiver from 'archiver';

export interface ZipEntry {
  /** Caminho do arquivo no disco. */
  path: string;
  /** Nome dentro do ZIP. */
  name: string;
}

export function createZip(entries: ZipEntry[], outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', () => resolve());
    output.on('error', reject); // erro de disco não pode virar uncaughtException
    archive.on('error', reject);
    archive.pipe(output);
    for (const entry of entries) {
      archive.file(entry.path, { name: entry.name });
    }
    archive.finalize();
  });
}
