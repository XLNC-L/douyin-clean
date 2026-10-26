/* 扩展静态校验：CI 与本地都能跑（node scripts/check.mjs）
 * 检查项：
 *   1) manifest.json 是合法 JSON、MV3、版本号是 x.y.z；
 *   2) manifest 引用的图标 / popup / 内容脚本 / CSS 文件全部存在；
 *   3) js/core.js 的 VER 与 manifest.version 一致；
 *   4) CHANGELOG.md 与 .github/release-notes.md 都包含当前版本；
 *   5) 所有 JS 文件能通过 node --check；
 *   6) 没有 MV3 禁止的 eval / new Function，popup 不加载远程脚本；
 *   7) 内容脚本顺序：defaults.js 在 settings.js 之前，settings.js 在功能模块之前。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = process.cwd();
const fail = [];
const ok = [];

const read = p => readFileSync(resolve(root, p), 'utf8');
const exists = p => existsSync(resolve(root, p));
const pass = msg => ok.push(msg);
const bad = msg => fail.push(msg);

let manifest;
try {
  manifest = JSON.parse(read('manifest.json'));
} catch (e) {
  console.error('manifest.json 解析失败：' + e.message);
  process.exit(1);
}

// 1) 基础字段
if (manifest.manifest_version !== 3) bad('manifest_version 必须是 3');
else pass('MV3');

if (!/^\d+\.\d+\.\d+$/.test(manifest.version || '')) bad('version 必须是 x.y.z：' + manifest.version);
else pass('version ' + manifest.version);

for (const key of ['name', 'description', 'icons', 'action', 'content_scripts']) {
  if (!manifest[key]) bad('manifest 缺少字段：' + key);
}

// 2) 文件引用
const refs = new Set();
Object.values(manifest.icons || {}).forEach(p => refs.add(p));
Object.values(manifest.action?.default_icon || {}).forEach(p => refs.add(p));
if (manifest.action?.default_popup) refs.add(manifest.action.default_popup);
for (const cs of manifest.content_scripts || []) {
  (cs.js || []).forEach(p => refs.add(p));
  (cs.css || []).forEach(p => refs.add(p));
}
for (const p of refs) {
  if (!exists(p)) bad('manifest 引用的文件不存在：' + p);
}
if (refs.size) pass('manifest 引用文件 ' + refs.size + ' 个');

// popup.html 里的本地资源
if (exists('popup.html')) {
  const html = read('popup.html');
  const attrs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]);
  for (const p of attrs) {
    if (/^https?:/i.test(p)) bad('popup.html 引用了远程资源：' + p);
    else if (!exists(p)) bad('popup.html 引用的文件不存在：' + p);
  }
  pass('popup.html 本地资源');
}

// README 里引用的本地图片（Release 包会带上 docs）
if (exists('README.md')) {
  const md = read('README.md');
  const imgs = [...md.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map(m => m[1]);
  for (const p of imgs) {
    if (/^https?:/i.test(p)) continue;
    if (!exists(p)) bad('README.md 引用的图片不存在：' + p);
  }
  pass('README 本地图片 ' + imgs.filter(p => !/^https?:/i.test(p)).length + ' 个');
}

// 3) core VER 与 manifest 对齐
if (exists('js/core.js')) {
  const m = read('js/core.js').match(/VER:\s*'([^']+)'/);
  if (!m) bad('js/core.js 找不到 VER');
  else if (m[1] !== manifest.version) bad(`js/core.js VER=${m[1]} 与 manifest.version=${manifest.version} 不一致`);
  else pass('core VER 一致');
}

// 4) CHANGELOG / release-notes
if (exists('CHANGELOG.md')) {
  if (!read('CHANGELOG.md').includes(`## [${manifest.version}]`)) {
    bad('CHANGELOG.md 缺少 ' + manifest.version + ' 的小节');
  } else pass('CHANGELOG 已记录');
}
if (exists('.github/release-notes.md')) {
  if (!read('.github/release-notes.md').includes('v' + manifest.version)) {
    bad('.github/release-notes.md 没有提到 v' + manifest.version);
  } else pass('release-notes 版本一致');
}

// 5) JS 语法
const jsFiles = new Set([
  ...(manifest.content_scripts || []).flatMap(cs => cs.js || []),
  ...(exists('popup.html')
    ? [...read('popup.html').matchAll(/<script src="([^"]+)"/g)].map(m => m[1])
    : [])
]);
if (exists('js')) {
  for (const f of readdirSync(resolve(root, 'js'))) {
    if (f.endsWith('.js')) jsFiles.add('js/' + f);
  }
}
for (const f of jsFiles) {
  if (!exists(f)) continue;
  try {
    execFileSync(process.execPath, ['--check', resolve(root, f)], { stdio: 'pipe' });
  } catch (e) {
    bad('JS 语法错误：' + f + '\n' + String(e.stderr || e.message));
  }
}
pass('JS 语法检查 ' + jsFiles.size + ' 个文件');

// 6) MV3 安全红线
for (const f of jsFiles) {
  if (!exists(f)) continue;
  const src = read(f);
  if (/\beval\s*\(|new\s+Function\s*\(/.test(src)) bad('发现 eval / new Function：' + f);
}
pass('无 eval / new Function');

// 7) 内容脚本顺序
const cs = (manifest.content_scripts || [])[0];
if (cs && Array.isArray(cs.js)) {
  const iDefaults = cs.js.indexOf('js/defaults.js');
  const iSettings = cs.js.indexOf('js/settings.js');
  const iMain = cs.js.indexOf('js/main.js');
  if (iDefaults < 0 || iSettings < 0) bad('内容脚本缺少 defaults.js / settings.js');
  else if (iDefaults > iSettings) bad('defaults.js 必须排在 settings.js 之前');
  else if (iSettings > iMain) bad('settings.js 必须排在 main.js 之前');
  else pass('内容脚本顺序正确');
}

if (fail.length) {
  console.error('\n✗ 校验失败：');
  for (const m of fail) console.error('  - ' + m);
  process.exit(1);
}

console.log('✓ 全部通过');
for (const m of ok) console.log('  · ' + m);
