const http = require('node:http');
const fs   = require('node:fs');
const path = require('node:path');

const PORT      = process.env.PORT || 3000;
const VAULT_DIR = path.join(__dirname, 'vaults');
const HTML_FILE = path.join(__dirname, 'dist', 'concept-map.html');
fs.mkdirSync(VAULT_DIR, { recursive: true });

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

http.createServer((req, res) => {
  cors(res);
if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Serve app (inject vault-enabled marker so client skips vault when using other servers)
  // Match any non-vault GET — handles Traefik StripPrefix variants ('', '/', '/index.html')
  if (req.method === 'GET' && !req.url.startsWith('/vault/')) {
    try {
      const html = fs.readFileSync(HTML_FILE, 'utf8')
        .replace('<meta charset="UTF-8">', '<meta charset="UTF-8">\n<meta name="orbis-vault" content="true">');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500); res.end('Run "npm run build" first.');
    }
    return;
  }

  // Vault API
  const m = req.url.match(/^\/vault\/([a-f0-9]{64})$/);
  if (!m) { res.writeHead(404); res.end(); return; }

  const file = path.join(VAULT_DIR, m[1] + '.json');

  if (req.method === 'GET') {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(fs.readFileSync(file, 'utf8'));
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    }
    return;
  }

  if (req.method === 'PUT') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 10_000_000) req.destroy(); });
    req.on('end', () => {
      try {
        const { data } = JSON.parse(body);
        if (typeof data !== 'string') throw new Error();
        fs.writeFileSync(file, JSON.stringify({ data, updated_at: Date.now() }), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  res.writeHead(405); res.end();
}).listen(PORT, () => {
  console.log(`Orbis running at http://localhost:${PORT}`);
});
