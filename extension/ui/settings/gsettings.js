// SPDX-License-Identifier: GPL-3.0-or-later
// Typed wrapper (ExtensionSettings) around Seabed desktop icon GSettings schema.

import { format_rgba, parse_rgba } from './color.js';

export const ICON_SIZES = Object.freeze(['tiny', 'small', 'standard', 'large']);
export const START_CORNERS = Object.freeze(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
export const ARRANGE_ORDERS = Object.freeze(['NAME', 'DESCENDINGNAME', 'MODIFIEDTIME', 'KIND', 'SIZE']);

const BOOL_DEFAULTS = Object.freeze({
    'sort-special-folders': false,
    'show-home': true,
    'show-trash': true,
    'show-volumes': true,
    'show-network-volumes': false,
    'show-hidden-files': false,
    'show-link-emblem': true,
    'dark-text-in-labels': false,
    'single-click-open': false,
    'multi-monitor': false,
    'show-selection-border': true,
});

const UINT_BOUNDS = Object.freeze({
    'border-width': [0, 8, 2],
    'border-radius': [0, 24, 12],
});

const ENUM_SPEC = Object.freeze({
    'icon-size': [ICON_SIZES, 'standard'],
    'start-corner': [START_CORNERS, 'top-left'],
    'arrange-order': [ARRANGE_ORDERS, 'NAME'],
});

export class ExtensionSettings {
    constructor(ext_settings) {
        this.ext = ext_settings;

        for (const [key, def] of Object.entries(BOOL_DEFAULTS)) {
            const prop = key.replace(/-/g, '_');
            this[prop] = () => (this.ext.settings_schema?.has_key(key) ? this.ext.get_boolean(key) : def);
            this[`set_${prop}`] = (v) => {
                if (this.ext.settings_schema?.has_key(key)) this.ext.set_boolean(key, Boolean(v));
            };
        }

        for (const [key, [min, max, def]] of Object.entries(UINT_BOUNDS)) {
            const prop = key.replace(/-/g, '_');
            this[prop] = () => {
                if (!this.ext.settings_schema?.has_key(key)) return def;
                const raw = this.ext.get_uint(key);
                return Math.max(min, Math.min(max, raw));
            };
            this[`set_${prop}`] = (v) => {
                if (!this.ext.settings_schema?.has_key(key)) return;
                const clamped = Math.max(min, Math.min(max, Math.round(Number(v) || 0)));
                this.ext.set_uint(key, clamped);
            };
        }

        for (const [key, [allowed, def]] of Object.entries(ENUM_SPEC)) {
            const prop = key.replace(/-/g, '_');
            this[prop] = () => {
                if (!this.ext.settings_schema?.has_key(key)) return def;
                const raw = this.ext.get_string(key);
                return allowed.includes(raw) ? raw : def;
            };
            this[`set_${prop}`] = (v) => {
                if (!this.ext.settings_schema?.has_key(key)) return;
                const valid = allowed.includes(v) ? v : def;
                if (this.ext.get_string(key) !== valid) this.ext.set_string(key, valid);
            };
        }
    }

    border_color_rgba() {
        if (!this.ext.settings_schema?.has_key('border-color-rgba')) {
            return format_rgba(parse_rgba('rgb(255,0,0)'));
        }
        return format_rgba(parse_rgba(this.ext.get_string('border-color-rgba')));
    }

    set_border_color_rgba(css_str) {
        if (this.ext.settings_schema?.has_key('border-color-rgba')) {
            this.ext.set_string('border-color-rgba', format_rgba(parse_rgba(css_str)));
        }
    }

    reset_defaults() {
        this.set_icon_size('standard');
        this.set_start_corner('top-left');
        this.set_arrange_order('NAME');
        this.set_sort_special_folders(false);
        this.set_show_home(true);
        this.set_show_trash(true);
        this.set_show_volumes(true);
        this.set_show_network_volumes(false);
        this.set_show_hidden_files(false);
        this.set_show_link_emblem(true);
        this.set_dark_text_in_labels(false);
        this.set_single_click_open(false);
        this.set_multi_monitor(false);
        this.set_show_selection_border(true);
        this.set_border_width(2);
        this.set_border_radius(12);
        this.set_border_color_rgba('rgb(255,0,0)');
    }
}
