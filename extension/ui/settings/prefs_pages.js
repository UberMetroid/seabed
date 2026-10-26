// SPDX-License-Identifier: GPL-3.0-or-later
// Libadwaita Preferences Appearance & Borders and About & Support pages for Seabed.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import { format_rgba, parse_rgba } from './color.js';

export const BORDER_PRESETS = Object.freeze([
    ['Gruvbox Amber', 'rgb(251,184,108)'],
    ['Kelp Emerald', 'rgb(46,194,126)'],
    ['Ocean Cyan', 'rgb(106,215,225)'],
    ['Coral Red', 'rgb(255,0,0)'],
]);

export function make_switch_row(title, subtitle, active, on_toggle) {
    const row = new Adw.ActionRow({ title, subtitle });
    const sw = new Gtk.Switch({ active: Boolean(active), valign: Gtk.Align.CENTER });
    sw.connect('notify::active', () => on_toggle(sw.active));
    row.add_suffix(sw);
    row.activatable_widget = sw;
    return [row, sw];
}

export function make_spin_row(title, subtitle, value, min, max, step, on_change) {
    const row = new Adw.ActionRow({ title, subtitle });
    const spin = Gtk.SpinButton.new_with_range(min, max, step);
    spin.set_value(value);
    spin.set_valign(Gtk.Align.CENTER);
    spin.connect('value-changed', () => on_change(spin.get_value_as_int()));
    row.add_suffix(spin);
    return [row, spin];
}

export function make_combo_row(title, subtitle, items, active_idx, on_change) {
    const row = new Adw.ActionRow({ title, subtitle });
    const combo = new Gtk.ComboBoxText({ valign: Gtk.Align.CENTER });
    for (const item of items) combo.append_text(item);
    combo.set_active(active_idx >= 0 && active_idx < items.length ? active_idx : -1);
    combo.connect('changed', () => on_change(combo.get_active()));
    row.add_suffix(combo);
    return [row, combo];
}

export function bind_settings_keys(ext_settings, keys, sync_fn, signals) {
    for (const k of keys) {
        if (ext_settings.settings_schema?.has_key(k)) {
            signals.push([ext_settings, ext_settings.connect(`changed::${k}`, sync_fn)]);
        }
    }
}

function add_link_row(group, title, subtitle, button_label, url, fallback_url = null) {
    const row = new Adw.ActionRow({ title, subtitle });
    const btn = new Gtk.Button({
        label: button_label,
        valign: Gtk.Align.CENTER,
        css_classes: ['pill'],
    });
    btn.connect('clicked', () => {
        let ok = false;
        try {
            ok = Boolean(Gio.AppInfo.launch_default_for_uri(url, null));
        } catch (_e) {
            ok = false;
        }
        if (!ok && fallback_url) {
            try { Gio.AppInfo.launch_default_for_uri(fallback_url, null); } catch (_e2) { /* ignore */ }
        }
    });
    row.add_suffix(btn);
    row.activatable_widget = btn;
    group.add(row);
}

