#!/usr/bin/env python3
"""
Oomycota Manager - GUI tool for managing your Oomycota static music player.

Scans a directory for MP3 files, reads ID3 tags, extracts embedded album art,
lets you organize tracks into playlists, and exports tracks.json.

Requirements:
    pip install mutagen
    (tkinter is included with most Python installations)

Usage:
    python oomycota_manager.py
    python oomycota_manager.py /path/to/your/site
"""

import json
import os
import sys
import hashlib
import tkinter as tk
from tkinter import ttk, filedialog, messagebox, simpledialog
from pathlib import Path

try:
    from mutagen.id3 import ID3
    from mutagen import File as MutagenFile
    HAS_MUTAGEN = True
except ImportError:
    HAS_MUTAGEN = False

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MUSIC_EXTENSIONS = {'.mp3', '.m4a', '.webm', '.mp4'}
IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp'}
MUSIC_DIR = 'music'
COVERS_DIR = 'covers'
COVER_SIZE = 512
COVER_QUALITY = 85

DEFAULT_ICONS = [
    '🎵', '🎸', '🎹', '🎷', '🎺', '🥁', '🎻', '🎤',
    '🚗', '🌙', '☀️', '🌊', '🔥', '❤️', '⭐', '🎧',
    '🏃', '🧘', '💪', '🎉', '😴', '📚', '✈️', '🌲',
]

# Colors used throughout the UI
COLORS = {
    'bg':             '#1a1a2e',
    'surface':        '#16213e',
    'primary':        '#0f3460',
    'accent':         '#e94560',
    'accent_hover':   '#c73e54',
    'text':           '#e0e0e0',
    'text_muted':     '#888',
    'white':          '#fff',
}


# ---------------------------------------------------------------------------
# Cover image processing
# ---------------------------------------------------------------------------

def process_cover_image(data):
    """Center-crop image bytes to a square and downscale to COVER_SIZE.

    Cars decode media-session artwork on a throttled background thread;
    large/non-square source images (raw YouTube thumbnails, 1280x720+)
    can fail to decode in time, so covers are normalized to a small
    square JPEG. Returns (image_bytes, ext), falling back to the
    original (data, None) if Pillow is missing or processing fails.
    """
    if not HAS_PIL:
        return data, None
    try:
        import io
        img = Image.open(io.BytesIO(data))
        img.load()
        img = img.convert('RGB')

        w, h = img.size
        side = min(w, h)
        left = (w - side) // 2
        top = (h - side) // 2
        img = img.crop((left, top, left + side, top + side))
        img = img.resize((COVER_SIZE, COVER_SIZE), Image.LANCZOS)

        out = io.BytesIO()
        img.save(out, format='JPEG', quality=COVER_QUALITY)
        return out.getvalue(), '.jpg'
    except Exception:
        return data, None


# ---------------------------------------------------------------------------
# ID3 tag reading and album art extraction
# ---------------------------------------------------------------------------

def read_id3(filepath):
    """Read ID3 tags from an MP3 file.

    Returns a dict with 'title', 'artist', and 'album'.
    Falls back to a cleaned-up filename for the title if mutagen
    is missing or the file has no tags.
    """
    info = {
        'title': Path(filepath).stem.replace('-', ' ').replace('_', ' ').title(),
        'artist': '',
        'album': '',
    }
    if not HAS_MUTAGEN:
        return info
    try:
        tags = ID3(filepath)
        if tags.get('TIT2'):
            info['title'] = str(tags['TIT2'])
        if tags.get('TPE1'):
            info['artist'] = str(tags['TPE1'])
        if tags.get('TALB'):
            info['album'] = str(tags['TALB'])
    except Exception:
        pass
    return info


def read_duration(filepath):
    """Read duration in seconds from an audio file using mutagen.

    Returns the duration rounded to one decimal place, or 0 if
    mutagen is missing or the file can't be read.
    """
    if not HAS_MUTAGEN:
        return 0
    try:
        audio = MutagenFile(filepath)
        if audio and audio.info:
            return round(audio.info.length, 1)
    except Exception:
        pass
    return 0


def extract_embedded_art(filepath, output_dir):
    """Pull the first APIC (album art) frame out of an MP3's ID3 tags.

    Saves the image into output_dir with a content-hashed filename
    to avoid duplicates. Returns the filename on success, None otherwise.
    """
    if not HAS_MUTAGEN:
        return None
    try:
        tags = ID3(filepath)
        for key in tags:
            if not key.startswith('APIC'):
                continue

            apic = tags[key]
            default_ext = {
                'image/png':  '.png',
                'image/webp': '.webp',
            }.get(apic.mime, '.jpg')

            processed, processed_ext = process_cover_image(apic.data)
            ext = processed_ext or default_ext

            filename = hashlib.md5(processed).hexdigest()[:12] + ext
            out_path = os.path.join(output_dir, filename)

            if not os.path.exists(out_path):
                os.makedirs(output_dir, exist_ok=True)
                with open(out_path, 'wb') as f:
                    f.write(processed)
            return filename
    except Exception:
        pass
    return None


