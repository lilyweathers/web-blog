/*
 * File: main.js
 * Purpose: Client-side logic for the blog (rendering, search/sort, likes, comments, modals).
 * Notes:
 *  - All DOM writes are scoped to #list to avoid wiping the toolbar/new-post UI.
 *  - Event listeners are delegated so re-rendered elements continue to work.
 *  - Animations respect prefers-reduced-motion when possible.
 *  - This file was annotated on 2025-10-14 for clarity.
 */
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

// escapeHtml(str)
// Ensure user-provided strings (titles, content, author names) are rendered safely.
const escapeHtml = s =>
  String(s).replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');


// fmtDate(ms)
// Pretty-print a millisecond timestamp using the browser locale.
const fmtDate = ms => ms ? new Date(ms).toLocaleString() : '';

// fetchJSON(url, options)
// A defensive wrapper around fetch:
// - Always sends JSON Content-Type unless overridden.
// - Throws a readable Error for non-2xx responses.
// - Returns parsed JSON if Content-Type is JSON, otherwise text.
// - Treats 204 No Content as a successful `null` result.

// Fetch a JSON endpoint and throw a helpful error if the HTTP request fails.
async function fetchJSON(url, options) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const type = res.headers.get('Content-Type') || '';
  return type.includes('application/json') ? res.json() : res.text();
}


// Local remembered state for like/dislike (so the heart/thumb stays consistent
// on this device even before/after a server roundtrip).

// Read the local like state for a post id (from localStorage).
function getLiked(id) { return localStorage.getItem(LIKE_KEY(id)) === '1'; }

// Write the local like state for a post id (into localStorage).
function setLiked(id, v) { v ? localStorage.setItem(LIKE_KEY(id), '1') : localStorage.removeItem(LIKE_KEY(id)); }

// Read the local dislike state for a post id (from localStorage).
function getDisliked(id) { return localStorage.getItem(DISLIKE_KEY(id)) === '1'; }


// Write the local dislike state for a post id (into localStorage).
function setDisliked(id, v) { v ? localStorage.setItem(DISLIKE_KEY(id), '1') : localStorage.removeItem(DISLIKE_KEY(id)); }

// -----------------------------------------------------------------------------
// Loading + Rendering
// -----------------------------------------------------------------------------

//
// loadPosts()
// 1) GET the full posts list
// 2) Cache it in STATE_POSTS (used by the Edit modal to prefill fields)
// 4) Render each post into #posts (with like/dislike + comment UI)

// Render a given array of posts into the #list container using renderPost() for each item.
function renderPostsList(posts) {

  const els = (typeof getToolbarEls === 'function') ? getToolbarEls() : { list: document.getElementById('list') };
  const listEl = els.list;
  if (!listEl) return;
  const arr = Array.isArray(posts) ? posts : [];
  if (!arr.length) {
    listEl.innerHTML = '<div class="empty">No posts found.</div>';
    return;
  }
  const html = arr.map(renderPost).join('');
  listEl.innerHTML = html;

}

// Return the HTML string for a single post card: title, image (or placeholder), meta, content, controls, and comments.
function renderPost(p) {
  const likedLocal = getLiked(p.id); // local heart state

  return `
    <div class="post" data-id="${escapeHtml(p.id)}">
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
    </div>
  `;
}

// -----------------------------------------------------------------------------
// Search + Sort state 
// -----------------------------------------------------------------------------

let UI_SEARCH = '';
let UI_SORT = 'newest';

// Return references to #posts and #list containers that already exist in the DOM.
function getToolbarEls() {
  return {
    search: document.getElementById('post-search'),
    sort: document.getElementById('post-sort'),
    list: document.querySelector('#posts #list')
  };
}

// Debounce helper: delay calls to `fn` until no invocation occurs for `wait` ms.
function debounce(fn, wait) {
  let t;
  return function () {
    const args = arguments;
    clearTimeout(t);
    t = setTimeout(function () { fn.apply(null, args); }, wait || 300);
  };
}

// Render the posts from STATE_POSTS (used after edits/deletes)
function computeView() {
  const q = (UI_SEARCH || '').trim().toLowerCase();
  let rows = Array.isArray(STATE_POSTS) ? STATE_POSTS.slice() : [];
  if (q) {
    rows = rows.filter(function (p) {
      const title = (p.title || '').toLowerCase();
      const author = (p.author || '').toLowerCase();
      const content = (p.content || '').toLowerCase();
      return title.indexOf(q) !== -1 || author.indexOf(q) !== -1 || content.indexOf(q) !== -1;
    });
  }
  switch (UI_SORT) {
    case 'oldest': rows.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); }); break;
    case 'liked': rows.sort(function (a, b) { return (b.likes || 0) - (a.likes || 0); }); break;
    case 'commented': rows.sort(function (a, b) {
      const bc = Array.isArray(b.comments) ? b.comments.length : 0;
      const ac = Array.isArray(a.comments) ? a.comments.length : 0;
      return bc - ac;
    }); break;
    case 'az': rows.sort(function (a, b) { return String(a.title || '').localeCompare(String(b.title || '')); }); break;
    case 'newest':
    default: rows.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }); break;
  }
  return rows;
}

