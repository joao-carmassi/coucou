// Helpers around the user's own Claude Code: where its CLI lives and a clean
// environment to start it in.

use std::path::PathBuf;
use std::process::Command;

/// Claude Code on Windows: the native installer's `~\.local\bin\claude.exe`,
/// else whatever `claude` PATH finds (an npm shim, say), else the copy the
/// Claude desktop app keeps for its Code tab.
pub fn windows_cli() -> Option<PathBuf> {
    let native = std::env::var_os("USERPROFILE")
        .map(|h| PathBuf::from(h).join(r".local\bin\claude.exe"))
        .filter(|p| p.is_file());
    native
        .or_else(|| crate::core::platform::find_on_path("claude"))
        .or_else(desktop_app_cli)
}

/// The Claude desktop app ships Claude Code in `…\Claude\claude-code\<version>\`,
/// under the Store package's LocalCache or, for the classic installer, under
/// %APPDATA%. The folder changes with every update, so the newest one wins.
/// That copy is signed in through the app, not on its own.
fn desktop_app_cli() -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(appdata).join(r"Claude\claude-code"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        if let Ok(packages) = std::fs::read_dir(PathBuf::from(local).join("Packages")) {
            for pkg in packages.flatten() {
                if pkg.file_name().to_string_lossy().starts_with("Claude_") {
                    roots.push(pkg.path().join(r"LocalCache\Roaming\Claude\claude-code"));
                }
            }
        }
    }
    roots
        .iter()
        .filter_map(|root| std::fs::read_dir(root).ok())
        .flatten()
        .flatten()
        .map(|v| (version_key(&v.file_name().to_string_lossy()), v.path().join("claude.exe")))
        .filter(|(_, exe)| exe.is_file())
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, exe)| exe)
}

/// "2.1.284" → [2, 1, 284], so 2.1.300 sorts after 2.1.29.
fn version_key(name: &str) -> Vec<u64> {
    name.split('.').map(|p| p.parse().unwrap_or(0)).collect()
}

/// A Claude Code we start must not inherit the markers of one that started us
/// (Coucou is often launched from a Claude Code session): CLAUDE_CODE_CHILD_SESSION
/// and friends make it a "child" with transcript saving off, so `--resume` would
/// find nothing. Same for the parent's terminal identity (WT_SESSION, TERM…),
/// which describe a window this process is not in, and NO_COLOR/FORCE_COLOR,
/// which Claude Code sets for the commands it runs (a white, colorless claude).
/// CLAUDE_CONFIG_DIR goes too: callers set the profile they mean, explicitly.
pub fn fresh_env(cmd: &mut Command) {
    for (key, _) in std::env::vars_os() {
        let name = key.to_string_lossy().to_ascii_uppercase();
        let inherited = name.starts_with("CLAUDE")
            || matches!(
                name.as_str(),
                "WT_SESSION"
                    | "WT_PROFILE_ID"
                    | "TERM"
                    | "TERM_PROGRAM"
                    | "TERM_PROGRAM_VERSION"
                    | "NO_COLOR"
                    | "FORCE_COLOR"
            );
        if inherited {
            cmd.env_remove(&key);
        }
    }
}

/// Claude Code inside a distro, as its login shell finds it.
pub fn wsl_cli(distro: &str) -> Option<String> {
    crate::modules::claude::wsl::run_wsl(&["-d", distro, "--exec", "sh", "-lc", "command -v claude"])
        .map(|s| s.trim().to_string())
        .filter(|p| p.starts_with('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_newest_bundled_version_wins() {
        let mut v = vec!["2.1.29", "2.1.284", "2.1.300", "2.0.999"];
        v.sort_by_key(|s| version_key(s));
        assert_eq!(v.last(), Some(&"2.1.300"));
    }
}
