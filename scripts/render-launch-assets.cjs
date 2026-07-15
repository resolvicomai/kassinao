const path = require('node:path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const PH = path.join(ROOT, 'launch-assets', 'product-hunt');
const BRAND = path.join(ROOT, 'docs', 'brand');

const C = {
  bg: '#111214',
  panel: '#1e1f22',
  panel2: '#2b2d31',
  line: '#3f4147',
  text: '#f2f3f5',
  muted: '#b5bac1',
  faint: '#80848e',
  brand: '#5865f2',
  brand2: '#7983f5',
  cyan: '#49ccf9',
  green: '#23a55a',
  yellow: '#f0b232',
};

const FONT = 'Arial, Helvetica, sans-serif';
const MONO = 'Menlo, Consolas, monospace';

function esc(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function defs() {
  return `<defs>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${C.brand}" stop-opacity=".26"/>
      <stop offset="100%" stop-color="${C.brand}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="brand" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#8790ff"/><stop offset="100%" stop-color="${C.brand}"/>
    </linearGradient>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="18" stdDeviation="24" flood-color="#000" flood-opacity=".45"/>
    </filter>
  </defs>`;
}

function shell(width, height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    ${defs()}
    <rect width="${width}" height="${height}" fill="${C.bg}"/>
    <circle cx="${Math.round(width * 0.82)}" cy="${Math.round(height * 0.15)}" r="${Math.round(height * 0.75)}" fill="url(#glow)"/>
    ${body}
  </svg>`;
}

function logo(x, y, size = 64, label = true) {
  return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${Math.round(size * 0.28)}" fill="url(#brand)"/>
    <text x="${x + size / 2}" y="${y + size * 0.68}" text-anchor="middle" font-family="${FONT}" font-size="${size * 0.43}" font-weight="800" fill="#fff">k/</text>
    ${label ? `<text x="${x + size + 18}" y="${y + size * 0.66}" font-family="${FONT}" font-size="${size * 0.43}" font-weight="760" fill="${C.text}">Kassinão</text>` : ''}`;
}

function pill(x, y, width, label, color = C.brand2) {
  return `<rect x="${x}" y="${y}" width="${width}" height="38" rx="19" fill="${C.panel}" stroke="${C.line}"/>
    <circle cx="${x + 21}" cy="${y + 19}" r="5" fill="${color}"/>
    <text x="${x + 36}" y="${y + 25}" font-family="${MONO}" font-size="13" font-weight="700" letter-spacing=".7" fill="${C.muted}">${esc(label)}</text>`;
}

function text(x, y, lines, size, lineHeight, color = C.text, weight = 760, family = FONT) {
  return `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${color}">${lines
    .map(
      (line, index) =>
        `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}"${typeof line === 'object' && line.color ? ` fill="${line.color}"` : ''}>${esc(typeof line === 'object' ? line.value : line)}</tspan>`,
    )
    .join('')}</text>`;
}

function waveform(x, y, width, color, variant = 0) {
  const patterns = [
    [18, 36, 62, 32, 80, 54, 28, 70, 44, 24, 58, 78, 40, 26, 66, 38],
    [24, 50, 30, 72, 44, 82, 36, 58, 76, 28, 46, 68, 34, 80, 52, 22],
    [32, 70, 42, 24, 60, 84, 48, 28, 74, 54, 36, 64, 22, 78, 46, 30],
  ];
  const values = patterns[variant % patterns.length];
  const gap = 6;
  const bar = (width - gap * (values.length - 1)) / values.length;
  return values
    .map(
      (h, index) =>
        `<rect x="${x + index * (bar + gap)}" y="${y - h / 2}" width="${bar}" height="${h}" rx="${bar / 2}" fill="${color}" fill-opacity="${0.92 - index * 0.018}"/>`,
    )
    .join('');
}

function track(x, y, width, initials, name, handle, color, variant) {
  return `<rect x="${x}" y="${y}" width="${width}" height="104" rx="22" fill="${C.panel}" stroke="${C.line}"/>
    <circle cx="${x + 50}" cy="${y + 52}" r="25" fill="${color}"/>
    <text x="${x + 50}" y="${y + 60}" text-anchor="middle" font-family="${FONT}" font-size="20" font-weight="800" fill="#fff">${esc(initials)}</text>
    <text x="${x + 88}" y="${y + 43}" font-family="${FONT}" font-size="20" font-weight="740" fill="${C.text}">${esc(name)}</text>
    <text x="${x + 88}" y="${y + 68}" font-family="${MONO}" font-size="13" font-weight="600" fill="${C.faint}">${esc(handle)}</text>
    ${waveform(x + 238, y + 52, width - 276, color, variant)}`;
}

function cover() {
  return shell(
    1270,
    760,
    `
    ${logo(70, 58, 64)}
    ${pill(70, 158, 260, 'SELF-HOSTED DISCORD BOT', C.green)}
    ${text(70, 250, ['Discord calls,', { value: 'captured by account.', color: C.brand2 }], 65, 70)}
    ${text(70, 414, ['Separate tracks, a mixed recording, and', 'timestamped notes. Optional AI comes later.'], 24, 35, C.muted, 500)}
    ${pill(70, 520, 188, 'AGPL OPEN SOURCE', C.brand2)}
    ${pill(272, 520, 248, 'YOUR URL · YOUR STORAGE', C.cyan)}
    <text x="70" y="691" font-family="${MONO}" font-size="15" font-weight="700" letter-spacing="1" fill="${C.faint}">INDEPENDENT PROJECT · NOT AFFILIATED WITH DISCORD</text>

    <rect x="735" y="88" width="466" height="584" rx="34" fill="${C.panel}" stroke="${C.line}" stroke-width="2" filter="url(#shadow)"/>
    <rect x="735" y="88" width="466" height="64" rx="34" fill="${C.panel2}"/>
    <circle cx="772" cy="120" r="9" fill="${C.green}"/>
    <text x="792" y="127" font-family="${FONT}" font-size="18" font-weight="750" fill="${C.text}">Product Sync · voice channel</text>
    <text x="774" y="194" font-family="${MONO}" font-size="13" font-weight="700" letter-spacing="1" fill="${C.faint}">SEPARATE DISCORD STREAMS</text>
    ${track(768, 216, 400, 'I', 'Iris', '@iris', C.brand, 0)}
    ${track(768, 338, 400, 'N', 'Noah', '@noah', C.cyan, 1)}
    ${track(768, 460, 400, 'L', 'Lina', '@lina', '#b58cff', 2)}
    <rect x="768" y="596" width="400" height="44" rx="12" fill="#17181c" stroke="${C.line}"/>
    <text x="792" y="624" font-family="${MONO}" font-size="13" font-weight="700" fill="${C.green}">3 TRACKS</text>
    <text x="1138" y="624" text-anchor="end" font-family="${MONO}" font-size="13" font-weight="700" fill="${C.muted}">+ MIX + NOTES</text>
  `,
  );
}

function tracksGallery() {
  return shell(
    1270,
    760,
    `
    ${logo(70, 54, 56)}
    ${pill(70, 144, 254, 'ACCOUNT-AWARE CAPTURE', C.cyan)}
    ${text(70, 226, ['The stream keeps', { value: 'its Discord origin.', color: C.brand2 }], 62, 68)}
    ${text(70, 378, ['One track for every Discord account that speaks.', 'The mixed recording is generated separately.'], 23, 34, C.muted, 500)}
    <rect x="70" y="494" width="530" height="116" rx="24" fill="#171a24" stroke="${C.brand}" stroke-width="2"/>
    <text x="100" y="536" font-family="${MONO}" font-size="14" font-weight="800" letter-spacing=".8" fill="${C.brand2}">WHAT THIS PROVES</text>
    <text x="100" y="574" font-family="${FONT}" font-size="22" font-weight="650" fill="${C.text}">Which Discord account supplied the stream.</text>
    <text x="70" y="675" font-family="${FONT}" font-size="17" font-weight="540" fill="${C.faint}">It does not prove which human was behind that account.</text>

    <rect x="674" y="86" width="526" height="590" rx="34" fill="${C.panel2}" stroke="${C.line}" stroke-width="2" filter="url(#shadow)"/>
    <text x="710" y="137" font-family="${MONO}" font-size="14" font-weight="800" letter-spacing="1" fill="${C.faint}">FICTIONAL MEETING · 00:48:12</text>
    ${track(706, 174, 460, 'I', 'Iris', '@iris', C.brand, 0)}
    ${track(706, 296, 460, 'N', 'Noah', '@noah', C.cyan, 1)}
    ${track(706, 418, 460, 'L', 'Lina', '@lina', '#b58cff', 2)}
    <rect x="706" y="552" width="460" height="78" rx="20" fill="${C.panel}" stroke="${C.green}" stroke-opacity=".7"/>
    <text x="734" y="583" font-family="${MONO}" font-size="13" font-weight="800" fill="${C.green}">CORE OUTPUT</text>
    <text x="734" y="611" font-family="${FONT}" font-size="18" font-weight="680" fill="${C.text}">tracks · mix · timestamped notes</text>
  `,
  );
}

function optionalGallery() {
  const tools = ['list_meetings', 'pending_actions', 'search_meetings', 'who_said', 'get_meeting'];
  return shell(
    1270,
    760,
    `
    ${logo(70, 54, 56)}
    ${pill(70, 144, 214, 'OPERATOR-CONTROLLED', C.yellow)}
    ${text(70, 226, ['AI is optional.', { value: 'Sources stay linked.', color: C.brand2 }], 62, 68)}
    ${text(70, 378, ['Choose your ASR and LLM providers, or leave them off.', 'The base recording flow does not depend on AI.'], 23, 34, C.muted, 500)}

    <rect x="70" y="486" width="524" height="158" rx="26" fill="${C.panel}" stroke="${C.line}"/>
    <text x="100" y="525" font-family="${MONO}" font-size="14" font-weight="800" fill="${C.faint}">WHEN OPTIONAL AI IS ENABLED</text>
    <text x="100" y="567" font-family="${FONT}" font-size="21" font-weight="720" fill="${C.text}">Transcript · minutes · sourced /ask</text>
    <text x="100" y="603" font-family="${FONT}" font-size="17" font-weight="520" fill="${C.muted}">Fictional demo. Answers are private and link to evidence.</text>

    <rect x="668" y="86" width="532" height="590" rx="34" fill="${C.panel2}" stroke="${C.line}" stroke-width="2" filter="url(#shadow)"/>
    <text x="706" y="136" font-family="${MONO}" font-size="14" font-weight="800" letter-spacing="1" fill="${C.green}">5 READ-ONLY MCP TOOLS</text>
    ${tools
      .map(
        (tool, index) => `
      <rect x="706" y="${166 + index * 76}" width="456" height="58" rx="15" fill="${C.panel}" stroke="${C.line}"/>
      <circle cx="731" cy="${195 + index * 76}" r="6" fill="${index < 2 ? C.brand2 : C.cyan}"/>
      <text x="751" y="${201 + index * 76}" font-family="${MONO}" font-size="17" font-weight="720" fill="${C.text}">${tool}</text>`,
      )
      .join('')}
    <rect x="706" y="566" width="456" height="78" rx="18" fill="#171a24" stroke="${C.brand}" stroke-width="2"/>
    <text x="734" y="596" font-family="${MONO}" font-size="13" font-weight="800" fill="${C.brand2}">ACCESS BOUNDARY</text>
    <text x="734" y="624" font-family="${FONT}" font-size="17" font-weight="650" fill="${C.text}">Compatible local MCP host · your instance URL</text>
  `,
  );
}

function githubPreview() {
  return shell(
    1280,
    640,
    `
    ${logo(68, 54, 66)}
    ${pill(68, 160, 242, 'AGPL · SELF-HOSTED', C.green)}
    ${text(68, 248, ['Discord calls,', { value: 'kept useful.', color: C.brand2 }], 68, 72)}
    ${text(68, 414, ['Separate tracks per speaking Discord account,', 'a mix, timestamped notes, and optional AI/MCP.'], 24, 35, C.muted, 520)}
    <text x="68" y="574" font-family="${MONO}" font-size="17" font-weight="750" fill="${C.faint}">github.com/resolvicomai/kassinao</text>

    <rect x="744" y="70" width="466" height="500" rx="34" fill="${C.panel}" stroke="${C.line}" stroke-width="2" filter="url(#shadow)"/>
    <text x="780" y="119" font-family="${MONO}" font-size="13" font-weight="800" letter-spacing="1" fill="${C.faint}">BASE INSTALLATION</text>
    ${track(776, 150, 398, 'I', 'Iris', '@iris', C.brand, 0)}
    ${track(776, 270, 398, 'N', 'Noah', '@noah', C.cyan, 1)}
    <rect x="776" y="398" width="398" height="126" rx="22" fill="#171a24" stroke="${C.brand}" stroke-opacity=".8"/>
    <text x="806" y="436" font-family="${MONO}" font-size="13" font-weight="800" fill="${C.brand2}">YOU CONTROL</text>
    <text x="806" y="472" font-family="${FONT}" font-size="20" font-weight="700" fill="${C.text}">Discord app · URL · storage</text>
    <text x="806" y="501" font-family="${FONT}" font-size="17" font-weight="520" fill="${C.muted}">retention · providers · access perimeter</text>
  `,
  );
}

function openGraphPreview() {
  return shell(
    1200,
    630,
    `
    ${logo(64, 52, 64)}
    ${pill(64, 154, 254, 'SELF-HOSTED DISCORD BOT', C.green)}
    ${text(64, 242, ['Discord calls,', { value: 'captured by account.', color: C.brand2 }], 66, 70)}
    ${text(64, 404, ['Separate tracks, a mix, and timestamped notes.', 'Transcription, AI, and MCP stay operator-controlled.'], 23, 34, C.muted, 520)}
    <rect x="754" y="78" width="382" height="474" rx="34" fill="${C.panel}" stroke="${C.line}" stroke-width="2" filter="url(#shadow)"/>
    <text x="790" y="126" font-family="${MONO}" font-size="13" font-weight="800" letter-spacing="1" fill="${C.faint}">FICTIONAL DISCORD STREAMS</text>
    ${track(786, 158, 318, 'I', 'Iris', '@iris', C.brand, 0)}
    ${track(786, 278, 318, 'N', 'Noah', '@noah', C.cyan, 1)}
    <rect x="786" y="408" width="318" height="98" rx="20" fill="#171a24" stroke="${C.green}" stroke-opacity=".75"/>
    <text x="816" y="443" font-family="${MONO}" font-size="13" font-weight="800" fill="${C.green}">BASE OUTPUT</text>
    <text x="816" y="478" font-family="${FONT}" font-size="19" font-weight="680" fill="${C.text}">tracks · mix · notes</text>
    <text x="64" y="570" font-family="${MONO}" font-size="15" font-weight="750" letter-spacing=".8" fill="${C.faint}">AGPL OPEN SOURCE · YOUR URL · YOUR STORAGE</text>
  `,
  );
}

async function save(file, svg) {
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9, palette: false }).toFile(file);
}

async function render() {
  await Promise.all([
    save(path.join(PH, 'gallery-cover-en-1270x760.png'), cover()),
    save(path.join(PH, 'gallery-02-1270x760.png'), tracksGallery()),
    save(path.join(PH, 'gallery-04-1270x760.png'), optionalGallery()),
    save(path.join(BRAND, 'github-social-preview-1280x640.png'), githubPreview()),
    save(path.join(ROOT, 'docs', 'og.png'), openGraphPreview()),
  ]);
  console.log('Rendered Product Hunt and GitHub launch assets.');
}

render().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
