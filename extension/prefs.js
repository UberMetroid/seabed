// SPDX-License-Identifier: GPL-3.0-or-later
// Multi-tab GTK4 / Libadwaita preferences UI for Seabed desktop icons, grid layout, and borders.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {
    ARRANGE_ORDERS, ExtensionSettings, ICON_SIZES, START_CORNERS,
} from './ui/settings/gsettings.js';
import { build_about_page, build_appearance_page } from './ui/settings/prefs_pages.js';

function make_switch_row(title, subtitle, active, on_toggle) {
    const row = new Adw.ActionRow({ title, subtitle });
    const sw = new Gtk.Switch({ active: Boolean(active), valign: Gtk.Align.CENTER });
    sw.connect('notify::active', () => on_toggle(sw.active));
    row.add_suffix(sw);
    row.activatable_widget = sw;
    return [row, sw];
}

function make_combo_row(title, subtitle, items, active_idx, on_change) {
    const row = new Adw.ActionRow({ title, subtitle });
    const combo = new Gtk.ComboBoxText({ valign: Gtk.Align.CENTER });
    for (const item of items) combo.append_text(item);
    combo.set_active(Math.max(0, active_idx));
    combo.connect('changed', () => on_change(combo.get_active()));
    row.add_suffix(combo);
    return [row, combo];
}

function build_desktop_page(ext_settings, settings, signals) {
    const page = new Adw.PreferencesPage({ title: 'Desktop & Icons', icon_name: 'user-desktop-symbolic' });
    const spec_group = new Adw.PreferencesGroup({
        title: 'Special Folders &amp; Mounted Drives',
        description: 'Choose which system shortcuts and removable volumes appear on your desktop',
    });
    const [home_row, home_sw] = make_switch_row(
        'Show Personal Home Folder', 'Display a shortcut to your home directory on the desktop grid',
        settings.show_home(), (v) => settings.set_show_home(v),
    );
    const [trash_row, trash_sw] = make_switch_row(
        'Show Trash Icon', 'Display the freedesktop Trash shortcut with live empty/full icon state',
        settings.show_trash(), (v) => settings.set_show_trash(v),
    );
    const [vol_row, vol_sw] = make_switch_row(
        'Show External &amp; Removable Drives', 'Display mounted USB drives, SD cards, and external volumes',
        settings.show_volumes(), (v) => settings.set_show_volumes(v),
    );
    const [net_row, net_sw] = make_switch_row(
        'Show Mounted Network Volumes', 'Display remote SFTP, SMB, NFS, and WebDAV mounts on the desktop',
        settings.show_network_volumes(), (v) => settings.set_show_network_volumes(v),
    );
    for (const r of [home_row, trash_row, vol_row, net_row]) spec_group.add(r);
    page.add(spec_group);

    const file_group = new Adw.PreferencesGroup({
        title: 'File Visibility &amp; Click Behavior',
        description: 'Configure hidden files, symlink badges, click policy, and multi-monitor rendering',
    });
    const [hid_row, hid_sw] = make_switch_row(
        'Show Hidden Files (.dotfiles)', 'Include hidden files and folders starting with a dot in ~/Desktop',
        settings.show_hidden_files(), (v) => settings.set_show_hidden_files(v),
    );
    const [lnk_row, lnk_sw] = make_switch_row(
        'Show Symbolic Link Emblem', 'Display a link badge overlay on symlink desktop tiles',
        settings.show_link_emblem(), (v) => settings.set_show_link_emblem(v),
    );
    const [clk_row, clk_sw] = make_switch_row(
        'Single-Click to Open Items', 'Open files and folders on single click instead of double click',
        settings.single_click_open(), (v) => settings.set_single_click_open(v),
    );
    const [mm_row, mm_sw] = make_switch_row(
        'Show Desktop Icons on All Monitors', 'Render the desktop icon grid across all connected displays',
        settings.multi_monitor(), (v) => settings.set_multi_monitor(v),
    );
    for (const r of [hid_row, lnk_row, clk_row, mm_row]) file_group.add(r);

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

    const sync_desktop = () => {
        if (home_sw.active !== settings.show_home()) home_sw.active = settings.show_home();
        if (trash_sw.active !== settings.show_trash()) trash_sw.active = settings.show_trash();
        if (vol_sw.active !== settings.show_volumes()) vol_sw.active = settings.show_volumes();
        if (net_sw.active !== settings.show_network_volumes()) net_sw.active = settings.show_network_volumes();
        if (hid_sw.active !== settings.show_hidden_files()) hid_sw.active = settings.show_hidden_files();
        if (lnk_sw.active !== settings.show_link_emblem()) lnk_sw.active = settings.show_link_emblem();
        if (clk_sw.active !== settings.single_click_open()) clk_sw.active = settings.single_click_open();
        if (mm_sw.active !== settings.multi_monitor()) mm_sw.active = settings.multi_monitor();
    };
    const d_keys = [
        'show-home', 'show-trash', 'show-volumes', 'show-network-volumes',
        'show-hidden-files', 'show-link-emblem', 'single-click-open', 'multi-monitor',
    ];
    for (const k of d_keys) {
        if (ext_settings.settings_schema?.has_key(k)) {
            signals.push([ext_settings, ext_settings.connect(`changed::${k}`, sync_desktop)]);
        }
    }
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
        size_labels, ICON_SIZES.indexOf(settings.icon_size()),
        (idx) => { if (idx >= 0 && idx < ICON_SIZES.length) settings.set_icon_size(ICON_SIZES[idx]); },
    );
    const corner_labels = [
        'Top Left (Default)', 'Top Right', 'Bottom Left', 'Bottom Right',
    ];
    const [cr_row, cr_combo] = make_combo_row(
        'Grid Starting Corner', 'Screen corner from which Seabed populates desktop icon columns',
        corner_labels, START_CORNERS.indexOf(settings.start_corner()),
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
        order_labels, ARRANGE_ORDERS.indexOf(settings.arrange_order()),
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

    const sync_grid = () => {
        const s_idx = Math.max(0, ICON_SIZES.indexOf(settings.icon_size()));
        if (sz_combo.get_active() !== s_idx) sz_combo.set_active(s_idx);
        const c_idx = Math.max(0, START_CORNERS.indexOf(settings.start_corner()));
        if (cr_combo.get_active() !== c_idx) cr_combo.set_active(c_idx);
        const o_idx = Math.max(0, ARRANGE_ORDERS.indexOf(settings.arrange_order()));
        if (ord_combo.get_active() !== o_idx) ord_combo.set_active(o_idx);
        if (sp_sw.active !== settings.sort_special_folders()) sp_sw.active = settings.sort_special_folders();
    };
    for (const k of ['icon-size', 'start-corner', 'arrange-order', 'sort-special-folders']) {
        if (ext_settings.settings_schema?.has_key(k)) {
            signals.push([ext_settings, ext_settings.connect(`changed::${k}`, sync_grid)]);
        }
    }
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
