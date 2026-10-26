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

    if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) {
        const hex = s.slice(1);
        if (hex.length <= 4) {
            const alpha = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1.0;
            return {
                red: clamp_byte(parseInt(hex[0] + hex[0], 16)),
                green: clamp_byte(parseInt(hex[1] + hex[1], 16)),
                blue: clamp_byte(parseInt(hex[2] + hex[2], 16)),
                alpha: clamp_alpha(alpha),
            };
        }
        const alpha = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1.0;
        return {
            red: clamp_byte(parseInt(hex.slice(0, 2), 16)),
            green: clamp_byte(parseInt(hex.slice(2, 4), 16)),
            blue: clamp_byte(parseInt(hex.slice(4, 6), 16)),
            alpha: clamp_alpha(alpha),
        };
    }

    const match = s.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+%?))?\s*\)$/i);
    if (match) {
        let alpha = 1.0;
        if (match[4] !== undefined) {
            const raw_a = match[4];
            alpha = raw_a.endsWith('%') ? parseFloat(raw_a) / 100 : parseFloat(raw_a);
        }
        return {
            red: clamp_byte(parseFloat(match[1])),
            green: clamp_byte(parseFloat(match[2])),
            blue: clamp_byte(parseFloat(match[3])),
            alpha: clamp_alpha(alpha),
        };
    }

    return { ...DEFAULT_RGBA };
}

export function format_rgba(rgba) {
    const src = rgba && typeof rgba === 'object' ? rgba : DEFAULT_RGBA;
    const r = clamp_byte(src.red);
    const g = clamp_byte(src.green);
    const b = clamp_byte(src.blue);
    const a = clamp_alpha(src.alpha);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function is_dark_rgba(rgba) {
    const src = rgba && typeof rgba === 'object' ? rgba : DEFAULT_RGBA;
    const to_linear = (channel) => {
        const c = clamp_byte(channel) / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const luminance =
        0.2126 * to_linear(src.red) +
        0.7152 * to_linear(src.green) +
        0.0722 * to_linear(src.blue);
    return luminance <= 0.179;
}

export function text_color_for_css(css_color) {
    const parsed = parse_rgba(css_color);
    return is_dark_rgba(parsed) ? '#ffffff' : '#000000';
}
