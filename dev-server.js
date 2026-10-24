// Локальный сервер для разработки: отдаёт статику и запускает функции из api/ так же, как Vercel.
// Переменные окружения читаются из .env.local (он в .gitignore). Для работы без облака можно указать
//   TURSO_DATABASE_URL=file:local.db
// — тогда база будет обычным файлом рядом с проектом.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';

try { process.loadEnvFile('.env.local'); } catch { /* файла может не быть */ }

const PORT = Number(process.env.PORT) || 3000;
const ROOT = process.cwd();
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const HIDDEN = new Set(['node_modules', 'api']);

function send(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function api(req, res, url) {
  const name = url.pathname.slice('/api/'.length).replace(/\/$/, '');
  if (!/^[a-z]+$/.test(name)) return send(res, 404, 'Not found');
  const mod = await import(`./api/${name}.js`).catch(() => null);
  const handler = mod?.[req.method];
  if (!handler) return send(res, mod ? 405 : 404, mod ? 'Method not allowed' : 'Not found');
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const request = new Request(url, {
    method: req.method,
    headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: 'half',
  });
  const response = await handler(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function file(res, url) {
  const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
  if (parts.some((p) => p.startsWith('.') || HIDDEN.has(p))) return send(res, 404, 'Not found');
  let path = normalize(join(ROOT, ...parts));
  if (path !== ROOT && !path.startsWith(ROOT + sep)) return send(res, 403, 'Forbidden');
  if ((await stat(path).catch(() => null))?.isDirectory()) path = join(path, 'index.html');
  const data = await readFile(path);
  res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(data);
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else await file(res, url);
  } catch (e) {
    if (e.code === 'ENOENT') send(res, 404, 'Not found');
    else { console.error(e); send(res, 500, 'Server error'); }
  }
}).listen(PORT, () => {
  console.log(`Music Visualizer: http://localhost:${PORT}`);
  console.log(`База: ${process.env.TURSO_DATABASE_URL ? process.env.TURSO_DATABASE_URL.replace(/\?.*/, '') : 'не настроена (режим «только браузер»)'}`);
});
