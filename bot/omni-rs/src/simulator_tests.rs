use super::*;
fn engine() -> Engine {
    Engine::from_pool_value(&serde_json::from_str(include_str!("../../omni/rs/pool.json")).unwrap())
        .unwrap()
}
fn add(e: &Engine, s: &mut State, seat: Seat, code: &str) -> CardId {
    let id = s.next_id;
    s.next_id += 1;
    s.cards[id as usize] = Card {
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
        let lead = add(e, &mut s, seat, leader);
        s.player_mut(seat).base = base;
        s.player_mut(seat).leader = lead;
    }
    s
}
fn unit(e: &Engine, s: &mut State, seat: Seat, code: &str) -> CardId {
    let id = add(e, s, seat, code);
    e.add_arena(s, id).unwrap();
    id
}
fn click(e: &Engine, s: State, id: CardId) -> State {
    e.apply(&s, &e.card_action(&s, id)).unwrap()
}
fn button(e: &Engine, s: State, label: &str) -> State {
    let a = e
        .legal_actions(&s)
        .into_iter()
        .find(|a| a.label == label)
        .unwrap_or_else(|| panic!("missing {label}: {:?}", e.legal_actions(&s)));
    e.apply(&s, &a).unwrap()
}
fn resources(e: &Engine, s: &mut State, seat: Seat, count: u8) {
    for _ in 0..count {
        let id = add(e, s, seat, "LOF_254");
        s.player_mut(seat).resources.push(id).unwrap();
    }
}

