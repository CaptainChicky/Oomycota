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
const durations = {};     // file path -> duration in seconds (filled async)
const favorites = new Set();

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
  renderChips();
  renderTrackList();
  loadDurations();
  restoreState();
}

function loadDurations() {
  tracks.forEach((track, i) => {
    if (!track.file || durations[track.file]) return;
    const probe = new Audio();
    probe.preload = 'metadata';
    probe.src = track.file;
    probe.onloadedmetadata = () => {
      durations[track.file] = probe.duration;
      // Update any visible duration labels for this file
      const selector = `.ti-dur[data-f="${CSS.escape(track.file)}"]`;
      document.querySelectorAll(selector).forEach(el => {
        el.textContent = formatTime(probe.duration);
      });
    };
    probe.onerror = () => { track._err = true; };
  });
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


// --- Track list rendering ---

function renderTrackList() {
  const container = document.getElementById('tracks');

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

  container.innerHTML = '<div class="tl">' + indices.map(i => renderTrackItem(i)).join('') + '</div>';
}

function renderTrackItem(idx, opts = {}) {
  const track = tracks[idx];
  if (!track) return '';

  const duration = track.file && durations[track.file] ? formatTime(durations[track.file]) : '';
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
      <div class="ti-dur" data-f="${escapeHTML(track.file || '')}">${duration}</div>
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

function loadAndPlay() {
  const track = tracks[nowPlaying];
  if (!track || !track.file) return;

  if (track._err) {
    toast('Track unavailable');
    advance();
    return;
  }

  audio.src = track.file;
  audio.play()
    .then(() => {
      playing = true;
      updatePlayerUI();
      updateMediaSession();
      preloadNext();
    })
    .catch(() => {
      track._err = true;
      toast('Failed: ' + track.title);
      updatePlayerUI();
    });

  updatePlayerUI();
}

function advance() {
  if (repeatMode === 2) {
    audio.currentTime = 0;
    audio.play();
    return;
  }

  if (nowPlaying >= 0) history.push(nowPlaying);

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
    audio.play();
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
  if (next && next.file) {
    document.getElementById('audioPreload')?.setAttribute('src', next.file);
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
  renderTrackList();
  renderQueue();
  updateFullPlayerFavorite();
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

audio.addEventListener('timeupdate', () => {
  if (!audio.duration || seeking) return;

  const progress = (audio.currentTime / audio.duration) * 100;
  document.getElementById('bf').style.width = progress + '%';
  document.getElementById('fpBF').style.width = progress + '%';

  const queueProgress = document.getElementById('qpProg');
  if (queueProgress) queueProgress.style.width = progress + '%';

  document.getElementById('fpC').textContent = formatTime(audio.currentTime);
  document.getElementById('fpD').textContent = formatTime(audio.duration);
  document.getElementById('btime').textContent = formatTime(audio.currentTime) + ' / ' + formatTime(audio.duration);

  updatePositionState();
});

audio.addEventListener('ended', advance);
audio.addEventListener('play', () => { playing = true; updatePlayPauseButtons(); updateHighlight(); updateQueuePlayButton(); });
audio.addEventListener('pause', () => { playing = false; updatePlayPauseButtons(); updateHighlight(); updateQueuePlayButton(); });
audio.addEventListener('error', () => {
  const track = tracks[nowPlaying];
  if (track) {
    track._err = true;
    toast('Failed: ' + track.title);
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
  document.querySelectorAll('.ti').forEach(el => {
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

  if (nowPlaying < 0) {
    ctrlContainer.innerHTML = '';
    body.innerHTML = '<div class="empty"><p>Nothing playing yet.</p></div>';
    return;
  }

  const track = tracks[nowPlaying];

  // Now-playing controls at the top of the queue panel
  ctrlContainer.innerHTML = `
    <div class="qp-ctrl">
      <div class="qpc-art">${renderArt(track)}</div>
      <div class="qpc-info"><div class="qpc-title">${escapeHTML(track.title)}</div><div class="qpc-sub">${escapeHTML(track.artist || 'Unknown')}</div></div>
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
    html += `<div class="qp-section">Up Next (${upNext.length})</div><div class="tl">`;
    upNext.forEach((trackIdx, queuePos) => {
      html += renderTrackItem(trackIdx, {
        removeIdx: queuePos,
        onclick: `upNext.splice(0,${queuePos});if(!shuffleOn)originalQueue.splice(0,${queuePos});advance()`,
      });
    });
    html += '</div>';
  }

  if (history.length) {
    html += `<div class="qp-section">History</div><div class="tl">`;
    [...history].reverse().forEach(trackIdx => {
      html += renderTrackItem(trackIdx, { hist: true });
    });
    html += '</div>';
  }

  if (!upNext.length && !history.length) {
    html = '<div class="empty" style="padding:40px"><p>Queue is empty. Right-click a track to add it.</p></div>';
  }

  body.innerHTML = html;
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

  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist || 'Unknown',
    album: track.album || 'oomycota',
    artwork: track.art ? [{ src: track.art, sizes: '512x512', type: 'image/jpeg' }] : [],
  });

  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('previoustrack', previousTrack);
  navigator.mediaSession.setActionHandler('nexttrack', nextTrack);
  navigator.mediaSession.setActionHandler('seekto', d => { audio.currentTime = d.seekTime; updatePositionState(); });
  navigator.mediaSession.setActionHandler('seekbackward', d => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10)); updatePositionState(); });
  navigator.mediaSession.setActionHandler('seekforward', d => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (d.seekOffset || 10)); updatePositionState(); });

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
  document.getElementById('ms').classList.add('open');
  setTimeout(() => document.getElementById('msi').focus(), 100);
}

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

  const matches = tracks
    .map((track, i) => [track, i])
    .filter(([track]) =>
      track.title.toLowerCase().includes(term) ||
      (track.artist || '').toLowerCase().includes(term) ||
      (track.album || '').toLowerCase().includes(term)
    );

  if (!matches.length) {
    target.innerHTML = '<div class="empty"><p>No results</p></div>';
    return;
  }

  target.innerHTML = '<div class="tl">' + matches.map(([_, i]) => renderTrackItem(i)).join('') + '</div>';
}


// --- Helpers ---

function formatTime(seconds) {
  if (!seconds || !isFinite(seconds)) return '0:00';
  return Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}


// --- Offline caching ---

let cacheBusy = false;

async function cacheCurrentView() {
  if (cacheBusy) return;
  if (!('caches' in window)) { toast('Not available'); return; }

  cacheBusy = true;
  document.getElementById('cBtn').classList.add('on');
  const progressBar = document.getElementById('cbf');

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

  // Collect all file URLs to cache (audio + artwork)
  const urls = new Set();
  targetTracks.forEach(t => {
    if (t.file) urls.add(t.file);
    if (t.art) urls.add(t.art);
  });
  playlists.forEach(p => { if (p.art) urls.add(p.art); });

  const urlList = [...urls];
  let done = 0;
  toast('Caching ' + label + '...');

  const cache = await caches.open('oomycota');
  for (const url of urlList) {
    try {
      if (!(await cache.match(url))) {
        const response = await fetch(url);
        if (response.ok) await cache.put(url, response);
      }
    } catch {}
    done++;
    progressBar.style.width = ((done / urlList.length) * 100) + '%';
  }

  toast('Cached ' + label);

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
    try { await cache.addAll(['/', 'index.html', 'tracks.json']); } catch {}
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
        audio.src = tracks[idx].file;
        audio.addEventListener('loadedmetadata', function onMeta() {
          audio.currentTime = state.p || 0;
          audio.removeEventListener('loadedmetadata', onMeta);
        });
        updatePlayerUI();
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
