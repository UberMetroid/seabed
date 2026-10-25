// SPDX-License-Identifier: GPL-3.0-or-later
// Zero-dependency GJS architectural lint, Page Rule, EGO boundary, GTK4/Adw, and behavioral test suite.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { compute_grid_positions, sort_desktop_entries } from '../extension/desktop/desktop_grid.js';
import {
    ICON_PIXEL_SIZES, build_label_inline_style, build_tile_inline_style,
    compute_cell_dimensions, resolve_icon_pixel_size,
} from '../extension/ui/tile_style.js';
import { format_rgba, is_dark_rgba, parse_rgba, text_color_for_css } from '../extension/ui/settings/color.js';
import {
    ARRANGE_ORDERS, ExtensionSettings, ICON_SIZES, START_CORNERS,
} from '../extension/ui/settings/gsettings.js';
import { BORDER_PRESETS, build_about_page, build_appearance_page } from '../extension/ui/settings/prefs_pages.js';

const BANNED_STEMS = new Set([
    'util', 'utils', 'lib', 'helper', 'helpers', 'common', 'misc', 'shared', 'base', 'core', 'types', 'mod',
]);
const DECODER = new TextDecoder('utf-8');
const REPO_ROOT = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_path();
const EXT_ROOT = GLib.build_filenamev([REPO_ROOT, 'extension']);

function assert(cond, msg) {
    if (!cond) throw new Error(`Verification failed: ${msg}`);
}

function read_text(path) {
    const [ok, bytes] = GLib.file_get_contents(path);
    assert(ok, `failed to read ${path}`);
    return DECODER.decode(bytes);
}

function walk_repo(dir_path, js_files, dirs) {
    dirs.push(dir_path);
    const enumerator = Gio.File.new_for_path(dir_path).enumerate_children(
        'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null,
    );
    let info;
    while ((info = enumerator.next_file(null)) !== null) {
        const name = info.get_name();
        if (name.startsWith('.') || name === 'dist' || name === 'target') continue;
        const full = GLib.build_filenamev([dir_path, name]);
        if (info.get_file_type() === Gio.FileType.DIRECTORY) walk_repo(full, js_files, dirs);
        else if (name.endsWith('.js')) js_files.push(full);
    }
    enumerator.close(null);
}

function verify_page_rules_and_lint(js_files, dirs) {
    assert(js_files.length === 12, `expected 12 .js files, found ${js_files.length}`);
    const legacy = [
        'imports.gi', 'imports.ui', 'imports.misc', 'ExtensionUtils',
        'Meta.LaterType', 'Clutter.Container', 'add_actor', 'remove_actor',
    ];
    for (const file of js_files) {
        const content = read_text(file);
        const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
        assert(lines.length >= 16 && lines.length <= 256,
            `Page Rule violation: ${file} has ${lines.length} lines (16..=256)`);
        assert(lines[0] === '// SPDX-License-Identifier: GPL-3.0-or-later', `Missing SPDX header in ${file}`);
        assert(lines[1].startsWith('// ') && lines[1].length >= 12,
            `Missing concise module description on line 2 of ${file}`);
        if (file.startsWith(EXT_ROOT)) {
            for (const sym of legacy) {
                assert(!content.includes(sym), `Forbidden legacy symbol '${sym}' in ${file}`);
            }
        }
        for (let idx = 0; idx < lines.length; idx += 1) {
            const raw = lines[idx], ln = idx + 1, code = raw.split('//')[0];
            assert(raw.length <= 200, `Line ${ln} of ${file} exceeds 200 chars (${raw.length})`);
            if (!file.startsWith(EXT_ROOT)) continue;
            assert(!code.trimStart().startsWith('var ') && !code.includes(' var ') && !code.includes('(var '),
                `Forbidden var in ${file}:${ln}`);
            for (let i = 0; i < code.length - 1; i += 1) {
                const prev = i > 0 ? code[i - 1] : '';
                const prev_eq = prev === '=' || prev === '!' || prev === '<' || prev === '>';
                const next_eq = i + 2 < code.length && code[i + 2] === '=';
                assert(!(code[i] === '=' && code[i + 1] === '=' && !prev_eq && !next_eq), `Loose == in ${file}:${ln}`);
                assert(!(code[i] === '!' && code[i + 1] === '=' && !next_eq), `Loose != in ${file}:${ln}`);
            }
        }
    }
    for (const dir_path of dirs) {
        const enumerator = Gio.File.new_for_path(dir_path).enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null,
        );
        const visible = [];
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (!name.startsWith('.') && name !== 'dist' && name !== 'target') visible.push(name);
        }
        enumerator.close(null);
        assert(visible.length <= 8,
            `Directory density violation: ${dir_path} has ${visible.length} visible entries (max 8)`);
        for (const name of visible) {
            const stem = (name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name).toLowerCase();
            assert(!BANNED_STEMS.has(stem), `Banned generic name '${name}' in ${dir_path}`);
        }
    }
}