#[test]
fn state_is_inline_copy_and_hash_covers_prompts_and_deck_order() {
    fn copy<T: Copy>() {}
    copy::<State>();
    // Uniform arena damage retains 256 ordered targets; measured State size is 19,112 bytes.
    assert!(std::mem::size_of::<State>() < 20000, "inline state bytes: {}", std::mem::size_of::<State>());
    eprintln!("inline state bytes: {}; card bytes: {}", std::mem::size_of::<State>(), std::mem::size_of::<Card>());
    let e = engine();
    let mut s = board(&e);
    let a = add(&e, &mut s, Seat::P1, "LOF_254");
    let b = add(&e, &mut s, Seat::P1, "LOF_256");
    s.players[0].deck.push(a).unwrap();
    s.players[0].deck.push(b).unwrap();
    let original = s.zobrist();
    s.players[0].deck.ids.swap(0, 1);
    assert_ne!(original, s.zobrist());
    let order = s.zobrist();
    s.decision = Decision::AttackTarget;
    s.source = a;
    assert_ne!(order, s.zobrist());
}
#[test]
fn aspect_penalty_counts_each_missing_icon() {
    let e = engine();
    let mut s = board(&e);
    let id = add(&e, &mut s, Seat::P1, "HMW_082");
    assert_eq!(
        e.cost(&s, id),
        4,
        "two vigilance icons versus one from base costs +2"
    );
    let base = s.players[0].base;
    s.card_mut(base).def = *e.by_code.get("ASH_021").unwrap();
    assert_eq!(e.cost(&s, id), 6, "both missing icons each cost +2");
}
#[test]
fn sentinel_obeys_arena_and_saboteur_ignores_it() {
    let e = engine();
    let mut s = board(&e);
    let a = unit(&e, &mut s, Seat::P1, "ASH_173");
    let sentinel = unit(&e, &mut s, Seat::P2, "ASH_252");
    let other = unit(&e, &mut s, Seat::P2, "LOF_254");
    let target = e.attack_targets(&s, a, false);
    assert!(
        target.contains(&sentinel)
            && target.contains(&other)
            && target.contains(&s.players[1].base)
    );
    s.card_mut(a).def = *e.by_code.get("LOF_256").unwrap();
    assert_eq!(e.attack_targets(&s, a, false), vec![sentinel]);
    s.card_mut(a).def = *e.by_code.get("TWI_253").unwrap();
    assert_eq!(e.attack_targets(&s, a, false), vec![s.players[1].base]);
}
#[test]
fn raid_and_grit_are_dynamic_and_only_raid_needs_attacking() {
    let e = engine();
    let mut s = board(&e);
    let raid = unit(&e, &mut s, Seat::P1, "HMW_167");
    let grit = unit(&e, &mut s, Seat::P1, "HMW_179");
    s.card_mut(grit).damage = 3;
    assert_eq!(e.power(&s, raid, true) - e.power(&s, raid, false), 3);
    assert_eq!(e.power(&s, grit, true), 4);
    assert_eq!(e.power(&s, grit, false), 4);
    s.card_mut(grit).damage = 1;
    assert_eq!(e.power(&s, grit, false), 2);
}
#[test]
fn shield_replacement_prevents_overwhelm_contingent_damage() {
    let e = engine();
    let mut s = board(&e);
    let a = unit(&e, &mut s, Seat::P1, "ASH_029");
    let d = unit(&e, &mut s, Seat::P2, "ASH_069");
    let shield = add(&e, &mut s, Seat::P2, "TOKEN_SHIELD");
    s.card_mut(d).shield = shield;
    let s = click(&e, click(&e, s, a), d);
    assert!(s.is_action_window());
    assert_eq!(s.card(s.players[1].base).damage, 0);
    assert_eq!(s.card(d).damage, 0);
    assert_eq!(s.card(d).shield, 0);
    assert_eq!(s.card(a).damage, 1);
}
#[test]
fn saboteur_defeats_shield_before_combat_and_restore_precedes_damage() {
    let e = engine();
    let mut s = board(&e);
    let a = unit(&e, &mut s, Seat::P1, "ASH_256");
    let d = unit(&e, &mut s, Seat::P2, "ASH_069");
    let shield = add(&e, &mut s, Seat::P2, "TOKEN_SHIELD");
    s.card_mut(d).shield = shield;
    let base = s.players[0].base;
    s.card_mut(base).damage = 2;
    let s = click(&e, click(&e, s, a), d);
    assert_eq!(s.decision, Decision::TriggerOrder);
    assert_eq!(e.legal_actions(&s).len(), 2);
    let s = button(&e, s, "Restore 1");
    assert_eq!(s.card(base).damage, 1);
    assert!(s.players[1].discard.contains(d));
    assert_eq!(s.card(a).damage, 1);
}
#[test]
fn shield_prevention_on_both_sides_preserves_the_player_order_prompt() {
    let e = engine();
    let mut s = board(&e);
    let a = unit(&e, &mut s, Seat::P1, "ASH_069");
    let d = unit(&e, &mut s, Seat::P2, "ASH_069");
    for id in [a, d] {
        let shield = add(
            &e,
            &mut s,
            if id == a { Seat::P1 } else { Seat::P2 },
            "TOKEN_SHIELD",
        );
        s.card_mut(id).shield = shield;
    }
    let s = click(&e, click(&e, s, a), d);
    assert_eq!(s.decision, Decision::ShieldOrder);
    let mine = button(&e, s, "You");
    let theirs = button(&e, s, "Opponent");
    assert_eq!(mine, theirs);
    assert_eq!(mine.card(a).damage, 0);
    assert_eq!(mine.card(d).damage, 0);
}
#[test]
fn zero_power_leader_can_attack_to_restore_four() {
    let e = engine();
    let mut s = board(&e);
    let id = s.players[0].leader;
    s.card_mut(id).def = *e.by_code.get("SEC_005").unwrap();
    s.card_mut(id).deployed = true;
    s.card_mut(id).epic_used = true;
    e.add_arena(&mut s, id).unwrap();
    let base = s.players[0].base;
    s.card_mut(base).damage = 7;
    let enemy = s.players[1].base;
    let s = click(&e, click(&e, s, id), enemy);
    assert_eq!(s.card(base).damage, 3);
    assert_eq!(s.card(enemy).damage, 0);
    assert!(s.card(id).exhausted);
}
#[test]
fn unique_rule_gives_both_copies_as_explicit_defeat_choices() {
    let e = engine();
    let mut s = board(&e);
    resources(&e, &mut s, Seat::P1, 12);
    let old = unit(&e, &mut s, Seat::P1, "HMW_174");
    let new = add(&e, &mut s, Seat::P1, "HMW_174");
    s.players[0].hand.push(new).unwrap();
    let s = click(&e, s, new);
    assert_eq!(s.decision, Decision::Unique);
    assert_eq!(e.legal_actions(&s).len(), 2);
    let a = click(&e, s, old);
    let b = click(&e, s, new);
    assert!(a.players[0].ground.contains(new) && a.players[0].discard.contains(old));
    assert!(b.players[0].ground.contains(old) && b.players[0].discard.contains(new));
}
#[test]
fn defeated_leader_returns_exhausted_and_epic_action_stays_spent() {
    let e = engine();
    let mut s = board(&e);
    let leader = s.players[0].leader;
    s.card_mut(leader).deployed = true;
    s.card_mut(leader).epic_used = true;
    s.card_mut(leader).damage = 4;
    e.add_arena(&mut s, leader).unwrap();
    e.defeat(&mut s, leader).unwrap();
    assert!(!s.card(leader).deployed);
    assert!(s.card(leader).exhausted && s.card(leader).epic_used);
    assert_eq!(s.card(leader).damage, 0);
    assert!(!s.players[0].discard.contains(leader));
    resources(&e, &mut s, Seat::P1, 10);
    assert!(!e.leader_available(&s).0);
}
#[test]
fn regroup_draws_simultaneously_and_deck_out_can_draw_the_game() {
    let e = engine();
    let mut s = board(&e);
    let b1 = s.players[0].base;
    let b2 = s.players[1].base;
    s.card_mut(b1).damage = 27;
    s.card_mut(b2).damage = 28;
    let s = button(&e, button(&e, s, "Pass"), "Pass");
    assert!(s.is_terminal());
    assert_eq!(s.outcome, 3);
    assert!(s.regroup);
    assert_eq!(s.card(b1).damage, 30);
    assert_eq!(s.card(b2).damage, 30);
    assert!(!s.players[0].out && !s.players[1].out);
}
#[test]
fn drawing_one_available_card_takes_only_one_deck_out_hit() {
    let e = engine();
    let mut s = board(&e);
    let id = add(&e, &mut s, Seat::P1, "LOF_254");
    s.players[0].deck.push(id).unwrap();
    let s = button(&e, button(&e, s, "Pass"), "Pass");
    assert_eq!(s.decision, Decision::Resource);
    assert_eq!(s.card(s.players[0].base).damage, 3);
    assert_eq!(s.card(s.players[1].base).damage, 6);
    assert_eq!(s.players[0].hand.as_slice(), &[id]);
}
#[test]
fn successful_action_resets_pass_and_claimed_player_gets_no_more_windows() {
    let e = engine();
    let mut s = board(&e);
    resources(&e, &mut s, Seat::P2, 2);
    let id = add(&e, &mut s, Seat::P2, "LOF_254");
    s.players[1].hand.push(id).unwrap();
    let s = button(&e, s, "Pass");
    assert!(s.prev_passed);
    let s = click(&e, s, id);
    assert!(!s.prev_passed);
    assert_eq!(s.active, Seat::P1);
    let s = button(&e, s, "Claim Initiative");
    assert!(s.players[0].out);
    assert_eq!(s.active, Seat::P2);
    let lead = s.players[1].leader;
    let base = s.players[0].base;
    let s = click(&e, click(&e, s, lead), base);
    assert_eq!(s.active, Seat::P2);
}
#[test]
fn satine_branches_zero_one_two_including_overheal_and_opponents() {
    let e = engine();
    let mut s = board(&e);
    let leader = s.players[0].leader;
    s.card_mut(leader).def = *e.by_code.get("SEC_005").unwrap();
    let target = unit(&e, &mut s, Seat::P2, "LOF_256");
    s.card_mut(target).damage = 1;
    let s = click(&e, s, leader);
    assert_eq!(s.decision, Decision::SatineHeal);
    let actions = e.legal_actions(&s);
    assert_eq!(actions.len(), 3);
    for (i, a) in actions.iter().enumerate() {
        let t = e.apply(&s, a).unwrap();
        assert_eq!(t.card(t.players[0].base).damage, if i == 0 { 0 } else { 1 });
        assert_eq!(t.card(target).damage, if i == 0 { 1 } else { 0 });
    }
}
#[test]
fn ambush_is_optional_and_never_targets_a_base() {
    let e = engine();
    let mut s = board(&e);
    resources(&e, &mut s, Seat::P1, 6);
    let id = add(&e, &mut s, Seat::P1, "LOF_257");
    s.players[0].hand.push(id).unwrap();
    let target = unit(&e, &mut s, Seat::P2, "LOF_256");
    let s = click(&e, s, id);
    assert_eq!(s.decision, Decision::Ambush);
    let passed = button(&e, s, "Pass");
    assert!(passed.card(id).exhausted);
    let s = button(&e, s, "Trigger");
    assert_eq!(e.legal_actions(&s), vec![e.card_action(&s, target)]);
    let s = click(&e, s, target);
    assert!(s.is_action_window());
}
#[test]
fn on_attack_suicide_latches_winner_but_combat_still_finishes() {
    let e = engine();
    let mut s = board(&e);
    let id = s.players[1].leader;
    s.card_mut(id).deployed = true;
    s.card_mut(id).epic_used = true;
    e.add_arena(&mut s, id).unwrap();
    s.active = Seat::P2;
    let own = s.players[1].base;
    let enemy = s.players[0].base;
    s.card_mut(own).damage = 28;
    s.card_mut(enemy).damage = 28;
    let s = click(&e, click(&e, click(&e, s, id), enemy), own);
    assert_eq!(s.winner(), Some(Seat::P1));
    assert_eq!(s.card(own).damage, 30);
    assert_eq!(s.card(enemy).damage, 30);
}
#[test]
fn simultaneous_resource_choices_can_be_ordered_for_sound_proof() {
    let e = engine();
    let s = board(&e);
    let mut s = button(&e, button(&e, s, "Pass"), "Pass");
    e.order_regroup(&mut s, Seat::P2);
    assert_eq!(s.active, Seat::P2);
    let mut s = button(&e, s, "Skip Resourcing");
    e.order_regroup(&mut s, Seat::P2);
    assert_eq!(s.active, Seat::P1);
}

