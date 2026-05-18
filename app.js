// ---------------------------------------------------------------------------
// Oomycota - Static Music Player
// ---------------------------------------------------------------------------

// --- State ---

let tracks = [];          // full track list from tracks.json
let playlists = [];       // playlist definitions from tracks.json
let upNext = [];          // indices of tracks queued after the current one
let nowPlaying = -1;      // index of the currently loaded track (-1 = nothing)
let history = [];         // indices of previously played tracks
let originalQueue = [];   // pre-shuffle copy of upNext for restoring order

let playing = false;
let shuffleOn = false;
let repeatMode = 0;       // 0 = off, 1 = repeat all, 2 = repeat one
let activeFilter = null;  // null = all, 'fav' = favorites, number = playlist index
let seeking = false;
let contextTrack = -1;    // track index for the open context menu

const audio = document.getElementById('au');
const favorites = new Set();

// Artwork blob cache: Map<resolvedArtUrl, blobUrl>
// Keeps blob URLs alive so the media session can always fetch them.
// Max 3 entries (current + next + one stale) to avoid memory leaks.
const _artworkBlobs = new Map();
const _ARTWORK_CACHE_MAX = 3;

// Restore saved favorites
try {
  JSON.parse(localStorage.getItem('oo_fav') || '[]').forEach(f => favorites.add(f));
} catch {}

// Register service worker and request persistent storage
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}


// --- Toast notifications ---

let toastTimer;

function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
}


// --- Initialization ---

async function init() {
  try {
    const response = await fetch('tracks.json');
    if (!response.ok) throw 0;
    const data = await response.json();
    tracks = data.tracks || (Array.isArray(data) ? data : []);
    playlists = data.playlists || [];
  } catch {
    tracks = [];
  }
  // Pre-compute lowercased search field so handleSearch avoids
  // re-lowercasing 2k strings on every keystroke
  tracks.forEach(t => {
    t._s = (t.title + '\0' + (t.artist || '') + '\0' + (t.album || '')).toLowerCase();
  });
  renderChips();
  renderTrackList();
  restoreState();
}



// --- Playlist filter chips ---

function renderChips() {
  const container = document.getElementById('chips');
  let html = `<div class="chip ${activeFilter === null ? 'on' : ''}" onclick="setFilter(null)">All</div>`;

  if (favorites.size > 0) {
    html += `<div class="chip ${activeFilter === 'fav' ? 'on' : ''}" onclick="setFilter('fav')">` +
      `<svg width="12" height="12" viewBox="0 0 24 24" fill="var(--fav)" style="vertical-align:middle;margin-right:4px;margin-top:-1px"><use href="#i-heart"/></svg>Favorites</div>`;
  }

  playlists.forEach((pl, i) => {
    const artChip = pl.art
      ? `<span class="chip-art"><img src="${escapeHTML(pl.art)}"></span>`
      : (pl.icon ? pl.icon + ' ' : '');
    html += `<div class="chip ${activeFilter === i ? 'on' : ''}" onclick="setFilter(${i})">${artChip}${escapeHTML(pl.name)}</div>`;
  });

  container.innerHTML = html;
}

function setFilter(filter) {
  activeFilter = filter;
  renderChips();
  renderTrackList();
}


// --- Virtual scrolling ---

const ROW_H = 77;    // .ti height: 10px pad + 56px art + 10px pad + 1px border
const VBUF = 8;       // extra rows rendered above/below viewport
const HIST_MAX = 200; // max history entries kept in memory
let vState = null;    // { indices, tl, lastStart, lastEnd }
let vRaf = false;     // requestAnimationFrame guard

function onTrackScroll() {
  if (!vRaf) {
    vRaf = true;
    requestAnimationFrame(() => { vRaf = false; vRenderVisible(); });
  }
}

function vRenderVisible() {
  if (!vState) return;
  const container = document.getElementById('tracks');
  const { indices, tl } = vState;
  const top = container.scrollTop;
  const h = container.clientHeight;

  let s = Math.max(0, Math.floor(top / ROW_H) - VBUF);
  let e = Math.min(indices.length, Math.ceil((top + h) / ROW_H) + VBUF);

  if (s === vState.lastStart && e === vState.lastEnd) return;
  vState.lastStart = s;
  vState.lastEnd = e;

  let html = '';
  for (let i = s; i < e; i++) {
    const idx = indices[i];
    const track = tracks[idx];
    if (!track) continue;

    const dur = track.dur ? formatTime(track.dur) : '';
    const isNP = idx === nowPlaying;
    const isFav = favorites.has(track.file);
    const cls = ['ti', isNP ? 'np' : '', track._err ? 'err' : ''].filter(Boolean).join(' ');

    html += `<div class="${cls}" data-i="${idx}" style="position:absolute;top:${i * ROW_H}px;left:0;right:0" onclick="playTrack(${idx})" oncontextmenu="showContextMenu(event,${idx})" ontouchstart="longPressStart(event,${idx})" ontouchend="longPressEnd()" ontouchmove="longPressEnd()">
      <div class="ti-art">${renderArt(track)}<div class="ov"><svg viewBox="0 0 24 24"><use href="${isNP && playing ? '#i-pause' : '#i-play'}"/></svg></div></div>
      <div class="ti-info"><div class="ti-title">${escapeHTML(track.title)}</div><div class="ti-sub">${escapeHTML(track.artist || 'Unknown')}${track.album ? ' &middot; ' + escapeHTML(track.album) : ''}</div></div>
      <div class="ti-r">
        <button class="ti-fav ${isFav ? 'on' : ''}" onclick="event.stopPropagation();toggleFavorite(${idx})"><svg width="14" height="14" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><use href="${isFav ? '#i-heart' : '#i-heart-o'}"/></svg></button>
        <div class="ti-dur">${dur}</div>
      </div></div>`;
  }
  tl.innerHTML = html;
}

function vInvalidate() {
  if (!vState) return;
  vState.lastStart = -1;
  vState.lastEnd = -1;
  vRenderVisible();
}


// --- Track list rendering ---

