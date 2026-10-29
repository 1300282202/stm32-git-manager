'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
let count = 0;
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(name);
    else if (/\.(?:c?js)$/.test(entry.name)) { execFileSync(process.execPath, ['--check', name], { stdio: 'inherit' }); count++; }
  }
}
walk(path.join(root, 'src'));
walk(path.join(root, 'scripts'));
console.log(`Syntax checked: ${count} JavaScript files.`);
