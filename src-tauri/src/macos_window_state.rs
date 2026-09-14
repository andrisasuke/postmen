//! Preserve NORMAL bounds across native Zoom's multiple intermediate move events.
//! Windows/Linux keep the existing window-state plugin. Same v1 preference file;
//! no database access, migration, global display change, or frontend bounds input.
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::{io::Read, path::PathBuf, sync::Mutex, time::Duration};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
struct Bounds {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Saved {
    #[serde(flatten)]
    bounds: Bounds,
    prev_x: i32,
    prev_y: i32,
    maximized: bool,
    #[serde(default = "yes")]
    visible: bool,
    #[serde(default = "yes")]
    decorated: bool,
    #[serde(default)]
    fullscreen: bool,
}
fn yes() -> bool {
    true
}
#[derive(Serialize, Deserialize)]
struct Document {
    main: Saved,
}
pub struct WindowState {
    path: PathBuf,
    normal: Mutex<Bounds>,
}

impl Saved {
    fn normal(&self) -> Option<Bounds> {
        let mut result = self.bounds;
        if self.maximized {
            result.x = self.prev_x;
            result.y = self.prev_y;
        }
        (result.width >= 700
            && result.height >= 400
            && result.width <= 38400
            && result.height <= 21600)
            .then_some(result)
    }
    fn from_normal(bounds: Bounds, maximized: bool) -> Self {
        Self {
            bounds,
            prev_x: bounds.x,
            prev_y: bounds.y,
            maximized,
            visible: true,
            decorated: true,
            fullscreen: false,
        }
    }
}
fn current(window: &WebviewWindow) -> tauri::Result<Bounds> {
    let size = window.inner_size()?;
    let position = window.outer_position()?;
    Ok(Bounds {
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
    })
}
pub fn capture_normal(window: &WebviewWindow) {
    if !matches!(window.is_maximized(), Ok(false))
        || !matches!(window.is_minimized(), Ok(false))
        || !matches!(window.is_fullscreen(), Ok(false))
    {
        return;
    }
    if let (Some(state), Ok(bounds)) = (window.try_state::<WindowState>(), current(window)) {
        if bounds.width > 0 && bounds.height > 0 {
            if let Ok(mut normal) = state.normal.lock() {
                *normal = bounds;
            }
        }
    }
}

pub fn install(app: &AppHandle, path: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let window = app.get_webview_window("main").ok_or("No main window")?;
    let saved = std::fs::File::open(&path)
        .ok()
        .and_then(|file| {
            let mut bytes = Vec::new();
            file.take(65537).read_to_end(&mut bytes).ok().map(|_| bytes)
        })
        .filter(|bytes| bytes.len() <= 65536)
        .and_then(|bytes| serde_json::from_slice::<Document>(&bytes).ok())
        .map(|doc| doc.main);
    let mut normal = current(&window)?;
    if let Some(saved) = saved {
        if let Some(bounds) = saved.normal() {
            window.set_size(PhysicalSize::new(bounds.width, bounds.height))?;
            // Keep a usable titlebar on a connected display. Never move onto a
            // disappeared monitor; let the OS place the restored size instead.
            if window
                .available_monitors()?
                .iter()
                .any(|monitor| reachable(bounds, *monitor.position(), *monitor.size()))
            {
                window.set_position(PhysicalPosition::new(bounds.x, bounds.y))?;
            }
            normal = current(&window)?;
            if saved.maximized {
                window.maximize()?;
            }
        }
    }
    app.manage(WindowState {
        path,
        normal: Mutex::new(normal),
    });
    // Coalesce transition events in ONE worker, rather than saving every animated
    // Moved event into prev_x/prev_y. Capture pre-Zoom synchronously as well.
    let (sender, mut receiver) = tokio::sync::watch::channel(());
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
            sender.send_replace(());
        }
    });
    tauri::async_runtime::spawn(async move {
        while receiver.changed().await.is_ok() {
            loop {
                tokio::select! {
                    result = receiver.changed() => if result.is_err() { return; },
                    _ = tokio::time::sleep(Duration::from_millis(250)) => break,
                }
            }
            let target = window.clone();
            let _ = window.run_on_main_thread(move || capture_normal(&target));
        }
    });
    Ok(())
}

fn reachable(bounds: Bounds, position: PhysicalPosition<i32>, size: PhysicalSize<u32>) -> bool {
    let x = i64::from(bounds.x);
    let y = i64::from(bounds.y);
    let left = i64::from(position.x);
    let top = i64::from(position.y);
    x + i64::from(bounds.width) >= left + 100
        && x + 100 <= left + i64::from(size.width)
        && y >= top
        && y + 32 <= top + i64::from(size.height)
}

pub fn toggle_zoom(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let result = if window.is_maximized().unwrap_or(false) {
            window.unmaximize()
        } else {
            capture_normal(&window);
            window.maximize()
        };
        if let Err(error) = result {
            eprintln!("Could not change window Zoom: {error}");
        }
    }
}

pub fn save(app: &AppHandle) -> AppResult<()> {
    let error = || {
        AppError::new("WINDOW_STATE_ERROR", "Window state could not be saved. Retry or explicitly quit without saving session/window state.")
    };
    let window = app.get_webview_window("main").ok_or_else(error)?;
    capture_normal(&window);
    let state = app.state::<WindowState>();
    let normal = *state.normal.lock().map_err(|_| error())?;
    let saved = Saved::from_normal(normal, window.is_maximized().map_err(|_| error())?);
    let bytes = serde_json::to_vec_pretty(&Document { main: saved }).map_err(|_| error())?;
    let parent = state.path.parent().ok_or_else(error)?;
    std::fs::create_dir_all(parent).map_err(|_| error())?;
    // A failed save never truncates the last good preference file.
    let temporary = state.path.with_extension("json.tmp");
    std::fs::write(&temporary, bytes).map_err(|_| error())?;
    std::fs::rename(&temporary, &state.path).map_err(|_| error())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maximized_round_trip_preserves_normal_bounds() {
        let bounds = Bounds {
            width: 2200,
            height: 1440,
            x: 240,
            y: 160,
        };
        let encoded = serde_json::to_vec(&Saved::from_normal(bounds, true)).unwrap();
        let decoded: Saved = serde_json::from_slice(&encoded).unwrap();
        assert!(decoded.maximized);
        assert_eq!(decoded.normal(), Some(bounds));
        assert_eq!(Saved::from_normal(bounds, false).normal(), Some(bounds));
    }
    #[test]
    fn reads_existing_v1_maximized_position_without_database_migration() {
        let saved: Saved = serde_json::from_str(r#"{"width":2200,"height":1440,"x":0,"y":62,"prev_x":240,"prev_y":160,"maximized":true}"#).unwrap();
        assert_eq!(saved.normal().unwrap().x, 240);
        assert_eq!(saved.normal().unwrap().y, 160);
    }
    #[test]
    fn rejects_invalid_sizes_and_unreachable_titlebars() {
        let mut bounds = Bounds {
            width: 2200,
            height: 1440,
            x: 240,
            y: 160,
        };
        assert!(reachable(
            bounds,
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(2880, 1800)
        ));
        bounds.x = -5000;
        assert!(!reachable(
            bounds,
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(2880, 1800)
        ));
        assert!(reachable(
            bounds,
            PhysicalPosition::new(-5760, 0),
            PhysicalSize::new(2880, 1800)
        ));
        bounds.height = 0;
        assert!(Saved::from_normal(bounds, false).normal().is_none());
    }
}
