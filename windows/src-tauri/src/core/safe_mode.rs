// Crash-loop guard: `launch.marker` counts starts that were not followed by 60 s of healthy running.

use std::path::Path;
use std::time::Duration;

const FILE: &str = "launch.marker";
const THRESHOLD: u32 = 3;
const HEALTHY_AFTER: Duration = Duration::from_secs(60);

/// Returns the number of earlier unclean starts and writes the count including this one.
fn bump(dir: &Path) -> u32 {
    let prev = std::fs::read_to_string(dir.join(FILE)).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0u32);
    let _ = std::fs::write(dir.join(FILE), prev.saturating_add(1).to_string());
    prev
}

fn reset(dir: &Path) {
    let _ = std::fs::write(dir.join(FILE), "0");
}

static REAL: std::sync::OnceLock<std::collections::BTreeMap<String, bool>> = std::sync::OnceLock::new();

/// The module switches as stored on disk while this run is in safe mode: `settings::save` writes these, never the reduced set.
pub fn real_modules() -> Option<&'static std::collections::BTreeMap<String, bool>> {
    REAL.get()
}

pub fn active() -> bool {
    REAL.get().is_some()
}

/// A normal quit is not a crash.
pub fn clean_exit() {
    reset(&crate::core::platform::config_dir());
}

/// Call once, after single-instance. `stored` is the on-disk switch map. True when this run must use safe mode.
pub fn begin(stored: &std::collections::BTreeMap<String, bool>) -> bool {
    let dir = crate::core::platform::config_dir();
    let _ = crate::core::platform::ensure_private_dir(&dir);
    let safe = bump(&dir) >= THRESHOLD;
    if safe {
        let _ = REAL.set(stored.clone());
    }
    // Single short-lived core thread: sleeps once, resets the marker, exits.
    std::thread::spawn(move || {
        std::thread::sleep(HEALTHY_AFTER);
        reset(&dir);
    });
    safe
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counter_increments_resets_and_trips_at_threshold() {
        let dir = std::env::temp_dir().join(format!("coucou-marker-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let _ = std::fs::remove_file(dir.join(FILE));
        assert_eq!(bump(&dir), 0);
        assert_eq!(bump(&dir), 1);
        assert_eq!(bump(&dir), 2);
        assert!(bump(&dir) >= THRESHOLD, "fourth start follows three unclean ones");
        reset(&dir);
        assert_eq!(bump(&dir), 0);
        std::fs::write(dir.join(FILE), "junk").unwrap();
        assert_eq!(bump(&dir), 0, "garbage counts as clean");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
