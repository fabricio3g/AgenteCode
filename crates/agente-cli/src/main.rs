use clap::{Parser, Subcommand};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use agente_core::config::AppConfig;
use agente_tui::App;

mod attach;
mod bridge_cli;
mod logging;
mod mcp_bridge;

#[derive(Parser)]
#[command(name = "agente", version)]
#[command(about = "Agente — terminal-native AI coding agent")]
#[command(subcommand_precedence_over_arg = true)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    #[arg()]
    prompt: Option<String>,

    #[arg(short, long, default_value = ".", global = true)]
    project_dir: String,

    #[arg(short, long)]
    no_tui: bool,

    #[arg(long)]
    api_base: Option<String>,

    #[arg(long)]
    api_key: Option<String>,

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
        short,
        long,
        value_name = "SESSION_ID",
        num_args = 0..=1,
        default_missing_value = "",
        help = "Resume a saved session by id (or a unique prefix); bare --resume opens the picker"
    )]
    resume: Option<String>,

    #[arg(
        long,
        help = "Headless only: require approval prompts instead of auto-approving tools"
    )]
    no_auto_approve: bool,
}

#[derive(Subcommand)]
enum Command {
    /// Serve the runtime on a local socket, for Agente Desktop and other
    /// clients. Sessions are kept in ~/.agente/store.
    Serve {
        /// Socket path (default: $XDG_RUNTIME_DIR/agente/agente.sock)
        #[arg(long)]
        socket: Option<std::path::PathBuf>,
        /// Only report whether a daemon is serving, then exit.
        #[arg(long)]
        status: bool,
        /// Also accept remote clients on this address (for example
        /// 127.0.0.1:7420, or 0.0.0.0:7420 in a container). Clients must
        /// send the token with `initialize`. Not encrypted: use a tunnel or
        /// a TLS proxy across networks.
        #[arg(long, value_name = "ADDR")]
        listen: Option<std::net::SocketAddr>,
        /// Token remote clients must present (default: ~/.agente/serve-token,
        /// created on first use).
        #[arg(long, env = "AGENTE_TOKEN", hide_env_values = true)]
        token: Option<String>,
    },
    /// Your real browser and your Google Docs/Sheets/Drive as agent tools.
    /// Bare `agente bridge` is the MCP server a session spawns; run
    /// `agente bridge install` once to register it.
    Bridge {
        #[command(subcommand)]
        action: Option<bridge_cli::BridgeAction>,
    },
    /// Join a live session on a running `agente serve`:
    /// its turns stream here and what you type is sent to it.
    Attach {
        /// A session id (or a unique prefix). Without
        /// one, the most recent session.
        target: Option<String>,
        /// Open a fresh session on the daemon instead of resuming an existing one.
        #[arg(long)]
        new: bool,
        /// Driver instance id for a new session (`agente`, `claude`, `codex`, ...).
        #[arg(long)]
        driver: Option<String>,
        /// Provision an isolated Git worktree for a new session.
        #[arg(long)]
        worktree: bool,
        /// Socket path of a local `agente serve`.
        #[arg(long, conflicts_with = "remote")]
        socket: Option<std::path::PathBuf>,
        /// host:port of a remote `agente serve --listen`.
        #[arg(long, value_name = "HOST:PORT")]
        remote: Option<String>,
        /// Token of the remote server.
        #[arg(long, env = "AGENTE_TOKEN", hide_env_values = true)]
        token: Option<String>,
    },
    /// Run a single prompt through `agente serve` using any configured driver.
    Run {
        /// Prompt to run.
        prompt: String,
        /// Driver instance id (`agente`, `claude`, `codex`, ...).
        #[arg(long)]
        driver: Option<String>,
        /// Provision an isolated Git worktree for this session.
        #[arg(long)]
        worktree: bool,
        /// Permission mode (`plan`, `build`, `auto`).
        #[arg(long)]
        mode: Option<String>,
        /// Optional model override for the target driver.
        #[arg(long)]
        model: Option<String>,
        /// Socket path of a local `agente serve`.
        #[arg(long, conflicts_with = "remote")]
        socket: Option<std::path::PathBuf>,
        /// host:port of a remote `agente serve --listen`.
        #[arg(long, value_name = "HOST:PORT")]
        remote: Option<String>,
        /// Token of the remote server.
        #[arg(long, env = "AGENTE_TOKEN", hide_env_values = true)]
        token: Option<String>,
    },
    /// Bridge stdio MCP JSON-RPC frames to an HTTP MCP server (internal adapter).
    McpBridge {
        /// Streamable HTTP MCP URL to forward frames to.
        #[arg(long)]
        url: String,
        /// Environment variable carrying the Bearer token.
        #[arg(long, default_value = "AGENTE_MCP_BEARER_TOKEN")]
        token_env: String,
    },
}

