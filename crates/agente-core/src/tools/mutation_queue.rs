//! Per-path mutation serialization queue.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;

use super::ToolError;
use crate::cancellation::AbortSignal;

type FileMutationQueues = Arc<AsyncMutex<HashMap<String, Arc<AsyncMutex<()>>>>>;
static FILE_MUTATION_QUEUES: std::sync::LazyLock<FileMutationQueues> =
    std::sync::LazyLock::new(|| Arc::new(AsyncMutex::new(HashMap::new())));

/// Refuse a mutation that has not started its commit yet.
pub fn ensure_not_cancelled(signal: &AbortSignal) -> Result<(), ToolError> {
    if signal.is_aborted() {
        return Err(ToolError::ExecutionError("Tool execution cancelled".into()));
    }
    Ok(())
}

/// Serialize mutations of one path and keep the path lock owned until the
/// mutation finishes, even when its caller is cancelled.
///
/// The mutation runs in its own task. Dropping the caller's await (turn
/// cancellation, aborted handle) never drops a half-issued atomic write: the
/// detached task holds the same lock until commit and read-state recording
/// complete, so a second writer cannot interleave. `signal` is checked before
/// the mutation starts; call [`ensure_not_cancelled`] inside `f` to honor
/// cancellation before the actual commit.
pub async fn with_file_mutation_queue<F, Fut, T>(
    path: &str,
    signal: AbortSignal,
    f: F,
) -> Result<T, ToolError>
where
    F: FnOnce(AbortSignal) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<T, ToolError>> + Send + 'static,
    T: Send + 'static,
{
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| Path::new(path).to_path_buf());
    let key = canonical.to_string_lossy().to_string();

    let mutex = {
        let mut queues = FILE_MUTATION_QUEUES.lock().await;
        queues
            .entry(key.clone())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    };

    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let _guard = mutex.lock().await;
        let result = if signal.is_aborted() {
            Err(ToolError::ExecutionError("Tool execution cancelled".into()))
        } else {
            f(signal).await
        };
        let _ = tx.send(result);
    });

    match rx.await {
        Ok(result) => result,
        Err(_) => Err(ToolError::ExecutionError("Tool execution cancelled".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Dropping the caller's future must not release the path lock while an
    /// already-started mutation is still committing. The second mutation has
    /// to observe the first one's result.
    #[tokio::test(flavor = "multi_thread")]
    async fn cancelled_mutation_keeps_its_path_lock_until_it_finishes() {
        let dir = std::env::temp_dir().join(format!("agente-mut-queue-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("f.txt");
        let path = file.to_string_lossy().to_string();

        let controller = crate::cancellation::AbortController::new();
        let signal = controller.signal();
        let first_path = file.clone();
        let first = tokio::spawn(async move {
            with_file_mutation_queue(&path, signal, move |_| async move {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                std::fs::write(&first_path, "A").unwrap();
                Ok(())
            })
            .await
        });
        // Let the first mutation start, then abort its caller.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        controller.abort();
        first.abort();

        let second_path = file.clone();
        let observed = with_file_mutation_queue(
            &file.to_string_lossy(),
            crate::cancellation::AbortSignal::never(),
            move |_| async move {
                let seen = std::fs::read_to_string(&second_path).unwrap_or_default();
                std::fs::write(&second_path, "B").unwrap();
                Ok(seen)
            },
        )
        .await
        .expect("second mutation");

        assert_eq!(
            observed, "A",
            "the cancelled commit must finish under its lock before the next writer"
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "B");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A mutation that has not started yet must refuse to run once its signal
    /// is aborted.
    #[tokio::test(flavor = "multi_thread")]
    async fn aborted_mutation_never_writes() {
        let dir = std::env::temp_dir().join(format!("agente-mut-abort-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("f.txt");
        let controller = crate::cancellation::AbortController::new();
        controller.abort();

        let target = file.clone();
        let result = with_file_mutation_queue(
            &file.to_string_lossy(),
            controller.signal(),
            move |_| async move {
                std::fs::write(&target, "nope").unwrap();
                Ok(())
            },
        )
        .await;
        assert!(result.is_err(), "aborted mutation must not report success");
        assert!(!file.exists(), "aborted mutation must not write");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
