//! Remote access: the same JSON-RPC over TCP, for Agente Server and clients
//! on another machine. Unlike the local socket (only this user can open it),
//! anyone who can reach the port can connect, so the first message must be
//! `initialize` with the server's token; otherwise the connection is closed.
//!
//! There is no TLS here: bind to localhost and reach it through an SSH
//! tunnel, a VPN or a TLS reverse proxy when it crosses a network.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use agente_protocol::rpc::{self, Incoming};
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

use crate::connection::{error_reply, initialize_result};
use crate::{serve_connection, ServeError, Service};

/// How long a new connection has to authenticate.
const AUTH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// Maximum size of the unauthenticated handshake line (64 KiB).
const MAX_PRE_AUTH_LINE_BYTES: usize = 64 * 1024;
/// The wrong or missing token.
const UNAUTHORIZED: i32 = -32004;

/// A fresh random token (two v4 UUIDs: 244 random bits).
pub fn generate_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// The token in `path`, made (readable only by this user) when missing.
pub fn load_or_create_token(path: &Path) -> std::io::Result<String> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        let existing = existing.trim();
        if !existing.is_empty() {
            return Ok(existing.to_string());
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let token = generate_token();
    write_private(path, &token)?;
    Ok(token)
}

#[cfg(unix)]
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(text.as_bytes())
}

#[cfg(not(unix))]
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    // The user profile folder is private to the user on Windows.
    std::fs::write(path, text)
}

/// Where `agente serve` keeps its remote-access token by default.
pub fn default_token_path() -> PathBuf {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map_or_else(|| PathBuf::from("."), PathBuf::from);
    home.join(".agente").join("serve-token")
}

/// Equal strings, compared in time that doesn't depend on where they differ.
fn same_token(given: &str, expected: &str) -> bool {
    let (given, expected) = (given.as_bytes(), expected.as_bytes());
    let mut difference = given.len() ^ expected.len();
    for (index, byte) in expected.iter().enumerate() {
        difference |= usize::from(byte ^ given.get(index).copied().unwrap_or(0));
    }
    difference == 0
}

/// Accept TCP clients on `addr` until `shutdown` resolves.
pub async fn serve_tcp(
    service: Service,
    addr: SocketAddr,
    token: String,
    shutdown: impl std::future::Future<Output = ()>,
) -> Result<(), ServeError> {
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|source| ServeError::Socket {
            path: PathBuf::from(addr.to_string()),
            source,
        })?;
    if !addr.ip().is_loopback() {
        tracing::warn!(%addr, "remote access is not encrypted; use a tunnel or a TLS proxy across networks");
    }
    tracing::info!(%addr, "agente serve listening for remote clients");
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, peer) = match accepted {
                    Ok(accepted) => accepted,
                    Err(error) => {
                        tracing::warn!(%error, "accept failed");
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        continue;
                    }
                };
                let _ = stream.set_nodelay(true);
                let service = service.clone();
                let token = token.clone();
                tokio::spawn(async move {
                    let (reader, writer) = stream.into_split();
                    if let Err(error) = serve_authenticated(service, &token, reader, writer).await {
                        tracing::debug!(%error, %peer, "remote connection ended");
                    }
                });
            }
            () = &mut shutdown => break,
        }
    }
    Ok(())
}

/// Require `initialize` with the token first, then serve like a local client.
pub async fn serve_authenticated<R, W>(
    service: Service,
    token: &str,
    reader: R,
    mut writer: W,
) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let mut reader = BufReader::new(reader);
    let read = tokio::time::timeout(
        AUTH_TIMEOUT,
        rpc::read_bounded_line(&mut reader, MAX_PRE_AUTH_LINE_BYTES),
    )
    .await;
    let first = match read {
        Ok(Ok(Some(line))) => line,
        Ok(Ok(None)) | Err(_) => return Ok(()),
        Ok(Err(error)) => return Err(error),
    };
    let reply = authenticate(&first, token);
    let accepted = reply.get("result").is_some();
    let mut line = serde_json::to_vec(&reply).unwrap_or_default();
    line.push(b'\n');
    writer.write_all(&line).await?;
    writer.flush().await?;
    if !accepted {
        tracing::warn!("remote client refused: wrong or missing token");
        return Ok(());
    }
    serve_connection(service, reader, writer).await
}

/// The reply to a connection's first message: `initialize`'s result when it
/// carries the token, an error otherwise.
fn authenticate(line: &str, token: &str) -> Value {
    match rpc::classify(line.trim()) {
        Ok(Incoming::Request { id, method, params }) if method == "initialize" => {
            let given = params.get("token").and_then(Value::as_str).unwrap_or("");
            if same_token(given, token) {
                json!({ "jsonrpc": "2.0", "id": id, "result": initialize_result() })
            } else {
                error_reply(id, UNAUTHORIZED, "unauthorized: wrong or missing token")
            }
        }
        Ok(Incoming::Request { id, .. }) => error_reply(
            id,
            UNAUTHORIZED,
            "unauthorized: send initialize with the token first",
        ),
        _ => error_reply(
            Value::Null,
            UNAUTHORIZED,
            "unauthorized: send initialize with the token first",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_compare_whole() {
        assert!(same_token("abc", "abc"));
        assert!(!same_token("abd", "abc"));
        assert!(!same_token("ab", "abc"));
        assert!(!same_token("abcd", "abc"));
        assert!(!same_token("", "abc"));
    }

    #[test]
    fn only_initialize_with_the_token_is_accepted() {
        let ok = authenticate(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"token":"t"}}"#,
            "t",
        );
        assert_eq!(ok["result"]["server"], "agente");
        let wrong = authenticate(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"token":"x"}}"#,
            "t",
        );
        assert_eq!(wrong["error"]["code"], UNAUTHORIZED);
        let other = authenticate(r#"{"jsonrpc":"2.0","id":2,"method":"session.list"}"#, "t");
        assert_eq!(other["error"]["code"], UNAUTHORIZED);
        assert_eq!(authenticate("garbage", "t")["error"]["code"], UNAUTHORIZED);
    }

    #[test]
    fn a_token_file_is_made_once_and_kept() {
        let dir = std::env::temp_dir().join(format!("agente-token-{}", std::process::id()));
        let path = dir.join("serve-token");
        let first = load_or_create_token(&path).unwrap();
        assert_eq!(first.len(), 64);
        assert_eq!(load_or_create_token(&path).unwrap(), first);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
