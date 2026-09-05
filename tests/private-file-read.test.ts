import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { readPrivateFileBounded } from '../src/stateFile';

// Exercise the standalone recovery reader too, without running a recovery command.
const sandbox = vm.createContext({
  require: (name: string) => (name === 'node:fs' ? fs : path),
  process: { argv: [], platform: process.platform, umask: () => undefined },
  console: { error: () => undefined },
  Buffer,
});
vm.runInContext(fs.readFileSync(path.resolve('scripts/reconcile-restored-deletions.cjs'), 'utf8'), sandbox);
const readers = [
  ['shared', readPrivateFileBounded],
  ['standalone', sandbox.readPrivateFileBounded as typeof readPrivateFileBounded],
] as const;
const directories: string[] = [];
const fixture = (text = '{}') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-reader-'));
  directories.push(dir);
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, text);
  return { dir, file };
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it.each(readers)('%s allocates the snapshot size and closes a successful read', (_name, read) => {
  const { file } = fixture();
  const allocate = vi.spyOn(Buffer, 'allocUnsafe');
  const open = vi.spyOn(fs, 'openSync');
  expect(read(file, 128 * 1024 * 1024)).toBe('{}');
  expect(allocate).toHaveBeenCalledWith(3);
  expect(allocate).not.toHaveBeenCalledWith(128 * 1024 * 1024 + 1);
  expect(() => fs.fstatSync(open.mock.results[0].value)).toThrow();
});

it.each(readers)('%s rejects linked, oversized and nonregular inputs', (_name, read) => {
  const { dir, file } = fixture();
  expect(() => read(file, 1)).toThrow();
  expect(() => read(dir, 10)).toThrow();
  const hardlink = path.join(dir, 'hardlink');
  fs.linkSync(file, hardlink);
  expect(() => read(file, 10)).toThrow();
  fs.unlinkSync(hardlink);
  if (process.platform !== 'win32') {
    const symlink = path.join(dir, 'symlink');
    fs.symlinkSync(file, symlink);
    expect(() => read(symlink, 10)).toThrow();
    fs.unlinkSync(file);
    expect(() => read(symlink, 10)).toThrow(); // A dangling link must not become ENOENT/default state.
    const fifo = path.join(dir, 'fifo');
    execFileSync('mkfifo', [fifo]);
    expect(() => read(fifo, 10)).toThrow();
  }
});

it.each(readers)('%s keeps the checked inode when its pathname is replaced', (_name, read) => {
  const { dir, file } = fixture('original');
  const replacement = path.join(dir, 'replacement');
  fs.writeFileSync(replacement, 'different');
  const stat = fs.fstatSync;
  vi.spyOn(fs, 'fstatSync').mockImplementationOnce((fd) => {
    const opened = stat(fd);
    fs.renameSync(file, path.join(dir, 'old-inode'));
    fs.renameSync(replacement, file);
    return opened;
  });
  expect(read(file, 100)).toBe('original');
  expect(fs.readFileSync(file, 'utf8')).toBe('different');
});

it.each(readers)('%s bounds growth after fstat and closes on rejection or read failure', (_name, read) => {
  const { file } = fixture();
  const stat = fs.fstatSync;
  const open = vi.spyOn(fs, 'openSync');
  vi.spyOn(fs, 'fstatSync').mockImplementationOnce((fd) => {
    const opened = stat(fd);
    fs.appendFileSync(file, ' '.repeat(200));
    return opened;
  });
  expect(() => read(file, 10)).toThrow('changed during read');
  expect(() => stat(open.mock.results[0].value)).toThrow();
  vi.restoreAllMocks();
  fs.writeFileSync(file, '{}');
  const secondOpen = vi.spyOn(fs, 'openSync');
  vi.spyOn(fs, 'readSync').mockImplementationOnce(() => {
    throw new Error('synthetic read failure');
  });
  expect(() => read(file, 10)).toThrow('synthetic read failure');
  expect(() => stat(secondOpen.mock.results[0].value)).toThrow();
});
