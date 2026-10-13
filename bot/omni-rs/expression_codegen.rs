//! Build-time lowering of pure expressions. Event scheduling remains in the runtime.
use crate::ability_ir::Expr;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub fn expression(e: &Expr) -> Result<String, String> {
    let sub = expression;
    Ok(match e {
        Expr::Const { value } => {
            if let Some(n) = value.as_i64() {
                format!("Eval::Number({n}i64)")
            } else if let Some(b) = value.as_bool() {
                format!("Eval::Bool({b})")
            } else if let Some(t) = value.as_str() {
                format!("Eval::Text({t:?}.into())")
            } else {
                "Eval::Null".into()
            }
        }
        Expr::Array { items } => format!(
            "Eval::Array(vec![{}])",
            items
                .iter()
                .map(sub)
                .collect::<Result<Vec<_>, _>>()?
                .join(",")
        ),
        Expr::Math { name, args } => {
            if !["min", "max"].contains(&name.as_str()) {
                return Err("unknown math operation".into());
            }
            format!(
                "Eval::Number([{}].into_iter().{name}().unwrap_or(0))",
                args.iter()
                    .map(|a| Ok(format!("({}).number()", sub(a)?)))
                    .collect::<Result<Vec<_>, String>>()?
                    .join(",")
            )
        }
        Expr::Ref { path } => reference(path)?,
        Expr::Unary { op, value } => match op.as_str() {
            "!" => format!("Eval::Bool(!({}).truth())", sub(value)?),
            "-" => format!("Eval::Number(({}).number().saturating_neg())", sub(value)?),
            _ => return Err("unknown unary operation".into()),
        },
        Expr::Binary { op, left, right } => {
            let a = sub(left)?;
            let b = sub(right)?;
            let operation = match op.as_str() {
                "&&" => return Ok(format!("{{let a={a};if !a.truth() {{a}} else {{{b}}}}}")),
                "||" => return Ok(format!("{{let a={a};if a.truth() {{a}} else {{{b}}}}}")),
                "+" => "Eval::Number(a.number().saturating_add(b.number()))",
                "-" => "Eval::Number(a.number().saturating_sub(b.number()))",
                "*" => "Eval::Number(a.number().saturating_mul(b.number()))",
                "/" => "Eval::Number(a.number().checked_div(b.number()).unwrap_or(0))",
                "%" => "Eval::Number(a.number().checked_rem(b.number()).unwrap_or(0))",
                "==" | "===" => "Eval::Bool(a==b)",
                "!=" | "!==" => "Eval::Bool(a!=b)",
                "<" => "Eval::Bool(a.number()<b.number())",
                "<=" => "Eval::Bool(a.number()<=b.number())",
                ">" => "Eval::Bool(a.number()>b.number())",
                ">=" => "Eval::Bool(a.number()>=b.number())",
                _ => return Err("unknown binary operation".into()),
            };
            format!("{{let a={a};let b={b};{operation}}}")
        }
        Expr::Conditional {
            condition,
            then,
            r#else,
        } => format!(
            "if ({}).truth() {{{}}} else {{{}}}",
            sub(condition)?,
            sub(then)?,
            sub(r#else)?
        ),
        Expr::Query {
            name,
            receiver,
            args,
        } => query(name, receiver, args)?,
        Expr::Compiled(c) => expression(&c.original)?,
    })
}
fn reference(path: &[String]) -> Result<String, String> {
    let p: Vec<_> = path.iter().map(String::as_str).collect();
    let root = p.first().copied().unwrap_or("");
    let field = p.get(1).copied();
    if root == "event" {
        return Ok("Eval::Number(s.ability_result as i64)".into());
    }
    if root == "player" || root == "opponent" {
        let player = if root == "player" {
            "s.card(source).owner"
        } else {
            "s.card(source).owner.other()"
        };
        let value=match field {
            None=>"Eval::Player(player)",
            Some("base") if p.get(2)==Some(&"damage")=>"Eval::Number(s.card(s.player(player).base).damage as i64)",
            Some("base")=>"Eval::Card(s.player(player).base)",
            Some("readyResourceCount")=>"Eval::Number(self.ready_resources(s,player) as i64)",
            Some("exhaustedResourceCount")=>"Eval::Number(s.player(player).resources.len as i64-self.ready_resources(s,player) as i64)",
            Some("resources")=>"Eval::Number(s.player(player).resources.len as i64)",
            Some("hand")=>"Eval::Number(s.player(player).hand.len as i64)",
            Some("drawDeck")=>"Eval::Number(s.player(player).deck.len as i64)",
            Some("discard")=>"Eval::Number(s.player(player).discard.len as i64)",
            _=>return Err("unsupported player field".into()),
        };
        return Ok(format!("{{let player={player};{value}}}"));
    }
    if root == "modifierTarget" {
        let value = match p.as_slice() {
            ["modifierTarget"] => "Eval::Card(modifier_target)",
            ["modifierTarget", "damage"] => "Eval::Number(s.card(modifier_target).damage as i64)",
            ["modifierTarget", "controller"] => "Eval::Player(s.card(modifier_target).owner)",
            ["modifierTarget", "controller", "resources", "length"] => {
                "Eval::Number(s.player(s.card(modifier_target).owner).resources.len as i64)"
            }
            _ => return Err("unsupported modifier field".into()),
        };
        return Ok(format!("{{assert!(modifier_target!=0,\"modifierTarget unavailable outside persistent stat evaluation\");{value}}}"));
    }
    if p == ["card", "activeAttack", "attacker"] {
        return Ok("Eval::Card(self.active_attack_pair(s,card).0)".into());
    }
    if root == "source" && matches!(field, Some("parentCard" | "parentUnit")) {
        return Err("attached-parent reference retains interpreter scope".into());
    }
    let id = match root {
        "source" => "source",
        "card" => "card",
        "target" => "target",
        _ => return Err("unknown reference root".into()),
    };
    let value = match field {
        None => "Eval::Card(id)",
        Some("controller") => "Eval::Player(s.card(id).owner)",
        Some("damage") => "Eval::Number(s.card(id).damage as i64)",
        Some("power") => "Eval::Number(self.evaluated_power(s,id))",
        Some("hp") => "Eval::Number(self.evaluated_hp(s,id))",
        Some("remainingHp") => {
            "Eval::Number(self.hp(s,id).saturating_sub(s.card(id).damage) as i64)"
        }
        Some("title") => "Eval::Text(self.def(s,id).info.title.clone())",
        Some("cost" | "printedCost") => "Eval::Number(self.def(s,id).info.cost() as i64)",
        Some("exhausted") => "Eval::Bool(s.card(id).exhausted)",
        Some("unique") => "Eval::Bool(self.def(s,id).info.unique)",
        Some("zoneName") => return Err("zone-name reference retains interpreter".into()),
        _ => return Err("unsupported card field".into()),
    };
    Ok(format!(
        "{{let id={id};if id==0 {{Eval::Null}} else {{{value}}}}}"
    ))
}
fn query(name: &str, receiver: &Expr, args: &[Expr]) -> Result<String, String> {
    let receiver = expression(receiver)?;
    if name == "arenaUnitCount" || name == "hasSomeArenaUnit" {
        let predicate = expression(args.first().ok_or("arena query needs predicate")?)?;
        let result = if name == "arenaUnitCount" {
            "Eval::Number(count)"
        } else {
            "Eval::Bool(count>0)"
        };
        // Match the interpreter's full traversal; no changed query evaluation time.
        return Ok(format!("{{if let Eval::Player(player)={receiver} {{let count=s.player(player).ground.as_slice().iter().chain(s.player(player).space.as_slice()).filter(|&&card|({predicate}).truth()).count() as i64;{result}}} else {{Eval::Null}}}}"));
    }
    if name == "resourcePairs" {
        return Ok(format!("if let Eval::Player(player)={receiver} {{Eval::Number(s.player(player).resources.len as i64/2)}} else {{Eval::Null}}"));
    }
    if name == "hasInitiative" {
        return Ok(format!(
            "Eval::Bool(matches!({receiver},Eval::Player(p) if s.initiative==p))"
        ));
    }
    let body=match name {
        "isUnit"=>"Eval::Bool(d.info.is(\"unit\")||(d.info.is(\"leader\")&&s.card(id).deployed))".into(),
        "isTokenUnit"=>"Eval::Bool(d.info.is(\"token\")&&d.info.is(\"unit\"))".into(),
        "isNonLeaderUnit"=>"Eval::Bool(d.info.is(\"unit\")&&!d.info.is(\"leader\"))".into(),
        "isToken"=>"Eval::Bool(d.info.is(\"token\"))".into(),
        "isBase"=>"Eval::Bool(d.info.is(\"base\"))".into(),
        "isLeader"=>"Eval::Bool(d.info.is(\"leader\"))".into(),
        "isAttacking"=>"Eval::Bool(self.is_attacking(s,id))".into(),
        "isDefending"=>"Eval::Bool(self.is_defending(s,id))".into(),
        "isInPlay"=>"Eval::Bool(self.in_arena(s,id)||self.attached_in_play(s,id)||d.info.is(\"base\"))".into(),
        "canBeExhausted"=>"Eval::Bool(d.info.is(\"unit\")||d.info.is(\"leader\")||d.info.is(\"event\")||d.info.is(\"upgrade\"))".into(),
        "isUpgraded"=>"Eval::Bool(s.card(id).shield!=0||s.card(id).experience!=0||s.card(id).upgrades!=0)".into(),
        "getPower"=>"Eval::Number(self.evaluated_power(s,id))".into(),
        "getHp"=>"Eval::Number(self.evaluated_hp(s,id))".into(),
        "getCost"|"getPrintedCost"=>"Eval::Number(d.info.cost() as i64)".into(),
        "hasSomeTrait"|"hasSomeAspect"|"hasSomeKeyword"=>{
            let values=match args.first() {Some(Expr::Array {items})=>items.iter().collect::<Vec<_>>(),Some(e)=>vec![e],None=>vec![]};
            let mut checks=vec![];
            for v in values {
                let Expr::Const {value}=v else {return Err("dynamic trait/aspect/keyword argument retains interpreter".into())};
                let Some(t)=value.as_str() else {checks.push("false".into());continue};
                checks.push(match name {
                    "hasSomeTrait"=>format!("d.traits.iter().any(|t|t=={t:?})"),
                    "hasSomeAspect"=>format!("d.info.aspects().iter().any(|t|t=={t:?})"),
                    _=>format!("self.has_keyword(s,id,{t:?})"),
                });
            }
            format!("Eval::Bool({})",if checks.is_empty(){"false".into()}else{checks.join("||")})
        },
        _=>return Err(format!("query {name} retains interpreter")),
    };
    Ok(format!("if let Eval::Card(id)={receiver} {{if id==0 {{Eval::Null}} else {{let d=self.def(s,id);{body}}}}} else {{Eval::Null}}"))
}

pub fn generate(values: impl IntoIterator<Item = Value>) -> String {
    fn collect(v: &Value, expressions: &mut BTreeMap<String, (Vec<u8>, Expr)>) {
        if let Ok(e) = serde_json::from_value::<Expr>(v.clone()) {
            // Literals already have a cheap direct interpreter arm; don't add dispatch.
            if !matches!(e, Expr::Const { .. } | Expr::Array { .. }) {
                let bytes = serde_json::to_vec(&e).unwrap();
                expressions
                    .entry(format!("{:x}", Sha256::digest(&bytes)))
                    .or_insert((bytes, e));
            }
        }
    }
    let mut expressions = BTreeMap::new();
    for v in values {
        collect(&v, &mut expressions);
    }
    let mut lookup=String::from("pub(super) fn generated_expression_backend(hash:&str,canonical:&[u8])->Option<usize>{match hash{\n");
    let mut functions=String::from("impl Engine { # [allow(unused_variables,unused_parens,unused_braces)] fn generated_expression(&self,s:&State,source:CardId,target:CardId,card:CardId,modifier_target:CardId,index:usize)->Eval {match index {\n");
    let mut manifest = vec![];
    let mut index = 0;
    for (hash, (bytes, e)) in expressions {
        let canonical = String::from_utf8(bytes).unwrap();
        match expression(&e) {
            Ok(body) => {
                lookup.push_str(&format!(
                    "{hash:?} if canonical=={canonical:?}.as_bytes()=>Some({index}),\n"
                ));
                functions.push_str(&format!("{index}=>{{{body}}},\n"));
                manifest.push(serde_json::json!({"contentHash":hash,"index":index,"expression":e}));
                index += 1;
            }
            Err(reason) => manifest.push(
                serde_json::json!({"contentHash":hash,"fallbackReason":reason,"expression":e}),
            ),
        }
    }
    lookup.push_str("_=>None}}\n");
    functions.push_str("_=>unreachable!(\"invalid generated expression index\")}}}\n");
    format!(
        "{lookup}{functions}const GENERATED_EXPRESSIONS: &str = {:?};\n",
        serde_json::to_string(&manifest).unwrap()
    )
}
