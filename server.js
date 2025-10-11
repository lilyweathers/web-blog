// server.js — Web Blog with API & static server (no dependencies)
// Uses the WHATWG URL API (no deprecated url.parse).
// -----------------------------------------------------------------------------
// Features
//   • Serves static files from ./public (falls back to project root)
//   • CRUD for posts (newest-first ordering)
//   • Like / Unlike (persisted in posts.json)
//   • Add comments to a post
//   • Atomic JSON writes + a tiny queue to serialize concurrent updates
//
// Data model (stored in posts.json as an array of objects):
//   {
//     id: string,
//     title: string,
//     content: string,
//     author: string,
//     likes: number,
//     createdAt: number (ms),
//     updatedAt: number (ms),
//     comments: Array<{ author: string, content: string, createdAt: number}>
//   }
//
// Endpoints
//   GET    /api/posts                 -> list posts (newest first)
//   POST   /api/posts                 -> create post {title, content, author?}
//   PUT    /api/posts/:id             -> update {title?, content?, author?}
//   DELETE /api/posts/:id             -> delete post
//   POST   /api/posts/:id/like        -> +1 like
//   DELETE /api/posts/:id/like        -> -1 like
//   POST   /api/posts/:id/comments    -> add comment {content, author?}
//
// Notes
//   • No external packages. Everything is Node core (http, fs, path).
//   • WHATWG URL parsing is used everywhere to avoid deprecation warnings and
//     to get spec-compliant behavior.
//   • Atomic writes prevent partial-file corruption. The queue prevents two
//     writes from interleaving when requests arrive at the same time.
// -----------------------------------------------------------------------------

const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------- Paths & constants -----------------------------------------------
// Project root (the folder where server.js lives)
const ROOT = __dirname;

// Where we try to serve static files from.
// We check ./public first, then fall back to the project root.
const STATIC_DIRS = [path.join(ROOT, 'public'), ROOT];
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch {}

// posts.json can live in project root or ./data/posts.json.
// We pick the first file that exists, falling back to project root.
const POSTS_FILES = [
  path.join(__dirname, 'posts.json'),
  path.join(__dirname, 'data', 'posts.json')
];

// ---------- Small utility helpers -------------------------------------------

// Return the first path that exists; otherwise the first candidate.
function firstExisting(paths) {
  for (const p of paths) {
    try { fs.accessSync(p); return p; } catch {}
  }
  return paths[0];
}

function pickLatestFile(paths) {
  // Return the existing file with the newest mtime; if none exist, default to the first path.
  let best = null;
  let bestTime = -1;
  for (const p of paths) {
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.mtimeMs > bestTime) {
        best = p; bestTime = st.mtimeMs;
      }
    } catch {}
  }
  return best || paths[0];
}

// Which file we will use for posts storage.
const POSTS_FILE = pickLatestFile(POSTS_FILES);
console.log('Using posts file:', POSTS_FILE);
// Ensure posts file exists so reads don't crash on first boot.
function ensureFile(file, defaultContent) {
  try { fs.accessSync(file); }
  catch {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, defaultContent, 'utf-8');
  }
}
ensureFile(POSTS_FILE, '[]');

// Load posts.json into memory as a JS value.
// If reading/parsing fails, we return an empty array to keep the server alive.
function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return []; }
}

// Write posts.json atomically: write to a temp file, then rename over the old.
// This avoids truncated files if the process crashes mid-write.
function writeJSONAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

// A very small queue to serialize write operations. This prevents races like
// two requests reading, both writing, and one set of changes getting lost.
let pending = Promise.resolve();
function queue(task) {
  const run = pending.then(task, task);
  pending = run.catch(() => {}); // keep chain alive if a task throws
  return run;
}

// JSON response helpers
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function notFound(res, msg='Not found') { json(res, 404, { error: msg }); }
function badReq(res, msg='Bad request') { json(res, 400, { error: msg }); }

// Timestamps
function now() { return Date.now(); }