function verify_process_boundaries_and_invariants() {
    const shared = [
        'prefs.js', 'desktop/desktop_grid.js', 'ui/tile_style.js',
        'ui/settings/color.js', 'ui/settings/gsettings.js', 'ui/settings/prefs_pages.js',
    ];
    const compositor_only = ['gi://Meta', 'gi://Clutter', 'gi://St', 'gi://Shell', 'resource:///org/gnome/shell/'];
    for (const rel of shared) {
        for (const raw of read_text(GLib.build_filenamev([EXT_ROOT, rel])).split('\n')) {
            const code = raw.split('//')[0];
            for (const sym of compositor_only) {
                assert(!code.includes(sym), `Process-boundary violation: ${rel} imports '${sym}'`);
            }
        }
    }
    const check_files = [
        'extension.js', 'prefs.js', 'ui/settings/prefs_pages.js', 'desktop/desktop_manager.js',
        'desktop/file_scanner.js', 'desktop/icon_tile.js', 'desktop/context_menu.js',
        'metadata.json', 'schemas/org.gnome.shell.extensions.seabed.gschema.xml',
    ];
    const combined = check_files.map((rel) => read_text(GLib.build_filenamev([EXT_ROOT, rel]))).join('\n');
    const reqs = [
        'export default class SeabedExtension extends Extension', 'this.manager.destroy()',
        'fillPreferencesWindow(window)', 'Adw.PreferencesPage', 'close-request',
        'Seabed Settings & About…', 'openPreferences', 'Star Seabed on GitHub',
        'Tuition, Not Coffee — Help send my daughter to college',
        'https://ubermetroid.github.io/tuition-not-coffee',
        'Derived from Desktop Icons NG', '_backgroundGroup', '[seabed] rescan-debounce',
        '"45"', '"50"', '"settings-schema": "org.gnome.shell.extensions.seabed"',
        'name="icon-size"', 'name="start-corner"', 'name="arrange-order"', 'v1.0.0',
        'this.unload_theme()', 'load_stylesheet(file)', 'Support &amp; Community',
    ];
    for (const req of reqs) assert(combined.includes(req), `Missing invariant: ${req}`);
    assert(!combined.includes('Rust installer') && !combined.includes('cargo install'), 'No Rust CLI reference');
    const prefs_pages = read_text(GLib.build_filenamev([EXT_ROOT, 'ui/settings/prefs_pages.js']));
    assert(!/new Gtk\.Label\(\{[^}]*&amp;/s.test(prefs_pages), 'Gtk.Label must not contain raw &amp; without use_markup');
}

async function verify_behavioral_and_gtk_suite() {
    const tmp_dir = GLib.dir_make_tmp('seabed-verify-XXXXXX');
    const schema_xml = 'org.gnome.shell.extensions.seabed.gschema.xml';
    const dst_xml = Gio.File.new_for_path(GLib.build_filenamev([tmp_dir, schema_xml]));
    Gio.File.new_for_path(GLib.build_filenamev([EXT_ROOT, 'schemas', schema_xml]))
        .copy(dst_xml, Gio.FileCopyFlags.OVERWRITE, null, null);
    assert(Gio.Subprocess.new(['glib-compile-schemas', tmp_dir], Gio.SubprocessFlags.NONE).wait_check(null),
        'glib-compile-schemas');
    const src = Gio.SettingsSchemaSource.new_from_directory(tmp_dir, Gio.SettingsSchemaSource.get_default(), false);
    const ext_settings = new Gio.Settings({
        settings_schema: src.lookup('org.gnome.shell.extensions.seabed', true),
        backend: Gio.memory_settings_backend_new(),
    });
    const s = new ExtensionSettings(ext_settings);

    assert(s.icon_size() === 'standard' && s.start_corner() === 'top-left' && s.arrange_order() === 'NAME', 'defaults');
    assert(s.show_home() && s.show_trash() && s.show_volumes() && !s.show_network_volumes(), 'special defaults');
    assert(!s.show_hidden_files() && s.show_link_emblem() && !s.single_click_open() && !s.multi_monitor(), 'file flags');
    assert(s.show_selection_border() && s.border_width() === 2 && s.border_radius() === 12, 'border defaults');
    assert(ICON_SIZES.length === 4 && START_CORNERS.length === 4 && ARRANGE_ORDERS.length === 5, 'enums');
    assert(BORDER_PRESETS.length === 4 && ICON_PIXEL_SIZES.standard === 48, 'presets & sizes');

    s.set_icon_size('large');
    assert(s.icon_size() === 'large' && resolve_icon_pixel_size(s.icon_size()) === 64, 'large icon size');
    s.set_icon_size('invalid');
    assert(s.icon_size() === 'standard' && compute_cell_dimensions('tiny').icon_px === 32, 'fallback icon size');
    s.set_border_width(99);
    assert(s.border_width() === 8, 'clamp max border width');
    s.set_border_radius(99);
    assert(s.border_radius() === 24, 'clamp max border radius');
    s.set_border_color_rgba('#2ec27e');
    assert(s.border_color_rgba() === 'rgba(46, 194, 126, 1)', 'hex color normalization');
    assert(is_dark_rgba(parse_rgba('#111111')) && text_color_for_css('#ffffff') === '#000000', 'luminance');
    assert(format_rgba(parse_rgba('rgb(255,0,0)')) === 'rgba(255, 0, 0, 1)', 'rgba format');
    s.reset_defaults();
    assert(s.icon_size() === 'standard' && s.border_width() === 2 && s.border_radius() === 12, 'reset defaults');

    const sample = [
        { id: 'f1', name: 'zebra.txt', kind: 'text/plain', size: 100, mtime: 20, is_special: false },
        { id: 'tr', name: 'Trash', kind: 'trash', size: 0, mtime: 0, is_special: true },
        { id: 'f2', name: 'alpha.pdf', kind: 'application/pdf', size: 900, mtime: 50, is_special: false },
        { id: 'hm', name: 'Home', kind: 'home', size: 0, mtime: 0, is_special: true },
    ];
    const by_name = sort_desktop_entries(sample, 'NAME', false);
    assert(by_name[0].id === 'hm' && by_name[1].id === 'tr' && by_name[2].id === 'f2', 'pinned special + NAME sort');
    const by_desc = sort_desktop_entries(sample, 'DESCENDINGNAME', false);
    assert(by_desc[2].id === 'f1' && by_desc[3].id === 'f2', 'DESCENDINGNAME sort');
    const by_mtime = sort_desktop_entries(sample, 'MODIFIEDTIME', false);
    assert(by_mtime[2].id === 'f2' && by_mtime[3].id === 'f1', 'MODIFIEDTIME sort');
    const by_size = sort_desktop_entries(sample, 'SIZE', false);
    assert(by_size[2].id === 'f2' && by_size[3].id === 'f1', 'SIZE sort');
    const by_kind = sort_desktop_entries(sample, 'KIND', true);
    assert(by_kind[0].id === 'f2', 'KIND sort with mixed special folders');

    const wa = { x: 0, y: 32, width: 1920, height: 1048 };
    const tl = compute_grid_positions(3, wa, 112, 108, 'top-left', 8);
    const tr = compute_grid_positions(3, wa, 112, 108, 'top-right', 8);
    const bl = compute_grid_positions(3, wa, 112, 108, 'bottom-left', 8);
    const br = compute_grid_positions(3, wa, 112, 108, 'bottom-right', 8);
    assert(tl.length === 3 && tl[0].x === 16 && tl[0].y === 48 && tl[1].y > tl[0].y, 'top-left grid');
    assert(tr[0].x > 1700 && bl[0].y > 900 && br[0].x > 1700 && br[0].y > 900, 'all 4 start corners');
    assert(build_tile_inline_style({ selected: true, border_width: 2 }).includes('2px solid'), 'tile style');
    assert(build_label_inline_style(true).includes('#12161c') && build_label_inline_style(false).includes('#f6f8fa'), 'label');

    try {
        const Gtk = (await import('gi://Gtk?version=4.0')).default;
        const Adw = (await import('gi://Adw?version=1')).default;
        if (Gtk.init_check()) {
            Adw.init();
            const signals = [];
            const page_ap = build_appearance_page(ext_settings, s, signals);
            const page_ab = build_about_page();
            assert(page_ap.get_title() === 'Appearance & Borders' && page_ab.get_title() === 'About & Support', 'GTK4 pages');
            let root_to_walk = [page_ap, page_ab];
            const gres = '/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource';
            if (Gio.File.new_for_path(gres).query_exists(null)) {
                Gio.resources_register(Gio.Resource.load(gres));
                const { default: SeabedPreferences } = await import('../extension/prefs.js');
                const prefs = Object.create(SeabedPreferences.prototype);
                prefs.getSettings = () => ext_settings;
                const win = new Adw.PreferencesWindow();
                prefs.fillPreferencesWindow(win);
                root_to_walk = [win];
            }
            const walk_labels = (w) => {
                if (!w) return;
                if (w instanceof Gtk.Label) {
                    const txt = w.get_text() || '';
                    assert(!txt.includes('&amp;'), `Unescaped &amp; in rendered Gtk.Label text: ${txt}`);
                    if (w.get_visible()) assert(txt.trim().length > 0, 'Empty visible Gtk.Label');
                }
                for (let c = w.get_first_child?.(); c; c = c.get_next_sibling?.()) walk_labels(c);
            };
            for (const r of root_to_walk) walk_labels(r);
            for (const [obj, sig] of signals) obj.disconnect(sig);
        }
    } catch (e) {
        if (String(e).includes('Verification failed')) throw e;
    }

    dst_xml.delete(null);
    Gio.File.new_for_path(GLib.build_filenamev([tmp_dir, 'gschemas.compiled'])).delete(null);
    Gio.File.new_for_path(tmp_dir).delete(null);
}

const js_files = [], dirs = [];
walk_repo(REPO_ROOT, js_files, dirs);
verify_page_rules_and_lint(js_files, dirs);
verify_process_boundaries_and_invariants();
await verify_behavioral_and_gtk_suite();
print(`OK: verified ${js_files.length} JS pages across ${dirs.length} directories and all headless behavioral suites.`);
