//! `agente serve`: the runtime as a long-lived local service.
//!
//! Desktop, a second terminal (`agente attach`) and, later, bots talk to one
//! runtime over a Unix socket that only this user can open, with JSON-RPC 2.0
//! one message per line (see [`serve_connection`] for the methods).

mod bot_tools;
mod bots;
mod connection;
mod routines;
mod tcp;

pub use bots::{spawn_spend_tracker, BotProfiles};
pub use connection::serve_connection;
pub use routines::spawn_scheduler;
pub use tcp::{
    default_token_path, generate_token, load_or_create_token, serve_authenticated, serve_tcp,
};

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
    #[error("agente serve isn't supported on this platform yet")]
    Unsupported,
}

/// Where the socket lives: `$XDG_RUNTIME_DIR/agente/agente.sock` (a private,
/// per-login folder), else `~/.agente/agente.sock`. On Windows it is a named
/// pipe, `\\.\pipe\agente-<user>`.
pub fn default_socket_path() -> PathBuf {
    if cfg!(windows) {
        let user = std::env::var("USERNAME").unwrap_or_else(|_| "user".into());
        return PathBuf::from(format!(r"\\.\pipe\agente-{user}"));
    }
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
    #[cfg(windows)]
    {
        windows::is_serving(path)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        false
    }
}

/// Accept clients on `path` (a Unix socket, or a named pipe on Windows)
/// until `shutdown` resolves. A stale socket file (no daemon behind it) is
/// replaced; a live one is an error, so two daemons never share a path.
pub async fn serve_local(
    service: Service,
    path: &Path,
    shutdown: impl std::future::Future<Output = ()>,
) -> Result<(), ServeError> {
    #[cfg(unix)]
    {
        unix::serve(service, path, shutdown).await
    }
    #[cfg(windows)]
    {
        windows::serve(service, path, shutdown).await
    }
    #[cfg(not(any(unix, windows)))]
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

#[cfg(windows)]
mod windows {
    use std::path::Path;

    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions};

    use super::{serve_connection, ServeError, Service};

    /// ERROR_PIPE_BUSY: every instance is taken, so a server is there.
    const PIPE_BUSY: i32 = 231;

    pub(super) fn is_serving(path: &Path) -> bool {
        match ClientOptions::new().open(path.as_os_str()) {
            Ok(_) => true,
            Err(error) => error.raw_os_error() == Some(PIPE_BUSY),
        }
    }

    fn instance(path: &Path, first: bool) -> std::io::Result<NamedPipeServer> {
        ServerOptions::new()
            // The first instance claims the name: a pipe someone else
            // created first is an error, not a server we'd share.
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .create(path.as_os_str())
    }

    pub(super) async fn serve(
        service: Service,
        path: &Path,
        shutdown: impl std::future::Future<Output = ()>,
    ) -> Result<(), ServeError> {
        let pipe_error = |source| ServeError::Socket {
            path: path.to_path_buf(),
            source,
        };
        if is_serving(path) {
            return Err(ServeError::AlreadyRunning(path.to_path_buf()));
        }
        // Windows gives the creating user full access and everyone else at
        // most read access, which can't send a request.
        let mut server = instance(path, true).map_err(pipe_error)?;
        tracing::info!(pipe = %path.display(), "agente serve listening");

        tokio::pin!(shutdown);
        loop {
            tokio::select! {
                connected = server.connect() => {
                    // The next client needs its own instance, made before
                    // this one is handed off, so the name never disappears.
                    let next = instance(path, false).map_err(pipe_error)?;
                    let client = std::mem::replace(&mut server, next);
                    if let Err(error) = connected {
                        tracing::warn!(%error, "pipe connection failed");
                        continue;
                    }
                    let service = service.clone();
                    tokio::spawn(async move {
                        let (reader, writer) = tokio::io::split(client);
                        if let Err(error) = serve_connection(service, reader, writer).await {
                            tracing::debug!(%error, "client connection ended");
                        }
                    });
                }
                () = &mut shutdown => break,
            }
        }
        Ok(())
    }
}
