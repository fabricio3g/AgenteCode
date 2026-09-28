//! `agente serve`: the runtime as a long-lived local service.
//!
//! Desktop, a second terminal (`agente attach`) and, later, bots talk to one
//! runtime over a Unix socket that only this user can open, with JSON-RPC 2.0
//! one message per line (see [`serve_connection`] for the methods).

mod bots;
mod connection;

pub use bots::BotProfiles;
pub use connection::serve_connection;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use agente_bot::BotStore;
use agente_runtime::RuntimeHandle;
use thiserror::Error;

/// What a daemon serves: the runtime, and the bots that run on it.
#[derive(Clone)]
pub struct Service {
    pub runtime: RuntimeHandle,
    pub bots: Arc<BotStore>,
}

#[derive(Debug, Error)]
pub enum ServeError {
    #[error("agente is already serving on {0}")]
    AlreadyRunning(PathBuf),
    #[error("socket {path}: {source}")]
    Socket {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("agente serve needs Unix sockets; this platform is not supported yet")]
    Unsupported,
}

/// Where the socket lives: `$XDG_RUNTIME_DIR/agente/agente.sock` (a private,
/// per-login folder), else `~/.agente/agente.sock`.
pub fn default_socket_path() -> PathBuf {
    if let Some(runtime_dir) = std::env::var_os("XDG_RUNTIME_DIR") {
        return PathBuf::from(runtime_dir)
            .join("agente")
            .join("agente.sock");
    }
    let home = std::env::var_os("HOME").map_or_else(|| PathBuf::from("."), PathBuf::from);
    home.join(".agente").join("agente.sock")
}

/// Whether a daemon answers on `path`.
pub async fn is_serving(path: &Path) -> bool {
    #[cfg(unix)]
    {
        tokio::net::UnixStream::connect(path).await.is_ok()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        false
    }
}

/// Accept clients on `path` until `shutdown` resolves, then remove the
/// socket. A stale socket file (no daemon behind it) is replaced; a live one
/// is an error, so two daemons never share a path.
pub async fn serve_unix(
    service: Service,
    path: &Path,
    shutdown: impl std::future::Future<Output = ()>,
) -> Result<(), ServeError> {
    #[cfg(unix)]
    {
        unix::serve(service, path, shutdown).await
    }
    #[cfg(not(unix))]
    {
        let _ = (service, path, shutdown);
        Err(ServeError::Unsupported)
    }
}

#[cfg(unix)]
mod unix {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    use std::path::Path;

    use tokio::net::UnixListener;

    use super::{is_serving, serve_connection, ServeError, Service};

    pub(super) async fn serve(
        service: Service,
        path: &Path,
        shutdown: impl std::future::Future<Output = ()>,
    ) -> Result<(), ServeError> {
        let socket_error = |source| ServeError::Socket {
            path: path.to_path_buf(),
            source,
        };
        if path.exists() {
            if is_serving(path).await {
                return Err(ServeError::AlreadyRunning(path.to_path_buf()));
            }
            std::fs::remove_file(path).map_err(socket_error)?;
        }
        if let Some(parent) = path.parent() {
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(parent)
                .map_err(socket_error)?;
        }
        let listener = UnixListener::bind(path).map_err(socket_error)?;
        // Only this user may connect: whoever can is treated as the owner.
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(socket_error)?;
        tracing::info!(socket = %path.display(), "agente serve listening");

        tokio::pin!(shutdown);
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let (stream, _) = match accepted {
                        Ok(accepted) => accepted,
                        Err(error) => {
                            tracing::warn!(%error, "accept failed");
                            continue;
                        }
                    };
                    let service = service.clone();
                    tokio::spawn(async move {
                        let (reader, writer) = stream.into_split();
                        if let Err(error) = serve_connection(service, reader, writer).await {
                            tracing::debug!(%error, "client connection ended");
                        }
                    });
                }
                () = &mut shutdown => break,
            }
        }
        let _ = std::fs::remove_file(path);
        Ok(())
    }
}
