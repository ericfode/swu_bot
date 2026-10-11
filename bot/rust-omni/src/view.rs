//! Between the referee's view (protocol `state`) and the simulator's full state (bot/omni-rs).
//!
//! `Table` numbers every card of both deck lists the way the engine does (stable ids `c<n>`: a seat's deck cards in
//! deck-list order, then its base, its leader and one token, p1 first), so a card id names a known card even while it
//! is hidden. `full_state` builds one guess of the hidden cards (my deck order; the opponent's hand, resources and
//! deck) from the cards not seen yet, as the simulator's import format. `view` and `decide` go back the other way, so
//! the rule policies and the board score can read simulated positions.

use omni_rs::model::{CardId, Decision, Seat, State as Sim};
use omni_rs::{Action as SimAction, Engine};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use swu_bot_rs::policy::Rng;
use swu_bot_rs::protocol::{
    Action, BaseView, CardRef, CardWire, Decide, Hello, LeaderView, PlayerView, Prompt, Resources, State, UnitView, UpgradeRef,
};

const SHIELD: &str = "TOKEN_SHIELD";

/// The simulator's card pool: set code -> internal name.
pub struct Pool {
    names: HashMap<String, String>,
}

impl Pool {
    pub fn from_json(v: &Value) -> Pool {
        let names = v["cards"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|c| Some((c["setCode"].as_str()?.to_owned(), c["internalName"].as_str()?.to_owned())))
            .collect();
        Pool { names }
    }

    pub fn name(&self, code: &str) -> Option<&str> {
        self.names.get(code).map(String::as_str)
    }
}

/// Both decks of one game, numbered like the engine.
pub struct Table {
    /// Set code of card number n (decks, bases and leaders; tokens are not listed).
    code: HashMap<u32, String>,
    /// Per seat (p1, p2): the numbers of its deck cards, its base and its leader.
    deck: [Vec<u32>; 2],
    base: [u32; 2],
    leader: [u32; 2],
    /// First number after both seats' blocks.
    end: u32,
}

fn seat_index(seat: &str) -> usize {
    if seat == "p2" { 1 } else { 0 }
}

fn num(id: &str) -> Option<u32> {
    id.strip_prefix('c')?.parse().ok()
}

impl Table {
    /// The table for a game, or why the simulator cannot play it (a v1 referee, or a card outside its pool).
    pub fn new(hello: &Hello, pool: &Pool) -> Result<Table, String> {
        let (mine, theirs) = match (&hello.deck, &hello.opponent) {
            (Some(a), Some(b)) => (a, b),
            _ => return Err("no deck lists in hello".into()),
        };
        let lists = if hello.you == "p2" { [theirs, mine] } else { [mine, theirs] };
        let mut t = Table { code: HashMap::new(), deck: [vec![], vec![]], base: [0; 2], leader: [0; 2], end: 0 };
        let mut n = 0u32;
        for (i, list) in lists.iter().enumerate() {
            for e in &list.deck {
                for _ in 0..e.count {
                    t.code.insert(n, e.id.clone());
                    t.deck[i].push(n);
                    n += 1;
                }
            }
            t.base[i] = n;
            t.code.insert(n, list.base.id.clone());
            t.leader[i] = n + 1;
            t.code.insert(n + 1, list.leader.id.clone());
            n += 3; // base, leader, and a token the engine makes for every player
        }
        t.end = n;
        if let Some(code) = t.code.values().find(|c| pool.name(c).is_none()) {
            return Err(format!("{code} is not in the simulator's pool"));
        }
        Ok(t)
    }

    /// The view's base and leader ids must be where the table puts them, or the numbering is not the engine's.
    pub fn agrees(&self, s: &State) -> bool {
        ["p1", "p2"].iter().all(|seat| {
            let i = seat_index(seat);
            let Some(p) = s.players.get(*seat) else { return false };
            num(&p.base.id) == Some(self.base[i]) && p.leader.as_ref().and_then(|l| num(&l.id)) == Some(self.leader[i])
        })
    }
}

