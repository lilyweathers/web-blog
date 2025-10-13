/**
 * main.js — Client-side controller for the blog
 * -------------------------------------------------------------------------
 * Responsibilities
 *  - Fetch posts from the server and render them (newest first)
 *  - Create new posts (with optional image upload)
 *  - Edit existing posts via a modal dialog
 *  - Delete posts
 *  - Like/Dislike toggles with optimistic UI + local remembered state
 *  - Comment creation per post
 *
 * How data flows
 *  - Server persistence lives in /data/posts.json behind simple REST endpoints:
 *      GET    /api/posts
 *      POST   /api/posts
 *      PUT    /api/posts/:id
 *      DELETE /api/posts/:id
 *      POST   /api/posts/:id/like     | DELETE /api/posts/:id/like
 *      POST   /api/posts/:id/dislike  | DELETE /api/posts/:id/dislike
 *      POST   /api/posts/:id/comments
 *      POST   /api/uploads  (accepts { dataUrl } and returns { url })
 *
 * Patterns used
 *  - Event delegation: a single click/submit listener deals with many buttons/forms.
 *  - Optimistic UI: likes/dislikes flip immediately and roll back on failure.
 *  - Defensive networking: fetchJSON raises rich errors and tolerates 204 No Content.
 */

let STATE_POSTS = []; // Client-side cache of the latest list returned by GET /api/posts

// Short-hand selector. Used sparingly for top-level hooks.
const $ = sel => document.querySelector(sel);

// Keys for remembering local like/dislike state per post (independent of server count)
const LIKE_KEY = id => `liked:${id}`;
const DISLIKE_KEY = id => `disliked:${id}`;

// -----------------------------------------------------------------------------
// Tiny utilities
// -----------------------------------------------------------------------------

/**
 * escapeHtml(str)
 * Ensure user-provided strings (titles, content, author names) are rendered safely.
 */
const escapeHtml = s =>
  String(s).replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * fmtDate(ms)
 * Pretty-print a millisecond timestamp using the browser locale.
 */
const fmtDate = ms => ms ? new Date(ms).toLocaleString() : '';

/**
 * fetchJSON(url, options)
 * A defensive wrapper around fetch:
 *  - Always sends JSON Content-Type unless overridden.
 *  - Throws a readable Error for non-2xx responses.
 *  - Returns parsed JSON if Content-Type is JSON, otherwise text.
 *  - Treats 204 No Content as a successful `null` result.
 */
async function fetchJSON(url, options) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const type = res.headers.get('Content-Type') || '';
  return type.includes('application/json') ? res.json() : res.text();
}

/**
 * Local remembered state for like/dislike (so the heart/thumb stays consistent
 * on this device even before/after a server roundtrip).
 */
function getLiked(id) { return localStorage.getItem(LIKE_KEY(id)) === '1'; }
function setLiked(id, v) { v ? localStorage.setItem(LIKE_KEY(id), '1') : localStorage.removeItem(LIKE_KEY(id)); }

function getDisliked(id) { return localStorage.getItem(DISLIKE_KEY(id)) === '1'; }
function setDisliked(id, v) { v ? localStorage.setItem(DISLIKE_KEY(id), '1') : localStorage.removeItem(DISLIKE_KEY(id)); }

// -----------------------------------------------------------------------------
// Loading + Rendering
// -----------------------------------------------------------------------------

/**
 * loadPosts()
 * 1) GET the full posts list
 * 2) Cache it in STATE_POSTS (used by the Edit modal to prefill fields)
 * 3) Sort newest-first by createdAt
 * 4) Render each post into #posts (with like/dislike + comment UI)
 */
