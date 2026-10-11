//! swu-bot-rs: Star Wars Unlimited bots in Rust.
//!
//! Speaks the stdio bot protocol on stdin/stdout: v1 (spec/stdio-protocol.md) with any referee, v2 (spec/protocol.md:
//! `over`, and `sim` requests that play ahead on a private copy of the game) when the referee offers it. The JS side
//! runs the forceteki engine, lists the legal actions and applies the one we pick.
//!
//!   cargo build --release --manifest-path bot/rust/Cargo.toml
//!   swu-bot-rs [random|greedy|greedy2|search]  (default: greedy)

mod cards;
mod policy;
mod protocol;

use policy::{Policy, SimOp, Simulator};
use protocol::{Reply, Request, Simulated, PROTOCOL, VERSION, VERSION_2};
use std::io::{self, BufRead, Write};

struct Bot {
    name: String,
    policy: Box<dyn Policy>,
    /// Protocol version picked in this game's `ready`.
    v: u32,
}

impl Bot {
    fn new(name: String, policy: Box<dyn Policy>) -> Self {
        Bot { name, policy, v: VERSION }
    }

    /// The reply to one request line; None means stop (v2 `bye`).
    fn handle(&mut self, line: &str, sim: &mut dyn Simulator) -> Option<Reply> {
        let req: Request = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(e) => return Some(Reply::Error { error: format!("bad request: {e}") }),
        };
        Some(match req {
            Request::Hello(h) if h.v != VERSION || (!h.protocol.is_empty() && h.protocol != PROTOCOL) => {
                Reply::Error { error: format!("{} v{} not supported (want {PROTOCOL} v{VERSION})", h.protocol, h.v) }
            }
            Request::Hello(h) => {
                self.v = if h.versions.contains(&VERSION_2) { VERSION_2 } else { VERSION };
                self.policy.new_game(&h);
                let wants = self.v == VERSION_2 && self.policy.wants_sim();
                Reply::Ready { v: self.v, name: self.name.clone(), sim: wants.then_some(true) }
            }
            Request::Decide(d) if d.actions.is_empty() => Reply::Error { error: "no actions to choose from".into() },
            Request::Decide(d) => {
                let i = if d.sim && self.v == VERSION_2 { self.policy.choose_sim(&d, sim) } else { self.policy.choose(&d) };
                let split = if d.actions[i].kind == "distribute" { self.policy.distribution(&d, i) } else { None };
                if self.v == VERSION_2 {
                    Reply::Act { i, distribution: None, split }
                } else {
                    Reply::Act { i, distribution: split, split: None }
                }
            }
            Request::Over(_) => Reply::Ok,
            Request::Simulated(_) => Reply::Error { error: "simulated reply without a sim request".into() },
            Request::Bye => return None,
        })
    }
}

/// stdin/stdout. Also the simulator: a `sim` request is written and the next line must be its `simulated` reply.
struct Io {
    lines: io::Lines<io::StdinLock<'static>>,
    out: io::StdoutLock<'static>,
}

impl Io {
    fn next_line(&mut self) -> Option<String> {
        loop {
            match self.lines.next() {
                Some(Ok(line)) if line.trim().is_empty() => continue,
                Some(Ok(line)) => return Some(line),
                _ => return None,
            }
        }
    }

    fn send(&mut self, reply: &Reply) {
        serde_json::to_writer(&mut self.out, reply).expect("write reply");
        self.out.write_all(b"\n").expect("write reply");
        self.out.flush().expect("flush reply");
    }
}

impl Simulator for Io {
    fn sim(&mut self, op: SimOp) -> Simulated {
        let name = op.name();
        self.send(&match op {
            SimOp::Begin(deal) => Reply::Sim { op: name, deal, i: None, split: None },
            SimOp::Act(i, split) => Reply::Sim { op: name, deal: None, i: Some(i), split },
            SimOp::End => Reply::Sim { op: name, deal: None, i: None, split: None },
        });
        let op = name;
        let failed = |why: String| Simulated { op: op.into(), error: Some(why), ..Default::default() };
        match self.next_line() {
            None => failed("end of input".into()),
            Some(line) => match serde_json::from_str::<Request>(&line) {
                Ok(Request::Simulated(s)) => s,
                Ok(_) => failed(format!("expected a simulated reply, got: {}", &line[..line.len().min(80)])),
                Err(e) => failed(format!("bad simulated reply: {e}")),
            },
        }
    }
}

fn main() {
    let which = std::env::args().nth(1).unwrap_or_else(|| "greedy".into());
    let Some(policy) = policy::create(&which) else {
        eprintln!("unknown policy '{which}' (have: {})", policy::NAMES.join(", "));
        std::process::exit(2);
    };
    let mut bot = Bot::new(format!("swu-bot-rs/{which}"), policy);
    // stdout is protocol only; EOF on stdin means stop
    let mut io = Io { lines: io::stdin().lock().lines(), out: io::stdout().lock() };
    while let Some(line) = io.next_line() {
        match bot.handle(&line, &mut io) {
            Some(reply) => io.send(&reply),
            None => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bot(policy: &str) -> Bot {
        Bot::new(policy.into(), policy::create(policy).unwrap())
    }

    /// Answers every sim request with an error, as a referee with sims off would.
    struct NoSim;
    impl Simulator for NoSim {
        fn sim(&mut self, op: SimOp) -> Simulated {
            Simulated { op: op.name().into(), error: Some("sims off".into()), ..Default::default() }
        }
    }

    fn reply(b: &mut Bot, line: &str) -> String {
        serde_json::to_string(&b.handle(line, &mut NoSim).unwrap()).unwrap()
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
    fn picks_v2_when_offered_and_asks_for_sims_only_if_it_searches() {
        let v2 = HELLO.replace(r#""v":1,"#, r#""v":1,"versions":[1,2],"#);
        assert_eq!(reply(&mut bot("greedy2"), &v2), r#"{"t":"ready","v":2,"name":"greedy2"}"#);
        let mut s = bot("search");
        assert_eq!(reply(&mut s, &v2), r#"{"t":"ready","v":2,"name":"search","sim":true}"#);
        assert_eq!(reply(&mut s, r#"{"t":"over","winner":"p1"}"#), r#"{"t":"ok"}"#);
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