#[test]
fn hidden_keyword_text_is_boolean_and_consumes_the_whole_rule() {
    for text in ["Hidden","Hidden.","Hidden (This unit can't be attacked this phase.)","Hidden\nSaboteur","Hidden, Restore 2"] {let (flags,_,_)=keyword_text(text).unwrap();assert!(flags&(1<<8)!=0,"{text}");}
    for text in [".","Hidden 1","Hidden 2","Hidden -1","Hidden extra","Hidden\nDraw a card.","This unit gains Hidden.","Hidden (unclosed","Hidden)","Restore 2 extra","Raid 65536","Raid","Restore 1.5","Restore -1"] {assert!(keyword_text(text).is_err(),"{text}");}
    assert_eq!(keyword_text("Hidden\nRaid 2\nRestore 1").unwrap(),(1<<8,2,1));
}

#[test]
fn strict_hundred_card_pool_keyword_semantics_remain_exact() {
    let raw:serde_json::Value=serde_json::from_str(include_str!("../../omni/rs/pool.json")).unwrap();assert_eq!(raw["cards"].as_array().unwrap().len(),100);
    let e=Engine::from_pool_value(&raw).unwrap();
    for c in raw["cards"].as_array().unwrap() {if !c["types"].as_array().unwrap().iter().any(|t|t=="unit") {continue;}
        let d=&e.definitions[*e.by_code.get(c["setCode"].as_str().unwrap()).unwrap() as usize];
        for (index,name) in crate::ability_ir::CORE_KEYWORDS.iter().enumerate() {let expected=c["keywordValues"][*name].as_u64().unwrap_or(0) as u16;let actual=match crate::ability_ir::numeric_keyword_slot(index) {Some(0)=>d.raid,Some(1)=>d.restore,_=>u16::from(d.flags&(1<<index)!=0)};assert_eq!(actual,expected,"{} {name}",d.code);}
    }
}

