//! Apioni IDE — Tauri desktop backend.
//!
//! Owns PTY sessions (portable-pty) and bridges them to the xterm.js frontend:
//!   * `pty_spawn` opens a shell PTY and streams its output to a Tauri `Channel`
//!     (raw byte chunks via `InvokeResponseBody::Raw` → ArrayBuffer; no base64).
//!   * `pty_write` forwards keystrokes / pasted / IME-composed text to the PTY.
//!   * `pty_resize` resizes the PTY when the terminal grid changes.
//!
//! xterm.js (frontend) does VT rendering + IME (Korean and all other languages),
//! which is the whole reason for the Tauri + web re-platform.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry,
};
// The Overlay title-bar style is a macOS-only builder API.
#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;

static WIN_SEQ: AtomicU32 = AtomicU32::new(1);
// PTY ids are assigned by the backend so they are unique across ALL windows.
// (Generating them per-window in the frontend collided when two windows both
// counted from 1 — and the pane→window pop-out below needs a stable global id.)
static PTY_SEQ: AtomicU32 = AtomicU32::new(1);

struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    /// The spawned shell — kept so `pty_close`/window-close can kill + reap it
    /// (otherwise the shell, its reader thread, and a zombie leak per close).
    child: Box<dyn Child + Send + Sync>,
    /// The frontend sink for this PTY's output. Swappable (raw bytes) so a pane can
    /// be re-attached to a different window (pop-out) without losing the shell.
    channel: Arc<Mutex<Channel<InvokeResponseBody>>>,
    /// Label of the window that currently owns this PTY (re-parented on pop-out).
    /// Lets a native window close reap the shells that window owned.
    window: String,
}

#[derive(Default)]
struct Sessions(Mutex<HashMap<u32, Session>>);

/// Kill a shell's whole foreground process group (so vim / dev-servers / etc. die
/// with it), then reap the zombie. Best-effort — a closing pane must never panic.
fn reap(mut session: Session) {
    // Unix: the PTY shell is its own session/group leader (pgid == pid), so signalling
    // the group also takes down its foreground descendants; killing only the pid would
    // orphan them. On Windows there is no process group here — closing the ConPTY and
    // killing the child (below) tears the tree down.
    #[cfg(unix)]
    if let Some(pid) = session.child.process_id() {
        unsafe {
            libc::killpg(pid as i32, libc::SIGKILL);
        }
    }
    let _ = session.child.kill();
    let _ = session.child.wait();
}

#[tauri::command]
fn pty_spawn(
    sessions: State<Sessions>,
    window: WebviewWindow,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    let id = PTY_SEQ.fetch_add(1, Ordering::Relaxed);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(shell);
    cmd.env("TERM", "xterm-256color");
    if let Ok(home) = std::env::var("HOME") {
        cmd.cwd(home);
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let channel = Arc::new(Mutex::new(on_data));
    sessions.0.lock().unwrap().insert(
        id,
        Session {
            writer,
            master: pair.master,
            child,
            channel: Arc::clone(&channel),
            window: window.label().to_string(),
        },
    );

    // Stream raw PTY output to the frontend as raw byte chunks (no base64: it saved
    // no round-trips and forced a per-byte atob/charCodeAt decode on the JS main
    // thread that scaled with total output). `InvokeResponseBody::Raw` arrives as an
    // ArrayBuffer. Read through the swappable channel so a re-attach (pop-out) keeps
    // streaming; a send error just means the sink is momentarily gone (mid-detach) —
    // drop the chunk, don't kill the reader. The thread exits at EOF, which the
    // kill()+reap on close forces by taking the slave down.
    std::thread::spawn(move || {
        let mut buf = [0u8; 65536];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(sink) = channel.lock() {
                        let _ = sink.send(InvokeResponseBody::Raw(buf[..n].to_vec()));
                    }
                }
            }
        }
    });

    Ok(id)
}

/// Re-point an existing PTY's output to a new frontend channel (used when a pane
/// is popped out into a separate window and re-attaches to the same shell).
#[tauri::command]
fn pty_attach(
    sessions: State<Sessions>,
    window: WebviewWindow,
    id: u32,
    on_data: Channel<InvokeResponseBody>,
) {
    if let Some(s) = sessions.0.lock().unwrap().get_mut(&id) {
        if let Ok(mut sink) = s.channel.lock() {
            *sink = on_data;
        }
        // Ownership moves to the attaching window so closing the ORIGIN window no
        // longer reaps a shell the pop-out now owns.
        s.window = window.label().to_string();
    }
}

/// Open a new window that re-attaches to an existing PTY (pane → window).
#[tauri::command]
fn popout_pane(app: AppHandle, id: u32) {
    let n = WIN_SEQ.fetch_add(1, Ordering::Relaxed);
    // `mut` is used only on macOS (the cfg block below); harmless elsewhere.
    #[allow(unused_mut)]
    let mut b = WebviewWindowBuilder::new(
        &app,
        format!("win-{n}"),
        WebviewUrl::App(format!("index.html?attach={id}").into()),
    )
    .title("Apioni IDE")
    .inner_size(1100.0, 760.0)
    // Let the DOM receive `drop` (otherwise WRY's native handler eats it).
    .disable_drag_drop_handler();
    // macOS: traffic lights overlay the content, no title bar / text. Windows and
    // Linux use their native window controls.
    #[cfg(target_os = "macos")]
    {
        b = b.title_bar_style(TitleBarStyle::Overlay).hidden_title(true);
    }
    let _ = b.build();
}

