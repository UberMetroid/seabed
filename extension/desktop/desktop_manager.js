// SPDX-License-Identifier: GPL-3.0-or-later
// Compositor desktop canvas manager attached to Main.layoutManager._backgroundGroup.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { build_drop_preview_inline_style, compute_cell_dimensions } from '../ui/tile_style.js';
import { ExtensionSettings } from '../ui/settings/gsettings.js';
import { DesktopContextMenu, move_uri_to_target, move_uris_to_target, read_external_dnd_uris } from './context_menu.js';
import { compute_dropped_file_slots, compute_grid_positions, snap_pixel_to_slot, sort_desktop_entries } from './desktop_grid.js';
import { DesktopFileScanner, resolve_desktop_dir_path } from './file_scanner.js';
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
        this.stylesheet_file = this.selected_id = this.dragged_entry = this.dragged_tile = this.ext_dnd_source = this.ext_dnd_uris = this.ext_hover_target = this.drag_monitor = null;
        this.canvases = []; this.entries = []; this.signals = [];
        this.fm_cache = { win_map: {}, locs: [] };
        this.load_theme();
        this.context_menu = new DesktopContextMenu(ext, this.settings, () => this.scanner?.scan_now());
        this._rebuild_canvases(); this._setup_drag_monitor(); refresh_file_manager_cache(this.fm_cache);
        this.scanner = new DesktopFileScanner(this.settings, (entries) => {
            this.entries = entries;
            const ids = new Set(entries.map((e) => e.id));
            this.settings.prune_icon_positions(ids);
            if (this.dragged_entry && !ids.has(this.dragged_entry.id)) this.dragged_entry = this.dragged_tile = null;
            this._render_tiles();
        });
        this._bind_signals();
        this.scanner.scan_now();
    }
    _clear_drop_previews() {
        for (const c of this.canvases) { c.preview.hide(); for (const tile of c.tiles.values()) tile.set_drop_hover(false); }
    }
    _show_slot_preview(canvas, tx, ty) {
        this._clear_drop_previews();
        const dims = compute_cell_dimensions(this.settings.icon_size());
        const snapped = snap_pixel_to_slot(tx - dims.width / 2, ty - dims.height / 2, canvas.local_wa, dims.width, dims.height, this.settings.start_corner(), dims.gap);
        canvas.preview.set_style(build_drop_preview_inline_style({
            width: dims.width, height: dims.height, border_width: this.settings.border_width(), border_radius: this.settings.border_radius(), border_color: this.settings.border_color_rgba(),
        }));
        canvas.preview.set_position(snapped.x, snapped.y); canvas.preview.show();
        return snapped;
    }
    _setup_drag_monitor() {
        if (!DND || typeof DND.addDragMonitor !== 'function') return;
        this.drag_monitor = {
            dragMotion: (ev) => {
                this._clear_drop_previews(); this.ext_hover_target = null;
                if (!ev?.source?.entry || ev.source.entry.is_special) return DND.DragMotionResult.CONTINUE;
                return find_open_file_manager_target_at(ev.x, ev.y, this.fm_cache) ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.CONTINUE;
            },
            dragDrop: (ev) => {
                this._clear_drop_previews();
                const actor = ev?.dropActor, tile = this.dragged_tile, entry = this.dragged_entry;
                if (!entry || entry.is_special || !ev?.clutterEvent) return DND.DragDropResult.CONTINUE;
                const [dx, dy] = ev.clutterEvent.get_coords(), fm_uri = find_open_file_manager_target_at(dx, dy, this.fm_cache);
                if (!fm_uri) return DND.DragDropResult.CONTINUE;
                this.dragged_entry = this.dragged_tile = null;
                if (!move_uri_to_target(entry.uri, fm_uri, () => this.scanner?.schedule_rescan(60))) return DND.DragDropResult.CONTINUE;
                tile?.finish_external_drop(ev.clutterEvent.get_time?.() ?? 0);
                if (actor && actor.get_parent?.() === Main.uiGroup) actor.destroy();
                return DND.DragDropResult.SUCCESS;
            },
        };
        DND.addDragMonitor(this.drag_monitor);
    }
    _prefetch_ext_dnd() {
        if (this.ext_dnd_uris || this.ext_dnd_reading) return;
        this.ext_dnd_reading = true;
        read_external_dnd_uris(this.ext_dnd_source, (uris) => { if (uris.length > 0) this.ext_dnd_uris = uris; });
    }
    _complete_external_drop() {
        const target = this.ext_hover_target, src = this.ext_dnd_source, cached = this.ext_dnd_uris;
        this.ext_hover_target = this.ext_dnd_uris = this.ext_dnd_reading = null; this._clear_drop_previews();
        if (!target) return;
        const apply_uris = (uris) => {
            if (target.kind === 'tile') { move_uris_to_target(uris, target.uri, () => this.scanner?.schedule_rescan(60)); return; }
            const desk_dir = Gio.File.new_for_path(resolve_desktop_dir_path()), moved = move_uris_to_target(uris, desk_dir.get_uri(), () => this.scanner?.schedule_rescan(60));
            if (moved.length === 0) return;
            const dims = compute_cell_dimensions(this.settings.icon_size()), map = this.settings.icon_positions();
            const slots = compute_dropped_file_slots(moved.length, target.col, target.row, target.local_wa, dims.width, dims.height, this.settings.start_corner(), dims.gap, map);
            for (let i = 0; i < moved.length; i += 1) {
                const base = Gio.File.new_for_uri(moved[i]).get_basename(), s = slots[i];
                if (base && s) map[`file:${desk_dir.get_child(base).get_uri()}`] = { col: s.col, row: s.row };
            }
            this.settings.set_icon_positions(map);
        };
        if (cached && cached.length > 0) apply_uris(cached);
        else read_external_dnd_uris(src, apply_uris);
    }
    load_theme() {
        try {
            const file = Gio.File.new_for_path(`${this.ext.path}/ui/stylesheet.css`);
            if (file.query_exists(null)) { St.ThemeContext.get_for_stage(global.stage).get_theme().load_stylesheet(file); this.stylesheet_file = file; }
        } catch (_e) { this.stylesheet_file = null; }
    }
    unload_theme() {
        if (this.stylesheet_file) { try { St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this.stylesheet_file); } catch (_e) { /* ignore */ } }
        this.stylesheet_file = null;
    }
    _bind_signals() {
        const has = (k) => this.ext_settings.settings_schema?.has_key(k), sub = (o, s, fn) => { if (o) this.signals.push([o, o.connect(s, fn)]); };
        const rebuild = () => { this._rebuild_canvases(); this._render_tiles(); };
        for (const k of RESCAN_SETTING_KEYS) if (has(k)) sub(this.ext_settings, `changed::${k}`, () => this.scanner?.schedule_rescan(50));
        for (const k of RELAYOUT_SETTING_KEYS) if (has(k)) sub(this.ext_settings, `changed::${k}`, () => { if (k === 'multi-monitor') this._rebuild_canvases(); this._render_tiles(); });
        if (has('icon-positions')) sub(this.ext_settings, 'changed::icon-positions', () => this._sync_tile_positions());
        for (const [obj, sig] of [[Main.layoutManager, 'monitors-changed'], [global.display, 'workareas-changed']]) sub(obj, sig, rebuild);
        sub(global.display?.get_selection?.(), 'owner-changed', (_s, t, src) => {
            if (t === Meta.SelectionType.SELECTION_DND && src) { this.ext_dnd_source = src; this.ext_dnd_uris = this.ext_dnd_reading = null; this._prefetch_ext_dnd(); }
        });
        sub(Main.xdndHandler, 'drag-begin', () => { this.ext_hover_target = this.ext_dnd_reading = null; this._prefetch_ext_dnd(); });
        sub(Main.xdndHandler, 'drag-end', () => this._complete_external_drop());
    }
    _get_target_monitors() {
        const monitors = Main.layoutManager?.monitors || [];
        if (monitors.length === 0) return [{ index: 0, x: 0, y: 0, width: 1920, height: 1080 }];
        return this.settings.multi_monitor() ? monitors : [Main.layoutManager?.primaryMonitor || monitors[0]];
    }
    _get_workarea_for_monitor(monitor_index, fallback) {
        try { const ws = global.workspace_manager?.get_active_workspace?.(); if (ws?.get_work_area_for_monitor) return ws.get_work_area_for_monitor(monitor_index); } catch (_e) { /* fallback */ }
        return { x: fallback.x, y: fallback.y, width: fallback.width, height: fallback.height };
    }
    _clear_canvases() {
        for (const c of this.canvases) {
            for (const tile of c.tiles.values()) tile.destroy();
            c.tiles.clear(); c.actor._delegate = null;
            if (c.press_sig) c.actor.disconnect(c.press_sig);
            c.actor.destroy();
        }
        this.canvases.length = 0;
    }
    _move_tile_to_canvas_point(source_tile, local_wa, tx, ty) {
        this._clear_drop_previews();
        if (Main.xdndHandler && source_tile === Main.xdndHandler) return true;
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
            const wa = this._get_workarea_for_monitor(typeof mon.index === 'number' ? mon.index : 0, mon), local_wa = { x: 0, y: 0, width: wa.width, height: wa.height };
            const actor = new St.Widget({ style_class: 'seabed-desktop-canvas', reactive: true, x: wa.x, y: wa.y, width: wa.width, height: wa.height });
            const preview = new St.Widget({ style_class: 'seabed-drop-preview', reactive: false, visible: false });
            actor.add_child(preview);
            const canvas = { actor, preview, press_sig: 0, workarea: wa, local_wa, tiles: new Map() };
            actor._delegate = {
                handleDragOver: (source, _actor, tx, ty) => {
                    const ext = Boolean(Main.xdndHandler && source === Main.xdndHandler);
                    if (!ext && !source?.entry) return DND.DragMotionResult.CONTINUE;
                    const snapped = this._show_slot_preview(canvas, tx, ty);
                    if (ext) { this._prefetch_ext_dnd(); this.ext_hover_target = { kind: 'canvas', local_wa, col: snapped.col, row: snapped.row }; }
                    return DND.DragMotionResult.MOVE_DROP;
                },
                acceptDrop: (source, _drag_actor, tx, ty) => this._move_tile_to_canvas_point(source, local_wa, tx, ty),
            };
            if (typeof Clutter.ClickGesture === 'function') {
                const add_bg = (name, btn, on_rec) => {
                    const g = new Clutter.ClickGesture({ required_button: btn, recognize_on_press: true });
                    g.connect('should-handle-sequence', (_g, ev) => (global.stage?.get_event_actor?.(ev) || ev?.get_source?.()) === actor);
                    g.connect('may-recognize', () => { const { x, y } = g.get_coords_abs(); return global.stage?.get_actor_at_pos?.(Clutter.PickMode.REACTIVE, x, y) === actor; });
                    g.connect('recognize', () => on_rec(g));
                    if (typeof actor.add_action_full === 'function' && Clutter.EventPhase?.TARGET !== undefined) actor.add_action_full(name, Clutter.EventPhase.TARGET, g);
                    else actor.add_action(g);
                };
                add_bg('seabed-bg-context', Clutter.BUTTON_SECONDARY, (g) => { this._select_tile(null); const { x, y } = g.get_coords_abs(); this.context_menu?.open_for_background(x, y); });
                add_bg('seabed-bg-select', Clutter.BUTTON_PRIMARY, () => { this._select_tile(null); this.context_menu?.close(); });
            } else {
                canvas.press_sig = actor.connect('button-press-event', (_actor, event) => {
                    if (event.get_source() !== actor) return Clutter.EVENT_PROPAGATE;
                    const btn = event.get_button();
                    if (btn === 1) { this._select_tile(null); this.context_menu?.close(); return Clutter.EVENT_PROPAGATE; }
                    if (btn === 3) { const [sx, sy] = event.get_coords(); this._select_tile(null); this.context_menu?.open_for_background(sx, sy); return Clutter.EVENT_STOP; }
                    return Clutter.EVENT_PROPAGATE;
                });
            }
            bg_group.add_child(actor);
            this.canvases.push(canvas);
        }
    }
    _select_tile(target_tile) {
        this.selected_id = target_tile ? target_tile.entry.id : null;
        for (const c of this.canvases) { for (const tile of c.tiles.values()) tile.set_selected(tile.entry.id === this.selected_id); }
    }
    _compute_sorted_and_coords(local_wa) {
        const sorted = sort_desktop_entries(this.entries, this.settings.arrange_order(), this.settings.sort_special_folders()), dims = compute_cell_dimensions(this.settings.icon_size());
        return [sorted, compute_grid_positions(sorted, local_wa, dims.width, dims.height, this.settings.start_corner(), dims.gap, this.settings.icon_positions())];
    }
    _sync_tile_positions() {
        for (const canvas of this.canvases) {
            const [sorted, coords] = this._compute_sorted_and_coords(canvas.local_wa);
            for (let i = 0; i < sorted.length; i += 1) { const t = canvas.tiles.get(sorted[i].id), p = coords[i]; if (t && p) t.set_position(p.x, p.y); }
        }
    }
    _render_tiles() {
        if (this.canvases.length === 0) return;
        const cbs = {
            on_select: (t) => this._select_tile(t),
            on_drag_begin: (t) => { this.dragged_tile = t; this.dragged_entry = t.entry; refresh_file_manager_cache(this.fm_cache); },
            on_drag_end: () => { this._clear_drop_previews(); this.dragged_tile = this.dragged_entry = null; this._sync_tile_positions(); },
            on_context_menu: (t, sx, sy) => this.context_menu?.open_for_tile(t, sx, sy),
            on_tile_drag_over: (t, ext) => { this._clear_drop_previews(); t.set_drop_hover(true); if (ext) { this._prefetch_ext_dnd(); this.ext_hover_target = { kind: 'tile', uri: t.entry.uri }; } },
            on_drop_into_entry: (s, d) => { this._clear_drop_previews(); return move_uri_to_target(s.uri, d.uri, () => this.scanner?.schedule_rescan(60)); },
        };
        for (const canvas of this.canvases) {
            const [sorted, coords] = this._compute_sorted_and_coords(canvas.local_wa), seen = new Set();
            for (let i = 0; i < sorted.length; i += 1) {
                const entry = sorted[i], pos = coords[i] || { x: 16, y: 16 }, sel = entry.id === this.selected_id;
                seen.add(entry.id);
                let tile = canvas.tiles.get(entry.id);
                if (tile) { tile.update(entry, pos, sel); continue; }
                tile = new DesktopIconTile(entry, this.settings, cbs);
                tile.set_selected(sel);
                tile.set_position(pos.x, pos.y);
                canvas.actor.add_child(tile.actor);
                canvas.tiles.set(entry.id, tile);
            }
            for (const [id, tile] of canvas.tiles.entries()) { if (!seen.has(id)) { tile.destroy(); canvas.tiles.delete(id); } }
        }
    }
    destroy() {
        if (this.drag_monitor && DND && typeof DND.removeDragMonitor === 'function') { DND.removeDragMonitor(this.drag_monitor); this.drag_monitor = null; }
        for (const [obj, id] of this.signals) { try { obj.disconnect(id); } catch (_e) { /* ignore */ } }
        this.signals.length = 0;
        this.scanner?.destroy();
        this.context_menu?.destroy();
        this._clear_canvases();
        this.unload_theme();
        this.entries.length = 0;
        this.scanner = this.context_menu = this.ext_dnd_source = this.ext_dnd_uris = this.ext_hover_target = null;
        this.selected_id = this.dragged_entry = this.dragged_tile = this.ext_settings = this.settings = null;
    }
}
