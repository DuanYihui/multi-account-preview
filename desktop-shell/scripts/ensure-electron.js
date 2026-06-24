const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');

if (fs.existsSync(electronDir)) {
  process.exit(0);
}

console.log('Electron dependency missing. Running npm install...');

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npmCommand, ['install'], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit'
});

process.exit(result.status ?? 1);
