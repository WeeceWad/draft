// Optional local preview. Opening index.html directly also works.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const htmlPath = path.resolve(__dirname, '../index.html');
const server = http.createServer((request, response) => {
  if (request.url !== '/' && request.url !== '/index.html') {
    response.writeHead(404); response.end('Not found'); return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  fs.createReadStream(htmlPath).pipe(response);
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(4173, '127.0.0.1', () => console.log('Draft builder: http://127.0.0.1:4173'));
