// Copies eval/hostile/RESULTS.json and every case file it lists into demo/hostile/, byte for byte, for the /hostile page
// (the hosted demo's image copies demo/, not eval/). Run: npx tsx scripts/copy-hostile-results.ts
// test/hostile.test.ts fails when the copy and the original differ.
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOSTILE_DIR, hostileFiles } from '../src/hostile.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const source = join(ROOT, 'eval/hostile');
const results = JSON.parse(readFileSync(join(source, 'RESULTS.json'), 'utf8'));

rmSync(join(HOSTILE_DIR, 'cases'), { recursive: true, force: true });
mkdirSync(HOSTILE_DIR, { recursive: true });
copyFileSync(join(source, 'RESULTS.json'), join(HOSTILE_DIR, 'RESULTS.json'));
let n = 0;
for (const [rel, target] of hostileFiles(results)) {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(source, ...rel.split('/')), target);
  n++;
}
console.log(`copied RESULTS.json and ${n} case files into ${HOSTILE_DIR}`);
