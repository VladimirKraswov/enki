mod asr;
mod attachments;
pub mod browser;
mod build_job;
pub mod capabilities;
pub mod computer;
mod config;
pub mod control;
pub mod entry;
mod hosts;
pub mod hub;
pub mod hub_updates;
mod image_context;
mod images;
mod journal;
mod lifecycle;
mod lsp;
mod migration;
mod model_credentials;
mod paths;
mod pricing;
mod process;
pub mod runtime;
mod runtime_ui;
mod sound;
mod storage_info;
mod tray;
mod updates;
mod usage_store;
mod webview_profile;
pub mod workshop;
use tauri::Manager;
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Still single-threaded: the GUI never needs publisher credentials
    // (publishing is the separate scripts/releases tooling), so an owner shell
    // that exported them cannot hand them to the runtime, model-driven tools,
    // MCP servers, browser or source builds this process spawns.
    for key in hub_updates::PUBLISHER_SECRET_ENV {
        std::env::remove_var(key);
    }
    let profile = paths::profile_override().expect("Некорректный отдельный профиль Enki");
    if profile.is_none() {
        paths::app_data_parent()
            .and_then(|p| migration::initialize(&p))
            .expect("Не удалось безопасно перенести данные Enki");
        #[cfg(windows)]
        migration::initialize_named(
            &paths::user_home().expect("USERPROFILE"),
            ".opencode-desktop",
            ".enki",
        )
        .expect("Не удалось перенести профиль браузера Enki");
        if let Err(error) = paths::app_data_dir().and_then(|p| migration::bundled_defaults(&p)) {
            eprintln!("Обновление стандартных инструкций Enki: {error}");
        }
    }
    let hot = hub_updates::assets::HotAssets::load();
    let mut context = tauri::generate_context!();
    let mut profile_windows = Vec::new();
    let mut webview_profile = None;
    if let Some(profile) = &profile {
        use sha2::{Digest, Sha256};
        let hash = Sha256::digest(profile.to_string_lossy().as_bytes());
        webview_profile = Some(
            webview_profile::WebviewProfile::new(profile.clone())
                .expect("Не удалось изолировать WebView тестового профиля"),
        );
        profile_windows =
            webview_profile::WebviewProfile::defer_windows(&mut context.config_mut().app.windows);
        // Also isolate OS/application identity-dependent caches of test profiles.
        context.config_mut().identifier = format!(
            "dev.enki.profile.{}",
            hash[..8]
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
    }

    let embedded = std::mem::replace(&mut context.assets, Box::new(hub_updates::assets::Empty));
    context.set_assets(Box::new(hub_updates::assets::Provider {
        hot: hot.clone(),
        embedded,
    }));
    tauri::Builder::default()
        .manage(hosts::Hosts::default())
        .manage(runtime::RuntimeSupervisor::default())
        .manage(runtime_ui::UiAuthority::default())
        .manage(lifecycle::Lifecycle::default())
        .manage(updates::Updates::default())
        .manage(hub_updates::HubUpdates::default())
        .manage(hot)
        .manage(capabilities::SharedRuntime::default())
        .manage(browser::BrowserRuntime::default())
        .manage(control::AgentControl::default())
        .setup(move |app| {
            if let Some(profile) = &webview_profile {
                for window in &profile_windows {
                    profile
                        .apply(tauri::WebviewWindowBuilder::from_config(app, window)?)
                        .build()?;
                }
            }
            // Agent Control is optional. A socket that cannot be created (for
            // example a data path beyond the OS socket-name limit) must not stop
            // Desktop from starting; its status then reports it as unavailable.
            if let Err(error) = control::start(app.handle().clone()) {
                eprintln!("Agent Control is unavailable: {error}");
            }
            if let Err(error) = tray::setup(app.handle()) {
                eprintln!("System tray unavailable: {error}");
            }
            // The agent runtime is started here, by the native process, so
            // durable queues and schedules resume even before (and
            // independently of) the WebView. A failure is surfaced through
            // `runtime_status`; the UI retries via `runtime_connection`.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let supervisor = handle.state::<runtime::RuntimeSupervisor>().inner().clone();
                if let Err(error) = supervisor.ensure(&handle) {
                    eprintln!("Enki Runtime: {error}");
                }
            });
            runtime::start_rotation(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            asr::transcribe_audio,
            images::image_settings,
            images::image_asset,
            images::image_archive_save,
            images::image_probe,
            image_context::image_prompt_context,
            journal::operation_journal,
            lifecycle::quit_report,
            updates::app_update,
            hub_updates::hub_update,
            tray::runtime_quit_ready,
            attachments::stage_archive,
            attachments::archive_access,
            hub::hub_config,
            hub::hub_request,
            hub::hub_model_catalog,
            hub::retrieval::memory_retrieval,
            hub::hub_package,
            hub::hub_spool,
            model_credentials::model_service_key,
            browser::browser_status,
            browser::browser_install,
            browser::browser_start,
            browser::browser_open,
            browser::browser_view,
            browser::browser_presence,
            browser::browser_session,
            browser::browser_input,
            browser::monitor::browser_monitor,
            browser::monitor::browser_monitor_frame,
            browser::browser_stop,
            hosts::ssh_aliases,
            hosts::prepare_chat_workspace,
            hosts::connect_remote_runtime,
            workshop::workshop_prepare,
            runtime::runtime_connection,
            runtime::runtime_status,
            runtime::runtime_restart,
            runtime::runtime_broker_relay,
            runtime_ui::runtime_ui_authorize,
            lsp::runtime_setup_lsp,
            capabilities::shared_catalog,
            capabilities::quality::skill_quality,
            capabilities::project_map::project_map_preview,
            capabilities::shared_save,
            capabilities::shared_install,
            capabilities::shared_probe,
            capabilities::shared_mcp_key,
            sound::completion_chime,
            computer::computer_status,
            computer::computer_set_enabled,
            computer::computer_action,
            control::agent_control_ready,
            control::agent_control_complete,
            control::agent_control_status,
            storage_info::session_storage,
            pricing::fetch_price_book,
            pricing::fetch_usd_rate,
            usage_store::read_usage_file,
            usage_store::write_usage_file
        ])
        .plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(include_str!("../updater.pub").trim())
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } = &event
            {
                if label == "main" {
                    // Hiding never stops the runtime or its work.
                    api.prevent_close();
                    tray::close(app);
                }
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = &event {
                tray::show(app);
            }
            if let tauri::RunEvent::ExitRequested { api, code, .. } = &event {
                if code.is_none() {
                    api.prevent_exit();
                    tray::close(app);
                } else if *code != Some(tauri::RESTART_EXIT_CODE) && lifecycle::request_exit(app) {
                    api.prevent_exit();
                }
            }
            if let tauri::RunEvent::Exit = event {
                if let Ok(mut tunnels) = app.state::<hosts::Hosts>().0.lock() {
                    tunnels.clear();
                }
                // Only explicit exit stops agents; hiding stays alive. After a
                // Quit the runtime has already drained, so this is a no-op;
                // an updater restart (already verified idle) stops it here.
                app.state::<hub_updates::HubUpdates>().build.cancel();
                capabilities::shutdown(app.state::<capabilities::SharedRuntime>().inner());
                app.state::<runtime::RuntimeSupervisor>()
                    .inner()
                    .shutdown(std::time::Duration::from_secs(5));
                browser::shutdown(app);
                control::shutdown(app);
            }
        });
}
