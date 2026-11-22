// Copies the MediaPipe WASM runtime out of node_modules into public/ so the
// app never depends on an external CDN (school networks often block them).
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const dst = resolve(root, 'public/mediapipe/wasm');

if (!existsSync(src)) {
  console.error('找不到 @mediapipe/tasks-vision，請先執行 npm install');
  process.exit(1);
}
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log('MediaPipe WASM 已複製到 public/mediapipe/wasm');
