// SPDX-License-Identifier: GPL-3.0-or-later
// Async ~/Desktop enumerator, Home & trash:/// inspector, and Gio.VolumeMonitor mount watcher.

import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';

export const MAX_DESKTOP_ENTRIES = 256;
export const MAX_TRASH_PROBES = 64;
export const MAX_VOLUMES = 32;

export function load_square_image_gicon(img_path, fallback_file) {
    try {
        const pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(img_path, 128, 128, true);
        if (pb) {
            const pw = pb.get_width(), ph = pb.get_height();
            if (pw === ph) return pb;
            const side = Math.max(pw, ph), sq = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, true, 8, side, side);
            sq.fill(0x00000000);
            pb.copy_area(0, 0, pw, ph, sq, Math.floor((side - pw) / 2), Math.floor((side - ph) / 2));
            return sq;
        }
    } catch (_e) { /* fallback to Gio.FileIcon */ }
    return Gio.FileIcon.new(fallback_file || Gio.File.new_for_path(img_path));
}

const QUERY_ATTRS = [
    'standard::name', 'standard::display-name', 'standard::type', 'standard::icon',
    'standard::content-type', 'standard::size', 'standard::is-hidden',
    'standard::is-symlink', 'time::modified', 'thumbnail::path',
].join(',');

export function resolve_desktop_dir_path() {
    const special = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP);
    if (special && special.trim().length > 0) return special;
    return GLib.build_filenamev([GLib.get_home_dir(), 'Desktop']);
}

export const NETWORK_SCHEMES = Object.freeze(new Set([
    'smb', 'cifs', 'sftp', 'ssh', 'ftp', 'ftps', 'nfs', 'dav', 'davs', 'afp',
]));

export function is_network_mount(mount) {
    try {
        const root = mount?.get_root?.();
        return NETWORK_SCHEMES.has((root?.get_uri_scheme?.() || '').toLowerCase());
    } catch (_e) { return false; }
}

export class DesktopFileScanner {
    constructor(settings, on_entries_changed) {
        this.settings = settings;
        this.on_entries_changed = on_entries_changed;
        this.cancellable = this.desktop_monitor = this.trash_monitor = null;
        this.desktop_sig = this.trash_sig = this.debounce_id = 0;
        this.vol_monitor = Gio.VolumeMonitor.get();
        this.vol_sigs = [];
        this._setup_monitors();
    }

    _setup_monitors() {
        const desk_file = Gio.File.new_for_path(resolve_desktop_dir_path());
        try {
            this.desktop_monitor = desk_file.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this.desktop_sig = this.desktop_monitor.connect('changed', () => this.schedule_rescan());
        } catch (_e) { this.desktop_monitor = null; }

        try {
            const trash_file = Gio.File.new_for_uri('trash:///');
            this.trash_monitor = trash_file.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this.trash_sig = this.trash_monitor.connect('changed', () => this.schedule_rescan());
        } catch (_e) { this.trash_monitor = null; }

        if (this.vol_monitor) {
            for (const sig of ['mount-added', 'mount-removed', 'mount-changed']) {
                this.vol_sigs.push(this.vol_monitor.connect(sig, () => this.schedule_rescan()));
            }
        }
    }

    schedule_rescan(delay_ms = 120) {
        if (this.debounce_id !== 0) {
            try { GLib.Source.remove(this.debounce_id); } catch (_e) { /* ignore */ }
            this.debounce_id = 0;
        }
        this.debounce_id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay_ms, () => {
            this.debounce_id = 0;
            this.scan_now();
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this.debounce_id, '[seabed] rescan-debounce');
    }

    scan_now() {
        if (this.cancellable !== null) { this.cancellable.cancel(); this.cancellable = null; }
        const cancel = new Gio.Cancellable();
        this.cancellable = cancel;
        this._run_scan(cancel).catch(() => { /* ignore cancelled */ });
    }

    async _run_scan(cancel) {
        const entries = [];
        if (this.settings.show_home()) {
            const home_path = GLib.get_home_dir();
            const home_file = Gio.File.new_for_path(home_path);
            entries.push({
                id: 'special:home', name: 'Home', uri: home_file.get_uri(), path: home_path,
                gicon: Gio.ThemedIcon.new('user-home'), kind: 'home', size: 0, mtime: 0,
                is_special: true, is_symlink: false, is_desktop_launcher: false, mount: null,
            });
        }

        const want_trash = this.settings.show_trash();
        const [has_trash, desk_entries] = await Promise.all([
            want_trash ? this._probe_trash_non_empty(cancel) : Promise.resolve(false),
            this._enumerate_desktop_dir(cancel),
        ]);
        if (cancel.is_cancelled()) return;

        if (want_trash) {
            entries.push({
                id: 'special:trash', name: 'Trash', uri: 'trash:///', path: null,
                gicon: Gio.ThemedIcon.new(has_trash ? 'user-trash-full' : 'user-trash'),
                kind: 'trash', size: has_trash ? 1 : 0, mtime: 0,
                is_special: true, is_symlink: false, is_desktop_launcher: false, mount: null,
            });
        }

        if (this.settings.show_volumes() || this.settings.show_network_volumes()) {
            const mounts = this.vol_monitor ? this.vol_monitor.get_mounts() : [];
            let count = 0;
            for (const mount of mounts) {
                if (count >= MAX_VOLUMES) break;
                const net = is_network_mount(mount);
                if ((net && !this.settings.show_network_volumes()) || (!net && !this.settings.show_volumes())) continue;
                const root = mount.get_root();
                if (!root) continue;
                const uri = root.get_uri();
                entries.push({
                    id: `volume:${uri}`, name: mount.get_name() || 'Volume', uri, path: root.get_path(),
                    gicon: mount.get_icon() || Gio.ThemedIcon.new('drive-harddisk'),
                    kind: 'volume', size: 0, mtime: 0,
                    is_special: true, is_symlink: false, is_desktop_launcher: false, mount,
                });
                count += 1;
            }
        }

        for (const item of desk_entries) entries.push(item);
        if (this.cancellable === cancel) this.cancellable = null;
        this.on_entries_changed(entries);
    }

