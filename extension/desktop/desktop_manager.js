// SPDX-License-Identifier: GPL-3.0-or-later
// Compositor desktop canvas manager attached to Main.layoutManager._backgroundGroup.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { compute_cell_dimensions } from '../ui/tile_style.js';
import { ExtensionSettings } from '../ui/settings/gsettings.js';
import { DesktopContextMenu, move_uri_to_target } from './context_menu.js';
import { compute_grid_positions, snap_pixel_to_slot, sort_desktop_entries } from './desktop_grid.js';
import { DesktopFileScanner } from './file_scanner.js';
import { DesktopIconTile, find_open_file_manager_target_at } from './icon_tile.js';

const RESCAN_SETTING_KEYS = Object.freeze([
    'show-home', 'show-trash', 'show-volumes', 'show-network-volumes', 'show-hidden-files',
]);

const RELAYOUT_SETTING_KEYS = Object.freeze([
    'icon-size', 'start-corner', 'arrange-order', 'sort-special-folders', 'icon-positions',
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
        this.drag_monitor = null;

        this.load_theme();
        this.context_menu = new DesktopContextMenu(ext, this.settings, () => this.scanner?.scan_now());
        this._rebuild_canvases();
        this._setup_drag_monitor();

        this.scanner = new DesktopFileScanner(this.settings, (entries) => {
            this.entries = entries;
            this._render_tiles();
        });
        this._bind_signals();
        this.scanner.scan_now();
    }

    _setup_drag_monitor() {
        if (!DND || typeof DND.addDragMonitor !== 'function') return;
        this.drag_monitor = {
            dragMotion: (drag_event) => {
                const src = drag_event?.source;
                if (!src || !src.entry || src.entry.is_special) return DND.DragMotionResult.CONTINUE;
                const fm_uri = find_open_file_manager_target_at(drag_event.x, drag_event.y);
                return fm_uri ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.CONTINUE;
            },
            dragDrop: (drop_event) => {
                const actor = drop_event?.dropActor;
                const selected = this.tiles.find((t) => t.entry.id === this.selected_id);
                if (!selected || !selected.entry || selected.entry.is_special) return DND.DragDropResult.CONTINUE;
                const [dx, dy] = drop_event.clutterEvent.get_coords();
                const fm_uri = find_open_file_manager_target_at(dx, dy);
                if (!fm_uri) return DND.DragDropResult.CONTINUE;
                const moved = move_uri_to_target(selected.entry.uri, fm_uri, () => this.scanner?.schedule_rescan(60));
                if (!moved) return DND.DragDropResult.CONTINUE;
                if (actor && actor.get_parent?.() === Main.uiGroup) actor.destroy();
                return DND.DragDropResult.SUCCESS;
            },
        };
        DND.addDragMonitor(this.drag_monitor);
    }

    load_theme() {
        try {
            const file = Gio.File.new_for_path(`${this.ext.path}/ui/stylesheet.css`);
            if (file.query_exists(null)) {
                St.ThemeContext.get_for_stage(global.stage).get_theme().load_stylesheet(file);
                this.stylesheet_file = file;
            }
        } catch (_e) { this.stylesheet_file = null; }
    }

    unload_theme() {
        if (this.stylesheet_file !== null) {
            try {
                St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this.stylesheet_file);
            } catch (_e) { /* ignore */ }
            this.stylesheet_file = null;
        }
    }

    _bind_signals() {
        for (const key of RESCAN_SETTING_KEYS) {
            if (this.ext_settings.settings_schema?.has_key(key)) {
                this.signals.push([this.ext_settings, this.ext_settings.connect(`changed::${key}`, () => this.scanner?.schedule_rescan(50))]);
            }
        }
        const relayout = () => { this._rebuild_canvases(); this._render_tiles(); };
        for (const key of RELAYOUT_SETTING_KEYS) {
            if (this.ext_settings.settings_schema?.has_key(key)) {
                this.signals.push([this.ext_settings, this.ext_settings.connect(`changed::${key}`, relayout)]);
            }
        }
        for (const [obj, sig] of [[Main.layoutManager, 'monitors-changed'], [global.display, 'workareas-changed']]) {
            if (obj) this.signals.push([obj, obj.connect(sig, relayout)]);
        }
    }

    _get_target_monitors() {
        const monitors = Main.layoutManager?.monitors || [];
        if (monitors.length === 0) return [{ index: 0, x: 0, y: 0, width: 1920, height: 1080 }];
        if (this.settings.multi_monitor()) return monitors;
        return [Main.layoutManager?.primaryMonitor || monitors[0]];
    }

    _get_workarea_for_monitor(monitor_index, fallback) {
        try {
            const ws = global.workspace_manager?.get_active_workspace?.();
            if (ws?.get_work_area_for_monitor) return ws.get_work_area_for_monitor(monitor_index);
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
            c.actor._delegate = null;
            if (c.press_sig) c.actor.disconnect(c.press_sig);
            c.actor.destroy();
        }
        this.canvases.length = 0;
    }

    _move_tile_to_canvas_point(source_tile, local_wa, tx, ty) {
        if (!source_tile?.entry?.id) return false;
        const dims = compute_cell_dimensions(this.settings.icon_size());
        const snapped = snap_pixel_to_slot(
            tx - dims.width / 2, ty - dims.height / 2,
            local_wa, dims.width, dims.height, this.settings.start_corner(), dims.gap,
        );
        this.settings.set_icon_slot(source_tile.entry.id, snapped.col, snapped.row);
        return true;
    }

    _rebuild_canvases() {
        this._clear_canvases();
        const bg_group = Main.layoutManager?._backgroundGroup;
        if (!bg_group) return;

        for (const mon of this._get_target_monitors()) {
            const mon_idx = typeof mon.index === 'number' ? mon.index : 0;
            const wa = this._get_workarea_for_monitor(mon_idx, mon);
            const local_wa = { x: 0, y: 0, width: wa.width, height: wa.height };
            const actor = new St.Widget({
                style_class: 'seabed-desktop-canvas', reactive: true,
                x: wa.x, y: wa.y, width: wa.width, height: wa.height,
            });
            actor._delegate = {
                handleDragOver: (source) => (source?.entry ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.CONTINUE),
                acceptDrop: (source, _drag_actor, tx, ty) => this._move_tile_to_canvas_point(source, local_wa, tx, ty),
            };
            const press_sig = actor.connect('button-press-event', (_actor, event) => {
                const btn = event.get_button();
                if (btn === 1) { this._select_tile(null); this.context_menu?.close(); return Clutter.EVENT_PROPAGATE; }
                if (btn === 3) {
                    this._select_tile(null);
                    const [sx, sy] = event.get_coords();
                    this.context_menu?.open_for_background(sx, sy);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            if (typeof Clutter.ClickGesture === 'function') {
                const bg_click = new Clutter.ClickGesture({
                    required_button: Clutter.BUTTON_SECONDARY, recognize_on_press: true,
                });
                bg_click.connect('recognize', () => {
                    this._select_tile(null);
                    const coords = bg_click.get_coords_abs();
                    this.context_menu?.open_for_background(coords.x, coords.y);
                });
                actor.add_action(bg_click);
                const left_click = new Clutter.ClickGesture({
                    required_button: Clutter.BUTTON_PRIMARY, recognize_on_press: true,
                });
                left_click.connect('recognize', () => { this._select_tile(null); this.context_menu?.close(); });
                actor.add_action(left_click);
            }
            bg_group.add_child(actor);
            this.canvases.push({ actor, press_sig, workarea: wa, local_wa });
        }
    }

    _select_tile(target_tile) {
        this.selected_id = target_tile ? target_tile.entry.id : null;
        for (const tile of this.tiles) tile.set_selected(tile.entry.id === this.selected_id);
    }

    _render_tiles() {
        this._clear_tiles();
        if (this.canvases.length === 0) return;

        const sorted = sort_desktop_entries(
            this.entries, this.settings.arrange_order(), this.settings.sort_special_folders(),
        );
        const dims = compute_cell_dimensions(this.settings.icon_size());
        const corner = this.settings.start_corner();
        const custom_slots = this.settings.icon_positions();

        for (const canvas of this.canvases) {
            const coords = compute_grid_positions(
                sorted, canvas.local_wa, dims.width, dims.height, corner, dims.gap, custom_slots,
            );
            for (let i = 0; i < sorted.length; i += 1) {
                const entry = sorted[i];
                const pos = coords[i] || { x: 16, y: 16 };
                const tile = new DesktopIconTile(entry, this.settings, {
                    on_select: (t) => this._select_tile(t),
                    on_context_menu: (t, sx, sy) => this.context_menu?.open_for_tile(t, sx, sy),
                    on_drop_into_entry: (src_entry, dst_entry) => move_uri_to_target(
                        src_entry.uri, dst_entry.uri, () => this.scanner?.schedule_rescan(60),
                    ),
                });
                tile.set_selected(entry.id === this.selected_id);
                tile.set_position(pos.x, pos.y);
                canvas.actor.add_child(tile.actor);
                this.tiles.push(tile);
            }
        }
    }

    destroy() {
        if (this.drag_monitor && DND && typeof DND.removeDragMonitor === 'function') {
            DND.removeDragMonitor(this.drag_monitor);
            this.drag_monitor = null;
        }
        for (const [obj, id] of this.signals) { try { obj.disconnect(id); } catch (_e) { /* ignore */ } }
        this.signals.length = 0;
        if (this.scanner) { this.scanner.destroy(); this.scanner = null; }
        if (this.context_menu) { this.context_menu.destroy(); this.context_menu = null; }
        this._clear_canvases();
        this.unload_theme();
        this.ext_settings = null;
        this.settings = null;
    }
}
