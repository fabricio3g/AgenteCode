//! Stdio-to-Streamable-HTTP MCP bridge (`agente mcp-bridge`).
//!
//! Used automatically when an ACP external CLI advertises stdio MCP support
//! without `mcpCapabilities.http`. Reads one JSON-RPC line per request from
//! stdin, forwards it over HTTP `POST` with an optional Bearer token from
//! the environment (never from CLI argv), and writes JSON responses to stdout.

use std::io::Write;

use anyhow::Context;
use tokio::io::{AsyncBufReadExt, BufReader};

/// Run the synchronous stdio-to-HTTP bridge until stdin EOF.
pub fn run(url: String, token_env: String) -> anyhow::Result<()> {
    let token = std::env::var(&token_env)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(run_async(url, token))
}

async fn run_async(url: String, token: Option<String>) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let stdout = std::io::stdout();
    while let Some(line) = lines.next_line().await.context("read stdio MCP request")? {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(reply) = forward_line(&client, &url, token.as_deref(), trimmed).await? {
            let mut out = stdout.lock();
            out.write_all(reply.as_bytes())?;
            if !reply.ends_with('\n') {
                out.write_all(b"\n")?;
            }
            out.flush()?;
        }
    }
    Ok(())
}

async fn forward_line(
    client: &reqwest::Client,
    url: &str,
    token: Option<&str>,
    line: &str,
) -> anyhow::Result<Option<String>> {
    let mut req = client
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "application/json")
        .body(line.to_string());
    if let Some(tok) = token {
        req = req.bearer_auth(tok);
    }
    let resp = req
        .send()
        .await
        .with_context(|| format!("POST {url}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        anyhow::bail!("MCP HTTP {status}: {body}");
    }
    let trimmed = body.trim();
    if trimmed.is_empty() {
        Ok(None)
    } else {
        Ok(Some(trimmed.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn forward_line_sends_bearer_token_and_returns_response() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).await.unwrap();
            let raw = String::from_utf8_lossy(&buf[..n]).into_owned();
            assert!(
                raw.contains("authorization: Bearer bridge-secret")
                    || raw.contains("Authorization: Bearer bridge-secret"),
                "missing bearer header in request:\n{raw}"
            );
            assert!(raw.contains("\"tools/list\""), "{raw}");

            let reply = r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}"#;
            let http_resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
            stream.write_all(http_resp.as_bytes()).await.unwrap();
        });

        let client = reqwest::Client::new();
        let url = format!("http://{addr}/mcp");
        let reply = forward_line(
            &client,
            &url,
            Some("bridge-secret"),
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}"#,
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(reply, r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}"#);
        server.await.unwrap();
    }
}
