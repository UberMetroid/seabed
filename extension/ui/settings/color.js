// SPDX-License-Identifier: GPL-3.0-or-later
// CSS color parser, sRGB relative luminance calculator, and contrast palette selector.

const DEFAULT_RGBA = Object.freeze({ red: 255, green: 0, blue: 0, alpha: 1.0 });

function clamp_byte(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(255, Math.round(n)));
}

function clamp_alpha(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 1.0;
    return Math.max(0.0, Math.min(1.0, n));
}

export function parse_rgba(input) {
    if (typeof input !== 'string') return { ...DEFAULT_RGBA };
    const s = input.trim();

    if (s.startsWith('#')) {
        const hex = s.slice(1);
        if (hex.length === 3) {
            return {
                red: clamp_byte(parseInt(hex[0] + hex[0], 16)),
                green: clamp_byte(parseInt(hex[1] + hex[1], 16)),
                blue: clamp_byte(parseInt(hex[2] + hex[2], 16)),
                alpha: 1.0,
            };
        }
        if (hex.length === 6 || hex.length === 8) {
            const alpha = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1.0;
            return {
                red: clamp_byte(parseInt(hex.slice(0, 2), 16)),
                green: clamp_byte(parseInt(hex.slice(2, 4), 16)),
                blue: clamp_byte(parseInt(hex.slice(4, 6), 16)),
                alpha: clamp_alpha(alpha),
            };
        }
    }

    const match = s.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/i);
    if (match) {
        return {
            red: clamp_byte(parseFloat(match[1])),
            green: clamp_byte(parseFloat(match[2])),
            blue: clamp_byte(parseFloat(match[3])),
            alpha: match[4] !== undefined ? clamp_alpha(parseFloat(match[4])) : 1.0,
        };
    }

    return { ...DEFAULT_RGBA };
}

export function format_rgba(rgba) {
    const r = clamp_byte(rgba.red);
    const g = clamp_byte(rgba.green);
    const b = clamp_byte(rgba.blue);
    const a = clamp_alpha(rgba.alpha);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function is_dark_rgba(rgba) {
    const to_linear = (channel) => {
        const c = clamp_byte(channel) / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const luminance =
        0.2126 * to_linear(rgba.red) +
        0.7152 * to_linear(rgba.green) +
        0.0722 * to_linear(rgba.blue);
    return luminance <= 0.179;
}

export function text_color_for_css(css_color) {
    const parsed = parse_rgba(css_color);
    return is_dark_rgba(parsed) ? '#ffffff' : '#000000';
}