    _probe_trash_non_empty(cancel) {
        return new Promise((resolve) => {
            Gio.File.new_for_uri('trash:///').enumerate_children_async(
                'standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancel,
                (src, res) => {
                    try {
                        const enumerator = src.enumerate_children_finish(res);
                        enumerator.next_files_async(1, GLib.PRIORITY_DEFAULT, cancel, (esrc, eres) => {
                            let list = [];
                            try { list = esrc.next_files_finish(eres); } catch (_e2) { list = []; }
                            try { esrc.close(null); } catch (_e3) { /* ignore */ }
                            resolve(Array.isArray(list) && list.length > 0);
                        });
                    } catch (_e) { resolve(false); }
                },
            );
        });
    }

    _enumerate_desktop_dir(cancel) {
        return new Promise((resolve) => {
            const desk_file = Gio.File.new_for_path(resolve_desktop_dir_path());
            desk_file.enumerate_children_async(
                QUERY_ATTRS, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancel,
                (src, res) => {
                    let enumerator;
                    try { enumerator = src.enumerate_children_finish(res); } catch (_e) { resolve([]); return; }
                    const out = [];
                    const show_hidden = this.settings.show_hidden_files();
                    const step = () => {
                        enumerator.next_files_async(32, GLib.PRIORITY_DEFAULT, cancel, (esrc, eres) => {
                            let infos = [];
                            try { infos = esrc.next_files_finish(eres); } catch (_e2) { infos = []; }
                            if (cancel.is_cancelled() || !infos || infos.length === 0 || out.length >= MAX_DESKTOP_ENTRIES) {
                                try { esrc.close(null); } catch (_e3) { /* ignore */ }
                                resolve(out);
                                return;
                            }
                            for (const info of infos) {
                                if (out.length >= MAX_DESKTOP_ENTRIES) break;
                                const raw_name = info.get_name() || '';
                                if (!show_hidden && (info.get_is_hidden() || raw_name.startsWith('.'))) continue;
                                out.push(this._build_file_entry(desk_file.get_child(raw_name), info, raw_name));
                            }
                            step();
                        });
                    };
                    step();
                },
            );
        });
    }

    _build_file_entry(child, info, raw_name) {
        const path = child.get_path();
        const is_dir = info.get_file_type() === Gio.FileType.DIRECTORY;
        const is_launcher = !is_dir && raw_name.endsWith('.desktop') && path !== null;
        const mime = (info.get_content_type() || '').toLowerCase();
        const thumb = info.get_attribute_byte_string('thumbnail::path');
        const size = Number(info.get_size()) || 0;
        let display_name = info.get_display_name() || raw_name;
        let gicon = info.get_icon() || Gio.ThemedIcon.new(is_dir ? 'folder' : 'text-x-generic');

        if (thumb && GLib.file_test(thumb, GLib.FileTest.IS_REGULAR)) {
            gicon = load_square_image_gicon(thumb, Gio.File.new_for_path(thumb));
        } else if (!is_dir && mime.startsWith('image/') && path && size > 0 && size <= 16777216) {
            gicon = load_square_image_gicon(path, child);
        } else if (is_launcher) {
            try {
                const app = GioUnix.DesktopAppInfo.new_from_filename(path);
                if (app) { display_name = app.get_display_name() || display_name; gicon = app.get_icon() || gicon; }
            } catch (_e) { /* fallback to file info */ }
        }

        return {
            id: `file:${child.get_uri()}`, name: display_name, uri: child.get_uri(), path, gicon,
            kind: is_dir ? 'folder' : (is_launcher ? 'launcher' : (mime || 'file')), size,
            mtime: Number(info.get_attribute_uint64('time::modified')) || 0,
            is_special: false, is_symlink: Boolean(info.get_is_symlink()), is_desktop_launcher: is_launcher, mount: null,
        };
    }

    destroy() {
        if (this.debounce_id !== 0) { try { GLib.Source.remove(this.debounce_id); } catch (_e) { /* ignore */ } this.debounce_id = 0; }
        if (this.cancellable !== null) { this.cancellable.cancel(); this.cancellable = null; }
        if (this.desktop_monitor !== null) {
            if (this.desktop_sig !== 0) this.desktop_monitor.disconnect(this.desktop_sig);
            this.desktop_monitor.cancel(); this.desktop_monitor = null; this.desktop_sig = 0;
        }
        if (this.trash_monitor !== null) {
            if (this.trash_sig !== 0) this.trash_monitor.disconnect(this.trash_sig);
            this.trash_monitor.cancel(); this.trash_monitor = null; this.trash_sig = 0;
        }
        if (this.vol_monitor !== null) {
            for (const id of this.vol_sigs) this.vol_monitor.disconnect(id);
            this.vol_sigs.length = 0; this.vol_monitor = null;
        }
    }
}