// Convert a millisecond delta into a human-readable relative time (e.g., '3m ago').
function fmtWhen(ms) {
  try { return new Date(ms || Date.now()).toLocaleString(); } catch (e) { return ''; }
}

//
// renderComments(comments)
// Renders the comment thread for a single post.
// - Empty state message when no comments.
// - Otherwise, chronological order (oldest → newest).


// Return the HTML string for the comment list of a post.
function renderComments(comments) {
  if (!Array.isArray(comments) || comments.length === 0) {
    return '<div class="comment" style="opacity:.7">No comments yet. Be the first!</div>';
  }
  var out = [];
  for (var i = 0; i < comments.length; i++) {
    var c = comments[i];
    out.push(
      '<div class="comment">' +
      '<div class="meta">' + escapeHtml(c.author || 'Anonymous') + (c.createdAt ? (' • ' + fmtWhen(c.createdAt)) : '') + '</div>' +
      escapeHtml(c.content || '') +
      '</div>'
    );
  }
  return out.join('');
}

// Re-compute the posts to show (e.g., apply search/sort) and then render the list.
function refreshPosts() {
  renderPostsList(computeView());
}

// -----------------------------
// Load + event wiring
// -----------------------------

// App bootstrap: wire up events and kick off the initial load after HTML is parsed.
document.addEventListener('DOMContentLoaded', function () {
  
  // Initial load
  loadPosts().catch(function (err) {
    var list = document.querySelector('#posts #list');
    if (list) list.innerHTML = '<div class="post" style="color:#b91c1c">Failed to load posts: ' + escapeHtml(err.message || String(err)) + '</div>';
    console.error(err);
  });

  // Toolbar
  var els = getToolbarEls();
  if (els.search) els.search.addEventListener('input', debounce(function () {
    UI_SEARCH = els.search.value || '';
    refreshPosts();
  }, 200));

  if (els.clear) els.clear.addEventListener('click', function () {
    var e2 = getToolbarEls();
    if (e2.search) e2.search.value = '';
    UI_SEARCH = '';
    refreshPosts();
    if (e2.search) e2.search.focus();
  });

  if (els.sort) els.sort.addEventListener('change', function () {
    UI_SORT = els.sort.value || 'newest';
    refreshPosts();
  });
});

// -----------------------------
// API helpers
// -----------------------------

// Fetch posts from the server, cache them in STATE_POSTS, then draw the UI (via refreshPosts() or renderFromState()).
async function loadPosts() {

  const els = (typeof getToolbarEls === 'function') ? getToolbarEls() : { list: document.getElementById('list') };
  if (els.list) els.list.innerHTML = '';
  try {
    const data = await fetchJSON('/api/posts');
    STATE_POSTS = Array.isArray(data) ? data.slice() : [];
    if (typeof refreshPosts === 'function') {
      refreshPosts();
    } else {
      renderFromState();
    }
  } catch (err) {
    if (els.list) {
      const msg = (err && err.message) ? err.message : String(err);
      els.list.innerHTML = '<div class="post">Failed to load posts: ' + escapeHtml(msg) + '</div>';
    }
    console.error(err);
  }

// Toggle like state for a post (optimistic UI) and sync with the server.
}

async function toggleLike(id, buttonEl) {
  if (!id) return;
  // Simple optimistic toggle: check text contains 'Liked'
  var isLiked = buttonEl && buttonEl.textContent.indexOf('Liked') !== -1;
  var cur = findPost(id);
  var before = (cur && cur.likes) || 0;
  if (buttonEl) buttonEl.textContent = (isLiked ? '♡ Like (' : '♥ Liked (') + String(before + (isLiked ? -1 : 1)) + ')';

  try {
    await fetchJSON('/api/posts/' + encodeURIComponent(id) + '/like', { method: isLiked ? 'DELETE' : 'POST' });
    await loadPosts();
  } catch (err) {
    if (buttonEl) buttonEl.textContent = (isLiked ? '♥ Liked (' : '♡ Like (') + String(before) + ')';
    throw err;
  }
// Delete a post by id on the server, update local state, then re-render.
}

