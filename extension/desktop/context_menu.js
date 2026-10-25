// SPDX-License-Identifier: GPL-3.0-or-later
// Native GNOME Shell PopupMenu for Seabed desktop icons and background right-click actions.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { MAX_TRASH_PROBES, resolve_desktop_dir_path } from './file_scanner.js';
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
    const trash = Gio.File.new_for_uri('trash:///');
    trash.enumerate_children_async(
        'standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null,
        (src, res) => {
            let enumerator;
            try { enumerator = src.enumerate_children_finish(res); } catch (_e) { on_done?.(); return; }
            enumerator.next_files_async(MAX_TRASH_PROBES, GLib.PRIORITY_DEFAULT, null, (esrc, eres) => {
                let infos = [];
                try { infos = esrc.next_files_finish(eres); } catch (_e2) { infos = []; }
                try { esrc.close(null); } catch (_e3) { /* ignore */ }
                for (const info of infos) {
                    const child = trash.get_child(info.get_name());
                    child.delete_async(GLib.PRIORITY_DEFAULT, null, () => { /* ignore */ });
                }
                on_done?.();
            });
        },
    );
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

    open_for_tile(tile, x, y) {
        const entry = tile.entry;
        this.menu.removeAll();
        this.anchor.set_position(Math.round(x), Math.round(y));

        this._add_item(`Open "${entry.name}"`, () => launch_desktop_entry(entry));

        const parent_uri = Gio.File.new_for_path(resolve_desktop_dir_path()).get_uri();
        this._add_item('Open in Files', () => open_uri_in_files(entry.is_special ? entry.uri : parent_uri));

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
        this.menu.open( true);
    }

    open_for_background(x, y) {
        this.menu.removeAll();
        this.anchor.set_position(Math.round(x), Math.round(y));

        this._add_item('New Folder on Desktop', () => create_new_desktop_folder(() => this.on_refresh?.()));

        const desk_uri = Gio.File.new_for_path(resolve_desktop_dir_path()).get_uri();
        this._add_item('Open in Files', () => open_uri_in_files(desk_uri));

        const sort_sub = new PopupMenu.PopupSubMenuMenuItem('Sort Desktop By');
        const active_order = this.settings.arrange_order();
        for (const [code, label] of SORT_MENU_OPTIONS) {
            const item = sort_sub.menu.addAction(label, () => this.settings.set_arrange_order(code));
            if (typeof item.setOrnament === 'function') {
                item.setOrnament(code === active_order ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
            }
        }
        this.menu.addMenuItem(sort_sub);

        if (this.settings.show_trash()) {
            this._add_item('Empty Trash', () => empty_trash_async(() => this.on_refresh?.()));
        }

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
        item.connect('activate', () => {
            this.menu.close();
            callback();
        });
        this.menu.addMenuItem(item);
        return item;
    }

    close() {
        if (this.menu) this.menu.close();
    }

    destroy() {
        if (this.menu) {
            this.menu.close();
            this.menu.destroy();
            this.menu = null;
        }
        this.menu_manager = null;
        if (this.anchor) {
            this.anchor.destroy();
            this.anchor = null;
        }
    }
}
