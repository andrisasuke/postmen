# Third-party notices

PostMen's shell adapts visual tokens and layout measurements from Bruno v4.1.0, commit `eeff774e95afc5de5f8b7bf9e201c474f9299516`. Bruno's MIT copyright and permission notice are retained in `licenses/Bruno-MIT.txt`. PostMen is a separate product; the Bruno logo and promotional assets are not used as its identity.

Bundled UI assets and runtime libraries:

| Component | Pinned version | License file |
| --- | --- | --- |
| Inter (Latin 400, 500, 600; unmodified font files) | @fontsource/inter 5.0.15 | licenses/Inter-OFL.txt |
| Fira Code (Latin 400; unmodified font files) | @fontsource/fira-code 5.3.0 | licenses/Fira-Code-OFL.txt |
| Tabler Vue icons | @tabler/icons-vue 3.46.0 | licenses/Tabler-MIT.txt |
| Vue | 3.5.42 | licenses/Vue-MIT.txt |
| Pinia | 3.0.4 | licenses/Pinia-MIT.txt |
| Tauri Rust runtime (MIT option) | 2.11.5 | licenses/Tauri-MIT.txt |
| CodeMirror 6 (state, view, commands, language, JSON, lint, search) | Exact versions in frontend/package.json | licenses/CodeMirror-MIT.txt |
| Lezer JSON parsing/highlighting | Exact versions in package-lock.json | licenses/Lezer-MIT.txt |
| Zod | 4.5.4 | licenses/Zod-MIT.txt |
| rusqlite | 0.40.2 | licenses/rusqlite-MIT.txt |
| Tauri dialog / filesystem plugins (MIT option; no frontend filesystem permissions) | 2.7.3 / 2.5.2 | licenses/Tauri-plugins-MIT.txt |
| Rust URL parser (MIT option) | 2.5.8 | licenses/url-MIT.txt |
| UUID (MIT option) | 1.26.0 | licenses/uuid-MIT.txt |
| reqwest HTTP client (MIT option) | 0.13.4 | licenses/reqwest-MIT.txt |
| Tokio runtime and utilities | 1.53.1 / 0.7.19 | licenses/Tokio-MIT.txt, licenses/Tokio-util-MIT.txt |
| rustls TLS implementation | 0.23.43 | licenses/Rustls-MIT.txt, licenses/Rustls-ISC.txt |
| AWS-LC cryptography / Rust wrapper | aws-lc-sys 0.45.0 / aws-lc-rs 1.18.1 | licenses/AWS-LC.txt, licenses/AWS-LC-Sys.txt, licenses/AWS-LC-Rust.txt |
| encoding_rs character decoding | 0.8.35 | licenses/encoding_rs-MIT.txt, licenses/encoding_rs-WHATWG.txt |
| Tauri window-state plugin (MIT option) | 2.4.1 | licenses/Tauri-window-state-MIT.txt |
| tempfile and rustix (atomic collection export publication) | 3.27.0 / 1.1.4 | licenses/DEPENDENCIES.txt |

License texts are shipped in the macOS application's Resources/licenses directory. `licenses/DEPENDENCIES.txt` adds a conservative inventory of locked npm production dependencies and macOS Cargo normal/build dependencies (including build-only tools), with deduplicated upstream texts and hashes. Reproduce with `node scripts/audit-notices.mjs`; the machine-readable inventory is `docs/milestones/M4/dependency-notices.json`. Exact versions remain in `package-lock.json` and `src-tauri/Cargo.lock`; no dependencies were upgraded for M4 visual changes.

The collection-export follow-up promotes the existing locked tempfile dependency to runtime use. Its refreshed inventory is `docs/milestones/M4/collection-export/dependency-notices.json`; reproduce it with `node scripts/audit-notices.mjs docs/milestones/M4/collection-export/dependency-notices.json`. The historical milestone inventory remains unchanged. Runtime additions and their upstream notices are included in the current bundled `licenses/DEPENDENCIES.txt`.

Twenty published crates omitted standalone notice files. Supplements were recovered from their `.cargo_vcs_info.json` repository revisions and retained with URL/SHA256 in `docs/milestones/M4/notice-sources/sources.json`. The objc2 family publishes licensing context rather than complete standalone license/copyright files: its original Apple-SDK licensing caveat and standard MIT terms are included, with package-author metadata identified as such. No copyright attribution was invented. This inventory is not legal clearance; review these upstream caveats before public distribution.

Unmodified MPL-2.0 components (cssparser, cssparser-macros, dtoa-short, option-ext, selectors) retain their terms; exact upstream source archive addresses are provided per package in `DEPENDENCIES.txt`. CodeMirror 6 is bundled starting in M2; M1's preview and all development fixtures are excluded from production. SQLite is bundled through libsqlite3-sys (public-domain SQLite core; the rusqlite wrapper notice is retained).

The PostMen P icon in `src-tauri/icons/source.svg` is project-original artwork. Generated platform variants come from that SVG.
