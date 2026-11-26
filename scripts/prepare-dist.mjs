import fs from 'node:fs';
import path from 'node:path';

const outDir = path.resolve('out');
const distDir = path.resolve('dist');

if (!fs.existsSync(outDir)) {
  throw new Error('Direktori hasil ekspor Next.js (out/) tidak ditemukan.');
}

fs.rmSync(distDir, { recursive: true, force: true });
fs.cpSync(outDir, distDir, { recursive: true });

const headersFile = path.join(distDir, '_headers');
if (!fs.existsSync(headersFile)) {
  throw new Error('Berkas keamanan dist/_headers tidak ditemukan setelah ekspor.');
}
