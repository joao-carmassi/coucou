// Helpers around the user's own Claude Code: where its CLI lives, a clean
// environment to start it in, and whether it is signed in.

use std::io::{Read, Write};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Which Claude Code: the Windows one or a WSL distro's.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Backend {
    Windows,
    Wsl(String),
}

impl Backend {
    /// "windows" or "wsl:<distro>"; anything unrecognised is Windows.
    pub fn parse(value: &str) -> Self {
        match value.strip_prefix("wsl:") {
            Some(d) if crate::wsl::is_distro_name(d) => Self::Wsl(d.to_string()),
            _ => Self::Windows,
        }
    }
}

/// Claude Code on Windows: the native installer's `~\.local\bin\claude.exe`,
/// else whatever `claude` PATH finds (an npm shim, say), else the copy the
/// Claude desktop app keeps for its Code tab.
pub fn windows_cli() -> Option<PathBuf> {
    let native = std::env::var_os("USERPROFILE")
        .map(|h| PathBuf::from(h).join(r".local\bin\claude.exe"))
        .filter(|p| p.is_file());
    native
        .or_else(|| crate::platform::find_on_path("claude"))
        .or_else(desktop_app_cli)
}

/// The Claude desktop app ships Claude Code in `…\Claude\claude-code\<version>\`,
/// under the Store package's LocalCache or, for the classic installer, under
/// %APPDATA%. The folder changes with every update, so the newest one wins.
/// That copy is signed in through the app, not on its own: see `logged_in`.
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

/// Whether that Claude Code is signed in, from its own `claude auth status` —
/// which costs nothing. `None` when it can't be asked. A copy that comes with
/// the Claude desktop app answers "no" until it is signed in on its own.
pub fn logged_in(backend: &Backend) -> Option<bool> {
    let cmd = match backend {
        Backend::Windows => {
            let mut c = Command::new(windows_cli()?);
            c.args(["auth", "status"]);
            fresh_env(&mut c);
            if let Some(dir) = crate::settings::claude_config_dir() {
                c.env("CLAUDE_CONFIG_DIR", dir);
            }
            c
        }
        Backend::Wsl(distro) => {
            let mut c = Command::new("wsl.exe");
            c.args(["-d", distro, "--exec", "sh", "-lc", "exec claude auth status"]);
            c
        }
    };
    let (out, _) = run(cmd, "", Duration::from_secs(20)).ok()?;
    // Pretty-printed JSON; a login shell may print its own lines first.
    let json = &out[out.find('{')?..];
    serde_json::from_str::<Value>(json).ok()?.get("loggedIn")?.as_bool()
}

/// Spawns the CLI, feeds it the prompt and collects its output under a deadline.
fn run(mut cmd: Command, prompt: &str, timeout: Duration) -> Result<(String, String), String> {
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Não consegui iniciar o Claude Code: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(prompt.as_bytes());
        // Dropped here: end of input is what tells `claude -p` to start.
    }
    // Drain both pipes on their own threads so a big answer can't fill one and
    // stall the process.
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut buf);
            }
            String::from_utf8_lossy(&buf).into_owned()
        })
    };
    let out = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let err = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                return Err("O Claude Code demorou demais para responder.".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok((out.join().unwrap_or_default(), err.join().unwrap_or_default()))
}

/// Claude Code inside a distro, as its login shell finds it.
pub fn wsl_cli(distro: &str) -> Option<String> {
    crate::wsl::run_wsl(&["-d", distro, "--exec", "sh", "-lc", "command -v claude"])
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

    #[test]
    fn backends_parse_and_refuse_odd_distros() {
        assert_eq!(Backend::parse("windows"), Backend::Windows);
        assert_eq!(Backend::parse("wsl:Ubuntu-22.04"), Backend::Wsl("Ubuntu-22.04".into()));
        assert_eq!(Backend::parse("wsl:x&y"), Backend::Windows);
        assert_eq!(Backend::parse(""), Backend::Windows);
    }
}
