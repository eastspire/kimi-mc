// WebBridge 调用辅助：node wb.cjs <request.json>
const fs = require('fs');
const http = require('http');

const file = process.argv[2];
const body = fs.readFileSync(file, 'utf8');

const req = http.request(
  { host: '127.0.0.1', port: 10086, path: '/command', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
  (res) => {
    let d = '';
    res.on('data', (c) => (d += c));
    res.on('end', () => {
      console.log('HTTP', res.statusCode);
      console.log(d.slice(0, 3000));
    });
  },
);
req.on('error', (e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
req.write(body);
req.end();
