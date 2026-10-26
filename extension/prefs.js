// SPDX-License-Identifier: GPL-3.0-or-later
// Multi-tab GTK4 / Libadwaita preferences UI for Seabed desktop icons, grid layout, and borders.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {
    ARRANGE_ORDERS, ExtensionSettings, ICON_SIZES, START_CORNERS,
} from './ui/settings/gsettings.js';
import {
    bind_settings_keys, build_about_page, build_appearance_page, make_combo_row, make_switch_row,
} from './ui/settings/prefs_pages.js';

const DESKTOP_SPECIAL_ROWS = Object.freeze([
    ['show-home', 'show_home', 'Show Personal Home Folder', 'Display a shortcut to your home directory on the desktop grid'],
    ['show-trash', 'show_trash', 'Show Trash Icon', 'Display the freedesktop Trash shortcut with live empty/full icon state'],
    ['show-volumes', 'show_volumes', 'Show External &amp; Removable Drives', 'Display mounted USB drives, SD cards, and external volumes'],
    ['show-network-volumes', 'show_network_volumes', 'Show Mounted Network Volumes', 'Display remote SFTP, SMB, NFS, and WebDAV mounts on the desktop'],
]);

const DESKTOP_FILE_ROWS = Object.freeze([
    ['show-hidden-files', 'show_hidden_files', 'Show Hidden Files (.dotfiles)', 'Include hidden files and folders starting with a dot in ~/Desktop'],
    ['show-link-emblem', 'show_link_emblem', 'Show Symbolic Link Emblem', 'Display a link badge overlay on symlink desktop tiles'],
    ['single-click-open', 'single_click_open', 'Single-Click to Open Items', 'Open files and folders on single click instead of double click'],
    ['multi-monitor', 'multi_monitor', 'Show Desktop Icons on All Monitors', 'Render the desktop icon grid across all connected displays'],
]);

function add_bound_switches(group, specs, settings, bindings) {
    for (const [key, prop, title, subtitle] of specs) {
        const [row, sw] = make_switch_row(
            title, subtitle, settings[prop](), (v) => settings[`set_${prop}`](v),
        );
        group.add(row);
        bindings.push([key, sw, () => settings[prop]()]);
    }
}

function build_desktop_page(ext_settings, settings, signals) {
    const page = new Adw.PreferencesPage({ title: 'Desktop & Icons', icon_name: 'user-desktop-symbolic' });
    const bindings = [];

    const spec_group = new Adw.PreferencesGroup({
        title: 'Special Folders &amp; Mounted Drives',
        description: 'Choose which system shortcuts and removable volumes appear on your desktop',
    });
    add_bound_switches(spec_group, DESKTOP_SPECIAL_ROWS, settings, bindings);
    page.add(spec_group);

    const file_group = new Adw.PreferencesGroup({
        title: 'File Visibility &amp; Click Behavior',
        description: 'Configure hidden files, symlink badges, click policy, and multi-monitor rendering',
    });
    add_bound_switches(file_group, DESKTOP_FILE_ROWS, settings, bindings);

    const reset_row = new Adw.ActionRow({
        title: 'Reset to Seabed Defaults',
        subtitle: 'Restore Standard 48px icons, Top-Left start corner, Name sort, and Coral Red accent border',
    });
    const reset_btn = new Gtk.Button({
        label: 'Reset Defaults', valign: Gtk.Align.CENTER, css_classes: ['suggested-action'],
    });
    reset_btn.connect('clicked', () => settings.reset_defaults());
    reset_row.add_suffix(reset_btn);
    reset_row.activatable_widget = reset_btn;
    file_group.add(reset_row);
    page.add(file_group);

    bind_settings_keys(
        ext_settings,
        bindings.map(([k]) => k),
        () => {
            for (const [, sw, getter] of bindings) {
                const next = getter();
                if (sw.active !== next) sw.active = next;
            }
        },
        signals,
    );
    return page;
}

