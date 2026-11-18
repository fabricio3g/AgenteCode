use crate::types::{Todo, TodoPriority, TodoStatus};

#[derive(Clone)]
pub struct TodoStore {
    todos: Vec<Todo>,
}

impl TodoStore {
    pub fn new() -> Self {
        Self { todos: Vec::new() }
    }

    pub fn get_all(&self) -> &[Todo] {
        &self.todos
    }

    pub fn update(&mut self, new_todos: Vec<TodoInput>) {
        self.todos.clear();
        for input in new_todos {
            let status = match input.status.as_str() {
                "pending" => TodoStatus::Pending,
                "in_progress" => TodoStatus::InProgress,
                "completed" => TodoStatus::Completed,
                "cancelled" => TodoStatus::Cancelled,
                _ => TodoStatus::Pending,
            };
            let priority = match input.priority.as_str() {
                "high" => TodoPriority::High,
                "medium" => TodoPriority::Medium,
                "low" => TodoPriority::Low,
                _ => TodoPriority::Medium,
            };
            self.todos.push(Todo {
                id: uuid::Uuid::new_v4().to_string(),
                content: input.content,
                status,
                priority,
            });
        }
    }
}

impl Default for TodoStore {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TodoInput {
    pub content: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub priority: String,
}