# ---------------------------------------------------------------------------
# File and directory helpers
# ---------------------------------------------------------------------------

def copy_image_to_covers(src_path, root_dir):
    """Copy an image into the covers directory, content-hashed to deduplicate.

    Returns the path relative to root_dir (e.g. "covers/abc123.jpg").
    """
    covers_path = os.path.join(root_dir, COVERS_DIR)
    os.makedirs(covers_path, exist_ok=True)

    with open(src_path, 'rb') as f:
        raw = f.read()

    processed, processed_ext = process_cover_image(raw)
    ext = processed_ext or Path(src_path).suffix.lower()
    content_hash = hashlib.md5(processed).hexdigest()[:12]
    filename = content_hash + ext
    dest = os.path.join(covers_path, filename)

    if not os.path.exists(dest):
        with open(dest, 'wb') as f:
            f.write(processed)
    return f'{COVERS_DIR}/{filename}'


def scan_music_dir(root_dir, music_subdir=MUSIC_DIR):
    """Find all MP3 files under root_dir/music_subdir.

    Returns paths relative to root_dir so they include the subdirectory
    prefix (e.g. "music/song.mp3"), matching what the web player expects.
    """
    music_path = os.path.join(root_dir, music_subdir)
    if not os.path.isdir(music_path):
        return []

    found = []
    for dirpath, _, filenames in os.walk(music_path):
        for fn in sorted(filenames):
            if Path(fn).suffix.lower() in MUSIC_EXTENSIONS:
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, root_dir).replace('\\', '/')
                found.append(rel)
    return found


def scan_images(root_dir):
    """Recursively find all image files under root_dir."""
    found = []
    for dirpath, _, filenames in os.walk(root_dir):
        for fn in sorted(filenames):
            if Path(fn).suffix.lower() in IMAGE_EXTENSIONS:
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, root_dir).replace('\\', '/')
                found.append(rel)
    return found


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------

class TrackEntry:
    """A single track with metadata and an optional cover art path."""

    def __init__(self, file='', title='', artist='', album='', art='', dur=0):
        self.file = file
        self.title = title
        self.artist = artist
        self.album = album
        self.art = art
        self.dur = dur

    def to_dict(self):
        d = {'title': self.title, 'artist': self.artist, 'file': self.file}
        if self.album:
            d['album'] = self.album
        if self.art:
            d['art'] = self.art
        if self.dur:
            d['dur'] = self.dur
        return d


class PlaylistEntry:
    """A named playlist that references tracks by their index in the track list."""

    def __init__(self, name='', icon='🎵', art='', track_indices=None):
        self.name = name
        self.icon = icon
        self.art = art
        self.track_indices = track_indices or []

    def to_dict(self):
        d = {
            'name': self.name,
            'icon': self.icon,
            'trackIndices': self.track_indices,
        }
        if self.art:
            d['art'] = self.art
        return d


# ---------------------------------------------------------------------------
# Main application window
# ---------------------------------------------------------------------------