function build_grid_page(ext_settings, settings, signals) {
    const page = new Adw.PreferencesPage({ title: 'Grid & Sorting', icon_name: 'view-grid-symbolic' });
    const grid_group = new Adw.PreferencesGroup({
        title: 'Desktop Grid Sizing &amp; Anchor Corner',
        description: 'Control desktop icon zoom level and which screen corner begins the icon grid',
    });
    const size_labels = ['Tiny (32 px)', 'Small (36 px)', 'Standard (48 px — Default)', 'Large (64 px)'];
    const [sz_row, sz_combo] = make_combo_row(
        'Desktop Icon Size', 'Icon pixel dimensions and proportional grid cell spacing',
        size_labels, Math.max(0, ICON_SIZES.indexOf(settings.icon_size())),
        (idx) => { if (idx >= 0 && idx < ICON_SIZES.length) settings.set_icon_size(ICON_SIZES[idx]); },
    );
    const corner_labels = [
        'Top Left (Default)', 'Top Right', 'Bottom Left', 'Bottom Right',
    ];
    const [cr_row, cr_combo] = make_combo_row(
        'Grid Starting Corner', 'Screen corner from which Seabed populates desktop icon columns',
        corner_labels, Math.max(0, START_CORNERS.indexOf(settings.start_corner())),
        (idx) => { if (idx >= 0 && idx < START_CORNERS.length) settings.set_start_corner(START_CORNERS[idx]); },
    );
    grid_group.add(sz_row);
    grid_group.add(cr_row);
    page.add(grid_group);

    const sort_group = new Adw.PreferencesGroup({
        title: 'Sorting &amp; Folder Ordering',
        description: 'Choose how desktop files, folders, and special shortcuts are ordered',
    });
    const order_labels = [
        'Name (A -> Z — Default)',
        'Descending Name (Z -> A)',
        'Modified Time (Newest First)',
        'Kind / File Type',
        'File Size (Largest First)',
    ];
    const [ord_row, ord_combo] = make_combo_row(
        'Arrange Desktop Icons By', 'Right-click the desktop anytime to switch sorting on the fly',
        order_labels, Math.max(0, ARRANGE_ORDERS.indexOf(settings.arrange_order())),
        (idx) => { if (idx >= 0 && idx < ARRANGE_ORDERS.length) settings.set_arrange_order(ARRANGE_ORDERS[idx]); },
    );
    const [sp_row, sp_sw] = make_switch_row(
        'Sort Special Folders Alongside Files',
        'When off, Home, Trash, and Drives stay pinned at the beginning of the grid',
        settings.sort_special_folders(), (v) => settings.set_sort_special_folders(v),
    );
    sort_group.add(ord_row);
    sort_group.add(sp_row);
    page.add(sort_group);

    bind_settings_keys(
        ext_settings,
        ['icon-size', 'start-corner', 'arrange-order', 'sort-special-folders'],
        () => {
            const s_idx = Math.max(0, ICON_SIZES.indexOf(settings.icon_size()));
            if (sz_combo.get_active() !== s_idx) sz_combo.set_active(s_idx);
            const c_idx = Math.max(0, START_CORNERS.indexOf(settings.start_corner()));
            if (cr_combo.get_active() !== c_idx) cr_combo.set_active(c_idx);
            const o_idx = Math.max(0, ARRANGE_ORDERS.indexOf(settings.arrange_order()));
            if (ord_combo.get_active() !== o_idx) ord_combo.set_active(o_idx);
            if (sp_sw.active !== settings.sort_special_folders()) sp_sw.active = settings.sort_special_folders();
        },
        signals,
    );
    return page;
}

export default class SeabedPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const ext_settings = this.getSettings();
        const settings = new ExtensionSettings(ext_settings);
        const signals = [];
        window.set_default_size(760, 680);
        window.add(build_desktop_page(ext_settings, settings, signals));
        window.add(build_grid_page(ext_settings, settings, signals));
        window.add(build_appearance_page(ext_settings, settings, signals));
        window.add(build_about_page());
        window.connect('close-request', () => {
            for (const [obj, sig] of signals) obj.disconnect(sig);
            signals.length = 0;
            return false;
        });
    }
}
