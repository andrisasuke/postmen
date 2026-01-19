# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PostMen is a Dragon Ball themed REST API client desktop application built with Rust and Dioxus 0.6. It provides a GUI for testing and debugging REST APIs with features like request management, hostname configuration, and response viewing.

## Build Commands

```bash
# Development build and run
cargo run

# Release build
cargo build --release

# Check for compilation errors
cargo check

# Run clippy lints
cargo clippy
```

## Architecture

### Technology Stack
- **UI Framework**: Dioxus 0.7 (desktop feature) - React-like Rust framework
- **HTTP Client**: reqwest with json and multipart support
- **Database**: SQLite via rusqlite (bundled)
- **Async Runtime**: Tokio
- **Native Menus**: muda (re-exported from dioxus::desktop::muda)

### Project Structure

```
src/
├── main.rs          # App entry, window config, native menu setup
├── app.rs           # Main App component, all top-level state management
├── models/          # Data structures (Project, Request, Hostname, HttpResponse)
├── services/        # Database operations and HTTP request handling
├── state/           # App state types (Tab, ModalType, EditorTab, ResponseTab)
└── components/      # UI components
    ├── sidebar/     # Project tree, request items
    ├── editor/      # Request editor (URL bar, params, headers, body tabs)
    ├── response/    # Response panel
    └── modals/      # Various modal dialogs
```

### Key Patterns

**State Management**: All application state lives in `app.rs` using Dioxus signals (`use_signal`). State is passed down to child components via props.

**Database**: SQLite database stored at `~/.postmen/postmen.db`. The `Database` struct in `services/database.rs` handles all CRUD operations with table migrations in `init_tables()`.

**Styling**: Single CSS file at `assets/styles/main.css` using CSS variables for theming. CSS is embedded at compile time via `include_str!`.

**Modal System**: `ModalType` enum in `state/app_state.rs` controls which modal is displayed. Set via `modal.set(ModalType::...)`.

### Data Flow

1. Database loads projects, requests, and hostnames on app start
2. User interactions update signals in `app.rs`
3. HTTP requests use `HttpService::send_request()` or `send_multipart_request()`
4. Responses stored in `responses` HashMap keyed by request ID

### Component Communication

Components receive data via props and communicate back via `EventHandler` callbacks:
- `on_update`, `on_change` - data changes
- `on_delete`, `on_rename` - actions
- `on_close`, `on_cancel` - dismissals