export function build_appearance_page(ext_settings, settings, signals) {
    const page = new Adw.PreferencesPage({
        title: 'Appearance & Borders',
        icon_name: 'applications-graphics-symbolic',
    });

    const label_group = new Adw.PreferencesGroup({
        title: 'Icon Label Contrast &amp; Wallpaper Readability',
        description: 'Adjust desktop icon caption colors for dark or bright wallpapers',
    });
    const [dark_row, dark_sw] = make_switch_row(
        'Dark Text in Icon Labels',
        'Render dark text with a light halo instead of white text with a dark shadow',
        settings.dark_text_in_labels(),
        (v) => settings.set_dark_text_in_labels(v),
    );
    label_group.add(dark_row);
    page.add(label_group);

    const bdr_group = new Adw.PreferencesGroup({
        title: 'Selection &amp; Hover Accent Borders',
        description: 'Match desktop icon selection rings with Kelp active windows and Reef dock borders',
    });
    const [show_row, show_sw] = make_switch_row(
        'Show Selection &amp; Hover Border Ring',
        'Draw a high-contrast accent border around hovered and selected desktop icons',
        settings.show_selection_border(),
        (v) => settings.set_show_selection_border(v),
    );
    const color_row = new Adw.ActionRow({
        title: 'Accent Border Color',
        subtitle: 'Pick a custom RGBA color or select a 1-click Kelp/Reef preset below',
    });
    const rgba = new Gdk.RGBA();
    if (!rgba.parse(settings.border_color_rgba())) rgba.parse('rgb(255,0,0)');
    const color_btn = new Gtk.ColorButton({ rgba, use_alpha: true, valign: Gtk.Align.CENTER });
    color_btn.connect('color-set', () => settings.set_border_color_rgba(color_btn.get_rgba().to_string()));
    color_row.add_suffix(color_btn);

    const preset_labels = BORDER_PRESETS.map(([label]) => label);
    const match_preset = (color) => BORDER_PRESETS.findIndex(([, c]) => format_rgba(parse_rgba(c)) === color);
    const [preset_row, preset_combo] = make_combo_row(
        'Quick Color Presets',
        'One-click color presets matching Kelp and Reef accent borders',
        preset_labels,
        match_preset(settings.border_color_rgba()),
        (idx) => {
            if (idx >= 0 && idx < BORDER_PRESETS.length) {
                const css_color = BORDER_PRESETS[idx][1];
                settings.set_border_color_rgba(css_color);
                const next_rgba = new Gdk.RGBA();
                if (next_rgba.parse(css_color)) color_btn.set_rgba(next_rgba);
            }
        },
    );
    const [bw_row, bw_spin] = make_spin_row(
        'Border Width (px)',
        'Thickness of the selection and hover border ring (0–8 px, default 2 px)',
        settings.border_width(), 0, 8, 1, (v) => settings.set_border_width(v),
    );
    const [br_row, br_spin] = make_spin_row(
        'Border Corner Radius (px)',
        'Corner rounding of desktop icon tiles (0–24 px, default 12 px)',
        settings.border_radius(), 0, 24, 2, (v) => settings.set_border_radius(v),
    );
    for (const r of [show_row, color_row, preset_row, bw_row, br_row]) bdr_group.add(r);
    page.add(bdr_group);

    const sync_appearance = () => {
        if (dark_sw.active !== settings.dark_text_in_labels()) dark_sw.active = settings.dark_text_in_labels();
        if (show_sw.active !== settings.show_selection_border()) show_sw.active = settings.show_selection_border();
        if (bw_spin.get_value_as_int() !== settings.border_width()) bw_spin.set_value(settings.border_width());
        if (br_spin.get_value_as_int() !== settings.border_radius()) br_spin.set_value(settings.border_radius());
        const next_color = settings.border_color_rgba();
        const next_rgba = new Gdk.RGBA();
        if (next_rgba.parse(next_color) && !color_btn.get_rgba().equal(next_rgba)) color_btn.set_rgba(next_rgba);
        const next_idx = match_preset(next_color);
        if (preset_combo.get_active() !== next_idx) preset_combo.set_active(next_idx);
    };
    bind_settings_keys(
        ext_settings,
        ['dark-text-in-labels', 'show-selection-border', 'border-width', 'border-radius', 'border-color-rgba'],
        sync_appearance, signals,
    );
    return page;
}

export function build_about_page() {
    const page = new Adw.PreferencesPage({
        title: 'About & Support',
        icon_name: 'help-about-symbolic',
    });

    const header_group = new Adw.PreferencesGroup({
        title: 'Seabed — Wayland-Native Desktop Icons for GNOME 45–50',
        description: 'Zero-subprocess desktop icon grid rendering ~/Desktop files, Home, Trash, and mounted drives ' +
            'natively inside the compositor background layer alongside Kelp, Reef, and Shoal.',
    });

    const ver_row = new Adw.ActionRow({
        title: 'Seabed Release Version',
        subtitle: 'Zero-subprocess, zero-telemetry Wayland desktop icons extension for GNOME Shell',
    });
    ver_row.add_suffix(new Gtk.Label({
        label: 'v1.2.0', valign: Gtk.Align.CENTER, css_classes: ['monospace'],
    }));
    header_group.add(ver_row);

    const lic_row = new Adw.ActionRow({
        title: 'Open-Source License',
        subtitle: 'Derived from Desktop Icons NG (Sergio Costas, Carlos Soriano, &amp; contributors)',
    });
    lic_row.add_suffix(new Gtk.Label({
        label: 'GPL-3.0-or-later', valign: Gtk.Align.CENTER, css_classes: ['monospace'],
    }));
    header_group.add(lic_row);
    page.add(header_group);

    const support_group = new Adw.PreferencesGroup({
        title: 'Support &amp; Community',
        description: 'If Seabed improves your daily workflow alongside Kelp, Reef, and Shoal, starring the ' +
            'repository or sponsoring development helps keep GNOME 45–50 support fast and rock-solid.',
    });

    add_link_row(
        support_group,
        'Star Seabed on GitHub',
        'Star UberMetroid/seabed to help other GNOME &amp; Linux users discover Seabed',
        'Star on GitHub',
        'https://github.com/UberMetroid/seabed',
    );
    add_link_row(
        support_group,
        'Tuition, Not Coffee — Help send my daughter to college',
        "Skip the coffee — 100% of sponsorships go toward my daughter's college &amp; future fund",
        'Tuition, Not Coffee',
        'https://ubermetroid.github.io/tuition-not-coffee',
        'https://github.com/UberMetroid/seabed',
    );
    add_link_row(
        support_group,
        'Project Website &amp; Documentation',
        'Explore the Seabed feature guide, Kelp + Reef + Shoal overview, and configuration reference',
        'Open Website',
        'https://ubermetroid.github.io/seabed/',
    );
    add_link_row(
        support_group,
        'Report an Issue or Request a Feature',
        'Found a bug or have a feature request? Open an issue on GitHub',
        'Report Issue',
        'https://github.com/UberMetroid/seabed/issues',
    );

    page.add(support_group);
    return page;
}
