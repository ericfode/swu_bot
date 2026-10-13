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
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let e=Engine::from_compiled_pool_bytes(include_bytes!("../../omni/rs/pool.json"),include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();
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
    s.hidden_history_exact=true;
    s.force_state_exact=true;
    for (seat, leader) in [(Seat::P1, "SOR_014"), (Seat::P2, "IBH_053")] {
        let base = add(e, &mut s, seat, "ASH_019");
        let leader = add(e, &mut s, seat, leader);
        s.player_mut(seat).base = base;
        s.player_mut(seat).leader = leader;
        s.player_mut(seat).force_id = s.next_id;
        s.next_id += 1;
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
    for bad in [json!({"sentinel":2}),json!({"raid":65536}),json!({"hidden":2}),json!({"restore":-1}),json!({"restore":0})] {
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
    for effect in [json!({"kind":"gainKeyword","target":"self","keyword":"unsupported-keyword","duration":"persistent"}),json!({"kind":"gainKeyword","target":"self","keyword":"raid","amount":{"kind":"query","name":"getPower","receiver":{"kind":"ref","path":["source"]}},"duration":"persistent"}),json!({"kind":"gainKeyword","target":"self","keyword":"grit","amount":{"kind":"const","value":2},"duration":"persistent"}),json!({"kind":"gainKeyword","target":"self","keyword":"restore","amount":{"kind":"const","value":-1},"duration":"persistent"})] {
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
    for resolver in [json!({"type":"upgrade","owner":"any","zone":"arena","arena":"ground"}),json!({"type":"upgrade","owner":"any","zone":"arena","arena":"space"}),json!({"type":"upgrade","owner":"any","zone":"hand"}),json!({"type":"upgrade","owner":"any","zone":"base"})] {
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
    let e=engine();for code in ["ASH_226","JTL_170","ASH_046"] {assert!(!e.by_code.contains_key(code),"partial card {code} admitted");}
    assert!(e.rejected_cards().unwrap()["ASH_046"].contains("keyword support"));assert!(e.by_code.contains_key("HMW_233"));
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
fn aot_pilot_programs_execute_directly_and_match_forced_interpreter() {
    for code in ["TWI_124", "TWI_170"] {
        let mut e=engine();
        e.set_rules_instrumentation(true);
        let mut s=board(&e);
        let target=if code=="TWI_124" {unit(&e,&mut s,Seat::P1,"LOF_254")}else{s.players[1].base};
        let event=hand(&e,&mut s,code);
        let index=e.def(&s,event).programs.card[0] as usize;
        assert!(e.catalogue.as_ref().unwrap().programs[index].executable.is_ok());
        // This focused pool admits only the pilot execution programs.
        for d in &mut e.definitions {if d.code!=code {d.programs=Default::default();}}
        e.set_rules_backend(RulesBackend::Aot).unwrap();
        let prompt=e.apply(&s,&e.card_action(&s,event)).unwrap();
        let actual=e.apply(&prompt,&e.card_action(&prompt,target)).unwrap();
        let hits=e.rules_hits.lock().unwrap()[&index];
        assert!(hits[0]>0);assert_eq!(hits[1],0);
        e.rules_hits.lock().unwrap().clear();
        e.set_rules_backend(RulesBackend::Interpreter).unwrap();
        let other_prompt=e.apply(&s,&e.card_action(&s,event)).unwrap();
        assert_eq!(e.snapshot(&prompt),e.snapshot(&other_prompt));
        assert_eq!(e.legal_actions(&prompt),e.legal_actions(&other_prompt));
        let expected=e.apply(&other_prompt,&e.card_action(&other_prompt,target)).unwrap();
        assert_eq!(e.snapshot(&actual),e.snapshot(&expected));
        let hits=e.rules_hits.lock().unwrap()[&index];assert_eq!(hits[0],0);assert!(hits[1]>0);
        if code=="TWI_124" {assert_eq!(actual.card(target).phase_power,2);assert_eq!(actual.card(target).phase_hp,2);} else {assert_eq!(actual.card(target).damage,2);}
    }
}
#[test]
fn aot_identity_is_content_based_and_unknown_programs_have_explicit_fallback() {
    let e=engine();let c=e.catalogue.as_ref().unwrap();
    let index=c.cards["TWI_170"].card[0] as usize;
    let p=&c.programs[index];let bytes=serde_json::to_vec(p).unwrap();
    let hash=format!("{:x}",Sha256::digest(&bytes));
    assert_eq!(generated_backend(&hash,&bytes),p.executable);
    assert!(generated_backend(&hash,b"changed operand").is_err());
    let mut value:serde_json::Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();
    let card=value["cards"].as_array_mut().unwrap().iter_mut().find(|c|c["setCode"]=="TWI_170").unwrap();
    card["abilities"]["card"][0]["effect"]["amount"]["value"]=serde_json::json!(3);
    let mut external=Engine::from_catalogue_value(&value).unwrap();
    let mut s=board(&external);let target=s.players[1].base;let event=hand(&external,&mut s,"TWI_170");
    assert!(external.set_rules_backend(RulesBackend::Aot).unwrap_err().contains("AOT backend unavailable"));
    external.set_rules_backend(RulesBackend::Auto).unwrap();
    let prompt=external.apply(&s,&external.card_action(&s,event)).unwrap();
    let actual=external.apply(&prompt,&external.card_action(&prompt,target)).unwrap();assert_eq!(actual.card(target).damage,3);
}

#[test]
fn arena_list_phase_stats_snapshot_owner_arena_and_expiry() {
    let e=engine();
    let mut s=board(&e);
    let friendly=unit(&e,&mut s,Seat::P1,"ASH_029");
    let ground=unit(&e,&mut s,Seat::P2,"ASH_029");
    let space=unit(&e,&mut s,Seat::P2,"ASH_029");
    s.players[1].ground.remove(space);s.players[1].space.push(space).unwrap();
    s.source=hand(&e,&mut s,"TS26_048");s.ability_target=friendly;
    let effect:Effect=serde_json::from_value(json!({"kind":"modifyStats","duration":"phase","target":{"kind":"arenaList","receiver":{"kind":"ref","path":["opponent"]},"predicate":{"kind":"binary","op":"===","left":{"kind":"ref","path":["card","zoneName"]},"right":{"kind":"const","value":"groundArena"}}},"power":{"kind":"const","value":-1},"hp":{"kind":"const","value":-1}})).unwrap();
    e.apply_effect(&mut s,&effect).unwrap();
    assert_eq!((s.card(friendly).phase_power,s.card(space).phase_power),(0,0));
    assert_eq!((s.card(ground).phase_power,s.card(ground).phase_hp),(-1,-1));
    assert_eq!(s.ability_target,friendly,"candidate must not overwrite outer binding");
    s.players[0].out=true;s.players[1].out=true;e.advance(&mut s).unwrap();
    assert_eq!((s.card(ground).phase_power,s.card(ground).phase_hp),(0,0));
}

#[test]
fn arena_list_phase_stats_support_more_than_prepared_group_capacity() {
    let e=engine();let mut s=board(&e);
    for _ in 0..40 {unit(&e,&mut s,Seat::P1,"LOF_254");}
    s.source=hand(&e,&mut s,"TWI_126");
    let effect:Effect=serde_json::from_value(json!({"kind":"modifyStats","duration":"phase","target":{"kind":"arenaList","receiver":{"kind":"ref","path":["player"]},"predicate":{"kind":"const","value":true}},"power":{"kind":"const","value":1},"hp":{"kind":"const","value":1}})).unwrap();
    assert_eq!(e.apply_effect(&mut s,&effect).unwrap(),(40,true));
    assert!(e.arena_units(&s).iter().all(|id|s.card(*id).phase_hp==1));
}

#[test]
fn arena_list_phase_stats_collect_complete_lethal_set_and_ignore_shields() {
    let e=engine();let mut s=board(&e);
    let a=unit(&e,&mut s,Seat::P2,"LOF_254");let b=unit(&e,&mut s,Seat::P2,"LOF_254");
    e.create_token(&mut s,a,false).unwrap();
    s.source=hand(&e,&mut s,"TWI_075");
    let effect:Effect=serde_json::from_value(json!({"kind":"modifyStats","duration":"phase","target":{"kind":"arenaList","receiver":{"kind":"ref","path":["opponent"]},"predicate":{"kind":"const","value":true}},"power":{"kind":"const","value":-65535},"hp":{"kind":"const","value":-65535}})).unwrap();
    e.apply_effect(&mut s,&effect).unwrap();assert!(!e.in_arena(&s,a));assert!(!e.in_arena(&s,b));
    assert_eq!(e.apply_effect(&mut s,&effect).unwrap(),(0,false));
}

fn arena_defeat(receiver:&str)->Effect {serde_json::from_value(json!({"kind":"defeat","target":{"kind":"arenaList","receiver":{"kind":"ref","path":[receiver]},"predicate":{"kind":"const","value":true}}})).unwrap()}
#[test]
fn arena_list_defeat_captures_all_sources_and_reverses_complete_cleanup() {
    let mut e=engine();let mut s=board(&e);
    let a=unit(&e,&mut s,Seat::P1,"LOF_254");let b=unit(&e,&mut s,Seat::P2,"LOF_256");
    let upgrade_a=add(&e,&mut s,Seat::P1,"SOR_057");let upgrade_b=add(&e,&mut s,Seat::P1,"SOR_057");
    e.attach(&mut s,upgrade_a,a);e.attach(&mut s,upgrade_b,b);
    e.create_token(&mut s,a,false).unwrap();let shield=s.card(a).shield;
    e.create_token(&mut s,b,true).unwrap();let experience=s.card(b).experience;
    for source in [a,b] {death_program(&mut e,&s,source,json!({"trigger":"whenDefeated","title":"Draw","condition":{"kind":"binary","op":"===","left":{"kind":"query","name":"arenaUnitCount","receiver":{"kind":"ref","path":["opponent"]},"args":[{"kind":"const","value":true}]},"right":{"kind":"const","value":1}},"effect":{"kind":"draw","target":"ownPlayer","amount":{"kind":"const","value":1}}}));}
    s.source=hand(&e,&mut s,"SOR_043");let outer=s.players[0].leader;s.ability_target=outer;
    assert_eq!(e.apply_effect(&mut s,&arena_defeat("game")).unwrap(),(2,true));
    assert_eq!(s.death_pending.len,2,"both conditions saw pre-movement board");
    assert_eq!(s.players[0].discard.as_slice(),&[upgrade_b,upgrade_a,a]);
    assert_eq!(s.players[1].discard.as_slice(),&[b]);
    assert_eq!(s.card(shield).parent,0);assert_eq!(s.card(experience).parent,0);
    assert_eq!(s.ability_target,outer);
}
#[test]
fn arena_list_defeat_large_window_leader_token_and_missing_order() {
    let e=engine();let mut s=board(&e);
    for _ in 0..40 {unit(&e,&mut s,Seat::P2,"LOF_254");}
    let leader=s.players[1].leader;s.card_mut(leader).deployed=true;e.add_arena(&mut s,leader).unwrap();
    let token=unit(&e,&mut s,Seat::P2,"TOKEN_CLONE_TROOPER");
    let own=unit(&e,&mut s,Seat::P1,"LOF_254");s.source=hand(&e,&mut s,"TWI_126");
    let mut legacy=s;legacy.arena_order_exact=false;assert!(e.apply_effect(&mut legacy,&arena_defeat("opponent")).is_err());
    assert_eq!(e.apply_effect(&mut s,&arena_defeat("opponent")).unwrap(),(42,true));
    assert!(e.in_arena(&s,own));assert!(!s.card(leader).deployed);assert!(s.card(leader).exhausted);
    assert!(!s.players[1].discard.contains(leader));assert!(!s.players[1].discard.contains(token));
    assert_eq!(e.apply_effect(&mut s,&arena_defeat("opponent")).unwrap(),(0,false));
    eprintln!("State bytes={} (no storage changes for arena-list defeat)",std::mem::size_of::<State>());
}

#[test]
fn has_cost_tracks_engine_property_ancestry_not_positive_numeric_cost() {
    let e=engine();let mut s=board(&e);let source=s.players[0].leader;
    for (code,expected) in [("ASH_019",false),("SOR_014",true),("LOF_254",true),("SOR_057",true),("TWI_126",true),("TOKEN_SHIELD",true),("TOKEN_CLONE_TROOPER",true)] {
        let card=add(&e,&mut s,Seat::P1,code);
        let expr:Expr=serde_json::from_value(json!({"kind":"query","name":"hasCost","receiver":{"kind":"ref","path":["target"]},"args":[]})).unwrap();
        expr.validate().unwrap();assert_eq!(e.eval(&s,source,card,&expr).truth(),expected,"{code}");
    }
    for receiver in [json!({"kind":"ref","path":["player"]}),json!({"kind":"const","value":true}),json!({"kind":"ref","path":["target","controller"]})] {
        let expr:Expr=serde_json::from_value(json!({"kind":"query","name":"hasCost","receiver":receiver,"args":[]})).unwrap();assert!(expr.validate().is_err());
    }
}

#[test]
fn scalar_upgrade_return_admits_five_complete_sources_without_storage_growth() {
    let e=engine();for code in ["HMW_222","SHD_044","SHD_209","HMW_236","SEC_200"] {assert!(e.by_code.contains_key(code),"{code}: {:?}",e.rejected_cards().unwrap().get(code));}
    eprintln!("State bytes={} (no storage changes for scalar upgrade return)",std::mem::size_of::<State>());
    assert!(!e.by_code.contains_key("ASH_232"),"grouped nested upgrade return remains unsupported");
}
#[test]
fn scalar_upgrade_return_detaches_to_owner_and_token_return_removes_exact_identity() {
    let e=engine();let mut s=board(&e);let parent=unit(&e,&mut s,Seat::P2,"LOF_256");let source=s.players[0].leader;
    let upgrade=add(&e,&mut s,Seat::P1,"SOR_057");e.attach(&mut s,upgrade,parent);e.create_token(&mut s,parent,false).unwrap();let shield=s.card(parent).shield;e.create_token(&mut s,parent,true).unwrap();let experience=s.card(parent).experience;
    s.source=source;s.ability_target=upgrade;let hp=e.hp(&s,parent);
    e.apply_effect(&mut s,&Effect::ReturnToHand {target:Target::name("chosen")}).unwrap();
    assert!(s.players[0].hand.contains(upgrade));assert!(!s.players[1].hand.contains(upgrade));assert!(!s.players[0].discard.contains(upgrade));assert_eq!(s.card(upgrade).parent,0);assert!(e.hp(&s,parent)<hp);assert_eq!(s.card(parent).shield,shield);assert_eq!(s.card(parent).experience,experience);assert_eq!(s.death_pending.len,0);e.validate_attachment_links(&s).unwrap();
    s.ability_target=shield;e.apply_effect(&mut s,&Effect::ReturnToHand {target:Target::name("chosen")}).unwrap();assert_eq!(s.card(parent).shield,0);assert_eq!(s.card(shield).parent,0);assert_eq!(s.card(parent).experience,experience);assert!(!s.players[1].hand.contains(shield));assert!(!s.players[1].discard.contains(shield));e.validate_attachment_links(&s).unwrap();
    s.ability_target=experience;e.apply_effect(&mut s,&Effect::ReturnToHand {target:Target::name("chosen")}).unwrap();assert_eq!(s.card(parent).experience,0);assert!(!s.players[1].hand.contains(experience));assert!(!s.players[1].discard.contains(experience));e.validate_attachment_links(&s).unwrap();
}
#[test]
fn scalar_upgrade_return_discard_zone_and_implicit_type_predicates_preserve_inventory() {
    let e=engine();let mut s=board(&e);let source=unit(&e,&mut s,Seat::P1,"SHD_044");let parent=unit(&e,&mut s,Seat::P2,"LOF_256");let attached=add(&e,&mut s,Seat::P1,"SOR_057");e.attach(&mut s,attached,parent);let own=add(&e,&mut s,Seat::P1,"SOR_057");s.players[0].discard.push(own).unwrap();let enemy=add(&e,&mut s,Seat::P2,"SOR_057");s.players[1].discard.push(enemy).unwrap();
    let r=&e.program(e.card_programs(&s,source)[0]).instructions.iter().find_map(|i|if let Instruction::Select(r)=i {Some(r)}else{None}).unwrap();assert_eq!(e.matching_targets(&s,source,r),vec![own]);
    s.source=source;s.ability_target=own;e.apply_effect(&mut s,&Effect::ReturnToHand {target:Target::name("chosen")}).unwrap();assert!(s.players[0].hand.contains(own));assert!(!s.players[0].discard.contains(own));assert!(s.players[1].discard.contains(enemy));assert_eq!(s.card(attached).parent,parent);assert_eq!(s.death_pending.len,0);
    let senator=unit(&e,&mut s,Seat::P1,"SEC_200");let r=e.program(e.card_programs(&s,senator)[0]).instructions.iter().find_map(|i|if let Instruction::Select(r)=i {Some(r)}else{None}).unwrap();assert!(r.is_upgrade_domain());assert_eq!(e.matching_targets(&s,senator,r),vec![attached]);
    let ordinary:TargetResolver=serde_json::from_value(json!({"type":"any","owner":"any","zone":"arena"})).unwrap();assert!(!e.matching_targets(&s,senator,&ordinary).contains(&attached));
}
#[test]
fn scalar_upgrade_return_hp_loss_captures_host_death_but_not_upgrade_death() {
    // Synthetic death registration diagnostics isolate the removal event from
    // the actual-card reference fixtures, which independently witness timing.
    let mut e=engine();let mut s=board(&e);let parent=unit(&e,&mut s,Seat::P2,"LOF_256");let source=s.players[0].leader;let upgrade=add(&e,&mut s,Seat::P1,"SOR_057");e.attach(&mut s,upgrade,parent);
    death_program(&mut e,&s,parent,draw_death(false));death_program(&mut e,&s,upgrade,draw_death(false));let own_draw=deck_card(&e,&mut s,Seat::P1);let enemy_draw=deck_card(&e,&mut s,Seat::P2);
    s.card_mut(parent).damage=e.hp(&s,parent)-1;s.source=source;s.ability_target=upgrade;e.apply_effect(&mut s,&Effect::ReturnToHand {target:Target::name("chosen")}).unwrap();
    assert!(s.players[0].hand.contains(upgrade));assert!(s.players[1].discard.contains(parent));assert_eq!(s.death_pending.len,1);assert_eq!(s.death_pending.entries[0].source,parent);e.finish(&mut s).unwrap();assert!(s.players[1].hand.contains(enemy_draw));assert!(s.players[0].deck.contains(own_draw));e.validate_attachment_links(&s).unwrap();
}
#[test]
fn scalar_upgrade_return_rejects_unverified_domains_groups_and_arity() {
    for predicate in [json!({"kind":"binary","op":"||","left":{"kind":"query","name":"isUpgrade","receiver":{"kind":"ref","path":["card"]},"args":[]},"right":{"kind":"query","name":"isUnit","receiver":{"kind":"ref","path":["card"]},"args":[]}}),json!({"kind":"unary","op":"!","value":{"kind":"query","name":"isUpgrade","receiver":{"kind":"ref","path":["card"]},"args":[]}})]{
        let a:crate::ability_ir::Ability=serde_json::from_value(json!({"trigger":"event","title":"mixed","targetResolver":{"type":"any","predicate":predicate},"effect":{"kind":"returnToHand","target":"chosen"}})).unwrap();assert!(crate::ability_ir::Program::compile(&a).is_err());
    }
    for receiver in [json!({"kind":"ref","path":["player"]}),json!({"kind":"ref","path":["source","parentUnit"]})]{let q:Expr=serde_json::from_value(json!({"kind":"query","name":"isUpgrade","receiver":receiver,"args":[]})).unwrap();assert!(q.validate().is_err());}
    let q:Expr=serde_json::from_value(json!({"kind":"query","name":"isUpgrade","receiver":{"kind":"ref","path":["card"]},"args":[{"kind":"const","value":1}]})).unwrap();assert!(q.validate().is_err());
}
#[test]
fn scalar_upgrade_return_source_threshold_unique_and_tatooine_boundaries() {
    let e=engine();let mut s=board(&e);let parent=unit(&e,&mut s,Seat::P2,"LOF_256");let senator=unit(&e,&mut s,Seat::P1,"SEC_200");
    e.create_token(&mut s,parent,false).unwrap();let shield=s.card(parent).shield;e.create_token(&mut s,parent,true).unwrap();let experience=s.card(parent).experience;
    let cost3=add(&e,&mut s,Seat::P1,"ASH_087");e.attach(&mut s,cost3,parent);let cost4=add(&e,&mut s,Seat::P1,"LOF_171");e.attach(&mut s,cost4,parent);let unique=add(&e,&mut s,Seat::P1,"LOF_238");e.attach(&mut s,unique,parent);
    let resolver=|source|e.program(e.card_programs(&s,source)[0]).instructions.iter().find_map(|i|if let Instruction::Select(r)=i {Some(r.clone())}else{None}).unwrap();
    let candidates=e.matching_targets(&s,senator,&resolver(senator));assert!(candidates.contains(&cost3));assert!(candidates.contains(&unique));assert!(!candidates.contains(&cost4));assert!(!candidates.contains(&parent));assert!(candidates.contains(&shield));assert!(candidates.contains(&experience));
    let muscle=unit(&e,&mut s,Seat::P1,"SHD_209");let r=e.program(e.card_programs(&s,muscle)[0]).instructions.iter().find_map(|i|if let Instruction::Select(r)=i {Some(r)}else{None}).unwrap();let candidates=e.matching_targets(&s,muscle,r);assert!(candidates.contains(&cost3));assert!(candidates.contains(&cost4));assert!(!candidates.contains(&unique));
    let sandcrawler=unit(&e,&mut s,Seat::P1,"HMW_222");let conditional=Effect::Conditional {condition:Expr::Query {name:"hasSomeTrait".into(),receiver:Box::new(Expr::Ref {path:vec!["player".into(),"base".into()]}),args:vec![Expr::Const {value:json!("tatooine")}]},on_true:Box::new(Effect::ReturnToHand {target:Target::name("chosen")}),on_false:Some(Box::new(Effect::NoAction))};
    assert!(!e.effect_can_affect(&s,sandcrawler,cost3,&conditional,true));let enemy_base=s.players[1].base;s.card_mut(enemy_base).def=*e.by_code.get("HMW_019").unwrap();assert!(!e.effect_can_affect(&s,sandcrawler,cost3,&conditional,true));let own_base=s.players[0].base;s.card_mut(own_base).def=*e.by_code.get("HMW_019").unwrap();assert!(e.effect_can_affect(&s,sandcrawler,cost3,&conditional,true));
}
#[test]
fn scalar_upgrade_return_domain_does_not_admit_groups_or_effectless_selection() {
    let resolver=json!({"type":"any","owner":"any","predicate":{"kind":"query","name":"isUpgrade","receiver":{"kind":"ref","path":["card"]},"args":[]}});
    let select=json!({"kind":"select","targetResolver":resolver,"effect":{"kind":"returnToHand","target":"chosen"}});
    let a:crate::ability_ir::Ability=serde_json::from_value(json!({"trigger":"event","title":"Grouped upgrade","effect":{"kind":"simultaneous","effects":[select]}})).unwrap();assert!(crate::ability_ir::Program::compile(&a).unwrap_err().contains("grouped upgrade selection"));
    for effect in [json!({"kind":"noAction"}),json!({"kind":"conditional","condition":{"kind":"const","value":true},"onTrue":{"kind":"noAction"},"onFalse":{"kind":"noAction"}})] {
        let a:crate::ability_ir::Ability=serde_json::from_value(json!({"trigger":"event","title":"No-op selector","targetResolver":resolver,"effect":effect})).unwrap();assert!(crate::ability_ir::Program::compile(&a).is_err());
    }
    let a:crate::ability_ir::Ability=serde_json::from_value(json!({"trigger":"event","title":"Discard defeat","targetResolver":{"type":"upgrade","owner":"self","zone":"discard"},"effect":{"kind":"defeat","target":"chosen"}})).unwrap();assert!(crate::ability_ir::Program::compile(&a).is_err());
}
#[test]
fn scalar_upgrade_return_does_not_consume_a_discard_slot_before_moving_to_hand() {
    let e=engine();let mut s=board(&e);let parent=unit(&e,&mut s,Seat::P2,"LOF_256");let source=s.players[0].leader;let upgrade=add(&e,&mut s,Seat::P1,"SOR_057");e.attach(&mut s,upgrade,parent);
    for _ in 0..MAX_ZONE {let id=add(&e,&mut s,Seat::P1,"LOF_256");s.players[0].discard.push(id).unwrap();}let original=s.players[0].discard;
    s.source=source;s.ability_target=upgrade;e.apply_effect(&mut s,&Effect::ReturnToHand {target:Target::name("chosen")}).unwrap();
    assert_eq!(s.players[0].discard.as_slice(),original.as_slice());assert!(s.players[0].hand.contains(upgrade));assert_eq!(s.card(upgrade).parent,0);assert_eq!(s.card(parent).upgrades,0);e.validate_attachment_links(&s).unwrap();
}
#[test]
fn scalar_upgrade_return_rejects_unsupported_operations_in_every_continuation_selector() {
    for continuation in ["then","ifYouDo"] {for effect in [json!({"kind":"defeat","target":"chosen"}),json!({"kind":"noAction"}),json!({"kind":"damage","target":"chosen","amount":{"kind":"const","value":1}})] {
        let mut value=json!({"trigger":"event","title":"draw then unsupported upgrade action","effect":{"kind":"draw","target":"ownPlayer","amount":{"kind":"const","value":1}}});
        value[continuation]=json!({"title":"unsupported discard upgrade action","targetResolver":{"type":"upgrade","owner":"self","zone":"discard"},"effect":effect});let ability:crate::ability_ir::Ability=serde_json::from_value(value).unwrap();assert!(crate::ability_ir::Program::compile(&ability).unwrap_err().contains("upgrade selection supports only scalar defeat or return to hand"));
    }}
}

fn declaration(e:&Engine,mut s:State,attacker:CardId,defender:CardId)->State {
    s.active=s.card(attacker).owner;s.source=attacker;s.decision=Decision::AttackTarget;
    e.apply(&s,&e.card_action(&s,defender)).unwrap()
}
fn named_button(e:&Engine,s:&State,label:&str)->State {let a=e.legal_actions(s).into_iter().find(|a|a.label==label).unwrap_or_else(||panic!("missing {label}: {:?}",e.legal_actions(s)));e.apply(s,&a).unwrap()}
#[test]
fn defense_admission_is_generic_six_complete_cards_and_hidden_integrates() {
    let e=engine();for code in ["LOF_047","SHD_035","SOR_196","TS26_024","TWI_049","TWI_083"] {assert!(e.by_code.contains_key(code),"{code}: {:?}",e.rejected_cards().unwrap().get(code));}
    assert!(e.by_code.contains_key("SEC_187"));eprintln!("State bytes={} (no storage growth for declaration windows)",std::mem::size_of::<State>());
}
#[test]
fn defense_optional_uses_defender_owner_and_preserves_attack_while_prompting() {
    let e=engine();let mut s=board(&e);let attacker=unit(&e,&mut s,Seat::P2,"JTL_212");let defender=unit(&e,&mut s,Seat::P1,"LOF_047");let base=s.players[0].base;
    let s=declaration(&e,s,attacker,defender);assert_eq!(s.active,Seat::P1);assert_eq!(s.source,defender);assert_eq!(s.decision,Decision::AbilityOptional);assert!(s.card(attacker).exhausted);assert_eq!((s.attack_source,s.attack_defender),(attacker,defender));assert_eq!(e.is_attacking(&s,attacker),true);assert_eq!(e.is_defending(&s,defender),true);
    let passed=named_button(&e,&s,"Pass");assert_eq!(passed.card(defender).experience,0);assert_eq!(passed.card(base).damage,0);
    let triggered=named_button(&e,&s,"Trigger");assert_ne!(triggered.card(defender).experience,0);assert_eq!(triggered.card(base).damage,0);assert_eq!(triggered.attack_source,0);assert_eq!(triggered.death_depth,0);
}
#[test]
fn defense_joint_owner_priority_is_action_player_even_when_initiative_is_opponent() {
    let e=engine();let mut s=board(&e);s.initiative=Seat::P1;let attacker=unit(&e,&mut s,Seat::P2,"LOF_256");let defender=unit(&e,&mut s,Seat::P1,"SOR_196");s.card_mut(defender).exhausted=true;let own=s.players[1].base;s.card_mut(own).damage=4;let restoration=add(&e,&mut s,Seat::P2,"HMW_096");e.attach(&mut s,restoration,attacker);
    let started=declaration(&e,s,attacker,defender);assert_eq!(started.decision,Decision::DeathPlayer);assert_eq!(started.active,Seat::P2);
    for label in ["You","Opponent"] {let done=named_button(&e,&started,label);assert_eq!(done.card(own).damage,2);assert!(!done.card(defender).exhausted);assert_eq!(done.death_depth,0);assert_eq!(done.attack_source,0);}
}
#[test]
fn defense_saboteur_feasibility_and_resolution_survive_other_owner_optional_prompt() {
    let mut e=engine();let mut s=board(&e);let attacker=unit(&e,&mut s,Seat::P2,"JTL_212");let defender=unit(&e,&mut s,Seat::P1,"LOF_047");e.definitions[s.card(attacker).def as usize].flags|=SABOTEUR;e.create_token(&mut s,defender,false).unwrap();e.create_token(&mut s,defender,false).unwrap();let started=declaration(&e,s,attacker,defender);assert_eq!(started.decision,Decision::DeathPlayer);
    for priority in ["You","Opponent"] {let mut done=named_button(&e,&started,priority);assert_eq!(done.active,Seat::P1);assert_eq!(done.decision,Decision::AbilityOptional);done=named_button(&e,&done,"Trigger");assert_eq!(done.card(defender).shield,0);assert_ne!(done.card(defender).experience,0);assert_eq!(done.death_depth,0);e.validate_attachment_links(&done).unwrap();}
}
#[test]
fn defense_mandatory_token_registration_survives_source_removed_by_attack_trigger() {
    // Synthetic attack registration isolates capture-vs-resolution; pipeline
    // witnesses use the pinned actual attacker and actual defender definitions.
    for code in ["TWI_049","TWI_083"] {let mut e=engine();let mut s=board(&e);let attacker=unit(&e,&mut s,Seat::P2,"LOF_256");let defender=unit(&e,&mut s,Seat::P1,code);
        death_program(&mut e,&s,attacker,json!({"trigger":"onAttack","title":"remove defender","targetResolver":{"type":"unit","owner":"opponent","zone":"arena"},"effect":{"kind":"defeat","target":"chosen"}}));
        let started=declaration(&e,s,attacker,defender);assert_eq!(started.decision,Decision::DeathPlayer);let picked=named_button(&e,&started,"You");assert_eq!(picked.decision,Decision::AbilityTarget);
        let done=e.apply(&picked,&e.card_action(&picked,defender)).unwrap();assert_eq!(done.players[0].ground.len,1);assert!(done.players[0].discard.contains(defender));assert_eq!(done.players[1].ground.len,1);assert_eq!(done.death_depth,0);
    }
}
#[test]
fn defense_initial_attack_stat_death_joins_one_declaration_owner_window() {
    // Synthetic instance diagnostics mirror the independently recorded engine
    // attack-aura boundary. They are not printed-card acceptance evidence.
    let mut e=engine();let mut s=board(&e);let attacker=unit(&e,&mut s,Seat::P2,"LOF_256");let defender=unit(&e,&mut s,Seat::P1,"TWI_049");let own_draw=deck_card(&e,&mut s,Seat::P1);let enemy_draw=deck_card(&e,&mut s,Seat::P2);
    death_program(&mut e,&s,defender,draw_death(false));death_program(&mut e,&s,attacker,json!({"trigger":"constant","title":"SYNTHETIC attack aura","condition":{"kind":"query","name":"isAttacking","receiver":{"kind":"ref","path":["source"]},"args":[]},"targetResolver":{"owner":"opponent","type":"unit","zone":"arena"},"effect":{"kind":"modifyStats","target":"chosen","duration":"persistent","power":{"kind":"const","value":0},"hp":{"kind":"const","value":-1}}}));death_program(&mut e,&s,attacker,json!({"trigger":"onAttack","title":"SYNTHETIC attacker draw","effect":{"kind":"draw","target":"ownPlayer","amount":{"kind":"const","value":1}}}));
    s.card_mut(defender).damage=e.hp(&s,defender)-1;let started=declaration(&e,s,attacker,defender);assert!(started.players[0].discard.contains(defender));assert_eq!(started.active,Seat::P2);assert_eq!(started.decision,Decision::DeathPlayer);
    for priority in ["You","Opponent"] {let chosen=named_button(&e,&started,priority);assert_eq!(chosen.decision,Decision::DeathOrder);assert_eq!(chosen.active,Seat::P1);let labels:Vec<_>=e.legal_actions(&chosen).iter().map(|a|a.label.clone()).collect();assert!(labels.contains(&"Create a Clone Trooper token.".to_string()));assert!(labels.contains(&"Draw a card".to_string()));assert_eq!(chosen.players[1].hand.contains(enemy_draw),priority=="You");let done=named_button(&e,&chosen,"Create a Clone Trooper token.");assert!(done.players[0].hand.contains(own_draw));assert!(done.players[1].hand.contains(enemy_draw));assert_eq!(done.players[0].ground.len,1);assert_eq!(done.death_depth,0);}
}
#[test]
fn defense_metadata_scope_rejects_unwitnessed_token_leader_upgrade_and_front_sources() {
    let original:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();
    for (types,base) in [(json!(["unit","token"]),"TokenUnitCard"),(json!(["leader"]),"LeaderUnitCard"),(json!(["upgrade"]),"UpgradeCard"),(json!(["base"]),"BaseCard"),(json!(["event"]),"EventCard"),(json!(["unit"]),"UnknownUnitBase")] {
        let mut value=original.clone();let entry=value["cards"].as_array_mut().unwrap().iter_mut().find(|x|x["setCode"]=="TWI_049").unwrap();entry["card"]["types"]=types;entry["baseClass"]=json!(base);let engine=Engine::from_catalogue_value(&value).unwrap();assert!(engine.rejected_cards().unwrap()["TWI_049"].contains("ordinary nonleader unit"));
    }
}
#[test]
fn defense_all_ineffective_window_skips_order_but_effective_other_owner_keeps_both_choices() {
    let e=engine();let mut s=board(&e);let attacker=unit(&e,&mut s,Seat::P2,"LOF_256");let defender=unit(&e,&mut s,Seat::P1,"SOR_196");let restoration=add(&e,&mut s,Seat::P2,"HMW_096");e.attach(&mut s,restoration,attacker);let base=s.players[1].base;
    let mut effective=s;s.card_mut(base).damage=0;let ineffective=declaration(&e,s,attacker,defender);assert_ne!(ineffective.decision,Decision::DeathPlayer);assert_eq!(ineffective.death_depth,0);
    effective.card_mut(base).damage=4;let effective=declaration(&e,effective,attacker,defender);assert_eq!(effective.decision,Decision::DeathPlayer);assert_eq!(effective.active,Seat::P2);assert_eq!(e.legal_actions(&effective).iter().map(|a|a.label.as_str()).collect::<Vec<_>>(),vec!["You","Opponent"]);
}
#[test]
fn defense_selected_attack_stat_death_nests_before_remaining_declaration_entries() {
    // Optional synthetic death draw provides an observable pause at the same
    // child-event boundary recorded with mandatory draw by the engine diagnostic.
    let mut e=engine();let mut s=board(&e);let attacker=unit(&e,&mut s,Seat::P2,"LOF_256");let defender=unit(&e,&mut s,Seat::P1,"TWI_049");let own_draw=deck_card(&e,&mut s,Seat::P1);let enemy_draw=deck_card(&e,&mut s,Seat::P2);death_program(&mut e,&s,defender,draw_death(true));
    death_program(&mut e,&s,attacker,json!({"trigger":"onAttack","title":"SYNTHETIC lower defender HP","targetResolver":{"type":"unit","owner":"opponent","zone":"arena"},"effect":{"kind":"modifyStats","target":"chosen","duration":"phase","power":{"kind":"const","value":0},"hp":{"kind":"const","value":-1}}}));death_program(&mut e,&s,attacker,json!({"trigger":"onAttack","title":"SYNTHETIC attacker draw","effect":{"kind":"draw","target":"ownPlayer","amount":{"kind":"const","value":1}}}));
    s.card_mut(defender).damage=e.hp(&s,defender)-1;let started=declaration(&e,s,attacker,defender);let owner=named_button(&e,&started,"You");assert_eq!(owner.decision,Decision::DeathOrder);let target=named_button(&e,&owner,"SYNTHETIC lower defender HP");let paused=e.apply(&target,&e.card_action(&target,defender)).unwrap();
    assert_eq!(paused.active,Seat::P1);assert_eq!(paused.decision,Decision::AbilityOptional);assert_eq!(paused.death_depth,2);assert!(paused.players[0].discard.contains(defender));assert_eq!(paused.players[0].ground.len,0);assert!(!paused.players[1].hand.contains(enemy_draw));assert_eq!((paused.attack_source,paused.attack_defender),(attacker,defender));
    let done=named_button(&e,&paused,"Trigger");assert!(done.players[0].hand.contains(own_draw));assert!(done.players[1].hand.contains(enemy_draw));assert_eq!(done.players[0].ground.len,1);assert_eq!(done.death_depth,0);
}
#[test]
fn defense_synthetic_return_redirects_live_overwhelm_without_admitting_hidden_card() {
    for overwhelm in [false,true] {for priority in ["You","Opponent"] {let mut e=engine();let mut s=board(&e);let attacker=unit(&e,&mut s,Seat::P2,"LOF_256");let defender=unit(&e,&mut s,Seat::P1,"LOF_254");let base=s.players[0].base;let power=e.power(&s,attacker,false);
        if overwhelm {e.definitions[s.card(attacker).def as usize].flags|=OVERWHELM;}
        death_program(&mut e,&s,defender,json!({"trigger":"onDefense","title":"SYNTHETIC return self","effect":{"kind":"returnToHand","target":"self"}}));death_program(&mut e,&s,attacker,json!({"trigger":"onAttack","title":"SYNTHETIC live power boost","effect":{"kind":"modifyStats","target":"self","duration":"phase","power":{"kind":"const","value":2},"hp":{"kind":"const","value":0}}}));
        let started=declaration(&e,s,attacker,defender);assert_eq!(started.decision,Decision::DeathPlayer);let done=named_button(&e,&started,priority);assert!(done.players[0].hand.contains(defender));assert_eq!(done.card(defender).damage,0);assert_eq!(done.card(base).damage,if overwhelm {power+2}else{0});assert_eq!(done.attack_source,0);assert_eq!(done.death_depth,0);
    }}
}

#[test]
fn hidden_live_qualification_and_numeric_storage_are_separate() {
    let mut e=engine();let mut s=board(&e);s.hidden_history_exact=true;
    let attacker=unit(&e,&mut s,Seat::P2,"LOF_256");let target=unit(&e,&mut s,Seat::P1,"LOF_254");
    s.card_mut(target).set_hidden_qualified(true);
    e.definitions[s.card(target).def as usize].flags|=1<<8;
    assert!(!e.attack_targets(&s,attacker,false).contains(&target));
    e.definitions[s.card(attacker).def as usize].flags|=SABOTEUR;assert!(!e.attack_targets(&s,attacker,false).contains(&target));
    s.card_mut(target).set_hidden_qualified(false);assert!(e.attack_targets(&s,attacker,false).contains(&target));
    s.card_mut(target).set_hidden_qualified(true);e.definitions[s.card(target).def as usize].flags|=SENTINEL;assert!(e.attack_targets(&s,attacker,false).contains(&target));
    s.source=target;
    for (keyword,amount) in [("raid",3),("restore",2),("hidden",1),("hidden",1)] {
        let effect:crate::ability_ir::Effect=serde_json::from_value(json!({"kind":"gainKeyword","target":"self","keyword":keyword,"amount":{"kind":"const","value":amount},"duration":"phase"})).unwrap();e.apply_effect(&mut s,&effect).unwrap();
    }
    assert_eq!(s.card(target).phase_keyword_values,[3,2]);assert_eq!(e.keyword_amount(&s,target,"hidden"),1);
    let snapshot=e.snapshot(&s);let restored=e.load_state(&snapshot).unwrap();assert_eq!(e.snapshot(&restored),snapshot);
    for bad in [json!(null),json!(false),json!(2),json!("1")] {let mut v=snapshot.clone();v["hiddenHistoryVersion"]=bad;assert!(e.load_state(&v).is_err());}
    let mut v=snapshot.clone();v["players"]["p1"]["ground"][0].as_object_mut().unwrap().remove("hiddenQualified");assert!(e.load_state(&v).is_err());
    let mut v=snapshot.clone();v.as_object_mut().unwrap().remove("hiddenHistoryVersion");assert!(e.load_state(&v).is_err());
    e.leave_play(&mut s,target).unwrap();assert!(!s.card(target).hidden_qualified());
    s.players[0].out=true;s.players[1].out=true;e.advance(&mut s).unwrap();assert!(!s.card(attacker).hidden_qualified());
    eprintln!("Hidden State bytes={}; Card bytes={}",std::mem::size_of::<State>(),std::mem::size_of::<Card>());
}

#[test]
fn legacy_hidden_guard_uses_selected_pool_and_rejects_both_modifier_masks() {
    let mut e=engine();let mut s=board(&e);unit(&e,&mut s,Seat::P1,"LOF_256");
    let mut v=e.snapshot(&s);v.as_object_mut().unwrap().remove("hiddenHistoryVersion");
    for seat in ["p1","p2"] {for arena in ["ground","space"] {for card in v["players"][seat][arena].as_array_mut().unwrap() {card.as_object_mut().unwrap().remove("hiddenQualified");}}}
    assert!(e.load_state(&v).unwrap_err().contains("requires explicit Hidden"));
    e.catalogue.as_mut().unwrap().metadata.retain(|code,_|["ASH_019","SOR_014","IBH_053","LOF_256"].contains(&code.as_str()));
    assert!(!e.needs_hidden_history());let legacy=e.load_state(&v).unwrap();assert!(!legacy.hidden_history_exact);assert_eq!(e.snapshot(&legacy),v);
    for (field,value) in [("phaseKeywords",json!({"hidden":1})),("phaseLostKeywords",json!(["hidden"]))] {let mut bad=v.clone();bad["players"]["p1"]["ground"][0][field]=value;assert!(e.load_state(&bad).is_err());}
    let mut bad=v.clone();bad["players"]["p1"]["ground"][0]["hiddenQualified"]=json!(false);assert!(e.load_state(&bad).is_err());
}

#[test]
fn hidden_history_hash_preserves_arena_evidence_and_normalizes_inert_departures() {
    let e=engine();let mut s=board(&e);let leader=s.players[0].leader;
    s.card_mut(leader).deployed=true;s.card_mut(leader).epic_used=true;s.card_mut(leader).set_hidden_qualified(true);e.add_arena(&mut s,leader).unwrap();
    let v=e.snapshot(&s);assert_eq!(e.load_state(&v).unwrap().zobrist(),s.zobrist());
    let mut changed=s;changed.card_mut(leader).set_hidden_qualified(false);assert_ne!(changed.zobrist(),s.zobrist());
    e.defeat(&mut s,leader).unwrap();assert!(s.card(leader).hidden_qualified());
    let v=e.snapshot(&s);let restored=e.load_state(&v).unwrap();assert!(!restored.card(leader).hidden_qualified());assert_eq!(restored.zobrist(),s.zobrist());
    let token=unit(&e,&mut s,Seat::P1,"TOKEN_CLONE_TROOPER");s.card_mut(token).set_hidden_qualified(true);e.defeat(&mut s,token).unwrap();assert!(s.card(token).hidden_qualified());let hash=s.zobrist();s.card_mut(token).set_hidden_qualified(false);assert_eq!(hash,s.zobrist());
}

fn arena_keyword_ability(trigger:&str,kind:&str,keyword:&str,receiver:&str)->Value {
    let mut effect=json!({"kind":kind,"target":{"kind":"arenaList","receiver":{"kind":"ref","path":[receiver]},"predicate":{"kind":"const","value":true}},"keyword":keyword,"duration":"phase"});
    if kind=="gainKeyword" {effect["amount"]=json!({"kind":"const","value":if keyword=="raid" {2}else{1}});}
    json!({"trigger":trigger,"title":"SYNTHETIC arena keyword","effect":effect})
}
#[test]
fn scalar_arena_keyword_predecessors_remain_admitted() {
    let e=engine();for code in ["SOR_154","TS26_016","LOF_209"] {assert!(e.by_code.contains_key(code),"{code}: {:?}",e.rejected_cards().unwrap().get(code));}
    eprintln!("Arena keyword State bytes={}",std::mem::size_of::<State>());
}
#[test]
fn scalar_arena_keyword_shapes_reject_nested_constant_selected_conditional_and_grouped_effects() {
    let valid=arena_keyword_ability("event","gainKeyword","raid","player");
    for trigger in ["event","whenPlayed"] {let mut v=valid.clone();v["trigger"]=json!(trigger);let a:crate::ability_ir::Ability=serde_json::from_value(v).unwrap();crate::ability_ir::Program::compile(&a).unwrap();}
    let mut bad=Vec::new();for trigger in ["onAttack","onDefense","whenDefeated","action","constant"] {let mut v=valid.clone();v["trigger"]=json!(trigger);bad.push(v);}
    for (key,value) in [("optional",json!(true)),("coordinate",json!(true)),("condition",json!({"kind":"const","value":true})),("targetResolver",json!({"owner":"self","type":"unit","zone":"arena"}))] {let mut v=valid.clone();v[key]=value;bad.push(v);}
    for key in ["then","ifYouDo"] {let mut v=valid.clone();v[key]=json!({"title":"Draw","effect":{"kind":"draw","target":"ownPlayer","amount":{"kind":"const","value":1}}});bad.push(v);let mut nested=valid.clone();nested["effect"]=json!({"kind":"draw","target":"ownPlayer","amount":{"kind":"const","value":1}});let mut next=valid.clone();next.as_object_mut().unwrap().remove("trigger");nested[key]=next;bad.push(nested);}
    for kind in ["simultaneous","phaseModifiers","sequence"] {let mut v=valid.clone();v["effect"]=json!({"kind":kind,"effects":[valid["effect"].clone()]});bad.push(v);}
    let mut v=valid.clone();v["effect"]["duration"]=json!("persistent");bad.push(v);
    let mut v=valid.clone();v["effect"]["amount"]=json!({"kind":"ref","path":["source","damage"]});bad.push(v);
    let mut v=valid.clone();v["effect"]["target"]["receiver"]=json!({"kind":"ref","path":["source"]});bad.push(v);
    let mut v=valid.clone();v["effect"]["target"]["predicate"]=json!({"kind":"query","name":"hasSomeTrait","receiver":{"kind":"ref","path":["card"]},"args":[{"kind":"const","value":"jedi"}]});bad.push(v);
    let mut v=arena_keyword_ability("event","gainKeyword","restore","game");v["effect"]["amount"]=json!({"kind":"const","value":0});bad.push(v);
    let mut v=arena_keyword_ability("event","gainKeyword","sentinel","game");v["effect"]["amount"]=json!({"kind":"const","value":2});bad.push(v);
    for v in bad {let a:crate::ability_ir::Ability=serde_json::from_value(v.clone()).unwrap();assert!(crate::ability_ir::Program::compile(&a).is_err(),"{v}");}
}
#[test]
fn arena_keywords_snapshot_full_domain_stack_and_exclude_later_entries() {
    let mut e=engine();let mut s=board(&e);let source=add(&e,&mut s,Seat::P1,"SOR_154");s.source=source;
    let mut own=Vec::new();for _ in 0..40 {own.push(unit(&e,&mut s,Seat::P1,"LOF_256"));}let enemy=unit(&e,&mut s,Seat::P2,"LOF_256");
    let a:crate::ability_ir::Ability=serde_json::from_value(arena_keyword_ability("event","gainKeyword","raid","player")).unwrap();
    assert_eq!(e.apply_effect(&mut s,&a.effect).unwrap(),(40,true));for &id in &own {assert_eq!(e.keyword_amount(&s,id,"raid"),2);}assert_eq!(e.keyword_amount(&s,enemy,"raid"),0);
    e.apply_effect(&mut s,&a.effect).unwrap();for &id in &own {assert_eq!(e.keyword_amount(&s,id,"raid"),4);}
    let newcomer=unit(&e,&mut s,Seat::P1,"LOF_256");assert_eq!(e.keyword_amount(&s,newcomer,"raid"),0);
    e.leave_play(&mut s,own[0]).unwrap();assert_eq!(e.keyword_amount(&s,own[0],"raid"),0);
    let token=unit(&e,&mut s,Seat::P1,"TOKEN_CLONE_TROOPER");let leader=s.players[1].leader;s.card_mut(leader).deployed=true;e.add_arena(&mut s,leader).unwrap();
    let shield=add(&e,&mut s,Seat::P1,"TOKEN_SHIELD");e.attach(&mut s,shield,newcomer);
    let a:crate::ability_ir::Ability=serde_json::from_value(arena_keyword_ability("whenPlayed","gainKeyword","restore","game")).unwrap();assert_eq!(e.apply_effect(&mut s,&a.effect).unwrap(),(43,true));assert_eq!(e.keyword_amount(&s,token,"restore"),1);assert_eq!(e.keyword_amount(&s,leader,"restore"),1);assert_eq!(s.card(shield).phase_keyword_mask(),0);assert_eq!(e.keyword_amount(&s,enemy,"restore"),1);assert_eq!(e.keyword_amount(&s,newcomer,"restore"),1);
    let a:crate::ability_ir::Ability=serde_json::from_value(arena_keyword_ability("whenPlayed","loseKeyword","hidden","opponent")).unwrap();e.definitions[s.card(enemy).def as usize].flags|=1<<8;e.apply_effect(&mut s,&a.effect).unwrap();assert_eq!(e.keyword_amount(&s,enemy,"hidden"),0);assert_eq!(s.card(newcomer).lost_keyword_mask()&(1<<8),0);
    s.players[0].out=true;s.players[1].out=true;e.advance(&mut s).unwrap();for id in own.into_iter().chain([enemy,newcomer]) {assert_eq!(s.card(id).phase_keyword_mask(),0);assert_eq!(s.card(id).lost_keyword_mask(),0);}
}

#[test]
fn actual_rallying_cry_empty_confirmation_and_capacity_failure_are_transactional() {
    let e=engine();let mut s=board(&e);let event=hand(&e,&mut s,"SOR_154");let play=e.card_action(&s,event);
    assert!(e.legal_actions(&s).contains(&play));let prompt=e.apply(&s,&play).unwrap();assert_eq!(prompt.decision,Decision::AbilityNoEffect);assert!(prompt.players[0].hand.contains(event));assert!(prompt.players[0].resources.as_slice().iter().all(|id|!prompt.card(*id).exhausted));
    let actions=e.legal_actions(&prompt);assert_eq!(actions,vec![Action::button("Play anyway",0),Action::button("Cancel",1)]);
    let declined=named_button(&e,&prompt,"Cancel");assert_eq!(declined.zobrist(),s.zobrist());
    let cost=e.cost(&s,event);let confirmed=named_button(&e,&prompt,"Play anyway");assert!(confirmed.players[0].discard.contains(event));assert!(!confirmed.players[0].hand.contains(event));assert_eq!(confirmed.players[0].resources.as_slice().iter().filter(|id|confirmed.card(**id).exhausted).count(),cost as usize);
    let first=unit(&e,&mut s,Seat::P1,"LOF_256");let overflow=unit(&e,&mut s,Seat::P1,"LOF_256");let printed=e.power(&s,overflow,false);s.card_mut(overflow).phase_keyword_values[0]=65535-printed;s.card_mut(overflow).add_phase_keyword(6);
    assert!(e.legal_actions(&s).contains(&play));let before=s.zobrist();assert!(e.apply(&s,&play).is_err());assert_eq!(s.zobrist(),before);assert_eq!(e.keyword_amount(&s,first,"raid"),0);assert!(s.players[0].hand.contains(event));assert!(s.players[0].resources.as_slice().iter().all(|id|!s.card(*id).exhausted));
}

#[test]
fn actual_when_played_lists_include_the_entering_unit_and_skip_empty_enemy_trigger() {
    let e=engine();
    for code in ["TS26_016","LOF_209"] {let mut s=board(&e);let source=hand(&e,&mut s,code);let played=e.apply(&s,&e.card_action(&s,source)).unwrap();assert!(played.players[0].ground.contains(source));assert!(played.card(source).hidden_qualified());assert_eq!(played.decision,Decision::Window);assert_eq!(played.active,Seat::P2);
        if code=="TS26_016" {assert_eq!(e.keyword_amount(&played,source,"restore"),1);}else{assert_eq!(e.keyword_amount(&played,source,"raid"),2);assert_eq!(played.card(source).lost_keyword_mask()&(1<<8),0);}
    }
}

#[test]
fn named_two_admission_preserves_other_descriptor_rejections() {
    let e=engine();for code in ["HMW_255","JTL_253"] {assert!(e.by_code.contains_key(code),"{code}: {:?}",e.rejected_cards().unwrap().get(code));}
    for code in ["HMW_263","LAW_099","TWI_238"] {assert!(e.by_code.contains_key(code),"{code}");}
    for code in ["LOF_054","TWI_156","TWI_171","TWI_249"] {assert!(!e.by_code.contains_key(code),"{code}");}
    assert_eq!(std::mem::size_of::<State>(),19112);
}
#[test]
fn actual_named_event_prepares_both_choices_before_costs_and_effects() {
    let e=engine();let mut s=board(&e);let ground=unit(&e,&mut s,Seat::P2,"LOF_256");let space=unit(&e,&mut s,Seat::P2,"ASH_201");let event=hand(&e,&mut s,"JTL_253");
    let base_power=e.power(&s,ground,false);let base_space=e.power(&s,space,false);
    let prompt=e.apply(&s,&e.card_action(&s,event)).unwrap();assert_eq!(prompt.decision,Decision::AbilityTarget);assert!(prompt.players[0].hand.contains(event));
    let buttons=e.legal_actions(&prompt).into_iter().filter(|a|a.id().is_none()).collect::<Vec<_>>();assert_eq!(buttons,vec![Action::button("Choose nothing","done"),Action::button("Cancel","cancel")]);
    let next=e.apply(&prompt,&e.card_action(&prompt,ground)).unwrap();assert_eq!(next.decision,Decision::AbilityTarget);assert!(next.players[0].hand.contains(event));assert_eq!(e.power(&next,ground,false),base_power);assert!(next.players[0].resources.as_slice().iter().all(|id|!next.card(*id).exhausted));
    let resolved=e.apply(&next,&e.card_action(&next,space)).unwrap();assert!(resolved.players[0].discard.contains(event));assert_eq!(e.power(&resolved,ground,false),base_power+2);assert_eq!(e.power(&resolved,space,false),base_space+2);assert_eq!(resolved.decision,Decision::Window);
    let cancelled=named_button(&e,&next,"Cancel");assert_eq!(cancelled.zobrist(),s.zobrist());
    let first_declined=named_button(&e,&prompt,"Choose nothing");let both_declined=named_button(&e,&first_declined,"Choose nothing");assert!(both_declined.players[0].discard.contains(event));assert_eq!(both_declined.decision,Decision::Window);assert_eq!(e.power(&both_declined,ground,false),base_power);
}
#[test]
fn actual_named_event_missing_first_delays_remaining_until_paid_and_all_missing_confirms() {
    let e=engine();let mut s=board(&e);let space=unit(&e,&mut s,Seat::P2,"ASH_201");let event=hand(&e,&mut s,"JTL_253");
    let prompt=e.apply(&s,&e.card_action(&s,event)).unwrap();assert_eq!(prompt.decision,Decision::AbilityTarget);assert!(prompt.players[0].discard.contains(event));assert!(!e.legal_actions(&prompt).iter().any(|a|a.label=="Cancel"));assert!(e.legal_actions(&prompt).contains(&e.card_action(&prompt,space)));
    let skipped=named_button(&e,&prompt,"Choose nothing");assert_eq!(skipped.decision,Decision::Window);
    let mut empty=board(&e);let event=hand(&e,&mut empty,"JTL_253");let prompt=e.apply(&empty,&e.card_action(&empty,event)).unwrap();assert_eq!(prompt.decision,Decision::AbilityNoEffect);assert_eq!(named_button(&e,&prompt,"Cancel").zobrist(),empty.zobrist());assert!(named_button(&e,&prompt,"Play anyway").players[0].discard.contains(event));
    let mut ground_only=board(&e);unit(&e,&mut ground_only,Seat::P2,"LOF_256");let event=hand(&e,&mut ground_only,"JTL_253");let prompt=e.apply(&ground_only,&e.card_action(&ground_only,event)).unwrap();let skipped=named_button(&e,&prompt,"Choose nothing");assert_eq!(skipped.decision,Decision::Window);assert!(skipped.players[0].discard.contains(event));
}
#[test]
fn actual_c3po_without_ewok_still_selects_its_entering_rebel_source() {
    let e=engine();let mut s=board(&e);let source=hand(&e,&mut s,"HMW_255");let prompt=e.apply(&s,&e.card_action(&s,source)).unwrap();assert_eq!(prompt.decision,Decision::AbilityTarget);assert!(prompt.players[0].ground.contains(source));assert!(e.legal_actions(&prompt).contains(&e.card_action(&prompt,source)));assert!(!e.legal_actions(&prompt).iter().any(|a|a.label=="Cancel"));
    let power=e.power(&prompt,source,false);let resolved=e.apply(&prompt,&e.card_action(&prompt,source)).unwrap();assert_eq!(e.power(&resolved,source,false),power+2);assert_eq!(resolved.decision,Decision::Window);
}

#[test]
fn named_descriptors_fail_closed_for_dependencies_duplicates_and_other_systems() {
    let catalogue:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();let card=catalogue["cards"].as_array().unwrap().iter().find(|v|v["setCode"]=="JTL_253").unwrap();let valid=card["abilities"]["card"][0].clone();
    let compile=|v:Value|->bool {serde_json::from_value::<crate::ability_ir::Ability>(v).ok().is_some_and(|a|crate::ability_ir::Program::compile(&a).is_ok())};assert!(compile(valid.clone()));
    let mut invalid=Vec::new();
    for name in ["","target","groundUnit","bad.name"] {let mut v=valid.clone();v["targetResolvers"][1]["name"]=json!(name);invalid.push(v);}
    for (key,value) in [("chooser",json!("opponent")),("bogus",json!(true))] {let mut v=valid.clone();v["targetResolvers"][0][key]=value;invalid.push(v);}
    for (key,value) in [("owner",json!("self")),("optional",json!(false)),("type",json!("base")),("zone",json!("discard")),("mode",json!("upTo"))] {let mut v=valid.clone();v["targetResolvers"][0]["targetResolver"][key]=value;invalid.push(v);}
    let mut attack=valid.clone();attack["trigger"]=json!("onAttack");assert!(compile(attack));
    for trigger in ["onDefense","action","whenDefeated","constant"] {let mut v=valid.clone();v["trigger"]=json!(trigger);invalid.push(v);}
    for (key,value) in [("optional",json!(true)),("condition",json!({"kind":"const","value":true})),("costs",json!([{"kind":"exhaustSelf"}])),("targetResolver",json!({"type":"unit","zone":"arena"}))] {let mut v=valid.clone();v[key]=value;invalid.push(v);}
    let mut v=valid.clone();v["targetResolvers"][0]["effect"]["power"]=json!({"kind":"ref","path":["source","damage"]});invalid.push(v);
    let mut v=valid.clone();v["targetResolvers"][0]["effect"]["target"]=json!({"kind":"ref","path":["targets","spaceUnit"]});invalid.push(v);
    let mut v=valid.clone();v["targetResolvers"][0]["effect"]=json!({"kind":"damage","amount":{"kind":"const","value":2},"target":"chosen"});invalid.push(v);
    for key in ["then","ifYouDo"] {let mut v=valid.clone();v[key]=json!({"title":"No action","effect":{"kind":"noAction"}});invalid.push(v);let mut nested=valid.clone();nested.as_object_mut().unwrap().remove("trigger");invalid.push(json!({"trigger":"event","title":"Nested","effect":{"kind":"noAction"},key:nested}));}
    for v in invalid {assert!(!compile(v.clone()),"{v}");}
    // promptTitle alone must not silently widen ordinary resolver admission.
    assert!(!compile(json!({"trigger":"event","title":"Ordinary","targetResolver":{"type":"unit","zone":"arena","promptTitle":"Unexpected"},"effect":{"kind":"modifyStats","target":"chosen","duration":"phase","power":{"kind":"const","value":2},"hp":{"kind":"const","value":2}}})));
}
#[test]
fn synthetic_overlapping_named_traits_retain_two_same_recipient_events_and_phase_expiry() {
    let mut e=engine();let mut s=board(&e);let other=unit(&e,&mut s,Seat::P2,"LOF_256");e.definitions[s.card(other).def as usize].traits=vec!["ewok".into(),"rebel".into()];
    let source=hand(&e,&mut s,"HMW_255");let prompt=e.apply(&s,&e.card_action(&s,source)).unwrap();let next=e.apply(&prompt,&e.card_action(&prompt,other)).unwrap();assert_eq!(next.card(other).phase_power,0);let resolved=e.apply(&next,&e.card_action(&next,other)).unwrap();assert_eq!(resolved.card(other).phase_power,4);assert_eq!(resolved.card(other).phase_hp,4);assert_eq!(resolved.card(source).phase_power,0);
    let mut expired=resolved;expired.players[0].out=true;expired.players[1].out=true;e.advance(&mut expired).unwrap();assert_eq!(expired.card(other).phase_power,0);assert_eq!(expired.card(other).phase_hp,0);
}
#[test]
fn named_descriptor_catalogue_sources_exclude_leaders_tokens_and_upgrades() {
    let original:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();let template=original["cards"].as_array().unwrap().iter().find(|v|v["setCode"]=="HMW_255").unwrap();
    for base_class in ["LeaderCard","UpgradeCard","TokenUnitCard","BaseCard"] {let mut entry=template.clone();entry["baseClass"]=json!(base_class);let catalogue=json!({"schema":original["schema"],"cards":[entry]});let loaded=crate::ability_ir::Catalogue::load(&catalogue).unwrap();assert!(loaded.rejected.contains_key("HMW_255"),"{base_class}");}
    for types in [json!([]),json!(["leader","unit"]),json!(["upgrade"]),json!(["base"]),json!(["event"]),json!(["unit","event"])] {let mut entry=template.clone();entry["card"]["types"]=types;let loaded=crate::ability_ir::Catalogue::load(&json!({"schema":original["schema"],"cards":[entry]})).unwrap();assert!(loaded.rejected.contains_key("HMW_255"));}
    let event=original["cards"].as_array().unwrap().iter().find(|v|v["setCode"]=="JTL_253").unwrap();for types in [json!(["unit"]),json!(["event","leader"]),json!([])] {let mut entry=event.clone();entry["card"]["types"]=types;let loaded=crate::ability_ir::Catalogue::load(&json!({"schema":original["schema"],"cards":[entry]})).unwrap();assert!(loaded.rejected.contains_key("JTL_253"));}
    let mut entry=template.clone();entry["card"]["types"]=json!(["unit","token"]);let loaded=crate::ability_ir::Catalogue::load(&json!({"schema":original["schema"],"cards":[entry]})).unwrap();assert!(loaded.rejected.contains_key("HMW_255"));
    for side in ["leader","unit"] {let mut entry=template.clone();let ability=entry["abilities"]["card"][0].clone();entry["abilities"]["card"]=json!([]);entry["abilities"][side]=json!([ability]);let loaded=crate::ability_ir::Catalogue::load(&json!({"schema":original["schema"],"cards":[entry]})).unwrap();assert!(loaded.rejected.contains_key("HMW_255"));}
}
fn weakness_effect()->crate::ability_ir::Effect {serde_json::from_value(json!({"kind":"giveWeakness","target":"chosen","amount":{"kind":"const","value":1}})).unwrap()}
#[test]
fn weakness_admission_is_three_sources_plus_one_reviewed_native_token() {
    let e=engine();for code in ["HMW_059","HMW_087","HMW_242","TOKEN_WEAKNESS"] {assert!(e.by_code.contains_key(code),"{code}: {:?}",e.rejected_cards().unwrap().get(code));}
    for code in ["HMW_065"] {assert!(!e.by_code.contains_key(code),"{code}");}
    assert_eq!(std::mem::size_of::<State>(),19112);assert_eq!(std::mem::size_of::<Card>(),36);
    let original:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();
    for (field,value) in [("power",json!(1)),("upgradeHp",json!(0)),("types",json!(["unit","token"])),("traits",json!([])),("aspects",json!(["heroism"])),("text",json!("Draw a card")),("unique",json!(true)),("cost",json!(1))] {let mut catalog=original.clone();let token=catalog["cards"].as_array_mut().unwrap().iter_mut().find(|c|c["setCode"]=="TOKEN_WEAKNESS").unwrap();token["card"][field]=value;let altered=Engine::from_catalogue_value(&catalog).unwrap();assert!(!altered.by_code.contains_key("TOKEN_WEAKNESS"),"{field}");}
    for (field,value) in [("keywordValues",json!({"hidden":1})),("abilities",json!({"leader":[],"unit":[],"card":[{"trigger":"whenPlayed","title":"Injected","effect":{"kind":"draw","target":"ownPlayer","amount":{"kind":"const","value":1}}}]}))] {let mut catalog=original.clone();let token=catalog["cards"].as_array_mut().unwrap().iter_mut().find(|c|c["setCode"]=="TOKEN_WEAKNESS").unwrap();token[field]=value;assert!(!Engine::from_catalogue_value(&catalog).unwrap().by_code.contains_key("TOKEN_WEAKNESS"));}
    let mut catalog=original.clone();catalog["cards"].as_array_mut().unwrap().iter_mut().find(|c|c["setCode"]=="TOKEN_WEAKNESS").unwrap()["sourceHash"]=json!("changed");assert!(!Engine::from_catalogue_value(&catalog).unwrap().by_code.contains_key("TOKEN_WEAKNESS"));
}
#[test]
fn weakness_signed_chain_stacks_without_experience_double_count_and_roundtrips() {
    let e=engine();let mut s=board(&e);let target=unit(&e,&mut s,Seat::P2,"LOF_256");s.source=s.players[0].leader;s.ability_target=target;let base_power=e.power(&s,target,false);let base_hp=e.hp(&s,target);
    e.create_token(&mut s,target,true).unwrap();e.create_token(&mut s,target,false).unwrap();let experience=s.card(target).experience;let shield=s.card(target).shield;
    let first=s.next_id;e.apply_effect(&mut s,&weakness_effect()).unwrap();let second=s.next_id;e.apply_effect(&mut s,&weakness_effect()).unwrap();
    assert_eq!(e.power(&s,target,false),base_power.saturating_sub(1));assert_eq!(e.hp(&s,target),base_hp-1);assert_eq!(s.card(target).experience,experience);assert_eq!(s.card(target).shield,shield);assert_eq!(e.token_count(&s,experience),1);assert_eq!(e.token_count(&s,shield),1);
    assert_eq!(e.upgrades(&s,target),vec![experience,shield,first,second]);for id in [first,second] {assert_eq!(s.card(id).owner,Seat::P2);assert_eq!(s.card(id).parent,target);assert_eq!(s.card(id).next_token,0);assert_eq!(e.def(&s,id).code,"TOKEN_WEAKNESS");}
    s.source=0;s.ability_target=0;let snapshot=e.snapshot(&s);let restored=e.load_state(&snapshot).unwrap();assert_eq!(e.snapshot(&restored),snapshot);assert_eq!(restored.zobrist(),s.zobrist());
    let mut bad=snapshot.clone();let upgrades=bad["players"]["p2"]["ground"][0]["upgrades"].as_array_mut().unwrap();upgrades[3]["id"]=upgrades[2]["id"].clone();assert!(e.load_state(&bad).is_err());
    e.leave_play(&mut s,first).unwrap();assert_eq!(e.hp(&s,target),base_hp);assert_eq!(e.power(&s,target,false),base_power);assert!(!s.players[1].discard.contains(first));assert_eq!(s.card(first).parent,0);assert_eq!(s.card(target).experience,experience);
}
#[test]
fn weakness_undamaged_hp_one_captures_defeat_before_negative_cleanup_and_never_resurrects() {
    let mut e=engine();let mut s=board(&e);let target=unit(&e,&mut s,Seat::P2,"ASH_213");assert_eq!(e.hp(&s,target),1);assert_eq!(s.card(target).damage,0);let drawn=deck_card(&e,&mut s,Seat::P2);death_program(&mut e,&s,target,draw_death(false));
    s.source=s.players[0].leader;s.ability_target=target;let token=s.next_id;e.apply_effect(&mut s,&weakness_effect()).unwrap();assert!(!e.in_arena(&s,target));assert!(s.players[1].discard.contains(target));assert_eq!(s.card(token).parent,0);assert!(!s.players[1].discard.contains(token));assert_eq!(s.death_pending.len,1);assert_eq!(s.death_pending.entries[0].source,target);
    e.finish(&mut s).unwrap();assert!(s.players[1].hand.contains(drawn));assert!(!e.in_arena(&s,target));assert_eq!(s.card(target).upgrades,0);
}
#[test]
fn actual_occupation_officer_resource_threshold_optional_decline_and_enemy_recipient() {
    let e=engine();for resources in [5,6] {let mut s=board(&e);let target=unit(&e,&mut s,Seat::P2,"LOF_256");let source=hand(&e,&mut s,"HMW_242");s.players[0].resources.len=resources;let played=e.apply(&s,&e.card_action(&s,source)).unwrap();
        if resources==5 {assert_eq!(played.decision,Decision::Window);assert_eq!(s.next_id,played.next_id);continue;}
        assert_eq!(played.decision,Decision::AbilityTarget);let declined=named_button(&e,&played,"Pass");assert_eq!(declined.next_id,played.next_id);
        let selected=played;assert!(e.legal_actions(&selected).contains(&e.card_action(&selected,target)));let token=selected.next_id;let resolved=e.apply(&selected,&e.card_action(&selected,target)).unwrap();assert_eq!(resolved.card(token).owner,Seat::P2);assert_eq!(resolved.card(token).parent,target);assert_eq!(e.hp(&resolved,target),e.hp(&played,target)-1);
    }
}
#[test]
fn actual_weakness_death_sources_preserve_owner_and_damaged_selector() {
    let e=engine();for code in ["HMW_059","HMW_087"] {let mut s=board(&e);let source=unit(&e,&mut s,Seat::P2,code);let healthy=unit(&e,&mut s,Seat::P1,"LOF_256");let damaged=unit(&e,&mut s,Seat::P1,"LOF_256");s.card_mut(damaged).damage=1;e.defeat(&mut s,source).unwrap();e.finish(&mut s).unwrap();assert_eq!(s.active,Seat::P2);assert_eq!(s.decision,Decision::AbilityTarget);let prompt=s;let actions=e.legal_actions(&prompt);assert!(actions.contains(&e.card_action(&prompt,damaged)));assert_eq!(actions.contains(&e.card_action(&prompt,healthy)),code=="HMW_059");let token=prompt.next_id;let resolved=e.apply(&prompt,&e.card_action(&prompt,damaged)).unwrap();assert_eq!(resolved.card(token).owner,Seat::P1);assert_eq!(resolved.card(token).parent,damaged);assert!(resolved.players[1].discard.contains(source));}
}
#[test]
fn weakness_raw_shapes_reject_arrays_groups_other_registrations_and_nonliteral_amounts() {
    let catalogue:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();let valid=catalogue["cards"].as_array().unwrap().iter().find(|c|c["setCode"]=="HMW_059").unwrap()["abilities"]["card"][0].clone();
    let compile=|v:Value|serde_json::from_value::<crate::ability_ir::Ability>(v).ok().is_some_and(|a|crate::ability_ir::Program::compile(&a).is_ok());assert!(compile(valid.clone()));let mut bad=Vec::new();
    for trigger in ["event","action","onAttack","onDefense","constant"] {let mut v=valid.clone();v["trigger"]=json!(trigger);bad.push(v);}
    for amount in [json!({"kind":"const","value":0}),json!({"kind":"const","value":2}),json!({"kind":"ref","path":["source","damage"]})] {let mut v=valid.clone();v["effect"]["amount"]=amount;bad.push(v);}
    for target in [json!("self"),json!("ownBase"),json!("bothPlayers"),json!({"kind":"arenaList","receiver":{"kind":"ref","path":["player"]},"predicate":{"kind":"const","value":true}})] {let mut v=valid.clone();v["effect"]["target"]=target;bad.push(v);}
    for kind in ["sequence","simultaneous","phaseModifiers"] {let mut v=valid.clone();v["effect"]=json!({"kind":kind,"effects":[valid["effect"].clone()]});bad.push(v);}
    for (key,value) in [("optional",json!(false)),("condition",json!({"kind":"const","value":true})),("costs",json!([{"kind":"exhaustSelf"}]))] {let mut v=valid.clone();v[key]=value;bad.push(v);}
    let mut v=valid.clone();v["targetResolver"]["mode"]=json!("upTo");v["targetResolver"]["count"]=json!({"kind":"const","value":2});bad.push(v);
    let mut v=valid.clone();v["targetResolver"]["type"]=json!("any");bad.push(v);
    let mut v=valid.clone();v["targetResolver"]["predicate"]=json!({"kind":"query","name":"hasSomeTrait","receiver":{"kind":"ref","path":["card"]},"args":[{"kind":"const","value":"jedi"}]});bad.push(v);
    for key in ["then","ifYouDo"] {let mut v=valid.clone();v[key]=json!({"title":"Draw","effect":{"kind":"draw","target":"ownPlayer","amount":{"kind":"const","value":1}}});bad.push(v);let mut nested=valid.clone();nested.as_object_mut().unwrap().remove("trigger");bad.push(json!({"trigger":"event","title":"Nested","effect":{"kind":"noAction"},key:nested}));}
    for v in bad {assert!(!compile(v.clone()),"{v}");}
    for base in ["UpgradeCard","LeaderCard","EventCard","TokenUnitCard"] {let mut entry=catalogue["cards"].as_array().unwrap().iter().find(|c|c["setCode"]=="HMW_059").unwrap().clone();entry["baseClass"]=json!(base);let loaded=crate::ability_ir::Catalogue::load(&json!({"schema":catalogue["schema"],"cards":[entry]})).unwrap();assert!(loaded.rejected.contains_key("HMW_059"));}
}
#[test]
fn weakness_targets_token_units_and_deployed_leaders_and_returns_to_outside() {
    let e=engine();let mut s=board(&e);let token_unit=unit(&e,&mut s,Seat::P2,"TOKEN_CLONE_TROOPER");let leader=s.players[1].leader;s.card_mut(leader).deployed=true;e.add_arena(&mut s,leader).unwrap();s.source=s.players[0].leader;
    for target in [token_unit,leader] {s.ability_target=target;let hp=e.hp(&s,target);let id=s.next_id;e.apply_effect(&mut s,&weakness_effect()).unwrap();assert_eq!(e.hp(&s,target),hp-1);assert_eq!(s.card(id).owner,Seat::P2);assert_eq!(s.card(id).parent,target);
        s.ability_target=id;let returned:crate::ability_ir::Effect=serde_json::from_value(json!({"kind":"returnToHand","target":"chosen"})).unwrap();e.apply_effect(&mut s,&returned).unwrap();assert_eq!(s.card(id).parent,0);assert!(!s.players[1].hand.contains(id));assert!(!s.players[1].discard.contains(id));assert_eq!(e.hp(&s,target),hp);
    }
}
#[test]
fn weakness_static_native_dependency_rejects_missing_invalid_and_unselected_token() {
    let original:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();
    for remove in [true,false] {let mut v=original.clone();if remove {v["cards"].as_array_mut().unwrap().retain(|c|c["setCode"]!="TOKEN_WEAKNESS");}else{v["cards"].as_array_mut().unwrap().iter_mut().find(|c|c["setCode"]=="TOKEN_WEAKNESS").unwrap()["card"]["title"]=json!("Unreviewed token");}let e=Engine::from_catalogue_value(&v).unwrap();for code in ["HMW_059","HMW_087","HMW_242"] {assert!(!e.by_code.contains_key(code));assert!(e.rejected_cards().unwrap()[code].contains("Weakness token unavailable"));}}
    let e=engine();let mut pool=e.compiled_pool().unwrap();pool["cards"].as_array_mut().unwrap().retain(|c|c["setCode"]!="TOKEN_WEAKNESS");assert!(Engine::from_compiled_pool_bytes(&serde_json::to_vec(&pool).unwrap(),include_bytes!("../../card-compiler/generated/catalog.json")).err().unwrap().contains("GiveWeakness cards must include"));
    pool["cards"].as_array_mut().unwrap().retain(|c|!["HMW_059","HMW_087","HMW_242","HMW_097","HMW_100","HMW_199","HMW_202","HMW_231"].contains(&c["setCode"].as_str().unwrap()));Engine::from_compiled_pool_bytes(&serde_json::to_vec(&pool).unwrap(),include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();
}
#[test]
fn arena_stat_filter_admission_is_exact_two_and_unary_plus_normalizes_only_here() {
    let e=engine();for code in ["HMW_111","LOF_127"] {assert!(e.by_code.contains_key(code),"{code}: {:?}",e.rejected_cards().unwrap().get(code));}
    let p=e.program(e.definitions[*e.by_code.get("HMW_111").unwrap() as usize].programs.card[0]);assert!(matches!(&p.instructions[0],Instruction::Apply(Effect::ModifyStats{power:Expr::Const{value:p},hp:Expr::Const{value:h},..}) if p==2&&h==2));
    let plus:Expr=serde_json::from_value(json!({"kind":"unary","op":"+","value":{"kind":"const","value":2}})).unwrap();assert!(plus.validate().is_err());assert_eq!(std::mem::size_of::<State>(),19112);
}
#[test]
fn actual_lander_excludes_entering_source_and_keeps_captured_both_arena_recipients() {
    let e=engine();let mut s=board(&e);let ground=unit(&e,&mut s,Seat::P1,"LOF_256");let space=unit(&e,&mut s,Seat::P1,"ASH_201");let enemy=unit(&e,&mut s,Seat::P2,"LOF_256");let token=unit(&e,&mut s,Seat::P1,"TOKEN_CLONE_TROOPER");let leader=s.players[0].leader;s.card_mut(leader).deployed=true;e.add_arena(&mut s,leader).unwrap();let shield=add(&e,&mut s,Seat::P1,"TOKEN_SHIELD");e.attach(&mut s,shield,ground);
    let source=hand(&e,&mut s,"HMW_111");for _ in 0..12 {let id=add(&e,&mut s,Seat::P1,"LOF_254");s.players[0].resources.push(id).unwrap();}let played=e.apply(&s,&e.card_action(&s,source)).unwrap();assert!(played.players[0].space.contains(source));assert_eq!(played.card(source).phase_power,0);assert_eq!(played.card(source).phase_hp,0);for id in [ground,space,token,leader] {assert_eq!(played.card(id).phase_power,2);assert_eq!(played.card(id).phase_hp,2);}assert_eq!(played.card(enemy).phase_power,0);assert_eq!(played.card(shield).phase_power,0);
    let mut after=played;e.leave_play(&mut after,source).unwrap();let newcomer=unit(&e,&mut after,Seat::P1,"LOF_256");assert_eq!(after.card(newcomer).phase_hp,0);assert_eq!(after.card(ground).phase_hp,2);
    e.leave_play(&mut after,ground).unwrap();after.players[0].discard.remove(ground);e.add_arena(&mut after,ground).unwrap();assert_eq!(after.card(ground).phase_hp,0);assert_eq!(after.card(space).phase_hp,2);
    after.players[0].out=true;after.players[1].out=true;e.advance(&mut after).unwrap();assert_eq!(after.card(space).phase_hp,0);assert_eq!(after.card(token).phase_power,0);
    let mut empty=board(&e);let source=hand(&e,&mut empty,"HMW_111");for _ in 0..12 {let id=add(&e,&mut empty,Seat::P1,"LOF_254");empty.players[0].resources.push(id).unwrap();}let played=e.apply(&empty,&e.card_action(&empty,source)).unwrap();assert_eq!(played.decision,Decision::Window);assert!(played.players[0].space.contains(source));assert_eq!(played.card(source).phase_hp,0);
}
#[test]
fn actual_rampage_static_traits_snapshot_beast_owner_and_empty_cost_confirmation() {
    let e=engine();let mut s=board(&e);let ground=unit(&e,&mut s,Seat::P1,"ASH_131");let space=unit(&e,&mut s,Seat::P1,"LOF_119");let beast=unit(&e,&mut s,Seat::P1,"TOKEN_BEAST");let enemy=unit(&e,&mut s,Seat::P2,"ASH_131");let other=unit(&e,&mut s,Seat::P1,"LOF_256");let event=hand(&e,&mut s,"LOF_127");for _ in 0..12 {let id=add(&e,&mut s,Seat::P1,"LOF_254");s.players[0].resources.push(id).unwrap();}let resolved=e.apply(&s,&e.card_action(&s,event)).unwrap();for id in [ground,space,beast] {assert_eq!(resolved.card(id).phase_power,2);assert_eq!(resolved.card(id).phase_hp,2);}for id in [enemy,other] {assert_eq!(resolved.card(id).phase_hp,0);}
    let mut stack=resolved;let second=add(&e,&mut stack,Seat::P1,"LOF_127");stack.players[0].hand.push(second).unwrap();stack.active=Seat::P1;stack.action_player=Some(Seat::P1);let stacked=e.apply(&stack,&e.card_action(&stack,second)).unwrap();assert_eq!(stacked.card(beast).phase_hp,4);
    let mut empty=board(&e);unit(&e,&mut empty,Seat::P2,"ASH_131");unit(&e,&mut empty,Seat::P1,"LOF_256");let event=hand(&e,&mut empty,"LOF_127");let prompt=e.apply(&empty,&e.card_action(&empty,event)).unwrap();assert_eq!(prompt.decision,Decision::AbilityNoEffect);assert_eq!(named_button(&e,&prompt,"Cancel").zobrist(),empty.zobrist());let paid=named_button(&e,&prompt,"Play anyway");assert!(paid.players[0].discard.contains(event));assert_eq!(paid.decision,Decision::Window);
}
#[test]
fn arena_stat_filter_guards_do_not_widen_defeat_keywords_or_nested_registrations() {
    let catalog:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();let valid=catalog["cards"].as_array().unwrap().iter().find(|c|c["setCode"]=="LOF_127").unwrap()["abilities"]["card"][0].clone();let compile=|v:Value|serde_json::from_value::<crate::ability_ir::Ability>(v).ok().is_some_and(|a|crate::ability_ir::Program::compile(&a).is_ok());assert!(compile(valid.clone()));let mut bad=Vec::new();
    for trigger in ["onAttack","onDefense","action","whenDefeated","constant"] {let mut v=valid.clone();v["trigger"]=json!(trigger);bad.push(v);}
    for (key,value) in [("optional",json!(true)),("coordinate",json!(true)),("condition",json!({"kind":"const","value":true})),("costs",json!([{"kind":"exhaustSelf"}])),("targetResolver",json!({"type":"unit","zone":"arena"})),("contextTitle",json!([{"kind":"const","value":"Dynamic"}]))] {let mut v=valid.clone();v[key]=value;bad.push(v);}
    for key in ["then","ifYouDo"] {let mut v=valid.clone();v[key]=json!({"title":"Draw","effect":{"kind":"draw","target":"ownPlayer","amount":{"kind":"const","value":1}}});bad.push(v);let mut nested=valid.clone();nested.as_object_mut().unwrap().remove("trigger");bad.push(json!({"trigger":"event","title":"Nested","effect":{"kind":"noAction"},key:nested}));}
    for kind in ["sequence","simultaneous","phaseModifiers"] {let mut v=valid.clone();v["effect"]=json!({"kind":kind,"effects":[valid["effect"].clone()]});bad.push(v);}
    for receiver in ["game","source","target"] {let mut v=valid.clone();v["effect"]["target"]["receiver"]=json!({"kind":"ref","path":[receiver]});bad.push(v);}
    let mut v=valid.clone();v["effect"]["target"]["predicate"]["right"]["receiver"]=json!({"kind":"ref","path":["source"]});bad.push(v);
    let mut v=valid.clone();v["effect"]["target"]["predicate"]["right"]["args"]=json!([{ "kind":"ref","path":["source","title"]}]);bad.push(v);
    for kind in ["defeat","gainKeyword","loseKeyword"] {let mut v=valid.clone();v["effect"]=json!({"kind":kind,"target":valid["effect"]["target"]});if kind!="defeat" {v["effect"]["duration"]=json!("phase");v["effect"]["keyword"]=json!("hidden");if kind=="gainKeyword" {v["effect"]["amount"]=json!({"kind":"const","value":1});}}bad.push(v);}
    for v in bad {assert!(!compile(v.clone()),"{v}");}
}
#[test]
fn arena_stat_filter_source_domains_and_malformed_exclusions_reject() {
    let original:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();let lander=original["cards"].as_array().unwrap().iter().find(|c|c["setCode"]=="HMW_111").unwrap();
    for (field,value) in [("baseClass",json!("LeaderCard")),("baseClass",json!("TokenUnitCard")),("types",json!(["unit","leader"])),("types",json!(["event"])),("types",json!(["unit","token"]))] {let mut entry=lander.clone();if field=="types" {entry["card"][field]=value;}else{entry[field]=value;}let c=crate::ability_ir::Catalogue::load(&json!({"schema":original["schema"],"cards":[entry]})).unwrap();assert!(c.rejected.contains_key("HMW_111"));}
    for side in ["unit","leader"] {let mut entry=lander.clone();entry["abilities"][side]=entry["abilities"]["card"].clone();entry["abilities"]["card"]=json!([]);let c=crate::ability_ir::Catalogue::load(&json!({"schema":original["schema"],"cards":[entry]})).unwrap();assert!(c.rejected.contains_key("HMW_111"));}
    let rampage=original["cards"].as_array().unwrap().iter().find(|c|c["setCode"]=="LOF_127").unwrap();let mut entry=rampage.clone();entry["card"]["types"]=json!(["unit"]);assert!(crate::ability_ir::Catalogue::load(&json!({"schema":original["schema"],"cards":[entry]})).unwrap().rejected.contains_key("LOF_127"));
    let valid=lander["abilities"]["card"][0].clone();let mut bad=Vec::new();let mut v=valid.clone();v["effect"]["target"]["predicate"]["right"]["right"]["right"]=json!({"kind":"ref","path":["target"]});bad.push(v);let mut v=valid.clone();v["effect"]["target"]["predicate"]=json!({"kind":"unary","op":"!","value":{"kind":"ref","path":["source"]}});bad.push(v);let mut v=valid.clone();v["effect"]["power"]["value"]=json!({"kind":"ref","path":["source","damage"]});bad.push(v);
    for v in bad {let a:crate::ability_ir::Ability=serde_json::from_value(v.clone()).unwrap();assert!(crate::ability_ir::Program::compile(&a).is_err(),"{v}");}
}

#[test]
fn force_scalar_lifecycle_preserves_identity_and_player_independence() {
 let e=engine(); let mut s=board(&e); s.source=s.players[0].leader;
 let ids=[s.players[0].force_id,s.players[1].force_id];let next=s.next_id;
 let gain=crate::ability_ir::Effect::GainForce{target:crate::ability_ir::Target::Name("ownPlayer".into())};let use_force=crate::ability_ir::Effect::UseForce{target:crate::ability_ir::Target::Name("ownPlayer".into())};
 e.apply_effect(&mut s,&gain).unwrap();assert!(s.players[0].force_held);assert!(!s.players[1].force_held);
 e.apply_effect(&mut s,&gain).unwrap();e.apply_effect(&mut s,&use_force).unwrap();assert!(!s.players[0].force_held);e.apply_effect(&mut s,&gain).unwrap();
 assert_eq!([s.players[0].force_id,s.players[1].force_id],ids);assert_eq!(s.next_id,next);
 s.source=0;let snapshot=e.snapshot(&s);let restored=e.load_state(&snapshot).unwrap();assert_eq!(restored.zobrist(),s.zobrist());assert_eq!(e.snapshot(&restored),snapshot);
}
#[test]
fn force_version_ids_and_selected_native_are_strict() {
 let mut e=engine();let s=board(&e);let snapshot=e.snapshot(&s);
 for value in [json!(null),json!(0),json!(true),json!("1")] {let mut bad=snapshot.clone();bad["forceStateVersion"]=value;assert!(e.load_state(&bad).is_err());}
 let mut bad=snapshot.clone();bad["players"]["p1"]["forceToken"]["id"]=snapshot["players"]["p1"]["base"]["id"].clone();assert!(e.load_state(&bad).is_err());
 e.catalogue.as_mut().unwrap().metadata.retain(|code,_|["ASH_019","SOR_014","IBH_053"].contains(&code.as_str()));assert!(e.load_state(&snapshot).is_ok());
 let mut held=snapshot.clone();held["players"]["p1"]["forceToken"]["held"]=json!(true);assert!(e.load_state(&held).unwrap_err().contains("selected native"));
 let mut legacy=snapshot.clone();legacy.as_object_mut().unwrap().remove("forceStateVersion");for seat in ["p1","p2"]{legacy["players"][seat].as_object_mut().unwrap().remove("forceToken");}assert!(e.load_state(&legacy).is_ok());
}
#[test]
fn force_native_identity_pin_and_static_dependencies_fail_closed() {
 let original:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();
 for field in ["title","types","text","cost"] {let mut c=original.clone();let token=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]=="TOKEN_THE_FORCE").unwrap();token["card"][field]=json!("altered");let e=Engine::from_catalogue_value(&c).unwrap();for code in ["TOKEN_THE_FORCE","LOF_146","LOF_193","LOF_195"]{assert!(!e.by_code.contains_key(code),"{field} {code}");}}
 let mut c=original.clone();c["cards"].as_array_mut().unwrap().retain(|v|v["setCode"]!="TOKEN_THE_FORCE");let e=Engine::from_catalogue_value(&c).unwrap();for code in ["LOF_146","LOF_193","LOF_195"]{assert!(!e.by_code.contains_key(code));}
 let e=engine();let mut legacy=e.snapshot(&board(&e));legacy.as_object_mut().unwrap().remove("forceStateVersion");for seat in ["p1","p2"]{legacy["players"][seat].as_object_mut().unwrap().remove("forceToken");}assert!(e.load_state(&legacy).unwrap_err().contains("Force"));
}
#[test]
fn force_exact_state_hash_distinguishes_held_identity_and_rejects_malformed_rows() {
 let e=engine();let s=board(&e);let value=e.snapshot(&s);let mut held=s;held.players[0].force_held=true;assert_ne!(s.zobrist(),held.zobrist());let mut identity=s;identity.players[0].force_id=s.players[1].force_id;assert_ne!(s.zobrist(),identity.zobrist());
 for field in ["id","held"]{let mut bad=value.clone();bad["players"]["p1"]["forceToken"].as_object_mut().unwrap().remove(field);assert!(e.load_state(&bad).is_err());}
 for id in [json!("c9999"),json!("c01"),value["players"]["p2"]["forceToken"]["id"].clone()] {let mut bad=value.clone();bad["players"]["p1"]["forceToken"]["id"]=id;assert!(e.load_state(&bad).is_err());}
 let mut bad=value.clone();bad["players"]["p1"]["forceToken"]["held"]=json!(1);assert!(e.load_state(&bad).is_err());
}

#[test]
fn force_trigger_lethal_fatigue_completes_action_player_handoff() {
 let e=engine();let mut s=board(&e);s.players[0].force_held=true;let source=hand(&e,&mut s,"LOF_146");let base=s.players[0].base;s.card_mut(base).damage=e.hp(&s,base)-3;
 let mut s=e.apply(&s,&e.card_action(&s,source)).unwrap();let trigger=e.legal_actions(&s).into_iter().find(|a|a.label=="Trigger").unwrap();s=e.apply(&s,&trigger).unwrap();assert!(s.is_terminal());assert_eq!(s.active,Seat::P2);assert!(!s.players[0].force_held);assert_eq!(s.next_id,source+9);
}
#[test]
fn terminal_trigger_handoff_does_not_discard_pending_registrations() {
 let e=engine();let mut s=board(&e);s.outcome=2;s.trigger_context=1;s.pending_programs=1;let active=s.active;e.process_all_triggers(&mut s).unwrap();assert_eq!(s.active,active);assert_eq!(s.pending_programs,1);s.pending_programs=0;s.death_pending.len=1;e.process_all_triggers(&mut s).unwrap();assert_eq!(s.active,active);assert_eq!(s.death_pending.len,1);s.death_pending.len=0;s.death_depth=1;e.process_all_triggers(&mut s).unwrap();assert_eq!(s.active,active);
}
#[test]
fn force_continuation_admission_is_exact_eight_and_raw_shapes_fail_closed() {
 let original:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();let e=engine();
 for code in ["LOF_031","LOF_035","LOF_048","LOF_075","LOF_149","LOF_159","LOF_172","LOF_173"]{assert!(e.by_code.contains_key(code),"{code}");}
 for (field,value) in [("costs",json!([{"kind":"exhaustSelf"}])),("optional",json!(false)),("trigger",json!("onAttack")),("condition",json!({"kind":"const","value":true})),("then",json!({"effect":{"kind":"noAction"}}))] {let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]=="LOF_035").unwrap();card["abilities"]["card"][0][field]=value;assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("LOF_035"),"{field}");}
 for (field,value) in [("optional",json!(true)),("then",json!({"effect":{"kind":"noAction"}})),("condition",json!({"kind":"const","value":true})),("targetResolvers",json!([{}]))] {let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]=="LOF_035").unwrap();card["abilities"]["card"][0]["ifYouDo"][field]=value;assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("LOF_035"),"child {field}");}
 for (code,types,class) in [("LOF_035",json!(["event"]),"EventCard"),("LOF_075",json!(["unit"]),"NonLeaderUnitCard"),("LOF_035",json!(["leader","unit"]),"NonLeaderUnitCard")] {let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]==code).unwrap();card["baseClass"]=json!(class);card["card"]["types"]=types;assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key(code));}
}
#[test]
fn force_event_primary_spends_even_without_secondary_and_absent_confirmation_is_prepaid() {
 let e=engine();let mut absent=board(&e);let event=hand(&e,&mut absent,"LOF_075");let prompt=e.apply(&absent,&e.card_action(&absent,event)).unwrap();assert_eq!(prompt.decision,Decision::AbilityNoEffect);assert!(prompt.players[0].hand.contains(event));assert_eq!(named_button(&e,&prompt,"Cancel").zobrist(),absent.zobrist());let paid=named_button(&e,&prompt,"Play anyway");assert!(paid.players[0].discard.contains(event));assert!(!paid.players[0].force_held);
 let mut held=absent;held.players[0].force_held=true;let identity=held.players[0].force_id;let next=held.next_id;let done=e.apply(&held,&e.card_action(&held,event)).unwrap();assert_eq!(done.decision,Decision::Window);assert!(!done.players[0].force_held);assert_eq!(done.players[0].force_id,identity);assert_eq!(done.next_id,next);assert!(done.players[0].discard.contains(event));
}
#[test]
fn force_continuation_selects_only_after_spend_and_retains_source_actor() {
 let e=engine();let mut s=board(&e);s.players[0].force_held=true;let enemy=unit(&e,&mut s,Seat::P2,"LOF_256");let source=hand(&e,&mut s,"LOF_149");let next=s.next_id;let optional=e.apply(&s,&e.card_action(&s,source)).unwrap();assert_eq!(optional.decision,Decision::AbilityOptional);assert!(optional.players[0].force_held);let selected=named_button(&e,&optional,"Trigger");assert_eq!(selected.active,Seat::P1);assert_eq!(selected.decision,Decision::AbilityTarget);assert!(!selected.players[0].force_held);assert_eq!(selected.next_id,next);assert!(e.legal_actions(&selected).iter().any(|a|a.card==Some(format!("c{}",enemy-1))));assert!(e.legal_actions(&selected).iter().all(|a|a.label!="Cancel"));
}
#[test]
fn force_death_continuation_opponent_chooses_discard_after_source_departure() {
 let e=engine();let mut s=board(&e);let source=unit(&e,&mut s,Seat::P1,"LOF_159");let card=add(&e,&mut s,Seat::P2,"LOF_256");s.players[1].hand.push(card).unwrap();let program=e.def(&s,source).programs.card[0];e.leave_play(&mut s,source).unwrap();s.source=source;s.players[0].force_held=true;e.begin_program(&mut s,program,0).unwrap();let selected=named_button(&e,&s,"Trigger");assert!(!selected.players[0].force_held);assert_eq!(selected.active,Seat::P2);assert!(e.legal_actions(&selected).iter().any(|a|a.card==Some(format!("c{}",card-1))));let action=e.legal_actions(&selected).into_iter().find(|a|a.card==Some(format!("c{}",card-1))).unwrap();let done=e.apply(&selected,&action).unwrap();assert!(done.players[1].discard.contains(card));assert!(!done.players[1].hand.contains(card));
}
#[test]
fn force_presence_live_grit_and_aura_follow_controller_not_active_player() {
 let e=engine();let mut s=board(&e);let plo=unit(&e,&mut s,Seat::P1,"LOF_050");s.card_mut(plo).damage=2;let original=e.power(&s,plo,false);s.active=Seat::P2;s.players[1].force_held=true;assert_eq!(e.keyword_amount(&s,plo,"grit"),0);s.players[0].force_held=true;assert_eq!(e.keyword_amount(&s,plo,"grit"),1);assert_eq!(e.power(&s,plo,false),original+2);s.players[0].force_held=false;assert_eq!(e.power(&s,plo,false),original);
 let son=unit(&e,&mut s,Seat::P1,"LOF_237");let own=unit(&e,&mut s,Seat::P1,"LOF_256");let enemy=unit(&e,&mut s,Seat::P2,"LOF_256");let before=[e.power(&s,son,false),e.power(&s,own,false),e.power(&s,enemy,false)];s.players[0].force_held=true;assert_eq!(e.power(&s,son,false),before[0]+2);assert_eq!(e.power(&s,own,false),before[1]+2);assert_eq!(e.power(&s,enemy,false),before[2]);let entrant=unit(&e,&mut s,Seat::P1,"LOF_256");assert_eq!(e.power(&s,entrant,false),before[1]+2);e.leave_play(&mut s,son).unwrap();assert_eq!(e.power(&s,own,false),before[1]);
}
#[test]
fn force_presence_sentinel_changes_attack_domain_and_overrides_hidden() {
 let e=engine();let mut s=board(&e);let sentinel=unit(&e,&mut s,Seat::P1,"LOF_196");let attacker=unit(&e,&mut s,Seat::P2,"LOF_256");let base=s.players[0].base;s.players[1].force_held=true;assert!(e.attack_targets(&s,attacker,false).contains(&base));s.players[0].force_held=true;assert_eq!(e.attack_targets(&s,attacker,false),vec![sentinel]);s.card_mut(sentinel).set_hidden_qualified(true);s.source=sentinel;let hidden=serde_json::from_value(json!({"kind":"gainKeyword","target":"self","duration":"phase","keyword":"hidden","amount":{"kind":"const","value":1}})).unwrap();e.apply_effect(&mut s,&hidden).unwrap();assert!(e.attack_targets(&s,attacker,false).contains(&sentinel));s.players[0].force_held=false;assert!(!e.attack_targets(&s,attacker,false).contains(&sentinel));assert!(e.attack_targets(&s,attacker,false).contains(&base));
}
#[test]
fn force_presence_selected_queries_require_native_and_explicit_history_even_when_absent() {
 let original:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();let mut bad=original.clone();bad["cards"].as_array_mut().unwrap().retain(|v|v["setCode"]!="TOKEN_THE_FORCE");let rejected=Engine::from_catalogue_value(&bad).unwrap();for code in ["LOF_050","LOF_196","LOF_231","LOF_237"]{assert!(!rejected.by_code.contains_key(code));}
 let mut e=engine();let mut snapshot=e.snapshot(&board(&e));snapshot.as_object_mut().unwrap().remove("forceStateVersion");for seat in ["p1","p2"]{snapshot["players"][seat].as_object_mut().unwrap().remove("forceToken");}
 e.catalogue.as_mut().unwrap().metadata.retain(|code,_|["ASH_019","SOR_014","IBH_053","LOF_050","TOKEN_THE_FORCE"].contains(&code.as_str()));assert!(e.load_state(&snapshot).unwrap_err().contains("Force"));e.catalogue.as_mut().unwrap().metadata.remove("LOF_050");assert!(e.load_state(&snapshot).is_ok());
}
#[test]
fn force_presence_tyranus_ambush_is_captured_at_entry_not_invented_on_later_gain() {
 let e=engine();let mut s=board(&e);unit(&e,&mut s,Seat::P2,"LOF_256");let source=hand(&e,&mut s,"LOF_231");while s.players[0].resources.len<e.cost(&s,source) as u8 {let r=add(&e,&mut s,Seat::P1,"LOF_254");s.players[0].resources.push(r).unwrap();}let mut held=s;held.players[0].force_held=true;let entered=e.apply(&held,&e.card_action(&held,source)).unwrap();assert_eq!(entered.decision,Decision::TriggerOrder);assert!(entered.pending_triggers&T_AMBUSH!=0);assert!(entered.pending_triggers&T_SHIELD!=0);let mut captured=entered; e.apply_effect(&mut captured,&crate::ability_ir::Effect::UseForce{target:crate::ability_ir::Target::Name("ownPlayer".into())}).unwrap();assert_eq!(e.keyword_amount(&captured,source,"ambush"),0);assert!(captured.pending_triggers&T_AMBUSH!=0);assert!(e.trigger_effect(&captured,T_AMBUSH));
 let mut absent=e.apply(&s,&e.card_action(&s,source)).unwrap();assert_eq!(absent.decision,Decision::Window);assert_eq!(e.keyword_amount(&absent,source,"ambush"),0);let decision=absent.decision;absent.source=source;e.apply_effect(&mut absent,&crate::ability_ir::Effect::GainForce{target:crate::ability_ir::Target::Name("ownPlayer".into())}).unwrap();assert_eq!(e.keyword_amount(&absent,source,"ambush"),1);assert_eq!(absent.decision,decision);assert_eq!(absent.pending_triggers,0);
}
#[test]
fn force_presence_recursive_scope_rejects_nonconstant_and_wrong_receivers() {
 let original:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();
 for path in [json!(["opponent","hasTheForce"]),json!(["source","hasTheForce"]),json!(["player","hasTheForce","extra"])] {let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]=="LOF_050").unwrap();card["abilities"]["card"][0]["condition"]["path"]=path;assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("LOF_050"));}
 for (field,value) in [("trigger",json!("whenPlayed")),("optional",json!(true)),("then",json!({"condition":{"kind":"ref","path":["player","hasTheForce"]},"effect":{"kind":"noAction"}})),("condition",json!({"kind":"unary","op":"!","value":{"kind":"ref","path":["player","hasTheForce"]}}))] {let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]=="LOF_050").unwrap();card["abilities"]["card"][0][field]=value;assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("LOF_050"),"{field}");}
 let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]=="LOF_146").unwrap();card["abilities"]["card"][0]["ifYouDo"]["condition"]=json!({"kind":"ref","path":["player","hasTheForce"]});assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("LOF_146"));
}
#[test]
fn force_presence_pool_dependency_uses_selected_programs_and_preserves_unrelated_legacy() {
 let e=engine();let catalogue=include_bytes!("../../card-compiler/generated/catalog.json");let metadata=&e.catalogue.as_ref().unwrap().metadata;
 let make=|codes:&[&str]|serde_json::to_vec(&json!({"schema":"omni-rs-pool-v1","cards":codes.iter().map(|code|{let mut card=metadata[*code].clone();card["setCode"]=json!(code);card}).collect::<Vec<_>>()})).unwrap();
 let unrelated=make(&["ASH_019","SOR_014","IBH_053","TOKEN_SHIELD"]);assert!(Engine::from_compiled_pool_bytes(&unrelated,catalogue).is_ok());
 let missing=make(&["ASH_019","SOR_014","IBH_053","TOKEN_SHIELD","LOF_050"]);assert!(Engine::from_compiled_pool_bytes(&missing,catalogue).err().unwrap().contains("TOKEN_THE_FORCE"));
 let complete=make(&["ASH_019","SOR_014","IBH_053","TOKEN_SHIELD","LOF_050","TOKEN_THE_FORCE"]);assert!(Engine::from_compiled_pool_bytes(&complete,catalogue).is_ok());
}
#[test]
fn force_presence_unwitnessed_hp_changes_and_nonordinary_sources_reject() {
 let original:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();
 for hp in [-2,2] {let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]=="LOF_237").unwrap();card["abilities"]["card"][0]["effect"]["hp"]["value"]=json!(hp);assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("LOF_237"));}
 for types in [json!(["leader","unit"]),json!(["unit","token"]),json!(["event"])] {let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]=="LOF_050").unwrap();card["card"]["types"]=types;assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("LOF_050"));}
}
#[test]
fn force_presence_power_aura_covers_both_arenas_tokens_and_deployed_leaders() {
 let e=engine();let mut s=board(&e);unit(&e,&mut s,Seat::P1,"LOF_237");let ground=unit(&e,&mut s,Seat::P1,"LOF_256");let space=unit(&e,&mut s,Seat::P1,"LOF_119");let token=unit(&e,&mut s,Seat::P1,"TOKEN_BEAST");let leader=s.players[0].leader;s.card_mut(leader).deployed=true;e.add_arena(&mut s,leader).unwrap();let ids=[ground,space,token,leader];let before=ids.map(|id|e.power(&s,id,false));s.players[0].force_held=true;for (i,id) in ids.iter().enumerate(){assert_eq!(e.power(&s,*id,false),before[i]+2,"{}",e.def(&s,*id).code);}
}
#[test]
fn force_triggers_acolyte_attack_and_defeat_gain_keep_identity_and_owner() {
 let e=engine();let mut s=board(&e);let source=unit(&e,&mut s,Seat::P1,"LOF_129");s.card_mut(source).exhausted=false;let enemybase=s.players[1].base;let next=s.next_id;let identity=s.players[0].force_id;s.players[1].force_held=true;let attack=e.apply(&s,&e.card_action(&s,source)).unwrap();let target=e.legal_actions(&attack).into_iter().find(|a|a.card==Some(format!("c{}",enemybase-1))).unwrap();let mut done=e.apply(&attack,&target).unwrap();assert!(done.players[0].force_held);assert!(done.players[1].force_held);assert_eq!(done.players[0].force_id,identity);assert_eq!(done.next_id,next);
 done.players[0].force_held=false;let wd=e.def(&done,source).programs.card.iter().copied().find(|p|e.program(*p).trigger=="whenDefeated").unwrap();e.leave_play(&mut done,source).unwrap();done.source=source;done.active=Seat::P2;e.begin_program(&mut done,wd,0).unwrap();assert!(done.players[0].force_held);assert!(done.players[1].force_held);assert_eq!(done.players[0].force_id,identity);assert_eq!(done.next_id,next);
}
#[test]
fn force_triggers_saber_preserves_attachment_stats_and_uses_upgrade_controller() {
 let e=engine();let mut s=board(&e);let host=unit(&e,&mut s,Seat::P2,"LOF_256");let space=unit(&e,&mut s,Seat::P1,"LOF_119");let vehicle=*e.by_code.iter().filter(|(_,id)|{let d=&e.definitions[**id as usize];d.info.is("unit")&&!d.info.is("leader")&&d.traits.iter().any(|t|t=="vehicle")&&d.programs.card.is_empty()}).map(|(_,id)|id).next().unwrap();let vehicle_code=e.definitions[vehicle as usize].code.clone();let blocked=unit(&e,&mut s,Seat::P1,&vehicle_code);let source=hand(&e,&mut s,"LOF_102");let before=[e.power(&s,host,false),e.hp(&s,host)];s.players[0].force_held=true;s.players[1].force_held=true;let ownbase=s.players[0].base;let enemybase=s.players[1].base;s.card_mut(ownbase).damage=5;s.card_mut(enemybase).damage=4;
 let targets=e.upgrade_targets(&s,source);assert!(targets.contains(&host));assert!(targets.contains(&space));assert!(!targets.contains(&blocked));let prompt=e.apply(&s,&e.card_action(&s,source)).unwrap();let attach=e.legal_actions(&prompt).into_iter().find(|a|a.card==Some(format!("c{}",host-1))).unwrap();let optional=e.apply(&prompt,&attach).unwrap();assert_eq!(optional.decision,Decision::AbilityOptional);assert_eq!(optional.card(source).owner,Seat::P1);assert_eq!(optional.card(source).parent,host);assert_eq!(e.power(&optional,host,false),before[0]+3);assert_eq!(e.hp(&optional,host),before[1]+1);
 let select=named_button(&e,&optional,"Trigger");assert!(!select.players[0].force_held);assert!(select.players[1].force_held);assert_eq!(select.active,Seat::P1);assert_eq!(select.decision,Decision::AbilityTarget);let actions=e.legal_actions(&select);assert!(actions.iter().all(|a|a.label!="Cancel"));let heal=actions.into_iter().find(|a|a.card==Some(format!("c{}",enemybase-1))).unwrap();let done=e.apply(&select,&heal).unwrap();assert_eq!(done.card(enemybase).damage,1);assert_eq!(done.card(ownbase).damage,5);
}
#[test]
fn force_triggers_saber_unique_same_host_auto_old_and_departed_new_still_heals() {
 let e=engine();
 for same_host in [true,false] {let mut s=board(&e);let own=unit(&e,&mut s,Seat::P1,"LOF_256");let enemy=unit(&e,&mut s,Seat::P2,"LOF_256");let old=add(&e,&mut s,Seat::P1,"LOF_102");e.attach(&mut s,old,own);let new=hand(&e,&mut s,"LOF_102");s.players[0].force_held=true;let base=s.players[0].base;s.card_mut(base).damage=3;
 let target=if same_host {own}else{enemy};let selection=e.apply(&s,&e.card_action(&s,new)).unwrap();let action=e.legal_actions(&selection).into_iter().find(|a|a.card==Some(format!("c{}",target-1))).unwrap();let mut entered=e.apply(&selection,&action).unwrap();
 if same_host {assert_eq!(entered.decision,Decision::AbilityOptional);assert!(entered.players[0].discard.contains(old));assert_eq!(entered.card(new).parent,own);}else{assert_eq!(entered.decision,Decision::Unique);let defeat=e.legal_actions(&entered).into_iter().find(|a|a.card==Some(format!("c{}",new-1))).unwrap();entered=e.apply(&entered,&defeat).unwrap();assert_eq!(entered.decision,Decision::AbilityOptional);assert!(entered.players[0].discard.contains(new));assert_eq!(entered.card(new).parent,0);assert_eq!(entered.card(old).parent,own);}
 let heal=named_button(&e,&entered,"Trigger");assert!(!heal.players[0].force_held);let action=e.legal_actions(&heal).into_iter().find(|a|a.card==Some(format!("c{}",base-1))).unwrap();let done=e.apply(&heal,&action).unwrap();assert_eq!(done.card(base).damage,0);
 }
}
#[test]
fn force_triggers_raw_shapes_preserve_timing_and_upgrade_domains() {
 let original:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();
 for trigger in ["action","onDefense","event"] {let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]=="LOF_129").unwrap();card["abilities"]["card"][0]["trigger"]=json!(trigger);assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("LOF_129"));}
 let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]=="LOF_129").unwrap();card["abilities"]["card"][0]["effect"]["kind"]=json!("useForce");card["abilities"]["card"][0]["optional"]=json!(true);card["abilities"]["card"][0]["ifYouDo"]=json!({"effect":{"kind":"ready","target":"self"}});assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("LOF_129"));
 for (field,value) in [("kind",json!("damage")),("target",json!("self"))] {let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]=="LOF_102").unwrap();card["abilities"]["card"][0]["ifYouDo"]["effect"][field]=value;assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("LOF_102"),"{field}");}
 for (field,value) in [("owner",json!("self")),("type",json!("unit")),("zone",json!("arena"))] {let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]=="LOF_102").unwrap();card["abilities"]["card"][0]["ifYouDo"]["targetResolver"][field]=value;assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("LOF_102"),"{field}");}
 for types in [json!(["unit"]),json!(["upgrade","token"]),json!(["upgrade","leader"])] {let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]=="LOF_102").unwrap();card["card"]["types"]=types;assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("LOF_102"));}
}
#[test]
fn resource_self_identity_current_zone_owner_and_already_ready() {
 let e=engine();for seat in [Seat::P1,Seat::P2] {let mut s=board(&e);let id=add(&e,&mut s,seat,"LOF_097");s.player_mut(seat).hand.push(id).unwrap();s.source=id;s.active=seat.other();let next=s.next_id;assert!(e.resource_source_eligible(&s,id));assert_eq!(e.resource_source(&mut s,id).unwrap(),1);assert!(s.player(seat).resources.contains(id));assert!(!s.player(seat).hand.contains(id));assert!(s.card(id).exhausted);assert_eq!(s.next_id,next);s.card_mut(id).exhausted=false;assert_eq!(e.resource_source(&mut s,id).unwrap(),0);assert!(!s.card(id).exhausted);}
}
#[test]
fn resource_self_capacity_is_atomic_and_arena_is_ineffective() {
 let e=engine();let mut s=board(&e);let source=unit(&e,&mut s,Seat::P1,"LOF_097");s.source=source;assert_eq!(e.resource_source(&mut s,source).unwrap(),0);assert!(e.in_arena(&s,source));e.leave_play(&mut s,source).unwrap();for _ in 0..crate::model::MAX_ZONE {let id=add(&e,&mut s,Seat::P1,"LOF_256");s.players[0].resources.push(id).unwrap();}let before=s;assert!(e.resource_source(&mut s,source).is_err());assert_eq!(s.players[0].resources,before.players[0].resources);assert_eq!(s.players[0].discard,before.players[0].discard);assert_eq!(s.next_id,before.next_id);
}
#[test]
fn resource_self_eeth_spends_force_even_when_secondary_is_ineffective() {
 let e=engine();for arena in [true,false] {let mut s=board(&e);let source=if arena {unit(&e,&mut s,Seat::P1,"LOF_097")}else{let id=add(&e,&mut s,Seat::P1,"LOF_097");s.players[0].resources.push(id).unwrap();s.card_mut(id).exhausted=false;id};s.source=source;s.players[0].force_held=true;let p=e.def(&s,source).programs.card[0];e.begin_program(&mut s,p,0).unwrap();assert_eq!(s.decision,Decision::AbilityOptional);let done=named_button(&e,&s,"Trigger");assert!(!done.players[0].force_held);if arena {assert!(e.in_arena(&done,source));}else{assert!(done.players[0].resources.contains(source));assert!(!done.card(source).exhausted);}}
}
#[test]
fn resource_self_raw_shapes_fail_closed_and_exact_three_admit() {
 let e=engine();for code in ["LAW_159","LOF_097","TWI_127"] {assert!(e.by_code.contains_key(code),"{code}");}assert!(!e.by_code.contains_key("SHD_107"));
 let original:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();
 for (field,value) in [("target",json!("chosen")),("amount",json!({"kind":"const","value":1})),("readyResource",json!(true)),("targetPlayer",json!("enemyPlayer"))] {let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]=="TWI_127").unwrap();card["abilities"]["card"][0]["effect"][field]=value;assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("TWI_127"),"{field}");}
 for types in [json!(["unit"]),json!(["event","token"]),json!(["leader","event"])] {let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]=="TWI_127").unwrap();card["card"]["types"]=types;assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("TWI_127"));}
}

