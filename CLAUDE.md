# Repository guidance

Reconciled with source on November 11, 2026. Implementation state and validation evidence are separate.

## Working rules

- Follow active AGENTS.md instructions and /Users/andri/.codex/RTK.md: prefix shell commands with `rtk`.
- Inspect the actual branch and working tree before editing. Preserve unrelated changes and use the task's branch; old milestone branch names are historical. Commit, push, and publish within the user's authorized scope.
- The user currently prefers manual self-testing. Author and compile regression definitions, but leave application launches, browser/native automation, HTTP acceptance, and test-suite execution to the user unless explicitly authorized later. Static checks/builds are allowed. Report authored, compiled, executed, and manually verified checks separately.
- Restart native dev after Rust, command, capability, or Tauri configuration changes. Vite hot reload cannot apply them.
- Internal milestone identity remains M4. Larger-display, cross-monitor DPI, and full visual/product parity acceptance remain open. Keep work within the requested feature rather than inferring a new milestone.

## Sources and architecture

PostMen is a local-first REST client built with Tauri 2, Vue 3, strict TypeScript, Pinia, Rust, and SQLite. The archived desktop v4.1.0 baseline is a visual reference, not a second supported runtime.

- Read README.md for public features, setup, shortcuts, and storage behavior. Use package.json, native configuration, and source for exact commands, limits, and contracts.
- Current independent versions: **bootstrap IPC 5, SQLite 3, workspace catalog 1**. Before storage/IPC changes, inspect the database initializer, workspace registry, and frontend bootstrap validator.
- Private historical docs may be available through an ignored `docs` symlink to `/Users/andri/Documents/Obsidian Vault/PostMen/docs`, indexed by `PostMen/00 - PostMen.md`. This worktree currently lacks that symlink. When available, consult CURRENT_STATE.md, WORKSPACES_AND_STORAGE.md, COLLECTION_IMPORT_EXPORT.md, DEVELOPMENT_AND_QA.md, and IPC_CONTRACT.md for the relevant area, then reconcile with later source changes. Keep builds independent of the archive and keep it out of Git.
- For milestone/OS QA work, consult archived IMPLEMENTATION_PLAN.md, milestones/M4/README.md, and milestones/M4/os-input-fixed/README.md if available. Historical results are not acceptance evidence for later features.
- `frontend/src/app/WorkspaceApp.vue` coordinates connection, dialogs, keyboard actions, and active-request lifecycle. `stores/workspace.ts` owns drafts, saved requests, tabs/session, collections, and environments; `stores/workspaces.ts` owns catalog/transitions; `stores/execution.ts` owns live results and restoration.
- Vue SFCs use `<script setup lang="ts">`. DTOs/Zod schemas live in `frontend/src/types/`; services validate IPC responses. `services/desktop.ts` validates bootstrap/shell events and distinguishes browser from native.
- Reusable UI/layout lives in `components/`. Settings validates shell localStorage preferences and follows system theme changes.
- Native command/menu registration lives in `src-tauri/src/lib.rs`. Commands dispatch database work to blocking workers; repositories save requests and ordered rows atomically with revisions.
- New commands need the build manifest, invoke handler, generated permission, and narrow main-window capability. Keep broad filesystem/shell/network authority out of the frontend.
- Reference/workspace/execution/visual fixtures are DEV-only and excluded from production. They simulate behavior; none proves native IPC, SQLite, HTTP, or restart persistence.

## Requests and UI

