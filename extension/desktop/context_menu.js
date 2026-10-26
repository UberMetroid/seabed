// SPDX-License-Identifier: GPL-3.0-or-later
// Native GNOME Shell PopupMenu for Seabed desktop icons and background right-click actions.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { MAX_DESKTOP_ENTRIES, MAX_TRASH_PROBES, resolve_desktop_dir_path } from './file_scanner.js';
import { launch_desktop_entry } from './icon_tile.js';

const SORT_MENU_OPTIONS = Object.freeze([
    ['NAME', 'Name (A -> Z)'],
    ['DESCENDINGNAME', 'Name (Z -> A)'],
    ['MODIFIEDTIME', 'Modified Time'],
    ['KIND', 'Kind / Type'],
    ['SIZE', 'File Size'],
]);

function open_uri_in_files(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri_async(uri, null, null, null);
    } catch (_e) {
        try { Gio.AppInfo.launch_default_for_uri(uri, null); } catch (_e2) { /* ignore */ }
    }
}

export function create_new_desktop_folder(on_done) {
    const desk_dir = Gio.File.new_for_path(resolve_desktop_dir_path());
    for (let idx = 1; idx <= 64; idx += 1) {
        const folder_name = idx === 1 ? 'New Folder' : `New Folder (${idx})`;
        const candidate = desk_dir.get_child(folder_name);
        if (!candidate.query_exists(null)) {
            try { candidate.make_directory_with_parents(null); } catch (_e) { /* ignore */ }
            on_done?.();
            return;
        }
    }
}

export function empty_trash_async(on_done) {
    Gio.DBus.session.call(
        'org.gnome.Nautilus', '/org/gnome/Nautilus/FileOperations2',
        'org.gnome.Nautilus.FileOperations2', 'EmptyTrash',
        new GLib.Variant('(ba{sv})', [false, {}]),
        null, Gio.DBusCallFlags.NONE, 3000, null,
        (conn, res) => {
            try { conn.call_finish(res); on_done?.(); return; } catch (_e) { /* fallback to GIO trash enumeration */ }
            const trash = Gio.File.new_for_uri('trash:///');
            trash.enumerate_children_async(
                'standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null,
                (src, eres) => {
                    let enumerator, deleted = 0;
                    try { enumerator = src.enumerate_children_finish(eres); } catch (_e2) { on_done?.(); return; }
                    const step = () => {
                        enumerator.next_files_async(MAX_TRASH_PROBES, GLib.PRIORITY_DEFAULT, null, (esrc, nres) => {
                            let infos = [];
                            try { infos = esrc.next_files_finish(nres); } catch (_e3) { infos = []; }
                            if (!infos || infos.length === 0 || deleted >= MAX_DESKTOP_ENTRIES) {
                                try { esrc.close(null); } catch (_e4) { /* ignore */ }
                                on_done?.();
                                return;
                            }
                            let pending = infos.length;
                            deleted += pending;
                            for (const info of infos) {
                                trash.get_child(info.get_name()).delete_async(GLib.PRIORITY_DEFAULT, null, () => {
                                    if ((pending -= 1) === 0) step();
                                });
                            }
                        });
                    };
                    step();
                },
            );
        },
    );
}

export function open_terminal_in_dir(dir_path) {
    if (!dir_path) return;
    const candidates = [
        'org.gnome.Ptyxis.desktop', 'org.gnome.Console.desktop', 'org.gnome.Terminal.desktop',
        'kitty.desktop', 'com.mitchellh.ghostty.desktop', 'Alacritty.desktop', 'foot.desktop',
    ];
    for (const id of candidates) {
        try {
            const app = Gio.DesktopAppInfo.new(id);
            if (app && app.launch([Gio.File.new_for_path(dir_path)], null)) return;
        } catch (_e) { /* try next */ }
    }
    open_uri_in_files(Gio.File.new_for_path(dir_path).get_uri());
}

export function is_drop_target_entry(entry) {
    if (!entry) return false;
    return entry.kind === 'folder' || entry.kind === 'home' || entry.kind === 'volume' || entry.kind === 'trash';
}

export function move_uri_to_target(source_uri, target_uri, on_done) {
    if (!source_uri || !target_uri || source_uri === target_uri) return false;
    try {
        const src = Gio.File.new_for_uri(source_uri);
        if (target_uri === 'trash:///') {
            src.trash_async(GLib.PRIORITY_DEFAULT, null, () => on_done?.());
            return true;
        }
        const dst_dir = Gio.File.new_for_uri(target_uri);
        const basename = src.get_basename();
        if (!basename) return false;
        const dst = dst_dir.get_child(basename);
        if (src.equal(dst) || src.get_parent()?.equal(dst_dir)) return false;

        Gio.DBus.session.call(
            'org.gnome.Nautilus', '/org/gnome/Nautilus/FileOperations2',
            'org.gnome.Nautilus.FileOperations2', 'MoveURIs',
            new GLib.Variant('(assa{sv})', [[source_uri], target_uri, {}]),
            null, Gio.DBusCallFlags.NONE, 3000, null,
            (conn, res) => {
                try {
                    conn.call_finish(res);
                    on_done?.();
                } catch (_e) {
                    try { src.move(dst, Gio.FileCopyFlags.NONE, null, null); } catch (_e2) { /* ignore */ }
                    on_done?.();
                }
            },
        );
        return true;
    } catch (_e) {
        return false;
    }
}

