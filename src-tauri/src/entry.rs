//! Shared CLI dispatcher for Enki and the legacy MCP executable alias.
pub fn run_cli() {
    if std::env::args().nth(1).as_deref() == Some("--image-state-lock") {
        if let Err(error) = crate::image_context::state_lock_cli() {
            eprintln!("{error}");
            std::process::exit(1);
        }
    } else if std::env::args().nth(1).as_deref() == Some("--workshop-prepare") {
        if let Err(e) = crate::workshop::cli() {
            eprintln!("{e}");
            std::process::exit(1);
        }
    } else if std::env::args().nth(1).as_deref() == Some("--hub-release") {
        if let Err(e) = crate::hub::device_publish::cli() {
            eprintln!("{e}");
            std::process::exit(1);
        }
    } else if std::env::args().nth(1).as_deref() == Some("--hub-update-status") {
        if let Err(e) = crate::hub_updates::cli_status() {
            eprintln!("{e}");
            std::process::exit(1);
        }
    } else if std::env::args().nth(1).as_deref() == Some("--apply-update") {
        if let Err(e) = crate::hub_updates::install::cli() {
            eprintln!("{e}");
            std::process::exit(1);
        }
    } else if matches!(
        std::env::args().nth(1).as_deref(),
        Some("--hub-setup" | "--hub-status")
    ) {
        if let Err(error) = crate::hub::cli() {
            eprintln!("{error}");
            std::process::exit(1);
        }
    } else if std::env::args().nth(1).as_deref() == Some("--computer-mcp") {
        if let Err(error) = crate::computer::mcp_main() {
            eprintln!("{error}");
            std::process::exit(1);
        }
    } else if std::env::args().nth(1).as_deref() == Some("--agent-mcp")
        || std::env::args().nth(1).as_deref() == Some("--schedule-mcp")
    {
        if let Err(error) = crate::control::mcp_main() {
            eprintln!("{error}");
            std::process::exit(1);
        }
    } else if std::env::args().nth(1).as_deref() == Some("--browser-mcp") {
        if let Err(error) = crate::browser::mcp_main() {
            eprintln!("{error}");
            std::process::exit(1);
        }
    } else if std::env::args().nth(1).as_deref() == Some("--memory-mcp") {
        if let Err(error) = crate::hub::retrieval::mcp_main() {
            eprintln!("{error}");
            std::process::exit(1);
        }
    } else if std::env::args().nth(1).as_deref() == Some("--project-map-mcp") {
        if let Err(error) = crate::capabilities::project_map::mcp_main() {
            eprintln!("{error}");
            std::process::exit(1);
        }
    } else if std::env::args().nth(1).as_deref() == Some("--shared-mcp") {
        if let Err(error) = crate::capabilities::mcp_main() {
            eprintln!("{error}");
            std::process::exit(1);
        }
    } else {
        crate::run()
    }
}
