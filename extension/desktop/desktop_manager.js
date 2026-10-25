// SPDX-License-Identifier: GPL-3.0-or-later
// Compositor desktop canvas manager attached to Main.layoutManager._backgroundGroup.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { compute_cell_dimensions } from '../ui/tile_style.js';
import { ExtensionSettings } from '../ui/settings/gsettings.js';
import { DesktopContextMenu } from './context_menu.js';
import { compute_grid_positions, sort_desktop_entries } from './desktop_grid.js';
import { DesktopFileScanner } from './file_scanner.js';
import { DesktopIconTile } from './icon_tile.js';

const RESCAN_SETTING_KEYS = Object.freeze([
    'show-home', 'show-trash', 'show-volumes', 'show-network-volumes', 'show-hidden-files',
]);

const RELAYOUT_SETTING_KEYS = Object.freeze([
    'icon-size', 'start-corner', 'arrange-order', 'sort-special-folders',
    'show-link-emblem', 'dark-text-in-labels', 'multi-monitor',
    'show-selection-border', 'border-width', 'border-radius', 'border-color-rgba',
]);

export class DesktopManager {
    constructor(ext) {
        this.ext = ext;
        this.ext_settings = ext.getSettings();
        this.settings = new ExtensionSettings(this.ext_settings);
        this.stylesheet_file = null;
        this.canvases = [];
        this.tiles = [];
        this.entries = [];
        this.selected_id = null;
        this.signals = [];

        this.load_theme();
        this.context_menu = new DesktopContextMenu(ext, this.settings, () => this.scanner?.scan_now());
        this._rebuild_canvases();

        this.scanner = new DesktopFileScanner(this.settings, (entries) => {
            this.entries = entries;
            this._render_tiles();
        });

        this._bind_signals();
        this.scanner.scan_now();
    }

    load_theme() {
        try {
            const path = `${this.ext.path}/ui/stylesheet.css`;
            const file = Gio.File.new_for_path(path);
            if (file.query_exists(null)) {
                const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
                theme.load_stylesheet(file);
                this.stylesheet_file = file;
            }
        } catch (_e) {
            this.stylesheet_file = null;
        }
    }

    unload_theme() {
        if (this.stylesheet_file !== null) {
            try {
                const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
                theme.unload_stylesheet(this.stylesheet_file);
            } catch (_e) { /* ignore */ }
            this.stylesheet_file = null;
        }
    }

    _bind_signals() {
        for (const key of RESCAN_SETTING_KEYS) {
            if (this.ext_settings.settings_schema?.has_key(key)) {
                const id = this.ext_settings.connect(`changed::${key}`, () => this.scanner?.schedule_rescan(50));
                this.signals.push([this.ext_settings, id]);
            }
        }
        for (const key of RELAYOUT_SETTING_KEYS) {
            if (this.ext_settings.settings_schema?.has_key(key)) {
                const id = this.ext_settings.connect(`changed::${key}`, () => {
                    this._rebuild_canvases();
                    this._render_tiles();
                });
                this.signals.push([this.ext_settings, id]);
            }
        }
        if (Main.layoutManager) {
            const id = Main.layoutManager.connect('monitors-changed', () => {
                this._rebuild_canvases();
                this._render_tiles();
            });
            this.signals.push([Main.layoutManager, id]);
        }
        if (global.display) {
            const id = global.display.connect('workareas-changed', () => {
                this._rebuild_canvases();
                this._render_tiles();
            });
            this.signals.push([global.display, id]);
        }
    }

    _get_target_monitors() {
        const monitors = Main.layoutManager?.monitors || [];
        if (monitors.length === 0) {
            return [{ index: 0, x: 0, y: 0, width: 1920, height: 1080 }];
        }
        if (this.settings.multi_monitor()) return monitors;
        const primary = Main.layoutManager?.primaryMonitor || monitors[0];
        return [primary];
    }

    _get_workarea_for_monitor(monitor_index, fallback) {
        try {
            const ws = global.workspace_manager?.get_active_workspace?.();
            if (ws && typeof ws.get_work_area_for_monitor === 'function') {
                return ws.get_work_area_for_monitor(monitor_index);
            }
        } catch (_e) { /* fallback to monitor bounds */ }
        return { x: fallback.x, y: fallback.y, width: fallback.width, height: fallback.height };
    }

    _clear_tiles() {
        for (const tile of this.tiles) tile.destroy();
        this.tiles.length = 0;
    }

    _clear_canvases() {
        this._clear_tiles();
        for (const c of this.canvases) {
            if (c.press_sig) c.actor.disconnect(c.press_sig);
            c.actor.destroy();
        }
        this.canvases.length = 0;
    }

    _rebuild_canvases() {
        this._clear_canvases();
        const bg_group = Main.layoutManager?._backgroundGroup;
        if (!bg_group) return;

        for (const mon of this._get_target_monitors()) {
            const mon_idx = typeof mon.index === 'number' ? mon.index : 0;
            const wa = this._get_workarea_for_monitor(mon_idx, mon);
            const actor = new St.Widget({
                style_class: 'seabed-desktop-canvas',
                reactive: true,
                x: wa.x,
                y: wa.y,
                width: wa.width,
                height: wa.height,
            });
            const press_sig = actor.connect('button-press-event', (_actor, event) => {
                const btn = event.get_button();
                if (btn === 1) {
                    this._select_tile(null);
                    this.context_menu?.close();
                    return Clutter.EVENT_PROPAGATE;
                }
                if (btn === 3) {
                    this._select_tile(null);
                    const [sx, sy] = event.get_coords();
                    this.context_menu?.open_for_background(sx, sy);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            bg_group.add_child(actor);
            this.canvases.push({ actor, press_sig, workarea: wa });
        }
    }

    _select_tile(target_tile) {
        this.selected_id = target_tile ? target_tile.entry.id : null;
        for (const tile of this.tiles) {
            tile.set_selected(tile.entry.id === this.selected_id);
        }
    }

    _render_tiles() {
        this._clear_tiles();
        if (this.canvases.length === 0) return;

        const sorted = sort_desktop_entries(
            this.entries,
            this.settings.arrange_order(),
            this.settings.sort_special_folders(),
        );
        const dims = compute_cell_dimensions(this.settings.icon_size());
        const corner = this.settings.start_corner();

        for (const canvas of this.canvases) {
            const local_wa = {
                x: 0,
                y: 0,
                width: canvas.workarea.width,
                height: canvas.workarea.height,
            };
            const coords = compute_grid_positions(
                sorted.length, local_wa, dims.width, dims.height, corner, dims.gap,
            );
            for (let i = 0; i < sorted.length; i += 1) {
                const entry = sorted[i];
                const pos = coords[i] || { x: 16, y: 16 };
                const tile = new DesktopIconTile(entry, this.settings, {
                    on_select: (t) => this._select_tile(t),
                    on_context_menu: (t, sx, sy) => this.context_menu?.open_for_tile(t, sx, sy),
                });
                tile.set_selected(entry.id === this.selected_id);
                tile.set_position(pos.x, pos.y);
                canvas.actor.add_child(tile.actor);
                this.tiles.push(tile);
            }
        }
    }

    destroy() {
        for (const [obj, id] of this.signals) {
            try { obj.disconnect(id); } catch (_e) { /* ignore */ }
        }
        this.signals.length = 0;
        if (this.scanner) {
            this.scanner.destroy();
            this.scanner = null;
        }
        if (this.context_menu) {
            this.context_menu.destroy();
            this.context_menu = null;
        }
        this._clear_canvases();
        this.unload_theme();
        this.ext_settings = null;
        this.settings = null;
    }
}
