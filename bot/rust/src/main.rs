//! swu-bot-rs: Star Wars Unlimited bots in Rust.
//!
//! Speaks spec/stdio-protocol.md (swu-bot-stdio v1) on stdin/stdout. The JS side (bot/players/external.js) runs the
//! forceteki engine, lists the legal actions and applies the one we pick, so this process needs no card data.
//!
//!   cargo build --release --manifest-path bot/rust/Cargo.toml
//!   swu-bot-rs [random|greedy|greedy2]  (default: greedy)

mod cards;
mod policy;
mod protocol;

use policy::Policy;
use protocol::{Reply, Request, PROTOCOL, VERSION};
use std::io::{self, BufRead, Write};

struct Bot {
    name: String,
    policy: Box<dyn Policy>,
}

impl Bot {
    fn handle(&mut self, line: &str) -> Reply {
        let req: Request = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(e) => return Reply::Error { error: format!("bad request: {e}") },
        };
        match req {
            Request::Hello(h) if h.v != VERSION || (!h.protocol.is_empty() && h.protocol != PROTOCOL) => {
                Reply::Error { error: format!("{} v{} not supported (want {PROTOCOL} v{VERSION})", h.protocol, h.v) }
            }
            Request::Hello(h) => {
                self.policy.new_game(&h);
                Reply::Ready { v: VERSION, name: self.name.clone() }
            }
            Request::Decide(d) if d.actions.is_empty() => Reply::Error { error: "no actions to choose from".into() },
            Request::Decide(d) => {
                let i = self.policy.choose(&d);
                let distribution = if d.actions[i].kind == "distribute" { self.policy.distribution(&d, i) } else { None };
                Reply::Act { i, distribution }
            }
        }
    }
}

