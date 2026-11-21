//! Open Hullport when the user logs in, through a LaunchAgent in ~/Library/LaunchAgents.
//!
//! SMAppService is the modern API, but it is unreliable for ad-hoc signed apps. The agent
//! starts the app itself (with `--background`), never the VM, so the VM always has the
//! menu bar icon. launchd sends SIGTERM at logout; ExitTimeOut leaves time to stop the VM.

use std::path::PathBuf;

const LABEL: &str = "dev.hullport.app";

fn plist_path() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")).join("Library/LaunchAgents").join(format!("{LABEL}.plist"))
}

pub fn enabled() -> bool {
    plist_path().exists()
}

/// Takes effect at the next login. The agent isn't loaded now: RunAtLoad would open a second copy.
pub fn set_enabled(on: bool) -> std::io::Result<()> {
    let path = plist_path();
    if !on {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        };
    }
    let exe = std::env::current_exe()?;
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(&path, plist(&exe.display().to_string()))
}

fn plist(exe: &str) -> String {
    let exe = exe.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>{exe}</string><string>--background</string></array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>ExitTimeOut</key><integer>120</integer>
</dict>
</plist>
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plist_starts_the_app_in_the_background_and_escapes_the_path() {
        let p = plist("/Applications/A&B <x>.app/Contents/MacOS/hullport");
        assert!(p.contains("<string>/Applications/A&amp;B &lt;x&gt;.app/Contents/MacOS/hullport</string><string>--background</string>"));
        assert!(p.contains("<key>RunAtLoad</key><true/>"));
        assert!(!p.contains("KeepAlive"), "Quit must stay quit");
    }
}