fn card_json(pool: &Pool, id: &str, code: &str) -> Result<Value, String> {
    let name = pool.name(code).ok_or_else(|| format!("{code} is not in the pool"))?;
    Ok(json!({"id": id, "setCode": code, "name": name}))
}

/// One guess of the hidden cards, as a full state the simulator imports (`Engine::load_state`), at `me`'s action
/// window. Fails when the view has something the import format cannot hold.
pub fn full_state(t: &Table, pool: &Pool, s: &State, me: &str, rng: &mut Rng) -> Result<Value, String> {
    let initiative = s.initiative.clone().ok_or("no initiative")?;
    let empty = PlayerView::default();
    let mut seen: HashSet<u32> = HashSet::new();
    let mut top = 0u32;
    let mut note = |id: &str, seen: &mut HashSet<u32>| -> Result<u32, String> {
        let n = num(id).ok_or_else(|| format!("card id {id}"))?;
        top = top.max(n);
        seen.insert(n);
        Ok(n)
    };
    // first pass: every visible card, to know what is hidden
    for seat in ["p1", "p2"] {
        let p = s.players.get(seat).unwrap_or(&empty);
        for c in p.hand.iter().flatten().chain(p.discard.iter()) {
            note(&c.id, &mut seen)?;
        }
        for r in p.resources.iter().flatten() {
            note(&r.id, &mut seen)?;
        }
        for u in p.units() {
            note(&u.id, &mut seen)?;
            for up in &u.u {
                note(&up.id, &mut seen)?;
            }
        }
    }
    let mut players = Map::new();
    let mut claimed = false;
    for seat in ["p1", "p2"] {
        let i = seat_index(seat);
        let p = s.players.get(seat).ok_or("missing player")?;
        let code = |n: u32| t.code.get(&n).cloned().ok_or_else(|| format!("unknown card c{n}"));
        let refs = |cards: &[CardRef]| -> Result<Vec<Value>, String> {
            cards.iter().map(|c| card_json(pool, &c.id, &code(num(&c.id).unwrap_or(u32::MAX))?)).collect()
        };
        let mut hidden: Vec<u32> = t.deck[i].iter().copied().filter(|n| !seen.contains(n)).collect();
        shuffle(&mut hidden, rng);
        let (hand, resources, deck);
        if seat == me {
            hand = refs(p.hand.as_deref().unwrap_or(&[]))?;
            resources = p
                .resources
                .iter()
                .flatten()
                .map(|r| {
                    let mut v = card_json(pool, &r.id, &code(num(&r.id).unwrap_or(u32::MAX))?)?;
                    v["exhausted"] = json!(r.x == 1);
                    Ok(v)
                })
                .collect::<Result<Vec<_>, String>>()?;
            if resources.len() != p.res.total as usize || hidden.len() != p.deck as usize {
                return Err(format!("{seat}: {} hidden cards for a deck of {}", hidden.len(), p.deck));
            }
            deck = hidden.iter().map(|&n| card_json(pool, &format!("c{n}"), &code(n)?)).collect::<Result<Vec<_>, _>>()?;
        } else {
            let (h, r) = (p.hand_count as usize, p.res.total as usize);
            if hidden.len() != h + r + p.deck as usize {
                return Err(format!("{seat}: {} hidden cards for {h} in hand, {r} resources, {} in deck", hidden.len(), p.deck));
            }
            let card = |n: u32| card_json(pool, &format!("c{n}"), &code(n)?);
            hand = hidden[..h].iter().map(|&n| card(n)).collect::<Result<Vec<_>, _>>()?;
            let exhausted = r - (p.res.ready as usize).min(r);
            resources = hidden[h..h + r]
                .iter()
                .enumerate()
                .map(|(k, &n)| {
                    let mut v = card(n)?;
                    v["exhausted"] = json!(k < exhausted);
                    Ok(v)
                })
                .collect::<Result<Vec<_>, String>>()?;
            deck = hidden[h + r..].iter().map(|&n| card(n)).collect::<Result<Vec<_>, _>>()?;
        }
        let leader = p.leader.as_ref().ok_or("no leader")?;
        let leader_code = code(t.leader[i])?;
        let arena = |units: &[UnitView]| -> Result<Vec<Value>, String> {
            units
                .iter()
                .map(|u| {
                    let n = num(&u.id).ok_or("unit id")?;
                    let c = if n == t.leader[i] { leader_code.clone() } else { code(n)? };
                    let mut v = card_json(pool, &u.id, &c)?;
                    v["damage"] = json!(u.d.max(0));
                    v["exhausted"] = json!(!u.ready());
                    v["power"] = json!(u.p.max(0));
                    v["hp"] = json!(u.h.max(0));
                    let mut ups = vec![];
                    for up in &u.u {
                        if up.n.as_deref() != Some("Shield") {
                            return Err(format!("upgrade {:?} is not a Shield", up.n));
                        }
                        let mut shield = card_json(pool, &up.id, SHIELD)?;
                        shield["token"] = json!(true);
                        ups.push(shield);
                    }
                    v["upgrades"] = json!(ups);
                    Ok(v)
                })
                .collect()
        };
        let ground = arena(&p.ground)?;
        let space = arena(&p.space)?;
        claimed |= p.out == 1;
        let mut base = card_json(pool, &p.base.id, &code(t.base[i])?)?;
        base["damage"] = json!(p.base.d.max(0));
        base["hp"] = json!(30);
        base["epicUsed"] = json!(false);
        let mut l = card_json(pool, &leader.id, &leader_code)?;
        l["deployed"] = json!(leader.dep == 1);
        l["exhausted"] = json!(leader.x == 1);
        l["epicUsed"] = json!(leader.epic == 1 || leader.dep == 1);
        players.insert(
            seat.into(),
            json!({"base": base, "leader": l, "hand": hand, "deck": deck, "resources": resources,
                   "discard": refs(&p.discard)?, "ground": ground, "space": space, "out": p.out == 1}),
        );
    }
    let opp = s.players.get(other(me)).ok_or("missing opponent")?;
    Ok(json!({
        "round": s.round, "phase": "action", "initiative": initiative, "initiativeClaimed": claimed,
        "prevPassed": opp.passed == 1, "activePlayer": me, "actor": me, "winner": null,
        "nextCardId": t.end.max(top + 1), "players": players
    }))
}

