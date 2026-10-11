//! Card data, read from the engine's card JSON (`forceteki/test/json/Card/*.json`, written by `npm run get-cards`).
//!
//! The protocol sends card names and set codes but not stats, so a policy that wants costs, aspects or keywords loads
//! them here. The folder is `$SWU_CARD_JSON`, else `forceteki/test/json` under the working directory (the adapter
//! starts bots in the repo root). Missing data is not an error: lookups return None and policies fall back to rules.

use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // the full stat line, for policies to come
pub struct CardInfo {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub internal_name: String,
    #[serde(default)]
    pub cost: Option<i32>,
    #[serde(default)]
    pub power: Option<i32>,
    #[serde(default)]
    pub hp: Option<i32>,
    #[serde(default)]
    pub upgrade_power: Option<i32>,
    #[serde(default)]
    pub upgrade_hp: Option<i32>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub arena: Option<String>,
    #[serde(default)]
    aspects: Option<Vec<String>>,
    #[serde(default)]
    keywords: Option<Vec<String>>,
    #[serde(default)]
    types: Option<Vec<String>>,
    #[serde(default)]
    set_id: Option<SetId>,
    /// Every printing (alternate art, reprints), `set_id` among them.
    #[serde(default)]
    set_codes: Option<Vec<SetId>>,
}

#[derive(Debug, Deserialize, Default, Clone)]
struct SetId {
    #[serde(default)]
    set: String,
    #[serde(default)]
    number: Option<u32>,
}

impl CardInfo {
    pub fn aspects(&self) -> &[String] {
        self.aspects.as_deref().unwrap_or(&[])
    }

    pub fn has_keyword(&self, k: &str) -> bool {
        self.keywords.as_deref().unwrap_or(&[]).iter().any(|x| x == k)
    }

    pub fn is(&self, t: &str) -> bool {
        self.types.as_deref().unwrap_or(&[]).iter().any(|x| x == t)
    }

    pub fn cost(&self) -> i32 {
        self.cost.unwrap_or(0)
    }

    pub fn text_lower(&self) -> String {
        self.text.as_deref().unwrap_or("").to_lowercase()
    }
}

#[derive(Default)]
pub struct CardDb {
    by_name: HashMap<String, CardInfo>,
    /// "SOR_010" -> internal name
    by_set: HashMap<String, String>,
    /// title -> internal name (first one wins; titles repeat across versions of a character)
    by_title: HashMap<String, String>,
}

impl CardDb {
    /// Load from `$SWU_CARD_JSON` or `forceteki/test/json`; an empty db if neither has a `Card/` folder.
    pub fn load_default() -> CardDb {
        let dir = std::env::var_os("SWU_CARD_JSON").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("forceteki/test/json"));
        CardDb::load(&dir)
    }

    pub fn load(dir: &Path) -> CardDb {
        let mut db = CardDb::default();
        let Ok(entries) = std::fs::read_dir(dir.join("Card")) else { return db };
        for e in entries.flatten() {
            let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
            if let Ok(card) = serde_json::from_str::<CardInfo>(&text) {
                db.insert(card);
            }
        }
        db
    }

    pub fn insert(&mut self, card: CardInfo) {
        let code = |s: &SetId| s.number.filter(|_| !s.set.is_empty()).map(|n| format!("{}_{:03}", s.set, n));
        if let Some(c) = card.set_id.as_ref().and_then(code) {
            self.by_set.insert(c, card.internal_name.clone());
        }
        // other printings never take a code that is some card's own set_id
        for c in card.set_codes.iter().flatten().filter_map(code) {
            self.by_set.entry(c).or_insert_with(|| card.internal_name.clone());
        }
        self.by_title.entry(card.title.clone()).or_insert_with(|| card.internal_name.clone());
        self.by_name.insert(card.internal_name.clone(), card);
    }

    pub fn len(&self) -> usize {
        self.by_name.len()
    }

    pub fn by_name(&self, internal_name: &str) -> Option<&CardInfo> {
        self.by_name.get(internal_name)
    }

    pub fn by_set_code(&self, code: &str) -> Option<&CardInfo> {
        self.by_set.get(code).and_then(|n| self.by_name.get(n))
    }

    pub fn by_title(&self, title: &str) -> Option<&CardInfo> {
        self.by_title.get(title).and_then(|n| self.by_name.get(n))
    }

    /// Best effort: action label (internal name), then set code, then title.
    pub fn find(&self, label: Option<&str>, set_code: Option<&str>, title: Option<&str>) -> Option<&CardInfo> {
        label
            .and_then(|l| self.by_name(l))
            .or_else(|| set_code.and_then(|s| self.by_set_code(s)))
            .or_else(|| title.and_then(|t| self.by_title(t)))
    }
}

#[cfg(test)]
pub fn test_card(name: &str, json: &str) -> CardInfo {
    let mut c: CardInfo = serde_json::from_str(json).unwrap();
    c.internal_name = name.into();
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_card_by_any_printing() {
        let mut db = CardDb::default();
        db.insert(test_card(
            "tauntaun-mount",
            r#"{"title":"Tauntaun Mount","setId":{"set":"IBH","number":15},
                "setCodes":[{"set":"IBH","number":15},{"set":"IBH","number":28},{"set":"SOR","number":7}]}"#,
        ));
        // SOR_007 is another card's own number: its set_id wins whatever the load order
        db.insert(test_card("other", r#"{"title":"Other","setId":{"set":"SOR","number":7}}"#));
        assert_eq!(db.by_set_code("IBH_028").map(|c| c.title.as_str()), Some("Tauntaun Mount"));
        assert_eq!(db.by_set_code("IBH_015").map(|c| c.title.as_str()), Some("Tauntaun Mount"));
        assert_eq!(db.by_set_code("SOR_007").map(|c| c.title.as_str()), Some("Other"));
    }
}