- New Request offers HTTP and From cURL. Import parses text without executing commands or reading files/environment/stdin/network. Unsupported options fail visibly. Creation optionally accepts initial content and atomically writes request plus rows at revision 1.
- cURL import puts URL query and combined `-G` data into enabled Params rows with repeated names/order preserved. Store a query-free URL to avoid duplicate append-on-Send. Reject empty names and invalid UTF-8 percent encoding; enforce row/value limits. Existing requests are not rewritten automatically.
- `composables/useRequestQuery.ts` reconciles URL/Params through explicit setters. Opening must not dirty requests. Edits preserve matching row IDs/descriptions, duplicate order, disabled/scratch rows, fragments, and readable complete placeholders. Raw query spelling may normalize. KeyValueTable emits immutable array updates.
- Drafts and undo are independent per open request and memory-only. Send snapshots the visible draft without saving it. Unchanged saves return without IPC/toast; session/preference caches advance only after successful persistence so retries remain possible.
- Clone copies the open draft, otherwise saved data, into the same parent with new request/row IDs and unchanged attachment references/literal placeholders. It opens clean and does not copy results/history or modify/send the source.
- Collection creation/rename stays inline. Folder creation, request/folder rename, and Clone use dialogs with modal/dirty/busy guards. Hover ellipsis actions remain keyboard accessible.
- Cmd/Ctrl-click selects multiple requests in one collection. Dragging a selected request moves the group into a folder; dirty selections require Save All & Move or Cancel. Preserve revision, order, and unsaved-edit safeguards.
- Sidebar expansion persists in `settings.preferences.treeExpanded` by collection/folder UUID, missing entries default expanded, and Reset Layout retains it. Search overrides are temporary; collapsing parents preserves child states.
- Sidebar pointer-menu actions opt out of focus restoration to the hover ellipsis; keyboard selection/Escape restore focus. Other menu consumers retain default focus behavior.
- Toasts notify completed public mutations once, with bounded transient cards and no raw errors, credentials, names, or URLs. Nested actions, autosaves, no-op changes, Cancel, and keystrokes stay silent; failures retain inline details.
- Preserve cyan `#8BE2FA` in both themes with black filled-button text; method/status/syntax colors are independent.
- UiSelect stays inside modal focus boundaries and scrolls its option list rather than the workspace. SplitPanes retains resolved request width when sidebar collapses. Saved tab views take precedence over automatic Body selection.

## Workspaces and storage

- Startup opens the configured **default workspace**, not the last active workspace. Setting default leaves current selection unchanged.
- Title-bar selection supports create/switch. Manage Workspaces occupies main content with the sidebar retained. The current default cannot be deleted. Active nondefault deletion returns a preloaded default activation; inactive deletion preserves current tabs/results.
- Atomic bounded catalog `workspaces.v1.json` stores activeId/defaultId/live entries/removedWorkspaces. Limits: 100 live, 1000 removed, 2 MiB catalog.
- Deletion removes the catalog entry but retains database/WAL/SHM and saved responses for manual recovery. No in-app restore, workspace rename, or cross-workspace move flow exists.
- Initial workspace uses `postmen.sqlite3`; additional workspaces use `workspaces/<UUID>/postmen.sqlite3`. Requests, collection/global environments, attachments, history, result snapshots, and sessions are workspace-scoped. Theme/window geometry are app-level.
- Flush outgoing session before transitions and block dirty/running/pending/conflicting-modal work. Ambiguous IPC outcomes freeze writes until authoritative recovery. `Database::clone` captures its target before async work; switching must never retarget in-flight commands. Successful transitions invalidate staged import/export.
- macOS production profile: `~/Library/Application Support/com.postmen.desktop/`; dev profile uses `com.postmen.desktop.dev/`. `storage_profile::prepare` selects identity before Builder/plugins/windows and assigns a separate stable dev WebKit store. macOS dev requires 14+ to avoid shared-store fallback. Windows/Linux use identifier-scoped default WebView paths, not relative window data directories.
- Profile separation does not copy/migrate/delete the other profile or read it as fallback. New dev storage starts empty; native-smoke has separate isolated profiles.
- Fresh SQLite databases use schema 3. Recognized Tauri schemas 1/2 upgrade transactionally; v1 also retires Base URL and creates environments before adding snapshots. Preserve existing requests/session. Reject unrelated/newer schemas. Older schema-2-only builds cannot open upgraded data without restoring a compatible backup.
- Legacy Dioxus databases are outside supported storage: no access, migration, fallback, or deletion. Removed Dioxus source/config and Dragon Ball assets survive only in historical backup.

## Execution and saved responses

