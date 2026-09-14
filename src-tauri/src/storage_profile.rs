//! Select storage before Tauri creates plugins, windows or application paths.
//! Production keeps its existing identity and WebView store; there is no migration.
use tauri::utils::config::Config;

// Stable across dev restarts, distinct from production's default WebKit store.
// Set at runtime: tauri-utils 2.9.3 cannot generate this array from JSON config.
const DEV_WEBKIT_STORE: [u8; 16] = [
    0x76, 0xe2, 0x51, 0x92, 0x85, 0x40, 0x46, 0x71, 0xa2, 0x49, 0xb0, 0x81, 0x3f, 0x65, 0xd2, 0x0a,
];

fn configure(config: &mut Config, development: bool, isolated_qa: bool) {
    if !development || isolated_qa {
        return;
    }
    if !config.identifier.ends_with(".dev") {
        config.identifier.push_str(".dev");
    }
    for window in &mut config.app.windows {
        // Windows/Linux default to LocalData/<config.identifier>. Do not use
        // WindowConfig's relative data_directory: the locked Tauri version
        // resolves it under LocalData/<window.label>, without the app identity.
        // macOS uses the explicit WebKit UUID instead of data_directory.
        window.data_directory = None;
        window.data_store_identifier = Some(DEV_WEBKIT_STORE);
        window.incognito = false;
    }
}

pub fn prepare(config: &mut Config) -> Result<(), &'static str> {
    // Unlike debug_assertions, this distinguishes `tauri dev --release` from
    // `tauri build --debug`. Native smoke has its own isolated DB/WebKit profiles.
    let development = tauri::is_dev();
    let isolated_qa = cfg!(all(feature = "native-smoke", target_os = "macos"));
    #[cfg(target_os = "macos")]
    if development && !isolated_qa && !objc2::available!(macos = 14.0) {
        // Older WebKit silently falls back to the shared default store.
        return Err("Isolated development storage requires macOS 14 or newer. Production storage has not been opened.");
    }
    configure(config, development, isolated_qa);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Config {
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap()
    }

    #[test]
    fn production_keeps_all_existing_storage_and_window_settings() {
        let mut config = base();
        let before = serde_json::to_value(&config).unwrap();
        configure(&mut config, false, false);
        assert_eq!(config.identifier, "com.postmen.desktop");
        assert_eq!(serde_json::to_value(&config).unwrap(), before);
    }

    #[test]
    fn dev_uses_separate_persistent_database_window_and_webview_namespaces() {
        let mut config = base();
        configure(&mut config, true, false);
        assert_eq!(config.identifier, "com.postmen.desktop.dev");
        for window in &config.app.windows {
            assert_eq!(window.data_store_identifier, Some(DEV_WEBKIT_STORE));
            assert!(window.data_directory.is_none());
            assert!(!window.incognito);
        }
        // Only identity/storage differ; layout, URL, permissions and CSP stay intact.
        config.identifier = base().identifier;
        for window in &mut config.app.windows {
            window.data_directory = None;
            window.data_store_identifier = None;
        }
        assert_eq!(
            serde_json::to_value(config).unwrap(),
            serde_json::to_value(base()).unwrap()
        );
    }

    #[test]
    fn dev_profile_is_stable_and_does_not_accumulate_suffixes() {
        let mut first = base();
        let mut restarted = base();
        configure(&mut first, true, false);
        configure(&mut restarted, true, false);
        configure(&mut restarted, true, false);
        assert_eq!(
            serde_json::to_value(first).unwrap(),
            serde_json::to_value(restarted).unwrap()
        );
    }

    #[test]
    fn dev_overrides_shared_webview_paths_for_every_configured_window() {
        let mut config = base();
        let mut secondary = config.app.windows[0].clone();
        secondary.label = "secondary".into();
        config.app.windows.push(secondary);
        for window in &mut config.app.windows {
            window.data_directory = Some("shared-production-cache".into());
            window.data_store_identifier = Some([2; 16]);
            window.incognito = true;
        }
        configure(&mut config, true, false);
        for window in &config.app.windows {
            assert!(window.data_directory.is_none());
            assert_eq!(window.data_store_identifier, Some(DEV_WEBKIT_STORE));
            assert!(!window.incognito);
        }
        assert_eq!(config.app.windows[1].label, "secondary");
    }

    #[test]
    fn native_smoke_profiles_remain_untouched_in_both_build_modes() {
        for development in [false, true] {
            let mut config = base();
            config.identifier = "com.postmen.nativeqa.example".into();
            config.app.windows[0].create = false;
            config.app.windows[0].data_store_identifier = Some([1; 16]);
            let before = serde_json::to_value(&config).unwrap();
            configure(&mut config, development, true);
            assert_eq!(serde_json::to_value(config).unwrap(), before);
        }
    }
}
