// SPDX-License-Identifier: GPL-3.0-or-later
// Pure desktop entry sorting and 4-corner grid slot coordinate calculator.

const SPECIAL_RANK = Object.freeze({
    home: 1,
    trash: 2,
    volume: 3,
});

function compare_names(a, b) {
    const na = String(a?.name || '').toLowerCase();
    const nb = String(b?.name || '').toLowerCase();
    if (na < nb) return -1;
    if (na > nb) return 1;
    const raw_a = String(a?.name || '');
    const raw_b = String(b?.name || '');
    if (raw_a < raw_b) return -1;
    if (raw_a > raw_b) return 1;
    return 0;
}

function compare_by_order(a, b, arrange_order) {
    if (arrange_order === 'DESCENDINGNAME') {
        return -compare_names(a, b);
    }
    if (arrange_order === 'MODIFIEDTIME') {
        const diff = (Number(b?.mtime) || 0) - (Number(a?.mtime) || 0);
        return diff !== 0 ? diff : compare_names(a, b);
    }
    if (arrange_order === 'SIZE') {
        const diff = (Number(b?.size) || 0) - (Number(a?.size) || 0);
        return diff !== 0 ? diff : compare_names(a, b);
    }
    if (arrange_order === 'KIND') {
        const ka = String(a?.kind || 'file').toLowerCase();
        const kb = String(b?.kind || 'file').toLowerCase();
        if (ka < kb) return -1;
        if (ka > kb) return 1;
        return compare_names(a, b);
    }
    return compare_names(a, b);
}

export function sort_desktop_entries(entries, arrange_order = 'NAME', sort_special = false) {
    if (!Array.isArray(entries)) return [];
    const copy = entries.slice();
    copy.sort((a, b) => {
        if (!sort_special) {
            const sa = Boolean(a?.is_special);
            const sb = Boolean(b?.is_special);
            if (sa !== sb) return sa ? -1 : 1;
            if (sa && sb) {
                const ra = SPECIAL_RANK[a?.kind] || 99;
                const rb = SPECIAL_RANK[b?.kind] || 99;
                if (ra !== rb) return ra - rb;
                return compare_names(a, b);
            }
        }
        return compare_by_order(a, b, arrange_order);
    });
    return copy;
}

export function compute_grid_metrics(workarea, cell_width, cell_height, start_corner = 'top-left', gap = 8) {
    const pad = 16;
    const wx = Number(workarea?.x) || 0;
    const wy = Number(workarea?.y) || 0;
    const ww = Math.max(120, (Number(workarea?.width) || 1920) - pad * 2);
    const wh = Math.max(120, (Number(workarea?.height) || 1080) - pad * 2);

    const cw = Math.max(64, Math.floor(Number(cell_width) || 112));
    const ch = Math.max(64, Math.floor(Number(cell_height) || 108));
    const sp = Math.max(0, Math.floor(Number(gap) || 8));
    const step_x = cw + sp;
    const step_y = ch + sp;

    const max_cols = Math.max(1, Math.floor((ww + sp) / step_x));
    const max_rows = Math.max(1, Math.floor((wh + sp) / step_y));
    const right_anchored = start_corner === 'top-right' || start_corner === 'bottom-right';
    const bottom_anchored = start_corner === 'bottom-left' || start_corner === 'bottom-right';

    return {
        pad, wx, wy, ww, wh, cw, ch, sp, step_x, step_y,
        max_cols, max_rows, right_anchored, bottom_anchored,
    };
}

export function slot_to_pixel(col, row, m) {
    const c = Math.max(0, Math.min(m.max_cols - 1, Math.floor(Number(col) || 0)));
    const r = Math.max(0, Math.min(m.max_rows - 1, Math.floor(Number(row) || 0)));
    const x = m.right_anchored ? m.wx + m.pad + m.ww - m.cw - c * m.step_x : m.wx + m.pad + c * m.step_x;
    const y = m.bottom_anchored ? m.wy + m.pad + m.wh - m.ch - r * m.step_y : m.wy + m.pad + r * m.step_y;
    return { x: Math.round(x), y: Math.round(y), col: c, row: r };
}

