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
    s.players[0].ground.remove(first);
    s.players[0].ground.push(first).unwrap();
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
