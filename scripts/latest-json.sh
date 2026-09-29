#!/bin/bash
# Writes latest.json (the one-click update manifest, docs/update.md) into a folder
# holding this release's files, named as on the website's /download/:
#   LinguaClip-mac-apple-silicon.app.tar.gz(.sig), LinguaClip-mac-intel.app.tar.gz(.sig),
#   LinguaClip-windows-setup.exe(.sig)
# Usage: scripts/latest-json.sh <folder> "<what's new, plain text>"
set -euo pipefail
cd "$(dirname "$0")/.."
node - "$1" "$2" <<'JS'
const fs = require('fs'), path = require('path');
const [dir, notes] = process.argv.slice(2);
const version = require('./src-tauri/tauri.conf.json').version;
const site = 'https://linguaclipapp.com/download/';
const files = {
  'darwin-aarch64': 'LinguaClip-mac-apple-silicon.app.tar.gz',
  'darwin-x86_64': 'LinguaClip-mac-intel.app.tar.gz',
  'windows-x86_64': 'LinguaClip-windows-setup.exe',
};
const platforms = {};
for (const [key, file] of Object.entries(files)) {
  const sig = path.join(dir, file + '.sig');
  if (!fs.existsSync(path.join(dir, file)) || !fs.existsSync(sig)) throw new Error(`missing ${file} or its .sig in ${dir}`);
  platforms[key] = { signature: fs.readFileSync(sig, 'utf8').trim(), url: site + file };
}
if (!notes.trim()) throw new Error('write what is new: it shows in the update dialog');
fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify({ version, notes, pub_date: new Date().toISOString(), platforms }, null, 2) + '\n');
console.log(`latest.json: ${version}, ${Object.keys(platforms).join(', ')}`);
JS
