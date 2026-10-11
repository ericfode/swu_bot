//! swu-bot-rs: Star Wars Unlimited bots in Rust.
//!
//! Speaks the stdio bot protocol on stdin/stdout: v1 (spec/stdio-protocol.md) with any referee, v2 (spec/protocol.md:
//! `over`, and `sim` requests that play ahead on a private copy of the game) when the referee offers it. The JS side
//! runs the forceteki engine, lists the legal actions and applies the one we pick.
//!
//!   cargo build --release   (at the repo root: the Cargo workspace puts the binary in target/release)
//!   swu-bot-rs [random|greedy|greedy2|search]  (default: greedy)

use swu_bot_rs::{policy, stdio};

fn main() {
    let which = std::env::args().nth(1).unwrap_or_else(|| "greedy".into());
    let Some(policy) = policy::create(&which) else {
        eprintln!("unknown policy '{which}' (have: {})", policy::NAMES.join(", "));
        std::process::exit(2);
    };
    stdio::run(format!("swu-bot-rs/{which}"), policy);
}
