// SPDX-License-Identifier: GPL-3.0-or-later
// St.Button desktop icon tile actor with symlink badge, hover/selection border, and click dispatch.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import Pango from 'gi://Pango';
import St from 'gi://St';
import {
    build_label_inline_style, build_tile_inline_style, compute_cell_dimensions,
} from '../ui/tile_style.js';

const DOUBLE_CLICK_MS = 400;

export function launch_desktop_entry(entry) {
    if (!entry) return;
    if (entry.is_desktop_launcher && entry.path) {
        try {
            const app = GioUnix.DesktopAppInfo.new_from_filename(entry.path);
            if (app && app.launch([], null)) return;
        } catch (_e) { /* fallback to default URI launch */ }
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
        this.last_click_us = 0;

        this.actor = new St.Button({
            style_class: 'seabed-icon-tile',
            reactive: true,
            can_focus: true,
            track_hover: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
        });

        const vbox = new St.BoxLayout({
            style_class: 'seabed-icon-box',
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });

        const icon_stack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.CENTER,
        });
        const dims = compute_cell_dimensions(this.settings.icon_size());
        this.icon = new St.Icon({
            gicon: entry.gicon,
            icon_size: dims.icon_px,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        icon_stack.add_child(this.icon);

        if (entry.is_symlink && this.settings.show_link_emblem()) {
            const badge = new St.Icon({
                icon_name: 'emblem-symbolic-link',
                icon_size: Math.max(12, Math.round(dims.icon_px * 0.32)),
                style_class: 'seabed-emblem-badge',
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.END,
            });
            icon_stack.add_child(badge);
        }
        vbox.add_child(icon_stack);

        this.label = new St.Label({
            text: entry.name,
            style_class: 'seabed-icon-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
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
        this._press_sig = this.actor.connect('button-press-event', (_actor, event) => this._on_button_press(event));
        this.sync_style();
    }

    _on_button_press(event) {
        const btn = event.get_button();
        if (btn === 3) {
            this.callbacks?.on_select?.(this);
            const [sx, sy] = event.get_coords();
            this.callbacks?.on_context_menu?.(this, sx, sy);
            return Clutter.EVENT_STOP;
        }
        if (btn === 1) {
            this.callbacks?.on_select?.(this);
            if (this.settings.single_click_open()) {
                launch_desktop_entry(this.entry);
                return Clutter.EVENT_STOP;
            }
            const now_us = GLib.get_monotonic_time();
            if (now_us - this.last_click_us <= DOUBLE_CLICK_MS * 1000) {
                this.last_click_us = 0;
                launch_desktop_entry(this.entry);
            } else {
                this.last_click_us = now_us;
            }
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    set_selected(selected) {
        const next = Boolean(selected);
        if (this.selected !== next) {
            this.selected = next;
            this.sync_style();
        }
    }

    set_position(x, y) {
        this.actor.set_position(x, y);
    }

    sync_style() {
        const dims = compute_cell_dimensions(this.settings.icon_size());
        this.icon.set_icon_size(dims.icon_px);
        this.actor.set_style(build_tile_inline_style({
            width: dims.width,
            height: dims.height,
            selected: this.selected,
            hovered: this.hovered,
            show_border: this.settings.show_selection_border(),
            border_width: this.settings.border_width(),
            border_radius: this.settings.border_radius(),
            border_color: this.settings.border_color_rgba(),
        }));
        this.label.set_style(build_label_inline_style(this.settings.dark_text_in_labels()));
    }

    destroy() {
        if (this.actor) {
            if (this._hover_sig) { this.actor.disconnect(this._hover_sig); this._hover_sig = 0; }
            if (this._press_sig) { this.actor.disconnect(this._press_sig); this._press_sig = 0; }
            this.actor.destroy();
            this.actor = null;
        }
    }
}
