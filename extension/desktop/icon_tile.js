// SPDX-License-Identifier: GPL-3.0-or-later
// St.Button desktop icon tile actor with symlink badge, DnD, hover/selection border, and click dispatch.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { build_label_inline_style, build_tile_inline_style, compute_cell_dimensions } from '../ui/tile_style.js';
import { is_drop_target_entry } from './context_menu.js';

const DOUBLE_CLICK_MS = 400;

export function refresh_file_manager_cache(cache) {
    try {
        Gio.DBus.session.call(
            'org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
            'org.freedesktop.DBus.Properties', 'GetAll',
            new GLib.Variant('(s)', ['org.freedesktop.FileManager1']),
            new GLib.VariantType('(a{sv})'), Gio.DBusCallFlags.NONE, 400, null,
            (conn, res) => {
                try {
                    const [props] = conn.call_finish(res).deepUnpack();
                    cache.win_map = props.OpenWindowsWithLocations ? props.OpenWindowsWithLocations.deepUnpack() : {};
                    cache.locs = props.OpenLocations ? props.OpenLocations.deepUnpack() : [];
                } catch (_e) { /* ignore */ }
            },
        );
    } catch (_e2) { /* ignore */ }
}

export function find_open_file_manager_target_at(sx, sy, cache) {
    try {
        let cur = global.stage?.get_actor_at_pos?.(Clutter.PickMode.ALL, sx, sy), meta_win = null;
        while (cur && !meta_win) {
            meta_win = cur.meta_window || cur.get_meta_window?.() || null;
            cur = cur.get_parent?.();
        }
        if (!meta_win) {
            const ws = global.workspace_manager?.get_active_workspace?.();
            const actors = global.get_window_actors?.() || [];
            for (let i = actors.length - 1; i >= 0; i -= 1) {
                const w = actors[i].meta_window || actors[i].get_meta_window?.();
                if (!w || w.minimized || (ws && w.located_on_workspace && !w.located_on_workspace(ws))) continue;
                const r = w.get_frame_rect?.();
                if (r && sx >= r.x && sx < r.x + r.width && sy >= r.y && sy < r.y + r.height) { meta_win = w; break; }
            }
        }
        if (!meta_win) return null;
        const win_map = cache?.win_map || {}, locs = cache?.locs || [];
        const obj_path = meta_win.get_gtk_window_object_path?.() || '';
        if (obj_path) {
            for (const [key, uris] of Object.entries(win_map)) {
                if ((key === obj_path || key.endsWith(obj_path)) && Array.isArray(uris) && uris.length > 0) return uris[0];
            }
        }
        const app_id = (meta_win.get_gtk_application_id?.() || '').toLowerCase();
        const wm_cls = (meta_win.get_wm_class?.() || '').toLowerCase();
        const is_fm = app_id.includes('nautilus') || wm_cls.includes('nautilus') || app_id.includes('filemanager');
        if (is_fm && Array.isArray(locs) && locs.length > 0) return locs[0];
    } catch (_e) { /* ignore */ }
    return null;
}

export function launch_desktop_entry(entry) {
    if (!entry) return;
    if (entry.is_desktop_launcher) {
        if (!entry.path) return;
        try {
            const app = GioUnix.DesktopAppInfo.new_from_filename(entry.path);
            if (app) app.launch([], null);
        } catch (_e) { /* refuse to open untrusted/broken .desktop launcher as text document */ }
        return;
    }
    if (entry.uri) {
        try {
            Gio.AppInfo.launch_default_for_uri_async(entry.uri, null, null, null);
        } catch (_e2) {
            try { Gio.AppInfo.launch_default_for_uri(entry.uri, null); } catch (_e3) { /* ignore */ }
        }
    }
}

