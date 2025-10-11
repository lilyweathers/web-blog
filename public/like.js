// No-deps like client: red-heart stored locally, counts persisted on server
const LIKED_KEY = 'likedPostIds';

function getLikedSet() {
  try { return new Set(JSON.parse(localStorage.getItem(LIKED_KEY) || '[]')); }
  catch { return new Set(); }
}
function saveLikedSet(set) {
  localStorage.setItem(LIKED_KEY, JSON.stringify([...set]));
}

async function fetchPosts() {
  try {
    const r = await fetch('/api/posts');
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

function initHearts(posts) {
  const liked = getLikedSet();
  document.querySelectorAll('[data-post-id]').forEach(el => {
    const id = String(el.getAttribute('data-post-id'));
    const btn = el.matches('button, .like-btn') ? el : el.querySelector('.like-btn, button');
    const countEl = el.querySelector('.like-count') || el.querySelector('[data-like-count]');
    const heartEl = el.querySelector('.heart') || el.querySelector('[data-heart]');
    const server = posts.find(p => String(p.id) === id);
    if (server && countEl && typeof server.likes === 'number') countEl.textContent = String(server.likes);
    const isLiked = liked.has(id);
    if (btn) {
      btn.classList.toggle('liked', isLiked);
      btn.setAttribute('aria-pressed', isLiked ? 'true' : 'false');
    }
    if (heartEl) heartEl.textContent = isLiked ? '❤' : '♡';
  });
}

async function handleLikeClick(target) {
  const container = target.closest('[data-post-id]') || target.closest('.like-btn');
  if (!container) return;
  const id = container.getAttribute('data-post-id') || container.dataset.postId;
  if (!id) return;

  const btn = container.matches('button, .like-btn') ? container : container.querySelector('.like-btn, button');
  const countEl = container.querySelector('.like-count') || container.querySelector('[data-like-count]');
  const heartEl = container.querySelector('.heart') || container.querySelector('[data-heart]');

  const liked = getLikedSet();
  const wasLiked = liked.has(String(id));
  let count = Number(countEl?.textContent || '0');

  // optimistic
  const nextCount = Math.max(0, count + (wasLiked ? -1 : +1));
  if (countEl) countEl.textContent = String(nextCount);
  if (heartEl) heartEl.textContent = wasLiked ? '♡' : '❤';
  if (btn) {
    btn.classList.toggle('liked', !wasLiked);
    btn.setAttribute('aria-pressed', (!wasLiked).toString());
  }
  if (wasLiked) liked.delete(String(id)); else liked.add(String(id));
  saveLikedSet(liked);

  try {
    const url = `/api/posts/${encodeURIComponent(String(id))}/like`;
    const r = await fetch(url, { method: wasLiked ? 'DELETE' : 'POST' });
    if (!r.ok) throw new Error('Server error');
    const data = await r.json();
    if (countEl && typeof data.likes === 'number') countEl.textContent = String(data.likes);
  } catch (e) {
    // revert if failed
    if (countEl) countEl.textContent = String(count);
    if (heartEl) heartEl.textContent = wasLiked ? '❤' : '♡';
    if (btn) {
      btn.classList.toggle('liked', wasLiked);
      btn.setAttribute('aria-pressed', wasLiked.toString());
    }
    const s = getLikedSet();
    if (wasLiked) s.add(String(id)); else s.delete(String(id));
    saveLikedSet(s);
    alert('Could not save your like. Please try again.');
  }
}

document.addEventListener('click', (e) => {
  const trg = e.target;
  if (trg.closest('.like-btn') || trg.closest('[data-like]')) {
    handleLikeClick(trg);
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  const posts = await fetchPosts();
  initHearts(posts);
});
