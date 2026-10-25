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

export function compute_grid_positions(count, workarea, cell_width, cell_height, start_corner = 'top-left', gap = 8) {
    const total = Math.max(0, Math.min(256, Math.floor(Number(count) || 0)));
    if (total === 0) return [];

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

    const positions = [];
    for (let idx = 0; idx < total; idx += 1) {
        const col = Math.min(max_cols - 1, Math.floor(idx / max_rows));
        const row = idx % max_rows;
        const x = right_anchored
            ? wx + pad + ww - cw - col * step_x
            : wx + pad + col * step_x;
        const y = bottom_anchored
            ? wy + pad + wh - ch - row * step_y
            : wy + pad + row * step_y;
        positions.push({ x: Math.round(x), y: Math.round(y), col, row });
    }
    return positions;
}