fn other(seat: &str) -> &'static str {
    if seat == "p1" { "p2" } else { "p1" }
}

fn shuffle<T>(v: &mut [T], rng: &mut Rng) {
    for i in (1..v.len()).rev() {
        v.swap(i, rng.below(i + 1));
    }
}

fn sid(id: CardId) -> String {
    format!("c{}", id - 1)
}

/// The board of a simulated position as the protocol shows it, with `hand_of`'s hand visible.
pub fn view(e: &Engine, s: &Sim, hand_of: Option<Seat>) -> State {
    let def = |id: CardId| &e.definitions[s.card(id).def as usize];
    let refs = |ids: &[CardId]| -> Vec<CardRef> {
        ids.iter().map(|&id| CardRef { id: sid(id), n: Some(def(id).info.title.clone()), s: Some(def(id).code.clone()) }).collect()
    };
    let unit = |id: CardId| -> UnitView {
        let c = s.card(id);
        let d = def(id);
        UnitView {
            id: sid(id),
            n: Some(d.info.title.clone()),
            p: e.power(s, id, false) as i32,
            h: d.info.hp.unwrap_or(0),
            d: c.damage as i32,
            s: Some(d.code.clone()),
            x: Some(c.exhausted as u8),
            sn: d.info.has_keyword("sentinel").then_some(1),
            u: if c.shield != 0 { vec![UpgradeRef { id: sid(c.shield), n: Some("Shield".into()), t: 1 }] } else { vec![] },
        }
    };
    let mut players = std::collections::BTreeMap::new();
    for seat in [Seat::P1, Seat::P2] {
        let p = s.player(seat);
        let res = p.resources.as_slice();
        let leader = s.card(p.leader);
        players.insert(
            seat.as_str().to_string(),
            PlayerView {
                base: BaseView {
                    id: sid(p.base),
                    n: Some(def(p.base).info.title.clone()),
                    s: Some(def(p.base).code.clone()),
                    hp: def(p.base).info.hp.unwrap_or(30),
                    d: s.card(p.base).damage as i32,
                },
                leader: Some(LeaderView {
                    id: sid(p.leader),
                    n: Some(def(p.leader).info.title.clone()),
                    s: Some(def(p.leader).code.clone()),
                    dep: leader.deployed as u8,
                    x: leader.exhausted as u8,
                    epic: leader.epic_used as u8,
                }),
                res: Resources { ready: res.iter().filter(|&&id| !s.card(id).exhausted).count() as u32, total: res.len() as u32 },
                hand_count: p.hand.len as u32,
                hand: (hand_of == Some(seat)).then(|| refs(p.hand.as_slice())),
                deck: p.deck.len as u32,
                discard: refs(p.discard.as_slice()),
                resources: None,
                passed: 0,
                out: p.out as u8,
                ground: p.ground.as_slice().iter().map(|&id| unit(id)).collect(),
                space: p.space.as_slice().iter().map(|&id| unit(id)).collect(),
            },
        );
    }
    State {
        round: s.round as u32,
        phase: Some(if s.regroup { "regroup" } else { "action" }.into()),
        initiative: Some(s.initiative.as_str().into()),
        players,
    }
}

