import { cp, mkdir, readFile, writeFile, access, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const output = path.join(root, 'android/app/src/main/assets');
const target = path.join(output, 'app');
await access(path.join(root, 'dist/build/h5/index.html'));
await mkdir(target, { recursive: true });
// This is a dedicated generated asset folder, never a source or repository root.
for (const entry of await readdir(target)) await rm(path.join(target, entry), { recursive: true, force: true });
await cp(path.join(root, 'dist/build/h5'), target, { recursive: true });
// Unused upstream download QR is excluded from the private APK; original source remains recoverable.
await rm(path.join(target, 'static/images/searchCode.png'), { force: true });
const engineSources = await Promise.all(['server/src/logistics-rules.js', 'core/pickcode-core.js'].map(file => readFile(path.join(root, file), 'utf8')));
await writeFile(path.join(output, 'pickcode-core.js'), engineSources.join('\n'), 'utf8');
console.log('Synced compiled Vue app and identical parser engine into Android assets.');