function renderTrackList(preserveScroll) {
  const container = document.getElementById('tracks');
  const savedScroll = preserveScroll ? container.scrollTop : 0;

  // Tear down previous virtual scroll
  container.removeEventListener('scroll', onTrackScroll);
  vState = null;

  // Build the list of track indices to show based on the active filter
  let indices;
  if (activeFilter === null) {
    indices = tracks.map((_, i) => i);
  } else if (activeFilter === 'fav') {
    indices = tracks.map((_, i) => i).filter(i => favorites.has(tracks[i].file));
  } else {
    const pl = playlists[activeFilter];
    indices = (pl.trackIndices || []).filter(i => i < tracks.length);
  }

  if (!indices.length) {
    const msg = !tracks.length
      ? 'No tracks yet. Add MP3s to <code>music/</code> and list them in <code>tracks.json</code>'
      : 'No tracks here.';
    container.innerHTML = `<div class="empty"><p>${msg}</p></div>`;
    return;
  }

  // Set up virtual scroll container
  const tl = document.createElement('div');
  tl.className = 'tl';
  tl.style.position = 'relative';
  tl.style.height = (indices.length * ROW_H) + 'px';
  container.innerHTML = '';
  container.appendChild(tl);
  container.scrollTop = savedScroll;

  vState = { indices, tl, lastStart: -1, lastEnd: -1 };
  container.addEventListener('scroll', onTrackScroll, { passive: true });
  vRenderVisible();
}

// renderTrackItem - used by queue panel & search (non-virtual, small lists)
function renderTrackItem(idx, opts = {}) {
  const track = tracks[idx];
  if (!track) return '';

  const duration = track.dur ? formatTime(track.dur) : '';
  const isNowPlaying = idx === nowPlaying;
  const isFav = favorites.has(track.file);

  const classes = [
    'ti',
    isNowPlaying ? 'np' : '',
    track._err ? 'err' : '',
    opts.hist ? 'hist' : '',
  ].filter(Boolean).join(' ');

  const removeBtn = opts.removeIdx !== undefined
    ? `<button class="ti-rm" onclick="event.stopPropagation();removeFromQueue(${opts.removeIdx})">&times;</button>`
    : '';

  const onclick = opts.onclick || `playTrack(${idx})`;

  return `<div class="${classes}" data-i="${idx}" onclick="${onclick}" oncontextmenu="showContextMenu(event,${idx})" ontouchstart="longPressStart(event,${idx})" ontouchend="longPressEnd()" ontouchmove="longPressEnd()">
    <div class="ti-art">${renderArt(track)}<div class="ov"><svg viewBox="0 0 24 24"><use href="${isNowPlaying && playing ? '#i-pause' : '#i-play'}"/></svg></div></div>
    <div class="ti-info"><div class="ti-title">${escapeHTML(track.title)}</div><div class="ti-sub">${escapeHTML(track.artist || 'Unknown')}${track.album ? ' &middot; ' + escapeHTML(track.album) : ''}</div></div>
    <div class="ti-r">
      <button class="ti-fav ${isFav ? 'on' : ''}" onclick="event.stopPropagation();toggleFavorite(${idx})"><svg width="14" height="14" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><use href="${isFav ? '#i-heart' : '#i-heart-o'}"/></svg></button>
      ${removeBtn}
      <div class="ti-dur">${duration}</div>
    </div></div>`;
}


// --- Album art ---
// Renders either the cover image or a gradient placeholder
// with the first letter of the title

function renderArt(track) {
  if (track.art) return `<img src="${escapeHTML(track.art)}" loading="lazy">`;

  // Generate a deterministic hue from the title
  let hash = 0;
  for (let i = 0; i < track.title.length; i++) {
    hash = ((hash << 5) - hash + track.title.charCodeAt(i)) | 0;
  }
  const hue1 = Math.abs(hash) % 360;
  const hue2 = (hue1 + 35 + (Math.abs(hash >> 8) % 40)) % 360;
  const sat = 40 + (Math.abs(hash >> 4) % 25);
  const letter = escapeHTML(track.title.trim()[0] || '?').toUpperCase();

  return `<div class="ga" style="background:linear-gradient(135deg,hsl(${hue1},${sat}%,28%),hsl(${hue2},${sat}%,18%))">${letter}</div>`;
}


// --- Playback: queue building and track loading ---

function playTrack(idx) {
  // Build a queue from whatever view is currently active
  let source;
  if (activeFilter === null) {
    source = tracks.map((_, i) => i);
  } else if (activeFilter === 'fav') {
    source = tracks.map((_, i) => i).filter(i => favorites.has(tracks[i].file));
  } else {
    const pl = playlists[activeFilter];
    source = (pl.trackIndices || []).filter(i => i < tracks.length);
  }

  const position = source.indexOf(idx);
  if (position < 0) {
    // Track isn't in current view; fall back to full library
    source = tracks.map((_, i) => i);
    const fallback = source.indexOf(idx);
    buildQueue(source, fallback < 0 ? 0 : fallback);
  } else {
    buildQueue(source, position);
  }
}

function buildQueue(source, position) {
  history = [];
  nowPlaying = source[position];
  upNext = source.slice(position + 1);
  originalQueue = [...upNext];
  if (shuffleOn) shuffleArray(upNext);
  loadAndPlay();
}

let playRetryCount = 0;
const MAX_PLAY_RETRIES = 5;
let playRetryTimer = null;

function loadAndPlay() {
  const track = tracks[nowPlaying];
  if (!track || !track.file) return;

  // Clear any pending retry from previous track
  clearTimeout(playRetryTimer);
  playRetryCount = 0;

  // Only skip if we've exhausted retries THIS session
  if (track._err && track._errRetries >= MAX_PLAY_RETRIES) {
    toast('Track unavailable');
    advance();
    return;
  }

  // Update UI immediately so the user sees the track change
  updatePlayerUI();
  updateMediaSession();

  audio.src = track.file;
  audio.load();
  attemptPlay();
}

