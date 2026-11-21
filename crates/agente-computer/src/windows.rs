use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, BufRead, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
use windows_sys::Win32::UI::WindowsAndMessaging::*;

const TAG_MASK: usize = 0xffusize << (usize::BITS - 8);
const TAG: usize = 0xa7usize << (usize::BITS - 8);
const HEARTBEAT_MS: u64 = 3_000;
static CURSOR_LOCK: Mutex<()> = Mutex::new(());
fn restore_cursor() {
    unsafe {
        SystemParametersInfoW(SPI_SETCURSORS, 0, std::ptr::null_mut(), 0);
    }
}
fn style_cursor() -> bool {
    let mut resource = *include_bytes!("cursor.bin");
    unsafe {
        let cursor = CreateIconFromResourceEx(
            resource.as_mut_ptr(),
            resource.len() as u32,
            0,
            0x00030000,
            32,
            32,
            0,
        );
        if cursor.is_null() {
            return false;
        }
        // SetSystemCursor consumes this owned handle; the configured scheme is
        // restored on takeover, heartbeat loss, EOF and normal shutdown.
        SetSystemCursor(cursor, OCR_NORMAL) != 0
    }
}
static SHARED: OnceLock<Arc<State>> = OnceLock::new();

struct State {
    lease: AtomicU64,
    heartbeat: AtomicU64,
    escape_held: AtomicBool,
    cursor_active: AtomicBool,
    started: Instant,
    events: mpsc::Sender<Value>,
}

impl State {
    fn now(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
    fn check(&self, lease: u64) -> Result<(), String> {
        if lease != 0 && self.lease.load(Ordering::SeqCst) == lease {
            Ok(())
        } else {
            Err("control_revoked: take over or start a new session".into())
        }
    }
    fn revoke(&self, reason: &str) {
        let lease = self.lease.swap(0, Ordering::SeqCst);
        if lease != 0 {
            let _ = self
                .events
                .send(json!({"event":"revoked", "reason":reason, "lease":lease}));
        }
    }
    fn is_escape_held(&self) -> bool {
        if !self.escape_held.load(Ordering::SeqCst) {
            return false;
        }
        let physically_down =
            unsafe { (GetAsyncKeyState(i32::from(VK_ESCAPE)) as u16 & 0x8000) != 0 };
        if !physically_down {
            self.escape_held.store(false, Ordering::SeqCst);
        }
        physically_down
    }
}

struct CursorGuard(Arc<State>);

impl Drop for CursorGuard {
    fn drop(&mut self) {
        self.0.revoke("owner_disconnected");
        let _cursor = CURSOR_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.0.cursor_active.swap(false, Ordering::SeqCst) {
            restore_cursor();
        }
    }
}

// Never wait for IPC, stdout or an input worker inside the hook. Windows may
// remove slow hooks; this callback does only atomics and an unbounded send.
unsafe extern "system" fn keyboard(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let key = &*(l as *const KBDLLHOOKSTRUCT);
        if key.flags & LLKHF_INJECTED != 0
            && injected_is_revoked(key.dwExtraInfo)
            && w as u32 != WM_KEYUP
            && w as u32 != WM_SYSKEYUP
        {
            return 1;
        }
        if key.vkCode == VK_ESCAPE as u32 && key.flags & LLKHF_INJECTED == 0 {
            if let Some(state) = SHARED.get() {
                if w as u32 == WM_KEYDOWN || w as u32 == WM_SYSKEYDOWN {
                    if state.lease.load(Ordering::SeqCst) != 0 {
                        state.escape_held.store(true, Ordering::SeqCst);
                        state.revoke("escape");
                        return 1;
                    }
                    if state.is_escape_held() {
                        return 1;
                    }
                } else if (w as u32 == WM_KEYUP || w as u32 == WM_SYSKEYUP)
                    && state.escape_held.swap(false, Ordering::SeqCst)
                {
                    return 1;
                }
            }
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, w, l)
}

fn injected_is_revoked(extra: usize) -> bool {
    if extra & TAG_MASK != TAG {
        return false;
    }
    let lease = (extra & !TAG_MASK) as u64;
    SHARED
        .get()
        .is_none_or(|state| lease == 0 || state.lease.load(Ordering::SeqCst) != lease)
}
// Filter a tagged stale event at delivery too, closing the check/SendInput
// race without holding a mutex across SendInput and deadlocking its hook.
// Releases always pass so takeover cannot leave a key or button held.
unsafe extern "system" fn mouse_hook(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let input = &*(l as *const MSLLHOOKSTRUCT);
        let release = matches!(
            w as u32,
            WM_LBUTTONUP | WM_RBUTTONUP | WM_MBUTTONUP | WM_XBUTTONUP
        );
        if !release && input.flags & LLMHF_INJECTED != 0 && injected_is_revoked(input.dwExtraInfo) {
            return 1;
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, w, l)
}

#[derive(Deserialize)]
struct Command {
    id: u64,
    op: String,
    #[serde(default)]
    lease: u64,
    #[serde(default)]
    action: Option<Action>,
}

#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Action {
    Move {
        x: i32,
        y: i32,
    },
    Click {
        x: i32,
        y: i32,
        #[serde(default)]
        right: bool,
        #[serde(default)]
        twice: bool,
    },
    Drag {
        x: i32,
        y: i32,
        to_x: i32,
        to_y: i32,
    },
    Scroll {
        x: i32,
        y: i32,
        delta: i32,
    },
    Key {
        keys: Vec<String>,
    },
    Type {
        text: String,
    },
}

fn send(input: INPUT) -> Result<(), String> {
    let count = unsafe { SendInput(1, &input, std::mem::size_of::<INPUT>() as i32) };
    if count == 1 {
        Ok(())
    } else {
        Err("Input was blocked. Take over for elevated or protected windows.".into())
    }
}
fn mouse(flags: u32, x: i32, y: i32, data: u32, lease: u64) -> Result<(), String> {
    send(INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: x,
                dy: y,
                mouseData: data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: TAG | lease as usize,
            },
        },
    })
}
fn key(vk: u16, scan: u16, flags: u32, lease: u64) -> Result<(), String> {
    send(INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: TAG | lease as usize,
            },
        },
    })
}
fn move_to(state: &State, lease: u64, x: i32, y: i32) -> Result<(), String> {
    state.check(lease)?;
    let (left, top, width, height) = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    };
    if width < 2 || height < 2 || x < left || y < top || x >= left + width || y >= top + height {
        return Err("Pointer is outside the connected displays".into());
    }
    let px = ((i64::from(x - left) * 65535) / i64::from(width - 1)) as i32;
    let py = ((i64::from(y - top) * 65535) / i64::from(height - 1)) as i32;
    mouse(
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        px,
        py,
        0,
        lease,
    )?;
    let _ = state.events.send(json!({"event":"pointer", "x":x, "y":y}));
    Ok(())
}
fn virtual_key(name: &str) -> Option<u16> {
    Some(match name.to_ascii_lowercase().as_str() {
        "control" | "ctrl" => VK_CONTROL,
        "shift" => VK_SHIFT,
        "alt" => VK_MENU,
        "meta" | "win" | "super" => VK_LWIN,
        "enter" => VK_RETURN,
        "tab" => VK_TAB,
        "escape" | "esc" => VK_ESCAPE,
        "backspace" => VK_BACK,
        "delete" => VK_DELETE,
        "space" => VK_SPACE,
        "up" | "arrowup" => VK_UP,
        "down" | "arrowdown" => VK_DOWN,
        "left" | "arrowleft" => VK_LEFT,
        "right" | "arrowright" => VK_RIGHT,
        "home" => VK_HOME,
        "end" => VK_END,
        "pageup" => VK_PRIOR,
        "pagedown" => VK_NEXT,
        s if s.len() == 1 && s.as_bytes()[0].is_ascii_alphanumeric() => {
            s.as_bytes()[0].to_ascii_uppercase() as u16
        }
        s if s.starts_with('f') => {
            let number: u16 = s[1..].parse().ok()?;
            if !(1..=12).contains(&number) {
                return None;
            }
            VK_F1 + number - 1
        }
        _ => return None,
    })
}
fn extended(vk: u16) -> u32 {
    if matches!(
        vk,
        VK_LWIN
            | VK_DELETE
            | VK_HOME
            | VK_END
            | VK_PRIOR
            | VK_NEXT
            | VK_UP
            | VK_DOWN
            | VK_LEFT
            | VK_RIGHT
    ) {
        KEYEVENTF_EXTENDEDKEY
    } else {
        0
    }
}

fn validate_action(action: &Action) -> Result<(), String> {
    match action {
        Action::Key { keys } => {
            if keys.is_empty() || keys.len() > 5 {
                return Err("Use one key or a combination of at most five keys".into());
            }
            for name in keys {
                if virtual_key(name).is_none() {
                    return Err(format!("Unsupported key: {name}. Use separate key names, e.g. [\"Control\",\"L\"]."));
                }
            }
        }
        Action::Scroll { delta, .. } if !(-1200..=1200).contains(delta) => {
            return Err("Scroll delta must be between -1200 and 1200".into());
        }
        Action::Type { text } if text.chars().count() > 2000 => {
            return Err("Type at most 2000 characters at once".into());
        }
        _ => {}
    }
    Ok(())
}