fn main() -> anyhow::Result<()> {
    // `agente __sandbox …`: the bot sandbox's helper (agente_core::sandbox).
    // It locks itself down and execs the command, before anything else here
    // runs: no runtime, no logging, no config.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some(agente_core::sandbox::HELPER_ARG) {
        agente_core::sandbox::helper_main(&args[2..]);
    }

    // Set up panic hook that restores the terminal first, then logs to file
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        agente_tui::restore_terminal_best_effort();
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

    // Subcommands and modes that do not need project config, canonicalization,
    // or a new diagnostic log file run immediately.
    if cli.inspect {
        let runtime = tokio::runtime::Runtime::new()?;
        let server = std::sync::Arc::new(agente_tui::web_inspector::InspectorServer::new());
        runtime.block_on(server.run(cli.inspect_port))?;
        return Ok(());
    }

    if let Some(Command::Bridge { action }) = cli.command {
        return bridge_cli::run(action);
    }

    if let Some(Command::McpBridge { url, token_env }) = cli.command {
        return mcp_bridge::run(url, token_env);
    }

    if let Some(Command::Attach {
        target,
        new,
        driver,
        worktree,
        socket,
        remote,
        token,
    }) = cli.command
    {
        let project_dir = agente_core::util::normalize_project_dir(
            std::fs::canonicalize(&cli.project_dir)
                .unwrap_or_else(|_| std::path::PathBuf::from(&cli.project_dir)),
        );
        return attach::run(attach::AttachOptions {
            target,
            create_new: new,
            driver,
            worktree,
            project_dir,
            server: attach::ServerOptions {
                socket,
                remote,
                token,
            },
        });
    }

    if let Some(Command::Run {
        prompt,
        driver,
        worktree,
        mode,
        model,
        socket,
        remote,
        token,
    }) = cli.command
    {
        let project_dir =
            agente_core::util::normalize_project_dir(std::fs::canonicalize(&cli.project_dir)?);
        return attach::run_oneshot(attach::RunOptions {
            prompt,
            driver,
            worktree,
            mode,
            model,
            project_dir,
            server: attach::ServerOptions {
                socket,
                remote,
                token,
            },
        });
    }

    if let Some(Command::Serve {
        socket,
        status: true,
        ..
    }) = cli.command
    {
        return run_serve_status(socket);
    }

    init_logging();

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

    if let Some(executor) = cli.executor_model {
        config.executor_model = Some(executor);
    }

    if let Some(ref api_key) = cli.api_key {
        let provider = config.default_provider.as_deref().unwrap_or("deepseek");
        config.auth_store.set_key(provider, api_key.clone());
    }

    if let Some(Command::Serve {
        socket,
        status: _,
        listen,
        token,
    }) = cli.command
    {
        let options = ServeOptions {
            socket,
            listen,
            token,
        };
        return run_serve(&project_dir, config, options);
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
        if let Some(query) = cli.resume.as_deref() {
            if let Err(error) = app.resume_session(query) {
                // Leave the alternate screen before reporting.
                drop(app);
                eprintln!("agente: {error}");
                std::process::exit(2);
            }
        }
        let ran = app.run();
        agente_core::tools::processes::stop_all();
        ran?;
        // The terminal is restored by now: say how to come back.
        if let Some(hint) = app.resume_hint() {
            println!("\n{hint}\n");
        }
    }

    Ok(())
}

