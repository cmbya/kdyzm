import { defineConfig, normalizePath } from 'vite';
import uniModule from '@dcloudio/vite-plugin-uni';

const uni = uniModule.default || uniModule;
export default defineConfig({
  base: './',
  plugins: [uni()],
  server: { host: '127.0.0.1', port: 5176, strictPort: true, cors: { origin: /^http:\/\/(?:127\.0\.0\.1|localhost):5176$/ }, fs: { strict: true, allow: [process.cwd()] }, watch: { ignored: ['android', 'server', 'artifacts', '.codex-dev'].map(directory => `${normalizePath(process.cwd())}/${directory}/**`) } },
  build: { sourcemap: false, emptyOutDir: true }
});
