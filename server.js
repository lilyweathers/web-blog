// Minimal Node blog server (no dependencies)
// Endpoints:
//   GET    /api/posts                 -> list posts
//   POST   /api/posts                 -> create post {title, content, author?}
//   PUT    /api/posts/:id             -> update post {title?, content?, author?}
//   DELETE /api/posts/:id             -> delete post
//   POST   /api/posts/:id/like        -> +1 like
//   DELETE /api/posts/:id/like        -> -1 like
//   POST   /api/posts/:id/comments    -> add comment {content, author?}
// Static files are served from ./public (if present) else from project root.

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const ROOT = __dirname;
const STATIC_DIRS = [path.join(ROOT, 'public'), ROOT];
const POSTS_CANDIDATES = [
  path.join(ROOT, 'posts.json'),
  path.join(ROOT, 'data', 'posts.json')
];

function resolvePostsPath() {
  for (const p of POSTS_CANDIDATES) {
    try { fs.accessSync(p); return p; } catch { }
  }
  // default to root posts.json
  return POSTS_CANDIDATES[0];
}

const POSTS_FILE = resolvePostsPath();

function ensurePostsFile() {
  try { fs.accessSync(POSTS_FILE); }
  catch {
    const dir = path.dirname(POSTS_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(POSTS_FILE, '[]', 'utf-8');
  }
}

function readPosts() {
  ensurePostsFile();
  try {
    const raw = fs.readFileSync(POSTS_FILE, 'utf-8');
    const j = JSON.parse(raw);
    if (Array.isArray(j)) return j;
    if (j && Array.isArray(j.posts)) return j.posts;
    return [];
  } catch (e) {
    return [];
  }
}

function writePostsAtomic(posts) {
  const tmp = POSTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(posts, null, 2), 'utf-8');
  fs.renameSync(tmp, POSTS_FILE);
}

// serialize writes (naive, single-process)
let pending = Promise.resolve();
function queue(task) {
  const run = pending.then(task, task);
  pending = run.catch(() => { });
  return run;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) { try { req.destroy(); } catch (e) { }; reject(new Error('Payload too large')); }
    });
    req.on('end', () => {
      if (!data) return resolve(null);
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function tryServeStatic(req, res) {
  let pathname = url.parse(req.url).pathname || '/';
  if (pathname === '/') pathname = '/index.html';
  for (const base of STATIC_DIRS) {
    const fp = path.join(base, decodeURIComponent(pathname));
    if (fp.startsWith(base) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      const stream = fs.createReadStream(fp);
      const ext = path.extname(fp).toLowerCase();
      const types = {
        '.html': 'text/html', '.htm': 'text/html', '.js': 'application/javascript',
        '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml'
      };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
      stream.pipe(res);
      return true;
    }
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const method = req.method || 'GET';

  // ---------- API: list posts ----------
  if (parsed.pathname === '/api/posts' && method === 'GET') {
    const raw = readPosts();
    const posts = raw
      .slice()
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); // newest first
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(posts));
    return;
  }

  // ---------- API: create post ----------
  if (parsed.pathname === '/api/posts' && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      if (!body || typeof body.title !== 'string' || !body.title.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Title is required' }));
        return;
      }
      const title = body.title.trim();
      const content = typeof body.content === 'string' ? body.content : '';
      const author = typeof body.author === 'string' ? body.author : 'Anonymous';
      await queue(async () => {
        const posts = readPosts();
        const id = String(Date.now()) + Math.floor(Math.random() * 1000);
        posts.push({ id, title, content, author, likes: 0, createdAt: Date.now(), updatedAt: Date.now(), comments: [] });
        writePostsAtomic(posts);
      });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || 'Invalid request' }));
    }
    return;
  }

  // ---------- API: update post ----------
  const updateMatch = parsed.pathname.match(/^\/api\/posts\/([^\/]+)\/?$/);
  if (updateMatch && method === 'PUT') {
    try {
      const id = String(decodeURIComponent(updateMatch[1]));
      const body = await readJsonBody(req);
      await queue(async () => {
        const posts = readPosts();
        const idx = posts.findIndex(p => String(p.id) == id);
        if (idx === -1) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Post not found' }));
          return;
        }
        if (body && typeof body.title === 'string') posts[idx].title = body.title;
        if (body && typeof body.content === 'string') posts[idx].content = body.content;
        if (body && typeof body.author === 'string') posts[idx].author = body.author;
        posts[idx].updatedAt = Date.now();
        writePostsAtomic(posts);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || 'Invalid request' }));
    }
    return;
  }

  // ---------- API: delete post (robust) ----------
  if (method === 'DELETE' && parsed.pathname.startsWith('/api/posts/')) {
    const parts = parsed.pathname.split('/').filter(Boolean); // ['api','posts',':id']
    if (parts.length === 3) {
      const id = String(decodeURIComponent(parts[2]));
      await queue(async () => {
        const posts = readPosts();
        const idx = posts.findIndex(p => String(p.id) == id);
        if (idx === -1) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Post not found' }));
          return;
        }
        posts.splice(idx, 1);
        writePostsAtomic(posts);
        res.writeHead(204);
        res.end();
      }).catch(err => {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to delete' }));
      });
      return;
    }
  }

  // ---------- API: like/unlike ----------
  const likeMatch = parsed.pathname.match(/^\/api\/posts\/([^\/]+)\/like\/?$/);
  if (likeMatch && (method === 'POST' || method === 'DELETE')) {
    const id = String(decodeURIComponent(likeMatch[1]));
    await queue(async () => {
      const posts = readPosts();
      const idx = posts.findIndex(p => String(p.id) == id);
      if (idx === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Post not found' }));
        return;
      }
      const delta = method === 'POST' ? +1 : -1;
      posts[idx].likes = Math.max(0, Number(posts[idx].likes || 0) + delta);
      posts[idx].updatedAt = Date.now();
      writePostsAtomic(posts);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, likes: posts[idx].likes }));
    }).catch(err => {
      console.error(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to update like' }));
    });
    return;
  }

  // ---------- API: add comment ----------
  const commentMatch = parsed.pathname.match(/^\/api\/posts\/([^\/]+)\/comments\/?$/);
  if (commentMatch && method === 'POST') {
    try {
      const id = String(decodeURIComponent(commentMatch[1]));
      const body = await readJsonBody(req);
      await queue(async () => {
        const posts = readPosts();
        const idx = posts.findIndex(p => String(p.id) == id);
        if (idx === -1) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Post not found' }));
          return;
        }
        const comment = {
          author: (body && typeof body.author === 'string' && body.author.trim()) ? body.author.trim() : 'Anonymous',
          content: (body && typeof body.content === 'string') ? body.content : '',
          createdAt: Date.now()
        };
        posts[idx].comments = Array.isArray(posts[idx].comments) ? posts[idx].comments : [];
        posts[idx].comments.push(comment);
        posts[idx].updatedAt = Date.now();
        writePostsAtomic(posts);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || 'Invalid request' }));
    }
    return;
  }

  // ---------- Static files ----------
  if (tryServeStatic(req, res)) return;

  // Not found
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