#[test]
fn resource_self_eeth_nonarena_zones_and_mercenary_condition_are_distinct() {
 let e=engine();for zone in ["hand","deck","discard"] {let mut s=board(&e);let source=add(&e,&mut s,Seat::P1,"LOF_097");match zone {"hand"=>s.players[0].hand.push(source).unwrap(),"deck"=>s.players[0].deck.push(source).unwrap(),_=>s.players[0].discard.push(source).unwrap()};s.source=source;s.players[0].force_held=true;let p=e.def(&s,source).programs.card[0];e.begin_program(&mut s,p,0).unwrap();let done=named_button(&e,&s,"Trigger");assert!(!done.players[0].force_held);assert!(done.players[0].resources.contains(source));assert!(done.card(source).exhausted);}
 let mut s=board(&e);let source=add(&e,&mut s,Seat::P1,"LAW_159");s.players[0].hand.push(source).unwrap();s.source=source;let p=e.def(&s,source).programs.card[0];e.begin_program(&mut s,p,0).unwrap();assert_ne!(s.decision,Decision::AbilityOptional);assert!(s.players[0].hand.contains(source));assert!(!s.players[0].resources.contains(source));
 for code in ["TOKEN_SHIELD","SOR_014"] {let mut s=board(&e);let source=add(&e,&mut s,Seat::P1,code);s.source=source;s.players[0].discard.push(source).unwrap();assert!(!e.resource_source_eligible(&s,source));assert_eq!(e.resource_source(&mut s,source).unwrap(),0);}
}
#[test]
fn resource_self_resupply_commits_cost_and_survives_event_finish() {
 let e=engine();let mut s=board(&e);let source=hand(&e,&mut s,"TWI_127");let old=s.players[0].resources;let next=s.next_id;let done=e.apply(&s,&e.card_action(&s,source)).unwrap();assert!(done.players[0].resources.contains(source));assert_eq!(done.players[0].resources.len,old.len+1);assert_eq!(done.players[0].resources.as_slice().last(),Some(&source));assert!(!done.players[0].hand.contains(source));assert!(!done.players[0].discard.contains(source));assert!(done.card(source).exhausted);assert_eq!(done.next_id,next);assert!(old.as_slice().iter().filter(|&&id|done.card(id).exhausted).count()>=3);assert_eq!(done.active,Seat::P2);
}
#[test]
fn named_attack_bossk_mandatory_first_defers_stats_and_restores_combat() {
 let e=engine();let mut s=board(&e);let bossk=unit(&e,&mut s,Seat::P1,"LAW_031");s.card_mut(bossk).exhausted=false;let ally=unit(&e,&mut s,Seat::P1,"LOF_256");let base=s.players[1].base;let power=e.power(&s,ally,false);let hp=e.hp(&s,ally);let prompt=declaration(&e,s,bossk,base);assert_eq!(prompt.decision,Decision::AbilityTarget);assert!(!e.legal_actions(&prompt).iter().any(|a|["Pass","Choose nothing","Cancel"].contains(&a.label.as_str())));assert_eq!(prompt.attack_source,bossk);assert_eq!(prompt.attack_defender,base);
 let second=e.apply(&prompt,&e.card_action(&prompt,ally)).unwrap();assert_eq!(e.power(&second,ally,false),power);assert_eq!(e.hp(&second,ally),hp);assert_eq!(second.decision,Decision::AbilityTarget);assert!(e.legal_actions(&second).iter().any(|a|a.label=="Choose nothing"));let done=e.apply(&second,&e.card_action(&second,ally)).unwrap();assert_eq!(e.power(&done,ally,false),power);assert_eq!(e.hp(&done,ally),hp);assert!(done.card(base).damage>0);assert_eq!(done.attack_source,0);
}
#[test]
fn named_attack_falcon_arena_domains_literal_negative_zero_and_declines() {
 let e=engine();let mut s=board(&e);let source=unit(&e,&mut s,Seat::P1,"LAW_068");s.card_mut(source).exhausted=false;let space=unit(&e,&mut s,Seat::P2,"LOF_119");let ground=unit(&e,&mut s,Seat::P2,"LOF_256");let base=s.players[1].base;let power=e.power(&s,space,false);let hp=e.hp(&s,space);let prompt=declaration(&e,s,source,base);let targets=e.legal_actions(&prompt);assert!(targets.iter().any(|a|a.card==Some(format!("c{}",space-1))));assert!(!targets.iter().any(|a|a.card==Some(format!("c{}",ground-1))));let next=e.apply(&prompt,&e.card_action(&prompt,space)).unwrap();assert_eq!(e.power(&next,space,false),power);assert_eq!(e.hp(&next,space),hp);let done=named_button(&e,&next,"Choose nothing");assert_eq!(e.power(&done,space,false),power.saturating_sub(2));assert_eq!(e.hp(&done,space),hp);let declined=named_button(&e,&named_button(&e,&prompt,"Choose nothing"),"Choose nothing");assert_eq!(e.power(&declined,space,false),power);
}
#[test]
fn named_attack_raw_shapes_reject_unwitnessed_primitive_headers_and_literals() {
 let original:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();
 for (field,value) in [("kind",json!("damage")),("duration",json!("persistent")),("target",json!("self"))] {let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]=="LAW_031").unwrap();card["abilities"]["card"][0]["targetResolvers"][0]["effect"][field]=value;assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("LAW_031"));}
 for expression in [json!({"kind":"unary","op":"+","value":{"kind":"const","value":1}}),json!({"kind":"unary","op":"-","value":{"kind":"ref","path":["source","power"]}})] {let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]=="LAW_031").unwrap();card["abilities"]["card"][0]["targetResolvers"][0]["effect"]["power"]=expression;assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("LAW_031"));}
 let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]=="LAW_031").unwrap();card["abilities"]["card"][0]["targetResolvers"][1]["targetResolver"]["optional"]=json!(false);assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("LAW_031"));
}
#[test]
fn named_attack_bossk_distinct_wounded_lethal_resolves_captured_death_then_combat() {
 let e=engine();let mut s=board(&e);let source=unit(&e,&mut s,Seat::P1,"LAW_031");s.card_mut(source).exhausted=false;let victim=unit(&e,&mut s,Seat::P2,"LOF_129");s.card_mut(victim).damage=e.hp(&s,victim)-1;let base=s.players[1].base;let power=e.power(&s,source,false);let prompt=declaration(&e,s,source,base);let second=e.apply(&prompt,&e.card_action(&prompt,source)).unwrap();assert!(e.in_arena(&second,victim));assert!(!second.players[1].force_held);let done=e.apply(&second,&e.card_action(&second,victim)).unwrap();assert!(done.players[1].discard.contains(victim));assert!(done.players[1].force_held);assert_eq!(done.card(base).damage,power+1);assert_eq!(done.attack_source,0);assert_eq!(done.death_depth,0);
}
#[test]
fn named_damage_trooper_defers_both_handlers_and_uses_source_chooser() {
 let e=engine();let mut s=board(&e);let enemy=unit(&e,&mut s,Seat::P2,"LOF_256");let source=hand(&e,&mut s,"SEC_030");let prompt=e.apply(&s,&e.card_action(&s,source)).unwrap();assert_eq!(prompt.decision,Decision::AbilityTarget);assert_eq!(prompt.active,Seat::P1);assert!(e.legal_actions(&prompt).iter().all(|a|a.kind=="card"));let second=e.apply(&prompt,&e.card_action(&prompt,source)).unwrap();assert_eq!(second.active,Seat::P1);assert_eq!(second.card(source).damage,0);assert_eq!(second.card(enemy).damage,0);let done=e.apply(&second,&e.card_action(&second,enemy)).unwrap();assert_eq!(done.card(source).damage,2);assert_eq!(done.card(enemy).damage,2);
 let mut s=board(&e);let source=hand(&e,&mut s,"SEC_030");let prompt=e.apply(&s,&e.card_action(&s,source)).unwrap();let done=e.apply(&prompt,&e.card_action(&prompt,source)).unwrap();assert_eq!(done.card(source).damage,2);assert_eq!(done.decision,Decision::Window);
}
#[test]
fn named_damage_two_owner_shields_and_combined_lethal_capture() {
 let e=engine();for priority in ["You","Opponent"] {let mut s=board(&e);let own=unit(&e,&mut s,Seat::P1,"LOF_129");let enemy=unit(&e,&mut s,Seat::P2,"LOF_129");for id in [own,enemy] {e.create_token(&mut s,id,false).unwrap();e.create_token(&mut s,id,false).unwrap();}let source=hand(&e,&mut s,"SEC_030");let first=e.apply(&s,&e.card_action(&s,source)).unwrap();let second=e.apply(&first,&e.card_action(&first,own)).unwrap();let shield=e.apply(&second,&e.card_action(&second,enemy)).unwrap();assert_eq!(shield.decision,Decision::AbilityGroupShield);assert_eq!(shield.active,Seat::P1);let done=named_button(&e,&shield,priority);for id in [own,enemy] {assert_eq!(done.card(id).damage,0);assert_eq!(e.token_count(&done,done.card(id).shield),1);} }
 for priority in ["You","Opponent"] {let mut s=board(&e);let own=unit(&e,&mut s,Seat::P1,"LOF_129");let enemy=unit(&e,&mut s,Seat::P2,"LOF_129");for id in [own,enemy] {s.card_mut(id).damage=e.hp(&s,id)-1;}let source=hand(&e,&mut s,"SEC_030");let first=e.apply(&s,&e.card_action(&s,source)).unwrap();let second=e.apply(&first,&e.card_action(&first,own)).unwrap();let death=e.apply(&second,&e.card_action(&second,enemy)).unwrap();assert!(death.players[0].discard.contains(own));assert!(death.players[1].discard.contains(enemy));assert_eq!(death.decision,Decision::DeathPlayer);let done=named_button(&e,&death,priority);assert!(done.players[0].force_held);assert!(done.players[1].force_held);assert_eq!(done.death_depth,0);}
}
#[test]
fn named_damage_ziton_real_ambush_and_self_lethal_preserve_captured_second() {
 let e=engine();let mut s=board(&e);let enemy=unit(&e,&mut s,Seat::P2,"LOF_256");let source=hand(&e,&mut s,"TS26_029");let ambush=e.apply(&s,&e.card_action(&s,source)).unwrap();assert_eq!(ambush.decision,Decision::Ambush);let attack=named_button(&e,&ambush,"Trigger");let first=e.apply(&attack,&e.card_action(&attack,enemy)).unwrap();assert_eq!(first.attack_source,source);assert_eq!(first.attack_defender,enemy);let second=e.apply(&first,&e.card_action(&first,source)).unwrap();assert_eq!(second.card(source).damage,0);let done=e.apply(&second,&e.card_action(&second,enemy)).unwrap();assert!(done.card(source).damage>=1);assert_eq!(done.attack_source,0);
 let mut s=board(&e);let source=unit(&e,&mut s,Seat::P1,"TS26_029");s.card_mut(source).damage=e.hp(&s,source)-1;s.card_mut(source).exhausted=false;let enemy=unit(&e,&mut s,Seat::P2,"LOF_256");let base=s.players[1].base;let first=declaration(&e,s,source,base);let second=e.apply(&first,&e.card_action(&first,source)).unwrap();let done=e.apply(&second,&e.card_action(&second,enemy)).unwrap();assert!(done.players[0].discard.contains(source));assert_eq!(done.card(enemy).damage,1);assert_eq!(done.card(base).damage,0);assert_eq!(done.attack_source,0);
}
#[test]
fn named_damage_missing_first_still_resolves_second_and_raw_guards_reject() {
 let e=engine();let mut s=board(&e);let source=add(&e,&mut s,Seat::P1,"TS26_029");s.players[0].discard.push(source).unwrap();let enemy=unit(&e,&mut s,Seat::P2,"LOF_256");s.source=source;let p=e.def(&s,source).programs.card[0];e.begin_program(&mut s,p,0).unwrap();assert_eq!(s.decision,Decision::AbilityTarget);let done=e.apply(&s,&e.card_action(&s,enemy)).unwrap();assert_eq!(done.card(enemy).damage,1);
 let original:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();for (field,value) in [("owner",json!("any")),("optional",json!(true)),("type",json!("base")),("promptTitle",json!("Custom"))] {let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]=="SEC_030").unwrap();card["abilities"]["card"][0]["targetResolvers"][0]["targetResolver"][field]=value;assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("SEC_030"));}
 for trigger in ["event","onDefense","action"] {let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]=="SEC_030").unwrap();card["abilities"]["card"][0]["trigger"]=json!(trigger);assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("SEC_030"));}
}
#[test]
fn named_mixed_ineffective_first_keeps_second_cancel_before_payment() {
 let e=engine();for (event,exhausted) in [("TS26_072",false),("SOR_218",true)] {let mut s=board(&e);let own=unit(&e,&mut s,Seat::P1,"LOF_256");let enemy=unit(&e,&mut s,Seat::P2,"LOF_256");s.card_mut(own).exhausted=exhausted;s.card_mut(enemy).exhausted=exhausted;let source=hand(&e,&mut s,event);let prompt=e.apply(&s,&e.card_action(&s,source)).unwrap();assert_eq!(prompt.decision,Decision::AbilityTarget);assert!(!prompt.ability_committed);assert!(prompt.players[0].hand.contains(source));assert!(e.legal_actions(&prompt).iter().any(|a|a.label=="Cancel"));let cancelled=named_button(&e,&prompt,"Cancel");assert_eq!(cancelled.zobrist(),s.zobrist());assert_eq!(cancelled.next_id,s.next_id);}
}
#[test]
fn named_mixed_fervor_ready_ineffective_recipient_remains_selectable_and_shared() {
 let e=engine();let mut s=board(&e);let ready=unit(&e,&mut s,Seat::P1,"LOF_256");s.card_mut(ready).exhausted=false;let tired=unit(&e,&mut s,Seat::P2,"LOF_256");s.card_mut(tired).exhausted=true;let source=hand(&e,&mut s,"TS26_072");let prompt=e.apply(&s,&e.card_action(&s,source)).unwrap();assert!(e.legal_actions(&prompt).contains(&e.card_action(&prompt,ready)));let second=e.apply(&prompt,&e.card_action(&prompt,tired)).unwrap();assert!(second.card(tired).exhausted);assert_eq!(second.card(tired).damage,0);let done=e.apply(&second,&e.card_action(&second,tired)).unwrap();assert!(!done.card(tired).exhausted);assert_eq!(done.card(tired).damage,3);
 let second=e.apply(&prompt,&e.card_action(&prompt,ready)).unwrap();let done=e.apply(&second,&e.card_action(&second,tired)).unwrap();assert!(done.card(tired).exhausted);assert!(!done.card(ready).exhausted);assert_eq!(done.card(tired).damage,3);
}
#[test]
fn named_mixed_fervor_shield_and_lethal_callbacks_follow_ready() {
 let e=engine();for shield in [false,true] {let mut s=board(&e);let victim=unit(&e,&mut s,Seat::P2,"LOF_129");s.card_mut(victim).exhausted=true;s.card_mut(victim).damage=e.hp(&s,victim)-1;if shield {e.create_token(&mut s,victim,false).unwrap();}let source=hand(&e,&mut s,"TS26_072");let first=e.apply(&s,&e.card_action(&s,source)).unwrap();let second=e.apply(&first,&e.card_action(&first,victim)).unwrap();let done=e.apply(&second,&e.card_action(&second,victim)).unwrap();if shield {assert!(e.in_arena(&done,victim));assert!(!done.card(victim).exhausted);assert_eq!(done.card(victim).shield,0);assert!(!done.players[1].force_held);}else{assert!(done.players[1].discard.contains(victim));assert!(done.players[1].force_held);}}
}
#[test]
fn named_mixed_sanctuary_missing_enemy_pays_then_shields_cheap_own() {
 let e=engine();let mut s=board(&e);let target=unit(&e,&mut s,Seat::P1,"LOF_256");let expensive=unit(&e,&mut s,Seat::P1,"LOF_119");let source=hand(&e,&mut s,"SOR_218");let next=s.next_id;let prompt=e.apply(&s,&e.card_action(&s,source)).unwrap();assert!(prompt.ability_committed);assert!(prompt.players[0].discard.contains(source));assert!(!e.legal_actions(&prompt).iter().any(|a|a.label=="Cancel"));assert!(e.legal_actions(&prompt).contains(&e.card_action(&prompt,target)));assert!(!e.legal_actions(&prompt).contains(&e.card_action(&prompt,expensive)));let done=e.apply(&prompt,&e.card_action(&prompt,target)).unwrap();assert_eq!(done.next_id,next+1);assert_eq!(done.card(target).shield,next);assert_eq!(done.card(next).owner,Seat::P1);assert_eq!(done.card(next).parent,target);
}
#[test]
fn named_mixed_raw_shapes_reject_broad_headers_operations_and_predicates() {
 let original:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();for code in ["SOR_218","TS26_072"] {for (field,value) in [("owner",json!("opponent")),("optional",json!(true)),("type",json!("base")),("zone",json!("resource"))] {let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]==code).unwrap();card["abilities"]["card"][0]["targetResolvers"][1]["targetResolver"][field]=value;assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key(code),"{code}/{field}");}}
 let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]=="SOR_218").unwrap();card["abilities"]["card"][0]["targetResolvers"][1]["targetResolver"]["predicate"]["right"]["right"]["value"]=json!(4);assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("SOR_218"));
}
#[test]
fn named_mixed_mislead_defers_token_id_until_both_choices_and_payment() {
 let e=engine();for same in [true,false] {let mut s=board(&e);let own=unit(&e,&mut s,Seat::P1,"LOF_256");let enemy=unit(&e,&mut s,Seat::P2,"LOF_256");let source=hand(&e,&mut s,"TS26_081");let next=s.next_id;let power=e.power(&s,enemy,false);let hp=e.hp(&s,enemy);let first=e.apply(&s,&e.card_action(&s,source)).unwrap();let second=e.apply(&first,&e.card_action(&first,enemy)).unwrap();assert_eq!(second.next_id,next);assert_eq!(second.cards,s.cards);assert_eq!(second.players[0].resources,s.players[0].resources);assert!(second.players[0].hand.contains(source));assert_eq!(second.card(enemy).shield,0);assert_eq!(e.power(&second,enemy,false),power);assert_eq!(second.event_group.records[0].token,0);let cancelled=named_button(&e,&second,"Cancel");assert_eq!(cancelled.zobrist(),s.zobrist());assert_eq!(cancelled.cards,s.cards);assert_eq!(cancelled.next_id,next);assert_eq!(cancelled.players[0].hand,s.players[0].hand);
 let target=if same {enemy}else{own};let original_power=e.power(&s,target,false);let done=e.apply(&second,&e.card_action(&second,target)).unwrap();assert_eq!(done.next_id,next+1);assert_eq!(done.card(enemy).shield,next);assert_eq!(done.card(next).parent,enemy);assert_eq!(done.card(next).owner,Seat::P2);assert_eq!(e.power(&done,target,false),original_power.saturating_sub(3));assert_eq!(e.hp(&done,enemy),hp);assert!(done.players[0].discard.contains(source));assert!(done.players[0].resources.as_slice().iter().any(|id|done.card(*id).exhausted));}
}
#[test]
fn named_mixed_token_capacity_preflight_has_no_partial_card_allocation() {
 let e=engine();let mut s=board(&e);let recipient=unit(&e,&mut s,Seat::P1,"LOF_256");let source=hand(&e,&mut s,"TS26_081");let first=e.apply(&s,&e.card_action(&s,source)).unwrap();let mut second=e.apply(&first,&e.card_action(&first,recipient)).unwrap();second.next_id=MAX_CARDS as CardId;let before=second;assert!(e.apply(&second,&e.card_action(&second,recipient)).is_err());assert_eq!(second.cards,before.cards);assert_eq!(second.players[0].hand,before.players[0].hand);let p=e.program(second.ability_program-1);let Instruction::NamedGroup(effect)=&p.instructions[second.ability_pc as usize] else {panic!()};assert!(e.allocate_named_tokens(&mut second,effect).is_err());assert_eq!(second.cards,before.cards);assert_eq!(second.next_id,before.next_id);
}
#[test]
fn named_mixed_mislead_rejects_hp_damage_and_dynamic_token_shapes() {
 let original:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();for (field,value) in [("hp",json!({"kind":"unary","op":"-","value":{"kind":"const","value":1}})),("power",json!({"kind":"ref","path":["source","power"]})),("duration",json!("persistent"))] {let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]=="TS26_081").unwrap();card["abilities"]["card"][0]["targetResolvers"][1]["effect"][field]=value;assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("TS26_081"));}
}
#[test]
fn named_mixed_all_empty_confirms_before_costs_and_cost_filter_is_printed() {
 let e=engine();for code in ["SOR_218","TS26_072","TS26_081"] {let mut s=board(&e);let source=hand(&e,&mut s,code);let prompt=e.apply(&s,&e.card_action(&s,source)).unwrap();assert_eq!(prompt.decision,Decision::AbilityNoEffect);assert_eq!(named_button(&e,&prompt,"Cancel").zobrist(),s.zobrist());let done=named_button(&e,&prompt,"Play anyway");assert!(done.players[0].discard.contains(source));assert_eq!(done.next_id,s.next_id);}
 let mut s=board(&e);let source=hand(&e,&mut s,"SOR_218");let mut ids=vec![];for cost in [3,4] {let d=e.definitions.iter().find(|d|d.info.is("unit")&&!d.info.is("leader")&&d.info.cost==Some(cost)&&d.programs.card.is_empty()).unwrap();let id=unit(&e,&mut s,Seat::P1,&d.code);ids.push(id);}let zero=unit(&e,&mut s,Seat::P1,"LOF_254");let beast=unit(&e,&mut s,Seat::P1,"TOKEN_BEAST");let prompt=e.apply(&s,&e.card_action(&s,source)).unwrap();let legal=e.legal_actions(&prompt);for id in [ids[0],zero,beast] {assert!(legal.contains(&e.card_action(&prompt,id)));}assert!(!legal.contains(&e.card_action(&prompt,ids[1])));
}

