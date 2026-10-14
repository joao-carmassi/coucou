use std::{env, fs, path::PathBuf};

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
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("catalog.rs"), out).unwrap();
}

fn main() {
    catalog();
    tauri_build::build()
}
