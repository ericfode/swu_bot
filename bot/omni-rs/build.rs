//! Compile validated catalog programs into executable Rust, keyed by content.
#[allow(dead_code)]
#[path = "src/ability_ir.rs"]
mod ability_ir;
mod expression_codegen;
fn expression_backend(_bytes: &[u8]) -> Option<usize> { None }
use ability_ir::{Catalogue, Effect, Expr, Instruction, Program, Target};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, env, fs, path::PathBuf};
fn program_backend(_bytes: &[u8]) -> Result<usize, &'static str> {
    Err("build-time compiler")
}
fn number(e: &Expr) -> Result<String, String> {
    match e {
        Expr::Const { value } => value
            .as_i64()
            .map(|n| format!("{n}i64"))
            .ok_or("noninteger amount".into()),
        Expr::Unary { op, value } if op == "-" => {
            Ok(format!("({}).saturating_neg()", number(value)?))
        }
        Expr::Binary { op, left, right } if ["+", "-", "*"].contains(&op.as_str()) => Ok(format!(
            "({}).{}({})",
            number(left)?,
            match op.as_str() {
                "+" => "saturating_add",
                "-" => "saturating_sub",
                _ => "saturating_mul",
            },
            number(right)?
        )),
        _ => Err("amount expression requires interpreter".into()),
    }
}
fn targets(t: &Target) -> Result<String, String> {
    let Target::Name(n) = t else {
        return Err("expression target requires interpreter".into());
    };
    Ok(match n.as_str() {
        "self" => "vec![Eval::Card(s.source)]",
        "chosen" => "vec![Eval::Card(s.ability_target)]",
        "ownBase" => "vec![Eval::Card(s.player(s.card(s.source).owner).base)]",
        "enemyBase" => "vec![Eval::Card(s.player(s.card(s.source).owner.other()).base)]",
        "bothBases" => "vec![Eval::Card(s.players[0].base), Eval::Card(s.players[1].base)]",
        "ownPlayer" => "vec![Eval::Player(s.card(s.source).owner)]",
        "enemyPlayer" => "vec![Eval::Player(s.card(s.source).owner.other())]",
        "bothPlayers" => "vec![Eval::Player(Seat::P1), Eval::Player(Seat::P2)]",
        _ => return Err(format!("target {n} requires interpreter")),
    }
    .into())
}
fn primitive(e: &Effect) -> Result<String, String> {
    if matches!(e, Effect::NoAction) {
        return Ok("s.ability_result=0; s.ability_succeeded=false;".into());
    }
    if let Effect::ModifyStats {
        power,
        hp,
        duration,
        target,
    } = e
    {
        if duration != "phase" {
            return Err("persistent stat operation uses modifier backend".into());
        }
        let power = number(power)?;
        let hp = number(hp)?;
        let targets = targets(target)?;
        return Ok(format!(
            r#"let power={power};let hp={hp};let mut result=0u16;for target in {targets} {{if let Eval::Card(id)=target {{if id!=0 && self.in_arena(s,id) {{let next_power=s.card(id).phase_power as i64+power;let next_hp=s.card(id).phase_hp as i64+hp;if !(-65535..=65535).contains(&next_power)||!(-65535..=65535).contains(&next_hp) {{return Err("phase stat capacity exceeded".into());}}let composed_power=self.def(s,id).info.power.unwrap_or(0) as i64+self.token_count(s,s.card(id).experience) as i64+if self.keyword_amount(s,id,"grit")>0 {{s.card(id).damage as i64}} else {{0}}+next_power;let composed_hp=self.def(s,id).info.hp.unwrap_or(0) as i64+self.token_count(s,s.card(id).experience) as i64+next_hp;if composed_power>65535||composed_hp>65535 {{return Err("computed phase stats exceed capacity".into());}}s.card_mut(id).phase_power=next_power as i32;s.card_mut(id).phase_hp=next_hp as i32;result+=1;}}}}}}if !s.event_group.resolving {{self.sweep_stat_defeats(s)?;self.check_win(s);}}s.ability_result=result;s.ability_succeeded=result>0;"#
        ));
    }
    let (kind, target, amount) = match e {
        Effect::Draw { target, amount } => ("draw", target, number(amount)?),
        Effect::Damage { target, amount } => ("damage", target, number(amount)?),
        Effect::Heal { target, amount } => ("heal", target, number(amount)?),
        Effect::Ready { target } => ("ready", target, "1i64".into()),
        Effect::Exhaust { target } => ("exhaust", target, "1i64".into()),
        _ => return Err("effect operation requires interpreter".into()),
    };
    let operation=match kind {
        "draw"=>r#"if let Eval::Player(seat)=target { resolved |= amount>0; for _ in 0..amount { if let Some(id)=s.player_mut(seat).deck.pop_front() { s.player_mut(seat).hand.push(id)?; result=result.saturating_add(1); } else if !s.event_group.resolving {let base=s.player(seat).base;let hp=self.def(s,base).info.hp.unwrap_or(30) as u16;s.card_mut(base).damage=s.card(base).damage.saturating_add(3).min(hp);} }}"#,
        "damage"=>r#"if let Eval::Card(id)=target {if id!=0 && (self.in_arena(s,id)||self.def(s,id).info.is("base")) {resolved |= amount>0 && s.card(id).shield!=0;let before=s.card(id).damage;self.damage(s,id,amount);result=result.saturating_add(s.card(id).damage.saturating_sub(before));}}"#,
        "heal"=>r#"if let Eval::Card(id)=target {if id!=0 && (self.in_arena(s,id)||self.def(s,id).info.is("base")) {let heal=amount.min(s.card(id).damage);s.card_mut(id).damage-=heal;result=result.saturating_add(heal);}}"#,
        "ready"=>"if let Eval::Card(id)=target {if id!=0 && self.in_arena(s,id) {result+=u16::from(s.card(id).exhausted);s.card_mut(id).exhausted=false;}}",
        _=>"if let Eval::Card(id)=target {if id!=0 && self.in_arena(s,id) {result+=u16::from(!s.card(id).exhausted);s.card_mut(id).exhausted=true;}}",
    };
    Ok(format!("let raw_amount={amount};let amount=u16::try_from(raw_amount).map_err(|_|format!(\"effect amount {{raw_amount}} exceeds bounded runtime\"))?;let mut result=0u16;let mut resolved=false;for target in {} {{ {operation} }} if !s.event_group.resolving {{self.sweep_stat_defeats(s)?;self.check_win(s);}} s.ability_result=result;s.ability_succeeded=result>0||resolved;",targets(target)?))
}
fn lower(p: &Program) -> Result<String, String> {
    if p.trigger == "constant" {
        return Err("constant registration uses live modifier backend".into());
    }
    let mut body = String::from("match s.ability_pc {\n");
    for (pc, i) in p.instructions.iter().enumerate() {
        let step=match i {
            Instruction::EndStep=>"s.ability_pc+=1;".into(),
            Instruction::Commit=>"self.commit_program(s)?;s.ability_pc+=1;".into(),
            Instruction::Select(_)=>format!("let Instruction::Select(r)=&p.instructions[{pc}] else {{return Err(\"AOT selection identity mismatch\".into())}};if self.program_targets(s,s.source,s.ability_program-1,{pc},r,true).is_empty() {{s.ability_target=0;s.ability_selection=Selection::default();s.ability_pc+=1;}} else {{s.decision=Decision::AbilityTarget;return Ok(true);}}"),
            Instruction::IfResult {skip}=>format!("s.ability_pc=if s.ability_succeeded {{{}}}else{{{skip}}};",pc+1),
            Instruction::Jump {to}=>format!("s.ability_pc={to};"),
            Instruction::Apply(e)=>format!("self.commit_program(s)?;{}s.ability_pc+=1;",primitive(e)?),
            _=>return Err("instruction control/expression requires interpreter".into()),
        };
        body.push_str(&format!("{pc}=>{{{step}}},\n"));
    }
    body.push_str("_=>{self.end_program(s)?;return Ok(true);}} Ok(false)");
    Ok(body)
}
fn main() {
    println!("cargo:rerun-if-env-changed=SWU_RULES_CATALOGUE");
    let catalog = env::var_os("SWU_RULES_CATALOGUE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
                .join("../card-compiler/generated/catalog.json")
        });
    println!("cargo:rerun-if-changed={}", catalog.display());
    println!("cargo:rerun-if-changed=src/ability_ir.rs");
    let value =
        serde_json::from_slice(&fs::read(catalog).expect("committed ability catalog missing"))
            .expect("invalid committed catalog JSON");
    let c = Catalogue::load(&value).expect("invalid catalog schema");
    let mut roots = Vec::new();
    for mut program in c.programs.iter().cloned() {
        program.visit_expression_roots_mut(&mut |e| roots.push(serde_json::to_value(e).unwrap()));
    }
    roots.extend(c.cards.values().filter_map(|p|p.attach_condition.as_ref()).map(|e|serde_json::to_value(e).unwrap()));
    let expressions = expression_codegen::generate(roots);
    let mut programs = BTreeMap::new();
    for p in c.programs {
        let hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&p).unwrap()));
        let bytes = serde_json::to_vec(&p).unwrap();
        programs.entry(hash).or_insert_with(|| (bytes, lower(&p)));
    }
    let mut source=String::from("pub(super) fn generated_backend(hash:&str,canonical:&[u8])->Result<usize,&'static str> {match hash {\n");
    let mut functions=String::from("impl Engine {#[allow(unused_mut,unused_variables,unused_parens)] fn generated_step(&self,s:&mut State,p:&Program,index:usize)->Result<bool,String> {match index {\n");
    let mut ready = 0;
    for (hash, (bytes, body)) in programs {
        let canonical = String::from_utf8(bytes).unwrap();
        match body {
            Ok(body) => {
                source.push_str(&format!(
                    "\"{hash}\" if canonical=={canonical:?}.as_bytes()=>Ok({ready}),\n"
                ));
                functions.push_str(&format!("{ready}=>{{{body}}},\n"));
                ready += 1;
            }
            Err(reason) => source.push_str(&format!(
                "\"{hash}\" if canonical=={canonical:?}.as_bytes()=>Err({reason:?}),\n"
            )),
        }
    }
    source.push_str("_=>Err(\"program content absent from build catalog\")}}\n");
    functions.push_str("_=>Err(\"invalid AOT executable index\".into())}}}\n");
    source.push_str(&functions);
    source.push_str(&expressions);
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("rules_aot.rs"),
        source,
    )
    .unwrap();
}