#[test]
fn named_unit_base_damage_domains_and_deferred_handlers() {
    let e = engine();
    let mut s = board(&e);
    let source = unit(&e, &mut s, Seat::P1, "LAW_184");
    let own = unit(&e, &mut s, Seat::P1, "HMW_116");
    let ground = unit(&e, &mut s, Seat::P2, "HMW_116");
    let space = unit(&e, &mut s, Seat::P2, "IBH_022");
    let enemy_base = s.players[1].base;
    let first = declaration(&e, s, source, enemy_base);
    let cards: Vec<_> = e.legal_actions(&first).into_iter().filter(|a| a.kind == "card").collect();
    assert_eq!(cards, vec![e.card_action(&first, ground)]);
    let second = e.apply(&first, &e.card_action(&first, ground)).unwrap();
    assert_eq!(second.card(ground).damage, 0);
    for player in &second.players {
        assert!(e.legal_actions(&second).contains(&e.card_action(&second, player.base)));
    }
    let done = e.apply(&second, &e.card_action(&second, enemy_base)).unwrap();
    assert_eq!(done.card(ground).damage, 2);
    assert_eq!(done.card(enemy_base).damage, 5);
    assert_eq!(done.card(own).damage, 0);
    assert_eq!(done.card(space).damage, 0);
    assert_eq!(done.attack_source, 0);
}

#[test]
fn named_unit_base_damage_missing_ground_preserves_base_and_combat() {
    let e = engine();
    let mut s = board(&e);
    let source = unit(&e, &mut s, Seat::P1, "LAW_184");
    let enemy_base = s.players[1].base;
    let own_base = s.players[0].base;
    let prompt = declaration(&e, s, source, enemy_base);
    let done = e.apply(&prompt, &e.card_action(&prompt, own_base)).unwrap();
    assert_eq!(done.card(own_base).damage, 2);
    assert_eq!(done.card(enemy_base).damage, 3);
    assert_eq!(done.attack_source, 0);
}

#[test]
fn named_unit_base_damage_raw_scope_is_fail_closed() {
    let original: Value = serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();
    let alterations = [
        ("/abilities/card/0/optional", json!(true)),
        ("/abilities/card/0/targetResolvers/0/chooser", json!("opponent")),
        ("/abilities/card/0/targetResolvers/0/targetResolver/owner", json!("any")),
        ("/abilities/card/0/targetResolvers/0/targetResolver/arena", json!("space")),
        ("/abilities/card/0/targetResolvers/1/targetResolver/type", json!("unit")),
        ("/card/keywords", json!(["raid"])),
        ("/card/pilotText", json!("unmodeled")),
        ("/baseClass", json!("EventCard")),
    ];
    for (path, value) in alterations {
        let mut catalogue = original.clone();
        let card = catalogue["cards"].as_array_mut().unwrap().iter_mut().find(|c| c["setCode"] == "LAW_184").unwrap();
        let parts: Vec<_> = path.trim_start_matches('/').split('/').collect();
        let mut slot = &mut *card;
        for key in &parts[..parts.len()-1] {
            slot = if slot.is_array() { &mut slot[key.parse::<usize>().unwrap()] } else { &mut slot[*key] };
        }
        let key = parts[parts.len()-1];
        if slot.is_array() { slot[key.parse::<usize>().unwrap()] = value; } else { slot[key] = value; }
        assert!(!Engine::from_catalogue_value(&catalogue).unwrap().by_code.contains_key("LAW_184"), "{path}");
    }
}
#[test]
fn named_chooser_event_pays_original_actor_before_opponent_and_restores() {
 let e=engine();let mut s=board(&e);let own=unit(&e,&mut s,Seat::P1,"LOF_112");let enemy=unit(&e,&mut s,Seat::P2,"LOF_112");let event=hand(&e,&mut s,"TWI_238");let resources=s.players[0].resources;let first=e.apply(&s,&e.card_action(&s,event)).unwrap();assert_eq!(first.active,Seat::P2);assert_eq!(first.decision,Decision::AbilityTarget);assert!(first.players[0].discard.contains(event));assert!(!first.players[0].hand.contains(event));assert!(resources.as_slice().iter().any(|id|first.card(*id).exhausted));assert!(!e.legal_actions(&first).iter().any(|a|["Cancel","Choose nothing","Pass"].contains(&a.label.as_str())));assert_eq!(e.legal_actions(&first).iter().filter_map(Action::id).collect::<Vec<_>>(),vec![enemy]);
 let second=e.apply(&first,&e.card_action(&first,enemy)).unwrap();assert_eq!(second.active,Seat::P1);assert!(e.in_arena(&second,enemy));let done=e.apply(&second,&e.card_action(&second,own)).unwrap();assert!(done.players[0].discard.contains(own));assert!(done.players[1].discard.contains(enemy));assert_eq!(done.active,Seat::P2);
}
#[test]
fn named_chooser_unit_missing_opponent_and_entering_self_defeat() {
 let e=engine();let mut s=board(&e);let source=hand(&e,&mut s,"LAW_099");let first=e.apply(&s,&e.card_action(&s,source)).unwrap();assert_eq!(first.active,Seat::P1);assert_eq!(first.decision,Decision::AbilityTarget);assert_eq!(e.legal_actions(&first).iter().filter_map(Action::id).collect::<Vec<_>>(),vec![source]);let done=e.apply(&first,&e.card_action(&first,source)).unwrap();assert!(done.players[0].discard.contains(source));assert_eq!(done.active,Seat::P2);
 let mut s=board(&e);let enemy=unit(&e,&mut s,Seat::P2,"LOF_112");let source=add(&e,&mut s,Seat::P1,"LAW_099");s.players[0].discard.push(source).unwrap();s.source=source;let p=e.def(&s,source).programs.card[0];e.begin_program(&mut s,p,0).unwrap();assert_eq!(s.active,Seat::P2);let done=e.apply(&s,&e.card_action(&s,enemy)).unwrap();assert!(done.players[1].discard.contains(enemy));assert_ne!(done.decision,Decision::AbilityTarget);
}
#[test]
fn named_chooser_wrecker_shield_priority_and_combined_defeat_owners() {
 let e=engine();for label in ["You","Opponent"] {let mut s=board(&e);let own=unit(&e,&mut s,Seat::P1,"LOF_112");let enemy=unit(&e,&mut s,Seat::P2,"LOF_112");for id in [own,enemy] {e.create_token(&mut s,id,false).unwrap();e.create_token(&mut s,id,false).unwrap();}let source=hand(&e,&mut s,"HMW_263");let first=e.apply(&s,&e.card_action(&s,source)).unwrap();assert_eq!(first.active,Seat::P2);let second=e.apply(&first,&e.card_action(&first,enemy)).unwrap();assert_eq!(second.active,Seat::P1);let priority=e.apply(&second,&e.card_action(&second,own)).unwrap();assert_eq!(priority.decision,Decision::AbilityGroupShield);assert_eq!(priority.active,Seat::P1);let done=named_button(&e,&priority,label);for id in [own,enemy] {assert_eq!(done.card(id).damage,0);assert_eq!(e.token_count(&done,done.card(id).shield),1);}}
 for label in ["You","Opponent"] {let mut s=board(&e);let own=unit(&e,&mut s,Seat::P1,"LOF_129");let enemy=unit(&e,&mut s,Seat::P2,"LOF_129");let source=hand(&e,&mut s,"LAW_099");let first=e.apply(&s,&e.card_action(&s,source)).unwrap();let second=e.apply(&first,&e.card_action(&first,enemy)).unwrap();let death=e.apply(&second,&e.card_action(&second,own)).unwrap();assert!(death.players[0].discard.contains(own));assert!(death.players[1].discard.contains(enemy));assert_eq!(death.decision,Decision::DeathPlayer);assert_eq!(death.active,Seat::P1);let done=named_button(&e,&death,label);assert!(done.players[0].force_held&&done.players[1].force_held);}
}
#[test]
fn named_chooser_raw_shapes_fail_closed() {
 let original:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();
 for (field,value) in [("chooser",json!("self")),("name",json!(""))] {let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]=="LAW_099").unwrap();card["abilities"]["card"][0]["targetResolvers"][0][field]=value;assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("LAW_099"));}
 for (field,value) in [("owner",json!("any")),("optional",json!(true)),("type",json!("nonLeaderUnit")),("arena",json!("ground"))] {let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]=="LAW_099").unwrap();card["abilities"]["card"][0]["targetResolvers"][0]["targetResolver"][field]=value;assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("LAW_099"));}
 for (field,value) in [("pilotText",json!("Pilot")),("keywords",json!(["ambush"])),("types",json!(["leader","unit"])),("unique",json!(null))] {let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]=="LAW_099").unwrap();card["card"][field]=value;assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("LAW_099"));}
 for name in ["target","constructor","prototype","__proto__","0choice"] {let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]=="LAW_099").unwrap();card["abilities"]["card"][0]["targetResolvers"][0]["name"]=json!(name);assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("LAW_099"));}
 assert_eq!(std::mem::size_of::<State>(),19112);assert_eq!(std::mem::size_of::<Card>(),36);
}

#[test]
fn weakness_upgrade_raw_scope_requires_sole_optional_play_and_native() {
    let original:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();
    assert!(Engine::from_catalogue_value(&original).unwrap().by_code.contains_key("HMW_097"));
    for kind in 0..8 {
        let mut catalogue=original.clone();
        let card=catalogue["cards"].as_array_mut().unwrap().iter_mut().find(|c|c["setCode"]=="HMW_097").unwrap();
        match kind {
            0=>card["abilities"]["card"][0]["optional"]=json!(false),
            1=>card["abilities"]["card"][0]["trigger"]=json!("whenDefeated"),
            2=>card["abilities"]["card"][0]["effect"]["amount"]["value"]=json!(2),
            3=>card["card"]["pilotText"]=json!("unmodeled"),
            4=>card["card"]["keywords"]=json!(["raid"]),
            5=>card["attachCondition"]=json!({"kind":"const","value":true}),
            6=>card["abilities"]["card"][0]["targetResolver"]["owner"]=json!("self"),
            _=>card["abilities"]["card"][0]["then"]=json!({"effect":{"kind":"noAction"}}),
        }
        assert!(!Engine::from_catalogue_value(&catalogue).unwrap().by_code.contains_key("HMW_097"),"variant{kind}");
    }
    let mut missing=original.clone();missing["cards"].as_array_mut().unwrap().retain(|c|c["setCode"]!="TOKEN_WEAKNESS");
    assert!(!Engine::from_catalogue_value(&missing).unwrap().by_code.contains_key("HMW_097"));
}

