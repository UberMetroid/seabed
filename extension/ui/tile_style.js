// SPDX-License-Identifier: GPL-3.0-or-later
// Pure desktop tile sizing, cell dimension math, and selection/hover border CSS builders.

import { parse_rgba } from './settings/color.js';

export const ICON_PIXEL_SIZES = Object.freeze({
    tiny: 32,
    small: 36,
    standard: 48,
    large: 64,
});

export function resolve_icon_pixel_size(preset) {
    if (typeof preset === 'string' && Object.prototype.hasOwnProperty.call(ICON_PIXEL_SIZES, preset)) {
        return ICON_PIXEL_SIZES[preset];
    }
    return ICON_PIXEL_SIZES.standard;
}

export function compute_cell_dimensions(preset) {
    const px = resolve_icon_pixel_size(preset);
    if (px <= 32) return { icon_px: px, width: 92, height: 86, gap: 6 };
    if (px <= 36) return { icon_px: px, width: 100, height: 94, gap: 8 };
    if (px <= 48) return { icon_px: px, width: 112, height: 108, gap: 8 };
    return { icon_px: px, width: 128, height: 126, gap: 10 };
}

export function build_label_inline_style(dark_text) {
    if (dark_text) {
        return 'color: #12161c; text-shadow: 0 1px 2px rgba(255, 255, 255, 0.88); font-weight: 600;';
    }
    return 'color: #f6f8fa; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.92); font-weight: 600;';
}

export function build_tile_inline_style(opts) {
    const {
        width = 112,
        height = 108,
        selected = false,
        hovered = false,
        show_border = true,
        border_width = 2,
        border_radius = 12,
        border_color = 'rgb(255,0,0)',
    } = opts || {};

    const w = Math.max(72, Math.min(200, Math.round(Number(width) || 112)));
    const h = Math.max(72, Math.min(200, Math.round(Number(height) || 108)));
    const bw = Math.max(0, Math.min(8, Math.round(Number(border_width) || 0)));
    const br = Math.max(0, Math.min(24, Math.round(Number(border_radius) || 0)));
    const rgba = parse_rgba(border_color);
    const active = Boolean(selected || hovered);

    let bg = 'rgba(0, 0, 0, 0.0)';
    if (selected) {
        bg = `rgba(${rgba.red}, ${rgba.green}, ${rgba.blue}, 0.24)`;
    } else if (hovered) {
        bg = `rgba(${rgba.red}, ${rgba.green}, ${rgba.blue}, 0.14)`;
    }

    let bdr = `${bw}px solid transparent`;
    if (active && show_border && bw > 0) {
        const alpha = selected ? rgba.alpha : Math.max(0.35, rgba.alpha * 0.72);
        bdr = `${bw}px solid rgba(${rgba.red}, ${rgba.green}, ${rgba.blue}, ${alpha})`;
    }

    return `width: ${w}px; height: ${h}px; border-radius: ${br}px; background-color: ${bg}; border: ${bdr}; padding: 6px 4px;`;
}

export function build_drop_preview_inline_style(opts) {
    const {
        width = 112,
        height = 108,
        border_width = 2,
        border_radius = 12,
        border_color = 'rgb(255,0,0)',
    } = opts || {};

    const w = Math.max(72, Math.min(200, Math.round(Number(width) || 112)));
    const h = Math.max(72, Math.min(200, Math.round(Number(height) || 108)));
    const bw = Math.max(2, Math.min(8, Math.round(Number(border_width) || 2)));
    const br = Math.max(0, Math.min(24, Math.round(Number(border_radius) || 12)));
    const rgba = parse_rgba(border_color);
    const bg = `rgba(${rgba.red}, ${rgba.green}, ${rgba.blue}, 0.22)`;
    const bdr = `${bw}px solid rgba(${rgba.red}, ${rgba.green}, ${rgba.blue}, ${Math.max(0.75, rgba.alpha)})`;
    return `width: ${w}px; height: ${h}px; border-radius: ${br}px; background-color: ${bg}; border: ${bdr};`;
}

