// ── `agente bridge` ───────────────────────────────────────────────────
// The browser extension's local end. Bare `agente bridge` is the MCP server a
// session spawns (stdio — never print to stdout there); the subcommands are
// for a person: install it, see its state, pair a browser, sign in to Google.

use agente_bridge::pairing::{self, Pairing, Settings, ToolSet};
use agente_core::auth::AuthStore;
use agente_core::config::AppConfig;
use clap::Subcommand;

#[derive(Subcommand, Debug)]
pub enum BridgeAction {
    /// Hold the browser listener in the foreground, so the extension stays
    /// connected while no Agente session is open.
    Serve,
    /// Show the listener, the connected browser, the Google account and the
    /// pairing code.
    Status,
    /// Register the bridge as the `web` MCP server for every Agente session.
    Install {
        /// Which tools sessions get: all, browser or docs.
        #[arg(long, default_value = "all")]
        tools: String,
    },
    /// Remove the `web` MCP server again.
    Uninstall,
    /// Sign in to a document service (only `google` today).
    Auth {
        service: String,
        /// OAuth client id of your own Google Cloud "Desktop app" client
        /// (docs/GOOGLE_WORKSPACE.md). Stored for next time.
        #[arg(long)]
        client_id: Option<String>,
        #[arg(long)]
        client_secret: Option<String>,
    },
}

pub fn run(action: Option<BridgeAction>) -> anyhow::Result<()> {
    let runtime = tokio::runtime::Runtime::new()?;
    let pairing = Pairing::load_or_create()?;
    match action {
        None => runtime.block_on(agente_bridge::server::run_stdio(
            pairing,
            ToolSet::from_env(),
        )),
        Some(BridgeAction::Serve) => runtime.block_on(agente_bridge::run_serve(pairing)),
        Some(BridgeAction::Status) => {
            println!("{}", runtime.block_on(agente_bridge::status(&pairing)));
            Ok(())
        }
        Some(BridgeAction::Install { tools }) => {
            let config = config_path()?;
            let exe = std::env::current_exe()?;
            let tools = ToolSet::parse(&tools);
            pairing::install_mcp_entry(&config, &exe, tools.label())?;
            println!(
                "Registered the `web` tools ({}) in {}.",
                tools.label(),
                config.display()
            );
            println!("Pairing code for the browser extension: {}", pairing.code());
            Ok(())
        }
        Some(BridgeAction::Uninstall) => {
            let config = config_path()?;
            if pairing::remove_mcp_entry(&config)? {
                println!("Removed the `web` tools from {}.", config.display());
            } else {
                println!(
                    "The `web` tools were not registered in {}.",
                    config.display()
                );
            }
            Ok(())
        }
        Some(BridgeAction::Auth {
            service,
            client_id,
            client_secret,
        }) => {
            if service != agente_bridge::google::PROVIDER {
                anyhow::bail!("Only `google` can be signed in to today");
            }
            let mut settings = Settings::load();
            if let Some(id) = client_id {
                settings.google_client_id = Some(id);
            }
            if let Some(secret) = client_secret {
                settings.google_client_secret = Some(secret);
            }
            let (Some(id), Some(secret)) = (
                settings.google_client_id.clone(),
                settings.google_client_secret.clone(),
            ) else {
                anyhow::bail!(
                    "No Google OAuth client yet. Create one (docs/GOOGLE_WORKSPACE.md), then run \
                     `agente bridge auth google --client-id … --client-secret …`"
                );
            };
            settings.save()?;
            let grant = runtime.block_on(agente_bridge::google::oauth::run_flow(&id, &secret))?;
            let mut store = AuthStore::load();
            store.set_oauth(agente_bridge::google::PROVIDER, grant);
            store.save()?;
            println!("Signed in to Google. Docs, Sheets and Drive tools are ready.");
            Ok(())
        }
    }
}

fn config_path() -> anyhow::Result<std::path::PathBuf> {
    AppConfig::global_config_path()
        .ok_or_else(|| anyhow::anyhow!("No home directory to keep ~/.agente/config.json in"))
}
