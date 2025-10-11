/* like.js — fully commented, no dependencies
   - Keeps a local “liked” set in localStorage (so the red heart is remembered per browser)
   - Sends POST/DELETE to your server to persist the *count* in posts.json
   - Uses "optimistic UI": updates the UI *before* the server confirms, then reconciles (explained below)
*/

// ---- Local storage helpers -------------------------------------------------

// Key where we store liked post IDs in this browser
const LIKED_KEY = 'likedPostIds';

// Read liked IDs from localStorage -> Set<string>
function getLikedSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem(LIKED_KEY) || '[]'));
  } catch {
    // If parsing fails for any reason, start fresh
    return new Set();
  }
}

// Save liked IDs Set<string> back to localStorage
function saveLikedSet(set) {
  localStorage.setItem(LIKED_KEY, JSON.stringify([...set]));
}

// ---- Server helpers --------------------------------------------------------

// Fetch all posts (so we can sync the like counts on page load)
async function fetchPostsForInit() {
  try {
    const r = await fetch('/api/posts');
    if (!r.ok) return [];
    return await r.json(); // expected: [{ id, likes, ... }, ...]
  } catch {
    return [];
  }
}

// Send +1 (POST) or −1 (DELETE) like to the server
async function persistLikeToServer(postId, likedNow) {
  const url = `/api/posts/${encodeURIComponent(String(postId))}/like`;
  const method = likedNow ? 'POST' : 'DELETE';
  const r = await fetch(url, { method });
  if (!r.ok) {
    // e.g., 404/500 -> throw so caller can handle/revert optimistic UI
    throw new Error(`Server error: ${r.status}`);
  }
  return r.json(); // expected: { id, likes }
}

// ---- UI helpers ------------------------------------------------------------

// Given a post container element, returns references to key parts
function getLikeElements(container) {
  return {
    btn: container.matches('button, .like-btn')
      ? container
      : container.querySelector('.like-btn, button'),
    countEl: container.querySelector('.like-count') || container.querySelector('[data-like-count]'),
    heartEl: container.querySelector('.heart') || container.querySelector('[data-heart]'),
  };
}

// Apply initial state for one post: count from server, heart from local storage
function applyInitialStateForPost(container, serverPost, likedSet) {
  const id = String(container.getAttribute('data-post-id'));
  const { btn, countEl, heartEl } = getLikeElements(container);

  // 1) Use server likes to set the number (source of truth for counts)
  if (serverPost && countEl && typeof serverPost.likes === 'number') {
    countEl.textContent = String(serverPost.likes);
  }

  // 2) Use local storage to set the heart (source of truth for per-browser liked state)
  const isLiked = likedSet.has(id);
  if (btn) {
    btn.classList.toggle('liked', isLiked);
    btn.setAttribute('aria-pressed', isLiked ? 'true' : 'false');
  }
  if (heartEl) {
    heartEl.textContent = isLiked ? '❤' : '♡';
  }
}

// Initialize all posts found on the page
async function initializeLikes() {
  const [postsFromServer, likedSet] = [await fetchPostsForInit(), getLikedSet()];
  document.querySelectorAll('[data-post-id]').forEach(container => {
    const id = String(container.getAttribute('data-post-id'));
    const serverPost = postsFromServer.find(p => String(p.id) === id);
    applyInitialStateForPost(container, serverPost, likedSet);
  });
}

// ---- Optimistic like toggle ------------------------------------------------

// Handle a click anywhere within a post’s like area
async function handleLikeClick(target) {
  // Find the *closest* element that represents a given post
  // We allow clicking either the .like-btn or any child with [data-like]
  const container =
    target.closest('[data-post-id]') ||
    target.closest('.like-btn')?.closest('[data-post-id]');
  if (!container) return;

  const id = container.getAttribute('data-post-id') || container.dataset.postId;
  if (!id) return;

  const { btn, countEl, heartEl } = getLikeElements(container);
  const likedSet = getLikedSet();
  const wasLiked = likedSet.has(String(id));
  const willBeLiked = !wasLiked;

  // Read current count safely
  const currentCount = Number(countEl?.textContent || '0');

  // -----------------------------
  // OPTIMISTIC UI UPDATE (instant)
  // Update the UI *before* asking the server.
  // This makes the app feel snappy even with network delay.
  // -----------------------------
  const optimisticCount = Math.max(0, currentCount + (willBeLiked ? 1 : -1));

  if (countEl) countEl.textContent = String(optimisticCount);
  if (heartEl) heartEl.textContent = willBeLiked ? '❤' : '♡';
  if (btn) {
    btn.classList.toggle('liked', willBeLiked);
    btn.setAttribute('aria-pressed', willBeLiked ? 'true' : 'false');
  }

  // Update local storage immediately to remember the heart in this browser
  if (willBeLiked) likedSet.add(String(id)); else likedSet.delete(String(id));
  saveLikedSet(likedSet);

  try {
    // Talk to the server to persist the count
    const resp = await persistLikeToServer(id, willBeLiked);

    // Reconcile: if the server replies with a definitive number, use it
    if (countEl && typeof resp?.likes === 'number') {
      countEl.textContent = String(resp.likes);
    }
  } catch (err) {
    // -----------------------------
    // REVERT on failure
    // If the server fails, we undo the optimistic updates
    // so the UI stays accurate.
    // -----------------------------
    if (countEl) countEl.textContent = String(currentCount);
    if (heartEl) heartEl.textContent = wasLiked ? '❤' : '♡';
    if (btn) {
      btn.classList.toggle('liked', wasLiked);
      btn.setAttribute('aria-pressed', wasLiked ? 'true' : 'false');
    }

    const revertSet = getLikedSet();
    if (wasLiked) revertSet.add(String(id)); else revertSet.delete(String(id));
    saveLikedSet(revertSet);

    alert('Could not save your like. Please try again.');
    // You could also log `err` to the console for debugging
    // console.error(err);
  }
}

// ---- Global event listeners -----------------------------------------------

// Delegate clicks anywhere in the document; react only if they happen on a like control
document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.closest('.like-btn') || t.closest('[data-like]')) {
    handleLikeClick(t);
  }
});

// Initialize hearts/counts when DOM is ready
document.addEventListener('DOMContentLoaded', initializeLikes);