async function loadPosts() {
  const data = await fetchJSON('/api/posts');

  // Keep an immutable snapshot so we can search by id for edit-prefill
  STATE_POSTS = Array.isArray(data) ? data.slice() : [];

  // Display newest first (fallback to 0 if missing createdAt)
  const posts = data.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const root = $('#posts');
  if (!root) return;

  // Clear and re-render in one pass for simplicity
  root.innerHTML = '<h2>Posts</h2>';
  for (const p of posts) {
    const likedLocal = getLiked(p.id);

    // Build one post element
    const div = document.createElement('div');
    div.className = 'post';
    div.dataset.id = p.id; // critical: used to target server actions

    // Prefer the post's imageUrl; otherwise show the placeholder
    div.innerHTML = `
      <h3>${escapeHtml(p.title || '')}</h3>
      ${p.imageUrl
        ? `<div class="image"><img src="${escapeHtml(p.imageUrl)}" alt="" loading="lazy" /></div>`
        : `<div class="image"><img src="/uploads/placeholder.svg" alt="" loading="lazy" /></div>`}
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
          <span class="dislike-wrap" title="Dislike">
            <span class="thumb" data-dislike>${getDisliked(p.id) ? "👎" : "👎"}</span>
            <span class="dislike-count" data-dislike-count>${p.dislikes || 0}</span>
          </span>
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

/**
 * renderComments(comments)
 * Renders the comment thread for a single post.
 * - Empty state message when no comments.
 * - Otherwise, chronological order (oldest → newest).
 */
function renderComments(comments) {
  if (!Array.isArray(comments) || comments.length === 0) {
    return `<div class="comment" style="opacity:.7">No comments yet. Be the first!</div>`;
  }
  return comments
    .slice()
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .map(c => `<div class="comment">
                 <div class="meta">${escapeHtml(c.author || 'Anonymous')}${c.createdAt ? ' • ' + fmtDate(c.createdAt) : ''}</div>
                 ${escapeHtml(c.content || '')}
               </div>`)
    .join('');
}

// -----------------------------------------------------------------------------
// New Post creation
// -----------------------------------------------------------------------------

/**
 * onSubmitNewPost(e)
 * Handles the "New Post" form:
 *  - Validates title & content
 *  - If an image file is chosen, uploads it via /api/uploads and uses returned URL
 *  - POST /api/posts with { title, content, author, imageUrl }
 *  - Resets the form and refreshes the list
 */
async function onSubmitNewPost(e) {
  e.preventDefault();

  // Read form values
  const title = document.getElementById('title')?.value.trim();
  const content = document.getElementById('content')?.value.trim();
  const author = document.getElementById('author')?.value.trim();
  const fileInput = document.getElementById('image');

  if (!title || !content) {
    alert('Please provide a title and content');
    return;
  }

  let imageUrl = '';
  try {
    // If a file is selected, convert to data URL and ask server to save it
    if (fileInput?.files?.[0]) {
      const dataUrl = await fileToDataUrl(fileInput.files[0]);
      const up = await fetch('/api/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl })
      });
      if (!up.ok) throw new Error(await up.text() || 'Upload failed');
      const out = await up.json();
      imageUrl = out.url || ''; // server returns the public URL (e.g., /uploads/xxx.jpg)
    }

    // Create the post itself
    await fetchJSON('/api/posts', {
      method: 'POST',
      body: JSON.stringify({ title, content, author, imageUrl })
    });

    // Reset & refresh
    document.getElementById('post-form')?.reset();
    await loadPosts();
  } catch (err) {
    alert('Failed to create post: ' + (err.message || err));
  }
}

/**
 * fileToDataUrl(file)
 * Utility to convert a File into a base64 data URL for transport to the server.
 */
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// -----------------------------------------------------------------------------
// Post list interactions (delete, edit, like, dislike)
// -----------------------------------------------------------------------------

/**
 * onPostsClick(e)
 * A single delegated click handler bound to the #posts container.
 * Routes actions by checking target matches on:
 *  - [data-delete] → DELETE /api/posts/:id
 *  - [data-edit]   → open modal pre-filled from STATE_POSTS
 *  - [data-like]   → optimistic like toggle + POST/DELETE /like
 *  - [data-dislike]→ optimistic dislike toggle + POST/DELETE /dislike
 */
async function onPostsClick(e) {
  const postEl = e.target.closest('.post');
  if (!postEl) return;
  const id = postEl.dataset.id;

  // --- Delete ---------------------------------------------------------------
  if (e.target.matches('button[data-delete]')) {
    if (e.target.matches('button[data-delete]')) {
      const postEl = e.target.closest('.post');
      const id = postEl?.dataset.id;
      const title = postEl?.querySelector('h3')?.textContent || '';
      showDeleteModal({ id, title });
      return; // stop here so it doesn't fall through to other actions
    }
  }

  // --- Edit (open modal) ----------------------------------------------------
  if (e.target.matches('button[data-edit]')) {
    const id = postEl.dataset.id;
    const post = (STATE_POSTS || []).find(p => String(p.id) === String(id));
    if (post) {
      const m = document.getElementById('edit-modal');
      if (m) {
        (document.getElementById('edit-id') || document.querySelector('[name="edit-id"]')).value = post.id ?? '';
        (document.getElementById('edit-title') || document.querySelector('[name="edit-title"]')).value = post.title ?? '';
        (document.getElementById('edit-author') || document.querySelector('[name="edit-author"]')).value = post.author ?? '';
        (document.getElementById('edit-content') || document.querySelector('[name="edit-content"]')).value = post.content ?? '';
        m.classList.remove('hidden');
        m.setAttribute('aria-hidden', 'false');
      }
    }
    return; // stop early so this click doesn't bubble into other handlers
  }

  // --- Like (optimistic toggle with rollback) -------------------------------
  if (e.target.closest('[data-like]')) {
    const heart = postEl.querySelector('[data-like]');
    const countEl = postEl.querySelector('[data-like-count]');

    const wasLiked = getLiked(id);
    const nextLiked = !wasLiked;
    const cur = parseInt(countEl?.textContent || '0', 10) || 0;

    // Immediate UI change
    heart?.classList.toggle('liked', nextLiked);
    if (heart) heart.textContent = nextLiked ? '♥' : '♡';
    if (countEl) countEl.textContent = String(Math.max(0, cur + (nextLiked ? 1 : -1)));
    setLiked(id, nextLiked);

    // Persist to server, roll back if it fails
    try {
      await fetchJSON(`/api/posts/${encodeURIComponent(id)}/like`, { method: nextLiked ? 'POST' : 'DELETE' });
    } catch (err) {
      setLiked(id, wasLiked);
      heart?.classList.toggle('liked', wasLiked);
      if (heart) heart.textContent = wasLiked ? '♥' : '♡';
      if (countEl) countEl.textContent = String(cur);
      alert('Failed to update like: ' + err.message);
    }
  }

  // --- Dislike (optimistic toggle with rollback) ----------------------------
  if (e.target.closest('[data-dislike]')) {
    const thumb = postEl.querySelector('[data-dislike]');
    const countEl = postEl.querySelector('[data-dislike-count]');

    const was = getDisliked(id);
    const next = !was;
    const cur = Number(countEl?.textContent || 0);

    // Immediate UI change
    if (countEl) countEl.textContent = String(Math.max(0, cur + (next ? 1 : -1)));
    if (thumb) thumb.textContent = next ? '👎' : '👎';
    setDisliked(id, next);

    // Persist to server, roll back on error
    try {
      await fetchJSON(`/api/posts/${encodeURIComponent(id)}/dislike`, { method: next ? 'POST' : 'DELETE' });
    } catch (err) {
      setDisliked(id, was);
      if (thumb) thumb.textContent = was ? '👎' : '👎';
      if (countEl) countEl.textContent = String(cur);
      alert('Failed to update dislike: ' + err.message);
    }
    return;
  }
}

// -----------------------------------------------------------------------------
// Comment submission (per-post form in the list)
// -----------------------------------------------------------------------------

/**
 * onPostsSubmit(e)
 * Handles the small comment form under each post:
 *  - POST /api/posts/:id/comments with { content, author }
 *  - Resets the form and reloads the post list
 */
async function onPostsSubmit(e) {
  const form = e.target.closest('form[data-comment]');
  if (!form) return;
  e.preventDefault();

  const postEl = e.target.closest('.post');
  const id = postEl?.dataset.id;

  const content = form.querySelector('textarea[name="content"]')?.value.trim();
  const author = form.querySelector('input[name="author"]')?.value.trim();
  if (!content) return;

  try {
    await fetchJSON(`/api/posts/${encodeURIComponent(id)}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content, author })
    });
    form.reset();
    await loadPosts();
  } catch (err) {
    alert('Failed to comment: ' + err.message);
  }
}

