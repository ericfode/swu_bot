//! Printed card stats by set code ("SOR_042"), read from the engine's card data (forceteki/test/json/Card).
//! The data is gitignored in the repo, so it is read at start-up instead of being compiled in.

use std::collections::HashMap;
use std::path::Path;

#[derive(Clone, Debug, Default)]
pub struct CardInfo {
    pub cost: f32,
    pub power: f32,
    pub hp: f32,
    pub unit: bool,
    pub event: bool,
    pub upgrade: bool,
    pub leader: bool,
    pub base: bool,
    pub token: bool,
    pub space: bool,
    pub keywords: u32,
}

#[derive(Default)]
pub struct CardDb {
    by_code: HashMap<String, CardInfo>,
}

impl CardDb {
    /// Reads every card file in `dir` (the `Card/` folder or its parent). Missing data gives an empty table:
    /// the model still plays, it just loses the printed-stat features.
    pub fn load(dir: &Path) -> CardDb {
        let dir = if dir.join("Card").is_dir() { dir.join("Card") } else { dir.to_path_buf() };
        let mut db = CardDb::default();
        let Ok(entries) = std::fs::read_dir(&dir) else {
            eprintln!("swu-learned: no card data at {}", dir.display());
            return db;
        };
        for e in entries.flatten() {
            let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
            let num = |k: &str| v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0) as f32;
            let strs = |k: &str| -> Vec<String> {
                v.get(k)
                    .and_then(|x| x.as_array())
                    .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_lowercase)).collect())
                    .unwrap_or_default()
            };
            let types = strs("types");
            let kws = strs("keywords");
            let has = |t: &str| types.iter().any(|x| x.contains(t));
            let mut info = CardInfo {
                cost: num("cost"),
                power: num("power"),
                hp: num("hp"),
                unit: has("unit"),
                event: has("event"),
                upgrade: has("upgrade"),
                leader: has("leader"),
                base: has("base"),
                token: has("token"),
                space: v.get("arena").and_then(|a| a.as_str()) == Some("space"),
                keywords: 0,
            };
            for (bit, k) in KEYWORDS.iter().enumerate() {
                if kws.iter().any(|x| x == k) {
                    info.keywords |= 1 << bit;
                }
            }
            if info.upgrade && info.power == 0.0 {
                info.power = num("upgradePower");
                info.hp = num("upgradeHp");
            }
            let codes = v.get("setCodes").and_then(|x| x.as_array()).cloned().unwrap_or_default();
            let mut all = codes;
            if let Some(id) = v.get("setId") {
                all.push(id.clone());
            }
            for c in all {
                let (Some(set), Some(n)) = (c.get("set").and_then(|s| s.as_str()), c.get("number").and_then(|n| n.as_u64())) else {
                    continue;
                };
                db.by_code.insert(format!("{set}_{n:03}"), info.clone());
            }
        }
        eprintln!("swu-learned: {} card codes from {}", db.by_code.len(), dir.display());
        db
    }

    pub fn get(&self, code: Option<&str>) -> Option<&CardInfo> {
        code.and_then(|c| self.by_code.get(c))
    }

    pub fn len(&self) -> usize {
        self.by_code.len()
    }
}

/// Keywords that get their own feature bit.
pub const KEYWORDS: [&str; 10] =
    ["sentinel", "overwhelm", "raid", "restore", "saboteur", "shielded", "ambush", "grit", "bounty", "smuggle"];
