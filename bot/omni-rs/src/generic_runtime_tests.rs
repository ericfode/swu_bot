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
        def: *e.by_code.get(code).unwrap_or_else(||panic!("{code}: {:?}",e.rejected_cards().unwrap().get(code))),
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

#[test]
fn phase_stat_stacking_clamping_cleanup_and_roundtrip() {
    let e = engine();
    let mut s = board(&e);
    let id = unit(&e, &mut s, Seat::P1, "LOF_254");
    let baseline_power = e.power(&s, id, false);
    let baseline_hp = e.hp(&s, id);
    s.source = id;
    s.ability_target = id;
    let effect = crate::ability_ir::Effect::ModifyStats {
        target: crate::ability_ir::Target::name("chosen"),
        power: crate::ability_ir::Expr::number(2),
        hp: crate::ability_ir::Expr::number(3),
        duration: "phase".into(),
    };
    e.apply_effect(&mut s, &effect).unwrap();
    e.apply_effect(&mut s, &effect).unwrap();
    assert_eq!(e.power(&s, id, false), baseline_power + 4);
    assert_eq!(e.hp(&s, id), baseline_hp + 6);
    s.source = 0;
    s.ability_target = 0;
    let restored = e.load_state(&e.snapshot(&s)).unwrap();
    assert_eq!(restored.card(id).phase_power, 4);
    assert_eq!(restored.card(id).phase_hp, 6);
    assert_eq!(e.snapshot(&s), e.snapshot(&restored));
    s.card_mut(id).damage = baseline_hp;
    s.players[0].out = true;
    s.players[1].out = true;
    e.advance(&mut s).unwrap();
    assert!(!e.in_arena(&s, id));
    assert!(s.players[0].discard.contains(id));
    assert_eq!(s.card(id).phase_hp, 0);
    assert_eq!(s.card(id).phase_power, 0);
}

#[test]
fn bounce_clears_arena_state_and_returns_discard_without_defeat_semantics() {
    let e = engine();
    let mut s = board(&e);
    let id = unit(&e, &mut s, Seat::P2, "LOF_254");
    s.source = s.players[0].leader;
    s.ability_target = id;
    s.card_mut(id).phase_power = 2;
    s.card_mut(id).phase_hp = 3;
    s.card_mut(id).damage = 1;
    e.create_token(&mut s, id, false).unwrap();
    e.create_token(&mut s, id, true).unwrap();
    let effect = crate::ability_ir::Effect::ReturnToHand {
        target: crate::ability_ir::Target::name("chosen"),
    };
    assert_eq!(e.apply_effect(&mut s, &effect).unwrap(), (1, true));
    assert!(!e.in_arena(&s, id));
    assert!(s.players[1].hand.contains(id));
    assert!(!s.players[1].discard.contains(id));
    assert_eq!(s.card(id).damage, 0);
    assert_eq!(s.card(id).phase_power, 0);
    assert_eq!(s.card(id).phase_hp, 0);
    assert_eq!(s.card(id).shield, 0);
    assert_eq!(s.card(id).experience, 0);
    s.players[1].hand.remove(id);
    s.players[1].discard.push(id).unwrap();
    assert_eq!(e.apply_effect(&mut s, &effect).unwrap(), (1, true));
    assert!(s.players[1].hand.contains(id));
}
#[test]
fn zero_phase_stats_are_legal_and_resolve_an_event() {
    let e = engine();
    let mut s = board(&e);
    let id = unit(&e, &mut s, Seat::P1, "LOF_254");
    s.source = id;
    s.ability_target = id;
    let effect = crate::ability_ir::Effect::ModifyStats {
        target: crate::ability_ir::Target::name("chosen"),
        power: crate::ability_ir::Expr::number(0),
        hp: crate::ability_ir::Expr::number(0),
        duration: "phase".into(),
    };
    assert!(e.effect_can_affect(&s, id, id, &effect, true));
    assert_eq!(e.apply_effect(&mut s, &effect).unwrap(), (1, true));
    assert_eq!(
        e.apply_effect(&mut s, &crate::ability_ir::Effect::NoAction)
            .unwrap(),
        (0, false)
    );
}

#[test]
fn discard_unit_selector_excludes_events_and_array_predicates_use_any_member() {
    let e = engine();
    let mut s = board(&e);
    let id = add(&e, &mut s, Seat::P1, "LOF_254");
    let event = e
        .definitions
        .iter()
        .position(|d| d.info.is("event"))
        .unwrap() as u16;
    let eid = s.next_id;
    s.next_id += 1;
    *s.card_mut(eid) = Card {
        present: true,
        def: event,
        owner: Seat::P1,
        ..Card::default()
    };
    s.players[0].discard.push(id).unwrap();
    s.players[0].discard.push(eid).unwrap();
    let resolver: crate::ability_ir::TargetResolver =
        serde_json::from_value(json!({"owner":"self","type":"nonLeaderUnit","zone":"discard"}))
            .unwrap();
    assert_eq!(
        e.matching_targets(&s, s.players[0].leader, &resolver),
        vec![id]
    );
    let trait_name = e.def(&s, id).traits.first().unwrap().clone();
    let expr:crate::ability_ir::Expr=serde_json::from_value(json!({"kind":"query","name":"hasSomeTrait","receiver":{"kind":"ref","path":["card"]},"args":[{"kind":"array","items":[{"kind":"const","value":"missing"},{"kind":"const","value":trait_name}]}]})).unwrap();
    expr.validate().unwrap();
    assert!(e.eval(&s, s.players[0].leader, id, &expr).truth());
}

#[test]
fn phase_stat_bounds_clamp_negative_power_and_reject_overflow() {
    let e = engine();
    let mut s = board(&e);
    let id = unit(&e, &mut s, Seat::P1, "LOF_254");
    s.source = id;
    s.ability_target = id;
    let effect = |power, hp| crate::ability_ir::Effect::ModifyStats {
        target: crate::ability_ir::Target::name("chosen"),
        power: crate::ability_ir::Expr::number(power),
        hp: crate::ability_ir::Expr::number(hp),
        duration: "phase".into(),
    };
    e.apply_effect(&mut s, &effect(-100, 0)).unwrap();
    assert_eq!(e.power(&s, id, false), 0);
    assert!(e
        .apply_effect(&mut s, &effect(100000, 0))
        .unwrap_err()
        .contains("capacity"));
    let expr:crate::ability_ir::Expr=serde_json::from_value(json!({"kind":"math","name":"max","args":[{"kind":"const","value":0},{"kind":"const","value":-3}]})).unwrap();
    expr.validate_number().unwrap();
    assert_eq!(e.eval(&s, id, id, &expr).number(), 0);
    let expr:crate::ability_ir::Expr=serde_json::from_value(json!({"kind":"math","name":"min","args":[{"kind":"const","value":10},{"kind":"const","value":3}]})).unwrap();
    expr.validate_number().unwrap();
    assert_eq!(e.eval(&s, id, id, &expr).number(), 3);
    let mut value = e.snapshot(&s);
    value["players"]["p1"]["ground"][0]["phaseStats"]["power"] = json!(65536);
    assert!(e.load_state(&value).unwrap_err().contains("phase power"));
}

#[test]
fn constant_aura_is_live_filters_controller_and_removal_defeats_damaged_unit() {
    let mut e = engine();
    let mut s = board(&e);
    let source = unit(&e, &mut s, Seat::P1, "LOF_254");
    let target = unit(&e, &mut s, Seat::P1, "ASH_029");
    let enemy = unit(&e, &mut s, Seat::P2, "ASH_029");
    let baseline = e.hp(&s, target);
    let power = e.power(&s, target, false);
    let ability:crate::ability_ir::Ability=serde_json::from_value(json!({"trigger":"constant","title":"Test live aura","targetResolver":{"owner":"self","type":"unit","zone":"arena"},"condition":{"kind":"binary","op":">=","left":{"kind":"ref","path":["source","damage"]},"right":{"kind":"const","value":1}},"effect":{"kind":"modifyStats","target":"chosen","duration":"persistent","power":{"kind":"const","value":2},"hp":{"kind":"const","value":1}}})).unwrap();
    let program = crate::ability_ir::Program::compile(&ability).unwrap();
    let index = e.catalogue.as_ref().unwrap().programs.len() as u16;
    e.catalogue.as_mut().unwrap().programs.push(program);
    e.definitions[s.card(source).def as usize]
        .programs
        .card
        .push(index);
    assert_eq!(e.hp(&s, target), baseline);
    s.card_mut(source).damage = 1;
    assert_eq!(e.hp(&s, target), baseline + 1);
    assert_eq!(e.power(&s, target, false), power + 2);
    assert_eq!(e.hp(&s, enemy), baseline);
    s.card_mut(target).damage = baseline;
    e.sweep_stat_defeats(&mut s).unwrap();
    assert!(e.in_arena(&s, target));
    e.defeat(&mut s, source).unwrap();
    e.sweep_stat_defeats(&mut s).unwrap();
    assert!(!e.in_arena(&s, target));
    assert!(s.players[0].discard.contains(target));
}
#[test]
fn constant_stat_cycles_fail_closed_and_arena_query_rebinds_card() {
    let e = engine();
    let mut s = board(&e);
    let id = unit(&e, &mut s, Seat::P1, "LOF_254");
    let expr:crate::ability_ir::Expr=serde_json::from_value(json!({"kind":"query","name":"arenaUnitCount","receiver":{"kind":"ref","path":["player"]},"args":[{"kind":"binary","op":"===","left":{"kind":"ref","path":["card"]},"right":{"kind":"ref","path":["source"]}}]})).unwrap();
    expr.validate_number().unwrap();
    assert_eq!(e.eval(&s, id, 0, &expr).number(), 1);
    let ability:crate::ability_ir::Ability=serde_json::from_value(json!({"trigger":"constant","title":"cycle","condition":{"kind":"binary","op":">","left":{"kind":"ref","path":["source","power"]},"right":{"kind":"const","value":0}},"effect":{"kind":"modifyStats","target":"self","duration":"persistent","power":{"kind":"const","value":1},"hp":{"kind":"const","value":0}}})).unwrap();
    assert!(crate::ability_ir::Program::compile(&ability)
        .unwrap_err()
        .contains("cycles"));
}

#[test]
fn ready_resources_preserves_first_exhausted_resource_order_and_caps_amount() {
    let e = engine();
    let mut s = board(&e);
    s.source = s.players[0].leader;
    let mut ids = vec![];
    for exhausted in [true, false, true] {
        let id = add(&e, &mut s, Seat::P1, "LOF_254");
        s.players[0].resources.push(id).unwrap();
        s.card_mut(id).exhausted = exhausted;
        ids.push(id);
    }
    let effect = crate::ability_ir::Effect::ReadyResources {
        target: crate::ability_ir::Target::name("ownPlayer"),
        amount: crate::ability_ir::Expr::number(1),
    };
    assert_eq!(e.apply_effect(&mut s, &effect).unwrap(), (1, true));
    assert!(!s.card(ids[0]).exhausted);
    assert!(s.card(ids[2]).exhausted);
    let effect = crate::ability_ir::Effect::ReadyResources {
        target: crate::ability_ir::Target::name("ownPlayer"),
        amount: crate::ability_ir::Expr::number(3),
    };
    assert_eq!(e.apply_effect(&mut s, &effect).unwrap(), (1, false));
    assert!(!s.card(ids[2]).exhausted);
}

#[test]
fn admitted_plain_base_metadata_hp_controls_terminal_threshold() {
    let e = engine();
    for (code, hp) in [("IBH_002", 20), ("JTL_031", 34)] {
        let mut s = board(&e);
        let base = s.players[0].base;
        s.card_mut(base).def = *e.by_code.get(code).unwrap();
        s.card_mut(base).damage = hp - 1;
        e.check_win(&mut s);
        assert!(!s.is_terminal());
        assert_eq!(e.snapshot(&s)["players"]["p1"]["base"]["hp"], json!(hp));
        e.load_state(&e.snapshot(&s)).unwrap();
        s.card_mut(base).damage = hp;
        e.check_win(&mut s);
        assert_eq!(s.outcome, 2);
    }
}

#[test]
fn capability_and_upgrade_queries_use_type_and_attached_token_state() {
    let e = engine();
    let mut s = board(&e);
    let id = unit(&e, &mut s, Seat::P1, "LOF_254");
    let query = |name: &str| crate::ability_ir::Expr::Query {
        name: name.into(),
        receiver: Box::new(crate::ability_ir::Expr::Ref {
            path: vec!["card".into()],
        }),
        args: vec![],
    };
    assert!(!e.eval(&s, id, id, &query("isUpgraded")).truth());
    assert!(e.eval(&s, id, id, &query("canBeExhausted")).truth());
    assert!(!e
        .eval(&s, id, s.players[0].base, &query("canBeExhausted"))
        .truth());
    e.create_token(&mut s, id, false).unwrap();
    assert!(e.eval(&s, id, id, &query("isUpgraded")).truth());
    e.leave_play(&mut s, id).unwrap();
    assert!(!e.eval(&s, id, id, &query("isUpgraded")).truth());
}

#[test]
fn phase_expiry_marks_all_lethal_units_before_negative_aura_source_leaves() {
    let mut e = engine();
    let mut s = board(&e);
    let source = unit(&e, &mut s, Seat::P1, "LOF_254");
    let target = unit(&e, &mut s, Seat::P2, "ASH_029");
    let source_hp = e.hp(&s, source);
    let target_hp = e.hp(&s, target);
    let ability:crate::ability_ir::Ability=serde_json::from_value(json!({"trigger":"constant","title":"negative aura","targetResolver":{"owner":"opponent","type":"nonLeaderUnit","zone":"arena"},"effect":{"kind":"modifyStats","target":"chosen","duration":"persistent","power":{"kind":"const","value":-2},"hp":{"kind":"const","value":-2}}})).unwrap();
    let index = e.catalogue.as_ref().unwrap().programs.len() as u16;
    e.catalogue
        .as_mut()
        .unwrap()
        .programs
        .push(crate::ability_ir::Program::compile(&ability).unwrap());
    e.definitions[s.card(source).def as usize]
        .programs
        .card
        .push(index);
    s.card_mut(source).phase_hp = 4;
    s.card_mut(target).phase_hp = 4;
    s.card_mut(source).damage = source_hp + 1;
    s.card_mut(target).damage = target_hp - 1;
    assert!(s.card(source).damage < e.hp(&s, source));
    assert!(s.card(target).damage < e.hp(&s, target));
    s.players[0].out = true;
    s.players[1].out = true;
    e.advance(&mut s).unwrap();
    assert!(!e.in_arena(&s, source));
    assert!(!e.in_arena(&s, target));
}
#[test]
fn arena_predicate_card_binding_preserves_outer_target_and_target_arena() {
    let e = engine();
    let mut s = board(&e);
    let source = unit(&e, &mut s, Seat::P1, "LOF_254");
    let target = unit(&e, &mut s, Seat::P1, "ASH_029");
    let expr:crate::ability_ir::Expr=serde_json::from_value(json!({"kind":"query","name":"arenaUnitCount","receiver":{"kind":"ref","path":["player"]},"args":[{"kind":"binary","op":"&&","left":{"kind":"binary","op":"!==","left":{"kind":"ref","path":["card"]},"right":{"kind":"ref","path":["target"]}},"right":{"kind":"binary","op":"<","left":{"kind":"query","name":"getPower","receiver":{"kind":"ref","path":["card"]},"args":[]},"right":{"kind":"query","name":"getPower","receiver":{"kind":"ref","path":["target"]},"args":[]}}}]})).unwrap();
    assert_eq!(e.eval(&s, source, target, &expr).number(), 1);
    s.players[0].ground.remove(source);
    s.players[0].space.push(source).unwrap();
    let expr:crate::ability_ir::Expr=serde_json::from_value(json!({"kind":"query","name":"arenaUnitCount","receiver":{"kind":"ref","path":["player"]},"args":[{"kind":"binary","op":"===","left":{"kind":"ref","path":["card","zoneName"]},"right":{"kind":"ref","path":["target","zoneName"]}}]})).unwrap();
    assert_eq!(e.eval(&s, source, target, &expr).number(), 1);
}
#[test]
fn conditional_nested_selection_availability_checks_candidate_effects() {
    let mut e = engine();
    let mut s = board(&e);
    let source = unit(&e, &mut s, Seat::P1, "LOF_254");
    let target = unit(&e, &mut s, Seat::P2, "ASH_029");
    let ability:crate::ability_ir::Ability=serde_json::from_value(json!({"trigger":"whenPlayed","title":"conditional exhaust","effect":{"kind":"conditional","condition":{"kind":"binary","op":">","left":{"kind":"ref","path":["source","damage"]},"right":{"kind":"const","value":0}},"onTrue":{"kind":"select","targetResolver":{"owner":"opponent","type":"unit","zone":"arena"},"effect":{"kind":"exhaust","target":"chosen"}},"onFalse":{"kind":"noAction"}}})).unwrap();
    let index = e.catalogue.as_ref().unwrap().programs.len() as u16;
    e.catalogue
        .as_mut()
        .unwrap()
        .programs
        .push(crate::ability_ir::Program::compile(&ability).unwrap());
    assert!(!e.program_has_effect(&s, source, index));
    s.card_mut(source).damage = 1;
    assert!(e.program_has_effect(&s, source, index));
    s.card_mut(target).exhausted = true;
    assert!(!e.program_has_effect(&s, source, index));
}

#[test]
fn unverified_collection_targets_and_multiplayer_resource_ready_fail_admission() {
    use crate::ability_ir::{Ability, Expr, Program, Target};
    let array = Target::Expression(Expr::Array {
        items: vec![
            Expr::Ref {
                path: vec!["source".into()],
            },
            Expr::Ref {
                path: vec!["target".into()],
            },
        ],
    });
    assert!(array.validate().unwrap_err().contains("array targets"));
    assert!(Target::Expression(Expr::number(1)).validate().is_err());
    let ability:Ability=serde_json::from_value(json!({"trigger":"event","title":"unverified dual ready","effect":{"kind":"readyResources","target":"bothPlayers","amount":{"kind":"const","value":1}}})).unwrap();
    assert!(Program::compile(&ability)
        .unwrap_err()
        .contains("multi-player"));
}

#[test]
fn leader_deployment_resolves_shielded_keyword_and_advances_token_identity() {
    let mut e = engine();
    let mut s = board(&e);
    let leader = s.players[0].leader;
    e.definitions[s.card(leader).def as usize].flags |= SHIELDED;
    for _ in 0..8 {
        let id = add(&e, &mut s, Seat::P1, "LOF_254");
        s.players[0].resources.push(id).unwrap();
    }
    let menu = e.apply(&s, &e.card_action(&s, leader)).unwrap();
    let deploy = e
        .legal_actions(&menu)
        .into_iter()
        .find(|a| a.label.starts_with("Deploy "))
        .unwrap();
    let before = menu.next_id;
    let after = e.apply(&menu, &deploy).unwrap();
    assert!(after.card(leader).deployed);
    assert_ne!(after.card(leader).shield, 0);
    assert_eq!(after.next_id, before + 1);
}

#[test]
fn internal_selection_commits_event_and_uses_choose_nothing_while_outer_can_cancel() {
    for internal in [false, true] {
        let mut e = engine();
        let mut s = board(&e);
        let code = e
            .definitions
            .iter()
            .find(|d| d.info.is("event"))
            .unwrap()
            .code
            .clone();
        let source = hand(&e, &mut s, &code);
        unit(&e, &mut s, Seat::P2, "ASH_029");
        s.source = source;
        let resolver = json!({"owner":"opponent","type":"unit","zone":"arena","optional":true});
        let effect = json!({"kind":"exhaust","target":"chosen"});
        let value = if internal {
            json!({"trigger":"event","title":"internal","effect":{"kind":"select","targetResolver":resolver,"effect":effect}})
        } else {
            json!({"trigger":"event","title":"outer","targetResolver":resolver,"effect":effect})
        };
        let ability: crate::ability_ir::Ability = serde_json::from_value(value).unwrap();
        let index = e.catalogue.as_ref().unwrap().programs.len() as u16;
        e.catalogue
            .as_mut()
            .unwrap()
            .programs
            .push(crate::ability_ir::Program::compile(&ability).unwrap());
        e.begin_program(&mut s, index, 0).unwrap();
        assert_eq!(s.decision, Decision::AbilityTarget);
        let actions = e.legal_actions(&s);
        assert_eq!(actions.iter().any(|a| a.label == "Cancel"), !internal);
        assert_eq!(s.ability_committed, internal);
        assert!(actions.contains(&if internal {
            Action::button("Choose nothing", "done")
        } else {
            Action::button("Choose no target", "noTarget")
        }));
        assert_eq!(s.players[0].discard.contains(source), internal);
    }
}
#[test]
fn no_target_ambush_retains_trigger_order_choice_and_resolves_without_attack() {
    let mut e = engine();
    let mut s = board(&e);
    let source = unit(&e, &mut s, Seat::P1, "LOF_254");
    s.source = source;
    let ability:crate::ability_ir::Ability=serde_json::from_value(json!({"trigger":"whenPlayed","title":"Draw a card","effect":{"kind":"draw","target":"ownPlayer","amount":{"kind":"const","value":1}}})).unwrap();
    let index = e.catalogue.as_ref().unwrap().programs.len() as u16;
    e.catalogue
        .as_mut()
        .unwrap()
        .programs
        .push(crate::ability_ir::Program::compile(&ability).unwrap());
    let definition = &mut e.definitions[s.card(source).def as usize];
    definition.flags |= AMBUSH;
    definition.programs.card.push(index);
    e.enter_triggers(&mut s).unwrap();
    assert_eq!(s.decision, Decision::TriggerOrder);
    assert_eq!(
        e.ordered_trigger_titles(&s),
        vec!["Draw a card", "(No effect) Ambush"]
    );
    e.resolve_ordered_trigger(&mut s, 1).unwrap();
    assert_ne!(s.decision, Decision::Ambush);
}
#[test]
fn simultaneous_stat_defeats_preserve_arena_entry_order_in_discard() {
    let e = engine();
    let mut s = board(&e);
    let first = unit(&e, &mut s, Seat::P1, "ASH_029");
    let second = unit(&e, &mut s, Seat::P1, "LOF_254");
    e.leave_play(&mut s,first).unwrap();
    s.players[0].discard.remove(first);e.add_arena(&mut s,first).unwrap();
    s.card_mut(first).damage = e.hp(&s, first);
    s.card_mut(second).damage = e.hp(&s, second);
    e.sweep_stat_defeats(&mut s).unwrap();
    assert_eq!(s.players[0].discard.as_slice(), &[second, first]);
}

#[test]
fn incoming_unique_aura_waits_for_choice_and_only_survivor_applies() {
    let mut e = engine();
    let mut s = board(&e);
    let old = unit(&e, &mut s, Seat::P1, "LOF_254");
    let new = unit(&e, &mut s, Seat::P1, "LOF_254");
    let enemy = unit(&e, &mut s, Seat::P2, "ASH_029");
    let baseline = e.hp(&s, enemy);
    let ability: crate::ability_ir::Ability = serde_json::from_value(json!({"trigger":"constant","title":"Negative aura","targetResolver":{"owner":"opponent","type":"unit","zone":"arena"},"effect":{"kind":"modifyStats","target":"chosen","duration":"persistent","power":{"kind":"const","value":0},"hp":{"kind":"const","value":-1}}})).unwrap();
    let program = crate::ability_ir::Program::compile(&ability).unwrap();
    let index = e.catalogue.as_ref().unwrap().programs.len() as u16;
    e.catalogue.as_mut().unwrap().programs.push(program);
    e.definitions[s.card(old).def as usize]
        .programs
        .card
        .push(index);
    s.card_mut(enemy).damage = baseline - 2;
    s.source = new;
    s.trigger_context = 1;
    s.decision = Decision::Unique;
    assert_eq!(e.hp(&s, enemy), baseline - 1);
    e.sweep_stat_defeats(&mut s).unwrap();
    assert!(e.in_arena(&s, enemy));
    for chosen in [old, new] {
        let after = e.apply(&s, &e.card_action(&s, chosen)).unwrap();
        assert!(e.in_arena(&after, enemy));
        assert_eq!(e.hp(&after, enemy), baseline - 1);
        assert!(!e.in_arena(&after, chosen));
    }
}

#[test]
fn unique_choice_precedes_existing_aura_lethal_check_for_incoming_copy() {
    let mut e = engine();
    let mut s = board(&e);
    let old = unit(&e, &mut s, Seat::P1, "ASH_029");
    let new = unit(&e, &mut s, Seat::P1, "ASH_029");
    let aura = unit(&e, &mut s, Seat::P2, "LOF_254");
    let baseline = e.hp(&s, new) as i32;
    let ability: crate::ability_ir::Ability = serde_json::from_value(json!({"trigger":"constant","title":"Lethal negative aura","targetResolver":{"owner":"opponent","type":"unit","zone":"arena"},"effect":{"kind":"modifyStats","target":"chosen","duration":"persistent","power":{"kind":"const","value":0},"hp":{"kind":"const","value":-baseline}}})).unwrap();
    let program = crate::ability_ir::Program::compile(&ability).unwrap();
    let index = e.catalogue.as_ref().unwrap().programs.len() as u16;
    e.catalogue.as_mut().unwrap().programs.push(program);
    e.definitions[s.card(aura).def as usize]
        .programs
        .card
        .push(index);
    s.card_mut(old).phase_hp = 2;
    s.source = new;
    s.trigger_context = 1;
    s.decision = Decision::Unique;
    assert_eq!(e.hp(&s, new), 0);
    e.sweep_stat_defeats(&mut s).unwrap();
    assert!(e.in_arena(&s, new));
    assert_eq!(
        e.legal_actions(&s)
            .iter()
            .filter_map(Action::id)
            .collect::<Vec<_>>(),
        vec![old, new]
    );
    let keep_old = e.apply(&s, &e.card_action(&s, new)).unwrap();
    assert!(e.in_arena(&keep_old, old));
    let keep_new = e.apply(&s, &e.card_action(&s, old)).unwrap();
    assert!(!e.in_arena(&keep_new, new));
}

#[test]
fn lethal_entry_resolves_deaths_before_self_tokens_but_retains_draw_trigger() {
    for effect in [
        json!({"kind":"giveExperience","target":"self","amount":{"kind":"const","value":1}}),
        json!({"kind":"draw","target":"ownPlayer","amount":{"kind":"const","value":1}}),
    ] {
        let mut e = engine();
        let mut s = board(&e);
        let source = unit(&e, &mut s, Seat::P1, "LOF_254");
        let drawn = add(&e, &mut s, Seat::P1, "ASH_029");
        s.players[0].deck.push(drawn).unwrap();
        let ability: crate::ability_ir::Ability = serde_json::from_value(
            json!({"trigger":"whenPlayed","title":"Entry effect","effect":effect}),
        )
        .unwrap();
        let index = e.catalogue.as_ref().unwrap().programs.len() as u16;
        e.catalogue
            .as_mut()
            .unwrap()
            .programs
            .push(crate::ability_ir::Program::compile(&ability).unwrap());
        e.definitions[s.card(source).def as usize]
            .programs
            .card
            .push(index);
        e.definitions[s.card(source).def as usize].flags |= SHIELDED | AMBUSH;
        s.card_mut(source).phase_hp = -(e.hp(&s, source) as i32);
        s.source = source;
        let mut unique = s;
        unique.decision = Decision::Unique;
        e.settle_enter_triggers(&mut unique, Some(source)).unwrap();
        if unique.decision == Decision::TriggerOrder {
            e.resolve_ordered_trigger(&mut unique, 0).unwrap();
        }
        assert_eq!(
            unique.players[0].hand.contains(drawn),
            effect["kind"] == "draw"
        );
        assert_eq!(unique.card(source).shield, 0);
        assert_eq!(unique.disabled_ongoing_source, 0);
        e.enter_triggers(&mut s).unwrap();
        assert!(!e.in_arena(&s, source));
        assert_eq!(s.card(source).experience, 0);
        assert_eq!(s.card(source).shield, 0);
        if s.decision == Decision::TriggerOrder {
            e.resolve_ordered_trigger(&mut s, 0).unwrap();
        }
        if effect["kind"] == "draw" {
            assert!(s.players[0].hand.contains(drawn));
        } else {
            assert!(!s.players[0].hand.contains(drawn));
        }
        assert_eq!(s.disabled_ongoing_source, 0);
    }
}

fn register_keyword_program(e: &mut Engine, s: &State, source: CardId, value: Value) {
    let ability: crate::ability_ir::Ability = serde_json::from_value(value).unwrap();
    let program = crate::ability_ir::Program::compile(&ability).unwrap();
    let index = e.catalogue.as_ref().unwrap().programs.len() as u16;
    e.catalogue.as_mut().unwrap().programs.push(program);
    e.definitions[s.card(source).def as usize].programs.card.push(index);
}
#[test]
fn continuous_keywords_are_live_deduped_and_losses_suppress_all_sources() {
    let mut e = engine(); let mut s = board(&e);
    let source = unit(&e, &mut s, Seat::P1, "LOF_254");
    let target = unit(&e, &mut s, Seat::P1, "LOF_256");
    let enemy = unit(&e, &mut s, Seat::P2, "LOF_256");
    register_keyword_program(&mut e, &s, source, json!({"trigger":"constant","title":"Live keywords","targetResolver":{"owner":"self","type":"unit","zone":"arena"},"effect":{"kind":"simultaneous","effects":[{"kind":"gainKeyword","target":"chosen","keyword":"sentinel","duration":"persistent"},{"kind":"gainKeyword","target":"chosen","keyword":"raid","amount":{"kind":"ref","path":["card","damage"]},"duration":"persistent"}]}}));
    assert!(e.has_keyword(&s,target,"sentinel")); assert!(!e.has_keyword(&s,enemy,"sentinel"));
    assert!(e.has_keyword(&s,target,"raid")); assert_eq!(e.keyword_amount(&s,target,"raid"),0);
    s.card_mut(target).damage=1; assert_eq!(e.keyword_amount(&s,target,"raid"),1);
    s.source=source;s.ability_target=target;
    let loss:crate::ability_ir::Effect=serde_json::from_value(json!({"kind":"loseKeyword","target":"chosen","keyword":"sentinel","duration":"phase"})).unwrap();
    e.apply_effect(&mut s,&loss).unwrap(); assert!(!e.has_keyword(&s,target,"sentinel"));
    let gain:crate::ability_ir::Effect=serde_json::from_value(json!({"kind":"gainKeyword","target":"chosen","keyword":"sentinel","duration":"phase"})).unwrap();
    e.apply_effect(&mut s,&gain).unwrap();assert!(!e.has_keyword(&s,target,"sentinel"));
    e.leave_play(&mut s,source).unwrap();assert_eq!(e.keyword_amount(&s,target,"raid"),0);
    s.card_mut(target).phase_lost_keywords=0;assert!(e.has_keyword(&s,target,"sentinel"));
    e.leave_play(&mut s,target).unwrap();assert_eq!(s.card(target).phase_keyword_presence,0);
}
#[test]
fn phase_keywords_stack_numeric_dedupe_boolean_roundtrip_and_expire() {
    let e=engine();let mut s=board(&e);let target=unit(&e,&mut s,Seat::P1,"LOF_256");s.source=target;s.ability_target=target;
    for (keyword,amount) in [("raid",2),("raid",3),("sentinel",1),("sentinel",1),("raid",0)] {
        let effect:crate::ability_ir::Effect=serde_json::from_value(json!({"kind":"gainKeyword","target":"self","keyword":keyword,"amount":{"kind":"const","value":amount},"duration":"phase"})).unwrap();
        e.apply_effect(&mut s,&effect).unwrap();
    }
    assert_eq!(e.keyword_amount(&s,target,"raid"),5);assert_eq!(e.keyword_amount(&s,target,"sentinel"),1);assert!(e.has_keyword(&s,target,"raid"));
    let snapshot=e.snapshot(&s);let restored=e.load_state(&snapshot).unwrap();assert_eq!(e.keyword_amount(&restored,target,"raid"),5);assert!(e.has_keyword(&restored,target,"raid"));
    s.players[0].out=true;s.players[1].out=true;
    e.advance(&mut s).unwrap();assert_eq!(s.card(target).phase_keyword_presence,0);assert_eq!(e.keyword_amount(&s,target,"raid"),0);
    for bad in [json!({"sentinel":2}),json!({"raid":65536}),json!({"hidden":1}),json!({"restore":-1}),json!({"restore":0})] {
        let mut v=snapshot.clone();v["players"]["p1"]["ground"][0]["phaseKeywords"]=bad;assert!(e.load_state(&v).is_err());
    }
}
#[test]
fn restore_amount_is_captured_before_its_aura_source_leaves() {
    let mut e=engine();let mut s=board(&e);let source=unit(&e,&mut s,Seat::P1,"LOF_254");let attacker=unit(&e,&mut s,Seat::P1,"LOF_256");
    register_keyword_program(&mut e,&s,source,json!({"trigger":"constant","title":"Restore aura","targetResolver":{"owner":"self","type":"unit","zone":"arena"},"effect":{"kind":"gainKeyword","target":"chosen","keyword":"restore","amount":{"kind":"const","value":3},"duration":"persistent"}}));
    s.card_mut(s.players[0].base).damage=5;s.source=attacker;s.target=s.players[1].base;s.trigger_context=2;s.pending_triggers=T_RESTORE;s.attack_restore=e.keyword_amount(&s,attacker,"restore");
    e.leave_play(&mut s,source).unwrap();assert_eq!(e.keyword_amount(&s,attacker,"restore"),0);assert_eq!(e.trigger_title(&s,T_RESTORE),"Restore 3");
    e.resolve_trigger(&mut s,T_RESTORE).unwrap();assert_eq!(s.card(s.players[0].base).damage,2);
}
#[test]
fn keyword_admission_rejects_cycles_unknowns_and_unbounded_values() {
    for effect in [json!({"kind":"gainKeyword","target":"self","keyword":"hidden","duration":"persistent"}),json!({"kind":"gainKeyword","target":"self","keyword":"raid","amount":{"kind":"query","name":"getPower","receiver":{"kind":"ref","path":["source"]}},"duration":"persistent"}),json!({"kind":"gainKeyword","target":"self","keyword":"grit","amount":{"kind":"const","value":2},"duration":"persistent"}),json!({"kind":"gainKeyword","target":"self","keyword":"restore","amount":{"kind":"const","value":-1},"duration":"persistent"})] {
        let a:crate::ability_ir::Ability=serde_json::from_value(json!({"trigger":"constant","title":"Rejected","effect":effect})).unwrap();assert!(crate::ability_ir::Program::compile(&a).is_err());
    }
    let a:crate::ability_ir::Ability=serde_json::from_value(json!({"trigger":"constant","title":"Cycle","condition":{"kind":"query","name":"hasSomeKeyword","receiver":{"kind":"ref","path":["source"]},"args":[{"kind":"const","value":"sentinel"}]},"effect":{"kind":"gainKeyword","target":"self","keyword":"sentinel","duration":"persistent"}})).unwrap();assert!(crate::ability_ir::Program::compile(&a).is_err());
}
#[test]
fn sentinel_filtered_stat_aura_tracks_granted_and_lost_keyword_without_cycles() {
    let e=engine();let mut s=board(&e);let shuttle=unit(&e,&mut s,Seat::P1,"SEC_032");let target=unit(&e,&mut s,Seat::P1,"LOF_256");
    let baseline=e.hp(&s,target);s.source=shuttle;s.ability_target=target;
    let gain:crate::ability_ir::Effect=serde_json::from_value(json!({"kind":"gainKeyword","target":"chosen","keyword":"sentinel","duration":"phase"})).unwrap();e.apply_effect(&mut s,&gain).unwrap();assert_eq!(e.hp(&s,target),baseline+2);
    let loss:crate::ability_ir::Effect=serde_json::from_value(json!({"kind":"loseKeyword","target":"chosen","keyword":"sentinel","duration":"phase"})).unwrap();e.apply_effect(&mut s,&loss).unwrap();assert_eq!(e.hp(&s,target),baseline);
}
#[test]
fn numeric_keyword_overflow_fails_even_with_negative_power_modifier() {
    let mut e=engine();let mut s=board(&e);let source=unit(&e,&mut s,Seat::P1,"LOF_254");let target=unit(&e,&mut s,Seat::P1,"LOF_256");
    s.card_mut(target).phase_power=-65535;
    register_keyword_program(&mut e,&s,source,json!({"trigger":"constant","title":"Huge keywords","targetResolver":{"owner":"self","type":"unit","zone":"arena"},"effect":{"kind":"simultaneous","effects":[{"kind":"gainKeyword","target":"chosen","keyword":"restore","amount":{"kind":"const","value":65535},"duration":"persistent"},{"kind":"gainKeyword","target":"chosen","keyword":"restore","amount":{"kind":"const","value":1},"duration":"persistent"}]}}));
    assert!(e.check_stat_capacity(&s).unwrap_err().contains("restore"));
}
#[test]
fn metadata_keyword_mentions_are_not_intrinsic_keywords() {
    let e=engine();let mut s=board(&e);
    for code in ["LOF_242","SEC_032"] {
        let id=unit(&e,&mut s,Seat::P1,code);assert!(!e.has_keyword(&s,id,"sentinel"),"{code} only mentions Sentinel on other units");assert_eq!(e.def(&s,id).flags & SENTINEL,0);
    }
}
#[test]
fn phase_keyword_arithmetic_and_live_unverified_amounts_fail_admission() {
    for (duration, amount) in [("phase",json!({"kind":"ref","path":["card","damage"]})),("phase",json!({"kind":"binary","op":"-","left":{"kind":"const","value":1},"right":{"kind":"const","value":2}})),("persistent",json!({"kind":"binary","op":"-","left":{"kind":"const","value":1},"right":{"kind":"ref","path":["card","damage"]}}))] {
        let ability:crate::ability_ir::Ability=serde_json::from_value(json!({"trigger":if duration=="phase" {"event"} else {"constant"},"title":"Unsafe amount","effect":{"kind":"gainKeyword","target":"self","duration":duration,"keyword":"raid","amount":amount}})).unwrap();assert!(crate::ability_ir::Program::compile(&ability).is_err());
    }
}
#[test]
fn context_menu_titles_render_live_damage_and_preserve_no_effect_prefix() {
    let mut e=engine();let mut s=board(&e);let source=unit(&e,&mut s,Seat::P1,"LOF_254");
    register_keyword_program(&mut e,&s,source,json!({"trigger":"onAttack","title":"Static title","contextTitle":[{"kind":"const","value":"Deal "},{"kind":"ref","path":["source","damage"]},{"kind":"const","value":" damage from "},{"kind":"ref","path":["source","title"]}],"effect":{"kind":"damage","target":"enemyBase","amount":{"kind":"ref","path":["source","damage"]}}}));
    let p=*e.def(&s,source).programs.card.last().unwrap();
    assert_eq!(e.program_menu_title(&s,source,p),format!("(No effect) Deal 0 damage from {}",e.def(&s,source).info.title));
    s.card_mut(source).damage=2;
    assert_eq!(e.program_menu_title(&s,source,p),format!("Deal 2 damage from {}",e.def(&s,source).info.title));
    s.card_mut(source).damage=3;
    assert_eq!(e.program_menu_title(&s,source,p),format!("Deal 3 damage from {}",e.def(&s,source).info.title));
}
#[test]
fn context_menu_titles_reject_unmodelled_parent_refs_and_object_fragments() {
    for fragment in [json!({"kind":"ref","path":["source","parentCard","title"]}),json!({"kind":"ref","path":["source"]}),json!({"kind":"array","items":[]})] {
        let a:crate::ability_ir::Ability=serde_json::from_value(json!({"trigger":"event","title":"Static","contextTitle":[fragment],"effect":{"kind":"draw","target":"ownPlayer","amount":{"kind":"const","value":1}}})).unwrap();assert!(crate::ability_ir::Program::compile(&a).is_err());
    }
}

#[test]
fn context_titles_bound_recursive_aggregate_literals() {
    let chunk="a".repeat(600);
    for fragments in [json!([{"kind":"const","value":chunk},{"kind":"const","value":chunk}]),json!([{"kind":"conditional","condition":{"kind":"const","value":true},"then":{"kind":"const","value":chunk},"else":{"kind":"const","value":chunk}}])] {
        let a:crate::ability_ir::Ability=serde_json::from_value(json!({"trigger":"event","title":"Static","contextTitle":fragments,"effect":{"kind":"draw","target":"ownPlayer","amount":{"kind":"const","value":1}}})).unwrap();
        assert!(crate::ability_ir::Program::compile(&a).unwrap_err().contains("aggregate literal bytes"));
    }
    let a:crate::ability_ir::Ability=serde_json::from_value(json!({"trigger":"event","title":"Static","contextTitle":[{"kind":"const","value":"a".repeat(512)},{"kind":"conditional","condition":{"kind":"const","value":true},"then":{"kind":"const","value":"b".repeat(256)},"else":{"kind":"const","value":"c".repeat(256)}}],"effect":{"kind":"draw","target":"ownPlayer","amount":{"kind":"const","value":1}}})).unwrap();
    crate::ability_ir::Program::compile(&a).unwrap();
}
#[test]
fn live_raid_and_overwhelm_do_not_redirect_replaced_shield_damage() {
    let mut e=engine();let mut s=board(&e);let attacker=unit(&e,&mut s,Seat::P1,"LOF_254");let defender=unit(&e,&mut s,Seat::P2,"LOF_256");
    register_keyword_program(&mut e,&s,attacker,json!({"trigger":"constant","title":"Live raid","effect":{"kind":"gainKeyword","target":"self","duration":"persistent","keyword":"raid","amount":{"kind":"ref","path":["player","exhaustedResourceCount"]}}}));
    register_keyword_program(&mut e,&s,attacker,json!({"trigger":"constant","title":"Conditional overwhelm","condition":{"kind":"binary","op":"===","left":{"kind":"ref","path":["player","readyResourceCount"]},"right":{"kind":"const","value":0}},"effect":{"kind":"gainKeyword","target":"self","duration":"persistent","keyword":"overwhelm"}}));
    for _ in 0..14 { let resource=add(&e,&mut s,Seat::P1,"LOF_256");s.players[0].resources.push(resource).unwrap();s.card_mut(resource).exhausted=true; }
    s.card_mut(s.players[1].base).damage=24;
    s.source=attacker;s.target=defender;s.trigger_context=2;
    e.create_token(&mut s,defender,false).unwrap();
    let mut unshielded=s;unshielded.card_mut(defender).shield=0;
    assert!(e.power(&s,attacker,true)>e.hp(&s,defender)+6);
    e.combat(&mut s).unwrap();assert!(s.is_action_window());assert!(!s.is_terminal());assert_eq!(s.card(s.players[1].base).damage,24);assert_eq!(s.card(defender).damage,0);assert_eq!(s.card(defender).shield,0);
    e.combat(&mut unshielded).unwrap();assert!(unshielded.is_terminal());assert_eq!(unshielded.winner(),Some(Seat::P1));
}

fn begin_group_test(e:&mut Engine,s:&mut State,source:CardId,value:Value) {
    register_keyword_program(e,s,source,value);
    let p=*e.def(s,source).programs.card.last().unwrap(); s.source=source;
    e.begin_program(s,p,0).unwrap();
}
#[test]
fn event_group_defers_damage_deaths_and_checks_both_lethal_bases_together() {
    let mut e=engine(); let mut s=board(&e);
    let source=unit(&e,&mut s,Seat::P1,"LOF_256");
    s.card_mut(source).damage=e.hp(&s,source)-1;
    let damage=s.card(source).damage;
    begin_group_test(&mut e,&mut s,source,json!({"trigger":"action","title":"Damage then heal","effect":{"kind":"simultaneous","effects":[{"kind":"damage","target":"self","amount":{"kind":"const","value":2}},{"kind":"heal","target":"self","amount":{"kind":"const","value":2}}]}}));
    assert!(e.in_arena(&s,source)); assert_eq!(s.card(source).damage,damage.saturating_sub(1));
    s.active=Seat::P1;
    for seat in [Seat::P1,Seat::P2] { let base=s.player(seat).base; s.card_mut(base).damage=29; }
    begin_group_test(&mut e,&mut s,source,json!({"trigger":"action","title":"Both lethal","effect":{"kind":"simultaneous","effects":[{"kind":"damage","target":"ownBase","amount":{"kind":"const","value":4}},{"kind":"damage","target":"enemyBase","amount":{"kind":"const","value":4}}]}}));
    assert_eq!(s.outcome,3);
    assert_eq!(s.card(s.players[0].base).damage,30); assert_eq!(s.card(s.players[1].base).damage,30);
}
#[test]
fn event_generation_allocates_tokens_before_nested_selection_and_preserves_outer_binding() {
    let mut e=engine(); let mut s=board(&e);
    let source=unit(&e,&mut s,Seat::P1,"LOF_256"); let target=unit(&e,&mut s,Seat::P2,"LOF_254"); let next=s.next_id;
    begin_group_test(&mut e,&mut s,source,json!({"trigger":"action","title":"Allocate then choose","effect":{"kind":"simultaneous","effects":[{"kind":"giveExperience","target":"self"},{"kind":"select","targetResolver":{"owner":"opponent","type":"unit","zone":"arena"},"effect":{"kind":"giveShield","target":"chosen"}}]}}));
    assert_eq!(s.decision,Decision::AbilityTarget); assert_eq!(s.next_id,next+1); assert_eq!(s.card(source).experience,0);
    assert!(s.card(next).present); assert!(!e.legal_actions(&s).iter().any(|a| a.label=="Cancel"));
    s=e.apply(&s,&e.card_action(&s,target)).unwrap();
    assert_eq!(s.card(source).experience,next); assert_eq!(s.card(target).shield,next+1);
    assert_eq!(s.event_group,EventGroupState::default());
}
#[test]
fn ordered_multi_selection_toggles_at_cap_and_allocates_all_experience_before_shields() {
    let mut e=engine(); let mut s=board(&e);
    let source=unit(&e,&mut s,Seat::P1,"LOF_256"); let target=unit(&e,&mut s,Seat::P1,"LOF_254"); let other=unit(&e,&mut s,Seat::P1,"LOF_254"); let next=s.next_id;
    begin_group_test(&mut e,&mut s,source,json!({"trigger":"action","title":"Ordered tokens","targetResolver":{"owner":"self","type":"unit","zone":"arena","mode":"upTo","count":{"kind":"const","value":2},"optional":true},"effect":{"kind":"simultaneous","effects":[{"kind":"giveExperience","target":"chosen"},{"kind":"giveShield","target":"chosen"}]}}));
    let initial=s;
    assert!(e.legal_actions(&s).iter().any(|a| a.label=="Choose nothing"));
    s=e.apply(&s,&e.card_action(&s,target)).unwrap(); s=e.apply(&s,&e.card_action(&s,source)).unwrap();
    let order=s.zobrist(); let mut reversed=s; reversed.ability_selection.ids.swap(0,1); assert_ne!(order,reversed.zobrist());
    assert!(!e.legal_actions(&s).iter().any(|a| a.id()==Some(other))); assert!(e.legal_actions(&s).iter().any(|a| a.id()==Some(target)));
    s=e.apply(&s,&e.card_action(&s,target)).unwrap(); s=e.apply(&s,&e.card_action(&s,target)).unwrap();
    let done=e.legal_actions(&s).into_iter().find(|a|a.label=="Done").unwrap(); s=e.apply(&s,&done).unwrap();
    assert_eq!(s.card(source).experience,next); assert_eq!(s.card(target).experience,next+1);
    assert_eq!(s.card(source).shield,next+2); assert_eq!(s.card(target).shield,next+3);
    let cancel=e.legal_actions(&initial).into_iter().find(|a|a.label=="Cancel").unwrap(); let canceled=e.apply(&initial,&cancel).unwrap();
    assert_eq!(canceled.next_id,next); assert_eq!(canceled.ability_selection,Selection::default());
    let mut captured=initial; captured.event_group.records[0].amount=3; assert_ne!(initial.zobrist(),captured.zobrist());
}
#[test]
fn group_same_owner_shields_offer_resolution_menu_to_their_controller() {
    let mut e=engine(); let mut s=board(&e); let source=unit(&e,&mut s,Seat::P1,"LOF_256");
    let a=unit(&e,&mut s,Seat::P2,"LOF_254"); let b=unit(&e,&mut s,Seat::P2,"LOF_254");
    for id in [a,b] { e.create_token(&mut s,id,false).unwrap(); e.create_token(&mut s,id,false).unwrap(); }
    begin_group_test(&mut e,&mut s,source,json!({"trigger":"action","title":"Two shields","targetResolver":{"owner":"opponent","type":"unit","zone":"arena","mode":"upTo","count":{"kind":"const","value":2},"optional":true},"effect":{"kind":"damage","target":"chosen","amount":{"kind":"const","value":2}}}));
    s=e.apply(&s,&e.card_action(&s,a)).unwrap(); s=e.apply(&s,&e.card_action(&s,b)).unwrap();
    let done=e.legal_actions(&s).into_iter().find(|a|a.label=="Done").unwrap(); s=e.apply(&s,&done).unwrap();
    assert_eq!(s.active,Seat::P2); assert_eq!(s.decision,Decision::AbilityGroupShield);
    assert_eq!(e.legal_actions(&s).iter().map(|a|a.label.as_str()).collect::<Vec<_>>(),vec!["Resolve next","Resolve all (2)"]);
    let next=e.legal_actions(&s)[0].clone(); s=e.apply(&s,&next).unwrap();
    for id in [a,b] { assert_eq!(s.card(id).damage,0); assert_eq!(e.token_count(&s,s.card(id).shield),1); }
    assert_eq!(s.active,Seat::P2); assert!(s.is_action_window());
}
#[test]
fn group_captures_live_amounts_before_any_handler_changes_damage() {
    let mut e=engine(); let mut s=board(&e); let source=unit(&e,&mut s,Seat::P1,"LOF_256");
    begin_group_test(&mut e,&mut s,source,json!({"trigger":"action","title":"Captured heal","effect":{"kind":"simultaneous","effects":[{"kind":"damage","target":"self","amount":{"kind":"const","value":1}},{"kind":"heal","target":"self","amount":{"kind":"ref","path":["source","damage"]}}]}}));
    assert_eq!(s.card(source).damage,1,"heal captured zero before the damage handler");
}
#[test]
fn accepting_optional_group_trigger_does_not_offer_pass_again_at_nested_selectors() {
    let mut e=engine(); let mut s=board(&e); let source=unit(&e,&mut s,Seat::P1,"LOF_256");
    let target=unit(&e,&mut s,Seat::P2,"LOF_254");
    begin_group_test(&mut e,&mut s,source,json!({"trigger":"onAttack","optional":true,"title":"Optional damage group","effect":{"kind":"simultaneous","effects":[{"kind":"select","targetResolver":{"owner":"any","type":"base","zone":"base"},"effect":{"kind":"damage","target":"chosen","amount":{"kind":"const","value":1}}},{"kind":"select","targetResolver":{"owner":"opponent","type":"unit","zone":"arena"},"effect":{"kind":"damage","target":"chosen","amount":{"kind":"const","value":1}}}]}}));
    assert_eq!(s.decision,Decision::AbilityOptional);
    let trigger=e.legal_actions(&s).into_iter().find(|a|a.label=="Trigger").unwrap(); s=e.apply(&s,&trigger).unwrap();
    assert_eq!(s.decision,Decision::AbilityTarget);
    assert_eq!(e.legal_actions(&s).iter().filter_map(Action::id).collect::<Vec<_>>(),vec![s.players[0].base,s.players[1].base]);
    assert!(e.legal_actions(&s).iter().all(|a|a.kind=="card"));
    s=e.apply(&s,&e.card_action(&s,s.players[1].base)).unwrap();
    assert_eq!(e.legal_actions(&s).iter().filter_map(Action::id).collect::<Vec<_>>(),vec![target]);
    assert!(e.legal_actions(&s).iter().all(|a|a.kind=="card"));
}
#[test]
fn shield_group_cleanup_rotates_retained_token_identity_between_units() {
    let mut e=engine(); let mut s=board(&e); let source=unit(&e,&mut s,Seat::P1,"LOF_256");
    let a=unit(&e,&mut s,Seat::P2,"LOF_254"); let b=unit(&e,&mut s,Seat::P2,"LOF_254");
    let next=s.next_id;
    for id in [a,b] { e.create_token(&mut s,id,false).unwrap(); e.create_token(&mut s,id,false).unwrap(); }
    begin_group_test(&mut e,&mut s,source,json!({"trigger":"action","title":"Ordered shield replacements","targetResolver":{"owner":"opponent","type":"unit","zone":"arena","mode":"upTo","count":{"kind":"const","value":2},"optional":true},"effect":{"kind":"damage","target":"chosen","amount":{"kind":"const","value":1}}}));
    // Select the second arena unit first, reproducing the independent engine trace.
    s=e.apply(&s,&e.card_action(&s,b)).unwrap(); s=e.apply(&s,&e.card_action(&s,a)).unwrap();
    let done=e.legal_actions(&s).into_iter().find(|a|a.label=="Done").unwrap(); s=e.apply(&s,&done).unwrap();
    let next_action=e.legal_actions(&s).into_iter().find(|a|a.label=="Resolve next").unwrap(); s=e.apply(&s,&next_action).unwrap();
    assert_eq!(s.card(b).shield,next+3,"first replacement removes oldest token");
    assert_eq!(s.card(a).shield,next,"cleanup makes second replacement remove newest token");
    assert_eq!(s.card(a).damage,0); assert_eq!(s.card(b).damage,0);
}
#[test]
fn group_shield_consolidation_preserves_stashed_context_order_for_three_units() {
    let mut e=engine(); let mut s=board(&e); let source=unit(&e,&mut s,Seat::P1,"LOF_256");
    let targets=[unit(&e,&mut s,Seat::P2,"LOF_254"),unit(&e,&mut s,Seat::P2,"LOF_254"),unit(&e,&mut s,Seat::P2,"LOF_254")];
    let start=s.next_id;
    for id in targets { for _ in 0..3 { e.create_token(&mut s,id,false).unwrap(); } }
    begin_group_test(&mut e,&mut s,source,json!({"trigger":"action","title":"Three shield contexts","targetResolver":{"owner":"opponent","type":"unit","zone":"arena","mode":"upTo","count":{"kind":"const","value":3},"optional":true},"effect":{"kind":"damage","target":"chosen","amount":{"kind":"const","value":1}}}));
    for id in targets { s=e.apply(&s,&e.card_action(&s,id)).unwrap(); }
    let done=e.legal_actions(&s).into_iter().find(|a|a.label=="Done").unwrap(); s=e.apply(&s,&done).unwrap();
    let all=e.legal_actions(&s).into_iter().find(|a|a.label=="Resolve all (3)").unwrap(); s=e.apply(&s,&all).unwrap();
    for (i,id) in targets.into_iter().enumerate() {
        let mut attached=vec![]; let mut token=s.card(id).shield;
        while token!=0 { attached.push(token); token=s.card(token).next_token; }
        let removed=start+(3*i+i) as u16;
        assert!(!attached.contains(&removed)); assert_eq!(attached.len(),2); assert_eq!(s.card(id).damage,0);
    }
}
#[test]
fn damage_callback_defeats_follow_selected_order_before_arena_stat_sweep() {
    let mut e=engine(); let mut s=board(&e); let source=unit(&e,&mut s,Seat::P1,"LOF_256");
    let first=unit(&e,&mut s,Seat::P2,"LOF_254"); let second=unit(&e,&mut s,Seat::P2,"LOF_254");
    for id in [first,second] { s.card_mut(id).damage=e.hp(&s,id)-1; }
    begin_group_test(&mut e,&mut s,source,json!({"trigger":"action","title":"Selected deaths","targetResolver":{"owner":"opponent","type":"unit","zone":"arena","mode":"upTo","count":{"kind":"const","value":2},"optional":true},"effect":{"kind":"damage","target":"chosen","amount":{"kind":"const","value":2}}}));
    s=e.apply(&s,&e.card_action(&s,second)).unwrap(); s=e.apply(&s,&e.card_action(&s,first)).unwrap();
    let done=e.legal_actions(&s).into_iter().find(|a|a.label=="Done").unwrap(); s=e.apply(&s,&done).unwrap();
    assert_eq!(s.players[1].discard.as_slice(),&[second,first]);
}
#[test]
fn printed_title_references_use_exact_title_across_roots_and_controllers() {
    let e=engine(); let mut s=board(&e); let own=unit(&e,&mut s,Seat::P1,"LOF_256"); let enemy=unit(&e,&mut s,Seat::P2,"LOF_256");
    for root in ["source","card","target"] {
        let expr=Expr::Ref{path:vec![root.into(),"title".into()]};
        assert_eq!(e.eval(&s,own,enemy,&expr),Eval::Text("Gifted Urchin".into()));
    }
    let source=s.players[0].leader;
    let title=Expr::Ref{path:vec!["source".into(),"title".into()]};
    assert_eq!(e.eval(&s,source,own,&title),Eval::Text("Sabine Wren".into()));
    for expected in ["Gifted Urchin","gifted urchin","gifted-urchin"] {
        let predicate=Expr::Binary{op:"===".into(),left:Box::new(Expr::Ref{path:vec!["card".into(),"title".into()]}),right:Box::new(Expr::Const{value:json!(expected)})};
        let mut resolver:TargetResolver=serde_json::from_value(json!({"owner":"any","type":"unit","zone":"arena"})).unwrap(); resolver.predicate=Some(predicate);
        assert_eq!(e.matching_targets(&s,own,&resolver),if expected=="Gifted Urchin" { vec![own,enemy] } else { vec![] });
    }
}
#[test]
fn printed_title_admission_rejects_numeric_and_query_coercion() {
    for root in ["card","source","target"] {
        let title=Expr::Ref{path:vec![root.into(),"title".into()]}; title.validate().unwrap();
        for op in ["+","-","*","%","<",">=","=="] {
            let e=Expr::Binary{op:op.into(),left:Box::new(title.clone()),right:Box::new(Expr::number(1))}; assert!(e.validate().is_err(),"{root}.{op}");
        }
        for op in ["===","!==","&&","||"] {
            Expr::Binary{op:op.into(),left:Box::new(title.clone()),right:Box::new(Expr::Const{value:json!("Zuckuss")})}.validate().unwrap();
        }
        assert!(Expr::Unary{op:"-".into(),value:Box::new(title.clone())}.validate().is_err());
        assert!(Expr::Query{name:"getPower".into(),receiver:Box::new(title),args:vec![]}.validate().is_err());
    }
}
#[test]
fn damage_pending_negative_aura_does_not_rescue_framework_dead_unit() {
    let mut e=engine(); let mut s=board(&e); let source=unit(&e,&mut s,Seat::P1,"LOF_256");
    let aura=unit(&e,&mut s,Seat::P2,"LOF_256"); let protected=unit(&e,&mut s,Seat::P1,"LOF_254");
    register_keyword_program(&mut e,&s,aura,json!({"trigger":"constant","title":"Negative enemy HP","targetResolver":{"owner":"opponent","type":"unit","zone":"arena"},"effect":{"kind":"modifyStats","target":"chosen","duration":"persistent","power":{"kind":"const","value":0},"hp":{"kind":"const","value":-1}}}));
    register_keyword_program(&mut e,&s,protected,json!({"trigger":"constant","title":"Upgraded HP","condition":{"kind":"query","name":"isUpgraded","receiver":{"kind":"ref","path":["source"]}},"effect":{"kind":"modifyStats","target":"self","duration":"persistent","power":{"kind":"const","value":0},"hp":{"kind":"const","value":1}}}));
    e.create_token(&mut s,protected,false).unwrap(); s.card_mut(protected).damage=e.hp(&s,protected)-1;
    s.card_mut(aura).damage=e.hp(&s,aura)-1;
    begin_group_test(&mut e,&mut s,source,json!({"trigger":"action","title":"Combined defeat batch","targetResolver":{"owner":"any","type":"unit","zone":"arena","mode":"upTo","count":{"kind":"const","value":2},"optional":true},"effect":{"kind":"damage","target":"chosen","amount":{"kind":"const","value":1}}}));
    s=e.apply(&s,&e.card_action(&s,aura)).unwrap(); s=e.apply(&s,&e.card_action(&s,protected)).unwrap();
    let done=e.legal_actions(&s).into_iter().find(|a|a.label=="Done").unwrap(); s=e.apply(&s,&done).unwrap();
    assert!(s.players[1].discard.contains(aura)); assert!(s.players[0].discard.contains(protected));
}
#[test]
fn ordinary_combat_reuses_shield_consolidation_in_chosen_player_order() {
    for opponent_first in [false,true] {
        let e=engine(); let mut s=board(&e); let source=unit(&e,&mut s,Seat::P1,"LOF_256"); let target=unit(&e,&mut s,Seat::P2,"LOF_254");
        let next=s.next_id;
        for id in [source,target] { for _ in 0..3 { e.create_token(&mut s,id,false).unwrap(); } }
        s.source=source; s.target=target; e.combat(&mut s).unwrap(); assert_eq!(s.decision,Decision::ShieldOrder);
        let key=if opponent_first {"Opponent"} else {"You"};
        let action=e.legal_actions(&s).into_iter().find(|a|a.label==key).unwrap(); s=e.apply(&s,&action).unwrap();
        let removed_source=next+u16::from(opponent_first); let removed_target=next+3+u16::from(!opponent_first);
        for (id,removed) in [(source,removed_source),(target,removed_target)] {
            assert!(!e.shield_attached(&s,id,removed)); assert_eq!(e.token_count(&s,s.card(id).shield),2); assert_eq!(s.card(id).damage,0);
        }
        assert!(!s.attack_shield_opponent_first);
    }
}
fn death_program(e:&mut Engine,s:&State,source:CardId,ability:Value)->u16 {
    let a:crate::ability_ir::Ability=serde_json::from_value(ability).unwrap();
    let p=crate::ability_ir::Program::compile(&a).unwrap();
    let index=e.catalogue.as_ref().unwrap().programs.len() as u16;
    e.catalogue.as_mut().unwrap().programs.push(p);
    e.definitions[s.card(source).def as usize].programs.card.push(index);index
}
fn draw_death(optional:bool)->Value {json!({"trigger":"whenDefeated","title":"Draw a card","optional":optional,"effect":{"kind":"draw","target":"ownPlayer","amount":{"kind":"const","value":1}}})}
fn deck_card(e:&Engine,s:&mut State,seat:Seat)->CardId {let id=add(e,s,seat,"LOF_256");s.player_mut(seat).deck.push(id).unwrap();id}
#[test]
fn death_draw_captures_once_and_bounce_never_registers() {
    let mut e=engine();let mut s=board(&e);let source=unit(&e,&mut s,Seat::P1,"LOF_254");let drawn=deck_card(&e,&mut s,Seat::P1);
    death_program(&mut e,&s,source,draw_death(false));
    let mut bounced=s;e.leave_play(&mut bounced,source).unwrap();assert_eq!(bounced.death_pending.len,0);
    e.defeat(&mut s,source).unwrap();e.defeat(&mut s,source).unwrap();assert_eq!(s.death_pending.len,1);
    e.finish(&mut s).unwrap();assert!(s.players[0].hand.contains(drawn));assert!(s.players[0].discard.contains(source));assert_eq!(s.active,Seat::P2);assert_eq!(s.death_depth,0);
}
#[test]
fn death_player_choice_uses_action_player_and_restores_after_optional_decline() {
    let mut e=engine();let mut s=board(&e);s.initiative=Seat::P2;
    let first=unit(&e,&mut s,Seat::P1,"LOF_254");let second=unit(&e,&mut s,Seat::P2,"LOF_256");
    death_program(&mut e,&s,first,draw_death(false));death_program(&mut e,&s,second,draw_death(true));
    let drawn=deck_card(&e,&mut s,Seat::P1);let skipped=deck_card(&e,&mut s,Seat::P2);
    e.defeat_many(&mut s,&[first,second]).unwrap();e.finish(&mut s).unwrap();
    assert_eq!(s.active,Seat::P1);assert_eq!(e.legal_actions(&s),vec![Action::button("You",0),Action::button("Opponent",1)]);
    s=e.apply(&s,&Action::button("Opponent",1)).unwrap();assert_eq!(s.active,Seat::P2);assert_eq!(s.decision,Decision::AbilityOptional);
    assert_eq!(e.legal_actions(&s),vec![Action::button("Trigger","trigger"),Action::button("Pass","pass")]);
    s=e.apply(&s,&Action::button("Pass","pass")).unwrap();assert!(s.players[0].hand.contains(drawn));assert!(s.players[1].deck.contains(skipped));assert_eq!(s.active,Seat::P2);assert_eq!(s.death_depth,0);
}
#[test]
fn repeated_death_group_and_distinct_source_order_match_menu_protocol() {
    let mut e=engine();let mut s=board(&e);let a=unit(&e,&mut s,Seat::P1,"LOF_254");let b=unit(&e,&mut s,Seat::P1,"LOF_254");
    death_program(&mut e,&s,a,draw_death(false));deck_card(&e,&mut s,Seat::P1);deck_card(&e,&mut s,Seat::P1);
    e.defeat_many(&mut s,&[a,b]).unwrap();e.finish(&mut s).unwrap();assert_eq!(s.decision,Decision::DeathBatch);
    assert_eq!(e.legal_actions(&s),vec![Action::button("Resolve next","next"),Action::button("Resolve all (2)","all")]);
    s=e.apply(&s,&Action::button("Resolve all (2)","all")).unwrap();assert_eq!(s.players[0].hand.len,2);assert_eq!(s.death_depth,0);
    let mut s=board(&e);let a=unit(&e,&mut s,Seat::P1,"LOF_254");let b=unit(&e,&mut s,Seat::P1,"ASH_029");death_program(&mut e,&s,b,draw_death(true));deck_card(&e,&mut s,Seat::P1);
    e.defeat_many(&mut s,&[a,b]).unwrap();e.finish(&mut s).unwrap();assert_eq!(s.decision,Decision::DeathOrder);
    assert_eq!(e.legal_actions(&s),vec![Action::button("Draw a card","0"),Action::button("Draw a card","1")]);
}
#[test]
fn nested_sacrifice_restores_parent_if_you_do_result_and_source() {
    let mut e=engine();let mut s=board(&e);let parent=unit(&e,&mut s,Seat::P1,"LOF_254");let child=unit(&e,&mut s,Seat::P1,"ASH_029");
    death_program(&mut e,&s,child,draw_death(true));let draw=deck_card(&e,&mut s,Seat::P1);
    death_program(&mut e,&s,parent,json!({"trigger":"whenDefeated","title":"Sacrifice","targetResolver":{"owner":"self","type":"unit","zone":"arena"},"effect":{"kind":"defeat","target":"chosen"},"ifYouDo":{"title":"Damage","effect":{"kind":"damage","target":"enemyBase","amount":{"kind":"const","value":4}}}}));
    e.defeat(&mut s,parent).unwrap();e.finish(&mut s).unwrap();assert_eq!(s.decision,Decision::AbilityTarget);
    s=e.apply(&s,&e.card_action(&s,child)).unwrap();assert_eq!(s.decision,Decision::AbilityOptional);assert_eq!(s.death_depth,2);assert_eq!(s.source,child);assert_eq!(s.card(s.players[1].base).damage,4);
    s=e.apply(&s,&Action::button("Pass","pass")).unwrap();assert!(s.players[0].deck.contains(draw));assert_eq!(s.card(s.players[1].base).damage,4);assert_eq!(s.death_depth,0);assert_eq!(s.active,Seat::P2);
}
#[test]
fn death_capacity_and_unsettled_group_fail_explicitly_and_hash_covers_context() {
    let mut e=engine();let mut s=board(&e);let source=unit(&e,&mut s,Seat::P1,"LOF_254");death_program(&mut e,&s,source,draw_death(true));
    s.death_pending.len=MAX_DEATH_TRIGGERS as u8;assert!(e.defeat(&mut s,source).unwrap_err().contains("capacity"));assert!(e.in_arena(&s,source));
    s.death_pending=DeathWindow::default();e.capture_death(&mut s,source).unwrap();s.event_group.active=true;assert!(e.open_deaths(&mut s,3).unwrap_err().contains("settled"));
    s.event_group.active=false;s.death_depth=MAX_DEATH_DEPTH as u8;assert!(e.open_deaths(&mut s,3).unwrap_err().contains("nested"));
    let original=s.zobrist();s.death_frames[0].context.ability_succeeded=true;assert_ne!(s.zobrist(),original);
    let original=s.zobrist();s.death_pending.entries[0].player=Seat::P2;assert_ne!(s.zobrist(),original);
}
#[test]
fn nested_explicit_defeat_steps_share_the_initiating_ability_trigger_window() {
    let mut e=engine();let mut s=board(&e);let parent=unit(&e,&mut s,Seat::P1,"LOF_254");let first=unit(&e,&mut s,Seat::P1,"ASH_029");let second=unit(&e,&mut s,Seat::P1,"LOF_256");
    death_program(&mut e,&s,first,draw_death(true));death_program(&mut e,&s,second,draw_death(true));deck_card(&e,&mut s,Seat::P1);deck_card(&e,&mut s,Seat::P1);
    death_program(&mut e,&s,parent,json!({"trigger":"whenDefeated","title":"Nested sacrifices","targetResolver":{"owner":"self","type":"unit","zone":"arena"},"effect":{"kind":"defeat","target":"chosen"},"then":{"title":"Second sacrifice","targetResolver":{"owner":"self","type":"unit","zone":"arena"},"effect":{"kind":"defeat","target":"chosen"}}}));
    e.defeat(&mut s,parent).unwrap();e.finish(&mut s).unwrap();s=e.apply(&s,&e.card_action(&s,first)).unwrap();assert_eq!(s.decision,Decision::AbilityTarget);assert_eq!(s.source,parent);
    s=e.apply(&s,&e.card_action(&s,second)).unwrap();assert_eq!(s.decision,Decision::DeathOrder);
    s=e.apply(&s,&Action::button("Draw a card","1")).unwrap();assert_eq!(s.source,second);assert_eq!(s.decision,Decision::AbilityOptional);
    s=e.apply(&s,&Action::button("Pass","pass")).unwrap();assert_eq!(s.source,first);assert_eq!(s.decision,Decision::AbilityOptional);
    s=e.apply(&s,&Action::button("Trigger","trigger")).unwrap();assert_eq!(s.players[0].hand.len,1);assert_eq!(s.death_pending.len,0);assert_eq!(s.death_depth,0);
}
#[test]
fn sequence_passes_defeat_triggers_to_initiating_window_after_following_draw() {
    let mut e=engine();let mut s=board(&e);let source=unit(&e,&mut s,Seat::P1,"LOF_254");let victim=unit(&e,&mut s,Seat::P1,"ASH_029");death_program(&mut e,&s,victim,draw_death(true));deck_card(&e,&mut s,Seat::P1);
    let program=death_program(&mut e,&s,source,json!({"trigger":"action","title":"Defeat then draw","targetResolver":{"owner":"self","type":"unit","zone":"arena"},"effect":{"kind":"sequence","effects":[{"kind":"defeat","target":"chosen"},{"kind":"draw","target":"ownPlayer","amount":{"kind":"const","value":1}}]}}));
    s.source=source;e.begin_program(&mut s,program,0).unwrap();s=e.apply(&s,&e.card_action(&s,victim)).unwrap();assert_eq!(s.decision,Decision::AbilityOptional);assert_eq!(s.players[0].hand.len,1);
    s=e.apply(&s,&Action::button("Pass","pass")).unwrap();assert_eq!(s.players[0].hand.len,1);assert_eq!(s.death_depth,0);
}
#[test]
fn duplicated_static_death_titles_group_all_programs_consistently() {
    let mut e=engine();let mut s=board(&e);let source=unit(&e,&mut s,Seat::P1,"LOF_254");death_program(&mut e,&s,source,draw_death(false));death_program(&mut e,&s,source,draw_death(false));deck_card(&e,&mut s,Seat::P1);deck_card(&e,&mut s,Seat::P1);
    e.defeat(&mut s,source).unwrap();e.finish(&mut s).unwrap();assert_eq!(e.legal_actions(&s),vec![Action::button("Resolve next","next"),Action::button("Resolve all (2)","all")]);
    s=e.apply(&s,&Action::button("Resolve all (2)","all")).unwrap();assert_eq!(s.players[0].hand.len,2);assert_eq!(s.death_depth,0);
}
#[test]
fn coordinate_stats_follow_both_friendly_arenas_and_attack_registration_is_captured() {
    let mut e=engine();let mut s=board(&e);let source=unit(&e,&mut s,Seat::P1,"LOF_254");let second=unit(&e,&mut s,Seat::P1,"ASH_029");let third=unit(&e,&mut s,Seat::P1,"LOF_256");unit(&e,&mut s,Seat::P2,"LOF_254");
    s.players[0].ground.remove(third);s.players[0].space.push(third).unwrap();
    let hp=e.hp(&s,source);death_program(&mut e,&s,source,json!({"trigger":"constant","coordinate":true,"title":"Coordinate HP","effect":{"kind":"modifyStats","duration":"persistent","target":"self","power":{"kind":"const","value":0},"hp":{"kind":"const","value":3}}}));assert_eq!(e.hp(&s,source),hp+3);
    let program=death_program(&mut e,&s,source,json!({"trigger":"onAttack","coordinate":true,"title":"Draw a card","effect":{"kind":"draw","target":"ownPlayer","amount":{"kind":"const","value":1}}}));let drawn=deck_card(&e,&mut s,Seat::P1);
    s.source=source;e.queue_programs(&mut s,"onAttack");let captured=s.pending_programs;assert_ne!(captured,0);
    e.leave_play(&mut s,third).unwrap();assert_eq!(e.hp(&s,source),hp);assert_eq!(s.pending_programs,captured);e.begin_program(&mut s,program,0).unwrap();assert!(s.players[0].hand.contains(drawn));
    s.source=source;e.queue_programs(&mut s,"onAttack");assert_eq!(s.pending_programs,0);assert!(e.in_arena(&s,second));
}
#[test]
fn simultaneous_explicit_defeat_conditions_capture_before_any_source_moves() {
    let mut e=engine();let mut s=board(&e);let first=unit(&e,&mut s,Seat::P1,"LOF_254");let second=unit(&e,&mut s,Seat::P1,"LOF_254");
    let mut ability=draw_death(false);ability["condition"]=json!({"kind":"binary","op":">=","left":{"kind":"query","name":"arenaUnitCount","receiver":{"kind":"ref","path":["player"]},"args":[{"kind":"const","value":true}]},"right":{"kind":"const","value":2}});
    death_program(&mut e,&s,first,ability);deck_card(&e,&mut s,Seat::P1);deck_card(&e,&mut s,Seat::P1);
    let source=s.players[0].leader;let program=death_program(&mut e,&s,source,json!({"trigger":"action","title":"Defeat two units","targetResolver":{"owner":"self","type":"unit","zone":"arena","mode":"upTo","count":{"kind":"const","value":2}},"effect":{"kind":"defeat","target":"chosen"}}));
    s.source=source;e.begin_program(&mut s,program,0).unwrap();s=e.apply(&s,&e.card_action(&s,first)).unwrap();s=e.apply(&s,&e.card_action(&s,second)).unwrap();
    let done=e.legal_actions(&s).into_iter().find(|a|a.label=="Done").unwrap();s=e.apply(&s,&done).unwrap();assert_eq!(s.players[0].ground.len,0);assert_eq!(s.decision,Decision::DeathBatch);
    s=e.apply(&s,&Action::button("Resolve all (2)","all")).unwrap();assert_eq!(s.players[0].hand.len,2);
}
#[test]
fn created_token_units_keep_owner_readiness_printed_keywords_and_leave_play_zones() {
    let mut e=engine();let mut s=board(&e);let source=s.players[0].leader;let start=s.next_id;
    let p=death_program(&mut e,&s,source,json!({"trigger":"action","title":"Create spies","effect":{"kind":"createTokenUnit","tokenType":"spy","amount":{"kind":"const","value":2},"target":"enemyPlayer","entersReady":true}}));
    s.source=source;e.begin_program(&mut s,p,0).unwrap();assert_eq!(s.players[1].ground.as_slice(),&[start,start+1]);assert_eq!(s.next_id,start+2);
    for id in [start,start+1] {assert_eq!(s.card(id).owner,Seat::P2);assert!(!s.card(id).exhausted);assert_eq!(e.power(&s,id,false),0);assert_eq!(e.power(&s,id,true),2);}
    let snapshot=e.snapshot(&s);assert_eq!(e.snapshot(&e.load_state(&snapshot).unwrap()),snapshot);
    e.defeat(&mut s,start).unwrap();assert!(!s.players[1].discard.contains(start));assert!(!s.players[1].ground.contains(start));
    s.source=source;s.active=Seat::P1;s.ability_target=start+1;e.apply_effect(&mut s,&Effect::ReturnToHand {target:Target::Name("chosen".into())}).unwrap();assert!(!s.players[1].hand.contains(start+1));assert!(!s.players[1].discard.contains(start+1));
}
#[test]
fn token_capacity_rejection_is_transactional_and_raw_ir_is_strict() {
    let mut e=engine();let mut s=board(&e);let source=unit(&e,&mut s,Seat::P1,"LOF_254");s.card_mut(source).exhausted=true;
    death_program(&mut e,&s,source,json!({"trigger":"action","title":"Create two droids","effect":{"kind":"createTokenUnit","tokenType":"battleDroid","amount":{"kind":"const","value":2},"target":"ownPlayer"}}));s.next_id=(MAX_CARDS-1) as u16;let original=s.zobrist();
    assert!(e.apply(&s,&e.card_action(&s,source)).unwrap_err().contains("capacity"));assert_eq!(s.zobrist(),original);
    for effect in [json!({"kind":"createTokenUnit","tokenType":"battleDroid","amount":{"kind":"const","value":6},"target":"ownPlayer"}),json!({"kind":"createTokenUnit","tokenType":"unknown","amount":{"kind":"const","value":1},"target":"ownPlayer"}),json!({"kind":"createTokenUnit","tokenType":"cloneTrooper","amount":{"kind":"ref","path":["source","damage"]},"target":"ownPlayer"})] {
        let a:crate::ability_ir::Ability=serde_json::from_value(json!({"trigger":"whenPlayed","title":"bad","effect":effect})).unwrap();assert!(crate::ability_ir::Program::compile(&a).is_err());
    }
}
#[test]
fn owner_discard_selects_before_simultaneous_draw_and_restores_ability_player() {
    let mut e=engine();let mut s=board(&e);let source=s.players[0].leader;
    let first=add(&e,&mut s,Seat::P2,"LOF_254");let second=add(&e,&mut s,Seat::P2,"ASH_029");s.players[1].hand.push(first).unwrap();s.players[1].hand.push(second).unwrap();let draw=deck_card(&e,&mut s,Seat::P1);
    let p=death_program(&mut e,&s,source,json!({"trigger":"action","title":"Discard and draw","effect":{"kind":"simultaneous","effects":[{"kind":"discardOwnHand","target":"enemyPlayer","amount":{"kind":"const","value":1}},{"kind":"draw","target":"ownPlayer","amount":{"kind":"const","value":1}}]}}));
    s.source=source;e.begin_program(&mut s,p,0).unwrap();assert_eq!(s.decision,Decision::AbilityDiscard);assert_eq!(s.active,Seat::P2);assert!(s.players[0].deck.contains(draw));assert_eq!(e.legal_actions(&s),vec![e.card_action(&s,first),e.card_action(&s,second)]);
    s=e.apply(&s,&e.card_action(&s,second)).unwrap();assert!(s.players[1].discard.contains(second));assert!(s.players[1].hand.contains(first));assert!(s.players[0].hand.contains(draw));assert_eq!(s.active,Seat::P2);
}
#[test]
fn exact_two_card_discard_toggles_at_cap_and_zero_hand_skips_prompt() {
    let mut e=engine();let mut s=board(&e);let source=s.players[0].leader;let mut cards=vec![];
    for code in ["LOF_254","LOF_256","ASH_029"] {let id=add(&e,&mut s,Seat::P2,code);s.players[1].hand.push(id).unwrap();cards.push(id);}
    let p=death_program(&mut e,&s,source,json!({"trigger":"action","title":"Discard two","effect":{"kind":"discardOwnHand","target":"enemyPlayer","amount":{"kind":"const","value":2}}}));s.source=source;e.begin_program(&mut s,p,0).unwrap();
    s=e.apply(&s,&e.card_action(&s,cards[0])).unwrap();assert!(!e.legal_actions(&s).iter().any(|a|a.label=="Done"));s=e.apply(&s,&e.card_action(&s,cards[2])).unwrap();assert!(!e.legal_actions(&s).iter().any(|a|a.id()==Some(cards[1])));assert!(e.legal_actions(&s).iter().any(|a|a.id()==Some(cards[0])));
    s=e.apply(&s,&Action::button("Done","done")).unwrap();assert_eq!(s.players[1].discard.as_slice(),&[cards[0],cards[2]]);
    let mut empty=board(&e);empty.source=empty.players[0].leader;e.begin_program(&mut empty,p,1).unwrap();assert_eq!(empty.decision,Decision::Window);assert_eq!(empty.players[1].discard.len,0);
}
#[test]
fn terminal_optional_opponent_prompt_preserves_latched_action_priority() {
    let mut e=engine();let mut s=board(&e);let source=unit(&e,&mut s,Seat::P1,"LOF_254");let victim=unit(&e,&mut s,Seat::P2,"ASH_029");
    death_program(&mut e,&s,victim,draw_death(true));let draw=deck_card(&e,&mut s,Seat::P2);
    e.definitions[s.card(source).def as usize].flags|=OVERWHELM;s.card_mut(source).phase_power=10;
    s.card_mut(victim).damage=e.hp(&s,victim)-1;s.card_mut(s.players[1].base).damage=29;s.source=source;s.target=victim;
    e.combat(&mut s).unwrap();assert_eq!(s.outcome,1);assert_eq!(s.active,Seat::P2);assert_eq!(s.decision,Decision::AbilityOptional);assert!(e.legal_actions(&s).is_empty());assert!(s.players[1].deck.contains(draw));
    assert_eq!(e.snapshot(&s)["activePlayer"],json!("p1"));
    let original=s.zobrist();s.action_player=None;assert_ne!(s.zobrist(),original);
}

#[test]
fn empty_deck_draw_resolves_fatigue_and_preserves_if_you_do_discard() {
    let mut e=engine();let mut s=board(&e);let source=s.players[0].leader;
    let discard=add(&e,&mut s,Seat::P1,"LOF_254");s.players[0].hand.push(discard).unwrap();
    let program=death_program(&mut e,&s,source,json!({"trigger":"whenPlayed","title":"Draw then discard","optional":true,"effect":{"kind":"draw","target":"ownPlayer","amount":{"kind":"const","value":1}},"ifYouDo":{"title":"Discard a card","effect":{"kind":"discardOwnHand","target":"ownPlayer","amount":{"kind":"const","value":1}}}}));
    s.source=source;e.begin_program(&mut s,program,1).unwrap();assert_eq!(s.decision,Decision::AbilityOptional);
    let declined=e.apply(&s,&Action::button("Pass","pass")).unwrap();assert_eq!(declined.card(declined.players[0].base).damage,0);assert!(declined.players[0].hand.contains(discard));
    s=e.apply(&s,&Action::button("Trigger","trigger")).unwrap();assert_eq!(s.decision,Decision::AbilityDiscard);assert_eq!(s.ability_result,0);assert!(!s.ability_succeeded);assert_eq!(s.card(s.players[0].base).damage,3);
    s=e.apply(&s,&e.card_action(&s,discard)).unwrap();assert!(s.players[0].discard.contains(discard));assert_eq!(s.players[0].hand.len,0);assert_eq!(s.card(s.players[0].base).damage,3);
}
#[test]
fn draw_resolution_and_actual_draw_count_are_separate_in_scalar_and_group_execution() {
    let e=engine();let mut s=board(&e);let source=s.players[0].leader;s.source=source;
    let empty=Effect::Draw {target:Target::Name("ownPlayer".into()),amount:Expr::number(1)};
    assert_eq!(e.apply_effect(&mut s,&empty).unwrap(),(0,true));assert_eq!(s.card(s.players[0].base).damage,3);
    let zero=Effect::Draw {target:Target::Name("ownPlayer".into()),amount:Expr::number(0)};
    assert_eq!(e.apply_effect(&mut s,&zero).unwrap(),(0,false));assert_eq!(s.card(s.players[0].base).damage,3);
    let draw=deck_card(&e,&mut s,Seat::P1);let partial=Effect::Draw {target:Target::Name("ownPlayer".into()),amount:Expr::number(2)};
    assert_eq!(e.apply_effect(&mut s,&partial).unwrap(),(1,true));assert!(s.players[0].hand.contains(draw));assert_eq!(s.card(s.players[0].base).damage,6);
    s.ability_result=0;s.ability_succeeded=false;s.event_group.active=true;s.event_group.initiator=s.active;
    let group=Effect::Simultaneous {effects:vec![empty]};e.generate_group(&mut s,&group).unwrap();e.resolve_group(&mut s,&group).unwrap();assert_eq!(s.ability_result,0);assert!(s.ability_succeeded);assert_eq!(s.card(s.players[0].base).damage,9);
}

#[test]
fn grouped_draw_fatigue_follows_all_primaries_without_early_winner_latch() {
    let e=engine();for (initial,expected) in [(1,3),(29,29)] {let mut s=board(&e);s.source=s.players[0].leader;let base=s.players[0].base;s.card_mut(base).damage=initial;
    s.event_group.active=true;s.event_group.initiator=s.active;
    let group=Effect::Simultaneous {effects:vec![Effect::Draw {target:Target::Name("ownPlayer".into()),amount:Expr::number(1)},Effect::Heal {target:Target::Name("ownBase".into()),amount:Expr::number(3)}]};
    e.generate_group(&mut s,&group).unwrap();e.resolve_group(&mut s,&group).unwrap();assert_eq!(s.card(base).damage,expected);assert_eq!(s.outcome,0);assert!(s.ability_succeeded);}
}

#[test]
fn grouped_draws_reserve_fatigue_contingents_and_reject_same_player_multiplicity() {
    let draw=json!({"kind":"draw","target":"ownPlayer","amount":{"kind":"const","value":1}});
    let duplicate:crate::ability_ir::Ability=serde_json::from_value(json!({"trigger":"event","title":"duplicate draw","effect":{"kind":"simultaneous","effects":[draw.clone(),draw.clone()]}})).unwrap();
    assert!(crate::ability_ir::Program::compile(&duplicate).unwrap_err().contains("multiple grouped draws"));
    let heal=json!({"kind":"heal","target":"ownBase","amount":{"kind":"const","value":1}});
    let mut effects=vec![];for _ in 0..3 {effects.push(json!({"kind":"simultaneous","effects":vec![heal.clone();8]}));}
    let mut last=vec![heal;7];last.push(draw);effects.push(json!({"kind":"simultaneous","effects":last}));
    let too_large:crate::ability_ir::Ability=serde_json::from_value(json!({"trigger":"event","title":"contingent capacity","effect":{"kind":"simultaneous","effects":effects}})).unwrap();
    assert!(crate::ability_ir::Program::compile(&too_large).unwrap_err().contains("record budget"));
}

#[test]
fn empty_discard_group_does_not_inherit_a_preceding_draw_success_for_if_you_do() {
    for enemy_has_card in [false,true] {
        let mut e=engine();let mut s=board(&e);let source=s.players[0].leader;let drawn=deck_card(&e,&mut s,Seat::P1);
        let enemy_card=if enemy_has_card {let id=add(&e,&mut s,Seat::P2,"LOF_254");s.players[1].hand.push(id).unwrap();Some(id)}else{None};
        let program=death_program(&mut e,&s,source,json!({"trigger":"action","title":"Draw then discard","effect":{"kind":"draw","target":"ownPlayer","amount":{"kind":"const","value":1}},"then":{"title":"Enemy discards","effect":{"kind":"discardOwnHand","target":"enemyPlayer","amount":{"kind":"const","value":1}},"ifYouDo":{"title":"Pay damage","effect":{"kind":"damage","target":"ownBase","amount":{"kind":"const","value":1}}}}}));
        s.source=source;e.begin_program(&mut s,program,0).unwrap();assert!(s.players[0].hand.contains(drawn));
        if let Some(id)=enemy_card {
            assert_eq!(s.decision,Decision::AbilityDiscard);assert_eq!(s.active,Seat::P2);assert_eq!(s.ability_result,1);assert!(!s.ability_succeeded);
            s=e.apply(&s,&e.card_action(&s,id)).unwrap();assert!(s.players[1].discard.contains(id));
        }else{assert_eq!(s.decision,Decision::Window);}
        assert_eq!(s.card(s.players[0].base).damage,u16::from(enemy_has_card));
    }
}

#[test]
fn omitted_conditional_else_cannot_inherit_a_preceding_draw_success() {
    let mut e=engine();let mut s=board(&e);let source=s.players[0].leader;let drawn=deck_card(&e,&mut s,Seat::P1);
    let program=death_program(&mut e,&s,source,json!({"trigger":"action","title":"Draw then condition","effect":{"kind":"draw","target":"ownPlayer","amount":{"kind":"const","value":1}},"then":{"title":"No discard","effect":{"kind":"conditional","condition":{"kind":"const","value":false},"onTrue":{"kind":"discardOwnHand","target":"enemyPlayer","amount":{"kind":"const","value":1}}},"ifYouDo":{"title":"Pay damage","effect":{"kind":"damage","target":"ownBase","amount":{"kind":"const","value":1}}}}}));
    s.source=source;e.begin_program(&mut s,program,0).unwrap();assert!(s.players[0].hand.contains(drawn));assert_eq!(s.card(s.players[0].base).damage,0);assert_eq!(s.decision,Decision::Window);
}
#[test]
fn group_generation_preserves_parent_distribution_amount_before_resetting_its_result() {
    let mut e=engine();let mut s=board(&e);let source=unit(&e,&mut s,Seat::P1,"LOF_254");s.card_mut(source).damage=2;let hp=e.hp(&s,source);
    let program=death_program(&mut e,&s,source,json!({"trigger":"action","title":"Heal and grow","effect":{"kind":"distributeHealing","amount":{"kind":"const","value":2},"maxTargets":1,"targetResolver":{"owner":"self","type":"unit","zone":"arena"}},"ifYouDo":{"title":"Grow","effect":{"kind":"phaseModifiers","effects":[{"kind":"modifyStats","target":"self","duration":"phase","power":{"kind":"const","value":0},"hp":{"kind":"ref","path":["event","totalDistributed"]}}]}}}));
    s.source=source;e.begin_program(&mut s,program,0).unwrap();assert_eq!(s.decision,Decision::AbilityDistribute);
    let action=e.legal_actions(&s).into_iter().find(|a|a.arg.as_ref().is_some_and(|v|v[0][1].as_u64()==Some(2))).unwrap();s=e.apply(&s,&action).unwrap();assert_eq!(s.card(source).damage,0);assert_eq!(e.hp(&s,source),hp+2);
}

