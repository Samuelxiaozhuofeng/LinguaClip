// Runs the browser regression flows (dev/e2e/README.md): node dev/e2e/run.mjs
// The server, the browser and the helpers every flow gets come from lib.mjs.
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open, SAMPLE } from './lib.mjs';
import practice from './practice.mjs';
import watch from './watch.mjs';
import persist from './persist.mjs';
import backup from './backup.mjs';

const OUT = mkdtempSync(path.join(os.tmpdir(), 'linguaclip-e2e-'));
const FLOWS = [...practice, ...watch, ...persist, ...backup];

for (const f of [`${SAMPLE}.mp4`, `${SAMPLE}.srt`]) {
  if (!existsSync(f)) { console.error(`缺样片：${f}`); process.exit(1); }
}

const results = [];
let ctx;
try {
  ctx = await open(OUT);
  const { page, errors: pageErrors } = ctx;
  let broken = null;
  for (const [i, flow] of FLOWS.entries()) {
    const name = `${i + 1}. ${flow.name}`;
    if (broken) { results.push({ name, status: 'SKIP', note: `前面「${broken}」失败，这步依赖它` }); continue; }
    process.stdout.write(`… ${name}\n`);
    try {
      await flow.run(ctx);
      results.push({ name, status: 'PASS' });
    } catch (e) {
      const shot = path.join(OUT, `fail-${i + 1}.png`);
      await page.screenshot({ path: shot }).catch(() => {});
      results.push({ name, status: 'FAIL', note: `${String(e.message ?? e).split('\n')[0]}\n     截图：${shot}` });
      broken = flow.name;
    }
  }
  if (pageErrors.length) console.log(`\n页面报错（${pageErrors.length}）：\n  ${pageErrors.slice(0, 5).join('\n  ')}`);
} catch (e) {
  results.push({ name: '启动 dev 服务 / 浏览器', status: 'FAIL', note: String(e.message ?? e) });
} finally {
  await ctx?.close();
}

console.log('\n结果：');
for (const r of results) console.log(`  ${r.status.padEnd(4)}  ${r.name}${r.note ? `\n     ${r.note}` : ''}`);
const bad = results.filter(r => r.status !== 'PASS').length;
console.log(bad ? `\n${bad} 项没过（输出目录 ${OUT}）` : `\n全部通过（${results.length} 项）`);
process.exit(bad ? 1 : 0);