async function deletePost(id) {
  await fetchJSON('/api/posts/' + encodeURIComponent(id), { method: 'DELETE' });
  await loadPosts();
// Add a new comment to a post on the server, update state, then re-render the post.
}

async function addComment(id, author, content) {
  await fetchJSON('/api/posts/' + encodeURIComponent(id) + '/comments', {
    method: 'POST',
    body: JSON.stringify({ author: author, content: content })
  });
  await loadPosts();
// Look up and return a post object in STATE_POSTS by id.
}

function findPost(id) {
  for (var i = 0; i < STATE_POSTS.length; i++) {
    if (String(STATE_POSTS[i].id) === String(id)) return STATE_POSTS[i];
  }
  return null;
}

// -----------------------------------------------------------------------------
// New Post creation
// -----------------------------------------------------------------------------

// onSubmitNewPost(e)
// Handles the "New Post" form:
//  - Validates title & content
//  - If an image file is chosen, uploads it via /api/uploads and uses returned URL
//  - POST /api/posts with { title, content, author, imageUrl }
//  - Resets the form and refreshes the list
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

// fileToDataUrl(file)
// Utility to convert a File into a base64 data URL for transport to the server.
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

// onPostsClick(e)
// A single delegated click handler bound to the #posts container.
// Routes actions by checking target matches on:
//  - [data-delete] → DELETE /api/posts/:id
//  - [data-edit]   → open modal pre-filled from STATE_POSTS
//  - [data-like]   → optimistic like toggle + POST/DELETE /like
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
        openModal(m);
        requestAnimationFrame(() => document.getElementById('edit-title')?.focus());
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

// onPostsSubmit(e)
// Handles the small comment form under each post:
// - Resets the form and reloads the post list
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

// showEditModal(post)
//  Fill the modal inputs with the selected post and reveal the dialog.
// Populate the Edit modal with the selected post's data and open it (focus lands on the title field).
function showEditModal(post) {
  const modal = document.getElementById('edit-modal');
  if (!modal) return;
  document.getElementById('edit-id').value = post.id || '';
  document.getElementById('edit-title').value = post.title || '';
  document.getElementById('edit-author').value = post.author || 'Anonymous';
  document.getElementById('edit-content').value = post.content || '';
  openModal(modal);
  // focus first field after open
  requestAnimationFrame(() => document.getElementById('edit-title')?.focus());
}


// hideEditModal()
// Hide the dialog and keep markup in the DOM for next use.
// Close the Edit modal using the animated close helper.
function hideEditModal() {
  const modal = document.getElementById('edit-modal');
  if (!modal) return;
  closeModal(modal);
}


// Close modal on either the X button or clicking the backdrop
document.addEventListener('click', (e) => {
  if (e.target.matches('#edit-modal [data-close]')) hideEditModal();
  if (e.target.matches('#edit-modal .modal-backdrop')) hideEditModal();
});

// Submit the Edit form:
// - PUT /api/posts/:id with { title, author, content }
// - Close the modal and refresh the posts
// Note: Bound directly since the modal exists at load in this project.
//       If markup order changes, switch to delegated 'submit' (document-level).
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

// Populate the Delete modal with the selected post's info (id/title) and open it.
function showDeleteModal({ id, title }) {
  const modal = document.getElementById('delete-modal');
  if (!modal) return;
  document.getElementById('delete-id').value = id || '';
  document.getElementById('delete-post-title').textContent = title || '(untitled)';
  openModal(modal);
  requestAnimationFrame(() => document.getElementById('delete-confirm')?.focus());
}

// Close the Delete modal using the animated close helper.
function hideDeleteModal() {
  const modal = document.getElementById('delete-modal');
  if (!modal) return;
  closeModal(modal); // removes .modal--open, waits for transitionend, then hides
}

// Close modal on either the X button or clicking the backdrop
document.addEventListener('click', (e) => {
  if (e.target.matches('#delete-modal [data-close]')) hideDeleteModal();
  if (e.target.matches('#delete-modal .modal-backdrop')) hideDeleteModal();
});


// Confirm the deletion:
// - DELETE /api/posts/:id
// - Close the modal and refresh the posts
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


// Esc key listener
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
  const last = all[all.length - 1];

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
// Generic modal open/close with animation.
// Assumes markup: <div id="...-modal" class="modal hidden"> 
// with children .modal-backdrop and .modal-card
// -----------------------------------------------------------------------------

