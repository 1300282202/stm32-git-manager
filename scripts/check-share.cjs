'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const top = ['.gitignore', '.gitattributes', 'package.json', 'package-lock.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'THIRD-PARTY-NOTICES.md'];
const directories = ['src', 'scripts', 'tests', 'docs', '.github'];
async function main() {
  const files = [...top], errors = [];
  async function walk(relative) { for (const e of await fs.readdir(path.join(root, relative), { withFileTypes: true })) { const file = path.posix.join(relative, e.name); if (e.isSymbolicLink()) throw Error(`Publication links are not allowed: ${file}`); if (e.isDirectory()) await walk(file); else files.push(file); } }
  for (const directory of directories) await walk(directory);
  const records = [];
  for (const file of files.sort()) {
    if (/\.(?:uvprojx?|uvoptx?|axf|hex|bin|elf|bundle|zip|exe)$/i.test(file) || /(?:^|\/)(?:data|\.env|\.git)(?:\/|$)/.test(file)) errors.push(`Unexpected source entry: ${file}`);
    const bytes = await fs.readFile(path.join(root, file));
    records.push({ path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    if (!/\.(?:md|json|cjs|js|css|html|yml|txt)$/.test(file)) continue;
    const text = bytes.toString('utf8');
    if (/gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/.test(text)) errors.push(`Credential-like content: ${file}`);
    if (/C:[\\/](?:\\?Users)[\\/]/.test(text)) errors.push(`Private development reference: ${file}`);
    if (file.endsWith('.md')) for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = m[1].split('#')[0]; if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const absolute = path.resolve(root, path.dirname(file), decodeURIComponent(target)), relative = path.relative(root, absolute);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !await fs.access(absolute).then(() => true, () => false)) errors.push(`Broken documentation link: ${file} -> ${target}`);
    }
  }
  await fs.mkdir(path.join(root, '.test-work'), { recursive: true });
  const result = { passed: errors.length === 0, sourceFiles: records.length, containsUserData: false, errors, files: records };
  await fs.writeFile(path.join(root, '.test-work/share-audit.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ passed: result.passed, sourceFiles: records.length, errors }));
  if (!result.passed) process.exitCode = 1;
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });

