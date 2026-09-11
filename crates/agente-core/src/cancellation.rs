//! Cancellation utilities
//!
//! This module provides an AbortController pattern for cancelling async tasks,
//! similar to the JavaScript AbortController API or .NET CancellationToken.
//!
//! # Example
//!
//! ```no_run
//! use agente_core::cancellation::{AbortController, AbortSignal};
//!
//! async fn my_task(signal: AbortSignal) -> Result<(), String> {
//!     loop {
//!         if signal.is_aborted() {
//!             return Err("Cancelled".to_string());
//!         }
//!         // Do some work...
//!         tokio::time::sleep(std::time::Duration::from_secs(1)).await;
//!     }
//! }
//!
//! #[tokio::main]
//! async fn main() {
//!     let controller = AbortController::new();
//!     let signal = controller.signal();
//!
//!     // Spawn the task with the abort signal
//!     let handle = tokio::spawn(my_task(signal));
//!
//!     // Abort the task after 5 seconds
//!     tokio::time::sleep(std::time::Duration::from_secs(5)).await;
//!     controller.abort();
//!
//!     let result = handle.await.unwrap();
//!     assert!(result.is_err());
//! }
//! ```

use tokio_util::sync::CancellationToken;

/// Controller for aborting async tasks
///
/// An AbortController allows you to abort one or more tasks by creating
/// an AbortSignal that can be passed to tasks.
#[derive(Clone)]
pub struct AbortController {
    token: CancellationToken,
}

impl AbortController {
    /// Create a new AbortController
    pub fn new() -> Self {
        Self {
            token: CancellationToken::new(),
        }
    }

    fn from_token(token: CancellationToken) -> Self {
        Self { token }
    }

    /// Abort all tasks using this controller's signal
    ///
    /// This sets the abort flag and notifies all waiting tasks.
    pub fn abort(&self) {
        self.token.cancel();
    }

    /// Check if the controller has been aborted
    pub fn is_aborted(&self) -> bool {
        self.token.is_cancelled()
    }

    /// Get a signal that can be passed to tasks
    ///
    /// Multiple signals can be created from a single controller,
    /// and they will all be aborted together.
    pub fn signal(&self) -> AbortSignal {
        AbortSignal::from_token(self.token.clone())
    }

    /// Create a controller whose token is a child of this signal's token.
    /// Cancellation of the parent propagates without a relay task, while
    /// cancelling the returned controller remains local to the child.
    pub fn child_controller(&self) -> AbortController {
        AbortController::from_token(self.token.child_token())
    }
}

impl Default for AbortController {
    fn default() -> Self {
        Self::new()
    }
}

/// Signal for checking if an operation should be aborted
///
/// AbortSignal can be cloned and passed to multiple tasks.
/// All clones refer to the same abort state.
#[derive(Clone)]
pub struct AbortSignal {
    token: CancellationToken,
}

impl AbortSignal {
    fn from_token(token: CancellationToken) -> Self {
        Self { token }
    }
}

impl AbortSignal {
    /// Check if the operation has been aborted
    ///
    /// This is a non-blocking check that can be called frequently
    /// without significant overhead.
    pub fn is_aborted(&self) -> bool {
        self.token.is_cancelled()
    }

    /// Wait until the signal is aborted
    ///
    /// This returns immediately if already aborted, otherwise waits
    /// for the abort signal.
    pub async fn wait_aborted(&self) {
        if self.is_aborted() {
            return;
        }
        self.token.cancelled().await;
    }

    /// Create a new AbortSignal that is already aborted
    pub fn aborted() -> Self {
        let token = CancellationToken::new();
        token.cancel();
        Self::from_token(token)
    }

    /// Create a new AbortSignal that will never be aborted
    pub fn never() -> Self {
        Self::from_token(CancellationToken::new())
    }

    /// Create a controller linked to this signal without a relay task.
    pub fn child_controller(&self) -> AbortController {
        AbortController::from_token(self.token.child_token())
    }
}

