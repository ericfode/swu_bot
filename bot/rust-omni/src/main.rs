//! swu-omni-bot: rust-search with its playouts in the native rules simulator (bot/omni-rs).
//!
//! Speaks the same stdio protocol as swu-bot-rs. Games whose decks are all in the simulator's card pool
//! (bot/omni/rs/pool.json, `SWU_OMNI_POOL` to override) are searched in-process; any other game is played as
//! rust-search, with the referee's `sim` requests.
//!
//!   cargo build --release   (at the repo root)
//!   target/release/swu-omni-bot

mod omni;
mod view;

use swu_bot_rs::cards::CardDb;
use swu_bot_rs::stdio;

fn main() {
    let path = std::env::var("SWU_OMNI_POOL").unwrap_or_else(|_| "bot/omni/rs/pool.json".into());
    let engine = omni::load_engine(&path);
    if let Err(e) = &engine {
        eprintln!("rust-omni: no simulator ({e}); playing as rust-search");
    }
    let db: &'static CardDb = Box::leak(Box::new(CardDb::load_default()));
    stdio::run("swu-omni-bot/omni".into(), Box::new(omni::OmniSearch::new(db, engine)));
}
