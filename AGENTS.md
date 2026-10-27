# AGENTS.md — Seabed Architectural Invariants & Engineering Standards

## 1. Global Engineering Philosophy

Seabed (`seabed@studio2201.github.io`) is built on four uncompromising engineering pillars:

1. **Linus Torvalds' "Good Taste"**: Eliminate special-case branching through clean data representation (immutable frozen enums, normalized desktop entry records, and pure grid-slot / tile-style calculators).
2. **UNIX Philosophy**: Each module ("page") does one thing well, composes cleanly via explicit ES2022 imports, and avoids hidden global state.
3. **NASA JPL Power-of-10 Safety Rules**:
   - All `~/Desktop` directory enumerations (`file_scanner.js`), `trash:///` counts, and `Gio.VolumeMonitor` mount scans enforce explicit upper iteration bounds (`MAX_DESKTOP_ENTRIES = 256`, `MAX_TRASH_PROBES = 64`, `MAX_VOLUMES = 32`).
   - Zero dynamic code evaluation (`eval`, `Function`) and zero external subprocesses (`Gio.Subprocess`, `GLib.spawn_*`) in the compositor.
   - All `GLib.timeout_add` sources are deterministically named via `GLib.Source.set_name_by_id` and removed on teardown.
4. **OWASP Zero-Trust & Multi-Distro Security**:
   - Zero external GTK3 desktop-window subprocesses (`ding.js` / `emulateX11WindowType.js` eliminated); renders natively inside `Main.layoutManager._backgroundGroup` across Fedora, Debian, Ubuntu, Arch, openSUSE, and NixOS.
   - Integrates with `systemd-logind` lock/suspend via `"session-modes": ["user"]`, cleanly destroying background actors, cancelling `Gio.Cancellable` enumerations, and disconnecting file/volume monitors on `disable()`.

---

## 2. The Page Rule & Directory Density (Enforced by `tests/verify.js`)

- **File Line Bounds**: Every `.js` source file in the repository (`extension/`, `tests/`) **must** be between **16 and 256 lines** (`16..=256`), and every line **must** be at most **200 characters** (`<= 200`).
- **Directory Density**: Every directory in the repository (`root`, `tests/`, `extension/`, and all subdirectories) **must** contain **at most 8 visible entries** (`<= 8`).
- **Banned Generic Names**: Generic grab-bag names (`util`, `utils`, `lib`, `helper`, `helpers`, `common`, `misc`, `shared`, `base`, `core`, `types`, `mod`) are strictly forbidden.
- **2-Line SPDX + Concise Module Header**:
   - Line 1 of every `.js` file must be `// SPDX-License-Identifier: GPL-3.0-or-later`.
   - Line 2 of every `.js` file must be a concise single-line module description (`// <Concise module description>`).

---

## 3. Process-Boundary & GNOME Shell / EGO Lifecycle Invariants (`tests/verify.js`)

- **ES2022 Strictness**: Zero `var` declarations (`const`/`let` only) and zero loose equality operators (`===`/`!==` only).
- **Process Boundary Separation**: `extension/prefs.js` runs in the GTK4 `gnome-extensions-app` process. Neither `prefs.js` nor any module in its import chain (`desktop/desktop_grid.js`, `ui/tile_style.js`, `ui/settings/color.js`, `ui/settings/gsettings.js`, `ui/settings/prefs_pages.js`) may import compositor-only typelibs (`gi://Meta`, `gi://Clutter`, `gi://St`, `gi://Shell`, `resource:///org/gnome/shell/*`).
- **Deterministic EGO Teardown**: `extension/extension.js` performs zero top-level work at import time and deterministically cleans up all `Main.layoutManager._backgroundGroup` actors, `Gio.FileMonitor` instances, `Gio.VolumeMonitor` signal connections, `Gio.Cancellable` handles, named `GLib` timers, popup menus, and loaded stylesheets on `disable()`.

---

## 4. Functional Page Map

### Verification & Test Suite (`tests/` — 1 page)
- [`tests/verify.js`](tests/verify.js): Zero-dependency GJS architectural lint, Page Rule (`16..=256` lines, `<= 8` entries/dir), process-boundary check, GTK4/Libadwaita Preferences inspection, and headless behavioral test suite (`gjs -m tests/verify.js`).

### GNOME Shell Extension (`extension/` — 11 JS pages across 2 domain trees)
- **Root Entrypoints**:
  - [`extension/extension.js`](extension/extension.js): `SeabedExtension extends Extension` EGO lifecycle entrypoint.
  - [`extension/prefs.js`](extension/prefs.js): `SeabedPreferences extends ExtensionPreferences` 4-tab GTK4 / Libadwaita preferences UI.
- **Native Compositor Desktop Engine (`extension/desktop/` — 5 pages)**:
  - [`desktop_manager.js`](extension/desktop/desktop_manager.js): `Main.layoutManager._backgroundGroup` desktop canvas lifecycle, monitor workarea tracking, and stylesheet manager.
  - [`desktop_grid.js`](extension/desktop/desktop_grid.js): Pure desktop entry sorting (`NAME`, `DESCENDINGNAME`, `MODIFIEDTIME`, `KIND`, `SIZE`) and 4-corner grid slot coordinate math.
  - [`file_scanner.js`](extension/desktop/file_scanner.js): Async `~/Desktop` enumerator, Home & `trash:///` inspector, `Gio.VolumeMonitor` mount tracker, and debounced `Gio.FileMonitor` watcher.
  - [`icon_tile.js`](extension/desktop/icon_tile.js): `St.Button` desktop icon tile actor with symlink emblem, hover/selection accent border, single/double-click activation, and right-click dispatch.
  - [`context_menu.js`](extension/desktop/context_menu.js): Native GNOME Shell `PopupMenu` for desktop background and icon right-click actions (`Open`, `Move to Trash`, `Empty Trash`, `Unmount`, `New Folder`, `Sort Desktop By`, `Seabed Settings & About…`).
- **UI, Styling & Settings (`extension/ui/` — 4 JS pages + stylesheet)**:
  - [`tile_style.js`](extension/ui/tile_style.js), `stylesheet.css`
  - `settings/`: [`color.js`](extension/ui/settings/color.js), [`gsettings.js`](extension/ui/settings/gsettings.js), [`prefs_pages.js`](extension/ui/settings/prefs_pages.js)
