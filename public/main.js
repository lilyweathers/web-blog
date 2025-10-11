// Local like state per browser to emulate per-user likes while keeping server simple.
const LIKE_KEY = (id) => `liked:${id}`;

async function fetchJSON(url, options) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString();
}
function escapeHtml(s){
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;');
}

function getLocalLiked(id) { return localStorage.getItem(LIKE_KEY(id)) === '1'; }
function setLocalLiked(id, val) { if (val) localStorage.setItem(LIKE_KEY(id), '1'); else localStorage.removeItem(LIKE_KEY(id)); }

async function loadPosts() {
  const data = await fetchJSON('/api/posts');
  const list = document.getElementById('posts');
  if (!list) return;
  list.innerHTML = '';
  for (const p of data) {
    const likedLocal = getLocalLiked(p.id);
    const likeCountDisplay = (p.likes || 0);
    const div = document.createElement('div');
    div.className = 'post';
    div.dataset.id = p.id;
    div.innerHTML = `
      <h3>${escapeHtml(p.title || '')}</h3>
      <div class="meta">
        <strong>${escapeHtml(p.author || 'Anonymous')}</strong>
        ${p.createdAt ? ` • created ${fmtDate(p.createdAt)}` : ''}
        ${p.updatedAt && p.updatedAt !== p.createdAt ? ` • updated ${fmtDate(p.updatedAt)}` : ''}
      </div>
      <p>${escapeHtml(p.content || '')}</p>
      <div class="controls">
        <button data-edit>Edit</button>
        <button data-delete>Delete</button>
        <span class="like-wrap" title="Like">
          <span class="heart ${likedLocal ? 'liked' : ''}" data-like>${likedLocal ? '♥' : '♡'}</span>
          <span class="like-count" data-like-count>${likeCountDisplay}</span>
        </span>
      </div>
      <div class="comment-list">${renderComments(p.comments || [])}</div>
      <form class="comment-form" data-comment>
        <input name="author" placeholder="Your name" />
        <textarea name="content" placeholder="Add a comment…" required></textarea>
        <button type="submit">Comment</button>
      </form>
    `;
    list.appendChild(div);
  }
}

function renderComments(comments) {
  if (!comments || comments.length === 0) {
    return `<div class="comment" style="opacity:.7">No comments yet. Be the first one to comment!</div>`;
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
  if (!title || !content) return;
  try {
    await fetchJSON('/api/posts', { method: 'POST', body: JSON.stringify({ title, content, author }) });
    e.target.reset();
    await loadPosts();
  } catch (err) {
    alert('Failed to create post: ' + err.message);
  }
}

async function onPostsClick(e) {
  const postEl = e.target.closest('.post');
  if (!postEl) return;
  const id = postEl.dataset.id;

  if (e.target.matches('button[data-delete]')) {
    if (confirm('Delete this post?')) {
      try {
        await fetchJSON(`/api/posts/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await loadPosts();
      } catch (err) {
        alert('Failed to delete: ' + err.message);
      }
    }
    return;
  }

  if (e.target.matches('button[data-edit]')) {
    const titleEl = postEl.querySelector('h3');
    const contentEl = postEl.querySelector('p');
    const newTitle = prompt('New title:', titleEl?.textContent || '');
    const newContent = prompt('New content:', contentEl?.textContent || '');
    try {
      await fetchJSON(`/api/posts/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ title: newTitle, content: newContent }) });
      await loadPosts();
    } catch (err) {
      alert('Failed to update: ' + err.message);
    }
    return;
  }

  if (e.target.closest('[data-like]')) {
    const heart = postEl.querySelector('[data-like]');
    const countEl = postEl.querySelector('[data-like-count]');
    const currentlyLiked = getLocalLiked(id);
    const nextLike = !currentlyLiked;
    // Optimistic UI: update heart and count immediately
    heart?.classList.toggle('liked', nextLike);
    if (heart) heart.textContent = nextLike ? '♥' : '♡';
    const cur = parseInt(countEl?.textContent || '0', 10) || 0;
    if (countEl) countEl.textContent = String(Math.max(0, cur + (nextLike ? 1 : -1)));
    setLocalLiked(id, nextLike);
    // Inform server — with try/catch that REVERTS UI on failure
    try {
      await fetchJSON(`/api/posts/${id}/like`, { method: nextLike ? 'POST' : 'DELETE' });
    } catch (err) {
      // revert on error
      setLocalLiked(id, currentlyLiked);
      heart?.classList.toggle('liked', currentlyLiked);
      if (heart) heart.textContent = currentlyLiked ? '♥' : '♡';
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
  const input = form.querySelector('textarea[name="content"]');
  const name = form.querySelector('input[name="author"]');
  const content = (input?.value || '').trim();
  const author = (name?.value || '').trim();
  if (!content) return;
  try {
    await fetchJSON(`/api/posts/${id}/comments`, { method: 'POST', body: JSON.stringify({ content, author }) });
    if (input) input.value = '';
    if (name) name.value = '';
    await loadPosts();
  } catch (err) {
    alert('Failed to comment: ' + err.message);
  }
}

// Wire up
document.getElementById('post-form')?.addEventListener('submit', onSubmitNewPost);
document.getElementById('posts')?.addEventListener('click', onPostsClick);
document.getElementById('posts')?.addEventListener('submit', onPostsSubmit);

// Start — ensure errors are shown but don't block future retries
(async () => {
  try {
    await loadPosts();
  } catch (err) {
    const list = document.getElementById('posts');
    if (list) list.innerHTML = `<div class="post">Failed to load posts: ${escapeHtml(err.message || String(err))}</div>`;
    console.error(err);
  }
})();
