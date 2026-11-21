// ── Pending request table + Drop-guard cleanup ────────────────────────
// Shared between `Hub` (forwarding actions to the browser extension) and
// `Peer` (forwarding actions to the hub). Holding a `PendingGuard` across
// the `await` guarantees that cancelled futures never leak entries in the
// pending map.

use crate::driver::ActionResult;
use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::oneshot;

#[derive(Default)]
pub(crate) struct PendingMap {
    entries: HashMap<String, oneshot::Sender<ActionResult>>,
}

impl PendingMap {
    pub(crate) fn register(&mut self, id: String) -> oneshot::Receiver<ActionResult> {
        let (sender, receiver) = oneshot::channel();
        self.entries.insert(id, sender);
        receiver
    }

    pub(crate) fn remove(&mut self, id: &str) {
        self.entries.remove(id);
    }

    pub(crate) fn take(&mut self, id: &str) -> Option<oneshot::Sender<ActionResult>> {
        self.entries.remove(id)
    }

    pub(crate) fn drain_senders(&mut self) -> Vec<oneshot::Sender<ActionResult>> {
        self.entries.drain().map(|(_, sender)| sender).collect()
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }
}

/// Fail every drained pending sender with the given error message (call after
/// dropping any lock guarding the map).
pub(crate) fn fail_all(senders: Vec<oneshot::Sender<ActionResult>>, message: &str) {
    for sender in senders {
        let _ = sender.send(ActionResult::error(message));
    }
}

struct PendingGuard<F: FnOnce(&str)> {
    id: String,
    remove: Option<F>,
}

impl<F: FnOnce(&str)> PendingGuard<F> {
    fn new(id: String, remove: F) -> Self {
        Self {
            id,
            remove: Some(remove),
        }
    }

    fn disarm(&mut self) {
        self.remove = None;
    }
}

impl<F: FnOnce(&str)> Drop for PendingGuard<F> {
    fn drop(&mut self) {
        if let Some(remove) = self.remove.take() {
            remove(&self.id);
        }
    }
}

/// Await a pending action response with a timeout, automatically removing `id`
/// via `remove` on disconnect, timeout, or future cancellation.
pub(crate) async fn await_pending<F>(
    id: String,
    receiver: oneshot::Receiver<ActionResult>,
    timeout: Duration,
    on_disconnect: impl FnOnce() -> String,
    on_timeout: impl FnOnce() -> String,
    remove: F,
) -> ActionResult
where
    F: FnOnce(&str),
{
    let mut guard = PendingGuard::new(id, remove);
    match tokio::time::timeout(timeout, receiver).await {
        Ok(Ok(result)) => {
            guard.disarm();
            result
        }
        Ok(Err(_)) => ActionResult::error(on_disconnect()),
        Err(_) => ActionResult::error(on_timeout()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn cancelling_await_pending_removes_entry_from_map() {
        let map = Arc::new(Mutex::new(PendingMap::default()));
        let rx = map.lock().unwrap().register("req-1".into());
        assert_eq!(map.lock().unwrap().len(), 1);

        let map_clone = Arc::clone(&map);
        let fut = await_pending(
            "req-1".into(),
            rx,
            Duration::from_secs(60),
            || "disconnected".into(),
            || "timed out".into(),
            move |id| map_clone.lock().unwrap().remove(id),
        );

        let handle = tokio::spawn(fut);
        tokio::task::yield_now().await;
        handle.abort();
        let _ = handle.await;

        assert_eq!(
            map.lock().unwrap().len(),
            0,
            "cancelled future must clean up its pending entry via Drop"
        );
    }

    #[tokio::test]
    async fn timeout_removes_entry_and_returns_error() {
        let map = Arc::new(Mutex::new(PendingMap::default()));
        let rx = map.lock().unwrap().register("req-2".into());
        let map_clone = Arc::clone(&map);

        let result = await_pending(
            "req-2".into(),
            rx,
            Duration::from_millis(10),
            || "disconnected".into(),
            || "timed out".into(),
            move |id| map_clone.lock().unwrap().remove(id),
        )
        .await;

        assert!(!result.ok);
        assert_eq!(result.text, "timed out");
        assert_eq!(map.lock().unwrap().len(), 0);
    }
}
