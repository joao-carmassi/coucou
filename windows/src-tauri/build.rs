use std::{env, fs, path::{Path, PathBuf}};

/// Generates `CATALOG` from src/modules/*/manifest.json (the same files the TS side reads), sorted by
/// `order` then id. `devOnly` entries compile only in debug builds.
fn catalog() {
    let dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../src/modules");
    println!("cargo:rerun-if-changed={}", dir.display()); // a folder added or removed
    let mut all: Vec<serde_json::Value> = Vec::new();
    for e in fs::read_dir(&dir).expect("src/modules") {
        let path = e.unwrap().path().join("manifest.json");
        let Ok(text) = fs::read_to_string(&path) else { continue };
        println!("cargo:rerun-if-changed={}", path.display());
        match serde_json::from_str::<serde_json::Value>(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display())) {
            serde_json::Value::Array(v) => all.extend(v),
            v => all.push(v),
        }
    }
    all.sort_by(|a, b| (a["order"].as_i64(), a["id"].as_str()).cmp(&(b["order"].as_i64(), b["id"].as_str())));
    let list = |v: &serde_json::Value| -> String {
        v.as_array().map(|a| a.iter().map(|s| format!("{:?}", s.as_str().unwrap())).collect::<Vec<_>>().join(", ")).unwrap_or_default()
    };
    let mut out = String::from("pub const CATALOG: &[ModuleInfo] = &[\n");
    for m in &all {
        let s = |k: &str| m[k].as_str().unwrap_or_else(|| panic!("manifest {m}: missing {k}"));
        let group = m["group"].as_str().map_or("None".to_string(), |g| format!("Some({g:?})"));
        let dev = if m["devOnly"].as_bool() == Some(true) { "#[cfg(debug_assertions)] " } else { "" };
        out += &format!(
            "    {dev}ModuleInfo {{ id: {:?}, label: {:?}, default_enabled: {}, requires: &[{}], group: {group} }},\n",
            s("id"), s("label"), m["default"].as_bool().expect("manifest: default"), list(&m["requires"])
        );
    }
    out += "];\n";
    let essential: Vec<String> = all.iter().filter(|m| m["essential"].as_bool() == Some(true)).map(|m| format!("{:?}", m["id"].as_str().unwrap())).collect();
    out += &format!("/// Manifest `essential: true`: the only modules resolved while safe mode is active.\npub const ESSENTIAL: &[&str] = &[{}];\n", essential.join(", "));
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("catalog.rs"), out).unwrap();
}

/// Every `.rs` file under `dir`, recursively.
fn rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in fs::read_dir(dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display())) {
        let p = e.unwrap().path();
        if p.is_dir() { rs_files(&p, out) } else if p.extension().is_some_and(|x| x == "rs") { out.push(p) }
    }
}

/// Names of the `#[tauri::command]` fns in a file (the first `fn` after each attribute).
fn commands_in(path: &Path) -> Vec<String> {
    let text = fs::read_to_string(path).unwrap();
    let mut out = Vec::new();
    let mut pending = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with("#[tauri::command") { pending = true; }
        if !pending { continue; }
        if let Some(i) = t.find("fn ").filter(|&i| i == 0 || !t.as_bytes()[i - 1].is_ascii_alphanumeric()) {
            let name: String = t[i + 3..].chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
            out.push(name);
            pending = false;
        }
    }
    out
}

/// The text without `//` and `/* */` comments (string literals are not special-cased: a PREFIXES list has no `//` inside).
fn strip_comments(text: &str) -> String {
    let mut out = String::new();
    let (mut i, b) = (0, text.as_bytes());
    while i < b.len() {
        if b[i..].starts_with(b"//") { while i < b.len() && b[i] != b'\n' { i += 1 } }
        else if b[i..].starts_with(b"/*") { i = text[i + 2..].find("*/").map_or(b.len(), |e| i + 2 + e + 2) }
        else { let c = text[i..].chars().next().unwrap(); out.push(c); i += c.len_utf8() }
    }
    out
}

