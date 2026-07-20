// 停止 preview 服务器并确认端口释放
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const pid = fs.readFileSync(path.join(__dirname, 'server.pid'), 'utf8').trim();
try {
  execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'inherit' });
} catch (e) {
  console.log('taskkill note:', e.message.split('\n')[0]);
}
setTimeout(() => {
  try {
    const out = execSync('netstat -ano | findstr :7201 | findstr LISTEN').toString();
    console.log('STILL LISTENING:\n' + out);
    process.exit(1);
  } catch {
    console.log('port 7201 free');
  }
}, 1200);
