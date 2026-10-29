'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
async function main() {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const folder = `STM32Git-v${pkg.version}-win32-x64`, dist = path.join(root, 'dist'), source = path.join(dist, folder), zip = path.join(dist, `${folder}.zip`);
  await fs.access(path.join(source, 'STM32Git.exe'));
  if (await fs.access(zip).then(() => true, () => false)) throw Error('ZIP already exists; refusing to overwrite.');
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'RELEASE-MANIFEST.json'), 'utf8'));
  const actual = [];
  async function walk(dir) { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const file = path.join(dir, e.name), rel = path.relative(source, file).replaceAll('\\', '/'); if (e.isSymbolicLink() || rel.split('/').some(p => ['data', '.git', '.test-work'].includes(p))) throw Error(`Private release entry: ${rel}`); if (e.isDirectory()) await walk(file); else actual.push(rel); } }
  await walk(source);
  const expected = new Set([...manifest.files.map(f => f.path), 'RELEASE-MANIFEST.json']);
  if (actual.length !== expected.size || actual.some(f => !expected.has(f))) throw Error('Release directory changed after packaging.');
  for (const file of manifest.files) { const b = await fs.readFile(path.join(source, file.path)); if (b.length !== file.bytes || createHash('sha256').update(b).digest('hex') !== file.sha256) throw Error(`Release hash mismatch: ${file.path}`); }
  execFileSync('tar.exe', ['-a', '-c', '-f', zip, '-C', dist, folder], { windowsHide: true, timeout: 180000 });
  const data = await fs.readFile(zip); if (data.subarray(0, 2).toString() !== 'PK') throw Error('Archive is not ZIP.');
  const entries = execFileSync('tar.exe', ['-t', '-f', zip], { windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim().split(/\r?\n/);
  if (entries.some(e => !e.startsWith(folder + '/') || /(?:^|\/)(?:data|\.git|\.test-work)(?:\/|$)/.test(e))) throw Error('Unexpected ZIP entry.');
  const sha256 = createHash('sha256').update(data).digest('hex');
  await fs.writeFile(path.join(dist, 'SHA256SUMS.txt'), `${sha256}  ${path.basename(zip)}\n`);
  console.log(JSON.stringify({ archive: path.basename(zip), bytes: data.length, sha256, entries: entries.length, containsUserData: false }));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });

