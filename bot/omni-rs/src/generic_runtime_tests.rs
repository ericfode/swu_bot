use super::*;
use std::path::Path;
fn engine() -> Engine {
    Engine::from_catalogue_bytes(include_bytes!("../../card-compiler/generated/catalog.json"))
        .unwrap()
}
#[test]
fn catalogue_admission_is_explicit_and_original_leaders_use_programs() {
    let e = engine();
    eprintln!(
        "executable={}, rejected={}",
        e.definitions.len(),
        e.rejected_cards().unwrap().len()
    );
    for code in ["SOR_014", "IBH_053", "SEC_005"] {
        let d = &e.definitions[*e
            .by_code
            .get(code)
            .unwrap_or_else(|| panic!("{code}: {:?}", e.rejected_cards().unwrap().get(code)))
            as usize];
        assert!(!d.programs.leader.is_empty());
    }
    assert!(
        e.rejected_cards().unwrap().len() > 1000,
        "unimplemented mechanics must remain rejected"
    );
    assert!(
        e.definitions.len() > 100,
        "generic runtime must expand beyond original pool"
    );
}
#[test]
fn generated_programs_match_all_committed_engine_traces() {
    let mut e = engine();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    e.pool_hash = Engine::from_pool(&root.join("../omni/rs/pool.json"))
        .unwrap()
        .pool_hash;
    for file in std::fs::read_dir(root.join("tests/fixtures")).unwrap() {
        let path = file.unwrap().path();
        if path.extension().is_some_and(|e| e == "gz") {
            let result = crate::check::check(&e, &path)
                .unwrap_or_else(|err| panic!("{}: {err}", path.display()));
            assert!(result.matched);
        }
    }
}
fn add(e: &Engine, s: &mut State, seat: Seat, code: &str) -> CardId {
    let id = s.next_id;
    s.next_id += 1;
    *s.card_mut(id) = Card {
        present: true,
        def: *e.by_code.get(code).unwrap(),
        owner: seat,
        ..Card::default()
    };
    id
}
fn board(e: &Engine) -> State {
    let mut s = State::default();
    for (seat, leader) in [(Seat::P1, "SOR_014"), (Seat::P2, "IBH_053")] {
        let base = add(e, &mut s, seat, "ASH_019");
        let leader = add(e, &mut s, seat, leader);
        s.player_mut(seat).base = base;
        s.player_mut(seat).leader = leader;
    }
    s
}
fn unit(e: &Engine, s: &mut State, seat: Seat, code: &str) -> CardId {
    let id = add(e, s, seat, code);
    e.add_arena(s, id).unwrap();
    id
}
fn hand(e: &Engine, s: &mut State, code: &str) -> CardId {
    let id = add(e, s, Seat::P1, code);
    s.players[0].hand.push(id).unwrap();
    for _ in 0..8 {
        let resource = add(e, s, Seat::P1, "LOF_254");
        s.players[0].resources.push(resource).unwrap();
    }
    id
}
#[test]
fn token_helper_filters_bases_even_when_resolver_type_is_any() {
    let e = engine();
    let mut s = board(&e);
    let own = unit(&e, &mut s, Seat::P1, "LOF_254");
    let enemy = unit(&e, &mut s, Seat::P2, "LOF_256");
    let event = hand(&e, &mut s, "SOR_073");
    let s = e.apply(&s, &e.card_action(&s, event)).unwrap();
    assert_eq!(s.decision, Decision::AbilityTarget);
    let targets: Vec<_> = e.legal_actions(&s).iter().filter_map(Action::id).collect();
    assert_eq!(targets, vec![own, enemy]);
    let s = e.apply(&s, &e.card_action(&s, own)).unwrap();
    assert_ne!(s.card(own).shield, 0);
    assert!(s.players[0].discard.contains(event));
}
#[test]
fn effectless_event_is_paid_and_discarded_without_confirmation() {
    let e = engine();
    let mut s = board(&e);
    unit(&e, &mut s, Seat::P1, "LOF_254");
    let event = hand(&e, &mut s, "SOR_169");
    let before = e.ready_resources(&s, Seat::P1);
    let cost = e.cost(&s, event);
    let s = e.apply(&s, &e.card_action(&s, event)).unwrap();
    assert_eq!(s.decision, Decision::Window);
    assert_eq!(s.active, Seat::P2);
    assert!(s.players[0].discard.contains(event));
    assert_eq!(e.ready_resources(&s, Seat::P1), before - cost as usize);
}
#[test]
fn shield_consumes_oldest_identity_and_experience_round_trips() {
    let e = engine();
    let mut s = board(&e);
    let target = unit(&e, &mut s, Seat::P1, "LOF_254");
    let hp = e.hp(&s, target);
    let power = e.power(&s, target, false);
    e.create_token(&mut s, target, false).unwrap();
    let old = s.card(target).shield;
    e.create_token(&mut s, target, false).unwrap();
    let new = s.card(target).shield;
    e.damage(&mut s, target, 5);
    assert_eq!(s.card(target).shield, new);
    assert_eq!(s.card(new).next_token, 0);
    assert_ne!(old, new);
    assert_eq!(s.card(target).damage, 0);
    e.create_token(&mut s, target, true).unwrap();
    e.create_token(&mut s, target, true).unwrap();
    assert_eq!(e.hp(&s, target), hp + 2);
    assert_eq!(e.power(&s, target, false), power + 2);
    let snapshot = e.snapshot(&s);
    assert_eq!(e.snapshot(&e.load_state(&snapshot).unwrap()), snapshot);
}
#[test]
fn native_tokens_fail_closed_if_source_or_stats_change() {
    let original: Value =
        serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json"))
            .unwrap();
    for (field, value) in [
        ("sourceHash", json!("changed")),
        (
            "card",
            json!({"types":["token","upgrade"],"internalName":"shield","hp":1,"power":1,"upgradeHp":1,"upgradePower":1}),
        ),
    ] {
        let mut c = original.clone();
        let shield = c["cards"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|c| c["setCode"] == "TOKEN_SHIELD")
            .unwrap();
        shield[field] = value;
        assert!(Engine::from_catalogue_value(&c).is_err());
    }
}
#[test]
fn subset_pool_binds_provenance_and_rejects_metadata_changes() {
    let e = engine();
    let mut pool = e.compiled_pool().unwrap();
    let bytes = serde_json::to_vec(&pool).unwrap();
    let catalog = include_bytes!("../../card-compiler/generated/catalog.json");
    let subset = Engine::from_compiled_pool_bytes(&bytes, catalog).unwrap();
    assert_eq!(subset.pool_hash(), format!("{:x}", Sha256::digest(&bytes)));
    pool["cards"][0]["power"] = json!(999);
    assert!(
        Engine::from_compiled_pool_bytes(&serde_json::to_vec(&pool).unwrap(), catalog)
            .err()
            .unwrap()
            .contains("differs")
    );
}
#[test]
fn resource_costs_are_aggregated_and_cancel_restores_continuation_state() {
    let mut e = engine();
    let mut s = board(&e);
    let leader = s.players[0].leader;
    let id = e.card_programs(&s, leader)[0];
    e.catalogue.as_mut().unwrap().programs[id as usize].costs = vec![
        Cost::Resources {
            amount: Expr::number(1),
        },
        Cost::Resources {
            amount: Expr::number(1),
        },
    ];
    let a = add(&e, &mut s, Seat::P1, "LOF_254");
    s.players[0].resources.push(a).unwrap();
    assert!(e.available_programs(&s, leader, "action").is_empty());
    let b = add(&e, &mut s, Seat::P1, "LOF_254");
    s.players[0].resources.push(b).unwrap();
    assert_eq!(e.available_programs(&s, leader, "action"), vec![id]);
    s.ability_program = id + 1;
    s.ability_pc = 2;
    s.ability_target = a;
    s.ability_result = 3;
    s.ability_succeeded = true;
    s.ability_return = 1;
    s.ability_committed = true;
    e.cancel(&mut s);
    assert_eq!(
        (
            s.ability_program,
            s.ability_pc,
            s.ability_target,
            s.ability_result,
            s.ability_succeeded,
            s.ability_return,
            s.ability_committed
        ),
        (0, 0, 0, 0, false, 0, false)
    );
}
#[test]
fn no_legal_event_targets_offer_play_anyway_and_preserve_cancel() {
    let e = engine();
    let mut s = board(&e);
    let event = hand(&e, &mut s, "SOR_073");
    let original = s;
    let s = e.apply(&s, &e.card_action(&s, event)).unwrap();
    assert_eq!(s.decision, Decision::AbilityNoEffect);
    assert_eq!(
        e.legal_actions(&s),
        vec![
            Action::button("Play anyway", 0),
            Action::button("Cancel", 1)
        ]
    );
    let canceled = e.apply(&s, &Action::button("Cancel", 1)).unwrap();
    assert_eq!(canceled, original);
}
#[test]
fn replacement_resolution_and_actual_damage_are_distinct() {
    let e = engine();
    let mut s = board(&e);
    let source = unit(&e, &mut s, Seat::P1, "LOF_254");
    s.source = source;
    e.create_token(&mut s, source, false).unwrap();
    let (amount, resolved) = e
        .apply_effect(
            &mut s,
            &Effect::Damage {
                amount: Expr::number(1),
                target: Target::name("self"),
            },
        )
        .unwrap();
    assert_eq!(amount, 0);
    assert!(resolved, "shield replacement resolved the damage event");
    let (amount, resolved) = e
        .apply_effect(
            &mut s,
            &Effect::Heal {
                amount: Expr::number(2),
                target: Target::name("self"),
            },
        )
        .unwrap();
    assert_eq!(amount, 0);
    assert!(!resolved, "healing zero does not satisfy ifYouDo");
}