export function snap_pixel_to_slot(px, py, workarea, cell_width, cell_height, start_corner = 'top-left', gap = 8) {
    const m = compute_grid_metrics(workarea, cell_width, cell_height, start_corner, gap);
    const rx = m.right_anchored
        ? (m.wx + m.pad + m.ww - m.cw - (Number(px) || 0))
        : ((Number(px) || 0) - (m.wx + m.pad));
    const ry = m.bottom_anchored
        ? (m.wy + m.pad + m.wh - m.ch - (Number(py) || 0))
        : ((Number(py) || 0) - (m.wy + m.pad));
    const col = Math.max(0, Math.min(m.max_cols - 1, Math.round(rx / m.step_x)));
    const row = Math.max(0, Math.min(m.max_rows - 1, Math.round(ry / m.step_y)));
    return slot_to_pixel(col, row, m);
}

export function compute_grid_positions(
    count_or_entries, workarea, cell_width, cell_height, start_corner = 'top-left', gap = 8, custom_slots = null,
) {
    const is_arr = Array.isArray(count_or_entries);
    const total = Math.max(0, Math.min(256, Math.floor(is_arr ? count_or_entries.length : (Number(count_or_entries) || 0))));
    if (total === 0) return [];

    const m = compute_grid_metrics(workarea, cell_width, cell_height, start_corner, gap);
    const positions = new Array(total);
    const occupied = new Set();

    if (is_arr && custom_slots && typeof custom_slots === 'object') {
        for (let idx = 0; idx < total; idx += 1) {
            const id = count_or_entries[idx]?.id;
            const slot = id ? custom_slots[id] : null;
            if (slot && typeof slot.col === 'number' && typeof slot.row === 'number') {
                const pos = slot_to_pixel(slot.col, slot.row, m);
                const key = `${pos.col},${pos.row}`;
                if (!occupied.has(key)) {
                    occupied.add(key);
                    positions[idx] = pos;
                }
            }
        }
    }

    let scan = 0;
    const max_slots = m.max_cols * m.max_rows;
    for (let idx = 0; idx < total; idx += 1) {
        if (positions[idx]) continue;
        while (scan < max_slots) {
            const c = Math.min(m.max_cols - 1, Math.floor(scan / m.max_rows));
            const r = scan % m.max_rows;
            scan += 1;
            const key = `${c},${r}`;
            if (!occupied.has(key)) {
                occupied.add(key);
                positions[idx] = slot_to_pixel(c, r, m);
                break;
            }
        }
        if (!positions[idx]) {
            const c = Math.min(m.max_cols - 1, Math.floor(idx / m.max_rows));
            const r = idx % m.max_rows;
            positions[idx] = slot_to_pixel(c, r, m);
        }
    }
    return positions;
}

export function parse_uri_list(raw_text) {
    if (typeof raw_text !== 'string' || raw_text.length === 0) return [];
    const out = [], seen = new Set();
    for (const line of raw_text.replace(/\0/g, '').split(/\r?\n/)) {
        const s = line.split('\t')[0].trim();
        if (!s || s.startsWith('#') || !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) continue;
        if (!seen.has(s)) {
            seen.add(s);
            out.push(s);
            if (out.length >= 256) break;
        }
    }
    return out;
}

export function compute_dropped_file_slots(count, start_col, start_row, workarea, cell_width, cell_height, start_corner = 'top-left', gap = 8, custom_slots = null) {
    const n = Math.max(0, Math.min(256, Math.floor(Number(count) || 0)));
    if (n === 0) return [];
    const m = compute_grid_metrics(workarea, cell_width, cell_height, start_corner, gap);
    const occupied = new Set();
    if (custom_slots && typeof custom_slots === 'object') {
        for (const s of Object.values(custom_slots)) {
            if (s && typeof s.col === 'number' && typeof s.row === 'number') {
                const p = slot_to_pixel(s.col, s.row, m);
                occupied.add(`${p.col},${p.row}`);
            }
        }
    }
    const out = [], max_slots = m.max_cols * m.max_rows;
    let cursor = Math.max(0, Math.min(m.max_cols - 1, Math.floor(start_col))) * m.max_rows + Math.max(0, Math.min(m.max_rows - 1, Math.floor(start_row)));
    for (let step = 0; step < max_slots && out.length < n; step += 1) {
        const idx = (cursor + step) % max_slots;
        const pos = slot_to_pixel(Math.floor(idx / m.max_rows), idx % m.max_rows, m);
        const key = `${pos.col},${pos.row}`;
        if (!occupied.has(key)) { occupied.add(key); out.push({ col: pos.col, row: pos.row, x: pos.x, y: pos.y }); }
    }
    while (out.length < n) {
        const i = out.length, pos = slot_to_pixel(start_col + Math.floor((start_row + i) / m.max_rows), (start_row + i) % m.max_rows, m);
        out.push({ col: pos.col, row: pos.row, x: pos.x, y: pos.y });
    }
    return out;
}