function attemptPlay() {
  const trackIdx = nowPlaying; // capture so retries don't act on wrong track

  audio.play()
    .then(() => {
      if (nowPlaying !== trackIdx) return; // user changed track during load
      playing = true;
      playRetryCount = 0;
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      updatePlayerUI();
      updateMediaSession();
      preloadNext();
    })
    .catch(() => {
      if (nowPlaying !== trackIdx) return;

      playRetryCount++;
      if (playRetryCount <= MAX_PLAY_RETRIES) {
        // Retry with exponential backoff (500ms, 1s, 2s, 4s, 8s)
        const delay = 500 * Math.pow(2, playRetryCount - 1);
        playRetryTimer = setTimeout(() => {
          if (nowPlaying !== trackIdx) return;
          attemptPlay();
        }, delay);
      } else {
        // All retries exhausted - mark and advance
        const track = tracks[trackIdx];
        if (track) {
          track._err = true;
          track._errRetries = (track._errRetries || 0) + MAX_PLAY_RETRIES;
        }
        toast('Failed: ' + tracks[trackIdx]?.title);
        advance();
      }
    });
}

function advance() {
  if (repeatMode === 2) {
    // Repeat one: try simple restart, fall back to full reload if backgrounded
    try { audio.currentTime = 0; } catch {}
    audio.play().catch(() => {
      // If simple replay fails (e.g. background), do full reload
      loadAndPlay();
    });
    return;
  }

  if (nowPlaying >= 0) {
    history.push(nowPlaying);
    if (history.length > HIST_MAX) history = history.slice(-HIST_MAX);
  }

  if (upNext.length) {
    nowPlaying = upNext.shift();
    if (!shuffleOn) originalQueue.shift();
    loadAndPlay();
  } else if (repeatMode === 1) {
    // Wrap around: rebuild queue from history + current track
    const all = [...history, nowPlaying];
    history = [];
    nowPlaying = all[0];
    upNext = all.slice(1);
    originalQueue = [...upNext];
    if (shuffleOn) shuffleArray(upNext);
    loadAndPlay();
  } else {
    playing = false;
    updatePlayPauseButtons();
  }

  renderQueue();
}

function goBack() {
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  if (!history.length) return;

  upNext.unshift(nowPlaying);
  if (!shuffleOn) originalQueue.unshift(nowPlaying);
  nowPlaying = history.pop();
  loadAndPlay();
  renderQueue();
}

function togglePlayback() {
  if (nowPlaying < 0) {
    if (tracks.length) playTrack(0);
    return;
  }
  if (audio.paused) {
    audio.play().catch(() => {
      // If play fails (e.g. after long background), reload and try
      audio.load();
      audio.play().catch(() => {});
    });
    playing = true;
  } else {
    audio.pause();
    playing = false;
  }
  updatePlayerUI();
}

function nextTrack() { advance(); }
function previousTrack() { goBack(); }

function addPlayNext(idx) {
  upNext.unshift(idx);
  originalQueue.unshift(idx);
  toast('Playing next');
  renderQueue();
}

function addToEndOfQueue(idx) {
  upNext.push(idx);
  originalQueue.push(idx);
  toast('Added to queue');
  renderQueue();
}

function removeFromQueue(position) {
  upNext.splice(position, 1);
  if (!shuffleOn) originalQueue.splice(position, 1);
  renderQueue();
}


// --- Shuffle and repeat ---

function toggleShuffle() {
  shuffleOn = !shuffleOn;
  if (shuffleOn) {
    originalQueue = [...upNext];
    shuffleArray(upNext);
  } else {
    // Restore original order, minus tracks already played
    const played = new Set(history);
    played.add(nowPlaying);
    upNext = originalQueue.filter(i => !played.has(i));
  }
  ['bShuf', 'fShuf'].forEach(id => {
    document.getElementById(id).classList.toggle('on', shuffleOn);
  });
  toast(shuffleOn ? 'Shuffle on' : 'Shuffle off');
  renderQueue();
}

function toggleRepeat() {
  repeatMode = (repeatMode + 1) % 3;
  const isOn = repeatMode > 0;
  const icon = repeatMode === 2 ? '#i-rep1' : '#i-rep';

  ['bRep', 'fRep'].forEach(id => {
    const el = document.getElementById(id);
    el.classList.toggle('on', isOn);
    const size = id === 'fRep' ? 20 : 14;
    el.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><use href="${icon}"/></svg>`;
  });

  toast(['Repeat off', 'Repeat all', 'Repeat one'][repeatMode]);
}

function setVolume(value) {
  audio.volume = value / 100;
}

function preloadNext() {
  if (!upNext.length) return;
  const next = tracks[upNext[0]];
  if (!next || !next.file) return;

  // Prefetch the audio file
  document.getElementById('audioPreload')?.setAttribute('href', next.file);

  // Pre-generate artwork blob for the next track so it's ready instantly on track change
  const artSrc = next.art || 'icon.png';
  const artUrl = new URL(artSrc, location.href).href;
  if (!_artworkBlobs.has(artUrl)) {
    _generateArtworkBlob(artUrl);
  }
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}


// --- Favorites ---

function toggleFavorite(idx) {
  const key = tracks[idx].file;
  if (favorites.has(key)) favorites.delete(key);
  else favorites.add(key);

  try {
    localStorage.setItem('oo_fav', JSON.stringify([...favorites]));
  } catch {}

  renderChips();

  // Detect if search is active (desktop input has text, or mobile overlay is open)
  const searchActive = document.getElementById('dsi').value.trim() ||
                        document.getElementById('ms').classList.contains('open');

  if (searchActive) {
    // Just update the fav button(s) for this track in place
    updateFavButtons(idx);
  } else if (activeFilter === 'fav') {
    renderTrackList();
  } else {
    vInvalidate();
  }

  renderQueue();
  updateFullPlayerFavorite();
}

function updateFavButtons(idx) {
  const isFav = favorites.has(tracks[idx].file);
  document.querySelectorAll(`.ti[data-i="${idx}"] .ti-fav`).forEach(btn => {
    btn.classList.toggle('on', isFav);
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><use href="${isFav ? '#i-heart' : '#i-heart-o'}"/></svg>`;
  });
}

function isFavorite(track) {
  return favorites.has(track.file);
}


// --- Context menu (right-click / long-press) ---