#[test]
fn attack_power_survives_death_source_and_nested_context_restoration() {
    let e=engine();let mut s=board(&e);
    let attacker=unit(&e,&mut s,Seat::P1,"SOR_194");
    let dying=unit(&e,&mut s,Seat::P2,"LOF_256");
    s.source=dying;s.attack_source=attacker;s.trigger_context=0;
    let query:Expr=serde_json::from_value(json!({"kind":"query","name":"getPower","receiver":{"kind":"ref","path":["card"]}})).unwrap();
    let power:Expr=serde_json::from_value(json!({"kind":"ref","path":["card","power"]})).unwrap();
    for expr in [&query,&power] {assert_eq!(e.eval_with_card(&s,dying,0,attacker,expr).number(),4);}
    let parent=ResolutionContext::capture(&s);let hash=s.zobrist();
    s.attack_source=dying;assert_ne!(s.zobrist(),hash);
    parent.restore(&mut s);assert_eq!(s.attack_source,attacker);assert_eq!(s.zobrist(),hash);
    s.death_frames[0].context=parent;s.death_depth=1;s.attack_source=dying;
    assert_eq!(e.eval_with_card(&s,dying,0,attacker,&query).number(),4);
    let suspended_hash=s.zobrist();s.death_frames[0].context.attack_source=0;assert_ne!(s.zobrist(),suspended_hash);
    assert_eq!(e.eval_with_card(&s,dying,0,attacker,&query).number(),2);
    s.death_frames[0].context=parent;s.death_depth=0;s.attack_source=attacker;
    e.leave_play(&mut s,attacker).unwrap();
    assert_eq!(e.eval_with_card(&s,dying,0,attacker,&query).number(),2);
    e.cancel(&mut s);assert_eq!(s.attack_source,0);
}

#[test]
fn terminal_death_prompt_snapshot_keeps_live_attacking_raid_power() {
    let e=engine();let mut s=board(&e);let attacker=unit(&e,&mut s,Seat::P1,"SOR_194");
    s.attack_source=attacker;s.outcome=1;s.decision=Decision::AbilityTarget;
    let snapshot=e.snapshot(&s);assert_eq!(snapshot["players"]["p1"]["ground"][0]["power"],4);
    assert!(e.legal_actions(&s).is_empty());
    s.attack_source=0;assert_eq!(e.snapshot(&s)["players"]["p1"]["ground"][0]["power"],2);
}

#[test]
fn deck_discard_prepares_top_cards_then_successful_aggregate_without_fatigue() {
    let e=engine();
    for seat in [Seat::P1,Seat::P2] {for available in [0,1,3] {
        let mut s=board(&e);s.source=s.players[0].leader;
        let untouched=deck_card(&e,&mut s,seat.other());
        let cards=(0..available).map(|_|deck_card(&e,&mut s,seat)).collect::<Vec<_>>();
        let effect=Effect::DiscardDeck {target:Target::name(if seat==Seat::P1 {"ownPlayer"}else{"enemyPlayer"}),amount:Expr::number(2)};
        s.event_group.active=true;s.event_group.initiator=Seat::P1;
        e.generate_group(&mut s,&effect).unwrap();
        let count=available.min(2);
        assert_eq!(s.event_group.count as usize,count+1);
        assert_eq!(s.event_group.records[..count].iter().map(|r|r.target).collect::<Vec<_>>(),cards[..count]);
        assert_eq!(s.event_group.records[count].target,s.player(seat).base);
        assert_eq!(s.player(seat).deck.as_slice(),cards);
        e.resolve_group(&mut s,&effect).unwrap();
        assert_eq!(s.player(seat).discard.as_slice(),&cards[..count]);
        assert_eq!(s.player(seat).deck.as_slice(),&cards[count..]);
        assert!(s.player(seat.other()).deck.contains(untouched));
        assert_eq!(s.ability_result,count as u16);assert!(s.ability_succeeded);
        assert_eq!(s.player(seat).hand.len,0);assert_eq!(s.card(s.player(seat).base).damage,0);
    }}
}
#[test]
fn deck_discard_zero_and_raw_ir_bounds_are_strict() {
    let e=engine();let mut s=board(&e);s.source=s.players[0].leader;let card=deck_card(&e,&mut s,Seat::P2);
    let effect=Effect::DiscardDeck {target:Target::name("enemyPlayer"),amount:Expr::number(0)};
    s.event_group.active=true;e.generate_group(&mut s,&effect).unwrap();assert_eq!(s.event_group.count,0);
    e.resolve_group(&mut s,&effect).unwrap();assert!(!s.ability_succeeded);assert!(s.players[1].deck.contains(card));
    for effect in [json!({"kind":"discardDeck","target":"bothPlayers","amount":{"kind":"const","value":1}}),json!({"kind":"discardDeck","target":"enemyPlayer","amount":{"kind":"const","value":6}}),json!({"kind":"discardDeck","target":"enemyPlayer","amount":{"kind":"ref","path":["source","damage"]}})] {
        let a:crate::ability_ir::Ability=serde_json::from_value(json!({"trigger":"event","title":"bad mill","effect":effect})).unwrap();assert!(crate::ability_ir::Program::compile(&a).is_err());
    }
}
#[test]
fn mandalorian_creation_preserves_pinned_metadata_defaults_and_shielded_trigger() {
    let mut e=engine();let mut s=board(&e);let source=s.players[0].leader;let start=s.next_id;
    let token=&e.definitions[*e.by_code.get("TOKEN_MANDALORIAN").unwrap() as usize];
    assert_eq!(token.info.internal_name,"mandalorian");assert_eq!(token.info.power,Some(2));assert_eq!(token.info.hp,Some(2));
    assert_eq!(token.info.arena.as_deref(),Some("ground"));assert_eq!(token.info.aspects(),vec!["vigilance"]);assert_eq!(token.flags&SHIELDED,SHIELDED);
    let p=death_program(&mut e,&s,source,json!({"trigger":"action","title":"Create Mandalorian","effect":{"kind":"createTokenUnit","tokenType":"mandalorian","amount":{"kind":"const","value":1},"target":"ownPlayer"}}));
    s.source=source;e.begin_program(&mut s,p,0).unwrap();
    assert_eq!(s.players[0].ground.as_slice(),&[start]);assert_eq!(s.players[1].ground.len,0);
    assert!(s.card(start).exhausted);assert_eq!(s.card(start).owner,Seat::P1);assert_ne!(s.card(start).shield,0);
    assert_eq!(e.power(&s,start,false),2);assert_eq!(e.hp(&s,start),2);
    let snapshot=e.snapshot(&s);assert_eq!(e.snapshot(&e.load_state(&snapshot).unwrap()),snapshot);
}

#[test]
fn deck_discard_rejects_unmodeled_event_payload_continuations() {
    let ability:crate::ability_ir::Ability=serde_json::from_value(json!({"trigger":"action","title":"Mill","effect":{"kind":"discardDeck","target":"enemyPlayer","amount":{"kind":"const","value":2}},"then":{"title":"Capture","effect":{"kind":"damage","target":"enemyBase","amount":{"kind":"ref","path":["event","totalDistributed"]}}}})).unwrap();
    assert!(crate::ability_ir::Program::compile(&ability).unwrap_err().contains("payload captures"));
}

fn upgrade_resources(e:&Engine,s:&mut State,seat:Seat) {
    for _ in 0..12 {let id=add(e,s,seat,"LOF_254");s.player_mut(seat).resources.push(id).unwrap();}
}
fn play_upgrade(e:&Engine,s:&State,upgrade:CardId,parent:CardId)->State {
    let choice=e.apply(s,&e.card_action(s,upgrade)).unwrap();assert_eq!(choice.decision,Decision::UpgradeTarget);
    e.apply(&choice,&e.card_action(&choice,parent)).unwrap()
}
#[test]
fn ordinary_upgrades_choose_before_paying_and_keep_enemy_host_controller() {
    let e=engine();let mut s=board(&e);upgrade_resources(&e,&mut s,Seat::P1);
    let own=unit(&e,&mut s,Seat::P1,"LOF_254");let enemy=unit(&e,&mut s,Seat::P2,"LOF_254");let upgrade=hand(&e,&mut s,"SOR_057");
    let before=e.ready_resources(&s,Seat::P1);let choice=e.apply(&s,&e.card_action(&s,upgrade)).unwrap();
    assert!(e.legal_actions(&choice).contains(&e.card_action(&choice,own)));assert!(e.legal_actions(&choice).contains(&e.card_action(&choice,enemy)));
    assert_eq!(e.ready_resources(&choice,Seat::P1),before);
    let cancelled=e.apply(&choice,&Action::button("Cancel","cancel")).unwrap();assert!(cancelled.players[0].hand.contains(upgrade));assert_eq!(e.ready_resources(&cancelled,Seat::P1),before);
    let old_hp=e.hp(&s,enemy);let old_power=e.power(&s,enemy,false);
    s=e.apply(&choice,&e.card_action(&choice,enemy)).unwrap();assert_eq!(s.card(upgrade).owner,Seat::P1);assert_eq!(s.card(upgrade).parent,enemy);
    assert_eq!(e.hp(&s,enemy),old_hp+1);assert_eq!(e.power(&s,enemy,false),old_power+1);assert!(e.has_keyword(&s,enemy,"sentinel"));assert!(!e.has_keyword(&s,own,"sentinel"));
    assert!(!s.players[0].ground.contains(upgrade));assert!(!s.players[1].ground.contains(upgrade));
    let snapshot=e.snapshot(&s);assert_eq!(snapshot["players"]["p2"]["ground"][0]["upgrades"][0]["controller"],"p1");
    assert_eq!(e.snapshot(&e.load_state(&snapshot).unwrap()),snapshot);
    e.defeat(&mut s,upgrade).unwrap();e.sweep_stat_defeats(&mut s).unwrap();assert_eq!(e.hp(&s,enemy),old_hp);assert!(!e.has_keyword(&s,enemy,"sentinel"));assert!(s.players[0].discard.contains(upgrade));
}
#[test]
fn attachment_predicates_and_live_keyword_loss_use_distinct_source_and_parent() {
    let e=engine();let mut s=board(&e);upgrade_resources(&e,&mut s,Seat::P1);let parent=unit(&e,&mut s,Seat::P2,"LOF_256");let upgrade=hand(&e,&mut s,"ASH_181");
    assert!(!e.legal_actions(&s).contains(&e.card_action(&s,upgrade)));s.card_mut(parent).damage=1;
    assert!(e.legal_actions(&s).contains(&e.card_action(&s,upgrade)));s=play_upgrade(&e,&s,upgrade,parent);assert!(e.has_keyword(&s,parent,"overwhelm"));
    // Conditional grants use the parent trait, not upgrade trait or controller.
    let conditional=add(&e,&mut s,Seat::P1,"LOF_238");e.attach(&mut s,conditional,parent);assert!(!e.has_keyword(&s,parent,"grit"));
    let mut e=e;let def=s.card(parent).def as usize;e.definitions[def].traits.push("sith".into());assert!(e.has_keyword(&s,parent,"grit"));
    e.definitions[def].traits.retain(|t|t!="sith");assert!(!e.has_keyword(&s,parent,"grit"));e.defeat(&mut s,conditional).unwrap();assert!(!e.has_keyword(&s,parent,"grit"));
}
#[test]
fn ordered_mixed_attachment_cleanup_and_links_survive_import_and_shield_consumption() {
    let e=engine();let mut s=board(&e);let parent=unit(&e,&mut s,Seat::P2,"LOF_254");
    let a=add(&e,&mut s,Seat::P1,"SOR_057");let b=add(&e,&mut s,Seat::P2,"HMW_096");
    e.attach(&mut s,b,parent);e.create_token(&mut s,parent,false).unwrap();let shield=s.card(parent).shield;e.attach(&mut s,a,parent);e.create_token(&mut s,parent,true).unwrap();let xp=s.card(parent).experience;
    assert_eq!(e.upgrades(&s,parent),vec![b,shield,a,xp]);e.validate_attachment_links(&s).unwrap();
    let snap=e.snapshot(&s);let imported=e.load_state(&snap).unwrap();assert_eq!(e.upgrades(&imported,parent),vec![b,shield,a,xp]);assert_eq!(imported.zobrist(),s.zobrist());
    e.damage(&mut s,parent,1);assert_eq!(e.upgrades(&s,parent),vec![b,a,xp]);assert_eq!(s.card(shield).parent,0);e.validate_attachment_links(&s).unwrap();
    e.defeat(&mut s,parent).unwrap();assert_eq!(s.players[0].discard.as_slice(),&[a]);assert_eq!(s.players[1].discard.as_slice(),&[b,parent]);assert!(!s.players[1].discard.contains(xp));
    for id in [a,b,xp] {assert_eq!(s.card(id).parent,0);}e.validate_attachment_links(&s).unwrap();
}
#[test]
fn unique_upgrade_same_parent_replaces_oldest_different_parent_requires_choice() {
    let e=engine();let mut s=board(&e);upgrade_resources(&e,&mut s,Seat::P1);let parent=unit(&e,&mut s,Seat::P1,"LOF_254");
    let old=add(&e,&mut s,Seat::P1,"LOF_238");e.attach(&mut s,old,parent);let incoming=hand(&e,&mut s,"LOF_238");
    s=play_upgrade(&e,&s,incoming,parent);assert_ne!(s.decision,Decision::Unique);assert!(s.players[0].discard.contains(old));assert_eq!(e.upgrades(&s,parent),vec![incoming]);
    let mut s=board(&e);upgrade_resources(&e,&mut s,Seat::P1);let p1=unit(&e,&mut s,Seat::P1,"LOF_254");let p2=unit(&e,&mut s,Seat::P2,"LOF_254");let old=add(&e,&mut s,Seat::P1,"LOF_238");e.attach(&mut s,old,p1);let incoming=hand(&e,&mut s,"LOF_238");
    let initial_hp=e.hp(&s,p2);s=play_upgrade(&e,&s,incoming,p2);assert_eq!(s.decision,Decision::Unique);assert_eq!(e.hp(&s,p2),initial_hp+2);
    let legal=e.legal_actions(&s);assert_eq!(legal,vec![e.card_action(&s,old),e.card_action(&s,incoming)]);
    for removed in [old,incoming] {let t=e.apply(&s,&e.card_action(&s,removed)).unwrap();assert!(t.players[0].discard.contains(removed));assert_eq!(t.card(removed).parent,0);}
}
#[test]
fn upgrade_loss_sweeps_lethal_host_and_negative_upgrade_kills_before_onplay() {
    let e=engine();let mut s=board(&e);let parent=unit(&e,&mut s,Seat::P2,"LOF_254");let upgrade=add(&e,&mut s,Seat::P1,"SOR_057");e.attach(&mut s,upgrade,parent);s.card_mut(parent).damage=e.hp(&s,parent)-1;
    e.defeat(&mut s,upgrade).unwrap();e.sweep_stat_defeats(&mut s).unwrap();assert!(s.players[1].discard.contains(parent));assert!(s.players[0].discard.contains(upgrade));
    let mut s=board(&e);upgrade_resources(&e,&mut s,Seat::P1);let parent=unit(&e,&mut s,Seat::P2,"LOF_254");s.card_mut(parent).damage=e.hp(&s,parent)-1;let kill=hand(&e,&mut s,"LAW_127");let draw=deck_card(&e,&mut s,Seat::P1);
    s=play_upgrade(&e,&s,kill,parent);assert!(s.players[1].discard.contains(parent));assert!(s.players[0].discard.contains(kill));assert!(s.players[0].deck.contains(draw));
}
#[test]
fn ordinary_upgrade_import_rejects_foreign_control_and_duplicate_attachment_identity() {
    let e=engine();let mut s=board(&e);let parent=unit(&e,&mut s,Seat::P2,"LOF_254");let upgrade=add(&e,&mut s,Seat::P1,"SOR_057");e.attach(&mut s,upgrade,parent);
    let mut snap=e.snapshot(&s);snap["players"]["p2"]["ground"][0]["upgrades"][0]["owner"]=json!("p2");assert!(e.load_state(&snap).unwrap_err().contains("foreign-controlled"));
    let mut snap=e.snapshot(&s);let duplicate=snap["players"]["p2"]["ground"][0]["upgrades"][0].clone();snap["players"]["p2"]["ground"][0]["upgrades"].as_array_mut().unwrap().push(duplicate);assert!(e.load_state(&snap).is_err());
    s.card_mut(upgrade).next_upgrade=upgrade;assert!(e.validate_attachment_links(&s).unwrap_err().contains("cyclic"));
}
#[test]
fn attached_restore_stacks_for_enemy_host_and_heals_host_controller_base() {
    let e=engine();let mut s=board(&e);let parent=unit(&e,&mut s,Seat::P2,"LOF_256");
    let a=add(&e,&mut s,Seat::P1,"HMW_096");let b=add(&e,&mut s,Seat::P2,"HMW_096");e.attach(&mut s,a,parent);e.attach(&mut s,b,parent);
    assert_eq!(e.keyword_amount(&s,parent,"restore"),4);s.source=parent;s.active=Seat::P2;s.attack_restore=4;s.pending_triggers=T_RESTORE;
    let base=s.players[1].base;s.card_mut(base).damage=9;e.resolve_trigger(&mut s,T_RESTORE).unwrap();assert_eq!(s.card(base).damage,5);assert_eq!(s.card(s.players[0].base).damage,0);
    e.defeat(&mut s,a).unwrap();assert_eq!(e.keyword_amount(&s,parent,"restore"),2);
}
#[test]
fn upgrade_parent_types_include_space_tokens_and_deployed_leaders_without_unit_count_changes() {
    let e=engine();let mut s=board(&e);let ground=unit(&e,&mut s,Seat::P1,"LOF_256");
    let space_code=e.definitions.iter().find(|d|d.info.is("unit")&&!d.info.is("token")&&d.info.arena.as_deref()==Some("space")).unwrap().code.clone();let space=unit(&e,&mut s,Seat::P2,&space_code);
    let token=unit(&e,&mut s,Seat::P1,"TOKEN_MANDALORIAN");let leader=s.players[1].leader;s.card_mut(leader).deployed=true;s.card_mut(leader).epic_used=true;e.add_arena(&mut s,leader).unwrap();
    let upgrade=add(&e,&mut s,Seat::P1,"SOR_057");let targets=e.upgrade_targets(&s,upgrade);for id in [ground,space,token,leader] {assert!(targets.contains(&id));}
    let before=s.players.iter().map(|p|p.ground.len as u16+p.space.len as u16).sum::<u16>();e.attach(&mut s,upgrade,space);assert_eq!(s.players.iter().map(|p|p.ground.len as u16+p.space.len as u16).sum::<u16>(),before);
    assert!(!e.attack_targets(&s,ground,false).contains(&upgrade));assert!(!e.upgrade_targets(&s,upgrade).contains(&upgrade));
}
#[test]
fn scalar_upgrade_defeat_includes_tokens_and_sweeps_after_printed_hp_loss() {
    let e=engine();let mut s=board(&e);let parent=unit(&e,&mut s,Seat::P2,"LOF_256");let source=s.players[0].leader;
    let upgrade=add(&e,&mut s,Seat::P1,"SOR_057");e.attach(&mut s,upgrade,parent);e.create_token(&mut s,parent,false).unwrap();let shield=s.card(parent).shield;
    let resolver:TargetResolver=serde_json::from_value(json!({"owner":"any","type":"upgrade","zone":"arena"})).unwrap();let candidates=e.matching_targets(&s,source,&resolver);assert_eq!(candidates,vec![upgrade,shield]);
    s.source=source;s.ability_target=shield;e.apply_effect(&mut s,&Effect::Defeat {target:Target::name("chosen")}).unwrap();assert_eq!(s.card(parent).shield,0);assert_eq!(s.card(shield).parent,0);e.validate_attachment_links(&s).unwrap();
    s.card_mut(parent).damage=e.hp(&s,parent)-1;s.ability_target=upgrade;e.apply_effect(&mut s,&Effect::Defeat {target:Target::name("chosen")}).unwrap();e.sweep_stat_defeats(&mut s).unwrap();assert!(s.players[1].discard.contains(parent));
}

