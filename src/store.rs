//! Minimal JSON persistence in the app data folder: preferences, saved build
//! configurations and records of builds started from this app.

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Data folder name used before the rename to Hullport.
pub const LEGACY_DIR: &str = "dev.berth.app";
const DATA_FILES: [&str; 3] = ["prefs.json", "build-configs.json", "build-records.json"];
const IMPORT_MARKER: &str = ".imported-from-dev.berth.app";

/// Copy the files saved under the old data folder into `dir`, once. Files that already exist in
/// `dir` are kept, and the old folder is never changed.
pub fn import_legacy(dir: &Path, legacy: &Path) -> std::io::Result<()> {
    let marker = dir.join(IMPORT_MARKER);
    if marker.exists() || !legacy.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(dir)?;
    for file in DATA_FILES {
        let (from, to) = (legacy.join(file), dir.join(file));
        if from.is_file() && !to.exists() {
            std::fs::copy(&from, &to)?;
        }
    }
    std::fs::write(marker, "")
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Prefs {
    pub context: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct KeyValue {
    pub key: String,
    pub value: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BuildConfig {
    pub id: String,
    pub name: String,
    pub context_dir: String,
    pub dockerfile: Option<String>,
    pub image: String,
    pub tag: Option<String>,
    #[serde(default)]
    pub build_args: Vec<KeyValue>,
    pub target: Option<String>,
    pub platform: Option<String>,
    #[serde(default)]
    pub no_cache: bool,
    #[serde(default)]
    pub pull: bool,
    pub updated_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BuildStepRecord {
    pub name: String,
    pub cached: bool,
    pub error: Option<String>,
    pub duration_ms: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BuildRecord {
    pub id: String,
    pub config: BuildConfig,
    /// "running" | "succeeded" | "failed" | "canceled"
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub error: Option<String>,
    pub image_id: Option<String>,
    pub build_ref: Option<String>,
    #[serde(default)]
    pub steps: Vec<BuildStepRecord>,
    #[serde(default)]
    pub log_tail: String,
    pub docker_context: Option<String>,
}

pub struct Store {
    dir: PathBuf,
    lock: Mutex<()>,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        Self { dir, lock: Mutex::new(()) }
    }

    fn read<T: DeserializeOwned + Default>(&self, file: &str) -> T {
        std::fs::read_to_string(self.dir.join(file))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn write<T: Serialize>(&self, file: &str, value: &T) -> std::io::Result<()> {
        let tmp = self.dir.join(format!("{file}.tmp"));
        std::fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
        std::fs::rename(tmp, self.dir.join(file))
    }

    pub fn prefs(&self) -> Prefs {
        self.read("prefs.json")
    }

    pub fn set_prefs(&self, p: &Prefs) -> std::io::Result<()> {
        let _g = self.lock.lock().unwrap();
        self.write("prefs.json", p)
    }

    pub fn build_configs(&self) -> Vec<BuildConfig> {
        self.read("build-configs.json")
    }

    pub fn save_build_config(&self, cfg: BuildConfig) -> std::io::Result<Vec<BuildConfig>> {
        let _g = self.lock.lock().unwrap();
        let mut all: Vec<BuildConfig> = self.read("build-configs.json");
        all.retain(|c| c.id != cfg.id);
        all.insert(0, cfg);
        self.write("build-configs.json", &all)?;
        Ok(all)
    }

    pub fn delete_build_config(&self, id: &str) -> std::io::Result<Vec<BuildConfig>> {
        let _g = self.lock.lock().unwrap();
        let mut all: Vec<BuildConfig> = self.read("build-configs.json");
        all.retain(|c| c.id != id);
        self.write("build-configs.json", &all)?;
        Ok(all)
    }

    pub fn build_records(&self) -> Vec<BuildRecord> {
        self.read("build-records.json")
    }

    pub fn upsert_build_record(&self, rec: &BuildRecord) -> std::io::Result<()> {
        let _g = self.lock.lock().unwrap();
        let mut all: Vec<BuildRecord> = self.read("build-records.json");
        all.retain(|r| r.id != rec.id);
        all.insert(0, rec.clone());
        all.truncate(200);
        self.write("build-records.json", &all)
    }

    pub fn delete_build_records(&self, ids: &[String]) -> std::io::Result<()> {
        let _g = self.lock.lock().unwrap();
        let mut all: Vec<BuildRecord> = self.read("build-records.json");
        all.retain(|r| !ids.contains(&r.id));
        self.write("build-records.json", &all)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("hullport-store-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn imports_legacy_files_once_without_overwriting() {
        let root = temp_dir();
        let (legacy, dir) = (root.join(LEGACY_DIR), root.join("dev.hullport.app"));
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(legacy.join("prefs.json"), r#"{"context":"orbstack"}"#).unwrap();
        std::fs::write(legacy.join("build-records.json"), "[]").unwrap();
        std::fs::write(dir.join("build-records.json"), "[\"newer\"]").unwrap();

        import_legacy(&dir, &legacy).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("prefs.json")).unwrap(), r#"{"context":"orbstack"}"#);
        assert_eq!(std::fs::read_to_string(dir.join("build-records.json")).unwrap(), "[\"newer\"]");
        assert!(!dir.join("build-configs.json").exists());

        // A second launch copies nothing, even if the old folder changed.
        std::fs::write(legacy.join("build-configs.json"), "[]").unwrap();
        import_legacy(&dir, &legacy).unwrap();
        assert!(!dir.join("build-configs.json").exists());
        assert!(legacy.join("prefs.json").exists());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn skips_when_there_is_no_legacy_folder() {
        let root = temp_dir();
        let dir = root.join("dev.hullport.app");
        import_legacy(&dir, &root.join(LEGACY_DIR)).unwrap();
        assert!(!dir.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
