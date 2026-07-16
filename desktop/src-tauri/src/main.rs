// Trundler desktop shell: spawns the Node backend as a Tauri sidecar and opens
// a system-webview window at its localhost URL. No bundled browser engine —
// WKWebView/WebView2/WebKitGTK are patched by the OS vendor.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// Holds the sidecar handle so we can kill it on exit.
struct Sidecar(Mutex<Option<CommandChild>>);

fn free_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .expect("bind 127.0.0.1:0")
        .local_addr()
        .expect("local_addr")
        .port()
}

fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second launch: focus the existing window instead of a new instance.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            // Dev escape hatch: point the window at an already-running
            // `npm run dev` web server instead of spawning the sidecar.
            let url = if let Ok(ext) = std::env::var("TRUNDLER_DESKTOP_EXTERNAL") {
                ext
            } else {
                let port = free_port();
                let server_mjs = app
                    .path()
                    .resource_dir()?
                    .join("server")
                    .join("server.mjs");

                let (mut rx, child) = app
                    .shell()
                    .sidecar("node")?
                    .args([server_mjs.to_string_lossy().as_ref()])
                    .env("TRUNDLER_WEB_PORT", port.to_string())
                    .spawn()?;

                // Drain sidecar output so its stdio pipes never fill up and
                // block the child (e.g. Playwright's Chromium download logs).
                tauri::async_runtime::spawn(async move {
                    while rx.recv().await.is_some() {}
                });

                *app.state::<Sidecar>().0.lock().unwrap() = Some(child);

                if !wait_for_port(port, Duration::from_secs(20)) {
                    return Err("backend did not start listening within 20s".into());
                }
                format!("http://127.0.0.1:{port}")
            };

            let parsed: tauri::Url = url.parse()?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
                .title("Trundler")
                .inner_size(1100.0, 800.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(child) = app.state::<Sidecar>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