/// `modules/<f>/mod.rs` -> `pub mod <f>;` entries in OUT_DIR/modules.rs, the module registry and the
/// invoke-handler table, so a new Rust module is just a new folder. Build-time collision checks:
/// prefixes end with '_' and never nest, a folder's commands use its prefixes, core commands use none.
fn modules() {
    let src = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("src");
    println!("cargo:rerun-if-changed=src/modules");
    println!("cargo:rerun-if-changed=src/core");
    for e in fs::read_dir(&src).unwrap() {
        let p = e.unwrap().path(); // a top-level src/*.rs (lib.rs, main.rs, ...) may hold commands
        if p.extension().is_some_and(|x| x == "rs") { println!("cargo:rerun-if-changed={}", p.display()); }
    }
    let mut folders: Vec<String> = Vec::new();
    for e in fs::read_dir(src.join("modules")).unwrap() {
        let p = e.unwrap().path();
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        if p.is_dir() {
            if p.join("mod.rs").is_file() { folders.push(name) }
        } else if name != "mod.rs" && name != "README.md" {
            panic!("src/modules/{name}: a module is a folder `src/modules/<id>/mod.rs`, not a file directly under modules/");
        }
    }
    folders.sort();
    let mut prefixes: Vec<(String, Vec<String>)> = Vec::new();
    for f in &folders {
        let text = strip_comments(&fs::read_to_string(src.join("modules").join(f).join("mod.rs")).unwrap());
        let decl = text.split("pub const PREFIXES").nth(1).unwrap_or_else(|| panic!("modules/{f}/mod.rs: missing `pub const PREFIXES: &[&str] = &[\"{f}_\"];`"));
        let list = &decl[decl.find('=').unwrap()..decl.find(';').unwrap()];
        let p: Vec<String> = list.split('"').skip(1).step_by(2).map(String::from).collect();
        for x in &p {
            assert!(x.len() > 1 && x.ends_with('_'), "modules/{f}: prefix {x:?} must end with '_'");
        }
        prefixes.push((f.clone(), p));
    }
    for (f, pf) in &prefixes {
        for (g, pg) in &prefixes {
            if f == g { continue; }
            for a in pf { for b in pg {
                assert!(!a.starts_with(b.as_str()), "command prefix collision: modules/{f} {a:?} starts with modules/{g} {b:?}");
            } }
        }
    }
    let mut files = Vec::new();
    rs_files(&src, &mut files);
    for file in files {
        let owner = file.strip_prefix(src.join("modules")).ok().map(|r| r.components().next().unwrap().as_os_str().to_string_lossy().into_owned());
        for cmd in commands_in(&file) {
            match &owner {
                Some(f) => {
                    let own = prefixes.iter().find(|(g, _)| g == f).map(|(_, p)| p);
                    assert!(own.is_some_and(|p| p.iter().any(|x| cmd.starts_with(x.as_str()))),
                        "{}: command `{cmd}` must start with a prefix of modules/{f} ({own:?})", file.display());
                }
                None => for (g, p) in &prefixes {
                    assert!(!p.iter().any(|x| cmd.starts_with(x.as_str())),
                        "{}: core command `{cmd}` collides with the prefixes of modules/{g} ({p:?})", file.display());
                },
            }
        }
    }
    let mut out = String::new();
    for f in &folders {
        // Absolute, forward slashes, not canonicalized (no \\?\ prefix).
        let p = src.join("modules").join(f).join("mod.rs").to_string_lossy().replace('\\', "/");
        out += &format!("#[path = {p:?}]\npub mod {f};\n");
    }
    out += "\n/// Every module of every folder, in folder order.\npub fn registry() -> Vec<Box<dyn Module>> {\n    let mut v: Vec<Box<dyn Module>> = Vec::new();\n";
    for f in &folders { out += &format!("    v.extend({f}::modules());\n"); }
    out += "    v\n}\n\n/// (command prefixes, invoke handler) per folder; lib.rs routes by prefix.\npub fn handlers() -> Vec<(&'static [&'static str], Handler)> {\n    vec![\n";
    for f in &folders { out += &format!("        ({f}::PREFIXES, {f}::handler()),\n"); }
    out += "    ]\n}\n";
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("modules.rs"), out).unwrap();
}

fn main() {
    catalog();
    modules();
    tauri_build::build()
}