- `src-tauri/src/execution/` owns shared TLS HTTP and prepare/execute/cancel. Keep database mutexes out of network I/O. Preserve gzip/deflate/brotli, 1 MiB decompressed preview, 100 MiB aggregate streamed file uploads, duplicate headers, bounded formatting, and credential-free diagnostics.
- Cross-origin redirects stop at 3xx to avoid forwarding credentials. No automatic proxy/cookie jar. Render all response content, including stored HTML, as inert text.
- Attachments are backend-picked opaque IDs. Workspace load restores metadata without probing files. Selection/Send/generated-cURL perform their required checks; Check files is removed.
- Completion saves one latest bounded result per saved request in `last_executions` before returning to UI: body preview, headers, status, duration, encoding/flags, outcome, identity, and completion timestamp. HTTP errors, transport failures, timeouts, and cancellation replace the previous result; preparation failure without a result does not.
- Snapshot storage is independent of metadata-only newest-500 history. Each write failure has its own warning while the live result stays visible. Failed replacement preserves the previous committed snapshot. Deleted requests do not create orphans; request deletion cascades snapshot removal.
- Main-window `get_last_execution` returns a validated nullable snapshot. Restore only the visible request on startup/reopen/workspace activation/recovery without HTTP replay. Deduplicate reads and retain generation guards against Send, close/delete, and workspace changes. Restored results are completed, never active executions.
- ResponsePanel has restore loading/error/retry and a Saved timestamp for restored results. Tab close clears memory, not durable data. Workspace changes invalidate relevant memory; inactive deletion and same-workspace recovery preserve current results. Import discards only affected result memory.
- Snapshot JSON limit is 16 MiB to accommodate decoding/escaping expansion of current preview/header bounds, not a larger network preview. Validate identities, sizes, fields, and outcome consistency on storage read/write. Transient write warnings are not restored.
- Results are historical output and may differ from the current draft/saved request. Request and response data are plaintext and can contain secrets. This is not a vault or full response archive; earlier metadata-only history cannot reconstruct bodies.

## Environments and generated cURL

- Selected Collection/Global environments persist per workspace; enabled Collection variables override Global. Substitute `<<name>>` in URL/parameter/header names and values only, not body/multipart. Native preparation resolves saved variables into a snapshot without rewriting templates; manager actions guard unsaved changes.
- Autocomplete/highlighting/tooltips use selected environments, nested references, empty values, scope, and missing/cycle errors. Preserve caret/selection and modal boundaries. Runtime/environment-save validators stay strict.
- The `</>` action beside Save generates cURL from the current draft through `generate_curl`. Resolve environments and native URL/header composition without saving, HTTP, execution reservation, or history/snapshot writes.
- Generation uses POSIX quoting and validates registered regular-file attachments/aggregate size. Preserve supported empty headers, raw bodies, and multipart values; reject unrepresentable combinations such as HEAD with active body. Output can contain resolved credentials/local paths; retain the sharing notice.

## Collection import/export

- Import accepts Postman v2.0/v2.1 through native picker or dropped text. Backend parsing creates a bounded single-use 15-minute preview token; commit is atomic. Preserve source files and unrelated saved data/drafts.
- Name collisions offer copy with smallest available `_n` suffix or explicit overwrite target. Overwrite retains collection identity/position, replaces scoped requests/folders/environments, prunes tabs, and blocks affected dirty/saving/running work.
- Support nested folders, ordered duplicate/disabled rows, raw/multipart, and collection variables as selected Imported environment. Normalize supported placeholders to `<<name>>`; body/multipart stay literal. Unsupported body modes fail. Auth/scripts/examples/local variables/descriptions/settings receive contextual warnings; never execute scripts/HTTP or read attachment files during import.
- Raw import preserves text/NDJSON/malformed JSON without syntax repair using existing `body_kind=json` and verbatim execution. Remove complete block comments outside quoted strings by replacing bytes with spaces, retaining CR/LF/token separation. Preserve escapes/line comments/unfinished blocks; warn on unfinished blocks. Limit raw input to 2 MiB. Missing Content-Type still defaults to application/json and requires user review.
- Trim surrounding whitespace in imported collection variable keys and placeholder names in supported fields/variable values. Leave literal outside text unchanged; reject invalid/empty/internal-space/duplicate normalized names, including disabled duplicates.
- Skip only fully empty structured query rows with contextual warnings. Retain named empty values, duplicate names, and meaningful disabled rows; reject nameless rows with values/descriptions and empty-name raw URL params.
- Diagnostics use bounded escaped names, row indices, scope, breadcrumbs/parser positions, and matching request references. Exclude payload values, URLs, bodies, scripts, and file paths; preserve selectable wrapped multiline presentation.
- Export snapshots 1–50 selected saved collections in a read transaction and targets a backend-picked directory as Postman v2.1. Block selected dirty drafts. Optionally flatten enabled selected Global/Collection variables with Collection precedence and convert supported placeholders to `{{name}}`. Bodies/multipart remain literal; attachments/paths/results/history/scripts are excluded.
- Export's single-use 15-minute token binds immutable payload/directory. Require explicit overwrite and fresh confirmation after metadata changes; reject symlink/directory/traversal targets. Flush tempfiles before publish, preserve partial successes, retry failures only. Limits: 64 MiB/batch, 10 MiB and 2000 nodes/32 levels per collection, 500 selected variables.

