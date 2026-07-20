// 构建辅助：tsc + vite build
const { spawnSync } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');

let r = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc')], { cwd: root, stdio: 'inherit' });
if (r.status !== 0) { console.error('TSC FAILED'); process.exit(1); }
console.log('TSC OK');
r = spawnSync(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
