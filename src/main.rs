#![allow(non_snake_case)]

use dioxus::desktop::{Config, WindowBuilder, WindowCloseBehaviour, tao::window::Icon};
use muda::{Menu, MenuItem, PredefinedMenuItem, Submenu, accelerator::{Code, Modifiers, Accelerator}};

mod app;
mod components;
mod models;
mod services;
mod state;

use app::App;

fn load_icon() -> Option<Icon> {
    let icon_bytes = include_bytes!("../assets/icons/AppIcon.iconset/icon_256x256.png");
    let image = image::load_from_memory(icon_bytes).ok()?.into_rgba8();
    let (width, height) = image.dimensions();
    Icon::from_rgba(image.into_raw(), width, height).ok()
}

/// Create custom menu bar with interceptable quit
fn create_menu() -> Menu {
    let menu = Menu::new();

    // App menu (macOS) / Window menu
    let app_menu = Submenu::new("PostMen", true);
    app_menu
        .append_items(&[
            &PredefinedMenuItem::fullscreen(None),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::hide(None),
            &PredefinedMenuItem::hide_others(None),
            &PredefinedMenuItem::show_all(None),
            &PredefinedMenuItem::maximize(None),
            &PredefinedMenuItem::minimize(None),
            &PredefinedMenuItem::close_window(None),
            &PredefinedMenuItem::separator(),
            // Custom quit item instead of PredefinedMenuItem::quit
            // This allows us to intercept it in the app
            &MenuItem::with_id(
                "postmen-quit",
                "Quit PostMen",
                true,
                Some(Accelerator::new(Some(Modifiers::META), Code::KeyQ)),
            ),
        ])
        .unwrap();

    let edit_menu = Submenu::new("Edit", true);
    edit_menu
        .append_items(&[
            &PredefinedMenuItem::undo(None),
            &PredefinedMenuItem::redo(None),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::cut(None),
            &PredefinedMenuItem::copy(None),
            &PredefinedMenuItem::paste(None),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::select_all(None),
        ])
        .unwrap();

    menu.append_items(&[&app_menu, &edit_menu]).unwrap();

    #[cfg(target_os = "macos")]
    {
        app_menu.set_as_windows_menu_for_nsapp();
    }

    menu
}

fn main() {
    let mut window_builder = WindowBuilder::new()
        .with_title("PostMen")
        .with_resizable(true)
        .with_maximized(true);

    if let Some(icon) = load_icon() {
        window_builder = window_builder.with_window_icon(Some(icon));
    }

    let config = Config::new()
        .with_window(window_builder)
        .with_close_behaviour(WindowCloseBehaviour::LastWindowHides)
        .with_menu(create_menu());

    dioxus::LaunchBuilder::desktop()
        .with_cfg(config)
        .launch(App);
}
