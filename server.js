/**
 * Minimal blog server with NO external deps.
 * Features:
 *  - Posts CRUD
 *  - Like toggle with likeCount and optional explicit state
 *  - Comments per post
 *  - Author names for posts and comments
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { randomUUID } = require('crypto');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'posts.json');
const ALLOW_CORS = String(process.env.ALLOW_CORS || 'false').toLowerCase() === 'true';

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]', 'utf8');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function safeJSON(str) {
  try { return JSON.parse(str) } catch { return null }
}

function send(res, status, body, headers={}) {
  const base = { 'Content-Type': 'application/json; charset=utf-8' };
  if (ALLOW_CORS) {
    base['Access-Control-Allow-Origin'] = '*';
    base['Access-Control-Allow-Methods'] = 'GET,POST,PUT,DELETE,OPTIONS';
    base['Access-Control-Allow-Headers'] = 'Content-Type';
  }
  res.writeHead(status, { ...base, ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function serveStatic(req, res, pathname) {
  const filePath = path.join(PUBLIC_DIR, decodeURIComponent(pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) { send(res, 403, { error: 'Forbidden' }); return true; }
  let finalPath = filePath;
  if (fs.existsSync(finalPath) && fs.statSync(finalPath).isDirectory()) finalPath = path.join(finalPath, 'index.html');
  if (!fs.existsSync(finalPath)) return false;
  const ext = path.extname(finalPath).toLowerCase();
  const types = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
  fs.createReadStream(finalPath).pipe(res);
  return true;
}

function readDB() {
  const raw = fs.readFileSync(DB_FILE, 'utf8');
  const arr = safeJSON(raw) || [];
  return arr.map(p => ({
    id: p.id,
    title: p.title,
    content: p.content,
    author: p.author || 'Anonymous',
    createdAt: p.createdAt,
    updatedAt: p.updatedAt ?? p.createdAt,
    liked: !!p.liked,
    likeCount: Number.isFinite(p.likeCount) ? p.likeCount : 0,
    comments: Array.isArray(p.comments) ? p.comments.map(c => ({
      id: c.id, content: c.content, author: c.author || 'Anonymous', createdAt: c.createdAt
    })) : [],
  }));
}

function writeDB(posts) {
  fs.writeFileSync(DB_FILE, JSON.stringify(posts, null, 2), 'utf8');
}

async function handleApi(req, res, pathname) {
  if (ALLOW_CORS && req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    res.end(); return;
  }

  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts[1] !== 'posts') return send(res, 404, { error: 'Not Found' });
  const id = parts[2];
  const sub = parts[3]; // 'comments' or 'like'

  if (req.method === 'GET' && !id) {
    const posts = readDB().sort((a,b) => b.createdAt - a.createdAt);
    return send(res, 200, { posts });
  }

  if (req.method === 'POST' && !id) {
    const body = safeJSON(await readBody(req)) || {};
    const title = String(body.title || '').trim();
    const content = String(body.content || '').trim();
    const author = String(body.author || '').trim() || 'Anonymous';
    if (!title || !content) return send(res, 400, { error: 'title and content are required' });
    const posts = readDB();
    const now = Date.now();
    const post = { id: randomUUID(), title, content, author, createdAt: now, updatedAt: now, liked: false, likeCount: 0, comments: [] };
    posts.push(post);
    writeDB(posts);
    return send(res, 201, { post });
  }

  if (!id) return send(res, 405, { error: 'Method Not Allowed' });

  // Like toggle or explicit set
  if (req.method === 'PUT' && sub === 'like') {
    const posts = readDB();
    const idx = posts.findIndex(p => p.id === id);
    if (idx === -1) return send(res, 404, { error: 'Post not found' });
    const body = safeJSON(await readBody(req)) || {};
    const hasExplicit = typeof body.like === 'boolean';
    const nextLike = hasExplicit ? body.like : !posts[idx].liked;
    // Adjust count based on change
    if (nextLike !== posts[idx].liked) {
      posts[idx].likeCount = Math.max(0, (posts[idx].likeCount || 0) + (nextLike ? 1 : -1));
    }
    posts[idx].liked = nextLike; // global flag (client may ignore and track locally)
    posts[idx].updatedAt = Date.now();
    writeDB(posts);
    return send(res, 200, { post: posts[idx] });
  }

  // Comments
  if (sub === 'comments') {
    if (req.method === 'GET') {
      const posts = readDB();
      const post = posts.find(p => p.id === id);
      if (!post) return send(res, 404, { error: 'Post not found' });
      return send(res, 200, { comments: post.comments });
    }
    if (req.method === 'POST') {
      const body = safeJSON(await readBody(req)) || {};
      const content = String(body.content || '').trim();
      const author = String(body.author || '').trim() || 'Anonymous';
      if (!content) return send(res, 400, { error: 'content is required' });
      const posts = readDB();
      const idx = posts.findIndex(p => p.id === id);
      if (idx === -1) return send(res, 404, { error: 'Post not found' });
      const comment = { id: randomUUID(), content, author, createdAt: Date.now() };
      posts[idx].comments.push(comment);
      posts[idx].updatedAt = Date.now();
      writeDB(posts);
      return send(res, 201, { comment });
    }
    return send(res, 405, { error: 'Method Not Allowed' });
  }

  // Update/Delete post
  if (req.method === 'PUT' && !sub) {
    const body = safeJSON(await readBody(req)) || {};
    const posts = readDB();
    const idx = posts.findIndex(p => p.id === id);
    if (idx === -1) return send(res, 404, { error: 'Post not found' });
    const now = Date.now();
    posts[idx] = {
      ...posts[idx],
      ...(body.title != null ? { title: String(body.title) } : {}),
      ...(body.content != null ? { content: String(body.content) } : {}),
      ...(body.author != null ? { author: String(body.author) } : {}),
      updatedAt: now,
    };
    writeDB(posts);
    return send(res, 200, { post: posts[idx] });
  }

  if (req.method === 'DELETE' && !sub) {
    const posts = readDB();
    const next = posts.filter(p => p.id !== id);
    if (next.length === posts.length) return send(res, 404, { error: 'Post not found' });
    writeDB(next);
    return send(res, 204, '');
  }

  send(res, 405, { error: 'Method Not Allowed' });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url);
  const pathname = decodeURIComponent(parsed.pathname || '/');
  if (pathname.startsWith('/api/')) {
    try { await handleApi(req, res, pathname); } 
    catch (err) { send(res, 500, { error: 'Server error', detail: String(err) }); }
    return;
  }
  const served = serveStatic(req, res, pathname);
  if (!served) {
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexPath)) fs.createReadStream(indexPath).pipe(res);
    else { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found'); }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});
