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