fn main() {
    let which = std::env::args().nth(1).unwrap_or_else(|| "greedy".into());
    let Some(policy) = policy::create(&which) else {
        eprintln!("unknown policy '{which}' (have: {})", policy::NAMES.join(", "));
        std::process::exit(2);
    };
    let mut bot = Bot { name: format!("swu-bot-rs/{which}"), policy };
    let mut out = io::stdout().lock();
    // stdout is protocol only; EOF on stdin means stop
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = bot.handle(&line);
        serde_json::to_writer(&mut out, &reply).expect("write reply");
        out.write_all(b"\n").expect("write reply");
        out.flush().expect("flush reply");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bot(policy: &str) -> Bot {
        Bot { name: policy.into(), policy: policy::create(policy).unwrap() }
    }

    fn reply(b: &mut Bot, line: &str) -> String {
        serde_json::to_string(&b.handle(line)).unwrap()
    }

    const HELLO: &str = r#"{"t":"hello","protocol":"swu-bot-stdio","v":1,"bot":"rust-greedy","you":"p1","seed":42,"players":[{"id":"p1","name":"p1"},{"id":"p2","name":"p2"}]}"#;

    fn decide(prompt: &str, actions: &str) -> String {
        format!(r#"{{"t":"decide","seq":1,"you":"p1","prompt":{prompt},"state":{{"round":1,"phase":"action","initiative":"p2","players":{{"p1":{{"res":{{"ready":2,"total":2}}}},"p2":{{"ground":[{{"id":"u2","n":"Wampa","p":4,"h":5,"d":0}}]}}}}}},"actions":{actions}}}"#)
    }

    #[test]
    fn hello_and_version_check() {
        let mut b = bot("random");
        assert_eq!(reply(&mut b, HELLO), r#"{"t":"ready","v":1,"name":"random"}"#);
        assert!(reply(&mut b, &HELLO.replace(r#""v":1"#, r#""v":2"#)).contains(r#""t":"error""#));
    }

    #[test]
    fn random_is_reproducible_per_seed() {
        let acts = r#"[{"i":0,"kind":"button","label":"a"},{"i":1,"kind":"button","label":"b"},{"i":2,"kind":"button","label":"c"}]"#;
        let line = decide(r#"{"type":null,"signature":"-","title":"x","promptTitle":null,"selectCardMode":null,"selected":[],"actionWindow":false}"#, acts);
        let run = || {
            let mut b = bot("random");
            reply(&mut b, HELLO);
            (0..20).map(|_| reply(&mut b, &line)).collect::<Vec<_>>()
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn greedy_plays_a_card_before_passing() {
        let mut b = bot("greedy");
        reply(&mut b, HELLO);
        let line = decide(
            r#"{"type":"actionWindow","signature":"actionWindow","title":"Choose an action","promptTitle":null,"selectCardMode":"single","selected":[],"actionWindow":true}"#,
            r#"[{"i":0,"kind":"button","label":"Pass","arg":"pass"},{"i":1,"kind":"card","label":"x","cardUuid":"h1","card":{"id":"h1","zone":"hand","ctl":"p1"}}]"#,
        );
        assert_eq!(reply(&mut b, &line), r#"{"t":"act","i":1}"#);
    }

    #[test]
    fn greedy_attacks_the_opponent_not_itself() {
        let mut b = bot("greedy");
        reply(&mut b, HELLO);
        let line = decide(
            r#"{"type":null,"signature":"-|single","title":"Choose a target for attack","promptTitle":null,"selectCardMode":"single","selected":[],"actionWindow":false}"#,
            r#"[{"i":0,"kind":"card","label":"own","card":{"id":"b1","zone":"base","ctl":"p1"}},{"i":1,"kind":"card","label":"wampa","card":{"id":"u2","zone":"groundArena","ctl":"p2"}}]"#,
        );
        assert_eq!(reply(&mut b, &line), r#"{"t":"act","i":1}"#);
    }

    #[test]
    fn greedy_confirms_resources_once_enough_are_selected() {
        // the opening prompt: extra clicks after two selections are no-ops, so it must confirm
        let mut b = bot("greedy");
        reply(&mut b, HELLO);
        let acts = r#"[{"i":0,"kind":"button","label":"Confirm Resources","arg":"done"},{"i":1,"kind":"card","label":"c","card":{"id":"h3","zone":"hand","ctl":"p1"}}]"#;
        let pick = |b: &mut Bot, selected: &str| {
            let prompt = format!(r#"{{"type":"resource","signature":"resource|multiple","title":"Select 2 cards to resource","promptTitle":"Resource Step","selectCardMode":"multiple","selected":{selected},"actionWindow":false}}"#);
            reply(b, &decide(&prompt, acts))
        };
        assert_eq!(pick(&mut b, "[]"), r#"{"t":"act","i":1}"#);
        assert_eq!(pick(&mut b, r#"["h1","h2"]"#), r#"{"t":"act","i":0}"#);
    }

    #[test]
    fn greedy_does_not_replay_a_card_it_cancelled() {
        // seen on the real engine: play an upgrade, dislike every target, cancel, play it again, forever
        let mut b = bot("greedy");
        reply(&mut b, HELLO);
        let window = decide(
            r#"{"type":"actionWindow","signature":"actionWindow|-","title":"Choose an action","promptTitle":null,"selectCardMode":null,"selected":[],"actionWindow":true}"#,
            r#"[{"i":0,"kind":"button","label":"Pass","arg":"pass"},{"i":1,"kind":"card","label":"heroic-bravery","card":{"id":"h1","zone":"hand","ctl":"p1"}}]"#,
        );
        let target = decide(
            r#"{"type":null,"signature":"-|single","title":"Attach Heroic Bravery to a unit","promptTitle":null,"selectCardMode":"single","selected":[],"actionWindow":false}"#,
            r#"[{"i":0,"kind":"button","label":"Cancel","arg":"cancel"},{"i":1,"kind":"card","label":"wampa","card":{"id":"u2","zone":"groundArena","ctl":"p2"}}]"#,
        );
        assert_eq!(reply(&mut b, &window), r#"{"t":"act","i":1}"#);
        assert_eq!(reply(&mut b, &target), r#"{"t":"act","i":0}"#);
        assert_eq!(reply(&mut b, &window), r#"{"t":"act","i":0}"#);
    }

    #[test]
    fn greedy_breaks_out_of_a_repeated_no_op() {
        let mut b = bot("greedy");
        reply(&mut b, HELLO);
        let line = decide(
            r#"{"type":null,"signature":"-|single","title":"Give a Shield token to a unit","promptTitle":null,"selectCardMode":"single","selected":[],"actionWindow":false}"#,
            r#"[{"i":0,"kind":"button","label":"Done","arg":"done"},{"i":1,"kind":"card","label":"x","card":{"id":"u9","zone":"groundArena","ctl":"p1"}}]"#,
        );
        let picks: Vec<String> = (0..20).map(|_| reply(&mut b, &line)).collect();
        assert!(picks.iter().any(|p| p.contains(r#""i":0"#)), "{picks:?}");
    }
}
