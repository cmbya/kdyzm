import { defineConfig } from 'vite';
import uniModule from '@dcloudio/vite-plugin-uni';

const uni = uniModule.default || uniModule;
export default defineConfig({
  base: './',
  plugins: [uni()],
  server: { host: '127.0.0.1', port: 5176, strictPort: true, watch: { ignored: ['**/android/**', '**/server/**', '**/artifacts/**', '**/.codex-dev/**'] } },
  build: { sourcemap: false, emptyOutDir: true }
});