fn perform(state: &State, lease: u64, action: Action) -> Result<(), String> {
    state.check(lease)?;
    match action {
        Action::Move { x, y } => move_to(state, lease, x, y)?,
        Action::Click { x, y, right, twice } => {
            move_to(state, lease, x, y)?;
            let (down, up) = if right {
                (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)
            } else {
                (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
            };
            for _ in 0..if twice { 2 } else { 1 } {
                state.check(lease)?;
                mouse(down, 0, 0, 0, lease)?;
                // Key/button release deliberately does not require an active lease.
                mouse(up, 0, 0, 0, lease)?;
            }
        }
        Action::Drag { x, y, to_x, to_y } => {
            move_to(state, lease, x, y)?;
            state.check(lease)?;
            mouse(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, lease)?;
            let result: Result<(), String> = (|| {
                for step in 1..=30 {
                    move_to(
                        state,
                        lease,
                        x + (((i64::from(to_x) - i64::from(x)) * step) / 30) as i32,
                        y + (((i64::from(to_y) - i64::from(y)) * step) / 30) as i32,
                    )?;
                    std::thread::sleep(Duration::from_millis(10));
                }
                Ok(())
            })();
            let released = mouse(MOUSEEVENTF_LEFTUP, 0, 0, 0, lease);
            result?;
            released?;
        }
        Action::Scroll { x, y, delta } => {
            if !(-1200..=1200).contains(&delta) {
                return Err("Scroll delta must be between -1200 and 1200".into());
            }
            move_to(state, lease, x, y)?;
            state.check(lease)?;
            mouse(MOUSEEVENTF_WHEEL, 0, 0, delta as u32, lease)?;
        }
        Action::Key { keys } => {
            if keys.is_empty() || keys.len() > 5 {
                return Err("Use one key or a combination of at most five keys".into());
            }
            let keys: Vec<u16> = keys
                .iter()
                .map(|name| virtual_key(name).ok_or_else(|| format!("Unsupported key: {name}")))
                .collect::<Result<_, _>>()?;
            let mut held = Vec::new();
            let result: Result<(), String> = (|| {
                for vk in keys {
                    state.check(lease)?;
                    key(vk, 0, extended(vk), lease)?;
                    held.push(vk);
                }
                Ok(())
            })();
            let mut release_error = None;
            for vk in held.into_iter().rev() {
                if let Err(error) = key(vk, 0, KEYEVENTF_KEYUP | extended(vk), lease) {
                    release_error = Some(error);
                }
            }
            result?;
            if let Some(error) = release_error {
                return Err(error);
            }
        }
        Action::Type { text } => {
            if text.chars().count() > 2000 {
                return Err("Type at most 2000 characters per action".into());
            }
            for unit in text.encode_utf16() {
                state.check(lease)?;
                let (vk, scan, flags) = if unit == 10 {
                    (VK_RETURN, 0, 0)
                } else if unit == 9 {
                    (VK_TAB, 0, 0)
                } else {
                    (0, unit, KEYEVENTF_UNICODE)
                };
                key(vk, scan, flags, lease)?;
                key(vk, scan, flags | KEYEVENTF_KEYUP, lease)?;
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    }
    state.check(lease)
}

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().any(|arg| arg == "--restore-cursor") {
        restore_cursor();
        return Ok(());
    }
    unsafe {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let (events, output) = mpsc::channel::<Value>();
    let state = Arc::new(State {
        lease: AtomicU64::new(0),
        heartbeat: AtomicU64::new(0),
        escape_held: AtomicBool::new(false),
        cursor_active: AtomicBool::new(false),
        started: Instant::now(),
        events,
    });
    SHARED
        .set(state.clone())
        .map_err(|_| "Already initialized")?;
    std::thread::spawn(move || {
        let stdout = io::stdout();
        let mut out = stdout.lock();
        for event in output {
            if writeln!(out, "{event}").and_then(|_| out.flush()).is_err() {
                std::process::exit(1);
            }
        }
    });
    let (ready_tx, ready_rx) = mpsc::channel();
    std::thread::spawn(move || unsafe {
        let hook = SetWindowsHookExW(
            WH_KEYBOARD_LL,
            Some(keyboard),
            GetModuleHandleW(std::ptr::null()),
            0,
        );
        let mouse = SetWindowsHookExW(
            WH_MOUSE_LL,
            Some(mouse_hook),
            GetModuleHandleW(std::ptr::null()),
            0,
        );
        let ok = !hook.is_null() && !mouse.is_null();
        let _ = ready_tx.send(ok);
        if !ok {
            if !hook.is_null() {
                UnhookWindowsHookEx(hook);
            }
            if !mouse.is_null() {
                UnhookWindowsHookEx(mouse);
            }
            return;
        }
        let mut message: MSG = std::mem::zeroed();
        while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {}
        UnhookWindowsHookEx(hook);
        UnhookWindowsHookEx(mouse);
        if let Some(state) = SHARED.get() {
            state.revoke("stop_listener_lost");
        }
    });
    if !ready_rx.recv_timeout(Duration::from_secs(5))? {
        return Err("Could not arm the physical Escape listener".into());
    }
    let watchdog = state.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(10));
        if watchdog
            .now()
            .saturating_sub(watchdog.heartbeat.load(Ordering::SeqCst))
            > HEARTBEAT_MS
        {
            watchdog.revoke("heartbeat_lost");
        }
        let _cursor = CURSOR_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if watchdog.lease.load(Ordering::SeqCst) == 0
            && watchdog.cursor_active.swap(false, Ordering::SeqCst)
        {
            restore_cursor();
        }
    });
    let (actions, work) = mpsc::sync_channel::<Command>(1);
    let worker = state.clone();
    std::thread::spawn(move || {
        for command in work {
            let action = match command.action {
                Some(action) => action,
                None => {
                    let _ = worker.events.send(json!({"id":command.id,"ok":false,"rejected":true,"error":"No input was sent: missing action. Observe again."}));
                    continue;
                }
            };
            if let Err(error) = validate_action(&action) {
                let _ = worker.events.send(json!({"id":command.id,"ok":false,"rejected":true,"error":format!("No input was sent: {error} Observe again before correcting the action.")}));
                continue;
            }
            let result = perform(&worker, command.lease, action);
            let reply = match result {
                Ok(()) => json!({"id":command.id,"ok":true}),
                Err(error) => {
                    worker.revoke("input_error");
                    json!({"id":command.id,"ok":false,"error":error})
                }
            };
            let _ = worker.events.send(reply);
        }
    });
    state.events.send(json!({"event":"ready", "protocol":1}))?;
    let cursor_guard = CursorGuard(state.clone());
    let mut input = io::stdin().lock();
    loop {
        // Bound each private-channel message even if main misbehaves.
        let mut line = String::new();
        let bytes = input.by_ref().take(128 * 1024).read_line(&mut line)?;
        if bytes == 0 {
            break;
        }
        if !line.ends_with('\n') {
            return Err("Input message too large".into());
        }
        let command: Command = serde_json::from_str(&line)?;
        let reply = match command.op.as_str() {
            "ping" => {
                state.heartbeat.store(state.now(), Ordering::SeqCst);
                continue;
            }
            "arm" if command.lease != 0 && command.lease <= (!TAG_MASK) as u64 => {
                let _cursor = CURSOR_LOCK
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                if state.is_escape_held() {
                    json!({"id":command.id,"ok":false,"error":"Release Escape before resuming"})
                } else if !style_cursor() {
                    json!({"id":command.id,"ok":false,"error":"Could not style the system cursor"})
                } else {
                    state.heartbeat.store(state.now(), Ordering::SeqCst);
                    state.lease.store(command.lease, Ordering::SeqCst);
                    state.cursor_active.store(true, Ordering::SeqCst);
                    json!({"id":command.id,"ok":true})
                }
            }
            "revoke" => {
                state.revoke("stopped");
                json!({"id":command.id,"ok":true})
            }
            "act" => match actions.try_send(command) {
                Ok(()) => continue,
                Err(
                    mpsc::TrySendError::Full(command) | mpsc::TrySendError::Disconnected(command),
                ) => {
                    json!({"id":command.id,"ok":false,"error":"Input queue busy; do not replay the action"})
                }
            },
            _ => json!({"id":command.id,"ok":false,"error":"Unknown helper operation"}),
        };
        state.events.send(reply)?;
    }
    drop(cursor_guard);
    // Give a bounded input worker a chance to release held keys/buttons on EOF.
    drop(actions);
    std::thread::sleep(Duration::from_millis(100));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsupported_key_combinations_are_rejected_before_input() {
        assert!(validate_action(&Action::Key {
            keys: vec!["Ctrl+L".into()]
        })
        .is_err());
        assert!(validate_action(&Action::Key {
            keys: vec!["Control".into(), "L".into()]
        })
        .is_ok());
        assert!(validate_action(&Action::Scroll {
            x: 0,
            y: 0,
            delta: 1201
        })
        .is_err());
    }
    #[test]
    fn revoked_generations_cannot_run_or_resume_themselves() {
        let (events, _) = mpsc::channel();
        let state = State {
            lease: AtomicU64::new(7),
            heartbeat: AtomicU64::new(0),
            escape_held: AtomicBool::new(false),
            cursor_active: AtomicBool::new(false),
            started: Instant::now(),
            events,
        };
        assert!(state.check(7).is_ok());
        state.revoke("escape");
        assert!(state.check(7).is_err());
        state.lease.store(8, Ordering::SeqCst);
        assert!(state.check(7).is_err());
        assert!(state.check(8).is_ok());
        assert!(state.check(0).is_err());
    }
    #[test]
    fn validate_keys_before_injecting_anything() {
        assert_eq!(virtual_key("Control"), Some(VK_CONTROL));
        assert_eq!(virtual_key("Escape"), Some(VK_ESCAPE));
        assert_eq!(virtual_key("F12"), Some(VK_F12));
        assert_eq!(virtual_key("F13"), None);
        assert_eq!(virtual_key("unknown"), None);
        assert!(
            serde_json::from_value::<Action>(json!({"kind":"type","text":"ok","shell":"bad"}))
                .is_err()
        );
    }
    #[test]
    fn cursor_resource_is_valid_without_changing_the_system_cursor() {
        let mut resource = *include_bytes!("cursor.bin");
        unsafe {
            let cursor = CreateIconFromResourceEx(
                resource.as_mut_ptr(),
                resource.len() as u32,
                0,
                0x00030000,
                32,
                32,
                0,
            );
            assert!(!cursor.is_null());
            DestroyCursor(cursor);
        }
    }
    #[test]
    fn physical_escape_invalidates_input_at_delivery_and_allows_release() {
        let (events, _) = mpsc::channel();
        let state = Arc::new(State {
            lease: AtomicU64::new(41),
            heartbeat: AtomicU64::new(0),
            escape_held: AtomicBool::new(false),
            cursor_active: AtomicBool::new(false),
            started: Instant::now(),
            events,
        });
        assert!(SHARED.set(state.clone()).is_ok());
        let input = KBDLLHOOKSTRUCT {
            vkCode: VK_ESCAPE as u32,
            scanCode: 0,
            flags: 0,
            time: 0,
            dwExtraInfo: 0,
        };
        unsafe {
            assert_eq!(
                keyboard(0, WM_KEYDOWN as usize, &input as *const _ as isize),
                1
            );
            assert_eq!(state.lease.load(Ordering::SeqCst), 0);
            assert!(injected_is_revoked(TAG | 41));
            assert_eq!(
                keyboard(0, WM_KEYUP as usize, &input as *const _ as isize),
                1
            );
        }
        state.lease.store(42, Ordering::SeqCst);
        assert!(injected_is_revoked(TAG | 41));
        assert!(!injected_is_revoked(TAG | 42));
        assert!(!injected_is_revoked(0));

        // Missed WM_KEYUP recovery: if escape_held was left true after the
        // lease was revoked and Escape is no longer physically pressed,
        // is_escape_held() clears the stale flag instead of staying wedged.
        state.lease.store(0, Ordering::SeqCst);
        state.escape_held.store(true, Ordering::SeqCst);
        let physically_down =
            unsafe { (GetAsyncKeyState(i32::from(VK_ESCAPE)) as u16 & 0x8000) != 0 };
        if !physically_down {
            assert!(!state.is_escape_held());
            assert!(!state.escape_held.load(Ordering::SeqCst));
        }
    }
    #[test]
    fn cursor_guard_revokes_and_clears_active_cursor_on_drop() {
        let (events, rx) = mpsc::channel();
        let state = Arc::new(State {
            lease: AtomicU64::new(99),
            heartbeat: AtomicU64::new(0),
            escape_held: AtomicBool::new(false),
            cursor_active: AtomicBool::new(true),
            started: Instant::now(),
            events,
        });
        {
            let _guard = CursorGuard(state.clone());
        }
        assert_eq!(state.lease.load(Ordering::SeqCst), 0);
        assert!(!state.cursor_active.load(Ordering::SeqCst));
        let event = rx.try_recv().expect("revoked event emitted on drop");
        assert_eq!(event["event"], "revoked");
        assert_eq!(event["reason"], "owner_disconnected");
    }
}