export class DesktopIconTile {
    constructor(entry, settings, callbacks) {
        this.entry = entry;
        this.settings = settings;
        this.callbacks = callbacks;
        this.selected = false;
        this.hovered = false;
        this.drop_hovered = false;
        this._dragging = false;
        this.last_click_us = 0;

        this.actor = new St.Button({
            style_class: 'seabed-icon-tile', reactive: true, can_focus: true,
            track_hover: true, button_mask: St.ButtonMask.ONE,
        });
        this.actor._delegate = this;

        const vbox_orient = 'orientation' in St.BoxLayout.prototype
            ? { orientation: Clutter.Orientation.VERTICAL }
            : { vertical: true };
        const vbox = new St.BoxLayout({
            style_class: 'seabed-icon-box', ...vbox_orient,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.START,
        });
        this.icon_stack = new St.Widget({ layout_manager: new Clutter.BinLayout(), x_align: Clutter.ActorAlign.CENTER });
        const dims = compute_cell_dimensions(this.settings.icon_size());
        this.icon = new St.Icon({
            gicon: entry.gicon, icon_size: dims.icon_px,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        });
        this.icon_stack.add_child(this.icon);
        this.emblem = new St.Icon({
            icon_name: 'emblem-symbolic-link',
            icon_size: Math.max(12, Math.round(dims.icon_px * 0.32)),
            style_class: 'seabed-emblem-badge',
            x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.END,
        });
        this.icon_stack.add_child(this.emblem);
        vbox.add_child(this.icon_stack);

        this.label = new St.Label({ text: entry.name, style_class: 'seabed-icon-label', x_align: Clutter.ActorAlign.CENTER });
        const ct = this.label.clutter_text;
        if (ct) {
            ct.set_line_wrap(true);
            ct.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
            ct.set_ellipsize(Pango.EllipsizeMode.END);
            ct.set_single_line_mode(false);
        }
        vbox.add_child(this.label);
        this.actor.set_child(vbox);

        this._hover_sig = this.actor.connect('notify::hover', () => {
            this.hovered = Boolean(this.actor.hover);
            this.sync_style();
        });
        this._press_sig = 0;
        this._click_sig = this.actor.connect('clicked', () => this._activate_primary());
        if (typeof Clutter.ClickGesture === 'function') {
            const right_gesture = new Clutter.ClickGesture({ required_button: Clutter.BUTTON_SECONDARY, recognize_on_press: true });
            right_gesture.connect('recognize', () => {
                this.callbacks?.on_select?.(this);
                const { x, y } = right_gesture.get_coords_abs();
                this.callbacks?.on_context_menu?.(this, x, y);
            });
            this.actor.add_action(right_gesture);
        } else {
            this._press_sig = this.actor.connect('button-press-event', (_actor, event) => {
                if (event.get_button() === 3) {
                    const [sx, sy] = event.get_coords();
                    this.callbacks?.on_select?.(this);
                    this.callbacks?.on_context_menu?.(this, sx, sy);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
        }
        if (DND && typeof DND.makeDraggable === 'function') {
            this._draggable = DND.makeDraggable(this.actor, { restoreOnSuccess: false, dragActorOpacity: 215 });
            this._draggable.connect('drag-begin', () => {
                this._dragging = true;
                this.callbacks?.on_select?.(this);
                this.callbacks?.on_drag_begin?.(this);
            });
            this._draggable.connect('drag-end', () => {
                this._dragging = false;
                this.callbacks?.on_drag_end?.(this);
            });
        }
        this.sync_style();
    }

    finish_external_drop(time) {
        this._dragging = false;
        const d = this._draggable;
        if (!d) return;
        d._dragCancellable = false;
        if (d._dragActor && d._dragActor.get_parent?.()) d._dragActor.destroy();
        d._updateCursor?.(Clutter.CursorType.DEFAULT);
        d.emit?.('drag-end', time, true);
        d._dragComplete?.();
    }

    getDragActor() {
        const dims = compute_cell_dimensions(this.settings.icon_size());
        return new St.Icon({ gicon: this.entry.gicon, icon_size: dims.icon_px, opacity: 220 });
    }
    getDragActorSource() { return this.icon; }
    handleDragOver(source) {
        const ext = Boolean(Main.xdndHandler && source === Main.xdndHandler);
        if (!ext && (!source || source === this || !source.entry || source.entry.is_special)) return DND.DragMotionResult.CONTINUE;
        if (!is_drop_target_entry(this.entry)) return DND.DragMotionResult.CONTINUE;
        this.callbacks?.on_tile_drag_over?.(this, ext);
        return DND.DragMotionResult.MOVE_DROP;
    }
    acceptDrop(source) {
        if (!is_drop_target_entry(this.entry)) return false;
        if (Main.xdndHandler && source === Main.xdndHandler) return true;
        if (!source || source === this || !source.entry || source.entry.is_special) return false;
        return Boolean(this.callbacks?.on_drop_into_entry?.(source.entry, this.entry));
    }
    _activate_primary() {
        this.callbacks?.on_select?.(this);
        if (this.settings.single_click_open()) { launch_desktop_entry(this.entry); return; }
        const now_us = GLib.get_monotonic_time();
        if (now_us - this.last_click_us <= DOUBLE_CLICK_MS * 1000) { this.last_click_us = 0; launch_desktop_entry(this.entry); }
        else this.last_click_us = now_us;
    }
    update(entry, pos, selected) {
        if (!this.entry.gicon?.equal?.(entry.gicon)) this.icon.set_gicon(entry.gicon);
        this.entry = entry;
        this.selected = Boolean(selected);
        if (this.label.text !== entry.name) this.label.text = entry.name;
        if (pos) this.set_position(pos.x, pos.y);
        this.sync_style();
    }
    set_selected(sel) { const next = Boolean(sel); if (this.selected !== next) { this.selected = next; this.sync_style(); } }
    set_drop_hover(dh) { const next = Boolean(dh); if (this.drop_hovered !== next) { this.drop_hovered = next; this.sync_style(); } }
    set_position(x, y) { if (!this._dragging && !this._draggable?._dragInProgress) this.actor.set_position(x, y); }
    sync_style() {
        const dims = compute_cell_dimensions(this.settings.icon_size());
        this.icon.set_icon_size(dims.icon_px);
        this.emblem.set_icon_size(Math.max(12, Math.round(dims.icon_px * 0.32)));
        this.emblem.visible = Boolean(this.entry.is_symlink && this.settings.show_link_emblem());
        this.actor.set_style(build_tile_inline_style({
            width: dims.width, height: dims.height,
            selected: this.selected || this.drop_hovered, hovered: this.hovered || this.drop_hovered,
            show_border: this.settings.show_selection_border() || this.drop_hovered,
            border_width: this.drop_hovered ? Math.max(2, this.settings.border_width()) : this.settings.border_width(),
            border_radius: this.settings.border_radius(), border_color: this.settings.border_color_rgba(),
        }));
        this.label.set_style(build_label_inline_style(this.settings.dark_text_in_labels()));
    }
    destroy() {
        if (this.actor) {
            this.actor._delegate = null;
            if (this._hover_sig) { this.actor.disconnect(this._hover_sig); this._hover_sig = 0; }
            if (this._press_sig) { this.actor.disconnect(this._press_sig); this._press_sig = 0; }
            if (this._click_sig) { this.actor.disconnect(this._click_sig); this._click_sig = 0; }
            this.actor.destroy();
            this.actor = null;
        }
    }
}

