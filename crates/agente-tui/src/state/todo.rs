//! Todo list state management
//!
//! This module contains state related to the todo list feature:
//! - Todo store
//! - Inline plan updates

use agente_core::todo::TodoStore;
use agente_core::types::Todo;

/// Todo state management
#[derive(Clone)]
pub struct TodoState {
    /// Todo store for session tasks
    pub todos: TodoStore,
}

impl Default for TodoState {
    fn default() -> Self {
        Self {
            todos: TodoStore::new(),
        }
    }
}

impl TodoState {
    /// Update todos from new data
    pub fn update(&mut self, todos: Vec<Todo>) {
        self.todos.update(
            todos
                .iter()
                .map(|t| agente_core::todo::TodoInput {
                    content: t.content.clone(),
                    status: t.status.to_string().to_lowercase(),
                    priority: t.priority.to_string().to_lowercase(),
                })
                .collect(),
        );
    }

    /// Get all todos
    pub fn get_all(&self) -> &[Todo] {
        self.todos.get_all()
    }

    /// Get todo count
    pub fn count(&self) -> usize {
        self.todos.get_all().len()
    }

    /// Get pending todo count
    pub fn pending_count(&self) -> usize {
        self.todos
            .get_all()
            .iter()
            .filter(|t| matches!(t.status, agente_core::types::TodoStatus::Pending))
            .count()
    }

    /// Get completed todo count
    pub fn completed_count(&self) -> usize {
        self.todos
            .get_all()
            .iter()
            .filter(|t| matches!(t.status, agente_core::types::TodoStatus::Completed))
            .count()
    }
}
