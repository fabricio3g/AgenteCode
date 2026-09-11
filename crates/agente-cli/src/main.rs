use clap::Parser;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use agente_core::config::AppConfig;
use agente_tui::App;

/// tracing MakeWriter over a single open file handle. The registry clones the
/// `Arc` per record (cheap) instead of duplicating the fd per log line.
#[derive(Clone)]
struct LogFile(std::sync::Arc<std::fs::File>);

impl std::io::Write for LogFile {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        (&*self.0).write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        (&*self.0).flush()
    }
}

#[derive(Parser)]
#[command(name = "agente")]
#[command(about = "Agente — terminal-native AI coding agent")]
struct Cli {
    #[arg()]
    prompt: Option<String>,

    #[arg(short, long, default_value = ".")]
    project_dir: String,

    #[arg(short, long)]
    no_tui: bool,

    #[arg(long)]
    api_base: Option<String>,

    #[arg(long)]
    api_key: Option<String>,

    #[arg(long)]
    planner_model: Option<String>,

    #[arg(long)]
    executor_model: Option<String>,

    #[arg(long)]
    config: Option<String>,

    #[arg(long, help = "Launch browser-based TUI visual studio & inspector")]
    inspect: bool,

    #[arg(long, default_value_t = 4040, help = "Port for browser inspector")]
    inspect_port: u16,

    #[arg(long, help = "Serve the Agent Client Protocol over stdio")]
    acp_stdio: bool,

    #[arg(
        long,
        help = "Headless only: require approval prompts instead of auto-approving tools"
    )]
    no_auto_approve: bool,
}

fn main() -> anyhow::Result<()> {
    // Set up panic hook that logs to file
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = if let Some(s) = info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "Unknown panic".to_string()
        };
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_default();
        let log_msg = format!("PANIC at {location}: {msg}\n");
        eprintln!("{log_msg}");
        if let Some(cache) = dirs::cache_dir() {
            let dir = cache.join("agente");
            let _ = std::fs::create_dir_all(&dir);
            // Append so a new panic does not erase the previous crash record.
            let _ = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("panic.log"))
                .and_then(|mut file| std::io::Write::write_all(&mut file, log_msg.as_bytes()));
        }
        default_hook(info);
    }));

    // Parse first: `--help`/`--version` exit before any cache dirs or log
    // files are created.
    let cli = Cli::parse();

    // Set up tracing to log to file instead of stdout (which interferes with TUI)
    let log_file = if let Some(cache) = dirs::cache_dir() {
        let dir = cache.join("agente");
        let _ = std::fs::create_dir_all(&dir);
        Some(dir.join("agente.log"))
    } else {
        None
    };

    if let Some(log_path) = log_file {
        match std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            Ok(file) => {
                let file = std::sync::Arc::new(file);
                tracing_subscriber::registry()
                    .with(
                        tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(
                            |_| "agente=info,agente_core=info,agente_tui=info".into(),
                        ),
                    )
                    .with(
                        tracing_subscriber::fmt::layer()
                            .with_writer(move || LogFile(std::sync::Arc::clone(&file)))
                            .compact(),
                    )
                    .init();
            }
            Err(error) => {
                eprintln!(
                    "warning: could not open log file {}: {error}; logging disabled",
                    log_path.display()
                );
                tracing_subscriber::registry()
                    .with(tracing_subscriber::EnvFilter::new("off"))
                    .init();
            }
        }
    } else {
        // Fallback: disable tracing if we can't create log file
        tracing_subscriber::registry()
            .with(tracing_subscriber::EnvFilter::new("off"))
            .init();
    }

    let project_dir =
        agente_core::util::normalize_project_dir(std::fs::canonicalize(&cli.project_dir)?);

    let mut config = if let Some(config_path) = &cli.config {
        let content = std::fs::read_to_string(config_path)?;
        serde_json::from_str::<AppConfig>(&content)?
    } else {
        AppConfig::load(&project_dir)
    };

    // Apply CLI overrides
    if let Some(api_base) = cli.api_base {
        if config.provider.contains_key("custom") {
            config.default_provider = Some("custom".to_string());
            if let Some(provider) = config.provider.get_mut("custom") {
                provider.api = Some(api_base);
            }
        } else {
            eprintln!(
                "warning: --api-base ignored: no \"custom\" provider exists in the config; \
                 add one to agente.json first"
            );
        }
    }

    if let Some(planner) = cli.planner_model {
        config.planner_model = Some(planner);
    }
    if let Some(executor) = cli.executor_model {
        config.executor_model = Some(executor);
    }

    if let Some(ref api_key) = cli.api_key {
        let provider = config.default_provider.as_deref().unwrap_or("openai");
        config.auth_store.set_key(provider, api_key.clone());
    }

    if cli.inspect {
        let runtime = tokio::runtime::Runtime::new()?;
        let server = std::sync::Arc::new(agente_tui::web_inspector::InspectorServer::new());
        runtime.block_on(server.run(cli.inspect_port))?;
        return Ok(());
    }

    if cli.acp_stdio {
        run_acp_stdio(&project_dir, config)?;
        return Ok(());
    }

    if cli.no_tui {
        // Run in non-interactive mode
        run_non_interactive(&project_dir, cli.prompt, config, !cli.no_auto_approve)?;
    } else {
        // Run TUI
        let runtime = tokio::runtime::Runtime::new()?;
        let mut app = App::new(config, project_dir, runtime)?;
        app.run()?;
    }

    Ok(())
}