export class DesktopContextMenu {
    constructor(ext, settings, on_refresh) {
        this.ext = ext;
        this.settings = settings;
        this.on_refresh = on_refresh;
        this.anchor = new St.Widget({ width: 1, height: 1, opacity: 0, reactive: false });
        Main.uiGroup.add_child(this.anchor);
        this.menu = new PopupMenu.PopupMenu(this.anchor, 0.0, St.Side.TOP);
        Main.uiGroup.add_child(this.menu.actor);
        this.menu.actor.hide();
        this.menu_manager = new PopupMenu.PopupMenuManager(this.anchor);
        this.menu_manager.addMenu(this.menu);
    }

    _move_anchor(x, y) {
        const rx = Math.round(x), ry = Math.round(y);
        this.anchor.set_position(rx, ry);
        Main.layoutManager?.setDummyCursorGeometry?.(rx, ry, 0, 0);
    }

    open_for_tile(tile, x, y) {
        const entry = tile.entry;
        this.menu.removeAll();
        this._move_anchor(x, y);

        this._add_item(`Open "${entry.name}"`, () => launch_desktop_entry(entry));

        const parent_uri = Gio.File.new_for_path(resolve_desktop_dir_path()).get_uri();
        this._add_item('Open in Files', () => open_uri_in_files(entry.is_special ? entry.uri : parent_uri));
        if ((entry.kind === 'folder' || entry.kind === 'home' || entry.kind === 'volume') && entry.path) {
            this._add_item('Open in Terminal', () => open_terminal_in_dir(entry.path));
        }

        if (!entry.is_special && entry.uri) {
            this._add_item('Move to Trash', () => {
                const file = Gio.File.new_for_uri(entry.uri);
                file.trash_async(GLib.PRIORITY_DEFAULT, null, () => this.on_refresh?.());
            });
        }
        if (entry.kind === 'trash') {
            this._add_item('Empty Trash', () => empty_trash_async(() => this.on_refresh?.()));
        }
        if (entry.kind === 'volume' && entry.mount) {
            this._add_item('Unmount', () => {
                try {
                    entry.mount.unmount_with_operation(Gio.MountUnmountFlags.NONE, null, null, () => this.on_refresh?.());
                } catch (_e) { /* ignore */ }
            });
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._append_common_footer();
        this.menu.open(true);
    }

    open_for_background(x, y) {
        this.menu.removeAll();
        this._move_anchor(x, y);

        this._add_item('New Folder on Desktop', () => create_new_desktop_folder(() => this.on_refresh?.()));

        const desk_path = resolve_desktop_dir_path();
        const desk_uri = Gio.File.new_for_path(desk_path).get_uri();
        this._add_item('Open in Files', () => open_uri_in_files(desk_uri));
        this._add_item('Open in Terminal', () => open_terminal_in_dir(desk_path));

        const sort_sub = new PopupMenu.PopupSubMenuMenuItem('Sort Desktop By');
        const active_order = this.settings.arrange_order();
        for (const [code, label] of SORT_MENU_OPTIONS) {
            const item = sort_sub.menu.addAction(label, () => {
                this.settings.clear_icon_positions();
                this.settings.set_arrange_order(code);
            });
            if (typeof item.setOrnament === 'function') {
                item.setOrnament(code === active_order ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
            }
        }
        this.menu.addMenuItem(sort_sub);

        if (this.settings.show_trash()) {
            this._add_item('Empty Trash', () => empty_trash_async(() => this.on_refresh?.()));
        }
        this._add_item('Arrange All Icons to Grid', () => this.settings.clear_icon_positions());

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._append_common_footer();
        this.menu.open(true);
    }

    _append_common_footer() {
        this._add_item('Refresh Desktop Icons', () => this.on_refresh?.());
        this._add_item('Seabed Settings & About…', () => {
            try { this.ext.openPreferences(); } catch (_e) { /* ignore */ }
        });
    }

    _add_item(label, callback) {
        const item = new PopupMenu.PopupMenuItem(label);
        item.connect('activate', () => { this.menu.close(); callback(); });
        this.menu.addMenuItem(item);
        return item;
    }

    close() { if (this.menu) this.menu.close(); }

    destroy() {
        if (this.menu) { this.menu.close(); this.menu.destroy(); this.menu = null; }
        this.menu_manager = null;
        if (this.anchor) { this.anchor.destroy(); this.anchor = null; }
    }
}
