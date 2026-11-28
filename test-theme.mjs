// Light / dark tokens (utils/theme.ts, index.css): light must stay pixel-identical to the
// original palette, dark must define every token, and the pre-paint boot script must be
// the same file in both public/ dirs.
import fs from 'fs';
import assert from 'assert/strict';

const css = fs.readFileSync('index.css', 'utf8');
const block = sel => {
  const m = css.match(new RegExp(`(^|\\n)${sel.replace('.', '\\.')} \\{([^}]*)\\}`));
  assert.ok(m, `index.css 缺少 ${sel}`);
  return Object.fromEntries([...m[2].matchAll(/--(c-[\w-]+):\s*([\d ]+);/g)].map(x => [x[1], x[2].trim()]));
};
const light = block(':root');
const dark = block('html.dark');

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(' ');
const ORIGINAL = {
  paper: '#FAFAFA', page: '#FFFFFF', shade: '#F4F4F3', line: '#E7E5E4', faint: '#D6D3D1',
  mute: '#78716C', ink: '#1C1917', inverse: '#FFFFFF', accent: '#E8492B', 'accent-soft': '#FDECE8',
};
for (const [k, hex] of Object.entries(ORIGINAL)) {
  assert.equal(light[`c-${k}`], rgb(hex), `浅色 --c-${k} 变了`);
  assert.ok(dark[`c-${k}`], `深色缺 --c-${k}`);
}
assert.equal(Object.keys(dark).length, Object.keys(light).length, '深色 / 浅色令牌数量不一致');

const tw = fs.readFileSync('tailwind.config.js', 'utf8');
for (const k of Object.keys(ORIGINAL)) {
  assert.ok(tw.includes(`rgb(var(--c-${k}) / <alpha-value>)`), `tailwind 颜色 ${k} 没走变量`);
}
assert.ok(/darkMode:\s*'class'/.test(tw), "tailwind 要 darkMode: 'class'");

assert.equal(fs.readFileSync('public/theme-boot.js', 'utf8'), fs.readFileSync('mobile/public/theme-boot.js', 'utf8'), 'theme-boot.js 两份不一致');

console.log('theme ok');