function showContextMenu(event, idx) {
  event.preventDefault();
  event.stopPropagation();
  contextTrack = idx;

  const menu = document.getElementById('ctx');
  const track = tracks[idx];
  const fav = isFavorite(track);

  document.getElementById('ctxFavL').textContent = fav ? 'Unfavorite' : 'Favorite';
  document.querySelector('#ctxFav svg use').setAttribute('href', fav ? '#i-heart' : '#i-heart-o');

  menu.classList.add('open');

  const x = event.clientX || (event.touches && event.touches[0].clientX) || 100;
  const y = event.clientY || (event.touches && event.touches[0].clientY) || 100;
  menu.style.left = Math.min(x, innerWidth - 200) + 'px';
  menu.style.top = Math.min(y, innerHeight - 160) + 'px';
}

function hideContextMenu() {
  document.getElementById('ctx').classList.remove('open');
}

function contextMenuAction(action) {
  hideContextMenu();
  if (contextTrack < 0) return;
  if (action === 'playNext') addPlayNext(contextTrack);
  else if (action === 'addToQueue') addToEndOfQueue(contextTrack);
  else if (action === 'favorite') toggleFavorite(contextTrack);
}

document.addEventListener('click', hideContextMenu);

// Long-press support for touch devices
let longPressTimer;

function longPressStart(event, idx) {
  longPressTimer = setTimeout(() => showContextMenu(event, idx), 500);
}

function longPressEnd() {
  clearTimeout(longPressTimer);
}


// --- Audio events ---

// Cache frequently-accessed DOM elements (timeupdate fires ~4x/sec)
const $bf = document.getElementById('bf');
const $fpBF = document.getElementById('fpBF');
const $fpC = document.getElementById('fpC');
const $fpD = document.getElementById('fpD');
const $btime = document.getElementById('btime');

audio.addEventListener('timeupdate', () => {
  if (!audio.duration || seeking) return;

  const progress = (audio.currentTime / audio.duration) * 100;
  $bf.style.width = progress + '%';
  $fpBF.style.width = progress + '%';

  const queueProgress = document.getElementById('qpProg');
  if (queueProgress) queueProgress.style.width = progress + '%';

  $fpC.textContent = formatTime(audio.currentTime);
  $fpD.textContent = formatTime(audio.duration);
  $btime.textContent = formatTime(audio.currentTime) + ' / ' + formatTime(audio.duration);

  updatePositionState();
});

audio.addEventListener('ended', advance);
audio.addEventListener('play', () => {
  playing = true;
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  updatePlayPauseButtons(); updateHighlight(); updateQueuePlayButton(); updateMediaSession();
});
audio.addEventListener('pause', () => {
  playing = false;
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  updatePlayPauseButtons(); updateHighlight(); updateQueuePlayButton();
});
audio.addEventListener('error', () => {
  // only track retries here. Do NOT call advance().
  // attemptPlay()'s catch block is the sole flow controller for retries/advance.
  const track = tracks[nowPlaying];
  if (track) {
    track._errRetries = (track._errRetries || 0) + 1;
    if (track._errRetries >= MAX_PLAY_RETRIES) {
      track._err = true;
      toast('Failed: ' + track.title);
    }
  }
});


// --- Seek bar interaction ---
// Sets up mouse and touch drag-to-seek on a progress bar element