#[test]
fn weakness_upgrade_enemy_host_preserves_source_actor_and_recipient_owner() {
    let e=engine();let mut s=board(&e);
    let host=unit(&e,&mut s,Seat::P2,"HMW_116");
    let target=unit(&e,&mut s,Seat::P1,"HMW_116");
    let upgrade=hand(&e,&mut s,"HMW_097");
    let initial_id=s.next_id;let host_hp=e.hp(&s,host);let host_power=e.power(&s,host,false);
    let attach=e.apply(&s,&e.card_action(&s,upgrade)).unwrap();
    let choice=e.apply(&attach,&e.card_action(&attach,host)).unwrap();
    assert_eq!(choice.active,Seat::P1);
    assert_eq!(e.hp(&choice,host),host_hp+1);assert_eq!(e.power(&choice,host,false),host_power+1);
    let done=e.apply(&choice,&e.card_action(&choice,target)).unwrap();
    assert_eq!(done.next_id,initial_id+1);
    assert_eq!(done.card(initial_id).owner,Seat::P1);
    assert_eq!(done.card(initial_id).parent,target);
    assert_eq!(e.hp(&done,target),e.hp(&s,target)-1);
    assert_eq!(e.power(&done,target,false),e.power(&s,target,false)-1);
}

#[test]
fn arena_uniform_damage_admits_complete_five_and_rejects_raw_scope() {
    let e=engine();for code in ["IBH_072","LOF_170","SEC_263","SHD_158","TWI_164"] {assert!(e.by_code.contains_key(code),"{code}: {:?}",e.rejected_cards().unwrap().get(code));}
    let original:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();
    for variant in 0..8 {let mut c=original.clone();let entry=c["cards"].as_array_mut().unwrap().iter_mut().find(|v|v["setCode"]=="IBH_072").unwrap();match variant {
        0=>entry["abilities"]["card"][0]["optional"]=json!(true),
        1=>entry["abilities"]["card"][0]["effect"]["amount"]["value"]=json!(4),
        2=>entry["abilities"]["card"][0]["effect"]["target"]["receiver"]=json!({"kind":"ref","path":["unknown"]}),
        3=>entry["abilities"]["card"][0]["condition"]=json!({"kind":"const","value":true}),
        4=>entry["abilities"]["card"][0]["then"]=json!({"effect":{"kind":"noAction"}}),
        5=>entry["card"]["types"]=json!(["unit","token"]),
        6=>entry["baseClass"]=json!("LeaderCard"),
        _=>entry["abilities"]["card"][0]["effect"]["target"]["predicate"]=json!({"kind":"ref","path":["card","damage"]}),
    }assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("IBH_072"),"variant{variant}");}
}
#[test]
fn arena_uniform_damage_over_32_recipients_and_combined_lethal() {
    let e=engine();let mut s=board(&e);let source=unit(&e,&mut s,Seat::P1,"IBH_072");let mut targets=vec![];
    for seat in [Seat::P1,Seat::P2] {for _ in 0..24 {targets.push(unit(&e,&mut s,seat,"LOF_112"));}}
    s.source=source;let p=e.def(&s,source).programs.card[0];e.begin_program(&mut s,p,0).unwrap();
    for target in targets {assert_eq!(s.card(target).damage,1);}
    assert_eq!(s.card(source).damage,0);assert_eq!(s.event_group.uniform_damage,UniformDamageState::default());
    let mut s=board(&e);let source=unit(&e,&mut s,Seat::P1,"IBH_072");let own=unit(&e,&mut s,Seat::P1,"LOF_129");let enemy=unit(&e,&mut s,Seat::P2,"LOF_129");for id in [own,enemy] {s.card_mut(id).damage=e.hp(&s,id)-1;}s.source=source;let p=e.def(&s,source).programs.card[0];e.begin_program(&mut s,p,0).unwrap();assert!(s.players[0].discard.contains(own));assert!(s.players[1].discard.contains(enemy));assert_eq!(s.decision,Decision::DeathPlayer);
}
#[test]
fn arena_uniform_damage_shield_context_ids_both_owner_orders() {
    let e=engine();for label in ["You","Opponent"] {let mut s=board(&e);let source=unit(&e,&mut s,Seat::P1,"IBH_072");let own=unit(&e,&mut s,Seat::P1,"LOF_112");let enemy=unit(&e,&mut s,Seat::P2,"LOF_112");let mut tokens=vec![];for id in [own,enemy] {let oldest=s.next_id;e.create_token(&mut s,id,false).unwrap();let newer=s.next_id;e.create_token(&mut s,id,false).unwrap();tokens.push((oldest,newer));}s.source=source;let p=e.def(&s,source).programs.card[0];e.begin_program(&mut s,p,0).unwrap();assert_eq!(s.decision,Decision::AbilityGroupShield);let copied=s;assert_eq!(s.zobrist(),copied.zobrist());let done=named_button(&e,&s,label);for (i,id) in [own,enemy].into_iter().enumerate() {let first=(label=="You"&&i==0)||(label=="Opponent"&&i==1);let consumed=if first {tokens[i].0}else {tokens[i].1};let survivor=if first {tokens[i].1}else {tokens[i].0};assert_eq!(done.card(id).damage,0);assert_eq!(done.card(consumed).parent,0);assert_eq!(done.card(id).shield,survivor);}assert_eq!(done.event_group.uniform_damage,UniformDamageState::default());}
}
#[test]
fn arena_uniform_damage_storage_hash_and_size_are_explicit() {
    assert!(UniformDamageRecord::new(0,0).is_err());assert!(UniformDamageRecord::new(256,0).is_err());assert!(UniformDamageRecord::new(1,256).is_err());assert_eq!(UniformDamageRecord::new(255,255).unwrap().target(),255);
    let s=State::default();let unchanged=s;assert_eq!(s.zobrist(),unchanged.zobrist());let mut pending=s;pending.event_group.uniform_damage.active=true;pending.event_group.uniform_damage.count=1;pending.event_group.uniform_damage.records[0]=UniformDamageRecord::new(1,2).unwrap();assert_ne!(s.zobrist(),pending.zobrist());let before=pending.zobrist();pending.event_group.uniform_damage.prevent(0);assert_ne!(before,pending.zobrist());pending.event_group=EventGroupState::default();assert_eq!(s.zobrist(),pending.zobrist());assert_eq!(std::mem::size_of::<Card>(),36);eprintln!("uniform State bytes={}",std::mem::size_of::<State>());
}
#[test]
fn arena_uniform_damage_same_owner_shields_rotate_alternates() {
 let e=engine();let mut s=board(&e);let source=unit(&e,&mut s,Seat::P1,"IBH_072");let first=unit(&e,&mut s,Seat::P1,"LOF_112");let second=unit(&e,&mut s,Seat::P1,"HMW_116");let mut tokens=vec![];for target in [first,second] {let old=s.next_id;e.create_token(&mut s,target,false).unwrap();let newer=s.next_id;e.create_token(&mut s,target,false).unwrap();tokens.push((old,newer));}s.source=source;let p=e.def(&s,source).programs.card[0];e.begin_program(&mut s,p,0).unwrap();assert_eq!(s.decision,Decision::AbilityGroupShield);assert_eq!(s.event_group.shield_count,2);let done=named_button(&e,&s,"Resolve next");assert_eq!(done.card(first).shield,tokens[0].1);assert_eq!(done.card(second).shield,tokens[1].0);assert_eq!(done.card(tokens[0].0).parent,0);assert_eq!(done.card(tokens[1].1).parent,0);assert_eq!(done.event_group.uniform_damage,UniformDamageState::default());
}