fn init_logging() {
    // Set up tracing to log to file instead of stdout (which interferes with TUI)
    let log_dir = if let Some(cache) = dirs::cache_dir() {
        let dir = cache.join("agente");
        let _ = std::fs::create_dir_all(&dir);
        Some(dir)
    } else {
        None
    };

    if let Some(log_dir) = log_dir {
        match logging::LogFile::open(&log_dir) {
            Ok((writer, log_path)) => {
                tracing_subscriber::registry()
                    .with(
                        tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(
                            |_| "agente=info,agente_core=info,agente_tui=info".into(),
                        ),
                    )
                    .with(
                        tracing_subscriber::fmt::layer()
                            .with_writer(move || writer.clone())
                            .with_thread_names(true)
                            .with_ansi(false)
                            .compact(),
                    )
                    .init();
                tracing::info!(path = %log_path.display(), "Agent diagnostics started");
            }
            Err(error) => {
                eprintln!(
                    "warning: could not open log file {}: {error}; logging disabled",
                    log_dir.display()
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
}

struct ServeOptions {
    socket: Option<std::path::PathBuf>,
    listen: Option<std::net::SocketAddr>,
    token: Option<String>,
}

fn run_serve_status(socket: Option<std::path::PathBuf>) -> anyhow::Result<()> {
    let socket = socket.unwrap_or_else(agente_daemon::default_socket_path);
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(async move {
        let serving = agente_daemon::is_serving(&socket).await;
        println!(
            "{} {}",
            if serving {
                "serving on"
            } else {
                "not serving on"
            },
            socket.display()
        );
        std::process::exit(if serving { 0 } else { 1 });
    })
}

/// Ctrl-C, or SIGTERM (how `docker stop` and service managers ask).
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut term) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

fn run_serve(project_dir: &str, config: AppConfig, options: ServeOptions) -> anyhow::Result<()> {
    use agente_daemon::orchestrator::{OrchestratorConfig, OrchestratorServer};
    use agente_runtime::{OrchestratorProvider, RuntimeConfig, RuntimeSupervisor};
    use std::sync::Arc;

    let ServeOptions {
        socket,
        listen,
        token,
    } = options;
    let socket = socket.unwrap_or_else(agente_daemon::default_socket_path);
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(async move {
        if agente_daemon::is_serving(&socket).await {
            anyhow::bail!("agente is already serving on {}", socket.display());
        }
        let orchestrator = OrchestratorServer::start(OrchestratorConfig::default()).await?;
        let runtime_config = RuntimeConfig::from_app_config(&config, project_dir)
            .with_user_store()
            .map_err(|error| anyhow::anyhow!("session store unavailable: {error}"))?
            .with_orchestrator(Arc::clone(&orchestrator) as Arc<dyn OrchestratorProvider>);
        if let Some(store) = runtime_config.session_store.as_ref() {
            let report = agente_runtime::import::import_legacy_sessions(store);
            if report.imported > 0 || report.failed > 0 {
                tracing::info!(?report, "imported TUI sessions into the store");
            }
        }
        let runtime = RuntimeSupervisor::start(runtime_config);
        orchestrator.attach_runtime(runtime.clone());
        let service = agente_daemon::Service::with_orchestrator(runtime, orchestrator);
        // One signal stops every listener.
        let (stop, stopped) = tokio::sync::watch::channel(false);
        let stop = std::sync::Arc::new(stop);
        let on_signal = std::sync::Arc::clone(&stop);
        tokio::spawn(async move {
            shutdown_signal().await;
            let _ = on_signal.send(true);
        });
        let until_stopped = |mut stopped: tokio::sync::watch::Receiver<bool>| async move {
            let _ = stopped.wait_for(|stop| *stop).await;
        };
        let remote = match listen {
            Some(addr) => {
                let token = match token.filter(|token| !token.trim().is_empty()) {
                    Some(token) => token,
                    None => {
                        let path = agente_daemon::default_token_path();
                        let token =
                            agente_daemon::load_or_create_token(&path).map_err(|error| {
                                anyhow::anyhow!("token file {}: {error}", path.display())
                            })?;
                        eprintln!("remote clients: use the token in {}", path.display());
                        token
                    }
                };
                eprintln!("agente serving remote clients on {addr}");
                let service = service.clone();
                let stopped = until_stopped(stopped.clone());
                Some(tokio::spawn(async move {
                    agente_daemon::serve_tcp(service, addr, token, stopped).await
                }))
            }
            None => None,
        };
        eprintln!("agente serving on {}", socket.display());
        let served = agente_daemon::serve_local(service, &socket, until_stopped(stopped)).await;
        // The local socket failing (in use, path too long…) stops everything.
        let _ = stop.send(true);
        let remote_served = match remote {
            Some(task) => task.await.unwrap_or(Ok(())),
            None => Ok(()),
        };
        // Dev servers and watchers started in the background end with us.
        agente_core::tools::processes::stop_all();
        served?;
        remote_served?;
        Ok::<(), anyhow::Error>(())
    })
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
        }
        // Auto-approve applies to build turns; a plan turn is read-only anyway.
        let mode = (auto_approve && runtime_config.mode == agente_core::types::AgentMode::Build)
            .then_some(agente_protocol::TurnMode::Auto);
        let runtime_handle = RuntimeSupervisor::start(runtime_config);
        let session_id = SessionId::new();
        let mut turn = runtime_handle.start_turn(StartTurn {
            session_id,
            conversation: vec![Message::user(user_prompt)],
            mode,
            ..StartTurn::default()
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
                let error = outcome.error.unwrap_or_else(|| "Agent turn failed".into());
                anyhow::bail!("{}", agente_core::util::redact_secrets(&error));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_rejects_removed_planner_model_flag() {
        assert!(Cli::try_parse_from(["agente", "--planner-model", "foo"]).is_err());
    }

    #[test]
    fn cli_parses_fast_path_subcommands_and_inspect() {
        let cli = Cli::try_parse_from(["agente", "serve", "--status"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Serve { status: true, .. })
        ));
        let cli = Cli::try_parse_from(["agente", "--inspect"]).unwrap();
        assert!(cli.inspect);
    }

    #[test]
    fn cli_parses_mcp_bridge_run_and_driver_attach_flags() {
        let bridge = Cli::try_parse_from([
            "agente",
            "mcp-bridge",
            "--url",
            "http://127.0.0.1:41234/mcp",
            "--token-env",
            "CUSTOM_TOKEN",
        ])
        .unwrap();
        assert!(matches!(
            bridge.command,
            Some(Command::McpBridge { ref url, ref token_env })
                if url == "http://127.0.0.1:41234/mcp" && token_env == "CUSTOM_TOKEN"
        ));

        let run = Cli::try_parse_from([
            "agente",
            "run",
            "--driver",
            "codex",
            "--worktree",
            "--mode",
            "build",
            "fix tests",
        ])
        .unwrap();
        assert!(matches!(
            run.command,
            Some(Command::Run {
                ref prompt,
                driver: Some(ref d),
                worktree: true,
                mode: Some(ref m),
                ..
            }) if prompt == "fix tests" && d == "codex" && m == "build"
        ));

        let attach = Cli::try_parse_from([
            "agente",
            "attach",
            "--new",
            "--driver",
            "claude",
            "--worktree",
        ])
        .unwrap();
        assert!(matches!(
            attach.command,
            Some(Command::Attach {
                new: true,
                driver: Some(ref d),
                worktree: true,
                ..
            }) if d == "claude"
        ));
    }
}
