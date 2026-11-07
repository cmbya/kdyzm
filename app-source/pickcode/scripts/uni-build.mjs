import { spawn } from 'node:child_process';
import path from 'node:path';
const mode = process.argv[2] || 'build';
const root = process.cwd();
const args = mode === 'build' ? ['build', '-p', 'h5'] : ['-p', 'h5'];
const child = spawn(process.execPath, ['node_modules/@dcloudio/vite-plugin-uni/bin/uni.js', ...args], {
  stdio: 'inherit',
  env: { ...process.env, UNI_INPUT_DIR: root, UNI_OUTPUT_DIR: path.join(root, 'dist', mode === 'build' ? 'build' : 'dev', 'h5') }
});
child.on('exit', code => { process.exitCode = code || 0; });