## Commands and validation

Use root package.json for script inventory and supported Node versions. Common permitted checks/builds:

```sh
rtk npm ci
rtk npm run typecheck
rtk npm run lint
rtk npm run build
rtk cargo fmt --manifest-path src-tauri/Cargo.toml --check
rtk cargo check --manifest-path src-tauri/Cargo.toml --locked --all-targets --all-features
rtk cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets --all-features -- -D warnings
rtk npm run tauri:build -- --bundles app
```

Normal macOS output: `src-tauri/target/release/bundle/macos/Postmen.app`. Local bundles are not notarized; ship without native-smoke.

When separately authorized, `rtk npm run tauri:dev` starts native dev/Vite on strict port 1420; `rtk npm run dev` is browser-only. Test scripts include npm test, test:rust, test:e2e, and native QA; availability does not override manual-testing preference. Playwright requires browser engines. Windows/Linux builds remain unverified.

## Native lifecycle and evidence

- Window close/menu/shortcut Quit share Save All / Discard / Cancel, await cancellation and session/preferences persistence, and keep the app open after failed saves.
- macOS input uses an app-local NSEvent monitor and genuine pointer-down for titlebar drag. Preserve modal-aware shortcuts, repeated-Send suppression, and controls/double-click behavior. The app needs no global monitor or runtime Accessibility/Screen Recording permission.
- macOS window state separates normal bounds from animated Zoom, atomically saves bounded preferences, and restores normal bounds before maximizing. Fresh-window correction applies only without saved state; preserve user/display-clamped dimensions. Windows/Linux use window-state plugin. Preserve traffic-light inset x=12/y=20.
- Native-smoke validates explicit temporary QA directories and UUID WebKit stores. The regression runner uses two native processes and loopback HTTP/TLS. QA-only manual window creation works around locked Tauri config store-identifier codegen. Browser simulations, native WebView screenshots, and physical OS input provide different evidence.
- OS QA drivers target an explicit QA PID and run sequentially with a lock. DOM is an assertion oracle, not physical-input evidence; launcher exit alone does not prove Quit.
- Historical September 7 OS retest: 36 grouped pass, zero fail, two hardware-blocked; September 6 baseline: 30/4/2. Old frontend/Rust/browser/screenshot counts apply only to their revisions. Full cross-monitor/visual acceptance remains open.
- Preserve archived os-input/, os-input-before-reconnect/, os-input-fixed/, source hashes, screenshots, reports, and bundles. Use new output destinations for new evidence. Fixed results still have hardware blockers; audit integrity/geometric comparisons are not full acceptance or pixel parity.
- Response-persistence worker reported passing typecheck/lint/build, Rust fmt/check/clippy, and regression compilation. On November 11, 2026, a release app build succeeded here and produced Postmen 0.2.0 macOS arm64; frontend emitted a chunk-size warning. No app launch, restart acceptance, or test-suite execution accompanied this build. Manual restart/UI acceptance remains pending.

## Licensing and reference material

- Preserve THIRD_PARTY_NOTICES.md and bundled dependency licenses. The shell-reference MIT section and separate license file were removed at the user's request; do not claim they remain or that removal established legal clearance. Originals remain recoverable from Git.
- Dependency inventories and QA counts are revision-specific. Recalculate when needed rather than treating archived totals as current; preserve old reports/hashes.
- Historical designs/ and private visual-reference assets are not runtime dependencies. Reference scripts use neutral filenames and archive metadata; archived command names describe historical tooling.