#[test]
fn grouped_upgrade_selection_is_rejected_while_scalar_upgrade_defeat_remains_supported() {
    let select=json!({"kind":"select","targetResolver":{"type":"upgrade","owner":"any","zone":"arena"},"effect":{"kind":"defeat","target":"chosen"}});
    let grouped:crate::ability_ir::Ability=serde_json::from_value(json!({"trigger":"event","title":"Unsupported group","effect":{"kind":"simultaneous","effects":[select.clone()]}})).unwrap();
    assert!(crate::ability_ir::Program::compile(&grouped).unwrap_err().contains("grouped upgrade selection"));
    let scalar:crate::ability_ir::Ability=serde_json::from_value(json!({"trigger":"event","title":"Scalar defeat","effect":select})).unwrap();
    assert!(crate::ability_ir::Program::compile(&scalar).is_ok());
}
#[test]
fn grouped_upgrade_source_defeat_is_rejected_for_name_reference_and_conditional_targets() {
    for target in [json!("self"),json!({"kind":"ref","path":["source"]}),json!({"kind":"conditional","condition":{"kind":"const","value":true},"then":{"kind":"ref","path":["source"]},"else":{"kind":"ref","path":["target"]}})] {
        let mut catalogue:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();
        let entry=catalogue["cards"].as_array_mut().unwrap().iter_mut().find(|entry|entry["setCode"]=="SOR_057").unwrap();
        entry["abilities"]=json!({"leader":[],"unit":[],"card":[{"trigger":"whenPlayed","title":"Unsupported attachment defeat","effect":{"kind":"simultaneous","effects":[{"kind":"defeat","target":target}]}}]});
        let engine=Engine::from_catalogue_value(&catalogue).unwrap();assert!(!engine.by_code.contains_key("SOR_057"));
        assert!(engine.rejected_cards().unwrap()["SOR_057"].contains("grouped upgrade source defeat"));
    }
}

#[test]
fn upgrade_selectors_reject_unmodeled_arena_filters_and_nonplay_zones() {
    for resolver in [json!({"type":"upgrade","owner":"any","zone":"arena","arena":"ground"}),json!({"type":"upgrade","owner":"any","zone":"arena","arena":"space"}),json!({"type":"upgrade","owner":"any","zone":"discard"}),json!({"type":"upgrade","owner":"any","zone":"base"})] {
        let ability:crate::ability_ir::Ability=serde_json::from_value(json!({"trigger":"event","title":"Unmodeled attachment zone","targetResolver":resolver,"effect":{"kind":"defeat","target":"chosen"}})).unwrap();
        assert!(crate::ability_ir::Program::compile(&ability).unwrap_err().contains("without an arena filter"));
    }
}

#[test]
fn pinned_cleanup_reverse_insertion_precedes_all_parent_defeat_handlers() {
    let e=engine();let mut s=board(&e);let p1=unit(&e,&mut s,Seat::P1,"LOF_256");let p2=unit(&e,&mut s,Seat::P1,"LOF_256");
    let a=add(&e,&mut s,Seat::P1,"SOR_057");let b=add(&e,&mut s,Seat::P1,"HMW_096");let c=add(&e,&mut s,Seat::P1,"SOR_166");
    e.attach(&mut s,a,p1);e.create_token(&mut s,p1,false).unwrap();e.attach(&mut s,b,p1);e.attach(&mut s,c,p2);
    e.defeat_many(&mut s,&[p1,p2]).unwrap();assert_eq!(s.players[0].discard.as_slice(),&[c,b,a,p1,p2]);e.validate_attachment_links(&s).unwrap();
}

#[test]
fn grouped_explicit_parent_defeats_share_global_cleanup_before_primary_handlers() {
    let e=engine();let mut s=board(&e);let p1=unit(&e,&mut s,Seat::P1,"LOF_256");let p2=unit(&e,&mut s,Seat::P1,"LOF_256");
    let a=add(&e,&mut s,Seat::P1,"SOR_057");let b=add(&e,&mut s,Seat::P1,"HMW_096");let c=add(&e,&mut s,Seat::P1,"SOR_166");
    e.attach(&mut s,a,p1);e.create_token(&mut s,p1,false).unwrap();e.attach(&mut s,b,p1);e.attach(&mut s,c,p2);
    s.source=p1;s.ability_target=p2;s.event_group.active=true;s.event_group.context=Selection::one(p2);s.event_group.initiator=Seat::P1;
    let group=Effect::Simultaneous {effects:vec![Effect::Defeat {target:Target::name("self")},Effect::Defeat {target:Target::name("chosen")}]};
    e.generate_group(&mut s,&group).unwrap();e.resolve_group(&mut s,&group).unwrap();assert_eq!(s.players[0].discard.as_slice(),&[c,b,a,p1,p2]);assert_eq!(s.ability_result,2);assert!(s.ability_succeeded);e.validate_attachment_links(&s).unwrap();
}

#[test]
fn mutual_combat_deaths_capture_defender_then_attacker_before_reverse_attachment_cleanup() {
    let e=engine();let mut s=board(&e);let attacker=unit(&e,&mut s,Seat::P1,"LOF_256");let defender=unit(&e,&mut s,Seat::P2,"LOF_256");
    let attacker_upgrade=add(&e,&mut s,Seat::P1,"SOR_057");let defender_upgrade=add(&e,&mut s,Seat::P1,"SOR_057");e.attach(&mut s,attacker_upgrade,attacker);e.attach(&mut s,defender_upgrade,defender);
    s.card_mut(attacker).damage=e.hp(&s,attacker)-1;s.card_mut(defender).damage=e.hp(&s,defender)-1;
    s.source=attacker;s.target=defender;s.active=Seat::P1;s.trigger_context=2;s.attack_source=attacker;
    e.combat(&mut s).unwrap();assert_eq!(s.players[0].discard.as_slice(),&[attacker_upgrade,defender_upgrade,attacker]);assert_eq!(s.players[1].discard.as_slice(),&[defender]);e.validate_attachment_links(&s).unwrap();
}

#[test]
fn upgrade_stat_expressions_read_signed_printed_values_without_unit_clamping() {
    let e=engine();let mut s=board(&e);let parent=unit(&e,&mut s,Seat::P2,"LOF_256");let power_upgrade=add(&e,&mut s,Seat::P1,"ASH_198");let hp_upgrade=add(&e,&mut s,Seat::P1,"LAW_127");e.attach(&mut s,power_upgrade,parent);e.attach(&mut s,hp_upgrade,parent);
    for (id,field,query,expected) in [(power_upgrade,"power","getPower",-2),(hp_upgrade,"hp","getHp",-1)] {
        for root in ["source","target","card"] {
            let expr=Expr::Ref {path:vec![root.into(),field.into()]};assert_eq!(e.eval(&s,id,id,&expr).number(),expected);
            let expr:Expr=serde_json::from_value(json!({"kind":"query","name":query,"receiver":{"kind":"ref","path":[root]},"args":[]})).unwrap();assert_eq!(e.eval(&s,id,id,&expr).number(),expected);
        }
        let resolver:TargetResolver=serde_json::from_value(json!({"owner":"any","type":"upgrade","zone":"arena","predicate":{"kind":"binary","op":"<","left":{"kind":"query","name":query,"receiver":{"kind":"ref","path":["card"]},"args":[]},"right":{"kind":"const","value":0}}})).unwrap();
        resolver.validate().unwrap();assert!(e.matching_targets(&s,s.players[0].leader,&resolver).contains(&id));
    }
}

#[test]
fn global_arena_order_controls_cross_controller_framework_deaths_and_attachment_cleanup() {
    let e=engine();for grouped in [false,true] {
        let mut s=board(&e);let early=unit(&e,&mut s,Seat::P2,"LOF_256");let late=unit(&e,&mut s,Seat::P1,"LOF_256");
        let early_upgrade=add(&e,&mut s,Seat::P1,"SOR_057");let late_upgrade=add(&e,&mut s,Seat::P1,"HMW_096");e.attach(&mut s,early_upgrade,early);e.attach(&mut s,late_upgrade,late);
        assert_eq!(e.arena_units(&s),vec![early,late]);s.card_mut(early).damage=e.hp(&s,early);s.card_mut(late).damage=e.hp(&s,late);
        if grouped {s.source=late;s.event_group.active=true;s.event_group.initiator=Seat::P1;let group=Effect::Simultaneous {effects:vec![Effect::NoAction]};e.generate_group(&mut s,&group).unwrap();e.resolve_group(&mut s,&group).unwrap();}else{e.sweep_stat_defeats(&mut s).unwrap();}
        assert_eq!(s.players[0].discard.as_slice(),&[late_upgrade,early_upgrade,late]);assert_eq!(s.players[1].discard.as_slice(),&[early]);assert!(e.arena_units(&s).is_empty());
    }
}
#[test]
fn arena_order_import_rejects_missing_future_upgrade_and_malformed_memberships() {
    let e=engine();let mut s=board(&e);let a=unit(&e,&mut s,Seat::P1,"LOF_256");let b=unit(&e,&mut s,Seat::P1,"LOF_256");let c=unit(&e,&mut s,Seat::P2,"LOF_256");
    let snapshot=e.snapshot(&s);assert_eq!(e.snapshot(&e.load_state(&snapshot).unwrap()),snapshot);
    for order in [json!({"ground":[format!("c{}",a-1),format!("c{}",b-1)],"space":[]}),json!({"ground":[format!("c{}",a-1),format!("c{}",b-1),format!("c{}",b-1)],"space":[]}),json!({"ground":[format!("c{}",a-1),format!("c{}",b-1)],"space":[format!("c{}",c-1)]}),json!({"ground":[format!("c{}",b-1),format!("c{}",a-1),format!("c{}",c-1)],"space":[]}),json!({"ground":[format!("c{}",a-1),format!("c{}",b-1),"c999"],"space":[]})] {
        let mut bad=snapshot.clone();bad["arenaUnitOrder"]=order;assert!(e.load_state(&bad).is_err());
    }
    for zone in ["hand","deck","resources","discard"] {
        let mut state=s;let future=add(&e,&mut state,Seat::P1,"SOR_057");match zone {"hand"=>state.players[0].hand.push(future),"deck"=>state.players[0].deck.push(future),"resources"=>state.players[0].resources.push(future),_=>state.players[0].discard.push(future)}.unwrap();
        let mut bad=e.snapshot(&state);bad.as_object_mut().unwrap().remove("arenaUnitOrder");assert!(e.load_state(&bad).unwrap_err().contains("require explicit arenaUnitOrder"));
    }
}
#[test]
fn global_arena_order_hash_and_snapshot_preserve_interleaving_departure_reentry_and_legacy_flag() {
    let e=engine();let mut s=board(&e);let early=unit(&e,&mut s,Seat::P2,"LOF_256");let late=unit(&e,&mut s,Seat::P1,"LOF_256");
    let snapshot=e.snapshot(&s);let hash=s.zobrist();let mut reverse=s;reverse.arena_unit_order[0].ids.swap(0,1);assert_ne!(reverse.zobrist(),hash);let reverse_snapshot=e.snapshot(&reverse);assert_eq!(e.load_state(&reverse_snapshot).unwrap().zobrist(),reverse.zobrist());
    e.leave_play(&mut s,early).unwrap();s.players[1].discard.remove(early);e.add_arena(&mut s,early).unwrap();assert_eq!(e.arena_units(&s),vec![late,early]);assert_ne!(s.zobrist(),hash);
    let token=unit(&e,&mut s,Seat::P2,"TOKEN_MANDALORIAN");let leader=s.players[0].leader;s.card_mut(leader).deployed=true;s.card_mut(leader).epic_used=true;e.add_arena(&mut s,leader).unwrap();assert_eq!(e.arena_units(&s),vec![late,early,token,leader]);
    let mut legacy=snapshot;legacy.as_object_mut().unwrap().remove("arenaUnitOrder");let legacy_state=e.load_state(&legacy).unwrap();assert!(!legacy_state.arena_order_exact);assert_eq!(e.snapshot(&legacy_state),legacy);assert_ne!(legacy_state.zobrist(),hash);
}
#[test]
fn repeated_defeat_records_prepare_repeated_cleanup_before_deduplicated_handlers() {
    let e=engine();let mut s=board(&e);let a=unit(&e,&mut s,Seat::P1,"LOF_256");let b=unit(&e,&mut s,Seat::P1,"LOF_256");let ua=add(&e,&mut s,Seat::P1,"SOR_057");let ub=add(&e,&mut s,Seat::P1,"HMW_096");e.attach(&mut s,ua,a);e.attach(&mut s,ub,b);
    let raw=json!({"kind":"simultaneous","effects":[{"kind":"defeat","target":"self"},{"kind":"defeat","target":"chosen"},{"kind":"defeat","target":"self"}]});let ability:crate::ability_ir::Ability=serde_json::from_value(json!({"trigger":"whenPlayed","title":"Repeated defeat","effect":raw})).unwrap();crate::ability_ir::Program::compile(&ability).unwrap();
    s.source=a;s.ability_target=b;s.event_group.active=true;s.event_group.context=Selection::one(b);s.event_group.initiator=Seat::P1;e.generate_group(&mut s,&ability.effect).unwrap();e.resolve_group(&mut s,&ability.effect).unwrap();assert_eq!(s.players[0].discard.as_slice(),&[ua,ub,a,b]);assert_eq!(s.ability_result,2);e.validate_attachment_links(&s).unwrap();
}

