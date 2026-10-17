// The only place the facts about each agent live: where its hook file is, which events
// it gets, whether a blocking hook (approval) exists. Writes go only to these user-level
// paths, never to a project.

use std::path::PathBuf;

use crate::core::platform::home_dir;

/// How a hook entry looks inside a merged JSON file.
#[derive(Clone, Copy)]
pub enum Style {
    /// `{"hooks": {"Event": [{"hooks": [{"type":"command","command":…,"timeout":…}]}]}}`.
    /// `named`: the entry also carries a `name`.
    Nested { named: bool },
    /// `{"version":1,"hooks": {"event": [{"command":…,"timeout":…}]}}`.
    Flat,
}

#[derive(Clone, Copy)]
pub enum Kind {
    /// A file the user (or the agent) also writes: merged key by key, foreign hooks kept.
    JsonMerge { path: fn() -> PathBuf, events: &'static [(&'static str, u64)], style: Style },
    /// A file that is entirely ours: written whole, removed whole. `body(exe, id)`.
    OwnFile { path: fn() -> PathBuf, body: fn(&str, &str) -> String },
}

pub struct AgentDef {
    pub id: &'static str,
    pub label: &'static str,
    pub color: &'static str,
    /// A blocking hook exists AND its reply format is known to work: only then is there an approval card.
    pub blocking: bool,
    /// Program name looked up on PATH, and the config folder whose presence also means "installed".
    pub bin: &'static str,
    pub dir: fn() -> PathBuf,
    pub kind: Kind,
}

fn env_dir(var: &str, default: &str) -> PathBuf {
    std::env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| home_dir().join(default))
}

fn codex_dir() -> PathBuf {
    env_dir("CODEX_HOME", ".codex")
}
fn gemini_dir() -> PathBuf {
    home_dir().join(".gemini")
}
fn cursor_dir() -> PathBuf {
    home_dir().join(".cursor")
}
fn copilot_dir() -> PathBuf {
    env_dir("COPILOT_HOME", ".copilot")
}
fn opencode_dir() -> PathBuf {
    home_dir().join(".config").join("opencode")
}

// Timeouts: Codex and Cursor in seconds, Gemini in milliseconds. A permission
// request outlives the relay's own 110 s wait by 10 s.
const CODEX_EVENTS: &[(&str, u64)] = &[
    ("SessionStart", 10),
    ("UserPromptSubmit", 10),
    ("PreToolUse", 10),
    ("PostToolUse", 10),
    ("PermissionRequest", 120),
    ("Stop", 10),
    ("SessionEnd", 3),
];
const GEMINI_EVENTS: &[(&str, u64)] = &[
    ("SessionStart", 10_000),
    ("BeforeAgent", 10_000),
    ("BeforeTool", 10_000),
    ("AfterTool", 10_000),
    ("AfterAgent", 10_000),
    ("Notification", 10_000),
    ("SessionEnd", 3_000),
];
// No preToolUse: it would need guaranteed JSON too and adds little over postToolUse.
const CURSOR_EVENTS: &[(&str, u64)] = &[
    ("sessionStart", 10),
    ("postToolUse", 10),
    ("beforeShellExecution", 120),
    ("stop", 10),
    ("sessionEnd", 10),
];
// No PreToolUse (Copilot fails closed on it) and no PermissionRequest (observe only).
pub const COPILOT_EVENTS: &[&str] = &["SessionStart", "SessionEnd", "UserPromptSubmit", "PostToolUse", "Stop"];

fn copilot_path() -> PathBuf {
    copilot_dir().join("hooks").join("coucou.json")
}
fn opencode_path() -> PathBuf {
    opencode_dir().join("plugins").join("coucou.js")
}

pub static AGENTS: &[AgentDef] = &[
    AgentDef {
        id: "codex", label: "Codex", color: "#10b981", blocking: true, bin: "codex", dir: codex_dir,
        kind: Kind::JsonMerge { path: || codex_dir().join("hooks.json"), events: CODEX_EVENTS, style: Style::Nested { named: false } },
    },
    AgentDef {
        id: "gemini", label: "Gemini CLI", color: "#4f8cff", blocking: false, bin: "gemini", dir: gemini_dir,
        kind: Kind::JsonMerge { path: || gemini_dir().join("settings.json"), events: GEMINI_EVENTS, style: Style::Nested { named: true } },
    },
    AgentDef {
        id: "cursor", label: "Cursor", color: "#a1a1aa", blocking: true, bin: "cursor", dir: cursor_dir,
        kind: Kind::JsonMerge { path: || cursor_dir().join("hooks.json"), events: CURSOR_EVENTS, style: Style::Flat },
    },
    AgentDef {
        id: "copilot", label: "Copilot CLI", color: "#a78bfa", blocking: false, bin: "copilot", dir: copilot_dir,
        kind: Kind::OwnFile { path: copilot_path, body: super::install::copilot_body },
    },
    AgentDef {
        id: "opencode", label: "OpenCode", color: "#f59e0b", blocking: false, bin: "opencode", dir: opencode_dir,
        kind: Kind::OwnFile { path: opencode_path, body: super::install::opencode_body },
    },
];

pub fn find(id: &str) -> Option<&'static AgentDef> {
    AGENTS.iter().find(|a| a.id == id)
}

impl AgentDef {
    pub fn path(&self) -> PathBuf {
        match self.kind {
            Kind::JsonMerge { path, .. } | Kind::OwnFile { path, .. } => path(),
        }
    }
}
