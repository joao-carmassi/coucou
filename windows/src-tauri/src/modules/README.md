# Rust modules

A Rust module is a folder. Create `src-tauri/src/modules/<id>/` with a `mod.rs`; touch no other file.
`build.rs` finds the folder, declares `pub mod <id>;`, adds it to `registry()` and routes its commands.
The id must be in the catalog (`windows/src/modules/<id>/manifest.json`, shared with the TS side).

## Contract of `<id>/mod.rs`

```rust
pub const PREFIXES: &[&str] = &["<id>_"];          // each ends with '_'; commands are routed by prefix
pub fn modules() -> Vec<Box<dyn Module>>;           // the Module impls (empty vec if none)
pub fn handler() -> crate::core::host::Handler;     // crate::core::host::handler(tauri::generate_handler![...])
```

`build.rs` fails the build when: a prefix does not end with `_`; one folder's prefix starts another's;
a `#[tauri::command]` under `<id>/**` does not start with one of its prefixes; a core command
(anywhere else under `src/`) starts with any module prefix.
`npm run neutrality-audit` (rule R) checks the TS bridges call only declared prefixes.

## Template

```rust
// src-tauri/src/modules/hello/mod.rs
use crate::core::host::{Module, ModuleCtx};
use crate::core::settings::Settings;

pub const PREFIXES: &[&str] = &["hello_"];

pub struct Hello;
impl Module for Hello {
    fn id(&self) -> &'static str { "hello" }
    fn start(&self, _ctx: &ModuleCtx, _s: &Settings) {}
}

#[tauri::command]
fn hello_ping() -> &'static str { "pong" }

pub fn modules() -> Vec<Box<dyn Module>> { vec![Box::new(Hello)] }

pub fn handler() -> crate::core::host::Handler {
    crate::core::host::handler(tauri::generate_handler![hello_ping])
}
```