/// Where a card is, in the protocol's zone names, and who controls it.
fn zone(s: &Sim, id: CardId) -> (&'static str, Seat) {
    for seat in [Seat::P1, Seat::P2] {
        let p = s.player(seat);
        let z = if p.hand.contains(id) {
            "hand"
        } else if p.ground.contains(id) {
            "groundArena"
        } else if p.space.contains(id) {
            "spaceArena"
        } else if p.base == id || p.leader == id {
            "base"
        } else if p.resources.contains(id) {
            "resource"
        } else if p.discard.contains(id) {
            "discard"
        } else {
            continue;
        };
        return (z, seat);
    }
    ("deck", s.card(id).owner)
}

/// A simulated decision as the protocol would send it to the seat that acts, for the rule policies.
pub fn decide(e: &Engine, s: &Sim, actions: &[SimAction]) -> Decide {
    let def = |id: CardId| &e.definitions[s.card(id).def as usize];
    let (kind, signature, title, prompt_title, window): (Option<&str>, &str, String, Option<String>, bool) = match s.decision {
        Decision::Window => (Some("actionWindow"), "actionWindow|-", "Choose an action".into(), None, true),
        Decision::AttackTarget => {
            (None, "-|single", "Choose a target for attack".into(), (s.source != 0).then(|| def(s.source).info.title.clone()), false)
        }
        Decision::LeaderMenu => {
            let l = s.player(s.active).leader;
            (None, "-|-", format!("Play {}:", def(l).info.title), None, false)
        }
        Decision::VaderBase => {
            let amount = if actions.iter().any(|a| a.label == "Cancel") { 1 } else { 2 };
            (None, "-|single", format!("Deal {amount} damage to a base"), None, false)
        }
        Decision::NoEffect => (None, "-|-", "The ability will have no effect. Are you sure you want to use it?".into(), None, false),
        Decision::Resource => (Some("resource"), "resource|single", "Select 1 card to resource".into(), Some("Resource Step".into()), false),
        _ => (None, "-|-", String::new(), None, false),
    };
    let acts = actions
        .iter()
        .enumerate()
        .map(|(i, a)| {
            let card = a.id().filter(|&id| id != 0).map(|id| {
                let (z, ctl) = zone(s, id);
                CardWire {
                    id: sid(id),
                    n: Some(def(id).info.title.clone()),
                    s: Some(def(id).code.clone()),
                    zone: Some(z.into()),
                    ctl: Some(ctl.as_str().into()),
                    cost: None,
                }
            });
            Action {
                i,
                kind: a.kind.clone(),
                label: a.label.clone(),
                arg: a.arg.clone(),
                card_uuid: a.card.clone(),
                card,
                distribute: None,
            }
        })
        .collect();
    Decide {
        seq: 0,
        you: s.active.as_str().into(),
        prompt: Prompt {
            kind: kind.map(Into::into),
            signature: signature.into(),
            title: Some(title),
            prompt_title,
            select_card_mode: (s.decision == Decision::Resource).then(|| "single".into()),
            selected: vec![],
            action_window: window,
        },
        state: view(e, s, Some(s.active)),
        actions: acts,
        sim: false,
        ms: None,
    }
}