function initSeekBar(bar, fill) {
  function seekTo(event) {
    if (!audio.duration) return;
    const rect = bar.getBoundingClientRect();
    const clientX = event.touches ? event.touches[0].clientX : event.clientX;
    const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    audio.currentTime = fraction * audio.duration;
    fill.style.width = (fraction * 100) + '%';
  }

  // Mouse
  bar.addEventListener('mousedown', event => {
    seeking = true;
    bar.classList.add('drag');
    seekTo(event);
    const onMove = ev => seekTo(ev);
    const onUp = () => {
      seeking = false;
      bar.classList.remove('drag');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      updatePositionState();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Touch
  bar.addEventListener('touchstart', event => {
    seeking = true;
    bar.classList.add('drag');
    seekTo(event);
  }, { passive: true });

  bar.addEventListener('touchmove', event => {
    if (seeking) seekTo(event);
  }, { passive: true });

  bar.addEventListener('touchend', () => {
    seeking = false;
    bar.classList.remove('drag');
    updatePositionState();
  });
}

initSeekBar(document.getElementById('bp'), document.getElementById('bf'));
initSeekBar(document.getElementById('fpBW'), document.getElementById('fpBF'));


// --- UI updates ---

function updatePlayerUI() {
  const track = tracks[nowPlaying];
  if (!track) return;

  // Show the bottom bar
  document.getElementById('bar').classList.add('vis');

  // Bottom bar
  document.getElementById('ba').innerHTML = renderArt(track);
  document.getElementById('bt').textContent = track.title;
  document.getElementById('bs').textContent = track.artist || 'Unknown';

  // Full-screen player
  document.getElementById('fpA').innerHTML = renderArt(track);
  document.getElementById('fpT').textContent = track.title;
  document.getElementById('fpAr').textContent = track.artist || 'Unknown';

  updateFullPlayerFavorite();
  updatePlayPauseButtons();
  updateHighlight();
}

function updateFullPlayerFavorite() {
  const el = document.getElementById('fpFav');
  if (!el || nowPlaying < 0) return;

  const fav = favorites.has(tracks[nowPlaying].file);
  el.classList.toggle('fav-on', fav);
  el.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="${fav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><use href="${fav ? '#i-heart' : '#i-heart-o'}"/></svg>`;
}

function updatePlayPauseButtons() {
  const icon = playing ? '#i-pause' : '#i-play';
  const svg = `<svg viewBox="0 0 24 24"><use href="${icon}"/></svg>`;
  document.getElementById('bpp').innerHTML = svg;
  document.getElementById('fpPP').innerHTML = svg;
}

function updateHighlight() {
  // Re-render virtual scroll rows (they carry np state inline)
  vInvalidate();
  // Re-render queue virtual scroll rows too
  if (qvState) { qvState.lastStart = -1; qvState.lastEnd = -1; qvRenderVisible(); }
  // Update any non-virtual .ti elements (capped history, search results)
  document.querySelectorAll('.qp .ti:not([style*="position"]), .ms .ti, #tracks > .tl > .ti:not([style])').forEach(el => {
    const idx = +el.dataset.i;
    const isActive = idx === nowPlaying;
    el.classList.toggle('np', isActive);
    const use = el.querySelector('.ov svg use');
    if (use) use.setAttribute('href', isActive && playing ? '#i-pause' : '#i-play');
  });
}

function updateQueuePlayButton() {
  const el = document.getElementById('qpPlay');
  if (el) el.innerHTML = `<svg viewBox="0 0 24 24"><use href="${playing ? '#i-pause' : '#i-play'}"/></svg>`;
}


// --- Queue panel ---

function openQueue() {
  document.getElementById('qp').classList.add('open');
  document.getElementById('scrim').classList.add('on');
  document.getElementById('bQ').classList.add('on');
  renderQueue();
}

function closeQueue() {
  document.getElementById('qp').classList.remove('open');
  document.getElementById('scrim').classList.remove('on');
  document.getElementById('bQ').classList.remove('on');
}

function renderQueue() {
  const ctrlContainer = document.getElementById('qpCtrl');
  const body = document.getElementById('qpBody');

  // Tear down queue virtual scroll
  body.removeEventListener('scroll', onQueueScroll);
  qvState = null;

  if (nowPlaying < 0) {
    ctrlContainer.innerHTML = '';
    body.innerHTML = '<div class="empty"><p>Nothing playing yet.</p></div>';
    return;
  }

  const track = tracks[nowPlaying];

  // Now-playing controls at the top of the queue panel
  ctrlContainer.innerHTML = `
    <div class="qp-ctrl">
      <div class="qpc-art" onclick="closeQueue();openFullPlayer()">${renderArt(track)}</div>
      <div class="qpc-info" onclick="closeQueue();openFullPlayer()"><div class="qpc-title">${escapeHTML(track.title)}</div><div class="qpc-sub">${escapeHTML(track.artist || 'Unknown')}</div></div>
      <div class="qpc-btns">
        <button class="qpc-btn" onclick="previousTrack()"><svg viewBox="0 0 24 24"><use href="#i-prev"/></svg></button>
        <button class="qpc-btn play" onclick="togglePlayback()" id="qpPlay"><svg viewBox="0 0 24 24"><use href="${playing ? '#i-pause' : '#i-play'}"/></svg></button>
        <button class="qpc-btn" onclick="nextTrack()"><svg viewBox="0 0 24 24"><use href="#i-next"/></svg></button>
      </div>
    </div>
    <div class="qp-prog"><div class="qp-prog-fill" id="qpProg"></div></div>`;

  // Up next + history lists
  let html = '';

  if (upNext.length) {
    html += `<div class="qp-section">Up Next (${upNext.length})</div>`;
    html += `<div class="tl qv-tl" style="position:relative;height:${upNext.length * ROW_H}px"></div>`;
  }

  const HIST_CAP = 50;
  if (history.length) {
    const shown = history.slice(-HIST_CAP).reverse();
    const label = history.length > HIST_CAP
      ? `History (latest ${HIST_CAP} of ${history.length})`
      : 'History';
    html += `<div class="qp-section">${label}</div><div class="tl">`;
    shown.forEach(trackIdx => {
      html += renderTrackItem(trackIdx, { hist: true });
    });
    html += '</div>';
  }

  if (!upNext.length && !history.length) {
    html = '<div class="empty" style="padding:40px"><p>Queue is empty. Right-click a track to add it.</p></div>';
  }

  body.innerHTML = html;

  // Set up virtual scroll for Up Next
  if (upNext.length) {
    const tl = body.querySelector('.qv-tl');
    if (tl) {
      qvState = { tl, lastStart: -1, lastEnd: -1 };
      body.addEventListener('scroll', onQueueScroll, { passive: true });
      qvRenderVisible();
    }
  }
}

// --- Queue virtual scroll ---

let qvState = null;
let qvRaf = false;

function onQueueScroll() {
  if (!qvRaf) {
    qvRaf = true;
    requestAnimationFrame(() => { qvRaf = false; qvRenderVisible(); });
  }
}

function qvRenderVisible() {
  if (!qvState) return;
  const body = document.getElementById('qpBody');
  const { tl } = qvState;
  const scrollTop = body.scrollTop;
  const viewH = body.clientHeight;
  const tlTop = tl.offsetTop;

  const relTop = scrollTop - tlTop;
  let s = Math.max(0, Math.floor(relTop / ROW_H) - VBUF);
  let e = Math.min(upNext.length, Math.ceil((relTop + viewH) / ROW_H) + VBUF);

  if (s === qvState.lastStart && e === qvState.lastEnd) return;
  qvState.lastStart = s;
  qvState.lastEnd = e;

  let html = '';
  for (let i = s; i < e; i++) {
    const trackIdx = upNext[i];
    const track = tracks[trackIdx];
    if (!track) continue;

    const dur = track.dur ? formatTime(track.dur) : '';
    const isNP = trackIdx === nowPlaying;
    const isFav = favorites.has(track.file);
    const cls = ['ti', isNP ? 'np' : '', track._err ? 'err' : ''].filter(Boolean).join(' ');

    html += `<div class="${cls}" data-i="${trackIdx}" style="position:absolute;top:${i * ROW_H}px;left:0;right:0" onclick="upNext.splice(0,${i});if(!shuffleOn)originalQueue.splice(0,${i});advance()" oncontextmenu="showContextMenu(event,${trackIdx})" ontouchstart="longPressStart(event,${trackIdx})" ontouchend="longPressEnd()" ontouchmove="longPressEnd()">
      <div class="ti-art">${renderArt(track)}<div class="ov"><svg viewBox="0 0 24 24"><use href="${isNP && playing ? '#i-pause' : '#i-play'}"/></svg></div></div>
      <div class="ti-info"><div class="ti-title">${escapeHTML(track.title)}</div><div class="ti-sub">${escapeHTML(track.artist || 'Unknown')}${track.album ? ' &middot; ' + escapeHTML(track.album) : ''}</div></div>
      <div class="ti-r">
        <button class="ti-fav ${isFav ? 'on' : ''}" onclick="event.stopPropagation();toggleFavorite(${trackIdx})"><svg width="14" height="14" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><use href="${isFav ? '#i-heart' : '#i-heart-o'}"/></svg></button>
        <button class="ti-rm" onclick="event.stopPropagation();removeFromQueue(${i})">&times;</button>
        <div class="ti-dur">${dur}</div>
      </div></div>`;
  }
  tl.innerHTML = html;
}

function clearQueue() {
  upNext = [];
  originalQueue = [];
  renderQueue();
  toast('Queue cleared');
}


// --- Media Session API (lock screen / OS controls) ---

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const track = tracks[nowPlaying];
  if (!track) return;

  const artSrc = track.art || 'icon.png';
  const artUrl = new URL(artSrc, location.href).href;

  // Build artwork list from cached blob if available
  const artworkList = [];
  const cachedBlob = _artworkBlobs.get(artUrl);
  if (cachedBlob) {
    artworkList.push({ src: cachedBlob, sizes: '256x256', type: 'image/png' });
    artworkList.push({ src: cachedBlob, sizes: '512x512', type: 'image/png' });
  }

  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist || 'Unknown',
    album: track.album || 'oomycota',
    artwork: artworkList,
  });

  // If no blob cached yet (and not previously failed), generate one and re-set metadata when ready
  if (!_artworkBlobs.has(artUrl)) {
    _generateArtworkBlob(artUrl, () => {
      // Only re-set if this track is still playing
      if (tracks[nowPlaying] === track) updateMediaSession();
    });
  }

  // Set explicit playbackState, critical for keeping media session alive
  // on car displays and lock screens when the app is in background
  navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';

  // Always (re-)register action handlers, iOS can drop them on app resume
  // await play() before setting state in the play handler
  navigator.mediaSession.setActionHandler('play', async () => {
    try {
      await audio.play();
      playing = true;
      navigator.mediaSession.playbackState = 'playing';
    } catch {
      // play failed (e.g. backgrounded too long)
    }
    updatePlayPauseButtons();
  });
  navigator.mediaSession.setActionHandler('pause', () => {
    audio.pause();
    playing = false;
    navigator.mediaSession.playbackState = 'paused';
    updatePlayPauseButtons();
  });
  navigator.mediaSession.setActionHandler('previoustrack', previousTrack);
  navigator.mediaSession.setActionHandler('nexttrack', nextTrack);
  navigator.mediaSession.setActionHandler('seekto', d => { audio.currentTime = d.seekTime; updatePositionState(); });
  // Handle stop - some car head units send this instead of pause
  try { navigator.mediaSession.setActionHandler('stop', () => {
    audio.pause();
    playing = false;
    navigator.mediaSession.playbackState = 'paused';
    updatePlayPauseButtons();
  }); } catch {}
  // Explicitly clear seekbackward/seekforward so iOS doesn't override prev/next with ±10s
  try { navigator.mediaSession.setActionHandler('seekbackward', null); } catch {}
  try { navigator.mediaSession.setActionHandler('seekforward', null); } catch {}

  updatePositionState();
}