// Normalize anything we read from disk to the expected post shape.
function normalizePosts(raw) {
  const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.posts) ? raw.posts : []);
  return arr.map(p => ({
    id: String(p.id ?? ''),
    title: String(p.title ?? ''),
    content: String(p.content ?? ''),
    author: String(p.author ?? 'Anonymous'),
    likes: Number(p.likes ?? 0),
    createdAt: Number(p.createdAt ?? now()),
    updatedAt: Number(p.updatedAt ?? now()),
    comments: Array.isArray(p.comments) ? p.comments : [], imageUrl: String(p.imageUrl || '')
  }));
}

// Parse a JSON request body (for POST/PUT).
// Uses a size guard (~1 MB) to avoid accidental huge uploads.

function fromDataUrl(dataUrl) {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  return { mime: m[1], data: Buffer.from(m[2], 'base64') };
}
function extFromMime(mime) {
  const map = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg' };
  return map[mime] || null;
}
function parseJSONBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 10 * 1024 * 1024) { // ~1MB guard
        try { req.destroy(); } catch {}
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!data) return resolve(null);
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// Build a base URL string (e.g., http://localhost:3000) so WHATWG URL can
// resolve relative request URLs safely behind proxies or different hosts.
function getBase(req) {
  const host = req.headers.host || 'localhost:3000';
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() || 'http';
  return `${proto}://${host}`;
}

// Serve a static file if it exists in one of our STATIC_DIRS.
function serveStatic(req, res) {
  // WHATWG URL: robust parsing, no deprecation warnings.
  const u = new URL(req.url, getBase(req));
  let pathname = u.pathname || '/';
  // serve index.html for the root path
  if (pathname === '/') pathname = '/index.html';

  for (const base of STATIC_DIRS) {
    const fp = path.join(base, decodeURIComponent(pathname));
    // Avoid path traversal: only serve files that remain inside `base`.
    if (fp.startsWith(base) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      const stream = fs.createReadStream(fp);
      const ext = path.extname(fp).toLowerCase();
      const types = {
        '.html':'text/html','.htm':'text/html','.js':'application/javascript','.css':'text/css',
        '.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml'
      };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
      stream.pipe(res);
      return true;
    }
  }
  return false;
}

// ---------- HTTP server -----------------------------------------------------
const server = http.createServer(async (req, res) => {
  // WHATWG URL for the current request
  const u = new URL(req.url, getBase(req));
  const method = req.method || 'GET';
  const pathname = u.pathname || '/';

  // ---- API routes ----------------------------------------------------------
  if (pathname.startsWith('/api/')) {
    if (pathname === '/api/debug/posts-file' && method === 'GET') { return json(res, 200, { file: POSTS_FILE }); }
    // 1) GET /api/posts — return newest first
    if (pathname === '/api/posts' && method === 'GET') {
      const posts = normalizePosts(readJSON(POSTS_FILE))
        .sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0));
      return json(res, 200, posts);
    }

    // 2) POST /api/posts — create a new post
    if (pathname === '/api/posts' && method === 'POST') {
      try {
        const body = await parseJSONBody(req);
        const title = (body?.title || '').trim();
        if (!title) return badReq(res, 'Title is required');
        const content = String(body?.content || '');
        const author  = (body?.author && String(body.author).trim()) || 'Anonymous';
        const imageUrl = typeof body?.imageUrl === 'string' ? body.imageUrl : ''; 

        await queue(async () => {
          const posts = normalizePosts(readJSON(POSTS_FILE));
          const post = {
            id: String(Date.now()) + Math.floor(Math.random() * 1000),
            title, content, author,
            likes: 0,
            createdAt: now(),
            updatedAt: now(),
            comments: [],
            imageUrl: imageUrl
          };
          // newest-first in the file itself
          posts.unshift(post);
          writeJSONAtomic(POSTS_FILE, posts);
        });

        return json(res, 201, { ok: true });
      } catch (e) {
        return badReq(res, e.message || 'Invalid JSON');
      }
    }

    // For routes with :id, split the path: ['', 'api', 'posts', ':id', 'like'|'comments'?]
    const parts = pathname.split('/');
    const id = parts.length >= 4 ? decodeURIComponent(parts[3]) : null;
    const tail = parts.length >= 5 ? parts[4] : null;

    if (id) {
      // 3) PUT /api/posts/:id — update fields
      if (method === 'PUT' && !tail) {
        try {
          const body = await parseJSONBody(req);
          await queue(async () => {
            const posts = normalizePosts(readJSON(POSTS_FILE));
            const idx = posts.findIndex(p => String(p.id) === String(id));
            if (idx === -1) return notFound(res, 'Post not found');
            if (typeof body?.title === 'string')   posts[idx].title   = body.title;
            if (typeof body?.content === 'string') posts[idx].content = body.content;
            if (typeof body?.author === 'string')  posts[idx].author  = body.author;
            posts[idx].updatedAt = now();
            writeJSONAtomic(POSTS_FILE, posts);
            json(res, 200, { ok: true });
          });
          return;
        } catch (e) {
          return badReq(res, e.message || 'Invalid JSON');
        }
      }

      // 4) DELETE /api/posts/:id — delete
      if (method === 'DELETE' && !tail) {
        await queue(async () => {
          const posts = normalizePosts(readJSON(POSTS_FILE));
          const idx = posts.findIndex(p => String(p.id) === String(id));
          if (idx === -1) return notFound(res, 'Post not found');
          posts.splice(idx, 1);
          writeJSONAtomic(POSTS_FILE, posts);
          res.writeHead(204); // No Content
          res.end();
        }).catch(err => {
          console.error(err);
          json(res, 500, { error: 'Failed to delete' });
        });
        return;
      }

      // 5) POST/DELETE /api/posts/:id/like — like/unlike
      if (tail === 'like' && (method === 'POST' || method === 'DELETE')) {
        await queue(async () => {
          const posts = normalizePosts(readJSON(POSTS_FILE));
          const idx = posts.findIndex(p => String(p.id) === String(id));
          if (idx === -1) return notFound(res, 'Post not found');
          const delta = method === 'POST' ? +1 : -1;
          posts[idx].likes = Math.max(0, (posts[idx].likes || 0) + delta);
          posts[idx].updatedAt = now();
          writeJSONAtomic(POSTS_FILE, posts);
          json(res, 200, { id: String(id), likes: posts[idx].likes });
        }).catch(err => {
          console.error(err);
          json(res, 500, { error: 'Failed to update like' });
        });
        return;
      }

      // 6) POST /api/posts/:id/comments — add a comment
      if (tail === 'comments' && method === 'POST') {
        try {
          const body = await parseJSONBody(req);
          await queue(async () => {
            const posts = normalizePosts(readJSON(POSTS_FILE));
            const idx = posts.findIndex(p => String(p.id) === String(id));
            if (idx === -1) return notFound(res, 'Post not found');
            const comment = {
              author: (typeof body?.author === 'string' && body.author.trim())
                ? body.author.trim()
                : 'Anonymous',
              content: String(body?.content || ''),
              createdAt: now()
            };
            posts[idx].comments = Array.isArray(posts[idx].comments) ? posts[idx].comments : [];
            posts[idx].comments.push(comment);
            posts[idx].updatedAt = now();
            writeJSONAtomic(POSTS_FILE, posts);
            json(res, 201, { ok: true });
          });
          return;
        } catch (e) {
          return badReq(res, e.message || 'Invalid JSON');
        }
      }
    }

    // If we got here, the API path didn't match anything
    
  // Upload endpoint: POST /api/uploads { dataUrl } -> { url }
  if (pathname === '/api/uploads' && method === 'POST') {
    try {
      const body = await parseJSONBody(req);
      const parsed = fromDataUrl(body && body.dataUrl);
      if (!parsed) { badReq(res, 'Invalid data URL'); return; }
      if (parsed.data.length > 5 * 1024 * 1024) { badReq(res, 'Image too large (max 5MB)'); return; }
      const ext = extFromMime(parsed.mime);
      if (!ext) { badReq(res, 'Unsupported image type'); return; }
      const name = 'img_' + Date.now() + '_' + Math.floor(Math.random()*1e6) + ext;
      const filePath = path.join(UPLOADS_DIR, name);
      fs.writeFileSync(filePath, parsed.data);
      json(res, 201, { url: '/uploads/' + name });
    } catch (e) {
      badReq(res, e.message || 'Invalid JSON');
    }
    return;
  }
return notFound(res);
  }

  // ---- Static files (non-API) ---------------------------------------------
  if (serveStatic(req, res)) return;

  // Fallback 404 for anything else
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ---------- Start server ----------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
