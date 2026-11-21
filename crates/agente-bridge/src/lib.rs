// ── Agente bridge ─────────────────────────────────────────────────────
// The user's real browser, and their real documents, as Agente tools.
//
// One process, three jobs:
// - `agente bridge` speaks MCP over stdio to one Agente session, which is
//   how the tools reach the TUI, Desktop or the daemon. Nothing has to be
//   kept running by hand: the session spawns it and it dies with the
//   session, exactly like every other MCP server.
// - The first bridge process to bind `127.0.0.1:<port>` owns the WebSocket
//   listener the browser extension connects to; later ones reach the
//   browser through it as peers, so several sessions share one browser.
// - `agente bridge serve` holds that listener in the foreground.
//
// Everything a model sees is designed text: a browser that is not connected
// answers with what to do about it, never with a stack trace.

pub mod driver;
pub mod google;
pub mod hub;
pub mod pairing;
pub mod peer;
mod pending;
pub mod protocol;
pub mod server;
pub mod text;

use driver::{Driver, Offline};
use hub::Hub;
use pairing::Pairing;
use std::sync::Arc;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// A driver plus the listener this process owns, when it owns one.
pub struct Bridge {
    pub driver: Driver,
    pub hub: Option<Arc<Hub>>,
    pub pairing: Pairing,
}

/// Join an existing hub, or become one.
///
/// `force_hub` is what `agente bridge serve` uses: it takes the port even if
/// another bridge already holds it (and fails loudly if a stranger does).
pub async fn attach(pairing: Pairing, force_hub: bool) -> Bridge {
    if !force_hub {
        if let Ok(Some(_)) = peer::probe(&pairing).await {
            if let Ok(peer) = peer::Peer::start(pairing.clone()).await {
                return Bridge {
                    driver: Driver::Peer(peer),
                    hub: None,
                    pairing,
                };
            }
        }
    }

    match Hub::bind(&pairing).await {
        Ok((hub, listener)) => {
            hub.serve(listener);
            Bridge {
                driver: Driver::Local(Arc::clone(&hub)),
                hub: Some(hub),
                pairing,
            }
        }
        Err(error) => {
            tracing::warn!(%error, port = pairing.port, "bridge could not take the loopback port");
            Bridge {
                driver: Driver::offline(pairing.clone(), Offline::NoListener),
                hub: None,
                pairing,
            }
        }
    }
}

/// Hold the loopback listener until Ctrl+C, so a browser can stay connected
/// while the user works somewhere else.
pub async fn run_serve(pairing: Pairing) -> anyhow::Result<()> {
    let bridge = attach(pairing, true).await;
    let Some(hub) = bridge.hub else {
        anyhow::bail!(
            "{}",
            driver::offline_text(&bridge.pairing, &Offline::NoListener)
        );
    };
    println!(
        "Agente bridge listening on 127.0.0.1:{} — pairing code {}",
        hub.pairing().port,
        hub.pairing().code()
    );
    println!("Connect the browser extension with that code. Ctrl+C to stop.");
    tokio::signal::ctrl_c().await?;
    Ok(())
}

/// What `agente bridge status` prints: the listener, the browser, and the
/// Google account, each on its own line.
pub async fn status(pairing: &Pairing) -> String {
    let mut lines = vec![format!("pairing code  {}", pairing.code())];
    match peer::probe(pairing).await {
        Ok(Some(info)) => {
            lines.push(format!(
                "listener      127.0.0.1:{} · {} attached",
                pairing.port,
                info.label()
            ));
        }
        Ok(None) => lines.push(format!(
            "listener      127.0.0.1:{} · no browser connected",
            pairing.port
        )),
        Err(error) => lines.push(format!(
            "listener      none on 127.0.0.1:{} ({error}) — run `agente bridge serve`, or let a session start one",
            pairing.port
        )),
    }
    lines.push(crate::google::status_line());
    lines.join("\n")
}
