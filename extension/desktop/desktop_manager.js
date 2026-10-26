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
import { DesktopIconTile, find_open_file_manager_target_at, refresh_file_manager_cache } from './icon_tile.js';

const RESCAN_SETTING_KEYS = Object.freeze(['show-home', 'show-trash', 'show-volumes', 'show-network-volumes', 'show-hidden-files']);
const RELAYOUT_SETTING_KEYS = Object.freeze([
    'icon-size', 'start-corner', 'arrange-order', 'sort-special-folders', 'show-link-emblem',
    'dark-text-in-labels', 'multi-monitor', 'show-selection-border', 'border-width', 'border-radius', 'border-color-rgba',
]);

export class DesktopManager {
    constructor(ext) {
        this.ext = ext;
        this.ext_settings = ext.getSettings();
        this.settings = new ExtensionSettings(this.ext_settings);
        this.stylesheet_file = null;
        this.canvases = [];
        this.entries = [];
        this.selected_id = null;
        this.dragged_entry = null;
        this.dragged_tile = null;
        this.fm_cache = { win_map: {}, locs: [] };
        this.signals = [];
        this.drag_monitor = null;
        this.load_theme();
        this.context_menu = new DesktopContextMenu(ext, this.settings, () => this.scanner?.scan_now());
        this._rebuild_canvases();
        this._setup_drag_monitor();
        refresh_file_manager_cache(this.fm_cache);
        this.scanner = new DesktopFileScanner(this.settings, (entries) => {
            this.entries = entries;
            const ids = new Set(entries.map((e) => e.id));
            this.settings.prune_icon_positions(ids);
            if (this.dragged_entry && !ids.has(this.dragged_entry.id)) { this.dragged_entry = null; this.dragged_tile = null; }
            this._render_tiles();
        });
        this._bind_signals();
        this.scanner.scan_now();
    }
    _setup_drag_monitor() {
        if (!DND || typeof DND.addDragMonitor !== 'function') return;
        this.drag_monitor = {
            dragMotion: (ev) => {
                const src = ev?.source;
                if (!src || !src.entry || src.entry.is_special) return DND.DragMotionResult.CONTINUE;
                return find_open_file_manager_target_at(ev.x, ev.y, this.fm_cache) ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.CONTINUE;
            },
            dragDrop: (ev) => {
                const actor = ev?.dropActor, tile = this.dragged_tile, entry = this.dragged_entry;
                if (!entry || entry.is_special || !ev?.clutterEvent) return DND.DragDropResult.CONTINUE;
                const [dx, dy] = ev.clutterEvent.get_coords();
                const fm_uri = find_open_file_manager_target_at(dx, dy, this.fm_cache);
                if (!fm_uri) return DND.DragDropResult.CONTINUE;
                this.dragged_entry = null;
                this.dragged_tile = null;
                if (!move_uri_to_target(entry.uri, fm_uri, () => this.scanner?.schedule_rescan(60))) return DND.DragDropResult.CONTINUE;
                if (actor && actor.get_parent?.() === Main.uiGroup) actor.destroy();
                tile?.finish_external_drop(ev.clutterEvent.get_time?.() ?? 0);
                return DND.DragDropResult.SUCCESS;
            },
        };
        DND.addDragMonitor(this.drag_monitor);
    }
    load_theme() {
        try {
            const file = Gio.File.new_for_path(`${this.ext.path}/ui/stylesheet.css`);
            if (!file.query_exists(null)) return;
            St.ThemeContext.get_for_stage(global.stage).get_theme().load_stylesheet(file);
            this.stylesheet_file = file;
        } catch (_e) { this.stylesheet_file = null; }
    }
    unload_theme() {
        if (!this.stylesheet_file) return;
        try { St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this.stylesheet_file); } catch (_e) { /* ignore */ }
        this.stylesheet_file = null;
    }
    _bind_signals() {
        const has = (k) => this.ext_settings.settings_schema?.has_key(k);
        for (const k of RESCAN_SETTING_KEYS) {
            if (has(k)) this.signals.push([this.ext_settings, this.ext_settings.connect(`changed::${k}`, () => this.scanner?.schedule_rescan(50))]);
        }
        for (const k of RELAYOUT_SETTING_KEYS) {
            if (!has(k)) continue;
            const cb = k === 'multi-monitor' ? () => { this._rebuild_canvases(); this._render_tiles(); } : () => this._render_tiles();
            this.signals.push([this.ext_settings, this.ext_settings.connect(`changed::${k}`, cb)]);
        }
        if (has('icon-positions')) {
            this.signals.push([this.ext_settings, this.ext_settings.connect('changed::icon-positions', () => this._sync_tile_positions())]);
        }
        const rebuild = () => { this._rebuild_canvases(); this._render_tiles(); };
        for (const [obj, sig] of [[Main.layoutManager, 'monitors-changed'], [global.display, 'workareas-changed']]) {
            if (obj) this.signals.push([obj, obj.connect(sig, rebuild)]);
        }
    }
    _get_target_monitors() {
        const monitors = Main.layoutManager?.monitors || [];
        if (monitors.length === 0) return [{ index: 0, x: 0, y: 0, width: 1920, height: 1080 }];
        return this.settings.multi_monitor() ? monitors : [Main.layoutManager?.primaryMonitor || monitors[0]];
    }
    _get_workarea_for_monitor(monitor_index, fallback) {
        try {
            const ws = global.workspace_manager?.get_active_workspace?.();
            if (ws?.get_work_area_for_monitor) return ws.get_work_area_for_monitor(monitor_index);
        } catch (_e) { /* fallback */ }
        return { x: fallback.x, y: fallback.y, width: fallback.width, height: fallback.height };
    }
    _clear_canvases() {
        for (const c of this.canvases) {
            for (const tile of c.tiles.values()) tile.destroy();
            c.tiles.clear();
            c.actor._delegate = null;
            if (c.press_sig) c.actor.disconnect(c.press_sig);
            c.actor.destroy();
        }
        this.canvases.length = 0;
    }
    _move_tile_to_canvas_point(source_tile, local_wa, tx, ty) {
        if (!source_tile?.entry?.id) return false;
        const dims = compute_cell_dimensions(this.settings.icon_size());
        const snapped = snap_pixel_to_slot(tx - dims.width / 2, ty - dims.height / 2, local_wa, dims.width, dims.height, this.settings.start_corner(), dims.gap);
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
                style_class: 'seabed-desktop-canvas', reactive: true, x: wa.x, y: wa.y, width: wa.width, height: wa.height,
            });
            actor._delegate = {
                handleDragOver: (source) => (source?.entry ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.CONTINUE),
                acceptDrop: (source, _drag_actor, tx, ty) => this._move_tile_to_canvas_point(source, local_wa, tx, ty),
            };
            let press_sig = 0;
            if (typeof Clutter.ClickGesture === 'function') {
                const is_bg = (g) => {
                    const { x, y } = g.get_coords_abs();
                    return global.stage?.get_actor_at_pos?.(Clutter.PickMode.REACTIVE, x, y) === actor;
                };
                const bg_click = new Clutter.ClickGesture({ required_button: Clutter.BUTTON_SECONDARY, recognize_on_press: true });
                bg_click.connect('may-recognize', () => is_bg(bg_click));
                bg_click.connect('recognize', () => {
                    this._select_tile(null);
                    const { x, y } = bg_click.get_coords_abs();
                    this.context_menu?.open_for_background(x, y);
                });
                const left_click = new Clutter.ClickGesture({ required_button: Clutter.BUTTON_PRIMARY, recognize_on_press: true });
                left_click.connect('may-recognize', () => is_bg(left_click));
                left_click.connect('recognize', () => { this._select_tile(null); this.context_menu?.close(); });
                actor.add_action(bg_click);
                actor.add_action(left_click);
            } else {
                press_sig = actor.connect('button-press-event', (_actor, event) => {
                    if (event.get_source() !== actor) return Clutter.EVENT_PROPAGATE;
                    const btn = event.get_button();
                    if (btn === 1) { this._select_tile(null); this.context_menu?.close(); return Clutter.EVENT_PROPAGATE; }
                    if (btn === 3) {
                        const [sx, sy] = event.get_coords();
                        this._select_tile(null);
                        this.context_menu?.open_for_background(sx, sy);
                        return Clutter.EVENT_STOP;
                    }
                    return Clutter.EVENT_PROPAGATE;
                });
            }
            bg_group.add_child(actor);
            this.canvases.push({ actor, press_sig, workarea: wa, local_wa, tiles: new Map() });
        }
    }
    _select_tile(target_tile) {
        this.selected_id = target_tile ? target_tile.entry.id : null;
        for (const c of this.canvases) {
            for (const tile of c.tiles.values()) tile.set_selected(tile.entry.id === this.selected_id);
        }
    }
    _compute_sorted_and_coords(local_wa) {
        const sorted = sort_desktop_entries(this.entries, this.settings.arrange_order(), this.settings.sort_special_folders());
        const dims = compute_cell_dimensions(this.settings.icon_size());
        const coords = compute_grid_positions(sorted, local_wa, dims.width, dims.height, this.settings.start_corner(), dims.gap, this.settings.icon_positions());
        return [sorted, coords];
    }
    _sync_tile_positions() {
        for (const canvas of this.canvases) {
            const [sorted, coords] = this._compute_sorted_and_coords(canvas.local_wa);
            for (let i = 0; i < sorted.length; i += 1) {
                const tile = canvas.tiles.get(sorted[i].id), pos = coords[i];
                if (tile && pos) tile.set_position(pos.x, pos.y);
            }
        }
    }
    _render_tiles() {
        if (this.canvases.length === 0) return;
        const cbs = {
            on_select: (t) => this._select_tile(t),
            on_drag_begin: (t) => { this.dragged_tile = t; this.dragged_entry = t.entry; refresh_file_manager_cache(this.fm_cache); },
            on_drag_end: () => { this.dragged_tile = null; this.dragged_entry = null; this._sync_tile_positions(); },
            on_context_menu: (t, sx, sy) => this.context_menu?.open_for_tile(t, sx, sy),
            on_drop_into_entry: (s, d) => move_uri_to_target(s.uri, d.uri, () => this.scanner?.schedule_rescan(60)),
        };
        for (const canvas of this.canvases) {
            const [sorted, coords] = this._compute_sorted_and_coords(canvas.local_wa);
            const seen = new Set();
            for (let i = 0; i < sorted.length; i += 1) {
                const entry = sorted[i], pos = coords[i] || { x: 16, y: 16 }, sel = entry.id === this.selected_id;
                seen.add(entry.id);
                let tile = canvas.tiles.get(entry.id);
                if (tile) {
                    tile.update(entry, pos, sel);
                } else {
                    tile = new DesktopIconTile(entry, this.settings, cbs);
                    tile.set_selected(sel);
                    tile.set_position(pos.x, pos.y);
                    canvas.actor.add_child(tile.actor);
                    canvas.tiles.set(entry.id, tile);
                }
            }
            for (const [id, tile] of canvas.tiles.entries()) {
                if (!seen.has(id)) { tile.destroy(); canvas.tiles.delete(id); }
            }
        }
    }
    destroy() {
        if (this.drag_monitor && DND && typeof DND.removeDragMonitor === 'function') { DND.removeDragMonitor(this.drag_monitor); this.drag_monitor = null; }
        for (const [obj, id] of this.signals) { try { obj.disconnect(id); } catch (_e) { /* ignore */ } }
        this.signals.length = 0;
        if (this.scanner) { this.scanner.destroy(); this.scanner = null; }
        if (this.context_menu) { this.context_menu.destroy(); this.context_menu = null; }
        this._clear_canvases();
        this.unload_theme();
        this.entries.length = 0;
        this.selected_id = null;
        this.dragged_entry = null;
        this.dragged_tile = null;
        this.ext_settings = null;
        this.settings = null;
    }
}
