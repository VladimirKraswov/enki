mod agent_plugins;
mod asr;
mod attachments;
pub mod browser;
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
mod local_server;
mod migration;
mod model_credentials;
mod paths;
pub mod pi;
mod pricing;
mod process;
mod sound;
mod storage_info;
mod tray;
mod updates;
mod usage_store;
pub mod workshop;
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
    if let Err(error) = migration::installation_alias() {
        eprintln!("Совместимость старых MCP-команд: {error}");
    }
    if let Err(error) = paths::app_data_dir().and_then(|p| migration::bundled_defaults(&p)) {
        eprintln!("Обновление стандартных инструкций Enki: {error}");
    }
    let hot = hub_updates::assets::HotAssets::load();
    let mut context = tauri::generate_context!();
    let embedded = std::mem::replace(&mut context.assets, Box::new(hub_updates::assets::Empty));
    context.set_assets(Box::new(hub_updates::assets::Provider {
        hot: hot.clone(),
        embedded,
    }));
    tauri::Builder::default()
        .manage(hosts::Hosts::default())
        .manage(pi::PiSessions::default())
        .manage(lifecycle::Lifecycle::default())
        .manage(updates::Updates::default())
        .manage(hub_updates::HubUpdates::default())
        .manage(hot)
        .manage(capabilities::SharedRuntime::default())
        .manage(browser::BrowserRuntime::default())
        .manage(control::AgentControl::default())
        .setup(|app| {
            // Agent Control is optional. A socket that cannot be created (for
            // example a data path beyond the OS socket-name limit) must not stop
            // Desktop from starting; its status then reports it as unavailable.
            if let Err(error) = control::start(app.handle().clone()) {
                eprintln!("Agent Control is unavailable: {error}");
            }
            if let Err(error) = tray::setup(app.handle()) {
                eprintln!("System tray unavailable: {error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            asr::transcribe_audio,
            images::image_settings,
            images::image_asset,
            images::image_probe,
            image_context::image_prompt_context,
            journal::operation_journal,
            lifecycle::own_work,
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
            browser::browser_pi_support,
            hosts::ssh_aliases,
            hosts::prepare_chat_workspace,
            workshop::workshop_prepare,
            hosts::connect_ssh,
            local_server::ensure_local_opencode,
            local_server::restart_local_opencode,
            local_server::detect_local_opencode,
            config::read_opencode_config,
            config::write_opencode_config,
            config::read_pi_models,
            config::write_pi_models,
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
            pi::pi_detect,
            pi::pi_open,
            pi::pi_request,
            pi::pi_post,
            pi::pi_close,
            pi::pi_sessions,
            storage_info::session_storage,
            pricing::fetch_price_book,
            pricing::fetch_usd_rate,
            usage_store::read_usage_file,
            usage_store::write_usage_file,
            pi::pi_live_sessions,
            pi::pi_resume_sessions,
            pi::pi_shared_inventory,
            pi::pi_setup_lsp,
            pi::pi_probe_directory,
            pi::pi_prepare_chat_workspace
        ])
        .plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(include_str!("../updater.pub").trim())
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
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
                use tauri::Manager;
                if let Ok(mut tunnels) = app.state::<hosts::Hosts>().0.lock() {
                    tunnels.clear();
                }
                // Only explicit runtime exit stops agents; hiding stays alive.
                app.state::<hub_updates::HubUpdates>().build.cancel();
                capabilities::shutdown(app.state::<capabilities::SharedRuntime>().inner());
                pi::shutdown(app);
                browser::shutdown(app);
                control::shutdown(app);
            }
        });
}
