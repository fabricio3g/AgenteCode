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

    pub fn set_status(&mut self, id: &str, status: TodoStatus) {
        if let Some(todo) = self.todos.iter_mut().find(|t| t.id == id) {
            todo.status = status;
        }
    }

    pub fn clear_completed(&mut self) {
        self.todos.retain(|t| t.status != TodoStatus::Completed);
    }

    pub fn count_pending(&self) -> usize {
        self.todos
            .iter()
            .filter(|t| t.status == TodoStatus::Pending)
            .count()
    }

    pub fn count_in_progress(&self) -> usize {
        self.todos
            .iter()
            .filter(|t| t.status == TodoStatus::InProgress)
            .count()
    }

    pub fn count_completed(&self) -> usize {
        self.todos
            .iter()
            .filter(|t| t.status == TodoStatus::Completed)
            .count()
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

pub fn todo_write_tool_def() -> crate::types::ToolDefinition {
    crate::types::ToolDefinition {
        name: "todo_write".to_string(),
        description:
            "Update the todo list for this session. Use this to track progress on multi-step tasks."
                .to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "todos": {
                    "type": "array",
                    "description": "List of todos to set",
                    "items": {
                        "type": "object",
                        "properties": {
                            "content": {
                                "type": "string",
                                "description": "Brief description of the task"
                            },
                            "status": {
                                "type": "string",
                                "enum": ["pending", "in_progress", "completed", "cancelled"],
                                "description": "Current status of the task"
                            },
                            "priority": {
                                "type": "string",
                                "enum": ["high", "medium", "low"],
                                "description": "Priority level of the task"
                            }
                        },
                        "required": ["content"]
                    }
                }
            },
            "required": ["todos"]
        }),
    }
}