function updatePositionState() {
  if (!('mediaSession' in navigator) || !audio.duration || !isFinite(audio.duration)) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate,
      position: Math.min(audio.currentTime, audio.duration),
    });
  } catch {}
}

// Generate a blob URL from an artwork image via canvas.
// Uses a Map cache so preloadNext doesn't clobber the current track's blob.
// Optional callback fires when the blob is ready.
const _artworkGenerating = new Map(); // artUrl -> [callbacks]

function _generateArtworkBlob(artUrl, onReady) {
  // Already cached (either valid blob URL or '' error sentinel)
  if (_artworkBlobs.has(artUrl)) { if (onReady) onReady(); return; }

  // Already generating so queue the callback instead of starting a duplicate
  if (_artworkGenerating.has(artUrl)) {
    if (onReady) _artworkGenerating.get(artUrl).push(onReady);
    return;
  }
  _artworkGenerating.set(artUrl, onReady ? [onReady] : []);

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = artUrl;

  function _finish() {
    const cbs = _artworkGenerating.get(artUrl) || [];
    _artworkGenerating.delete(artUrl);
    cbs.forEach(cb => cb());
  }

  img.addEventListener('load', () => {
    try {
      const SIZE = 512;
      const canvas = document.createElement('canvas');
      canvas.width = SIZE;
      canvas.height = SIZE;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, SIZE, SIZE);
      canvas.toBlob((blob) => {
        if (!blob) { _finish(); return; }
        const blobUrl = URL.createObjectURL(blob);
        _artworkBlobs.set(artUrl, blobUrl);

        // Evict oldest entries beyond the cache limit
        if (_artworkBlobs.size > _ARTWORK_CACHE_MAX) {
          const iter = _artworkBlobs.entries();
          const oldest = iter.next().value;
          if (oldest) {
            URL.revokeObjectURL(oldest[1]);
            _artworkBlobs.delete(oldest[0]);
          }
        }

        _finish();
      }, 'image/png');
    } catch { _finish(); }
  });
  img.addEventListener('error', () => {
    // Mark as attempted so we don't keep retrying a broken image
    _artworkBlobs.set(artUrl, '');
    _finish();
  });
}


// --- Full-screen player ---

function openFullPlayer() {
  document.getElementById('fp').classList.add('open');
}

function closeFullPlayer() {
  document.getElementById('fp').classList.remove('open');
}

// Swipe down to dismiss the full player
let touchStartY = 0;
const fullPlayerEl = document.getElementById('fp');

fullPlayerEl.addEventListener('touchstart', event => {
  if (event.target.closest('.fp-bw,.fp-vol')) return;
  touchStartY = event.touches[0].clientY;
});

fullPlayerEl.addEventListener('touchend', event => {
  if (event.target.closest('.fp-bw,.fp-vol')) return;
  if (event.changedTouches[0].clientY - touchStartY > 80) closeFullPlayer();
});


// --- Search ---

