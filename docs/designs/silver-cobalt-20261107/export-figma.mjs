import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const context = vm.createContext({ window: {} });
for (const file of ['ui.js', 'pickup.js', 'settings.js']) vm.runInContext(read(file), context);
const renderer = read('app.js').split('  function renderNav(')[0] + '\nwindow.phoneHTML=phoneHTML;})();';
vm.runInContext(renderer, context);
const scenes = context.window.SCENES;
assert.equal(scenes.length, 76);
const css = read('design.css').replace("url('grain.svg')", `url('data:image/svg+xml,${encodeURIComponent(read('grain.svg'))}')`);
fs.mkdirSync(path.join(root, 'figma'), { recursive: true });
for (let start = 0; start < scenes.length; start += 20) {
  const batch = scenes.slice(start, start + 20);
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${css}\nbody{display:flex;align-items:flex-start;gap:48px;padding:48px;width:max-content}.phone{flex-shrink:0}</style><body>${batch.map(s => context.window.phoneHTML(s)).join('')}</body></html>`;
  assert.equal((html.match(/data-scene="/g) || []).length, batch.length);
  assert.ok(!/<script\b/.test(html));
  fs.writeFileSync(path.join(root, 'figma', `batch-${start / 20 + 1}.html`), html);
}
console.log('Exported 76 static Figma frames in 4 batches.');
