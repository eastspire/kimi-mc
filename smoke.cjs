// 一次性冒烟测试：启动 vite preview → curl 关键资源 → 杀掉服务器
const { spawn } = require('child_process');
const http = require('http');

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', '7199', '--strictPort'], {
  cwd: __dirname,
  stdio: 'ignore',
});

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get('http://localhost:7199' + path, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ code: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
  });
}

(async () => {
  await new Promise((r) => setTimeout(r, 4000));
  let failed = false;
  try {
    const idx = await get('/');
    console.log('GET / ->', idx.code);
    console.log(idx.body.slice(0, 250).replace(/\n/g, ' '));
    if (idx.code !== 200) failed = true;

    const blocks = await get('/models/blocks.json');
    console.log('GET /models/blocks.json ->', blocks.code, '|', blocks.body.slice(0, 60).replace(/\n/g, ' '));
    if (blocks.code !== 200) failed = true;

    const cross = await get('/models/block/cross.json');
    console.log('GET /models/block/cross.json ->', cross.code);
    if (cross.code !== 200) failed = true;

    const m = idx.body.match(/assets\/mesher-worker[^"]*\.js/);
    if (m) {
      const w = await get('/' + m[0]);
      console.log('GET /' + m[0] + ' ->', w.code);
      if (w.code !== 200) failed = true;
    } else {
      console.log('WARN: worker asset not referenced in index.html (normal: it is lazy-loaded)');
    }
  } catch (e) {
    console.error('SMOKE ERROR:', e.message);
    failed = true;
  } finally {
    server.kill();
  }
  console.log(failed ? 'SMOKE FAILED' : 'SMOKE OK');
  process.exit(failed ? 1 : 0);
})();