#[test]
fn shield_only_combat_stat_deaths_follow_global_framework_order_without_damage_callbacks() {
    let mut e=engine();let mut s=board(&e);let attacker=unit(&e,&mut s,Seat::P1,"SHD_056");let defender=unit(&e,&mut s,Seat::P2,"SHD_056");
    death_program(&mut e,&s,attacker,draw_death(true));e.create_token(&mut s,attacker,false).unwrap();e.create_token(&mut s,defender,false).unwrap();assert_eq!(e.hp(&s,attacker),4);assert_eq!(e.hp(&s,defender),4);
    s.card_mut(attacker).damage=3;s.card_mut(defender).damage=3;s.source=attacker;s.target=defender;s.active=Seat::P1;s.trigger_context=3;s.attack_source=attacker;
    e.combat(&mut s).unwrap();assert_eq!(s.players[0].discard.as_slice(),&[attacker]);assert_eq!(s.players[1].discard.as_slice(),&[defender]);assert_eq!(s.death_window.entries[..s.death_window.len as usize].iter().map(|event|event.source).collect::<Vec<_>>(),vec![attacker,defender]);
}
#[test]
fn grouped_shield_replacement_stat_deaths_ignore_damage_record_order() {
    let mut e=engine();let mut s=board(&e);let first=unit(&e,&mut s,Seat::P1,"SHD_056");let second=unit(&e,&mut s,Seat::P2,"SHD_056");death_program(&mut e,&s,first,draw_death(true));
    e.create_token(&mut s,first,false).unwrap();e.create_token(&mut s,second,false).unwrap();s.card_mut(first).damage=3;s.card_mut(second).damage=3;
    s.source=first;s.ability_target=second;s.event_group.active=true;s.event_group.context=Selection::one(second);s.event_group.initiator=Seat::P1;
    let group=Effect::Simultaneous {effects:vec![Effect::Damage {target:Target::name("chosen"),amount:Expr::number(1)},Effect::Damage {target:Target::name("self"),amount:Expr::number(1)}]};e.generate_group(&mut s,&group).unwrap();s.event_group.shield_priority=1;assert!(e.resolve_group(&mut s,&group).unwrap());
    assert_eq!(s.ability_result,0);assert_eq!(s.death_pending.entries[..s.death_pending.len as usize].iter().map(|event|event.source).collect::<Vec<_>>(),vec![first,second]);
}
#[test]
fn live_resource_pairs_damage_and_hp_recompute_without_readiness_aliases() {
    let e=engine();let mut s=board(&e);let rebel=unit(&e,&mut s,Seat::P2,"HMW_133");let frigate=unit(&e,&mut s,Seat::P1,"JTL_052");let paz=unit(&e,&mut s,Seat::P1,"LOF_153");
    let base=e.def(&s,rebel).info.power.unwrap() as u16;
    for count in 0..=5 {if count>0 {let id=add(&e,&mut s,Seat::P2,"LOF_256");s.players[1].resources.push(id).unwrap();s.card_mut(id).exhausted=true;}assert_eq!(e.power(&s,rebel,false),base+count/2);}
    let power=e.power(&s,paz,false);s.card_mut(paz).damage=2;assert_eq!(e.power(&s,paz,false),power+4);s.card_mut(paz).damage=1;assert_eq!(e.power(&s,paz,false),power+2);
    let printed=e.power(&s,frigate,false);s.card_mut(frigate).damage=1;assert_eq!(e.power(&s,frigate,false),printed.saturating_sub(1));s.card_mut(frigate).damage=65535;assert_eq!(e.power(&s,frigate,false),0);
    let mut s=board(&e);let legion=add(&e,&mut s,Seat::P2,"SOR_118");for _ in 0..6 {let id=add(&e,&mut s,Seat::P2,"LOF_256");s.players[1].resources.push(id).unwrap();}e.add_arena(&mut s,legion).unwrap();s.card_mut(legion).damage=5;assert_eq!(e.hp(&s,legion),6);
    let resource=s.players[1].resources.ids[0];s.players[1].resources.remove(resource);s.players[1].hand.push(resource).unwrap();e.sweep_stat_defeats(&mut s).unwrap();assert!(s.players[1].discard.contains(legion));
}
#[test]
fn live_modifier_binding_distinguishes_registration_affected_candidate_and_controller() {
    let mut e=engine();let mut s=board(&e);let source=unit(&e,&mut s,Seat::P1,"LOF_256");let affected=unit(&e,&mut s,Seat::P2,"LOF_256");let other=unit(&e,&mut s,Seat::P2,"LOF_256");
    for _ in 0..5 {let id=add(&e,&mut s,Seat::P2,"LOF_256");s.players[1].resources.push(id).unwrap();}let resource=add(&e,&mut s,Seat::P1,"LOF_256");s.players[0].resources.push(resource).unwrap();
    let count=json!({"kind":"query","name":"arenaUnitCount","receiver":{"kind":"ref","path":["modifierTarget","controller"]},"args":[{"kind":"binary","op":"!==","left":{"kind":"ref","path":["card"]},"right":{"kind":"ref","path":["modifierTarget"]}}]});
    death_program(&mut e,&s,source,json!({"trigger":"constant","title":"Live aura","targetResolver":{"owner":"opponent","type":"unit","zone":"arena"},"effect":{"kind":"modifyStats","target":"chosen","duration":"persistent","power":{"kind":"binary","op":"+","left":count,"right":{"kind":"query","name":"resourcePairs","receiver":{"kind":"ref","path":["modifierTarget","controller"]},"args":[]}},"hp":{"kind":"const","value":0}}}));
    assert_eq!(e.constant_stats(&s,affected).0,3);assert_eq!(e.constant_stats(&s,other).0,3);assert_eq!(e.constant_stats(&s,source).0,0);
    e.leave_play(&mut s,other).unwrap();assert_eq!(e.constant_stats(&s,affected).0,2);
}
#[test]
fn persistent_stat_raw_ir_rejects_cycles_fractional_math_and_unavailable_binders() {
    for expr in [json!({"kind":"ref","path":["modifierTarget","power"]}),json!({"kind":"ref","path":["target","damage"]}),json!({"kind":"query","name":"getHp","receiver":{"kind":"ref","path":["source"]},"args":[]}),json!({"kind":"binary","op":"/","left":{"kind":"ref","path":["modifierTarget","damage"]},"right":{"kind":"const","value":2}}),json!({"kind":"query","name":"arenaUnitCount","receiver":{"kind":"ref","path":["player"]},"args":[{"kind":"query","name":"hasSomeKeyword","receiver":{"kind":"ref","path":["card"]},"args":[{"kind":"const","value":"sentinel"}]}]}),json!({"kind":"binary","op":"*","left":{"kind":"ref","path":["modifierTarget","damage"]},"right":{"kind":"const","value":1000}})] {
        let a:crate::ability_ir::Ability=serde_json::from_value(json!({"trigger":"constant","title":"Bad live stat","effect":{"kind":"modifyStats","target":"self","duration":"persistent","power":expr,"hp":{"kind":"const","value":0}}})).unwrap();assert!(crate::ability_ir::Program::compile(&a).is_err());
    }
    for effect in [json!({"kind":"damage","target":"chosen","amount":{"kind":"ref","path":["modifierTarget","damage"]}}),json!({"kind":"modifyStats","target":"self","duration":"phase","power":{"kind":"ref","path":["modifierTarget","damage"]},"hp":{"kind":"const","value":0}})] {
        let a:crate::ability_ir::Ability=serde_json::from_value(json!({"trigger":"action","title":"Unavailable binder","effect":effect})).unwrap();assert!(crate::ability_ir::Program::compile(&a).unwrap_err().contains("only exists"));
    }
}
#[test]
fn live_aggregate_overflow_rejects_transactional_apply_and_import_without_clipping() {
    let mut e=engine();let mut s=board(&e);let a=unit(&e,&mut s,Seat::P1,"LOF_256");let b=unit(&e,&mut s,Seat::P1,"ASH_029");let victim=unit(&e,&mut s,Seat::P2,"LOF_256");s.card_mut(victim).phase_hp=50000;s.card_mut(victim).damage=40000;
    for source in [a,b] {death_program(&mut e,&s,source,json!({"trigger":"constant","title":"Large live aura","targetResolver":{"owner":"opponent","type":"unit","zone":"arena"},"effect":{"kind":"modifyStats","target":"chosen","duration":"persistent","power":{"kind":"ref","path":["modifierTarget","damage"]},"hp":{"kind":"const","value":0}}}));}
    assert!(e.evaluated_power(&s,victim)>65535);assert!(e.check_stat_capacity(&s).unwrap_err().contains("capacity"));let before=s.zobrist();assert!(e.apply(&s,&Action::button("Pass","pass")).unwrap_err().contains("capacity"));assert_eq!(s.zobrist(),before);
    let mut clean=s;clean.card_mut(victim).damage=0;let mut snapshot=e.snapshot(&clean);snapshot["players"]["p2"]["ground"][0]["damage"]=json!(40000);assert!(e.load_state(&snapshot).unwrap_err().contains("capacity"));
}
#[test]
fn attack_queries_use_stable_participants_through_nested_context_and_cleanup() {
    let e=engine();let mut s=board(&e);let attacker=unit(&e,&mut s,Seat::P1,"TWI_205");let defender=unit(&e,&mut s,Seat::P2,"ASH_073");let other=unit(&e,&mut s,Seat::P2,"LOF_256");
    let attacking:Expr=serde_json::from_value(json!({"kind":"query","name":"isAttacking","receiver":{"kind":"ref","path":["card"]},"args":[]})).unwrap();let defending:Expr=serde_json::from_value(json!({"kind":"query","name":"isDefending","receiver":{"kind":"ref","path":["card"]},"args":[]})).unwrap();
    assert!(!e.eval_with_card(&s,other,defender,defender,&defending).truth());s.attack_source=attacker;s.attack_defender=defender;let power=e.def(&s,defender).info.power.unwrap() as u16;assert_eq!(e.power(&s,defender,false),power+2);
    assert!(e.eval_with_card(&s,other,other,attacker,&attacking).truth());assert!(e.eval_with_card(&s,other,other,defender,&defending).truth());assert!(!e.eval_with_card(&s,other,other,other,&defending).truth());
    let context=ResolutionContext::capture(&s);let hash=s.zobrist();s.attack_defender=other;assert_ne!(s.zobrist(),hash);context.restore(&mut s);assert_eq!(s.zobrist(),hash);
    s.death_frames[0].context=context;s.death_depth=1;s.attack_source=0;s.attack_defender=0;s.source=other;s.target=other;assert!(e.eval_with_card(&s,other,other,defender,&defending).truth());assert_eq!(e.active_attack_pair(&s,defender).0,attacker);
    e.leave_play(&mut s,attacker).unwrap();assert!(!e.is_attacking(&s,attacker));assert!(e.is_defending(&s,defender));assert_eq!(e.active_attack_pair(&s,defender).0,attacker);
    s.death_depth=0;e.cancel(&mut s);assert!(!e.is_defending(&s,defender));assert_eq!(e.power(&s,defender,false),power);
}
#[test]
fn guarded_attacker_raw_ir_requires_positive_same_candidate_guard_and_zero_argument_queries() {
    let guard=json!({"kind":"query","name":"isDefending","receiver":{"kind":"ref","path":["card"]},"args":[]});let relation=json!({"kind":"binary","op":"===","left":{"kind":"ref","path":["card","activeAttack","attacker"]},"right":{"kind":"ref","path":["source"]}});
    let valid:Expr=serde_json::from_value(json!({"kind":"binary","op":"&&","left":guard.clone(),"right":relation.clone()})).unwrap();valid.validate().unwrap();
    for expr in [relation.clone(),json!({"kind":"binary","op":"&&","left":relation.clone(),"right":guard.clone()}),json!({"kind":"binary","op":"||","left":guard.clone(),"right":relation.clone()}),json!({"kind":"binary","op":"&&","left":{"kind":"unary","op":"!","value":guard.clone()},"right":relation.clone()}),json!({"kind":"query","name":"isAttacking","receiver":{"kind":"ref","path":["source"]},"args":[{"kind":"const","value":true}]}),json!({"kind":"binary","op":"&&","left":{"kind":"query","name":"isDefending","receiver":{"kind":"ref","path":["source"]},"args":[]},"right":relation})] {let expr:Expr=serde_json::from_value(expr).unwrap();assert!(expr.validate().is_err());}
}
#[test]
fn complete_source_admission_preserves_secondary_and_printed_keyword_blockers() {
    let e=engine();for code in ["ASH_226","JTL_170","ASH_046","HMW_233"] {assert!(!e.by_code.contains_key(code),"partial card {code} admitted");}
    assert!(e.rejected_cards().unwrap()["ASH_046"].contains("keyword support"));assert!(e.rejected_cards().unwrap()["HMW_233"].contains("keyword hidden"));
    assert!(e.by_code.contains_key("SEC_011"));assert!(e.by_code.contains_key("TWI_094"));
}
#[test]
fn token_unit_selector_and_aura_exclude_upgrades_opponents_and_ordinary_units() {
    let e=engine();let mut s=board(&e);let source=unit(&e,&mut s,Seat::P1,"TWI_094");let own=unit(&e,&mut s,Seat::P1,"TOKEN_CLONE_TROOPER");let enemy=unit(&e,&mut s,Seat::P2,"TOKEN_CLONE_TROOPER");let ordinary=unit(&e,&mut s,Seat::P1,"LOF_256");e.create_token(&mut s,ordinary,false).unwrap();
    assert_eq!(e.constant_stats(&s,own).0,1);assert_eq!(e.constant_stats(&s,enemy).0,0);assert_eq!(e.constant_stats(&s,ordinary).0,0);assert_eq!(e.constant_stats(&s,source).0,0);
    let r:TargetResolver=serde_json::from_value(json!({"owner":"any","type":"tokenUnit","zone":"anyAttackable"})).unwrap();let candidates=e.matching_targets(&s,source,&r);assert!(candidates.contains(&own));assert!(candidates.contains(&enemy));assert!(!candidates.contains(&ordinary));assert!(!candidates.contains(&s.card(ordinary).shield));
}
#[test]
fn attachment_predicate_cannot_capture_live_modifier_binding() {
    let mut catalogue:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();let entry=catalogue["cards"].as_array_mut().unwrap().iter_mut().find(|entry|entry["setCode"]=="SOR_057").unwrap();entry["attachCondition"]=json!({"kind":"binary","op":">","left":{"kind":"ref","path":["modifierTarget","damage"]},"right":{"kind":"const","value":0}});
    let e=Engine::from_catalogue_value(&catalogue).unwrap();assert!(!e.by_code.contains_key("SOR_057"));assert!(e.rejected_cards().unwrap()["SOR_057"].contains("cannot capture"));
}
#[test]
fn confirmed_attack_enables_relationship_hp_aura_before_damage_and_cleans_up_after_defender_death() {
    let mut e=engine();let mut s=board(&e);let attacker=unit(&e,&mut s,Seat::P1,"LOF_256");let defender=unit(&e,&mut s,Seat::P2,"LOF_256");let base=s.players[1].base;s.card_mut(defender).damage=e.hp(&s,defender)-1;
    death_program(&mut e,&s,attacker,json!({"trigger":"constant","title":"Attacking defender loses HP","targetResolver":{"owner":"opponent","type":"unit","zone":"arena","predicate":{"kind":"binary","op":"&&","left":{"kind":"query","name":"isDefending","receiver":{"kind":"ref","path":["card"]},"args":[]},"right":{"kind":"binary","op":"===","left":{"kind":"ref","path":["card","activeAttack","attacker"]},"right":{"kind":"ref","path":["source"]}}}},"effect":{"kind":"modifyStats","target":"chosen","duration":"persistent","power":{"kind":"const","value":0},"hp":{"kind":"const","value":-1}}}));
    s=e.apply(&s,&e.card_action(&s,attacker)).unwrap();assert_eq!(s.decision,Decision::AttackTarget);assert!(s.players[1].ground.contains(defender));assert_eq!(s.attack_source,0);
    s=e.apply(&s,&e.card_action(&s,defender)).unwrap();assert!(s.players[1].discard.contains(defender));assert_eq!(s.card(attacker).damage,0);assert_eq!(s.card(base).damage,0);assert_eq!(s.attack_source,0);assert_eq!(s.attack_defender,0);
}
#[test]
fn selection_in_a_sequence_skips_targets_only_later_steps_change() {
    // Force Illusion (LOF_223): "Exhaust an enemy unit. A friendly unit gains Sentinel for this phase." With every
    // enemy unit exhausted, forceteki skips the exhaust and asks only for the Sentinel unit.
    let e=engine();let mut s=board(&e);
    let own=unit(&e,&mut s,Seat::P1,"LOF_254");let enemy=unit(&e,&mut s,Seat::P2,"LOF_256");s.card_mut(enemy).exhausted=true;
    let event=hand(&e,&mut s,"LOF_223");
    let s=e.apply(&s,&e.card_action(&s,event)).unwrap();
    assert_eq!(s.decision,Decision::AbilityTarget);
    let targets:Vec<_>=e.legal_actions(&s).iter().filter_map(Action::id).collect();
    assert_eq!(targets,vec![own]);
    let s=e.apply(&s,&e.card_action(&s,own)).unwrap();
    assert!(e.has_keyword(&s,own,"sentinel"));
    assert!(s.players[0].discard.contains(event));
}
#[test]
fn selection_without_targets_leaves_later_steps_their_effect() {
    let e=engine();let mut s=board(&e);
    let own=unit(&e,&mut s,Seat::P1,"LOF_254");
    let event=hand(&e,&mut s,"LOF_223");
    let p=*e.def(&s,event).programs.card.first().unwrap();
    assert!(e.program_has_effect(&s,event,p),"no enemy unit, but the Sentinel step still resolves");
    s.card_mut(own).present=false;s.players[0].ground=Default::default();
    assert!(!e.program_has_effect(&s,event,p));
}
#[test]
fn trigger_window_counts_a_triggered_target_that_changes_nothing() {
    // forceteki builds a triggered ability's target resolvers before it sets the change-required mode, so C-3PO's
    // On Attack (SEC_015) is offered when every unit is already exhausted, and then resolves with no effect.
    let e=engine();let mut s=board(&e);
    let c3po=add(&e,&mut s,Seat::P1,"SEC_015");s.player_mut(Seat::P1).leader=c3po;
    s.card_mut(c3po).deployed=true;s.card_mut(c3po).epic_used=true;e.add_arena(&mut s,c3po).unwrap();
    let own=unit(&e,&mut s,Seat::P1,"LOF_254");let enemy=unit(&e,&mut s,Seat::P2,"LOF_256");
    for id in [c3po,own,enemy] {s.card_mut(id).exhausted=true;}
    let p=*e.def(&s,c3po).programs.unit.first().unwrap();
    assert!(!e.program_has_effect(&s,c3po,p),"resolving it changes nothing");
    assert!(e.trigger_has_effect(&s,c3po,p));
    assert_eq!(e.program_menu_title(&s,c3po,p),"Exhaust a unit");
    s.card_mut(own).exhausted=false;
    assert!(!e.trigger_has_effect(&s,c3po,p),"no other exhausted unit: the condition fails");
    assert_eq!(e.program_menu_title(&s,c3po,p),"(No effect) Exhaust a unit");
}
#[test]
fn cards_are_admitted_only_with_the_tokens_they_create() {
    for (token, card) in [("TOKEN_EXPERIENCE", "LAW_037"), ("TOKEN_XWING", "JTL_099")] {
        assert!(engine().by_code.contains_key(card));
        let mut catalogue:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();
        let entry=catalogue["cards"].as_array_mut().unwrap().iter_mut().find(|entry|entry["setCode"]==token).unwrap();
        entry["card"]["cost"]=json!(5000);
        let e=Engine::from_catalogue_value(&catalogue).unwrap();
        assert!(!e.by_code.contains_key(token));
        assert!(!e.by_code.contains_key(card),"{card} creates {token}");
        assert_eq!(e.rejected_cards().unwrap()[card],format!("creates {token}, which is not admitted"));
    }
}
#[test]
fn restricted_pools_must_hold_the_tokens_their_cards_create() {
    let catalogue=include_bytes!("../../card-compiler/generated/catalog.json");
    let mut pool=engine().compiled_pool().unwrap();
    pool["cards"].as_array_mut().unwrap().retain(|c|c["setCode"]!="TOKEN_XWING");
    let err=Engine::from_compiled_pool_bytes(&serde_json::to_vec(&pool).unwrap(),catalogue).err().unwrap();
    assert!(err.contains("creates TOKEN_XWING, which the pool omits"),"{err}");
    pool["cards"].as_array_mut().unwrap().retain(|c|!["JTL_099","JTL_117","JTL_252","JTL_254"].contains(&c["setCode"].as_str().unwrap()));
    assert!(Engine::from_compiled_pool_bytes(&serde_json::to_vec(&pool).unwrap(),catalogue).is_ok());
}
#[test]
fn bases_cannot_be_upgraded_by_admitted_cards() {
    // isUpgraded reads only unit upgrades: Fortify, which attaches an upgrade to a base, must stay unadmitted
    let e=engine();
    for (code,card) in &e.catalogue.as_ref().unwrap().metadata {
        assert!(!card["keywords"].as_array().into_iter().flatten().any(|k|k=="fortify"),"{code} has Fortify");
    }
}