/// The simulator's action for a protocol action at an action window: the same button, or a click on the same card.
pub fn same(a: &Action, b: &SimAction) -> bool {
    a.kind == b.kind
        && match (&a.card, &b.card) {
            (Some(c), Some(id)) => &c.id == id,
            (None, None) => a.label == b.label,
            _ => false,
        }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use omni_rs::model::Seat;

    pub fn engine() -> (Engine, Pool) {
        crate::omni::load_engine(concat!(env!("CARGO_MANIFEST_DIR"), "/../omni/rs/pool.json")).unwrap()
    }

    /// Both seats: 2x Noti Mobile Pod (cost 3), 2x Offworld Jawa (cost 1), 2x Porg (cost 0); p1 Satine on Fortress of
    /// the Great Mothers, p2 Vader on Ancient Henge. Engine ids: p1 c0..c5, base c6, leader c7 (token c8); p2 c9..c14,
    /// base c15, leader c16.
    pub fn hello(you: &str) -> Hello {
        let list = |leader: &str, base: &str| {
            json!({"leader": {"id": leader, "count": 1}, "base": {"id": base, "count": 1},
                   "deck": [{"id": "ASH_261", "count": 2}, {"id": "HMW_268", "count": 2}, {"id": "LOF_254", "count": 2}]})
        };
        let (p1, p2) = (list("SEC_005", "ASH_019"), list("IBH_053", "ASH_023"));
        let (deck, opponent) = if you == "p1" { (p1, p2) } else { (p2, p1) };
        serde_json::from_value(json!({"t": "hello", "v": 2, "you": you, "seed": 7, "deck": deck, "opponent": opponent})).unwrap()
    }

    /// Round 2, p1 to act: p1 has a Pod (c0) and a Jawa (c2) in hand and two ready Porgs as resources; p2 has a damaged,
    /// exhausted, shielded Pod (c9) in play, one card in hand and two resources, one of them exhausted.
    pub fn board() -> State {
        serde_json::from_value(json!({
            "round": 2, "phase": "action", "initiative": "p2",
            "players": {
                "p1": {"base": {"id": "c6", "hp": 30, "d": 4}, "leader": {"id": "c7"}, "res": {"ready": 2, "total": 2},
                       "handCount": 2, "hand": [{"id": "c0"}, {"id": "c2"}], "deck": 2,
                       "resources": [{"id": "c4"}, {"id": "c5"}]},
                "p2": {"base": {"id": "c15", "hp": 30, "d": 0}, "leader": {"id": "c16"}, "res": {"ready": 1, "total": 2},
                       "handCount": 1, "deck": 2, "passed": 1,
                       "ground": [{"id": "c9", "n": "Noti Mobile Pod", "p": 3, "h": 4, "d": 1, "x": 1,
                                   "u": [{"id": "c18", "n": "Shield", "t": 1}]}]}
            }
        }))
        .unwrap()
    }

    #[test]
    fn numbers_cards_like_the_engine() {
        let (_, pool) = engine();
        for you in ["p1", "p2"] {
            let t = Table::new(&hello(you), &pool).unwrap();
            assert_eq!((t.base, t.leader, t.end), ([6, 15], [7, 16], 18));
            assert_eq!(t.deck[1], (9..15).collect::<Vec<_>>());
            assert_eq!(t.code[&2], "HMW_268");
            assert!(t.agrees(&board()));
        }
        let mut wrong = board();
        wrong.players.get_mut("p2").unwrap().base.id = "c14".into();
        assert!(!Table::new(&hello("p1"), &pool).unwrap().agrees(&wrong));
    }

    #[test]
    fn refuses_cards_outside_the_pool() {
        let (_, pool) = engine();
        let mut h = hello("p1");
        h.opponent.as_mut().unwrap().deck[0].id = "SOR_038".into();
        assert!(Table::new(&h, &pool).err().unwrap().contains("SOR_038"));
    }

    #[test]
    fn deals_the_hidden_cards_into_a_state_the_simulator_loads() {
        let (e, pool) = engine();
        let t = Table::new(&hello("p1"), &pool).unwrap();
        let mut rng = Rng::default();
        for _ in 0..20 {
            let s = e.load_state(&full_state(&t, &pool, &board(), "p1", &mut rng).unwrap()).unwrap();
            let (me, opp) = (s.player(Seat::P1), s.player(Seat::P2));
            assert_eq!(me.hand.as_slice(), [1, 3]);
            let mut deck = me.deck.as_slice().to_vec();
            deck.sort();
            assert_eq!(deck, [2, 4], "my deck is what I have not seen");
            // the opponent's 5 hidden cards (c10..c14) split 1 hand, 2 resources (one exhausted), 2 deck
            let mut hidden: Vec<_> = [opp.hand, opp.resources, opp.deck].iter().flat_map(|z| z.as_slice().to_vec()).collect();
            hidden.sort();
            assert_eq!(hidden, [11, 12, 13, 14, 15]);
            assert_eq!(opp.resources.as_slice().iter().filter(|&&id| s.card(id).exhausted).count(), 1);
            let pod = s.card(10);
            assert_eq!((pod.damage, pod.exhausted, pod.shield), (1, true, 19));
            assert!(s.prev_passed && !s.initiative_claimed && s.active == Seat::P1);
        }
    }

    #[test]
    fn simulated_positions_read_back_as_the_protocol_shows_them() {
        let (e, pool) = engine();
        let t = Table::new(&hello("p1"), &pool).unwrap();
        let s = e.load_state(&full_state(&t, &pool, &board(), "p1", &mut Rng::default()).unwrap()).unwrap();
        let v = view(&e, &s, Some(Seat::P1));
        let p2 = &v.players["p2"];
        assert_eq!((p2.ground[0].id.as_str(), p2.ground[0].p, p2.ground[0].h, p2.ground[0].d), ("c9", 3, 4, 1));
        assert_eq!(p2.ground[0].u[0].n.as_deref(), Some("Shield"));
        assert_eq!((v.players["p1"].base.d, v.players["p1"].hand.as_ref().unwrap().len()), (4, 2));
        assert!(v.players["p2"].hand.is_none());
        // the referee's actions here are Pass, Claim Initiative, the Jawa (the Pod costs 3) and maybe the leader
        let legal = e.legal_actions(&s);
        let d = decide(&e, &s, &legal);
        assert!(d.prompt.action_window);
        let jawa = d.actions.iter().find(|a| a.card.as_ref().is_some_and(|c| c.id == "c2")).unwrap();
        assert_eq!(jawa.card.as_ref().unwrap().zone.as_deref(), Some("hand"));
        assert_eq!(legal.iter().filter(|b| same(jawa, b)).count(), 1);
        assert!(!legal.iter().any(|b| b.card.as_deref() == Some("c0")));
        let pass = d.actions.iter().find(|a| a.label == "Pass").unwrap();
        assert_eq!(legal.iter().filter(|b| same(pass, b)).count(), 1);
    }
}