#[tauri::command]
fn pty_write(sessions: State<Sessions>, id: u32, data: String) -> Result<(), String> {
    if let Some(s) = sessions.0.lock().unwrap().get_mut(&id) {
        s.writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        s.writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pty_resize(sessions: State<Sessions>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    if let Some(s) = sessions.0.lock().unwrap().get(&id) {
        s.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pty_close(sessions: State<Sessions>, id: u32) {
    // Take the session OUT under the lock, then reap outside it (kill+wait can block).
    let session = sessions.0.lock().unwrap().remove(&id);
    if let Some(s) = session {
        reap(s);
    }
}

// ── Filesystem (sidebar file tree + editor) ──────────────────────────────────

#[derive(Serialize)]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[tauri::command]
fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| ".".to_string())
}

#[tauri::command]
fn list_dir(path: String) -> Vec<FileEntry> {
    let mut out: Vec<FileEntry> = std::fs::read_dir(&path)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    if name.starts_with('.') {
                        return None;
                    }
                    let p = e.path();
                    let is_dir = p.is_dir();
                    Some(FileEntry {
                        name,
                        path: p.to_string_lossy().into_owned(),
                        is_dir,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    out
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("file too large (>4 MB)".to_string());
    }
    if bytes.contains(&0) {
        return Err("binary file".to_string());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Close the calling window; if it's the last window, quit the app.
#[tauri::command]
fn close_window(app: AppHandle, window: WebviewWindow) {
    if app.webview_windows().len() <= 1 {
        app.exit(0);
    } else {
        let _ = window.close();
    }
}

/// Build the native menu bar. Custom items carry accelerators (= native global
/// shortcuts) and emit a `menu` event to the frontend; predefined items (Copy,
/// Paste, Quit, …) are handled natively by the OS/webview.
fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<Wry>> {
    let item = |id: &str, text: &str, accel: &str| {
        MenuItemBuilder::with_id(id, text).accelerator(accel).build(app)
    };

    let app_menu = SubmenuBuilder::new(app, "Apioni IDE")
        .item(&PredefinedMenuItem::about(app, Some("Apioni IDE"), None)?)
        .separator()
        .item(&item("settings", "Settings…", "CmdOrCtrl+,")?)
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&item("new_tab", "New Tab", "CmdOrCtrl+T")?)
        .item(&item("new_window", "New Window", "CmdOrCtrl+N")?)
        .separator()
        .item(&item("save", "Save", "CmdOrCtrl+S")?)
        .item(&item("print", "Print…", "CmdOrCtrl+P")?)
        .separator()
        .item(&item("close", "Close Tab", "CmdOrCtrl+W")?)
        .build()?;

    // Copy / Select All are custom (not predefined) so the frontend can grab the
    // terminal's WebGL selection, which the OS `copy:` responder can't see.
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&item("copy", "Copy", "CmdOrCtrl+C")?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&item("select_all", "Select All", "CmdOrCtrl+A")?)
        .separator()
        .item(&item("find", "Find…", "CmdOrCtrl+F")?)
        .item(&item("find_next", "Find Next", "CmdOrCtrl+G")?)
        .item(&item("find_prev", "Find Previous", "CmdOrCtrl+Shift+G")?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&item("toggle_sidebar", "Toggle Sidebar", "CmdOrCtrl+B")?)
        .separator()
        .item(&item("zoom_in", "Zoom In", "CmdOrCtrl+=")?)
        .item(&item("zoom_out", "Zoom Out", "CmdOrCtrl+-")?)
        .item(&item("zoom_reset", "Reset Zoom", "CmdOrCtrl+0")?)
        .separator()
        .item(&item("clear", "Clear Terminal", "CmdOrCtrl+K")?)
        .build()?;

    let terminal = SubmenuBuilder::new(app, "Terminal")
        .item(&item("split_right", "Split Right", "CmdOrCtrl+Backslash")?)
        .item(&item("split_down", "Split Down", "CmdOrCtrl+Shift+D")?)
        .separator()
        .item(&item("focus_prev", "Focus Previous Pane", "CmdOrCtrl+Alt+Left")?)
        .item(&item("focus_next", "Focus Next Pane", "CmdOrCtrl+Alt+Right")?)
        .build()?;

    let window = SubmenuBuilder::new(app, "Window")
        .item(&item("prev_tab", "Previous Tab", "CmdOrCtrl+Shift+BracketLeft")?)
        .item(&item("next_tab", "Next Tab", "CmdOrCtrl+Shift+BracketRight")?)
        .separator()
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &view, &terminal, &window])
        .build()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Sessions::default())
        .menu(build_menu)
        .on_menu_event(|app, event| {
            let id = event.id().0.clone();
            if id == "new_window" {
                let n = WIN_SEQ.fetch_add(1, Ordering::Relaxed);
                #[allow(unused_mut)]
                let mut b = WebviewWindowBuilder::new(
                    app,
                    format!("win-{n}"),
                    WebviewUrl::App("index.html".into()),
                )
                .title("Apioni IDE")
                .inner_size(1280.0, 820.0)
                // Let the DOM receive `drop` (otherwise WRY's native handler eats it).
                .disable_drag_drop_handler();
                #[cfg(target_os = "macos")]
                {
                    b = b.title_bar_style(TitleBarStyle::Overlay).hidden_title(true);
                }
                let _ = b.build();
                return;
            }
            // Route to ONLY the focused window. `emit` is global in Tauri 2, so we
            // must `emit_to(label)` — otherwise every window reacts (the bug where
            // new tabs/closes happened in all windows at once).
            if let Some(w) = app
                .webview_windows()
                .values()
                .find(|w| w.is_focused().unwrap_or(false))
            {
                let _ = app.emit_to(w.label(), "menu", id);
            }
        })
        .on_window_event(|window, event| {
            // A native window close (red button / Window menu) tears down the webview
            // WITHOUT running the JS closePane→pty_close path, so every PTY that window
            // owned would leak (shell + reader thread + Sessions entry). Reap them here.
            if let tauri::WindowEvent::Destroyed = event {
                let label = window.label().to_string();
                let sessions = window.state::<Sessions>();
                let removed: Vec<Session> = {
                    let mut map = sessions.0.lock().unwrap();
                    let ids: Vec<u32> = map
                        .iter()
                        .filter(|(_, s)| s.window == label)
                        .map(|(id, _)| *id)
                        .collect();
                    ids.into_iter().filter_map(|id| map.remove(&id)).collect()
                };
                for s in removed {
                    reap(s);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn, pty_write, pty_resize, pty_close, pty_attach, popout_pane, close_window,
            home_dir, list_dir, read_file, write_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Apioni IDE");
}
