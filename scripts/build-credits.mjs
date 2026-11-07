// Generates CREDITS.md and public/CREDITS.html from assets-meta/*.json
import fs from 'node:fs';
const sf = JSON.parse(fs.readFileSync('assets-meta/sketchfab.json', 'utf8'));
const itch = JSON.parse(fs.readFileSync('assets-meta/itch.json', 'utf8'));
const LIC = {
  'quaternius': 'CC0 1.0 (Public Domain)', 'tallbeard': 'CC0 1.0 (Public Domain)', 'hamsunqiu': 'CC0 (sources: freesound.org CC0)',
  'deerwcat': 'Royalty-free, attribution optional, no standalone redistribution', 'moneywithjjcom': 'Royalty-free, no attribution required',
  'rasterloom': 'Free for commercial use, no attribution required', 'reeboolabs': 'Royalty-free, credit appreciated', 'aquumgifts': 'Free for commercial use, credit appreciated',
  'jdsherbert': 'Free pack – see LICENSE.pdf on the itch.io page', 'nicola-fabro': 'Royalty-free (not used in the build)',
};
const licFor = (url) => Object.entries(LIC).find(([k]) => url.includes(k))?.[1] ?? 'see page';
let md = '# Credits & Asset Licenses\n\nAll 3D models, sounds and music in Lumos Strike come from **Sketchfab** and **itch.io**. Code is original.\n\n';
md += '## Sketchfab models\n\n| Asset | Title | Author | License |\n|---|---|---|---|\n';
for (const [path, m] of Object.entries(sf)) md += `| \`${path}\` | [${m.title}](${m.url}) | ${m.author} (@${m.author_username}) | ${m.license} |\n`;
md += '\nCC Attribution models are used under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Models were re-encoded (Draco geometry, WebP textures) and re-scaled for the web. The two European Buildings packs were additionally split into their individual buildings and props (scripts/split-scene.mjs → public/assets/kits/euro_a.glb and euro_b.glb); their geometry and textures are otherwise unchanged.\n\n';
md += '## itch.io packs\n\n| Pack | Used for | License |\n|---|---|---|\n';
for (const [url, m] of Object.entries(itch)) {
  const t = m.title;
  const used = /animation|base character/i.test(t) ? 'characters & animations' : /music/i.test(t) ? 'music'
    : /weather/i.test(t) ? 'weather & nature ambience (thunder, rain, wind, birds, waves)' : /sound|sfx|noises/i.test(t) ? 'sound effects'
    : /cars/i.test(t) ? 'vehicles' : /gun/i.test(t) ? 'weapons & attachments' : /city|street/i.test(t) ? 'city kit' : /nature/i.test(t) ? 'trees, rocks, plants' : 'sound effects';
  md += `| [${m.title}](${url}) | ${used} | ${licFor(url)} |\n`;
}
md += '\n## Software\n\nthree.js (MIT), Rapier (Apache-2.0), Supabase JS (MIT), Vite (MIT), glTF-Transform (MIT), meshoptimizer (MIT).\n';
fs.writeFileSync('CREDITS.md', md);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lumos Strike Credits</title>
<style>body{margin:0;padding:24px;background:#0b0f14;color:#e8eef5;font:14px system-ui,sans-serif}a{color:#ffb52e}table{border-collapse:collapse;width:100%;margin:10px 0 24px}td,th{border-bottom:1px solid #223;padding:6px 8px;text-align:left}code{color:#8fd0ff}</style></head><body>
${md.split('\n').map((l) => {
  if (l.startsWith('# ')) return `<h1>${esc(l.slice(2))}</h1>`;
  if (l.startsWith('## ')) return `<h2>${esc(l.slice(3))}</h2>`;
  if (l.startsWith('|---')) return '';
  if (l.startsWith('|')) { const cells = l.split('|').slice(1, -1).map((c) => c.trim().replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>').replace(/`([^`]+)`/g, '<code>$1</code>')); return `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`; }
  return l ? `<p>${l.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')}</p>` : '';
}).join('\n').replace(/(<tr>[\s\S]*?<\/tr>\n?)+/g, (m) => `<table>${m}</table>`)}
</body></html>`;
fs.writeFileSync('public/CREDITS.html', html);
console.log('CREDITS.md / public/CREDITS.html written');
