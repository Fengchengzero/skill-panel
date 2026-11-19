mod apply;
mod backup;
mod commands;
mod deploy;
mod grsai;
mod install;
mod library;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_always_on_top(true);
        let _ = window.set_focus();
    }
}

fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_main_window(app);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let _ = library::ensure_library();

            #[cfg(desktop)]
            {
                #[cfg(target_os = "macos")]
                let toggle_mods = Modifiers::SUPER | Modifiers::SHIFT;
                #[cfg(not(target_os = "macos"))]
                let toggle_mods = Modifiers::CONTROL | Modifiers::SHIFT;

                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, shortcut, event| {
                            if event.state != ShortcutState::Pressed {
                                return;
                            }
                            let expected = Shortcut::new(Some(toggle_mods), Code::KeyS);
                            if shortcut == &expected {
                                toggle_main_window(app);
                            }
                        })
                        .build(),
                )?;

                let shortcut = Shortcut::new(Some(toggle_mods), Code::KeyS);
                if let Err(err) = app.global_shortcut().register(shortcut) {
                    // Another instance / app may already own Ctrl/Cmd+Shift+S — still boot.
                    eprintln!("全局快捷键注册失败（可忽略，仍可用托盘打开）: {err}");
                }
            }

            let show_i = MenuItem::with_id(app, "show", "Show Panel", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            if let Some(icon) = app.default_window_icon().cloned() {
                let _tray = TrayIconBuilder::new()
                    .icon(icon)
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => show_main_window(app),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            toggle_main_window(tray.app_handle());
                        }
                    })
                    .build(app)?;
            } else {
                eprintln!("tray icon skipped: default window icon missing");
            }

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_always_on_top(true);
            }

            // Note: blur-to-hide is disabled for now — native file dialogs steal
            // focus and would immediately hide the panel. Use tray / hotkey /
            // Escape (frontend) to dismiss instead.

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_paths,
            commands::list_skills,
            commands::list_tags,
            commands::list_folders,
            commands::create_folder,
            commands::rename_folder,
            commands::delete_folder,
            commands::set_skill_folder,
            commands::set_skill_description_zh,
            commands::set_skill_cover,
            commands::clear_skill_cover,
            commands::pick_and_set_skill_cover,
            commands::set_skill_tags,
            commands::set_skill_display_name,
            commands::read_skill_markdown,
            commands::write_skill_markdown,
            commands::toggle_pin,
            commands::get_meta,
            commands::save_meta,
            commands::apply_skill,
            commands::list_nested_skills,
            commands::install_nested_skills,
            commands::install_local,
            commands::pick_and_install_local,
            commands::install_git,
            commands::install_skillssh,
            commands::cancel_install,
            commands::delete_skill,
            commands::check_skill_updates,
            commands::update_skill,
            commands::update_skills,
            commands::backfill_skill_sources,
            commands::open_library_folder,
            commands::get_ai_settings,
            commands::save_ai_settings,
            commands::reset_ai_prompts,
            commands::test_ai_connection,
            commands::cancel_ai,
            commands::clear_ai_cancel,
            commands::generate_skill_description,
            commands::generate_skill_cover,
            commands::recompress_covers,
            commands::export_library,
            commands::import_library,
        ])
        .run(tauri::generate_context!())
        .expect("error while running skill-panel");
}