function openMobileSearch() {
  // iOS Safari only opens the keyboard when .focus() is called synchronously
  // on a *visible* element during a user gesture. The real input is hidden
  // (opacity:0) when the button is tapped, so iOS ignores the focus.
  // Workaround: focus a tiny always-visible proxy input first (opens keyboard),
  // then show the overlay and transfer focus to the real input.
  var proxy = document.getElementById('iosProxy');
  if (proxy) proxy.focus();
  var overlay = document.getElementById('ms');
  overlay.classList.add('open');
  var input = document.getElementById('msi');
  requestAnimationFrame(function() { input.focus(); });
}

// Create the proxy input once on load
(function() {
  var p = document.createElement('input');
  p.id = 'iosProxy';
  p.setAttribute('aria-hidden', 'true');
  p.setAttribute('tabindex', '-1');
  p.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.01;border:none;padding:0;margin:0;outline:none;z-index:-1;pointer-events:none;';
  document.body.appendChild(p);
})();

function closeMobileSearch() {
  document.getElementById('ms').classList.remove('open');
  document.getElementById('msi').value = '';
  document.getElementById('msr').innerHTML = '';
  document.getElementById('dsi').value = '';
  renderTrackList();
}

function handleSearch(query) {
  const term = query.toLowerCase().trim();
  const isMobile = innerWidth < 600;
  const target = isMobile ? document.getElementById('msr') : document.getElementById('tracks');

  if (!term) {
    if (isMobile) target.innerHTML = '';
    else renderTrackList();
    return;
  }

  // Desktop search replaces the virtual-scrolled track list
  if (!isMobile) {
    target.removeEventListener('scroll', onTrackScroll);
    vState = null;
  }

  const matches = tracks
    .map((track, i) => [track, i])
    .filter(([track]) => track._s.includes(term));

  if (!matches.length) {
    target.innerHTML = '<div class="empty"><p>No results</p></div>';
    return;
  }

  const SEARCH_CAP = 100;
  const shown = matches.slice(0, SEARCH_CAP);
  let html = '<div class="tl">' + shown.map(([_, i]) => renderTrackItem(i)).join('') + '</div>';
  if (matches.length > SEARCH_CAP) {
    html += `<div class="empty" style="padding:12px"><p style="font-size:13px;color:var(--sub)">Showing ${SEARCH_CAP} of ${matches.length} results - try a more specific query</p></div>`;
  }
  target.innerHTML = html;
}


// --- Helpers ---

function formatTime(seconds) {
  if (!seconds || !isFinite(seconds)) return '0:00';
  return Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
}

function escapeHTML(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


// --- Offline caching ---

let cacheBusy = false;
let cacheAbort = false;

async function cacheCurrentView() {
  if (cacheBusy) {
    // Already caching - tap again to cancel
    cacheAbort = true;
    toast('Cancelling...');
    return;
  }
  if (!('caches' in window)) { toast('Not available'); return; }

  // Decide which tracks to cache based on the active filter
  let targetTracks;
  let label;

  if (activeFilter === null) {
    targetTracks = tracks;
    label = 'all ' + tracks.length + ' tracks';
  } else if (activeFilter === 'fav') {
    targetTracks = tracks.filter(t => favorites.has(t.file));
    label = targetTracks.length + ' favorites';
  } else {
    const pl = playlists[activeFilter];
    const indices = (pl.trackIndices || []).filter(i => i < tracks.length);
    targetTracks = indices.map(i => tracks[i]);
    label = targetTracks.length + ' tracks from ' + pl.name;
  }

  // Warn before caching a large number of tracks
  if (targetTracks.length > 50) {
    if (!confirm(`Cache ${label} for offline?\n\nThis may use a lot of storage. On iOS, consider caching a smaller playlist instead.`)) return;
  }

  cacheBusy = true;
  cacheAbort = false;
  document.getElementById('cBtn').classList.add('on');
  const progressBar = document.getElementById('cbf');

  // Collect all file URLs to cache (audio + artwork)
  const urls = new Set();
  targetTracks.forEach(t => {
    if (t.file) urls.add(t.file);
    if (t.art) urls.add(t.art);
  });
  playlists.forEach(p => { if (p.art) urls.add(p.art); });

  const urlList = [...urls];
  let done = 0;
  toast('Caching ' + label + '... (tap again to cancel)');

  const cache = await caches.open('oomycota');
  for (const url of urlList) {
    if (cacheAbort) break;
    try {
      if (!(await cache.match(url))) {
        const response = await fetch(url);
        if (response.ok) await cache.put(url, response);
      }
    } catch {}
    done++;
    progressBar.style.width = ((done / urlList.length) * 100) + '%';
  }

  toast(cacheAbort ? `Cancelled (${done} of ${urlList.length} cached)` : 'Cached ' + label);

  // Show storage usage after a short delay
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      const usedMB = Math.round((estimate.usage || 0) / 1024 / 1024);
      const quotaMB = Math.round((estimate.quota || 0) / 1024 / 1024);
      setTimeout(() => toast(usedMB + 'MB used of ' + quotaMB + 'MB available'), 2200);
    } catch {}
  }

  setTimeout(() => progressBar.style.width = '0%', 800);
  document.getElementById('cBtn').classList.remove('on');
  cacheBusy = false;
}

async function clearOfflineCache() {
  if (!('caches' in window)) return;
  if (!confirm('Clear all offline cached audio and images?')) return;

  await caches.delete('oomycota');
  toast('Offline cache cleared');

  // Re-cache just the app shell
  if ('serviceWorker' in navigator) {
    const cache = await caches.open('oomycota');
    try { await cache.addAll(['./', 'index.html', 'tracks.json']); } catch {}
  }
}

// Long-press on the cache button triggers clearOfflineCache on mobile
let cacheLongPressTimer;
let cacheLongPressDone = false;

const cacheBtn = document.getElementById('cBtn');

cacheBtn.addEventListener('touchstart', () => {
  cacheLongPressDone = false;
  cacheLongPressTimer = setTimeout(() => {
    cacheLongPressDone = true;
    clearOfflineCache();
  }, 800);
});

