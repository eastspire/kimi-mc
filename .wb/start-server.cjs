// 启动 preview 服务器（分离进程，写 PID 到 .wb/server.pid）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = fs.openSync(path.join(__dirname, 'server.log'), 'w');
const child = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--port', '7201', '--strictPort'], {
  cwd: root,
  detached: true,
  stdio: ['ignore', out, out],
});
child.unref();
fs.writeFileSync(path.join(__dirname, 'server.pid'), String(child.pid));
console.log('server pid:', child.pid);
setTimeout(() => process.exit(0), 500);