class OomycotaManager(tk.Tk):

    def __init__(self, initial_dir=None):
        super().__init__()
        self.title('Oomycota Manager')
        self.geometry('1750x720')
        self.minsize(1200, 550)

        # Application state
        self.root_dir = initial_dir or ''
        self.tracks = []
        self.playlists = []
        self.available_images = []
        self.dirty = False  # True when there are unsaved changes
        self._selected_playlist_idx = None

        # Sort state: None = natural order, otherwise (column_id, reverse)
        self._sort_key = None      # e.g. 'title', 'artist', 'album', 'file'
        self._sort_reverse = False
        # Maps display position -> real index in self.tracks (None = unsorted)
        self._sort_map = None

        self._apply_theme()
        self._build_ui()

        if self.root_dir:
            self._load_directory()

    # -------------------------------------------------------------------
    # Theming
    # -------------------------------------------------------------------

    def _apply_theme(self):
        """Configure ttk styles and the root window background."""
        c = COLORS
        style = ttk.Style(self)
        style.theme_use('clam')
        self.configure(bg=c['bg'])

        style.configure('.', background=c['bg'], foreground=c['text'],
                        fieldbackground=c['surface'], borderwidth=0)
        style.configure('TFrame',   background=c['bg'])
        style.configure('TLabel',   background=c['bg'], foreground=c['text'],
                        font=('Helvetica', 10))
        style.configure('TButton',  background=c['primary'], foreground=c['text'],
                        font=('Helvetica', 10), padding=6)
        style.map('TButton', background=[('active', c['accent'])])

        style.configure('Accent.TButton', background=c['accent'],
                        foreground=c['white'],
                        font=('Helvetica', 10, 'bold'), padding=8)
        style.map('Accent.TButton', background=[('active', c['accent_hover'])])

        style.configure('Header.TLabel', font=('Helvetica', 12, 'bold'),
                        foreground=c['accent'])
        style.configure('Title.TLabel',  font=('Helvetica', 14, 'bold'),
                        foreground=c['accent'])

        style.configure('Sort.TLabel', font=('Helvetica', 9),
                        foreground=c['accent'], background=c['bg'])

        style.configure('Treeview', background=c['surface'], foreground=c['text'],
                        fieldbackground=c['surface'], rowheight=28,
                        font=('Helvetica', 10))
        style.configure('Treeview.Heading', background=c['primary'],
                        foreground=c['text'], font=('Helvetica', 10, 'bold'))
        style.map('Treeview',
                  background=[('selected', c['accent'])],
                  foreground=[('selected', c['white'])])

    # -------------------------------------------------------------------
    # UI construction
    # -------------------------------------------------------------------

    def _build_ui(self):
        self._build_top_bar()
        self._build_dir_label()

        # Two-panel layout: tracks on the left, playlists on the right
        pw = ttk.PanedWindow(self, orient='horizontal')
        pw.pack(fill='both', expand=True, padx=10, pady=(0, 10))

        left = ttk.Frame(pw)
        pw.add(left, weight=3)
        self._build_track_panel(left)

        right = ttk.Frame(pw)
        pw.add(right, weight=2)
        self._build_playlist_panel(right)

    def _build_top_bar(self):
        top = ttk.Frame(self, padding=10)
        top.pack(fill='x')

        ttk.Label(top, text='OOMYCOTA MANAGER', style='Title.TLabel').pack(side='left')

        btn_frame = ttk.Frame(top)
        btn_frame.pack(side='right')
        ttk.Button(btn_frame, text='📂 Open Folder',
                   command=self._pick_dir).pack(side='left', padx=4)
        ttk.Button(btn_frame, text='📄 Import tracks.json',
                   command=self._import_json).pack(side='left', padx=4)
        ttk.Button(btn_frame, text='💾 Save tracks.json', style='Accent.TButton',
                   command=self._save_json).pack(side='left', padx=4)

    def _build_dir_label(self):
        self.dir_var = tk.StringVar(value='No folder selected')
        ttk.Label(self, textvariable=self.dir_var, font=('Helvetica', 9),
                  foreground=COLORS['text_muted']).pack(fill='x', padx=14, pady=(0, 4))

    def _build_track_panel(self, parent):
        """Left panel: track list with scan/edit/reorder controls."""

        # Header row with scan buttons
        header = ttk.Frame(parent)
        header.pack(fill='x', pady=(0, 6))
        ttk.Label(header, text='Tracks', style='Header.TLabel').pack(side='left')
        ttk.Button(header, text='🖼 Extract Art',
                   command=self._extract_all_art).pack(side='right', padx=4)
        ttk.Button(header, text='🔄 Resync',
                command=self._resync_tracks).pack(side='right', padx=4)
        ttk.Button(header, text='🔍 Scan for MP3s',
                   command=self._scan_files).pack(side='right', padx=4)

        # Sort indicator bar
        sort_bar = ttk.Frame(parent)
        sort_bar.pack(fill='x', pady=(0, 2))
        self._sort_label_var = tk.StringVar(value='')
        self._sort_label = ttk.Label(sort_bar, textvariable=self._sort_label_var,
                                     style='Sort.TLabel')
        self._sort_label.pack(side='left')
        self._unsort_btn = ttk.Button(sort_bar, text='✕ Clear Sort',
                                      command=self._clear_sort)
        # Hidden until a sort is active

        # Track area: treeview on the left, action buttons on the right
        track_area = ttk.Frame(parent)
        track_area.pack(fill='both', expand=True)

        self._build_track_treeview(track_area)
        self._build_track_actions(track_area)

    def _build_track_treeview(self, parent):
        """Scrollable treeview showing all tracks."""
        frame = ttk.Frame(parent)
        frame.pack(side='left', fill='both', expand=True)

        cols = ('title', 'artist', 'album', 'art', 'file')
        self.track_tree = ttk.Treeview(frame, columns=cols,
                                       show='headings', selectmode='extended')

        col_config = [
            ('title',  'Title',  200),
            ('artist', 'Artist', 150),
            ('album',  'Album',  120),
            ('art',    'Cover',  120),
            ('file',   'File',   200),
        ]
        for col_id, heading, width in col_config:
            self.track_tree.heading(
                col_id, text=heading,
                command=lambda c=col_id: self._toggle_sort(c),
            )
            self.track_tree.column(col_id, width=width)

        scrollbar = ttk.Scrollbar(frame, orient='vertical',
                                  command=self.track_tree.yview)
        self.track_tree.configure(yscrollcommand=scrollbar.set)
        self.track_tree.pack(side='left', fill='both', expand=True)
        scrollbar.pack(side='left', fill='y')

        self.track_tree.bind('<Double-1>', self._edit_track)
        self.track_tree.bind('<Delete>', self._delete_tracks)

    def _build_track_actions(self, parent):
        """Vertical column of track action buttons."""
        col = ttk.Frame(parent)
        col.pack(side='left', fill='y', padx=(8, 0))

        actions = [
            ('✏️  Edit',      self._edit_track),
            ('🖼  Set Cover', self._set_track_cover),
            ('🗑  Remove',    self._delete_tracks),
            ('⬆  Move Up',   lambda: self._move_track(-1)),
            ('⬇  Move Down', lambda: self._move_track(1)),
        ]
        for text, cmd in actions:
            ttk.Button(col, text=text, command=cmd, width=14).pack(fill='x', pady=2)

    def _build_playlist_panel(self, parent):
        """Right panel: playlist list, detail view, and track assignment."""

        # Header with "New" button
        header = ttk.Frame(parent)
        header.pack(fill='x', pady=(0, 6))
        ttk.Label(header, text='Playlists', style='Header.TLabel').pack(side='left')
        ttk.Button(header, text='+ New',
                   command=self._new_playlist).pack(side='right', padx=4)

        # Playlist listbox (exportselection=False keeps selection when
        # focus moves to the track tree)
        self.playlist_list = tk.Listbox(
            parent, bg=COLORS['surface'], fg=COLORS['text'],
            selectbackground=COLORS['accent'], selectforeground=COLORS['white'],
            font=('Helvetica', 11), borderwidth=0,
            highlightthickness=0, activestyle='none',
            exportselection=False, height=6,
        )
        self.playlist_list.pack(fill='x', pady=(0, 6))
        self.playlist_list.bind('<<ListboxSelect>>', self._on_playlist_select)

        # Playlist action buttons
        btn_row = ttk.Frame(parent)
        btn_row.pack(fill='x', pady=(0, 6))
        for text, cmd in [
            ('✏️ Rename', self._rename_playlist),
            ('🎨 Icon',   self._change_icon),
            ('🖼 Art',    self._set_playlist_art),
            ('🗑 Delete', self._delete_playlist),
        ]:
            ttk.Button(btn_row, text=text, command=cmd).pack(side='left', padx=2)

        # "Tracks in playlist" sub-section
        sub_header = ttk.Frame(parent)
        sub_header.pack(fill='x', pady=(6, 4))
        ttk.Label(sub_header, text='Tracks in playlist:',
                  style='Header.TLabel').pack(side='left')
        ttk.Button(sub_header, text='+ Add Selected Tracks',
                   command=self._add_to_playlist).pack(side='right', padx=2)

        # Scrollable listbox for the selected playlist's tracks
        list_frame = ttk.Frame(parent)
        list_frame.pack(fill='both', expand=True, pady=(0, 6))

        self.pl_tracks = tk.Listbox(
            list_frame, bg=COLORS['surface'], fg=COLORS['text'],
            selectbackground=COLORS['accent'], selectforeground=COLORS['white'],
            font=('Helvetica', 10), borderwidth=0,
            highlightthickness=0, selectmode='extended',
            exportselection=False,
        )
        scrollbar = ttk.Scrollbar(list_frame, orient='vertical',
                                  command=self.pl_tracks.yview)
        self.pl_tracks.configure(yscrollcommand=scrollbar.set)
        self.pl_tracks.pack(side='left', fill='both', expand=True)
        scrollbar.pack(side='left', fill='y')

        ttk.Button(parent, text='− Remove from Playlist',
                   command=self._remove_from_playlist).pack(anchor='w')

    # -------------------------------------------------------------------
    # Sorting (temporary, display-only)
    # -------------------------------------------------------------------

    def _toggle_sort(self, col_id):
        """Cycle through: ascending -> descending -> unsorted for the given column."""
        if self._sort_key == col_id:
            if not self._sort_reverse:
                # Was ascending -> go descending
                self._sort_reverse = True
            else:
                # Was descending -> clear sort
                self._clear_sort()
                return
        else:
            self._sort_key = col_id
            self._sort_reverse = False

        self._apply_sort()

    def _apply_sort(self):
        """Build _sort_map and refresh the treeview in sorted order."""
        attr = self._sort_key  # column ids match TrackEntry attrs directly

        indexed = [(i, getattr(self.tracks[i], attr, '').lower())
                   for i in range(len(self.tracks))]
        indexed.sort(key=lambda pair: pair[1], reverse=self._sort_reverse)
        self._sort_map = [real_idx for real_idx, _ in indexed]

        self._refresh_track_tree()
        self._update_sort_indicator()

    def _clear_sort(self):
        """Return to the natural (unsorted) track order."""
        self._sort_key = None
        self._sort_reverse = False
        self._sort_map = None
        self._refresh_track_tree()
        self._update_sort_indicator()

    def _update_sort_indicator(self):
        """Update the sort label and show/hide the clear-sort button."""
        # Column heading labels (base text without arrows)
        col_headings = {
            'title': 'Title', 'artist': 'Artist', 'album': 'Album',
            'art': 'Cover', 'file': 'File',
        }

        if self._sort_key is None:
            self._sort_label_var.set('')
            self._unsort_btn.pack_forget()
        else:
            arrow = '▼' if self._sort_reverse else '▲'
            self._sort_label_var.set(
                f'Sorted by {self._sort_key} {arrow}  (display only — track order unchanged)')
            self._unsort_btn.pack(side='left', padx=(8, 0))

        # Update column headings to show sort arrow on the active column
        for col_id, base_heading in col_headings.items():
            if col_id == self._sort_key:
                arrow = ' ▼' if self._sort_reverse else ' ▲'
                self.track_tree.heading(col_id, text=base_heading + arrow)
            else:
                self.track_tree.heading(col_id, text=base_heading)

    def _display_order(self):
        """Return the list of real track indices in the current display order."""
        if self._sort_map is not None:
            return self._sort_map
        return list(range(len(self.tracks)))

    def _iid_to_real_index(self, iid):
        """Convert a treeview item id back to the real index in self.tracks.

        Item ids are stored as 'r<real_index>' so they always reference
        the true position regardless of the current display sort.
        """
        return int(iid[1:])

    def _selected_real_indices(self):
        """Return the real track indices for whatever is selected in the treeview."""
        return [self._iid_to_real_index(s) for s in self.track_tree.selection()]

    # -------------------------------------------------------------------
    # Directory loading and MP3 scanning
    # -------------------------------------------------------------------

    def _pick_dir(self):
        d = filedialog.askdirectory(title='Select your Oomycota site folder')
        if d:
            self.root_dir = d
            self._load_directory()

    def _load_directory(self):
        """Load tracks.json if it exists, then refresh the UI."""
        self.dir_var.set(self.root_dir)

        json_path = os.path.join(self.root_dir, 'tracks.json')
        if os.path.exists(json_path):
            self._do_import(json_path)
        else:
            self.tracks = []
            self.playlists = []

        self.available_images = scan_images(self.root_dir)
        self._clear_sort()
        self._refresh_track_tree()
        self._refresh_playlist_list()

    def _scan_files(self):
        """Walk the music directory for new MP3s and add them to the track list."""
        if not self.root_dir:
            messagebox.showwarning('No Folder', 'Open a folder first.')
            return

        music_path = os.path.join(self.root_dir, MUSIC_DIR)
        if not os.path.isdir(music_path):
            messagebox.showwarning(
                'No Music Folder',
                f'No "{MUSIC_DIR}/" folder found in:\n{self.root_dir}\n\n'
                f'Create a "{MUSIC_DIR}/" folder and put your MP3s in it.',
            )
            return

        mp3s = scan_music_dir(self.root_dir)
        existing_files = {t.file for t in self.tracks}
        added = 0

        for rel in mp3s:
            if rel in existing_files:
                continue
            full_path = os.path.join(self.root_dir, rel)
            info = read_id3(full_path)
            dur = read_duration(full_path)
            self.tracks.append(TrackEntry(
                file=rel,
                title=info['title'],
                artist=info['artist'],
                album=info['album'],
                dur=dur,
            ))
            added += 1

        self.available_images = scan_images(self.root_dir)
        # Re-apply current sort if one is active so new tracks slot in
        if self._sort_key is not None:
            self._apply_sort()
        else:
            self._refresh_track_tree()
        self.dirty = True

        msg = f'Found {added} new track(s).'
        if not HAS_MUTAGEN:
            msg += '\n\nInstall mutagen for ID3 tag reading:\npip install mutagen'
        messagebox.showinfo('Scan Complete', msg)

    def _extract_all_art(self):
        """Extract embedded album art from every track that doesn't have cover art set."""
        if not self.root_dir:
            return
        if not HAS_MUTAGEN:
            messagebox.showwarning(
                'Missing mutagen',
                'Install mutagen to extract embedded art:\npip install mutagen',
            )
            return

        covers_path = os.path.join(self.root_dir, COVERS_DIR)
        count = 0

        for t in self.tracks:
            if t.art:
                continue
            full_path = os.path.join(self.root_dir, t.file)
            if not os.path.exists(full_path):
                continue
            art_file = extract_embedded_art(full_path, covers_path)
            if art_file:
                t.art = f'{COVERS_DIR}/{art_file}'
                count += 1

        self.available_images = scan_images(self.root_dir)
        self._refresh_track_tree()
        self.dirty = True
        messagebox.showinfo('Extract Art', f'Extracted cover art for {count} track(s).')

    def _resync_tracks(self):
            """Remove tracks whose files no longer exist on disk."""
            if not self.root_dir:
                messagebox.showwarning('No Folder', 'Open a folder first.')
                return

            missing = []
            for i, t in enumerate(self.tracks):
                full_path = os.path.join(self.root_dir, t.file)
                if not os.path.exists(full_path):
                    missing.append(i)

            if not missing:
                messagebox.showinfo('Resync', 'All tracks still exist on disk. Nothing to remove.')
                return

            names = '\n'.join(self.tracks[i].title or self.tracks[i].file for i in missing)
            if not messagebox.askyesno(
                'Resync',
                f'{len(missing)} track(s) no longer found on disk:\n\n{names}\n\n'
                'Remove them from the track list and all playlists?',
            ):
                return

            # Collect cover paths from tracks being removed
            removed_covers = {self.tracks[i].art for i in missing if self.tracks[i].art}

            for idx in sorted(missing, reverse=True):
                self.tracks.pop(idx)
                for pl in self.playlists:
                    pl.track_indices = [
                        ti if ti < idx else ti - 1
                        for ti in pl.track_indices if ti != idx
                    ]

            # Figure out which covers are still in use by remaining tracks or playlists
            still_used = {t.art for t in self.tracks if t.art}
            still_used.update(pl.art for pl in self.playlists if pl.art)

            # Delete orphaned cover files
            orphaned = removed_covers - still_used
            deleted_covers = 0
            for art_rel in orphaned:
                art_path = os.path.join(self.root_dir, art_rel)
                if os.path.exists(art_path):
                    try:
                        os.remove(art_path)
                        deleted_covers += 1
                    except Exception:
                        pass

            self.available_images = scan_images(self.root_dir)

            if self._sort_key is not None:
                self._apply_sort()
            else:
                self._refresh_track_tree()
            self._refresh_playlist_list()
            self._refresh_pl_tracks()
            self.dirty = True

            msg = f'Removed {len(missing)} missing track(s).'
            if deleted_covers:
                msg += f'\nDeleted {deleted_covers} orphaned cover image(s).'
            messagebox.showinfo('Resync', msg)

    # -------------------------------------------------------------------
    # Track tree: display, editing, reordering, deletion
    # -------------------------------------------------------------------

    def _refresh_track_tree(self):
        self.track_tree.delete(*self.track_tree.get_children())
        for real_idx in self._display_order():
            t = self.tracks[real_idx]
            art_display = os.path.basename(t.art) if t.art else ''
            # Use 'r' prefix + real index as the iid so we can always
            # map back to the true position regardless of sort state
            self.track_tree.insert('', 'end', iid=f'r{real_idx}',
                                   values=(t.title, t.artist, t.album,
                                           art_display, t.file))

    def _edit_track(self, event=None):
        """Open a dialog to edit the selected track's metadata."""
        sel = self.track_tree.selection()
        if not sel:
            return
        idx = self._iid_to_real_index(sel[0])
        t = self.tracks[idx]

        win = tk.Toplevel(self)
        win.title(f'Edit: {t.title}')
        win.geometry('630x280')
        win.configure(bg=COLORS['bg'])
        win.transient(self)
        win.grab_set()

        field_defs = [
            ('Title',      'title'),
            ('Artist',     'artist'),
            ('Album',      'album'),
            ('Cover Path', 'art'),
            ('File Path',  'file'),
        ]
        fields = {}
        for row, (label, attr) in enumerate(field_defs):
            ttk.Label(win, text=label).grid(row=row, column=0, padx=10, pady=4, sticky='e')
            var = tk.StringVar(value=getattr(t, attr))
            ttk.Entry(win, textvariable=var, width=60).grid(
                row=row, column=1, padx=10, pady=4, sticky='ew')
            fields[attr] = var

        win.grid_columnconfigure(1, weight=1)

        def save():
            for attr, var in fields.items():
                setattr(t, attr, var.get().strip())
            # Re-sort if a sort is active (edited value may change position)
            if self._sort_key is not None:
                self._apply_sort()
            else:
                self._refresh_track_tree()
            self._refresh_pl_tracks()
            self.dirty = True
            win.destroy()

        ttk.Button(win, text='Save', style='Accent.TButton', command=save).grid(
            row=len(field_defs), column=0, columnspan=2, pady=12)

    def _set_track_cover(self):
        """Assign a cover image to every selected track."""
        sel = self.track_tree.selection()
        if not sel or not self.root_dir:
            return

        path = filedialog.askopenfilename(
            title='Select cover image',
            initialdir=self.root_dir,
            filetypes=[('Images', '*.jpg *.jpeg *.png *.webp')],
        )
        if not path:
            return

        # If the image is outside the site folder, copy it into covers/
        if not os.path.abspath(path).startswith(os.path.abspath(self.root_dir)):
            rel = copy_image_to_covers(path, self.root_dir)
        else:
            rel = os.path.relpath(path, self.root_dir).replace('\\', '/')

        for s in sel:
            self.tracks[self._iid_to_real_index(s)].art = rel

        self._refresh_track_tree()
        self.dirty = True

    def _delete_tracks(self, event=None):
        """Remove selected tracks from the list (files on disk are not touched)."""
        sel = self.track_tree.selection()
        if not sel:
            return
        if not messagebox.askyesno(
            'Remove Tracks',
            f'Remove {len(sel)} track(s) from the list?\n'
            '(Files are not deleted from disk.)',
        ):
            return

        # Remove from highest index first so earlier indices stay valid
        indices = sorted(self._selected_real_indices(), reverse=True)
        for idx in indices:
            self.tracks.pop(idx)
            # Adjust every playlist's indices to account for the removal
            for pl in self.playlists:
                pl.track_indices = [
                    ti if ti < idx else ti - 1
                    for ti in pl.track_indices if ti != idx
                ]

        # Re-apply sort or refresh
        if self._sort_key is not None:
            self._apply_sort()
        else:
            self._refresh_track_tree()
        self._refresh_playlist_list()
        self._refresh_pl_tracks()
        self.dirty = True

    def _move_track(self, direction):
        """Swap the selected track with its neighbor. direction is -1 (up) or +1 (down).

        Disabled while a sort is active because the display order is temporary.
        """
        if self._sort_map is not None:
            messagebox.showinfo(
                'Sort Active',
                'Clear the column sort first to reorder tracks.\n'
                '(The current sort is display-only.)',
            )
            return

        sel = self.track_tree.selection()
        if len(sel) != 1:
            return
        idx = self._iid_to_real_index(sel[0])
        new_idx = idx + direction
        if new_idx < 0 or new_idx >= len(self.tracks):
            return

        # Swap in the track list
        self.tracks[idx], self.tracks[new_idx] = self.tracks[new_idx], self.tracks[idx]

        # Update playlist references so they follow the moved tracks
        for pl in self.playlists:
            pl.track_indices = [
                new_idx if ti == idx else idx if ti == new_idx else ti
                for ti in pl.track_indices
            ]

        self._refresh_track_tree()
        self.track_tree.selection_set(f'r{new_idx}')
        self.track_tree.see(f'r{new_idx}')
        self.dirty = True

    # -------------------------------------------------------------------
    # Playlist management
    # -------------------------------------------------------------------

    def _refresh_playlist_list(self):
        self.playlist_list.delete(0, 'end')
        for pl in self.playlists:
            art_tag = ' 🖼' if pl.art else ''
            label = f'{pl.icon}  {pl.name}  ({len(pl.track_indices)} tracks){art_tag}'
            self.playlist_list.insert('end', label)

        # Restore the previously active selection
        if (self._selected_playlist_idx is not None
                and self._selected_playlist_idx < len(self.playlists)):
            self.playlist_list.selection_set(self._selected_playlist_idx)

    def _get_selected_playlist(self):
        """Return (index, PlaylistEntry) for the selected playlist, or (None, None)."""
        sel = self.playlist_list.curselection()
        if not sel:
            return None, None
        idx = sel[0]
        return idx, self.playlists[idx]

    def _on_playlist_select(self, event=None):
        idx, _ = self._get_selected_playlist()
        self._selected_playlist_idx = idx
        self._refresh_pl_tracks()

    def _refresh_pl_tracks(self):
        """Repopulate the playlist-tracks listbox for the currently selected playlist."""
        self.pl_tracks.delete(0, 'end')
        idx = self._selected_playlist_idx
        if idx is None or idx >= len(self.playlists):
            return
        pl = self.playlists[idx]
        for ti in pl.track_indices:
            if 0 <= ti < len(self.tracks):
                t = self.tracks[ti]
                self.pl_tracks.insert('end', f'{ti + 1}. {t.title}  -  {t.artist}')

    def _new_playlist(self):
        name = simpledialog.askstring('New Playlist', 'Playlist name:', parent=self)
        if not name:
            return
        self.playlists.append(PlaylistEntry(name=name.strip()))
        self._selected_playlist_idx = len(self.playlists) - 1
        self._refresh_playlist_list()
        self._refresh_pl_tracks()
        self.dirty = True

    def _rename_playlist(self):
        idx, pl = self._get_selected_playlist()
        if pl is None:
            return
        name = simpledialog.askstring('Rename Playlist', 'New name:', parent=self,
                                      initialvalue=pl.name)
        if name:
            pl.name = name.strip()
            self._selected_playlist_idx = idx
            self._refresh_playlist_list()
            self.dirty = True

    def _change_icon(self):
        """Show a picker dialog with preset and custom emoji options."""
        idx, pl = self._get_selected_playlist()
        if pl is None:
            return

        win = tk.Toplevel(self)
        win.title('Pick Icon')
        win.geometry('500x220')
        win.configure(bg=COLORS['bg'])
        win.transient(self)
        win.grab_set()

        ttk.Label(win, text='Choose an icon:').pack(pady=(10, 6))

        def pick(icon):
            pl.icon = icon
            self._selected_playlist_idx = idx
            self._refresh_playlist_list()
            self.dirty = True
            win.destroy()

        # Grid of preset icons
        grid = ttk.Frame(win)
        grid.pack(padx=10, pady=6)
        cols = 8
        for i, icon in enumerate(DEFAULT_ICONS):
            btn = tk.Button(grid, text=icon, font=('Helvetica', 16),
                            bg=COLORS['surface'], fg=COLORS['text'], borderwidth=0,
                            activebackground=COLORS['accent'], width=2, height=1,
                            command=lambda ic=icon: pick(ic))
            btn.grid(row=i // cols, column=i % cols, padx=3, pady=3)

        # Custom input
        custom_frame = ttk.Frame(win)
        custom_frame.pack(pady=6)
        ttk.Label(custom_frame, text='Or type:').pack(side='left', padx=4)
        custom_var = tk.StringVar()
        ttk.Entry(custom_frame, textvariable=custom_var, width=8).pack(side='left', padx=4)
        ttk.Button(custom_frame, text='Use',
                   command=lambda: pick(custom_var.get() or '📁')).pack(side='left', padx=4)

    def _set_playlist_art(self):
        idx, pl = self._get_selected_playlist()
        if pl is None:
            messagebox.showinfo('No Playlist', 'Select a playlist first.')
            return
        if not self.root_dir:
            messagebox.showwarning('No Folder', 'Open a folder first.')
            return

        path = filedialog.askopenfilename(
            title='Select playlist cover image',
            initialdir=self.root_dir,
            filetypes=[('Images', '*.jpg *.jpeg *.png *.webp')],
        )
        if not path:
            return

        rel = copy_image_to_covers(path, self.root_dir)
        pl.art = rel
        self._selected_playlist_idx = idx
        self._refresh_playlist_list()
        self.dirty = True
        messagebox.showinfo('Playlist Art', f'Set cover for "{pl.name}" to {rel}')

    def _delete_playlist(self):
        idx, pl = self._get_selected_playlist()
        if pl is None:
            return
        if messagebox.askyesno('Delete Playlist', f'Delete "{pl.name}"?'):
            self.playlists.pop(idx)
            self._selected_playlist_idx = None
            self._refresh_playlist_list()
            self.pl_tracks.delete(0, 'end')
            self.dirty = True

    def _add_to_playlist(self):
        """Add the tracks selected in the track tree to the active playlist."""
        _, pl = self._get_selected_playlist()
        if pl is None:
            messagebox.showinfo('No Playlist', 'Select a playlist on the right first.')
            return
        sel = self.track_tree.selection()
        if not sel:
            messagebox.showinfo('No Tracks', 'Select tracks on the left to add.')
            return

        existing = set(pl.track_indices)
        for s in sel:
            idx = self._iid_to_real_index(s)
            if idx not in existing:
                pl.track_indices.append(idx)
                existing.add(idx)

        self._refresh_pl_tracks()
        self._refresh_playlist_list()
        self.dirty = True

    def _remove_from_playlist(self):
        """Remove highlighted entries from the active playlist (tracks themselves are kept)."""
        _, pl = self._get_selected_playlist()
        if pl is None:
            return
        sel = self.pl_tracks.curselection()
        if not sel:
            return
        for i in sorted(sel, reverse=True):
            pl.track_indices.pop(i)
        self._refresh_pl_tracks()
        self._refresh_playlist_list()
        self.dirty = True

    # -------------------------------------------------------------------
    # JSON import and export
    # -------------------------------------------------------------------

    def _import_json(self):
        path = filedialog.askopenfilename(
            title='Open tracks.json',
            filetypes=[('JSON', '*.json'), ('All', '*.*')],
        )
        if path:
            self._do_import(path)
            self.root_dir = os.path.dirname(path)
            self.dir_var.set(self.root_dir)

    def _do_import(self, path):
        """Parse a tracks.json file and populate self.tracks and self.playlists."""
        try:
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except Exception as e:
            messagebox.showerror('Import Error', str(e))
            return

        self.tracks = []
        self.playlists = []

        # tracks.json can be either a bare list of tracks or
        # an object with "tracks" and optional "playlists" keys
        track_list = data.get('tracks', data) if isinstance(data, dict) else data
        if isinstance(track_list, list):
            for t in track_list:
                self.tracks.append(TrackEntry(
                    file=t.get('file', ''),
                    title=t.get('title', ''),
                    artist=t.get('artist', ''),
                    album=t.get('album', ''),
                    art=t.get('art', ''),
                    dur=t.get('dur', 0),
                ))

        if isinstance(data, dict):
            for p in data.get('playlists', []):
                self.playlists.append(PlaylistEntry(
                    name=p.get('name', ''),
                    icon=p.get('icon', '🎵'),
                    art=p.get('art', ''),
                    track_indices=list(p.get('trackIndices', [])),
                ))

        self._selected_playlist_idx = None
        self._clear_sort()
        self._refresh_track_tree()
        self._refresh_playlist_list()

    def _save_json(self):
        """Write tracks and playlists to tracks.json in the site root.

        Always saves in the original (unsorted) track order — the sort
        is purely visual and never affects the persisted data.
        """
        if not self.root_dir:
            path = filedialog.asksaveasfilename(
                title='Save tracks.json',
                defaultextension='.json',
                filetypes=[('JSON', '*.json')],
            )
            if not path:
                return
        else:
            path = os.path.join(self.root_dir, 'tracks.json')

        data = {'tracks': [t.to_dict() for t in self.tracks]}
        if self.playlists:
            data['playlists'] = [p.to_dict() for p in self.playlists]

        try:
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            self.dirty = False
            messagebox.showinfo(
                'Saved',
                f'Saved {len(self.tracks)} tracks and '
                f'{len(self.playlists)} playlists to:\n{path}',
            )
        except Exception as e:
            messagebox.showerror('Save Error', str(e))

    # -------------------------------------------------------------------
    # Window close with unsaved-changes prompt
    # -------------------------------------------------------------------

    def destroy(self):
        if self.dirty:
            if messagebox.askyesno('Unsaved Changes',
                                   'You have unsaved changes. Save before quitting?'):
                self._save_json()
        super().destroy()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    initial = sys.argv[1] if len(sys.argv) > 1 else None
    app = OomycotaManager(initial_dir=initial)
    app.mainloop()
