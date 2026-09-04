#!/usr/bin/env node
'use strict';

// Executar numa restauração OFFLINE com o ledger MAIS RECENTE, preservado fora
// do snapshot antigo. Dry-run é padrão; nunca acessa/removerá o backup remoto.
const fs = require('node:fs');
const path = require('node:path');
process.umask(0o077);

function main(argv) {
  let ledger;
  let root;
  let apply = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--ledger') ledger = argv[++index];
    else if (arg === '--recordings-dir') root = argv[++index];
    else if (arg === '--apply') apply = true;
    else
      throw new Error(
        'Use --ledger CAMINHO --recordings-dir PASTA_RESTAURADA [--apply]. Execute com o escritor parado.',
      );
  }
  if (!ledger || !root || !path.isAbsolute(ledger) || !path.isAbsolute(root))
    throw new Error('Informe caminhos absolutos para ledger e restauração offline.');
  for (const item of [ledger, root]) {
    if (fs.realpathSync(item) !== path.resolve(item))
      throw new Error('Caminhos precisam ser canônicos, sem links simbólicos.');
  }
  const ledgerStat = fs.lstatSync(ledger);
  const rootStat = fs.lstatSync(root);
  if (!ledgerStat.isFile() || ledgerStat.nlink !== 1 || ledgerStat.size > 32 * 1024 * 1024 || !rootStat.isDirectory())
    throw new Error('Ledger ou pasta de restauração inválidos.');
  const entries = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  if (
    !Array.isArray(entries) ||
    entries.length > 100_000 ||
    entries.some(
      (entry) =>
        !entry ||
        typeof entry.recordingId !== 'string' ||
        !/^[A-Za-z0-9-]{1,255}$/.test(entry.recordingId) ||
        !['recording', 'audio'].includes(entry.kind) ||
        !Number.isFinite(entry.requestedAt) ||
        entry.requestedAt < 0,
    )
  )
    throw new Error('Ledger fora do formato esperado.');
  const targets = [];
  const audioMetas = [];
  for (const entry of entries) {
    const recording = path.join(root, entry.recordingId);
    if (!fs.existsSync(recording)) continue;
    const stat = fs.lstatSync(recording);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== rootStat.dev)
      throw new Error('Restauração contém gravação insegura ou outro filesystem.');
    const candidates =
      entry.kind === 'recording' ? [recording] : ['tracks', 'cache'].map((name) => path.join(recording, name));
    for (const candidate of candidates) if (fs.existsSync(candidate)) targets.push(candidate);
    if (entry.kind === 'audio') {
      const file = path.join(recording, 'meta.json');
      const metaStat = fs.lstatSync(file);
      if (!metaStat.isFile() || metaStat.isSymbolicLink() || metaStat.nlink !== 1 || metaStat.size > 16 * 1024 * 1024)
        throw new Error('Metadados de áudio inválidos.');
      const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!meta || meta.id !== entry.recordingId) throw new Error('Identidade divergente nos metadados.');
      audioMetas.push({ file, meta: { ...meta, audioDeleted: true } });
    }
  }
  // Validar a árvore inteira ANTES da primeira remoção; não seguir links/mounts.
  function validateTree(file) {
    const stat = fs.lstatSync(file);
    if (
      stat.isSymbolicLink() ||
      stat.dev !== rootStat.dev ||
      (!stat.isFile() && !stat.isDirectory()) ||
      (stat.isFile() && stat.nlink !== 1)
    )
      throw new Error('Restauração contém link, arquivo especial ou outro filesystem.');
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) validateTree(path.join(file, name));
  }
  for (const target of targets) validateTree(target);
  if (apply) {
    for (const target of new Set(targets)) fs.rmSync(target, { recursive: true, force: true });
    for (const { file, meta } of audioMetas) {
      const temporary = `${file}.${process.pid}.tmp`;
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(meta));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, file);
    }
  }
  // IDs/nomes não aparecem no terminal; preserve a saída como evidência operacional.
  console.log(
    JSON.stringify({
      mode: apply ? 'applied' : 'dry-run',
      ledgerEntries: entries.length,
      targets: new Set(targets).size,
    }),
  );
}

try {
  main(process.argv.slice(2));
} catch {
  console.error(
    'Reconciliação não concluída. Verifique argumentos, ledger atual e restauração offline sem links ou mounts internos.',
  );
  process.exitCode = 1;
}