function openModal(modal) {
  if (!modal) return;

  // remember last focus (for restoration after close)
  modal.dataset.prevFocus = (document.activeElement && document.activeElement.id) || '';

  // make visible, then animate in on next frame
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => {
    modal.classList.add('modal--open');
  });

  // Ensure the modal can receive key events and focus
  if (!modal.hasAttribute('tabindex')) modal.setAttribute('tabindex', '-1');
  try { modal.focus({ preventScroll: true }); } catch {}

  // Per-modal ESC handler (bind & store for cleanup)
  const escHandler = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (modal.id === 'delete-modal') hideDeleteModal();
    else if (modal.id === 'edit-modal') hideEditModal();
  };
  modal._escHandler = escHandler;
  modal.addEventListener('keydown', escHandler);
  document.addEventListener('keydown', escHandler);
}

function closeModal(modal) {
  if (!modal) return;

  // cleanup ESC listeners bound in openModal
  const esc = modal._escHandler;
  if (esc) {
    modal.removeEventListener('keydown', esc);
    document.removeEventListener('keydown', esc);
    delete modal._escHandler;
  }

  // start exit transition
  modal.classList.remove('modal--open');

  // transition target: support either .modal-card or .delete-modal-card
  const card = modal.querySelector('.modal-card  .delete-modal-card') || modal;

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');

    // restore focus
    const prevId = modal.dataset.prevFocus;
    if (prevId) {
      const prev = document.getElementById(prevId);
      if (prev) prev.focus();
    }
  };

  const onEnd = (e) => {
    if (e && e.target !== card) return;
    card.removeEventListener('transitionend', onEnd);
    finish();
  };
  card.addEventListener('transitionend', onEnd);

  // Fallback in case transitionend doesn't fire
  setTimeout(finish, 400);
}


// -----------------------------------------------------------------------------
// Collapsible "New Post" panel
// -----------------------------------------------------------------------------

// Toggle the visibility of the New Post form when the + button is pressed.
// Uses aria-expanded for accessibility and the [hidden] attribute for CSS.
document.addEventListener('click', function /*__NP_COLLAPSE_TOGGLE__*/(e) {
  const btn = e.target.closest('#np-toggle');
  if (!btn) return;
  const form = document.getElementById('post-form');
  if (!form) return;

  const expanded = btn.getAttribute('aria-expanded') === 'true';
  btn.setAttribute('aria-expanded', String(!expanded));

  if (expanded) {
    collapseForm(form);
  } else {
    expandForm(form);
  }
});


// -----------------------------------------------------------------------------
// --- Animated show/hide for #post-form ---
// -----------------------------------------------------------------------------


// Animate opening of the New Post form using height+opacity transition and keep it in an 'open' state.
function expandForm(el) {
  if (!el) return;

  // Make sure it's measurable
  el.hidden = false;
  el.style.removeProperty('display');

  // Start from 0 → target height
  el.style.height = '0px';
  el.style.opacity = '0';
  el.style.transition = 'height 260ms ease, opacity 180ms ease';

  // Next frame, animate to full height
  requestAnimationFrame(() => {
    const target = el.scrollHeight;
    el.style.height = target + 'px';
    el.style.opacity = '1';
    el.addEventListener('transitionend', function onEnd(e) {
      if (e.propertyName !== 'height') return;
      el.removeEventListener('transitionend', onEnd);
      // Clear inline styles so the form can grow naturally later
      el.style.height = '';
      el.style.transition = '';
    });
  });
}

// Animate closing of the New Post form, set hidden at the end of the transition for accessibility.
function collapseForm(el) {
  if (!el) return;

  // Fix current height (auto → px) so we can animate to 0
  const current = el.getBoundingClientRect().height;
  el.style.height = current + 'px';
  el.style.opacity = getComputedStyle(el).opacity;
  el.style.transition = 'height 260ms ease, opacity 180ms ease';

  requestAnimationFrame(() => {
    el.style.height = '0px';
    el.style.opacity = '0';
    el.addEventListener('transitionend', function onEnd(e) {
      if (e.propertyName !== 'height') return;
      el.removeEventListener('transitionend', onEnd);
      el.hidden = true;        // restore your original hidden state
      // Clean up inline styles
      el.style.height = '';
      el.style.transition = '';
      el.style.opacity = '';
    });
  });
}

// Render posts from STATE_POSTS after filtering/sorting based on current UI controls.
function renderFromState() {

  const els = (typeof getToolbarEls === 'function') ? getToolbarEls() : { list: document.getElementById('list') };
  const listEl = els.list;
  if (!listEl) return;
  const arr = (typeof filterAndSort === 'function') ? filterAndSort(STATE_POSTS) : (Array.isArray(STATE_POSTS) ? STATE_POSTS : []);
  if (!arr.length) {
    listEl.innerHTML = '<div class="empty">No posts found.</div>';
    return;
  }
  listEl.innerHTML = arr.map(renderPost).join('');
}