// -----------------------------------------------------------------------------
// Wire up page-level listeners
// -----------------------------------------------------------------------------

// New Post form
document.getElementById('post-form')?.addEventListener('submit', onSubmitNewPost);

// Post list (delegation for delete/edit/like/dislike)
document.getElementById('posts')?.addEventListener('click', onPostsClick);

// Per-post comment form (delegation)
document.getElementById('posts')?.addEventListener('submit', onPostsSubmit);

// Initial load with error display fallback (never leave a blank screen)
(async () => {
  try {
    await loadPosts();
  } catch (err) {
    const root = document.getElementById('posts');
    if (root) root.innerHTML = `<div class="post">Failed to load posts: ${escapeHtml(err.message || String(err))}</div>`;
    console.error(err);
  }
})();

// -----------------------------------------------------------------------------
// Edit modal helpers & submit
// -----------------------------------------------------------------------------

/**
 * showEditModal(post)
 * Fill the modal inputs with the selected post and reveal the dialog.
 */
function showEditModal(post) {
  const modal = document.getElementById('edit-modal');
  if (!modal) return;
  document.getElementById('edit-id').value = post.id || '';
  document.getElementById('edit-title').value = post.title || '';
  document.getElementById('edit-author').value = post.author || 'Anonymous';
  document.getElementById('edit-content').value = post.content || '';
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

/**
 * hideEditModal()
 * Hide the dialog and keep markup in the DOM for next use.
 */
function hideEditModal() {
  const modal = document.getElementById('edit-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

// Close modal on either the X button or clicking the backdrop
document.addEventListener('click', (e) => {
  if (e.target.matches('#edit-modal [data-close]')) hideEditModal();
  if (e.target.matches('#edit-modal .modal-backdrop')) hideEditModal();
});

/**
 * Submit the Edit form:
 *  - PUT /api/posts/:id with { title, author, content }
 *  - Close the modal and refresh the posts
 * Note: Bound directly since the modal exists at load in this project.
 *       If markup order changes, switch to delegated 'submit' (document-level).
 */
document.getElementById('edit-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();

  const id = document.getElementById('edit-id')?.value;
  const title = document.getElementById('edit-title')?.value.trim();
  const author = document.getElementById('edit-author')?.value.trim();
  const content = document.getElementById('edit-content')?.value.trim();

  if (!id || !title || !content) {
    alert('Please fill out Title and Content');
    return;
  }

  try {
    await fetchJSON(`/api/posts/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ title, author, content })
    });
    hideEditModal();
    await loadPosts();
  } catch (err) {
    alert('Failed to update: ' + (err.message || err));
  }
});

// -----------------------------------------------------------------------------
// Delete modal helpers & submit
// -----------------------------------------------------------------------------

function showDeleteModal({ id, title }) {
  const modal = document.getElementById('delete-modal');
  if (!modal) return;
  document.getElementById('delete-id').value = id;
  document.getElementById('delete-post-title').textContent = title || '(untitled)';
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');

  // focus first meaningful control (Delete)
  setTimeout(() => document.getElementById('delete-confirm')?.focus(), 0);
}

function hideDeleteModal() {
  const modal = document.getElementById('delete-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

// Close modal on either the X button or clicking the backdrop
document.addEventListener('click', (e) => {
  if (e.target.matches('#delete-modal [data-close]')) hideDeleteModal();
  if (e.target.matches('#delete-modal .modal-backdrop')) hideEDeleterModal();
});

/**
 * Confirm the deletion:
 *  - DELETE /api/posts/:id
 *  - Close the modal and refresh the posts
 */
document.getElementById('delete-confirm')?.addEventListener('click', async () => {
  const id = document.getElementById('delete-id')?.value;
  if (!id) return;
  try {
    await fetchJSON(`/api/posts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    hideDeleteModal();
    await loadPosts();
  } catch (err) {
    // optional: toast instead of alert
    alert('Failed to delete: ' + (err.message || err));
  }
});

// -----------------------------------------------------------------------------
// Modal close keydown
// -----------------------------------------------------------------------------

function getOpenModal() {
  return document.querySelector('.modal:not(.hidden)');
}

// Focus the first meaningful element in a modal
function focusFirstIn(modal) {
  if (!modal) return;
  const focusables = modal.querySelectorAll(
    'a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])'
  );
  for (const el of focusables) {
    // skip hidden/disabled
    const style = window.getComputedStyle(el);
    if (el.disabled) continue;
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    el.focus();
    break;
  }
}

// Remember the element that opened the modal; restore it on close
function openModal(modal) {
  if (!modal) return;
  modal.dataset.prevFocus = (document.activeElement && document.activeElement.id) || '';
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  // focus after it’s visible
  requestAnimationFrame(() => focusFirstIn(modal));
}

function closeModal(modal) {
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  const prevId = modal.dataset.prevFocus || '';
  if (prevId) {
    const prev = document.getElementById(prevId);
    if (prev) prev.focus();
  }
}

document.addEventListener('keydown', (e) => {
  const modal = getOpenModal();
  if (!modal) return; // no modal open

  if (e.key === 'Escape') {
    closeModal(modal);
    return;
  }

  if (e.key !== 'Tab') return;

  // Collect focusable elements inside the open modal
  const all = Array.from(
    modal.querySelectorAll('a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])')
  ).filter(el => {
    const cs = window.getComputedStyle(el);
    return !el.disabled && cs.display !== 'none' && cs.visibility !== 'hidden';
  });

  if (!all.length) return;

  const first = all[0];
  const last  = all[all.length - 1];

  // If focus has left the modal (rare), bring it back
  if (!modal.contains(document.activeElement)) {
    first.focus();
    e.preventDefault();
    return;
  }

  // Wrap focus
  if (e.shiftKey && document.activeElement === first) {
    last.focus();
    e.preventDefault();
  } else if (!e.shiftKey && document.activeElement === last) {
    first.focus();
    e.preventDefault();
  }
});

// -----------------------------------------------------------------------------
// Collapsible "New Post" panel
// -----------------------------------------------------------------------------

/**
 * Toggle the visibility of the New Post form when the + button is pressed.
 * Uses aria-expanded for accessibility and the [hidden] attribute for CSS.
 */
document.addEventListener('click', function /*__NP_COLLAPSE_TOGGLE__*/(e) {
  const btn = e.target.closest('#np-toggle');
  if (!btn) return;
  const form = document.getElementById('post-form');
  if (!form) return;
  const expanded = btn.getAttribute('aria-expanded') === 'true';
  btn.setAttribute('aria-expanded', String(!expanded));
  if (expanded) form.setAttribute('hidden', '');
  else form.removeAttribute('hidden');
});