fn arena_keyword4_effect(code:&str)->Effect {
 let catalogue:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();let entry=catalogue["cards"].as_array().unwrap().iter().find(|e|e["setCode"]==code).unwrap();serde_json::from_value(entry["abilities"]["card"][0]["effect"].clone()).unwrap()
}
#[test]
fn arena_keyword4_admits_four_and_rejects_nested_mixed_and_metadata() {
 let e=engine();for code in ["JTL_077","LOF_152","TWI_250","LOF_045"] {assert!(e.by_code.contains_key(code),"{code}: {:?}",e.rejected_cards().unwrap().get(code));}
 let original:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();
 for variant in 0..9 {let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|e|e["setCode"]=="LOF_152").unwrap();match variant {
 0=>card["abilities"]["card"][0]["optional"]=json!(true),1=>card["abilities"]["card"][0]["condition"]=json!({"kind":"const","value":true}),2=>card["abilities"]["card"][0]["effect"]["effects"][0]["target"]["receiver"]=json!({"kind":"ref","path":["unknown"]}),3=>card["abilities"]["card"][0]["effect"]["effects"][0]["amount"]["value"]=json!(65536),4=>card["abilities"]["card"][0]["effect"]["effects"][1]=json!({"kind":"ready","target":"self"}),5=>card["card"]["types"]=json!(["event","leader"]),6=>card["card"]["pilotText"]=json!("unmodeled"),7=>{let original=card["abilities"]["card"][0]["effect"].clone();card["abilities"]["card"][0]["effect"]=json!({"kind":"noAction"});card["abilities"]["card"][0]["then"]=json!({"effect":original});},_=>card["abilities"]["card"][0]["effect"]["effects"][0]["target"]["predicate"]=json!({"kind":"ref","path":["card","damage"]})}assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("LOF_152"),"variant{variant}");}
 for trait_name in ["jedi","!=='hasSomeTrait'"] {let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|e|e["setCode"]=="LOF_045").unwrap();card["abilities"]["card"][0]["effect"]["target"]["predicate"]=json!({"kind":"query","name":"hasSomeTrait","receiver":{"kind":"ref","path":["card"]},"args":[{"kind":"const","value":trait_name}]});assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("LOF_045"));}
 let mut c=original.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|e|e["setCode"]=="JTL_077").unwrap();card["abilities"]["card"][0]["effect"]["effects"][1]["target"]["receiver"]=json!({"kind":"ref","path":["player"]});assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("JTL_077"));
}
#[test]
fn arena_keyword4_global_over32_and_trait_snapshot_multiplicity() {
 let e=engine();let mut s=board(&e);let source=add(&e,&mut s,Seat::P1,"JTL_077");s.source=source;let mut ids=vec![];for seat in [Seat::P1,Seat::P2] {for _ in 0..24 {ids.push(unit(&e,&mut s,seat,"LOF_112"));}}let effect=arena_keyword4_effect("JTL_077");assert_eq!(e.apply_effect(&mut s,&effect).unwrap(),(96,true));for id in ids {assert_eq!(e.keyword_amount(&s,id,"sentinel"),1);assert_eq!(e.keyword_amount(&s,id,"saboteur"),0);}assert_eq!(s.event_group,EventGroupState::default());
 let mut s=board(&e);let source=add(&e,&mut s,Seat::P1,"LOF_152");s.source=source;let own=unit(&e,&mut s,Seat::P1,"LOF_112");let enemy=unit(&e,&mut s,Seat::P2,"LOF_112");let space=unit(&e,&mut s,Seat::P1,"JTL_251");let effect=arena_keyword4_effect("LOF_152");assert_eq!(e.apply_effect(&mut s,&effect).unwrap(),(2,true));assert_eq!(e.keyword_amount(&s,own,"raid"),1);assert_eq!(e.keyword_amount(&s,own,"saboteur"),1);for id in [enemy,space] {assert_eq!(e.keyword_amount(&s,id,"raid"),0);assert_eq!(e.keyword_amount(&s,id,"saboteur"),0);}let newcomer=unit(&e,&mut s,Seat::P1,"LOF_112");assert_eq!(e.keyword_amount(&s,newcomer,"raid"),0);e.apply_effect(&mut s,&effect).unwrap();assert_eq!(e.keyword_amount(&s,own,"raid"),2);assert_eq!(e.keyword_amount(&s,newcomer,"raid"),1);
}
#[test]
fn arena_keyword4_numeric_preflight_is_atomic_and_overlap_is_synthetic() {
 let e=engine();let mut s=board(&e);let source=add(&e,&mut s,Seat::P1,"LOF_152");s.source=source;let first=unit(&e,&mut s,Seat::P1,"LOF_112");let last=unit(&e,&mut s,Seat::P1,"LOF_112");s.card_mut(last).phase_keyword_values[0]=65535;s.card_mut(last).phase_power=-2;s.card_mut(last).add_phase_keyword(6);e.check_stat_capacity(&s).unwrap();let before=s;assert!(e.apply_effect(&mut s,&arena_keyword4_effect("LOF_152")).unwrap_err().contains("capacity"));assert_eq!(s.zobrist(),before.zobrist());assert_eq!(s.card(first).phase_keyword_values[0],0);
 s.card_mut(last).phase_keyword_values[0]=65533;s.card_mut(last).phase_power=0;e.check_stat_capacity(&s).unwrap();let before=s;
 assert!(e.apply_effect(&mut s,&arena_keyword4_effect("LOF_152")).unwrap_err().contains("computed stats"));assert_eq!(s.zobrist(),before.zobrist());assert_eq!(s.card(first).phase_keyword_values[0],0);
 let mut legacy=s;legacy.arena_order_exact=false;let before=legacy.zobrist();assert!(e.apply_effect(&mut legacy,&arena_keyword4_effect("LOF_152")).unwrap_err().contains("recorded global arena order"));assert_eq!(legacy.zobrist(),before);
 // Explicit synthetic descriptor overlap: both child systems give Raid to the
 // same real Force recipients. No invented printed dual-trait card coverage.
 s.card_mut(last).phase_keyword_values[0]=0;let mut effect=arena_keyword4_effect("LOF_152");let Effect::Simultaneous{effects}=&mut effect else{unreachable!()};effects[1]=effects[0].clone();e.apply_effect(&mut s,&effect).unwrap();assert_eq!(s.card(first).phase_keyword_values[0],2);assert_eq!(s.card(last).phase_keyword_values[0],2);
}
#[test]
fn arena_keyword4_restore_source_exclusion_and_sentinel_hp_expiry() {
 let e=engine();let mut s=board(&e);let source=unit(&e,&mut s,Seat::P1,"LOF_045");let own=unit(&e,&mut s,Seat::P1,"JTL_251");let enemy=unit(&e,&mut s,Seat::P2,"JTL_251");s.source=source;e.apply_effect(&mut s,&arena_keyword4_effect("LOF_045")).unwrap();assert_eq!(e.keyword_amount(&s,source,"restore"),1);assert_eq!(s.card(source).phase_keyword_mask(),0);assert_eq!(e.keyword_amount(&s,own,"restore"),1);assert_eq!(e.keyword_amount(&s,enemy,"restore"),0);
 let mut s=board(&e);let source=add(&e,&mut s,Seat::P1,"JTL_077");s.source=source;let shuttle=unit(&e,&mut s,Seat::P1,"SEC_032");let target=unit(&e,&mut s,Seat::P1,"LOF_112");let base_hp=e.hp(&s,target);e.apply_effect(&mut s,&arena_keyword4_effect("JTL_077")).unwrap();assert_eq!(e.hp(&s,target),base_hp+2);s.card_mut(target).damage=base_hp;assert!(e.in_arena(&s,target));s.players[0].out=true;s.players[1].out=true;e.advance(&mut s).unwrap();assert!(s.players[0].discard.contains(target));assert!(e.in_arena(&s,shuttle));assert_eq!(std::mem::size_of::<State>(),19112);
}