#[test]
fn strict_pool_does_not_infer_new_hidden_leader_or_pilot_implementations() {
    let raw:serde_json::Value=serde_json::from_str(include_str!("../../omni/rs/pool.json")).unwrap();
    for (kind,field,value) in [("leader","text",serde_json::json!("Hidden")),("unit","pilotText",serde_json::json!("Hidden"))] {let mut bad=raw.clone();let card=bad["cards"].as_array_mut().unwrap().iter_mut().find(|c|c["types"].as_array().unwrap().iter().any(|t|t==kind)).unwrap();card[field]=value;assert!(Engine::from_pool_value(&bad).is_err());}
    let mut bad=raw;bad["cards"][0]["setCode"]=serde_json::json!("ASH_166");assert!(Engine::from_pool_value(&bad).is_err());
}

#[test]
fn shared_keyword_grammar_matrix_is_fail_closed() {
    let cases:serde_json::Value=serde_json::from_str(include_str!("../../omni/rs/keyword-parser-cases.json")).unwrap();
    for case in cases.as_array().unwrap() {let text=case["text"].as_str().unwrap();let result=keyword_text(text);if case["expected"].is_null(){assert!(result.is_err(),"{text}");}else{let (flags,raid,restore)=result.unwrap();let mut actual=serde_json::Map::new();for (index,name) in crate::ability_ir::CORE_KEYWORDS.iter().enumerate(){if let Some(slot)=crate::ability_ir::numeric_keyword_slot(index){if case["expected"].get(*name).is_some(){actual.insert((*name).into(),serde_json::json!(if slot==0{raid}else{restore}));}}else if flags&(1<<index)!=0 {actual.insert((*name).into(),serde_json::json!(1));}}assert_eq!(serde_json::Value::Object(actual),case["expected"],"{text}");}}
}
fn captured_wp_engine() -> Engine {
    Engine::from_catalogue_bytes(include_bytes!("../../card-compiler/generated/catalog.json")).unwrap()
}
fn captured_wp_board(e:&Engine,seat:Seat)->State {
    let mut s=board(e);s.active=seat;s.action_player=Some(seat);s.hidden_history_exact=true;s.force_state_exact=true;
    for player in [Seat::P1,Seat::P2] {s.player_mut(player).force_id=s.next_id;s.next_id+=1;}
    s
}
#[test]
fn ambush_resumes_captured_ordinary_wp_after_mutual_death_and_with_living_source() {
    // Primitive declaration construction; all registrations/data are the actual
    // Sabine card. The separate engine recording proves normal play/cost timing.
    let e=captured_wp_engine();
    for seat in [Seat::P1,Seat::P2] {for lethal in [false,true] {
        let mut s=captured_wp_board(&e,seat);let source=unit(&e,&mut s,seat,"LAW_078");s.card_mut(source).exhausted=true;
        let victim=unit(&e,&mut s,seat.other(),if lethal {"ASH_190"}else{"LOF_254"});
        let host=unit(&e,&mut s,seat.other(),"LOF_254");let upgrade=add(&e,&mut s,seat.other(),"HMW_235");e.attach(&mut s,upgrade,host);
        s.source=source;e.capture_enter_triggers(&mut s);e.process_triggers(&mut s).unwrap();s=button(&e,s,"Ambush");s=button(&e,s,"Trigger");s=click(&e,s,victim);
        assert_eq!(e.in_arena(&s,source),!lethal);assert!(!e.in_arena(&s,victim));assert_eq!(s.active,seat);assert_eq!(s.decision,Decision::AbilityOptional);assert_eq!(s.source,source);assert_eq!(s.after_attack_programs,0);assert_eq!(s.after_attack_triggers,0);
        s=button(&e,s,"Trigger");assert_eq!(s.decision,Decision::AbilityTarget);assert!(e.legal_actions(&s).iter().any(|a|a.id()==Some(upgrade)));
        s=click(&e,s,upgrade);assert!(s.player(seat.other()).discard.contains(upgrade));assert_eq!(s.card(upgrade).parent,0);assert_eq!(e.in_arena(&s,source),!lethal);assert_eq!(s.active,seat.other());assert_eq!(s.decision,Decision::Window);
    }}
}
#[test]
fn ambush_dead_source_without_effective_captured_wp_finishes_action() {
    let e=captured_wp_engine();for seat in [Seat::P1,Seat::P2] {
        let mut s=captured_wp_board(&e,seat);let source=unit(&e,&mut s,seat,"LAW_078");let victim=unit(&e,&mut s,seat.other(),"ASH_190");s.source=source;s.card_mut(source).exhausted=true;e.capture_enter_triggers(&mut s);e.process_triggers(&mut s).unwrap();s=button(&e,s,"Ambush");s=button(&e,s,"Trigger");s=click(&e,s,victim);assert!(!e.in_arena(&s,source));assert_eq!(s.decision,Decision::Window);assert_eq!(s.active,seat.other());assert_eq!(s.pending_programs,0);assert_eq!(s.after_attack_programs,0);
    }
}
#[test]
fn dead_undeployed_leader_keeps_existing_side_index_policy() {
    // Synthetic pending-bit boundary: leaders do not capture WhenPlayed in
    // capture_enter_triggers; do not reinterpret an old unit-side index on base.
    let e=captured_wp_engine();let mut s=captured_wp_board(&e,Seat::P1);let source=s.players[0].leader;s.source=source;s.after_attack_programs=1;assert!(!e.in_arena(&s,source));e.combat_after_damage(&mut s).unwrap();assert_eq!(s.decision,Decision::Window);assert_eq!(s.active,Seat::P2);assert_eq!(s.pending_programs,0);assert_eq!(s.after_attack_programs,0);
}
#[test]
fn dead_ambush_source_without_captured_programs_finishes_existing_keyword_window() {
    let e=captured_wp_engine();for seat in [Seat::P1,Seat::P2] {
        let mut s=captured_wp_board(&e,seat);let source=unit(&e,&mut s,seat,"LOF_231");s.source=source;
        // The actual Shielded registration has no legal recipient after source
        // departure. This postcombat primitive must not allocate or rebind it.
        s.after_attack_triggers=T_SHIELD;let next=s.next_id;e.defeat(&mut s,source).unwrap();e.combat_after_damage(&mut s).unwrap();assert_eq!(s.decision,Decision::Window);assert_eq!(s.active,seat.other());assert_eq!(s.next_id,next);assert_eq!(s.after_attack_triggers,0);assert_eq!(s.after_attack_programs,0);
    }
}
#[test]
fn shielded_retains_bulk_shield_chain_in_both_trigger_orders() {
 let e=captured_wp_engine();for seat in [Seat::P1,Seat::P2] {for intrinsic_first in [false,true] {let mut s=captured_wp_board(&e,seat);s.arena_order_exact=true;for _ in 0..16 {let id=add(&e,&mut s,seat,"LOF_254");s.player_mut(seat).resources.push(id).unwrap();}let source=add(&e,&mut s,seat,"ASH_064");s.player_mut(seat).hand.push(source).unwrap();let first=s.next_id;s=click(&e,s,source);assert_eq!(s.decision,Decision::TriggerOrder);s=button(&e,s,if intrinsic_first{"Shielded"}else{"Give a Shield token to each friendly unit with Shielded"});assert_eq!(s.decision,Decision::Window);assert_eq!(s.next_id,first+2);assert_eq!(e.upgrades(&s,source),vec![first,first+1]);assert_eq!(s.card(source).shield,first+1);assert_eq!(s.card(first+1).next_token,first);assert_eq!(s.card(first).next_token,0);for id in [first,first+1]{assert_eq!(s.card(id).parent,source);assert_eq!(s.card(id).owner,seat);}e.validate_attachment_links(&s).unwrap();let copy=s;assert_eq!(copy.zobrist(),s.zobrist());
 e.damage(&mut s,source,3);assert_eq!(s.card(source).damage,0);assert_eq!(e.upgrades(&s,source),vec![first+1]);assert_eq!(s.card(source).shield,first+1);assert_eq!(s.card(first).parent,0);assert_eq!(s.card(first).next_token,0);assert_eq!(s.card(first+1).next_token,0);e.validate_attachment_links(&s).unwrap();e.damage(&mut s,source,2);assert_eq!(s.card(source).damage,0);assert!(e.upgrades(&s,source).is_empty());assert_eq!(s.card(source).shield,0);assert_eq!(s.card(first+1).parent,0);e.validate_attachment_links(&s).unwrap();e.damage(&mut s,source,1);assert_eq!(s.card(source).damage,1);}}
}
