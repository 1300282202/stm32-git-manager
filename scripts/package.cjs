'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('This package currently targets Windows x64.');
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const folder = `STM32Git-v${pkg.version}-win32-x64`, output = path.join(root, 'dist', folder);
  const electron = path.join(root, 'node_modules/electron/dist');
  await fs.access(path.join(electron, 'electron.exe'));
  await fs.mkdir(path.join(root, 'dist'), { recursive: true });
  await fs.mkdir(output); // A fresh directory is required; never merge user data into a release.
  await fs.cp(electron, output, { recursive: true, filter: file => file !== path.join(electron, 'electron.exe') });
  await fs.copyFile(path.join(electron, 'electron.exe'), path.join(output, 'STM32Git.exe'));
  const payload = path.join(output, 'resources/app'); await fs.mkdir(payload, { recursive: true });
  const { name, version, description, main, license, repository } = pkg;
  await fs.writeFile(path.join(payload, 'package.json'), JSON.stringify({ name, version, description, main, license, repository }, null, 2) + '\n');
  await fs.cp(path.join(root, 'src'), path.join(payload, 'src'), { recursive: true });
  const copied = new Set();
  async function copyDependency(name) {
    if (copied.has(name)) return; copied.add(name);
    const source = path.join(root, 'node_modules', name), target = path.join(payload, 'node_modules', name);
    const info = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.cp(source, target, { recursive: true });
    for (const child of Object.keys(info.dependencies || {})) await copyDependency(child);
  }
  await copyDependency('fast-xml-parser');
  for (const file of ['CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'THIRD-PARTY-NOTICES.md']) await fs.copyFile(path.join(root, file), path.join(output, file));
  await fs.writeFile(path.join(output, 'README.md'), (await fs.readFile(path.join(root, 'README.md'), 'utf8')).replace('(LICENSE)', '(PROJECT-LICENSE.txt)'));
  await fs.copyFile(path.join(root, 'LICENSE'), path.join(output, 'PROJECT-LICENSE.txt'));
  await fs.cp(path.join(root, 'docs'), path.join(output, 'docs'), { recursive: true });
  await fs.writeFile(path.join(output, 'Start.cmd'), '@echo off\r\nset "ELECTRON_RUN_AS_NODE="\r\nstart "" "%~dp0STM32Git.exe"\r\n');
  const files = [];
  async function walk(dir) { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const file = path.join(dir, e.name); if (e.isSymbolicLink()) throw Error('Release links are not allowed'); if (e.isDirectory()) await walk(file); else { const bytes = await fs.readFile(file); files.push({ path: path.relative(output, file).replaceAll('\\', '/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); } } }
  await walk(output);
  await fs.writeFile(path.join(output, 'RELEASE-MANIFEST.json'), JSON.stringify({ version, platform: 'win32-x64', containsUserData: false, files }, null, 2) + '\n');
  console.log(JSON.stringify({ output, files: files.length, runtimeDependencies: [...copied], userDataCopied: false }));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });

