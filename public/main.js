// Client script: render posts, create/edit/delete, like, comments, with images.

const $ = sel => document.querySelector(sel);
const LIKE_KEY = id => `liked:${id}`;

const escapeHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fmtDate = ms => ms ? new Date(ms).toLocaleString() : '';

async function fetchJSON(url, options) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const type = res.headers.get('Content-Type') || '';
  return type.includes('application/json') ? res.json() : res.text();
}

function getLiked(id) { return localStorage.getItem(LIKE_KEY(id)) === '1'; }
function setLiked(id, v) { v ? localStorage.setItem(LIKE_KEY(id), '1') : localStorage.removeItem(LIKE_KEY(id)); }

async function loadPosts() {
  const data = await fetchJSON('/api/posts');
  const posts = data.slice().sort((a,b) => (b.createdAt||0) - (a.createdAt||0));
  const root = $('#posts');
  if (!root) return;
  root.innerHTML = '';
  for (const p of posts) {
    const likedLocal = getLiked(p.id);
    const div = document.createElement('div');
    div.className = 'post';
    div.dataset.id = p.id;
    div.innerHTML = `
      <h3>${escapeHtml(p.title || '')}</h3>
      ${p.imageUrl ? `<div class="image"><img src="${escapeHtml(p.imageUrl)}" alt="" loading="lazy" /></div>` : `<div class="image"><img src="/uploads/placeholder.svg" alt="" loading="lazy" /></div>`}
      <div class="meta">
        <strong>${escapeHtml(p.author || 'Anonymous')}</strong>
        ${p.createdAt ? ' • ' + fmtDate(p.createdAt) : ''}
        ${p.updatedAt && p.updatedAt !== p.createdAt ? ' • updated ' + fmtDate(p.updatedAt) : ''}
      </div>
      <p>${escapeHtml(p.content || '')}</p>
      <div class="controls">
        <button data-edit>Edit</button>
        <button data-delete>Delete</button>
        <span class="like-wrap" title="Like">
          <span class="heart ${likedLocal ? 'liked' : ''}" data-like>${likedLocal ? '♥' : '♡'}</span>
          <span class="like-count" data-like-count>${p.likes || 0}</span>
        </span>
      </div>
      <div class="comment-list">${renderComments(p.comments || [])}</div>
      <form class="comment-form" data-comment>
        <input name="author" placeholder="Your name" />
        <textarea name="content" placeholder="Add a comment…" required></textarea>
        <button type="submit">Comment</button>
      </form>
    `;
    root.appendChild(div);
  }
}

function renderComments(comments) {
  if (!Array.isArray(comments) || comments.length === 0) {
    return `<div class="comment" style="opacity:.7">No comments yet. Be the first!</div>`;
  }
  return comments
    .slice()
    .sort((a,b) => (a.createdAt||0) - (b.createdAt||0))
    .map(c => `<div class="comment"><div class="meta">${escapeHtml(c.author || 'Anonymous')}${c.createdAt ? ' • ' + fmtDate(c.createdAt) : ''}</div>${escapeHtml(c.content || '')}</div>`)
    .join('');
}

async function onSubmitNewPost(e) {
  e.preventDefault();
  const title = document.getElementById('title')?.value.trim();
  const content = document.getElementById('content')?.value.trim();
  const author = document.getElementById('author')?.value.trim();
  const fileInput = document.getElementById('image');
  if (!title || !content) { alert('Please provide a title and content'); return; }

  let imageUrl = '';
  try {
    if (fileInput?.files?.[0]) {
      const dataUrl = await fileToDataUrl(fileInput.files[0]);
      const up = await fetch('/api/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl })
      });
      if (!up.ok) throw new Error(await up.text() || 'Upload failed');
      const out = await up.json();
      imageUrl = out.url || '';
    }
    await fetchJSON('/api/posts', {
      method: 'POST',
      body: JSON.stringify({ title, content, author, imageUrl })
    });
    document.getElementById('post-form')?.reset();
    await loadPosts();
  } catch (err) {
    alert('Failed to create post: ' + (err.message || err));
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function onPostsClick(e) {
  const postEl = e.target.closest('.post');
  if (!postEl) return;
  const id = postEl.dataset.id;

  if (e.target.matches('button[data-delete]')) {
    if (!confirm('Delete this post?')) return;
    try {
      await fetchJSON(`/api/posts/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadPosts();
    } catch (err) {
      alert('Failed to delete: ' + err.message);
    }
    return;
  }

  if (e.target.matches('button[data-edit]')) {
    const curTitle = postEl.querySelector('h3')?.textContent || '';
    const curContent = postEl.querySelector('p')?.textContent || '';
    const title = prompt('New title:', curTitle);
    const content = prompt('New content:', curContent);
    if (title == null || content == null) return;
    try {
      await fetchJSON(`/api/posts/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ title, content }) });
      await loadPosts();
    } catch (err) {
      alert('Failed to update: ' + err.message);
    }
    return;
  }

  if (e.target.closest('[data-like]')) {
    const heart = postEl.querySelector('[data-like]');
    const countEl = postEl.querySelector('[data-like-count]');
    const wasLiked = getLiked(id);
    const nextLiked = !wasLiked;
    const cur = parseInt(countEl?.textContent || '0', 10) || 0;
    heart?.classList.toggle('liked', nextLiked);
    if (heart) heart.textContent = nextLiked ? '♥' : '♡';
    if (countEl) countEl.textContent = String(Math.max(0, cur + (nextLiked ? 1 : -1)));
    setLiked(id, nextLiked);
    try {
      await fetchJSON(`/api/posts/${encodeURIComponent(id)}/like`, { method: nextLiked ? 'POST' : 'DELETE' });
    } catch (err) {
      setLiked(id, wasLiked);
      heart?.classList.toggle('liked', wasLiked);
      if (heart) heart.textContent = wasLiked ? '♥' : '♡';
      if (countEl) countEl.textContent = String(cur);
      alert('Failed to update like: ' + err.message);
    }
    return;
  }
}

async function onPostsSubmit(e) {
  const form = e.target.closest('form[data-comment]');
  if (!form) return;
  e.preventDefault();
  const postEl = e.target.closest('.post');
  const id = postEl?.dataset.id;
  const content = form.querySelector('textarea[name="content"]')?.value.trim();
  const author  = form.querySelector('input[name="author"]')?.value.trim();
  if (!content) return;
  try {
    await fetchJSON(`/api/posts/${encodeURIComponent(id)}/comments`, { method: 'POST', body: JSON.stringify({ content, author }) });
    form.reset();
    await loadPosts();
  } catch (err) {
    alert('Failed to comment: ' + err.message);
  }
}

document.getElementById('post-form')?.addEventListener('submit', onSubmitNewPost);
document.getElementById('posts')?.addEventListener('click', onPostsClick);
document.getElementById('posts')?.addEventListener('submit', onPostsSubmit);

(async () => {
  try { await loadPosts(); }
  catch (err) {
    const root = document.getElementById('posts');
    if (root) root.innerHTML = `<div class="post">Failed to load posts: ${escapeHtml(err.message||String(err))}</div>`;
    console.error(err);
  }
})(); 
