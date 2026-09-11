//! Session picker state management
//!
//! This module contains state related to the session picker UI:
//! - Session picker visibility and state
//! - Browse state for session folders
//! - Session queries and selection
//!
//! Session picker state

#[derive(Debug, Clone, Default)]
pub struct SessionPickerState {
    /// Show session picker
    pub show_session_picker: bool,
    /// Session picker search query
    pub session_picker_query: String,
    /// Selected session index
    pub session_picker_selected: usize,
    /// Folder input text
    pub session_picker_folder_input: String,
    /// Folder input is active
    pub session_picker_folder_active: bool,
    /// Browsing for session folder
    pub session_picker_browsing: bool,
    /// Browse path for sessions
    pub session_picker_browse_path: String,
    /// Selected browse entry
    pub session_picker_browse_selected: usize,
    /// Confirm delete session
    pub session_picker_confirm_delete: bool,
    /// Use the picker as a project/folder selector instead of only a session picker.
    pub session_picker_project_select: bool,
}

impl SessionPickerState {
    /// Open session picker
    pub fn open(&mut self) {
        self.show_session_picker = true;
        self.session_picker_query.clear();
        self.session_picker_selected = 0;
    }

    /// Open as the normal session picker, scoped to the current project.
    pub fn open_sessions(&mut self, project_dir: String) {
        self.open();
        self.session_picker_folder_input = project_dir;
        self.session_picker_folder_active = false;
        self.session_picker_browsing = false;
        self.session_picker_project_select = false;
    }

    /// Open directly in folder browsing mode to switch the active project.
    pub fn open_project_selector(&mut self, project_dir: String) {
        self.open();
        self.session_picker_folder_input = project_dir.clone();
        self.session_picker_browse_path = project_dir;
        self.session_picker_folder_active = false;
        self.session_picker_browsing = true;
        self.session_picker_project_select = true;
    }

    /// Close session picker
    pub fn close(&mut self) {
        self.show_session_picker = false;
        self.session_picker_query.clear();
        self.session_picker_selected = 0;
        self.session_picker_confirm_delete = false;
        self.session_picker_browsing = false;
        self.session_picker_folder_input.clear();
        self.session_picker_browse_path.clear();
        self.session_picker_browse_selected = 0;
        self.session_picker_project_select = false;
    }

    /// Start browsing for folder
    pub fn start_browsing(&mut self, path: String) {
        self.session_picker_browsing = true;
        self.session_picker_browse_path = path;
        self.session_picker_browse_selected = 0;
    }

    /// Stop browsing
    pub fn stop_browsing(&mut self) {
        self.session_picker_browsing = false;
        self.session_picker_browse_path.clear();
        self.session_picker_browse_selected = 0;
    }

    /// Activate folder input
    pub fn activate_folder_input(&mut self) {
        self.session_picker_folder_active = true;
    }

    /// Deactivate folder input
    pub fn deactivate_folder_input(&mut self) {
        self.session_picker_folder_active = false;
    }

    /// Set confirm delete state
    pub fn set_confirm_delete(&mut self, confirm: bool) {
        self.session_picker_confirm_delete = confirm;
    }

    /// Toggle confirm delete state
    pub fn toggle_confirm_delete(&mut self) {
        self.session_picker_confirm_delete = !self.session_picker_confirm_delete;
    }
}