#[test]
fn weakness4_admission_preserves_whole_sources_and_native_dependencies() {
 let e=engine();for code in ["HMW_100","HMW_199","HMW_202","HMW_231"] {assert!(e.by_code.contains_key(code),"{code}: {:?}",e.rejected_cards().unwrap().get(code));}assert_eq!(e.definitions[*e.by_code.get("HMW_202").unwrap() as usize].programs.card.len(),2);
 let original:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();
 for token in ["TOKEN_WEAKNESS","TOKEN_BEAST"] {for malformed in [false,true] {let mut c=original.clone();if malformed {c["cards"].as_array_mut().unwrap().iter_mut().find(|e|e["setCode"]==token).unwrap()["card"]["title"]=json!("Wrong native");}else{c["cards"].as_array_mut().unwrap().retain(|e|e["setCode"]!=token);}let e=Engine::from_catalogue_value(&c).unwrap();assert!(!e.by_code.contains_key("HMW_199"));if token=="TOKEN_WEAKNESS" {for code in ["HMW_100","HMW_202","HMW_231"] {assert!(!e.by_code.contains_key(code));}}}}
 assert_eq!(std::mem::size_of::<State>(),19112);assert_eq!(std::mem::size_of::<Card>(),36);
}
#[test]
fn weakness4_raw_shapes_fail_closed_without_mixed_group_relaxation() {
 let original:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();
 for (code,key,value) in [("HMW_100","optional",json!(true)),("HMW_199","optional",json!(true)),("HMW_231","optional",json!(false)),("HMW_202","condition",json!({"kind":"const","value":true}))] {let mut c=original.clone();let entry=c["cards"].as_array_mut().unwrap().iter_mut().find(|e|e["setCode"]==code).unwrap();entry["abilities"]["card"][0][key]=value;assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key(code));}
 for variant in 0..6 {let mut c=original.clone();let entry=c["cards"].as_array_mut().unwrap().iter_mut().find(|e|e["setCode"]=="HMW_202").unwrap();match variant {0=>{entry["abilities"]["card"].as_array_mut().unwrap().pop();},1=>entry["abilities"]["card"][0]["effect"]["effects"][0]["amount"]["value"]=json!(2),2=>entry["card"]["types"]=json!(["unit","leader"]),3=>entry["card"]["pilotText"]=json!("unmodeled"),4=>entry["abilities"]["card"][0]["targetResolver"]["owner"]=json!("self"),_=>entry["abilities"]["card"][0]["effect"]["effects"].as_array_mut().unwrap().reverse()}assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("HMW_202"),"variant{variant}");}
 for code in ["HMW_199","HMW_231"] {let mut c=original.clone();let entry=c["cards"].as_array_mut().unwrap().iter_mut().find(|e|e["setCode"]==code).unwrap();entry["abilities"]["card"][0]["ifYouDo"]=json!({"effect":{"kind":"noAction"}});assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key(code));}
 let mixed:crate::ability_ir::Ability=serde_json::from_value(json!({"trigger":"event","title":"Synthetic mixed","effect":{"kind":"simultaneous","effects":[{"kind":"damage","target":"self","amount":{"kind":"const","value":1}},{"kind":"giveShield","target":"self","amount":{"kind":"const","value":1}}]}})).unwrap();assert!(crate::ability_ir::Program::compile(&mixed).is_err());
}
#[test]
fn weakness4_torrent_two_allocations_before_one_hp_collapse_and_capacity() {
 let e=engine();let mut s=board(&e);let target=unit(&e,&mut s,Seat::P2,"ASH_190");let event=hand(&e,&mut s,"HMW_100");s.card_mut(s.players[0].base).def=*e.by_code.get("HMW_020").unwrap();let next=s.next_id;let choice=e.apply(&s,&e.card_action(&s,event)).unwrap();assert_eq!(choice.decision,Decision::AbilityTarget);let cancelled=named_button(&e,&choice,"Cancel");assert_eq!(cancelled.next_id,next);assert!(cancelled.players[0].hand.contains(event));
 let done=e.apply(&choice,&e.card_action(&choice,target)).unwrap();assert_eq!(done.next_id,next+2);assert!(done.players[1].discard.contains(target));for token in [next,next+1] {assert_eq!(done.card(token).owner,Seat::P2);assert_eq!(done.card(token).parent,0);}assert_eq!(done.event_group,EventGroupState::default());
 let mut capacity=choice;capacity.next_id=255;let before=capacity;let error=e.apply(&capacity,&e.card_action(&capacity,target)).unwrap_err();assert!(error.contains("card capacity"));assert_eq!(capacity.zobrist(),before.zobrist());
}
#[test]
fn weakness4_inferno_preallocation_is_independent_from_shield_and_lethal_callback() {
 let e=engine();let mut s=board(&e);let target=unit(&e,&mut s,Seat::P2,"LOF_112");let source=hand(&e,&mut s,"HMW_202");for _ in 0..4 {let r=add(&e,&mut s,Seat::P1,"LOF_254");s.players[0].resources.push(r).unwrap();}let shield=s.next_id;e.create_token(&mut s,target,false).unwrap();e.create_token(&mut s,target,false).unwrap();let token=s.next_id;
 let choice=e.apply(&s,&e.card_action(&s,source)).unwrap();let done=e.apply(&choice,&e.card_action(&choice,target)).unwrap();assert_eq!(done.next_id,token+1);assert_eq!(done.card(target).damage,0);assert_eq!(done.card(shield).parent,0);assert_eq!(e.token_count(&done,done.card(target).shield),1);assert_eq!(done.card(token).parent,target);assert_eq!(done.card(token).owner,Seat::P2);assert_eq!(e.hp(&done,target),e.hp(&s,target)-1);
 for hp in [1,2] {let mut s=board(&e);let target=unit(&e,&mut s,Seat::P2,"LOF_129");s.card_mut(target).phase_hp=hp as i32-e.hp(&s,target) as i32;let source=hand(&e,&mut s,"HMW_202");for _ in 0..4 {let r=add(&e,&mut s,Seat::P1,"LOF_254");s.players[0].resources.push(r).unwrap();}let token=s.next_id;let choice=e.apply(&s,&e.card_action(&s,source)).unwrap();let pending=e.apply(&choice,&e.card_action(&choice,target)).unwrap();assert!(pending.players[1].discard.contains(target));assert_eq!(pending.card(token).parent,0);assert_eq!(pending.next_id,token+1);assert!(pending.players[1].force_held);}
}
#[test]
fn weakness4_picador_actual_new_beast_is_friendly_mandatory_target() {
 let e=engine();let mut s=board(&e);let enemy=unit(&e,&mut s,Seat::P2,"LOF_112");let source=hand(&e,&mut s,"HMW_199");let beast=s.next_id;let choice=e.apply(&s,&e.card_action(&s,source)).unwrap();assert_eq!(choice.decision,Decision::AbilityTarget);assert!(e.in_arena(&choice,beast));assert!(choice.card(beast).exhausted);let ids=e.legal_actions(&choice).iter().filter_map(Action::id).collect::<Vec<_>>();assert!(ids.contains(&source)&&ids.contains(&beast)&&!ids.contains(&enemy));assert!(!e.legal_actions(&choice).iter().any(|a|["Pass","Cancel","Choose nothing"].contains(&a.label.as_str())));let weak=choice.next_id;let done=e.apply(&choice,&e.card_action(&choice,beast)).unwrap();assert_eq!(done.card(weak).parent,beast);assert_eq!(done.card(weak).owner,Seat::P1);assert_eq!(e.hp(&done,beast),2);assert_eq!(e.power(&done,beast,false),2);
}
#[test]
fn weakness4_sequence_settles_physical_death_but_holds_parent_registration() {
 let e=engine();for unique in [false,true] {let mut s=board(&e);let target=unit(&e,&mut s,Seat::P2,if unique {"HMW_082"}else {"LOF_112"});let source=hand(&e,&mut s,"HMW_231");let choice=e.apply(&s,&e.card_action(&s,source)).unwrap();let done=e.apply(&choice,&e.card_action(&choice,target)).unwrap();assert_eq!(done.card(target).exhausted,unique);}
 let mut s=board(&e);let target=unit(&e,&mut s,Seat::P2,"LOF_129");s.card_mut(target).damage=e.hp(&s,target)-1;let source=hand(&e,&mut s,"HMW_231");let token=s.next_id;let choice=e.apply(&s,&e.card_action(&s,source)).unwrap();let done=e.apply(&choice,&e.card_action(&choice,target)).unwrap();assert!(done.players[1].discard.contains(target));assert_eq!(done.card(token).parent,0);assert!(done.players[1].force_held);assert_eq!(done.event_group,EventGroupState::default());
}
#[test]
fn weakness4_pending_generation_and_direct_mutable_capacity_are_exact() {
 let e=engine();let mut s=board(&e);let source=unit(&e,&mut s,Seat::P1,"HMW_202");let target=unit(&e,&mut s,Seat::P2,"LOF_112");let shield=s.next_id;e.create_token(&mut s,target,false).unwrap();let program=e.def(&s,source).programs.card[0];let pc=e.program(program).instructions.iter().position(|i|i.group_effect().is_some()).unwrap();let effect=e.program(program).instructions[pc].group_effect().unwrap().clone();s.source=source;s.ability_program=program as u16+1;s.ability_pc=pc as u8;s.ability_target=target;s.event_group.active=true;s.event_group.context=Selection::one(target);let token=s.next_id;
 let mut capacity=s;capacity.next_id=256;let before=capacity.zobrist();assert!(e.generate_group(&mut capacity,&effect).unwrap_err().contains("card capacity"));assert_eq!(capacity.zobrist(),before);
 let mut capacity=s;capacity.event_group.count=32;let before=capacity.zobrist();assert!(e.generate_group(&mut capacity,&effect).unwrap_err().contains("prepared"));assert_eq!(capacity.zobrist(),before);
 assert!(e.generate_group(&mut s,&effect).unwrap());assert_eq!(s.next_id,token+1);assert_eq!(s.card(token).parent,0);assert_eq!(s.card(token).owner,Seat::P2);assert_eq!(s.card(target).shield,shield);assert_eq!(s.card(target).damage,0);let copied=s;assert_eq!(copied.zobrist(),s.zobrist());assert!(e.resolve_group(&mut s,&effect).unwrap());assert_eq!(s.card(shield).parent,0);assert_eq!(s.card(token).parent,target);assert_eq!(s.card(target).damage,0);
}
#[test]
fn weakness4_picador_captured_dead_source_and_selected_pool_dependencies() {
 let e=engine();let mut s=board(&e);let snoke=unit(&e,&mut s,Seat::P2,"SHD_037");let source=hand(&e,&mut s,"HMW_199");let beast=s.next_id;let choice=e.apply(&s,&e.card_action(&s,source)).unwrap();assert!(choice.players[0].discard.contains(source));assert!(e.in_arena(&choice,snoke));assert!(e.in_arena(&choice,beast));assert_eq!(e.hp(&choice,beast),1);assert_eq!(choice.decision,Decision::AbilityTarget);let token=choice.next_id;let done=e.apply(&choice,&e.card_action(&choice,beast)).unwrap();assert_eq!(done.next_id,token+1);assert!(!e.in_arena(&done,beast));assert_eq!(done.card(beast).parent,0);assert_eq!(done.card(token).parent,0);assert_eq!(done.card(beast).owner,Seat::P1);assert_eq!(done.card(token).owner,Seat::P1);
 let catalogue:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();let pool=e.compiled_pool().unwrap();for missing in ["TOKEN_WEAKNESS","TOKEN_BEAST"] {let mut p=pool.clone();p["cards"].as_array_mut().unwrap().retain(|c|c["setCode"]!=missing);assert!(Engine::from_compiled_pool_bytes(&serde_json::to_vec(&p).unwrap(),&serde_json::to_vec(&catalogue).unwrap()).is_err(),"{missing}");}
 for side in ["unit","leader"] {let mut c=catalogue.clone();let card=c["cards"].as_array_mut().unwrap().iter_mut().find(|e|e["setCode"]=="HMW_199").unwrap();card["abilities"][side]=card["abilities"]["card"].clone();card["abilities"]["card"]=json!([]);assert!(!Engine::from_catalogue_value(&c).unwrap().by_code.contains_key("HMW_199"));}
}
#[test]
fn weakness4_beast_dependency_requires_compiled_admission_and_outer_shape() {
 let original:Value=serde_json::from_slice(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap();let valid=engine();let pool=valid.compiled_pool().unwrap();
 for (field,value) in [("attachCondition",json!({"kind":"const","value":true})),("piloting",json!({"unmodeled":true})),("status",json!("unsupported")),("abilities",json!({"leader":[],"unit":[],"card":[{"trigger":"unknown","title":"Injected","effect":{"kind":"noAction"}}]}))] {
  let mut c=original.clone();let token=c["cards"].as_array_mut().unwrap().iter_mut().find(|e|e["setCode"]=="TOKEN_BEAST").unwrap();token[field]=value;let altered=Engine::from_catalogue_value(&c).unwrap();assert!(!altered.by_code.contains_key("HMW_199"),"{field}");assert!(altered.rejected_cards().unwrap()["HMW_199"].contains("Beast token unavailable"),"{field}");assert!(Engine::from_compiled_pool_bytes(&serde_json::to_vec(&pool).unwrap(),&serde_json::to_vec(&c).unwrap()).is_err(),"{field}");
 }
}