cacheBtn.addEventListener('touchend', event => {
  clearTimeout(cacheLongPressTimer);
  if (cacheLongPressDone) {
    event.preventDefault();
    cacheLongPressDone = false;
  }
});

cacheBtn.addEventListener('touchmove', () => {
  clearTimeout(cacheLongPressTimer);
});


// --- Save and restore playback state across sessions ---

function saveState() {
  if (nowPlaying < 0) return;
  try {
    localStorage.setItem('oo_st', JSON.stringify({
      f: tracks[nowPlaying]?.file,
      p: audio.currentTime || 0,
      d: audio.duration || tracks[nowPlaying]?.dur || 0,
      v: audio.volume,
      fl: activeFilter,
      un: upNext,
      hi: history,
      sh: shuffleOn,
      rp: repeatMode,
    }));
  } catch {}
}

function restoreState() {
  try {
    const raw = localStorage.getItem('oo_st');
    if (!raw) return;
    const state = JSON.parse(raw);

    // Volume
    if (typeof state.v === 'number') {
      audio.volume = state.v;
      document.querySelectorAll('input[type=range]').forEach(el => {
        if (el.max === '100') el.value = Math.round(state.v * 100);
      });
    }

    // Shuffle
    if (state.sh) {
      shuffleOn = true;
      ['bShuf', 'fShuf'].forEach(id => document.getElementById(id).classList.add('on'));
    }

    // Repeat
    if (state.rp) {
      repeatMode = state.rp;
      const icon = repeatMode === 2 ? '#i-rep1' : '#i-rep';
      ['bRep', 'fRep'].forEach(id => {
        const el = document.getElementById(id);
        el.classList.toggle('on', repeatMode > 0);
        const size = id === 'fRep' ? 20 : 14;
        el.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><use href="${icon}"/></svg>`;
      });
    }

    // Active filter
    if (state.fl !== undefined && state.fl !== null) {
      activeFilter = state.fl;
      renderChips();
      renderTrackList();
    }

    // Resume track (paused, at the saved position)
    if (state.f) {
      const idx = tracks.findIndex(t => t.file === state.f);
      if (idx >= 0) {
        nowPlaying = idx;
        upNext = (state.un || []).filter(i => i < tracks.length);
        history = (state.hi || []).filter(i => i < tracks.length);
        originalQueue = [...upNext];

        // Show saved time in the UI immediately (before metadata loads)
        const savedPos = state.p || 0;
        const savedDur = state.d || tracks[idx].dur || 0;
        if (savedDur) {
          const pct = (savedPos / savedDur) * 100;
          $bf.style.width = pct + '%';
          $fpBF.style.width = pct + '%';
          $fpC.textContent = formatTime(savedPos);
          $fpD.textContent = formatTime(savedDur);
          $btime.textContent = formatTime(savedPos) + ' / ' + formatTime(savedDur);
        }

        audio.src = tracks[idx].file;
        audio.preload = 'metadata';
        audio.load(); // Needed on iOS to trigger metadata loading without play

        audio.addEventListener('loadedmetadata', function onMeta() {
          audio.removeEventListener('loadedmetadata', onMeta);
          // Guard: if user already picked a different track, don't touch position
          if (nowPlaying !== idx) return;
          if (savedPos > 0) audio.currentTime = savedPos;
          // Update UI now that we have real duration
          $fpD.textContent = formatTime(audio.duration);
          $btime.textContent = formatTime(audio.currentTime) + ' / ' + formatTime(audio.duration);
          updateMediaSession();
        });

        updatePlayerUI();
        updateMediaSession(); // Set lock screen metadata + handlers even before metadata loads
      }
    }
  } catch {}
}

// Auto-save periodically and on pause/unload
let saveTimer;
audio.addEventListener('timeupdate', () => {
  if (!saveTimer) {
    saveTimer = setTimeout(() => { saveState(); saveTimer = null; }, 5000);
  }
});
audio.addEventListener('pause', saveState);
window.addEventListener('beforeunload', saveState);
// iOS PWA: 'pagehide' fires more reliably than 'beforeunload'
window.addEventListener('pagehide', saveState);
// iOS PWA: re-sync UI when returning to the app
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && nowPlaying >= 0) {
    // Re-kick metadata if duration was lost (iOS can purge audio state)
    if (!audio.duration || !isFinite(audio.duration)) {
      // Save position before load() resets it; fall back to localStorage
      let pos = audio.currentTime;
      if (!pos || !isFinite(pos)) {
        try {
          const st = JSON.parse(localStorage.getItem('oo_st') || '{}');
          pos = st.p || 0;
        } catch { pos = 0; }
      }
      audio.load();
      audio.addEventListener('loadedmetadata', function onResume() {
        audio.removeEventListener('loadedmetadata', onResume);
        if (pos > 0 && isFinite(audio.duration) && pos < audio.duration) {
          audio.currentTime = pos;
        }
        updateMediaSession();
      });
    }

    // if audio stopped unexpectedly while backgrounded, try to resume.
    // If play() fails, correct the state instead of silently lying.
    if (playing && audio.paused) {
      audio.play().catch(() => {
        playing = false;
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
        updatePlayPauseButtons();
      });
    }

    updatePlayerUI();
    updateMediaSession();
  } else if (document.visibilityState === 'hidden' && nowPlaying >= 0) {
    // ensure media session is fresh so car display keeps showing it even when background
    updateMediaSession();
    saveState();
  }
});


// --- Keyboard shortcuts ---

document.addEventListener('keydown', event => {
  if (event.target.tagName === 'INPUT') return;

  if (event.code === 'Space')      { event.preventDefault(); togglePlayback(); }
  if (event.code === 'ArrowRight') { event.preventDefault(); nextTrack(); }
  if (event.code === 'ArrowLeft')  { event.preventDefault(); previousTrack(); }
  if (event.code === 'KeyS')       { event.preventDefault(); toggleShuffle(); }
  if (event.code === 'KeyR')       { event.preventDefault(); toggleRepeat(); }
  if (event.code === 'Escape')     { closeMobileSearch(); hideContextMenu(); closeQueue(); }
});


// --- Start ---

init();