/// A guard that automatically aborts when dropped
///
/// This is useful for ensuring operations are aborted when
/// a scope exits.
pub struct AbortGuard {
    controller: AbortController,
}

impl AbortGuard {
    /// Create a new AbortGuard
    pub fn new(controller: AbortController) -> Self {
        Self { controller }
    }

    /// Get the underlying AbortController
    pub fn controller(&self) -> &AbortController {
        &self.controller
    }

    /// Abort without consuming the guard
    pub fn abort(&self) {
        self.controller.abort();
    }
}

impl Drop for AbortGuard {
    fn drop(&mut self) {
        self.controller.abort();
    }
}

/// A scope that supports cancellation
///
/// CancellableScope provides a structured way to manage cancellable
/// operations within a specific scope.
pub struct CancellableScope {
    controller: AbortController,
}

impl CancellableScope {
    /// Create a new cancellable scope
    pub fn new() -> Self {
        Self {
            controller: AbortController::new(),
        }
    }

    /// Get the AbortController for this scope
    pub fn controller(&self) -> &AbortController {
        &self.controller
    }

    /// Get an AbortSignal for this scope
    pub fn signal(&self) -> AbortSignal {
        self.controller.signal()
    }

    /// Abort all operations in this scope
    pub fn abort(&self) {
        self.controller.abort();
    }

    /// Check if the scope has been aborted
    pub fn is_aborted(&self) -> bool {
        self.controller.is_aborted()
    }
}

impl Default for CancellableScope {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_abort_controller_not_aborted_initially() {
        let controller = AbortController::new();
        assert!(!controller.is_aborted());
    }

    #[test]
    fn test_abort_controller_abort() {
        let controller = AbortController::new();
        controller.abort();
        assert!(controller.is_aborted());
    }

    #[test]
    fn test_signal_tracks_controller() {
        let controller = AbortController::new();
        let signal = controller.signal();
        assert!(!signal.is_aborted());

        controller.abort();
        assert!(signal.is_aborted());
    }

    #[test]
    fn test_multiple_signals() {
        let controller = AbortController::new();
        let signal1 = controller.signal();
        let signal2 = controller.signal();

        controller.abort();
        assert!(signal1.is_aborted());
        assert!(signal2.is_aborted());
    }

    #[tokio::test]
    async fn test_wait_aborted() {
        let controller = AbortController::new();
        let signal = controller.signal();

        // Spawn a task that will abort after a delay
        let ctrl = controller.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            ctrl.abort();
        });

        // Wait should complete when abort is called
        signal.wait_aborted().await;
        assert!(signal.is_aborted());
    }

    #[tokio::test]
    async fn dropping_controller_does_not_cancel_signal() {
        let controller = AbortController::new();
        let signal = controller.signal();
        drop(controller);

        let result =
            tokio::time::timeout(std::time::Duration::from_millis(20), signal.wait_aborted()).await;
        assert!(
            result.is_err(),
            "dropping a controller must not abort its signal"
        );
    }

    #[tokio::test]
    async fn child_controller_propagates_parent_abort() {
        let parent = AbortController::new();
        let child = parent.signal().child_controller();
        let signal = child.signal();

        parent.abort();
        signal.wait_aborted().await;
        assert!(signal.is_aborted());
    }

    #[test]
    fn test_aborted_signal() {
        let signal = AbortSignal::aborted();
        assert!(signal.is_aborted());
    }

    #[test]
    fn test_never_signal() {
        let signal = AbortSignal::never();
        assert!(!signal.is_aborted());
    }

    #[test]
    fn test_cancellable_scope() {
        let scope = CancellableScope::new();
        let signal = scope.signal();

        assert!(!scope.is_aborted());
        assert!(!signal.is_aborted());

        scope.abort();
        assert!(scope.is_aborted());
        assert!(signal.is_aborted());
    }
}
