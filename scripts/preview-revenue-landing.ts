import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { revenueLandingPage } from '../src/web/revenueLanding';

const rawPort = process.env.PREVIEW_PORT ?? '18082';
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`PREVIEW_PORT inválida: ${rawPort}`);
}

const root = path.resolve(__dirname, '..');
const brand = path.join(root, 'docs', 'brand');
const font = require.resolve('@fontsource-variable/archivo/files/archivo-latin-wght-normal.woff2');
const visuals = ['kassinao-revenue-hero.webp', 'kassinao-revenue-after-call.webp'] as const;

for (const required of [font, ...visuals.map((file) => path.join(brand, file))]) {
  if (!fs.existsSync(required)) throw new Error(`Asset ausente: ${required}`);
}

const app = express();
app.disable('x-powered-by');

app.get('/assets/archivo.woff2', (_req, res) => {
  res.type('font/woff2').set('Cache-Control', 'no-store').sendFile(font);
});
for (const file of visuals) {
  app.get(`/assets/${file}`, (_req, res) => {
    res.type('image/webp').set('Cache-Control', 'no-store').sendFile(path.join(brand, file));
  });
}
app.get('/og-:locale(pt|en).png', (req, res) => {
  const file = path.join(root, 'docs', `og-${req.params.locale}.png`);
  if (!fs.existsSync(file)) {
    res.status(404).end();
    return;
  }
  res.type('image/png').set('Cache-Control', 'no-store').sendFile(file);
});
app.get('/', (req, res) => {
  if (String(req.query.lang ?? '').toLowerCase() === 'en') {
    res.redirect(302, '/en');
    return;
  }
  res.set('Content-Language', 'pt-BR').type('html').send(revenueLandingPage('pt'));
});
app.get('/en', (_req, res) => {
  res.set('Content-Language', 'en').type('html').send(revenueLandingPage('en'));
});
app.get(['/demo', '/en/demo'], (_req, res) => {
  res.status(200).type('text/plain').send('Demo pública fictícia: a rota completa é servida pela aplicação Kassinão.');
});

app.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Revenue landing preview: http://127.0.0.1:${port}\n`);
});