fn run_non_interactive(
    project_dir: &str,
    prompt: Option<String>,
    config: AppConfig,
    auto_approve: bool,
) -> anyhow::Result<()> {
    use std::io::{self, Write};

    use agente_protocol::{Message, RuntimeEvent, SessionId, StartTurn, TurnStatus};
    use agente_runtime::{RuntimeConfig, RuntimeSupervisor};

    let user_prompt = match prompt {
        Some(prompt) => prompt,
        None => {
            print!("Enter your task: ");
            io::stdout().flush()?;
            let mut input = String::new();
            io::stdin().read_line(&mut input)?;
            input.trim().to_string()
        }
    };

    if user_prompt.is_empty() {
        println!("No prompt provided, exiting.");
        return Ok(());
    }

    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(async move {
        let runtime_config = RuntimeConfig::from_app_config(&config, project_dir);
        if auto_approve {
            eprintln!(
                "warning: headless auto-approve is ON — shell commands and file writes run \
                 without approval prompts; pass --no-auto-approve to disable"
            );
            if let Ok(mut engine) = runtime_config.permission_engine.write() {
                engine.set_auto_approve(true);
            }
        }
        let runtime_handle = RuntimeSupervisor::start(runtime_config);
        let session_id = SessionId::new();
        let mut turn = runtime_handle.start_turn(StartTurn {
            session_id,
            conversation: vec![Message::user(user_prompt)],
            provider: None,
            model: None,
            thinking_level: None,
        })?;

        let mut final_text = String::new();
        while let Some(envelope) = turn.recv().await {
            match envelope.event {
                RuntimeEvent::AssistantDelta { text } => final_text.push_str(&text),
                RuntimeEvent::AssistantMessage { text } => final_text = text,
                // Errors surface once through the turn outcome below; the event
                // only ends the stream.
                RuntimeEvent::TurnFailed { .. } => {}
                event if event.is_terminal() => break,
                _ => {}
            }
        }

        if let Some(outcome) = turn.outcome().await {
            if matches!(outcome.status, TurnStatus::Failed) {
                if let Some(error) = outcome.error {
                    eprintln!("Error: {}", agente_core::util::redact_secrets(&error));
                }
            }
        }
        println!("\n{}", final_text.trim());
        Ok::<(), anyhow::Error>(())
    })
}

fn run_acp_stdio(project_dir: &str, config: AppConfig) -> anyhow::Result<()> {
    use agente_runtime::{RuntimeConfig, RuntimeSupervisor};

    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(async move {
        // ACP sessions have identity across editor restarts (`loadSession`),
        // so this path persists snapshots under the project's .agente/sessions.
        let runtime_config = RuntimeConfig::from_app_config(&config, project_dir)
            .with_default_persistence()
            .map_err(|error| anyhow::anyhow!("session persistence unavailable: {error}"))?;
        let handle = RuntimeSupervisor::start(runtime_config);
        agente_acp::serve_stdio(handle).await?;
        Ok::<(), anyhow::Error>(())
    })
}
