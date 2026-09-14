//! App-local input routing. No global monitor, synthetic input, or OS permissions.
use crate::error::{AppError, AppResult};
use block2::RcBlock;
use objc2::{rc::Retained, runtime::AnyObject};
use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags as Flags, NSEventType, NSWindow};
use std::{
    cell::RefCell,
    ptr::NonNull,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

thread_local! {
    // AppKit objects stay on the main thread, including their destruction.
    static MONITOR: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
    static MOUSE_DOWN: RefCell<Option<(Retained<NSEvent>, Instant)>> = const { RefCell::new(None) };
}

fn shortcut(code: u16, flags: Flags) -> Option<&'static str> {
    // NumericPad/Function/CapsLock bits do not change these physical-key shortcuts.
    let modifiers = flags & (Flags::Command | Flags::Control | Flags::Shift | Flags::Option);
    match (code, modifiers) {
        (36 | 76, value) if value == Flags::Command => Some("send-request"),
        (48, value) if value == Flags::Control => Some("next-request"),
        (48, value) if value == Flags::Control | Flags::Shift => Some("previous-request"),
        _ => None,
    }
}

pub fn install(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let window = app.get_webview_window("main").ok_or("No main window")?;
    // setup runs on AppKit's main thread; Tauri owns this NSWindow.
    let number = unsafe { &*window.ns_window()?.cast::<NSWindow>() }.windowNumber();
    let handler = RcBlock::new(move |pointer: NonNull<NSEvent>| -> *mut NSEvent {
        // AppKit guarantees a live event for the duration of its local callback.
        let event = unsafe { pointer.as_ref() };
        if event.windowNumber() != number {
            return pointer.as_ptr(); // Native picker/sheets and other windows are untouched.
        }
        if event.r#type() == NSEventType::LeftMouseDown {
            crate::macos_window_state::capture_normal(&window);
            MOUSE_DOWN.with(|slot| {
                *slot.borrow_mut() = unsafe { Retained::retain(pointer.as_ptr()) }
                    .map(|event| (event, Instant::now()));
            });
        } else if event.r#type() == NSEventType::KeyDown {
            if let Some(action) = shortcut(event.keyCode(), event.modifierFlags()) {
                // Route exactly once, BEFORE WKWebView consumes Return/Tab key equivalents.
                // The shared frontend action handler retains modal/execution guards.
                if !event.isARepeat() {
                    if let Err(error) = window.emit_to("main", "shell-action", action) {
                        eprintln!("Could not deliver native shortcut: {error}");
                        return pointer.as_ptr();
                    }
                }
                return std::ptr::null_mut();
            }
        }
        pointer.as_ptr()
    });
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(
            NSEventMask::LeftMouseDown | NSEventMask::KeyDown,
            &handler,
        )
    }
    .ok_or("Could not install PostMen local input routing")?;
    MONITOR.with(|slot| *slot.borrow_mut() = Some(monitor));
    Ok(())
}

pub fn drag(window: &WebviewWindow) -> AppResult<()> {
    let captured = MOUSE_DOWN.with(|slot| slot.borrow_mut().take());
    let Some((event, at)) = captured else {
        return Err(AppError::new(
            "INVALID_INPUT",
            "Drag requires a native pointer press.",
        ));
    };
    // Never manufacture an event from a global cursor coordinate. IPC may replace
    // NSApp.currentEvent; the retained original has the correct locationInWindow.
    if at.elapsed() > Duration::from_secs(1) || NSEvent::pressedMouseButtons() & 1 == 0 {
        return Ok(()); // A quick click/release is not a drag or an application error.
    }
    let pointer = window
        .ns_window()
        .map_err(|_| AppError::new("WINDOW_ERROR", "Window unavailable."))?;
    let native = unsafe { &*pointer.cast::<NSWindow>() };
    if event.windowNumber() != native.windowNumber() {
        return Err(AppError::new(
            "FORBIDDEN",
            "Drag belongs to a different window.",
        ));
    }
    native.performWindowDragWithEvent(&event);
    Ok(())
}

pub fn shutdown() {
    MONITOR.with(|slot| {
        if let Some(monitor) = slot.borrow_mut().take() {
            unsafe { NSEvent::removeMonitor(&monitor) };
        }
    });
    MOUSE_DOWN.with(|slot| slot.borrow_mut().take());
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn routes_only_the_three_affected_shortcuts() {
        assert_eq!(shortcut(36, Flags::Command), Some("send-request"));
        assert_eq!(
            shortcut(76, Flags::Command | Flags::NumericPad),
            Some("send-request")
        );
        assert_eq!(shortcut(48, Flags::Control), Some("next-request"));
        assert_eq!(
            shortcut(48, Flags::Control | Flags::Shift),
            Some("previous-request")
        );
        for (code, flags) in [
            (36, Flags::empty()),
            (36, Flags::Command | Flags::Shift),
            (36, Flags::Command | Flags::Option),
            (48, Flags::Command),
            (1, Flags::Command),
            (48, Flags::Control | Flags::Option),
        ] {
            assert_eq!(shortcut(code, flags), None);
        }
    }
}
