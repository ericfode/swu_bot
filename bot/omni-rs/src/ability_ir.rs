//! Portable, data-only card abilities emitted by the TypeScript card compiler.
//!
//! The IR is deliberately smaller than TypeScript. It cannot call back into JS,
//! access host state, or smuggle an unimplemented engine operation through a
//! callback. Loading a card validates every instruction before play can begin.
use serde::{Deserialize, Serialize};
use serde_json::Value;

// Inspect every serialized expression position, including selectors and continuations.
pub(crate) fn contains_force_presence<T: Serialize>(value:&T)->bool {
    fn visit(v:&Value)->bool {match v {
        Value::Object(o)=> (o.get("kind").is_some_and(|k|k=="ref") && o.get("path").and_then(Value::as_array).is_some_and(|p|p.last().is_some_and(|v|v=="hasTheForce"))) || (o.get("kind").is_some_and(|k|k=="query") && o.get("name").is_some_and(|n|n=="hasTheForce")) || o.values().any(visit),
        Value::Array(a)=>a.iter().any(visit),_=>false,
    }}
    visit(&serde_json::to_value(value).expect("typed IR serializes"))
}

pub const SCHEMA: &str = "swu-card-ir/v1";
pub const MAX_PROGRAM_INSTRUCTIONS: usize = 128;
pub const MAX_GROUP_RECORDS: usize = 32;
pub const MAX_GROUP_OPS: usize = 128;
pub const MAX_ABILITY_NESTING: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Expr {
    Array {
        items: Vec<Expr>,
    },
    Math {
        name: String,
        args: Vec<Expr>,
    },
    Const {
        value: Value,
    },
    Ref {
        path: Vec<String>,
    },
    Binary {
        op: String,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Unary {
        op: String,
        value: Box<Expr>,
    },
    Conditional {
        condition: Box<Expr>,
        then: Box<Expr>,
        r#else: Box<Expr>,
    },
    Query {
        name: String,
        receiver: Box<Expr>,
        #[serde(default)]
        args: Vec<Expr>,
    },
}
impl Expr {
    fn references_title(&self) -> bool {
        match self {
            Self::Ref {path}=>path.last().is_some_and(|p|p=="title"),
            Self::Array {items}=>items.iter().any(Self::references_title),Self::Math {args,..}=>args.iter().any(Self::references_title),Self::Unary {value,..}=>value.references_title(),Self::Binary {left,right,..}=>left.references_title()||right.references_title(),Self::Conditional {condition,then,r#else}=>condition.references_title()||then.references_title()||r#else.references_title(),Self::Query {receiver,args,..}=>receiver.references_title()||args.iter().any(Self::references_title),_=>false,
        }
    }
    fn depends_on_stats(&self) -> bool {
        match self {
            Self::Const { .. } => false,
            Self::Ref { path } => path
                .iter()
                .any(|p| ["power", "hp", "remainingHp"].contains(&p.as_str())),
            Self::Array { items } => items.iter().any(Self::depends_on_stats),
            Self::Math { args, .. } => args.iter().any(Self::depends_on_stats),
            Self::Binary { left, right, .. } => left.depends_on_stats() || right.depends_on_stats(),
            Self::Unary { value, .. } => value.depends_on_stats(),
            Self::Conditional {
                condition,
                then,
                r#else,
            } => {
                condition.depends_on_stats() || then.depends_on_stats() || r#else.depends_on_stats()
            }
            Self::Query {
                name,
                receiver,
                args,
            } => {
                ["getPower", "getHp"].contains(&name.as_str())
                    || receiver.depends_on_stats()
                    || args.iter().any(Self::depends_on_stats)
            }
        }
    }
    fn depends_on_keywords(&self) -> bool {
        match self {
            Self::Const { .. } => false,
            Self::Ref { path } => path
                .iter()
                .any(|p| ["power", "hp", "remainingHp"].contains(&p.as_str())),
            Self::Array { items } => items.iter().any(Self::depends_on_keywords),
            Self::Math { args, .. } => args.iter().any(Self::depends_on_keywords),
            Self::Binary { left, right, .. } => left.depends_on_keywords() || right.depends_on_keywords(),
            Self::Unary { value, .. } => value.depends_on_keywords(),
            Self::Conditional {
                condition,
                then,
                r#else,
            } => {
                condition.depends_on_keywords() || then.depends_on_keywords() || r#else.depends_on_keywords()
            }
            Self::Query {
                name,
                receiver,
                args,
            } => {
                ["getPower", "getHp", "hasSomeKeyword"].contains(&name.as_str())
                    || receiver.depends_on_keywords()
                    || args.iter().any(Self::depends_on_keywords)
            }
        }
    }
    fn live_only(&self)->bool {
        match self {Self::Ref {path}=>path.first().is_some_and(|p|p=="modifierTarget"),Self::Query {name,receiver,args}=>name=="resourcePairs"||receiver.live_only()||args.iter().any(Self::live_only),Self::Binary {left,right,..}=>left.live_only()||right.live_only(),Self::Unary {value,..}=>value.live_only(),Self::Conditional {condition,then,r#else}=>condition.live_only()||then.live_only()||r#else.live_only(),Self::Array {items}|Self::Math {args:items,..}=>items.iter().any(Self::live_only),_=>false}
    }
    fn live_stat_bounds(&self)->Result<(i64,i64),String> {
        fn root(e:&Expr,paths:&[&[&str]])->bool {matches!(e,Expr::Ref {path} if paths.iter().any(|p|path.iter().map(String::as_str).collect::<Vec<_>>()==*p))}
        fn predicate(e:&Expr,depth:usize,identity:bool)->Result<(),String> {
            if depth>24 {return Err("live predicate depth exceeds capacity".into());}
            match e {
                Expr::Const {value} if value.is_boolean()||value.is_string()||value.as_i64().is_some_and(|n|(-1000..=1000).contains(&n))=>Ok(()),
                Expr::Ref {path} if (path.len()==2 && path[0]=="card" && ["damage","exhausted","unique","zoneName"].contains(&path[1].as_str())) || (identity && path.len()==1 && ["card","source","modifierTarget"].contains(&path[0].as_str()))=>Ok(()),
                Expr::Unary {op,value} if op=="!"=>predicate(value,depth+1,true),
                Expr::Binary {op,left,right} if ["&&","||","===","!==",">","<",">=","<="].contains(&op.as_str())=>{let identity=op=="!=="||op=="===";predicate(left,depth+1,identity)?;predicate(right,depth+1,identity)},
                Expr::Query {name,receiver,args} if root(receiver,&[&["card"]])=>{
                    if ["isUnit","isTokenUnit"].contains(&name.as_str()) && args.is_empty() {return Ok(());}
                    if ["hasSomeTrait","hasSomeAspect"].contains(&name.as_str()) && args.len()==1 {
                        let valid=match &args[0] {Expr::Const {value}=>value.is_string(),Expr::Array {items}=>!items.is_empty()&&items.len()<=8&&items.iter().all(|e|matches!(e,Expr::Const {value} if value.is_string())),_=>false};
                        if valid {return Ok(());}
                    }
                    Err("unsupported live-stat count predicate query".into())
                },_=>Err("unsupported live-stat predicate or effective-stat dependency".into())
            }
        }
        fn walk(e:&Expr,depth:usize)->Result<(i64,i64),String> {
            if depth>24 {return Err("live stat depth exceeds capacity".into());}
            let range=match e {
                Expr::Const {value}=>{let n=value.as_i64().filter(|n|(-1000..=1000).contains(n)).ok_or("live stats require bounded integer literals")?;(n,n)},
                Expr::Ref {path} if path==&["modifierTarget","damage"]=>(0,65535),
                Expr::Ref {path} if path==&["modifierTarget","controller","resources","length"] || (path.len()==3&&["player","opponent"].contains(&path[0].as_str())&&["resources","hand"].contains(&path[1].as_str())&&path[2]=="length")=>(0,64),
                Expr::Unary {op,value} if op=="-"=>{let (a,b)=walk(value,depth+1)?;(-b,-a)},
                Expr::Binary {op,left,right} if ["+","-","*"].contains(&op.as_str())=>{let (a,b)=walk(left,depth+1)?;let(c,d)=walk(right,depth+1)?;match op.as_str(){"+"=>(a+c,b+d),"-"=>(a-d,b-c),_=>{let p=[a*c,a*d,b*c,b*d];(*p.iter().min().unwrap(),*p.iter().max().unwrap())}}},
                Expr::Query {name,receiver,args} if root(receiver,&[&["player"],&["opponent"],&["modifierTarget","controller"]])=>{
                    if name=="resourcePairs"&&args.is_empty() {(0,32)}else if name=="arenaUnitCount"&&args.len()==1 {predicate(&args[0],depth+1,false)?;(0,255)}else{return Err("unsupported live-stat query".into());}
                },_=>return Err("unsupported live stat expression or effective-stat dependency".into())
            };
            if range.0< -1_000_000 || range.1>1_000_000 {return Err("live stat arithmetic exceeds proven integer bounds".into());}Ok(range)
        }
        walk(self,0)
    }
    pub fn number(n: i64) -> Self {
        Self::Const {
            value: Value::from(n),
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        fn positive(e:&Expr)->bool {match e {Expr::Query {name,receiver,args}=>name=="isDefending" && args.is_empty() && matches!(receiver.as_ref(),Expr::Ref {path} if path==&["card"]),Expr::Binary {op,left,right} if op=="&&"=>positive(left)||positive(right),_=>false}}
        fn guard(e:&Expr,defending:bool)->Result<(),String> {
            match e {
                Expr::Ref {path} if path.iter().any(|p|p=="activeAttack") => {if defending && path==&["card","activeAttack","attacker"] {Ok(())}else{Err("active attacker reference requires a dominating card.isDefending guard".into())}},
                Expr::Binary {op,left,right}=>{guard(left,defending)?;guard(right,defending||(op=="&&"&&positive(left)))},
                Expr::Query {receiver,args,..}=>{guard(receiver,defending)?;for arg in args {guard(arg,false)?;}Ok(())},
                Expr::Array {items}|Expr::Math {args:items,..}=>{for item in items {guard(item,defending)?;}Ok(())},
                Expr::Unary {value,..}=>guard(value,defending),Expr::Conditional {condition,then,r#else}=>{guard(condition,defending)?;guard(then,defending)?;guard(r#else,defending)},_=>Ok(())
            }
        }
        guard(self,false)?;self.validate_depth(0)
    }
    pub fn validate_number(&self) -> Result<(), String> {
        self.validate()?;
        let numeric = match self {
            Self::Array { .. } => false,
            Self::Math { name, args } => {
                ["min", "max"].contains(&name.as_str())
                    && !args.is_empty()
                    && args.iter().all(|a| a.validate_number().is_ok())
            }
            Self::Const { value } => value.is_i64(),
            Self::Ref { path } => matches!(
                path.last().map(String::as_str),
                Some(
                    "damage"
                        | "power"
                        | "hp"
                        | "cost" | "printedCost"
                        | "remainingHp"
                        | "readyResourceCount"
                        | "exhaustedResourceCount"
                        | "length"
                        | "totalDistributed"
                )
            ),
            Self::Binary { op, left, right } => {
                ["+", "-", "*", "%"].contains(&op.as_str())
                    && left.validate_number().is_ok()
                    && right.validate_number().is_ok()
            }
            Self::Unary { op, value } => op == "-" && value.validate_number().is_ok(),
            Self::Conditional { then, r#else, .. } => {
                then.validate_number().is_ok() && r#else.validate_number().is_ok()
            }
            Self::Query { name, .. } => {
                ["getPower", "getHp", "getCost", "getPrintedCost", "arenaUnitCount"].contains(&name.as_str())
            }
        };
        if numeric {
            Ok(())
        } else {
            Err("effect amount expression is not numeric".into())
        }
    }
    fn validate_depth(&self, depth: usize) -> Result<(), String> {
        if depth > MAX_ABILITY_NESTING {
            return Err("expression nesting exceeds runtime capacity".into());
        }
        let sub = |e: &Expr| e.validate_depth(depth + 1);
        match self {
            Self::Array { items } => {
                for item in items {
                    sub(item)?;
                }
                Ok(())
            }
            Self::Math { name, args } => {
                if !["min", "max"].contains(&name.as_str()) || args.is_empty() {
                    return Err("unsupported math expression".into());
                }
                for arg in args {
                    sub(arg)?;
                    arg.validate_number()?;
                }
                Ok(())
            }
            Self::Const { value }
                if value.is_i64() || value.is_boolean() || value.is_string() || value.is_null() =>
            {
                Ok(())
            }
            Self::Const { .. } => {
                Err("only integer, boolean, string and null constants are executable".into())
            }
            Self::Ref { path } => {
                let valid = match path
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>()
                    .as_slice()
                {
                    ["source" | "target" | "card" | "player" | "opponent"] => true,
                    ["source" | "target" | "card", "title"] => true,
                    ["player", "hasTheForce"] => true,
                    ["card","activeAttack","attacker"] => true,
                    ["modifierTarget"] | ["modifierTarget","damage"|"controller"] | ["modifierTarget","controller","resources","length"] => true,
                    ["source", "parentCard" | "parentUnit"] => true,
                    ["source", "parentCard" | "parentUnit", "damage" | "power" | "hp" | "remainingHp" | "controller" | "exhausted" | "unique"] => true,
                    ["source" | "target" | "card", "damage" | "power" | "hp" | "cost" | "printedCost" | "remainingHp" | "exhausted"
                    | "controller" | "unique" | "zoneName"] => true,
                    ["player" | "opponent", "readyResourceCount" | "exhaustedResourceCount" | "base"] => {
                        true
                    }
                    ["player" | "opponent", "resources" | "hand" | "drawDeck" | "discard", "length"] => {
                        true
                    }
                    ["player" | "opponent", "base", "damage"] => true,
                    ["event", "totalDistributed"] => true,
                    _ => false,
                };
                if valid {
                    Ok(())
                } else {
                    Err(format!("unsupported runtime reference {}", path.join(".")))
                }
            }
            Self::Binary { op, left, right } => {
                if (left.references_title() || right.references_title()) && !["===","!==","&&","||"].contains(&op.as_str()) { return Err("printed titles support strict equality and logical operators only".into()); }
                if ![
                    "+", "-", "*", "%", "===", "!==", "<", "<=", ">", ">=", "&&", "||",
                ]
                .contains(&op.as_str())
                {
                    return Err(format!("unsupported expression operator {op}"));
                }
                sub(left)?;
                sub(right)
            }
            Self::Unary { op, value } => {
                if value.references_title() && op!="!" { return Err("printed titles do not support numeric unary coercion".into()); }
                if !["!", "-"].contains(&op.as_str()) {
                    return Err(format!("unsupported unary operator {op}"));
                }
                sub(value)
            }
            Self::Conditional {
                condition,
                then,
                r#else,
            } => {
                sub(condition)?;
                sub(then)?;
                sub(r#else)
            }
            Self::Query {
                name,
                receiver,
                args,
            } => {
                if receiver.references_title() || args.iter().any(Self::references_title) { return Err("printed title query coercion is unsupported".into()); }
                let arity = match name.as_str() {
                    "hasCost" | "isUpgrade" | "canBeExhausted" | "isUpgraded" | "isInPlay" | "isNonLeaderUnit"
                    | "hasInitiative" | "isUnit" | "isBase" | "isLeader" | "getPower" | "getHp"
                    | "getCost" | "getPrintedCost" | "isToken" | "isTokenUnit" | "resourcePairs" | "isAttacking" | "isDefending" => 0,
                    "hasSomeTrait" | "hasSomeAspect" | "hasSomeKeyword" | "hasSomeArenaUnit"
                    | "arenaUnitCount" => 1,
                    _ => return Err(format!("unsupported runtime query {name}")),
                };
                if args.len() != arity {
                    return Err(format!("query {name} expects {arity} arguments"));
                }
                if name=="isUpgrade" && !matches!(receiver.as_ref(),Expr::Ref {path} if path.len()==1 && ["source","card","target"].contains(&path[0].as_str())) {return Err("isUpgrade requires an explicit card receiver".into());}
                if name=="hasCost" && !matches!(receiver.as_ref(),Expr::Ref {path} if path.len()==1 && ["source","card","target"].contains(&path[0].as_str())) {return Err("hasCost requires an explicit card receiver".into());}
                if name=="isTokenUnit" && !matches!(receiver.as_ref(),Expr::Ref {path} if path.len()==1 && ["source","card","target"].contains(&path[0].as_str())) {return Err("isTokenUnit requires an explicit card receiver".into());}
                if ["isAttacking","isDefending"].contains(&name.as_str()) && !matches!(receiver.as_ref(),Expr::Ref {path} if path.len()==1 && ["source","card","target"].contains(&path[0].as_str())) {return Err("attack query requires a scalar source/card/target receiver".into());}
                sub(receiver)?;
                for arg in args {
                    sub(arg)?;
                }
                Ok(())
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Target {
    Name(String),
    Expression(Expr),
    ArenaList(ArenaListTarget),
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArenaListTarget { pub kind: ArenaListKind, pub receiver: Expr, pub predicate: Expr }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ArenaListKind { #[serde(rename = "arenaList")] ArenaList }
impl ArenaListTarget {
    fn validate_phase_stats(&self)->Result<(),String> {
        if self.validate_scope(false).is_ok() {return Ok(());}
        self.receiver.validate()?;self.predicate.validate()?;
        if !matches!(&self.receiver,Expr::Ref{path} if path.len()==1&&["player","opponent"].contains(&path[0].as_str())) {return Err("phase-stat lists require one player arena inventory".into());}
        fn reference(e:&Expr,name:&str)->bool {matches!(e,Expr::Ref{path} if path.len()==1&&path[0]==name)}
        fn predicate(e:&Expr)->bool {
            // getArenaUnits({otherThan:source}) generates the nullable exclusion.
            if matches!(e,Expr::Binary{op,left,right} if op=="||" && matches!(left.as_ref(),Expr::Unary{op,value} if op=="!"&&reference(value,"source")) && matches!(right.as_ref(),Expr::Binary{op,left,right} if op=="!=="&&reference(left,"card")&&reference(right,"source"))) {return true;}
            match e {
                Expr::Const{value}=>value.is_boolean(),
                Expr::Binary{op,left,right} if ["&&","||"].contains(&op.as_str())=>predicate(left)&&predicate(right),
                Expr::Query{name,receiver,args} if name=="hasSomeTrait" && reference(receiver,"card") && args.len()==1=>matches!(&args[0],Expr::Const{value} if value.as_str().is_some_and(|v|!v.is_empty())),
                Expr::Binary{op,left,right} if op=="==="=> {
                    let zone=|e:&Expr|matches!(e,Expr::Ref{path} if path.iter().map(String::as_str).collect::<Vec<_>>()==["card","zoneName"]);
                    let name=|e:&Expr|matches!(e,Expr::Const{value} if matches!(value.as_str(),Some("groundArena"|"spaceArena"|"anyArena")));
                    (zone(left)&&name(right))||(name(left)&&name(right))
                },_=>false,
            }
        }
        if !predicate(&self.predicate) {return Err("phase-stat filters require static traits, arenas or source exclusion".into());}Ok(())
    }
    fn validate_scope(&self, global:bool)->Result<(),String> {
        if !(global && matches!(&self.receiver,Expr::Ref {path} if path.iter().map(String::as_str).collect::<Vec<_>>()==["game"])) {self.receiver.validate()?;}
        self.predicate.validate()?;
        if !matches!(&self.receiver,Expr::Ref {path} if path.len()==1 && (["player","opponent"].contains(&path[0].as_str()) || (global && path[0]=="game"))) {return Err("arena-list receiver is outside the verified scope".into());}
        fn predicate(e:&Expr,global:bool)->bool {match e {
            Expr::Const {value}=>value.is_boolean(),
            Expr::Unary {op,value} if op=="!"=>predicate(value,global)||matches!(value.as_ref(),Expr::Const {value} if matches!(value.as_str(),Some("groundArena"|"spaceArena"))),
            Expr::Binary {op,left,right} if ["&&","||"].contains(&op.as_str())=>predicate(left,global)&&predicate(right,global),
            Expr::Binary {op,left,right} if op=="==="=>{
                let zone=|e:&Expr|matches!(e,Expr::Ref {path} if path.iter().map(String::as_str).collect::<Vec<_>>()==["card","zoneName"]);
                let name=|e:&Expr|matches!(e,Expr::Const {value} if matches!(value.as_str(),Some("groundArena"|"spaceArena"|"anyArena")));
                (zone(left)&&name(right))||(name(left)&&name(right))
            },
            Expr::Query {name,receiver,args} if global && ["isUnit","isUpgraded"].contains(&name.as_str())=>args.is_empty() && matches!(receiver.as_ref(),Expr::Ref {path} if path.iter().map(String::as_str).collect::<Vec<_>>()==["card"]),
            _=>false}}
        if !predicate(&self.predicate,global) {return Err("arena-list phase-stat predicate requires verified arena-only scope".into());}Ok(())
    }
}
impl Target {
    pub fn name(name: &str) -> Self {
        Self::Name(name.into())
    }
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::ArenaList(_)=>Err("arena lists require standalone verified phase-stat semantics".into()),
            Self::Name(s)
                if [
                    "self",
                    "parent",
                    "ownBase",
                    "enemyBase",
                    "bothBases",
                    "chosen",
                    "ownPlayer",
                    "enemyPlayer",
                    "bothPlayers",
                ]
                .contains(&s.as_str()) =>
            {
                Ok(())
            }
            Self::Name(s) => Err(format!("unsupported effect target {s}")),
            Self::Expression(e) => {
                fn is_target(e: &Expr) -> bool {
                    match e {
                        Expr::Ref { path } => matches!(
                            path.iter()
                                .map(String::as_str)
                                .collect::<Vec<_>>()
                                .as_slice(),
                            ["source" | "target" | "card" | "player" | "opponent"]
                                | ["player" | "opponent", "base"]
                                | ["source" | "target" | "card", "controller"]
                                | ["source", "parentCard" | "parentUnit"]
                        ),
                        Expr::Conditional { then, r#else, .. } => {
                            is_target(then) && (is_target(r#else) || matches!(r#else.as_ref(),Expr::Const {value} if value.is_null()))
                        }
                        _ => false,
                    }
                }
                if !is_target(e) {
                    return Err("effect target must be a bounded card or player reference; array targets require verified event batching".into());
                }
                e.validate()
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetResolver {
    #[serde(default, skip_serializing_if="Option::is_none")]
    pub prompt_title: Option<String>,
    #[serde(default = "any_owner")]
    pub owner: String,
    #[serde(rename = "type", default = "any_owner")]
    pub card_type: String,
    #[serde(default)]
    pub arena: Option<String>,
    #[serde(default)]
    pub zone: Option<String>,
    #[serde(default)]
    pub optional: bool,
    #[serde(default)]
    pub predicate: Option<Expr>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub count: Option<Expr>,
}
fn any_owner() -> String {
    "any".into()
}
impl TargetResolver {
    /// A positive type predicate supplies the selector inventory domain; ordinary
    /// `any` continues to enumerate units/bases. Do not admit mixed domains.
    pub fn is_upgrade_domain(&self) -> bool {
        fn implies(e:&Expr)->bool { match e {
            Expr::Query {name,receiver,args} if name=="isUpgrade" && args.is_empty()=>matches!(receiver.as_ref(),Expr::Ref {path} if path.len()==1 && path[0]=="card"),
            Expr::Binary {op,left,right} if op=="&&"=>implies(left)||implies(right),
            Expr::Binary {op,left,right} if op=="||"=>implies(left)&&implies(right),
            _=>false,
        }}
        self.card_type=="upgrade" || (self.card_type=="any" && self.predicate.as_ref().is_some_and(implies))
    }
    fn mentions_upgrade_query(&self)->bool {
        fn mentions(e:&Expr)->bool {match e {
            Expr::Query {name,receiver,args}=>name=="isUpgrade"||mentions(receiver)||args.iter().any(mentions),
            Expr::Array {items}=>items.iter().any(mentions), Expr::Math {args,..}=>args.iter().any(mentions),
            Expr::Binary {left,right,..}=>mentions(left)||mentions(right), Expr::Unary {value,..}=>mentions(value),
            Expr::Conditional {condition,then,r#else}=>mentions(condition)||mentions(then)||mentions(r#else),
            _=>false,
        }}
        self.predicate.as_ref().is_some_and(mentions)
    }
    pub fn max_targets(&self) -> Result<usize, String> {
        match self.mode.as_deref() {
            None | Some("single") if self.count.is_none() => Ok(1),
            Some("upTo") => match &self.count {
                Some(Expr::Const { value }) if value.as_u64().is_some_and(|n| (1..=3).contains(&n)) => Ok(value.as_u64().unwrap() as usize),
                _ => Err("UpTo selectors require literal counts from one to three".into()),
            },
            Some("unlimited") if self.card_type == "base" && self.arena.is_none() && self.count.is_none() && self.optional && matches!(self.zone.as_deref(), None | Some("base" | "anyAttackable")) => Ok(2),
            _ => Err("unsupported target mode/count; unlimited selection is base-only".into()),
        }
    }
    pub fn is_multiple(&self) -> bool { matches!(self.mode.as_deref(), Some("upTo" | "unlimited")) }
    pub fn validate(&self) -> Result<(), String> {
        if self.prompt_title.is_some() {return Err("named prompt titles require a named descriptor".into());}
        self.max_targets()?;
        if self.card_type=="any" && self.mentions_upgrade_query() && !self.is_upgrade_domain() {return Err("mixed upgrade selector domains are not modeled".into());}
        if self.is_upgrade_domain() && (self.arena.is_some() || !matches!(self.zone.as_deref(),None|Some("arena"|"anyAttackable"|"discard"))) {return Err("upgrade selectors require arena/anyAttackable without an arena filter".into());}
        if !["self", "opponent", "any"].contains(&self.owner.as_str()) {
            return Err(format!("unsupported target owner {}", self.owner));
        }
        if !["unit", "base", "any", "nonLeaderUnit", "leaderUnit", "upgrade", "tokenUnit"]
            .contains(&self.card_type.as_str())
        {
            return Err(format!("unsupported target type {}", self.card_type));
        }
        if self
            .arena
            .as_deref()
            .is_some_and(|a| !["ground", "space"].contains(&a))
        {
            return Err(format!("unsupported arena {:?}", self.arena));
        }
        if self
            .zone
            .as_deref()
            .is_some_and(|z| !["arena", "base", "anyAttackable", "discard"].contains(&z))
        {
            return Err(format!("unsupported target zone {:?}", self.zone));
        }
        if let Some(p) = &self.predicate {
            p.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Cost {
    ExhaustSelf,
    Resources { amount: Expr },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Effect {
    DiscardOwnHand {amount:Expr,target:Target},
    DiscardDeck {amount:Expr,target:Target},
    CreateTokenUnit { #[serde(rename="tokenType")] token_type:String, amount:Expr, target:Target, #[serde(default,rename="entersReady")] enters_ready:bool },
    Damage {
        amount: Expr,
        target: Target,
    },
    Heal {
        amount: Expr,
        target: Target,
    },
    Draw {
        amount: Expr,
        target: Target,
    },
    Select {
        #[serde(rename = "targetResolver")]
        target_resolver: TargetResolver,
        effect: Box<Effect>,
    },
    ReadyResources {
        target: Target,
        amount: Expr,
    },
    NoAction,
    ResourceCard { target: Target },
    ReturnToHand {
        target: Target,
    },
    ModifyStats {
        target: Target,
        power: Expr,
        hp: Expr,
        duration: String,
    },
    GainKeyword { target: Target, keyword: String, #[serde(default = "one")] amount: Expr, duration: String },
    LoseKeyword { target: Target, keyword: String, duration: String },
    Ready {
        target: Target,
    },
    Exhaust {
        target: Target,
    },
    Defeat {
        target: Target,
    },
    GiveShield {
        #[serde(default = "one")]
        amount: Expr,
        target: Target,
    },
    UseForce {target:Target},
    GainForce {target:Target},
    GiveWeakness { amount:Expr, target:Target },
    GiveExperience {
        #[serde(default = "one")]
        amount: Expr,
        target: Target,
    },
    Sequence {
        effects: Vec<Effect>,
    },
    Simultaneous {
        effects: Vec<Effect>,
    },
    PhaseModifiers {
        effects: Vec<Effect>,
    },
    Conditional {
        condition: Expr,
        #[serde(rename = "onTrue")]
        on_true: Box<Effect>,
        #[serde(rename = "onFalse", default)]
        on_false: Option<Box<Effect>>,
    },
    DistributeHealing {
        amount: Expr,
        #[serde(rename = "maxTargets")]
        max_targets: u16,
        #[serde(rename = "canChooseNoTargets", default)]
        can_choose_no_targets: bool,
        #[serde(rename = "canDistributeLess", default)]
        can_distribute_less: bool,
        #[serde(rename = "targetResolver")]
        target_resolver: TargetResolver,
    },
}
/// Upgrade departure is scalar and has a single chosen-card event. Conditional
/// no-action branches retain feasibility; groups and other operations stay blocked.
fn scalar_upgrade_operation(effect:&Effect,discard:bool)->bool {
    fn walk(e:&Effect,discard:bool)->(bool,bool) {match e {
        Effect::ReturnToHand {target}=>(matches!(target,Target::Name(name) if name=="chosen"),true),
        Effect::Defeat {..}=>(!discard,true),
        Effect::NoAction=>(true,false),
        Effect::Conditional {on_true,on_false,..}=>{let a=walk(on_true,discard);let b=on_false.as_ref().map_or((true,false),|e|walk(e,discard));(a.0&&b.0,a.1||b.1)},
        _=>(false,false),
    }}
    let (valid,operation)=walk(effect,discard);valid&&operation
}
fn one() -> Expr {
    Expr::number(1)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ability {
    #[serde(default, skip_serializing_if="Vec::is_empty")]
    pub target_resolvers: Vec<NamedTargetResolver>,
    #[serde(default)]
    pub trigger: String,
    #[serde(default)]
    pub coordinate: bool,
    pub title: String,
    #[serde(default)]
    pub context_title: Vec<Expr>,
    #[serde(default)]
    pub costs: Vec<Cost>,
    #[serde(default)]
    pub optional: bool,
    #[serde(default)]
    pub requires_confirmation: bool,
    #[serde(default)]
    pub target_resolver: Option<TargetResolver>,
    #[serde(default)]
    pub condition: Option<Expr>,
    pub effect: Effect,
    #[serde(default)]
    pub then: Option<Box<Ability>>,
    #[serde(default)]
    pub if_you_do: Option<Box<Ability>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct NamedTargetResolver {
    pub name:String,
    pub target_resolver:TargetResolver,
    pub chooser:String,
    pub effect:Effect,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sides {
    #[serde(default)]
    pub leader: Vec<Ability>,
    #[serde(default)]
    pub unit: Vec<Ability>,
    #[serde(default)]
    pub card: Vec<Ability>,
}

fn contains_resource<T:Serialize>(v:&T)->bool {
    fn walk(v:&Value)->bool {v["kind"]=="resourceCard" || match v {Value::Array(a)=>a.iter().any(walk),Value::Object(o)=>o.values().any(walk),_=>false}}
    serde_json::to_value(v).map(|v|walk(&v)).unwrap_or(true)
}
fn resource_self(e:&Effect)->bool {matches!(e,Effect::ResourceCard{target:Target::Name(n)} if n=="self")}
fn contains_force(effect:&Effect)->bool {
    match effect {Effect::UseForce{..}|Effect::GainForce{..}=>true,Effect::Conditional{on_true,on_false,..}=>contains_force(on_true)||on_false.as_deref().is_some_and(contains_force),Effect::Select{effect,..}=>contains_force(effect),Effect::Simultaneous{effects}|Effect::Sequence{effects}|Effect::PhaseModifiers{effects}=>effects.iter().any(contains_force),_=>false}
}
fn contains_weakness(effect:&Effect)->bool {
    match effect {Effect::GiveWeakness{..}=>true,Effect::Conditional{on_true,on_false,..}=>contains_weakness(on_true)||on_false.as_deref().is_some_and(contains_weakness),Effect::Select{effect,..}=>contains_weakness(effect),Effect::Simultaneous{effects}|Effect::Sequence{effects}|Effect::PhaseModifiers{effects}=>effects.iter().any(contains_weakness),_=>false}
}

#[derive(Debug, Clone, Serialize)]
pub enum Instruction {
    /// All then/sequence subwindows pass registrations to this initiating ability window.
    EndStep,
    Commit,
    Select(TargetResolver),
    Conditional { condition: Expr, skip: usize },
    IfResult { skip: usize },
    Jump { to: usize },
    Apply(Effect),
    Group(Effect),
    /// Independent named selectors prepare before commitment and share one event window.
    NamedGroup(Effect),
}

#[derive(Debug, Clone, Serialize)]
pub struct Program {
    pub title: String,
    pub context_title: Vec<Expr>,
    pub trigger: String,
    pub coordinate: bool,
    pub costs: Vec<Cost>,
    pub optional: bool,
    pub requires_confirmation: bool,
    pub condition: Option<Expr>,
    pub instructions: Vec<Instruction>,
    pub event_end: u8,
    #[serde(skip)]
    pub executable: Result<usize, &'static str>,
}
impl Program {
    pub fn compile(ability: &Ability) -> Result<Self, String> {
        // Deck discard has per-card events plus an aggregate event. The scalar
        // result is not a modeled engine event payload; reject payload captures.
        fn contains(value:&Value, predicate:fn(&Value)->bool)->bool {
            predicate(value) || match value {Value::Array(a)=>a.iter().any(|v|contains(v,predicate)),Value::Object(o)=>o.values().any(|v|contains(v,predicate)),_=>false}
        }
        let encoded=serde_json::to_value(ability).map_err(|e|e.to_string())?;
        fn binder_context(value:&Value,live:bool)->Result<(),String> {
            if value["kind"]=="ref"&&value["path"][0]=="modifierTarget"&&!live {return Err("modifierTarget only exists in persistent stat expressions".into());}
            if value["kind"]=="query"&&value["name"]=="resourcePairs"&&!live {return Err("resourcePairs only exists in persistent stat expressions".into());}
            match value {Value::Object(object)=>{for(k,v)in object {let stat=value["kind"]=="modifyStats"&&value["duration"]=="persistent"&&["power","hp"].contains(&k.as_str());binder_context(v,live||stat)?;}},Value::Array(items)=>for v in items {binder_context(v,live)?;},_=>{}}Ok(())
        }
        binder_context(&encoded,false)?;

        if contains(&encoded,|v|v["kind"]=="discardDeck") && contains(&encoded,|v|v["kind"]=="ref" && v["path"][0]=="event") {
            return Err("deck discard event payload captures are not modeled".into());
        }
        fn validate_title(e: &Expr) -> Result<(), String> {
            match e {
                Expr::Ref {path} if path.iter().map(String::as_str).collect::<Vec<_>>() == ["source", "title"] => Ok(()),
                Expr::Conditional {condition, then, r#else} => { condition.validate()?; validate_title(then)?; validate_title(r#else) },
                Expr::Array { .. } => Err("context titles require scalar fragments".into()),
                Expr::Ref {path} if path.len() == 1 || matches!(path.last().map(String::as_str), Some("controller" | "base")) => Err("context titles require scalar reference values".into()),
                Expr::Binary {op, ..} if op == "+" => e.validate_number(),
                _ => e.validate(),
            }
        }
        if let Effect::Defeat {target:Target::ArenaList(list)}=&ability.effect {
            if ability.trigger!="event" || ability.target_resolver.is_some() || ability.then.is_some() || ability.if_you_do.is_some() || ability.condition.is_some() || ability.coordinate {return Err("arena-list defeat requires a standalone event without selectors or continuations".into());}
            list.validate_scope(true)?;
        }
        if let Effect::ModifyStats {target:Target::ArenaList(list),power,hp,duration}=&ability.effect {
            if !["event","whenPlayed"].contains(&ability.trigger.as_str()) || ability.target_resolver.is_some() || ability.then.is_some() || ability.if_you_do.is_some() || ability.condition.is_some() || ability.coordinate || ability.optional || ability.requires_confirmation || !ability.costs.is_empty() || !ability.context_title.is_empty() || !ability.target_resolvers.is_empty() || duration!="phase" {return Err("arena-list phase stats require a standalone event or WhenPlayed without selectors, costs or continuations".into());}
            list.validate_phase_stats()?;
            fn literal(e:&Expr)->bool {match e {Expr::Const {value}=>value.as_i64().is_some_and(|n|(-65535..=65535).contains(&n)),Expr::Unary {op,value} if ["+","-"].contains(&op.as_str())=>matches!(value.as_ref(),Expr::Const {value} if value.as_i64().is_some_and(|n|(0..=65535).contains(&n))),_=>false}}
            if !literal(power)||!literal(hp) {return Err("arena-list phase stats require bounded signed literals".into());}
        }
        if ability.coordinate && !["constant","onAttack"].contains(&ability.trigger.as_str()) {return Err("Coordinate supports only constant or onAttack registrations".into());}
        if ability.then.as_ref().is_some_and(|a|a.coordinate) || ability.if_you_do.as_ref().is_some_and(|a|a.coordinate) {return Err("Coordinate cannot register on a continuation".into());}
        if ability.context_title.len() > 32 { return Err("context title fragment count exceeds capacity".into()); }
        fn title_literal_bytes(e: &Expr) -> usize {
            match e {
                Expr::Const {value} => value.as_str().map_or(0, str::len),
                Expr::Array {items} => items.iter().map(title_literal_bytes).sum(),
                Expr::Math {args, ..} => args.iter().map(title_literal_bytes).sum(),
                Expr::Ref { .. } => 0,
                Expr::Unary {value, ..} => title_literal_bytes(value),
                Expr::Binary {left, right, ..} => title_literal_bytes(left) + title_literal_bytes(right),
                Expr::Conditional {condition, then, r#else} => title_literal_bytes(condition) + title_literal_bytes(then) + title_literal_bytes(r#else),
                Expr::Query {receiver, args, ..} => title_literal_bytes(receiver) + args.iter().map(title_literal_bytes).sum::<usize>(),
            }
        }
        let mut literal_bytes = 0;
        for fragment in &ability.context_title {
            validate_title(fragment)?;
            literal_bytes += title_literal_bytes(fragment);
            if literal_bytes > 1024 { return Err("context title aggregate literal bytes exceed capacity".into()); }
        }

        if !["action", "whenPlayed", "whenDefeated", "onAttack", "onDefense", "event", "constant"]
            .contains(&ability.trigger.as_str())
        {
            return Err(format!("unsupported runtime trigger {}", ability.trigger));
        }
        if ability.trigger == "constant" {
            if ability.optional
                || !ability.costs.is_empty()
                || ability.then.is_some()
                || ability.if_you_do.is_some()
            {
                return Err(
                    "constant modifiers cannot have costs, choices, or continuations".into(),
                );
            }
            fn validate_constant(effect: &Effect, selected: bool) -> Result<(), String> {
                let expected = if selected { "chosen" } else { "self" };
                let valid_target = |target: &Target, duration: &str| duration == "persistent" && matches!(target, Target::Name(n) if n == expected || (!selected && n == "parent"));
                match effect {
                    Effect::ModifyStats {power,hp,duration,target} if valid_target(target,duration)=>{power.live_stat_bounds()?;hp.live_stat_bounds()?;Ok(())},
                    Effect::GainKeyword { target, amount, duration, .. } if valid_target(target, duration) && !amount.depends_on_keywords() => Ok(()),
                    Effect::LoseKeyword { target, duration, .. } if valid_target(target, duration) => Ok(()),
                    Effect::Simultaneous { effects } if !effects.is_empty() => { for e in effects { validate_constant(e, selected)?; } Ok(()) }
                    _ => Err("unsupported constant modifier or recursive effective-stat/keyword dependency".into()),
                }
            }
            validate_constant(&ability.effect, ability.target_resolver.is_some())?;
            fn modifies_keywords(e: &Effect) -> bool { match e { Effect::GainKeyword { .. } | Effect::LoseKeyword { .. } => true, Effect::Simultaneous { effects } => effects.iter().any(modifies_keywords), _ => false } }
            if modifies_keywords(&ability.effect) && (ability.condition.as_ref().is_some_and(Expr::depends_on_keywords) || ability.target_resolver.as_ref().and_then(|r| r.predicate.as_ref()).is_some_and(Expr::depends_on_keywords)) { return Err("constant keyword-dependent conditions would form evaluation cycles".into()); }

            if ability
                .condition
                .as_ref()
                .is_some_and(Expr::depends_on_stats)
                || ability
                    .target_resolver
                    .as_ref()
                    .and_then(|r| r.predicate.as_ref())
                    .is_some_and(Expr::depends_on_stats)
            {
                return Err(
                    "constant stat-dependent conditions would form evaluation cycles".into(),
                );
            }
            if ability.target_resolver.as_ref().is_some_and(|r| {
                r.optional || r.mode.is_some() || r.count.is_some()
                    || !matches!(
                        r.zone.as_deref(),
                        None | Some("arena") | Some("anyAttackable")
                    )
            }) {
                return Err(
                    "constant target filter must be arena-only without optional choice".into(),
                );
            }
        }
        if ability.requires_confirmation {
            return Err("explicit confirmation semantics are not implemented".into());
        }
        if ability.trigger != "action" && !ability.costs.is_empty() {
            return Err("triggered or event additional costs are not implemented".into());
        }
        let mut p = Self {
            title: ability.title.clone(),
            context_title: ability.context_title.clone(),
            trigger: ability.trigger.clone(),
            coordinate: ability.coordinate,
            costs: ability.costs.clone(),
            optional: ability.optional,
            requires_confirmation: ability.requires_confirmation,
            condition: ability.condition.clone(),
            instructions: vec![],
            event_end:0,
            executable: Err("program has not been compiled"),
        };
        if let Some(e) = &p.condition {
            e.validate()?;
        }
        if p.costs
            .iter()
            .filter(|c| matches!(c, Cost::ExhaustSelf))
            .count()
            > 1
        {
            return Err("duplicate exhaust cost cannot be paid".into());
        }
        let mut resource_cost = 0u64;
        for cost in &p.costs {
            if let Cost::Resources { amount } = cost {
                let Expr::Const { value } = amount else {
                    return Err("dynamic resource costs require typed bounded evaluation".into());
                };
                let amount = value
                    .as_u64()
                    .filter(|n| *n <= u16::MAX as u64)
                    .ok_or("resource cost must be a nonnegative bounded integer")?;
                resource_cost = resource_cost
                    .checked_add(amount)
                    .filter(|n| *n <= u16::MAX as u64)
                    .ok_or("total resource cost exceeds capacity")?;
            }
        }
        p.compile_ability(ability, 0)?;
        if p.instructions.len()>u8::MAX as usize {return Err("ability event boundary exceeds capacity".into());}
        p.event_end=p.instructions.len() as u8;
        p.instructions.push(Instruction::EndStep);
        if p.instructions.len() > MAX_PROGRAM_INSTRUCTIONS {
            return Err("ability program exceeds instruction capacity".into());
        }
        let bytes=serde_json::to_vec(&p).map_err(|e|e.to_string())?;
        p.executable=crate::program_backend(&bytes);
        Ok(p)
    }
    fn compile_ability(&mut self, ability: &Ability, depth: usize) -> Result<(), String> {
        if depth==0 && contains_resource(ability) {
            let header=!ability.requires_confirmation && !ability.coordinate && ability.context_title.is_empty() && ability.costs.is_empty() && ability.target_resolver.is_none() && ability.target_resolvers.is_empty() && ability.condition.is_none() && ability.then.is_none();
            let event=ability.trigger=="event" && !ability.optional && resource_self(&ability.effect) && ability.if_you_do.is_none();
            let death=ability.trigger=="whenDefeated" && ability.optional && ability.if_you_do.is_none() && matches!(&ability.effect,Effect::Conditional{condition:Expr::Binary{op,left,right},on_true,on_false} if op=="===" && matches!(left.as_ref(),Expr::Ref{path} if path.iter().map(String::as_str).collect::<Vec<_>>()==["source","zoneName"]) && matches!(right.as_ref(),Expr::Const{value} if value.as_str()==Some("discard")) && resource_self(on_true) && on_false.as_deref().is_some_and(|e|matches!(e,Effect::NoAction)));
            let force=ability.trigger=="whenDefeated" && ability.optional && matches!(&ability.effect,Effect::UseForce{target:Target::Name(n)} if n=="ownPlayer") && ability.if_you_do.as_ref().is_some_and(|n|resource_self(&n.effect));
            if !header || !(event||death||force) {return Err("resourceCard requires bounded self event/death registration".into());}
        }
        if contains_force_presence(ability) {
            let header=depth==0 && ability.trigger=="constant" && !ability.optional && !ability.requires_confirmation && !ability.coordinate && ability.context_title.is_empty() && ability.costs.is_empty() && ability.target_resolvers.is_empty() && ability.then.is_none() && ability.if_you_do.is_none() && matches!(&ability.condition,Some(Expr::Ref{path}) if path.iter().map(String::as_str).collect::<Vec<_>>()==["player","hasTheForce"]);
            let keyword=ability.target_resolver.is_none() && matches!(&ability.effect,Effect::GainKeyword{target:Target::Name(n),duration,keyword,amount:Expr::Const{value}} if n=="self" && duration=="persistent" && ["grit","sentinel","ambush"].contains(&keyword.as_str()) && value.as_u64()==Some(1));
            let aura=ability.target_resolver.as_ref().is_some_and(|r|r.owner=="self" && r.card_type=="unit" && r.zone.as_deref()==Some("arena") && r.arena.is_none() && !r.optional && r.mode.is_none() && r.count.is_none() && r.prompt_title.is_none() && matches!(&r.predicate,Some(Expr::Query{name,receiver,args}) if name=="isUnit" && args.is_empty() && matches!(receiver.as_ref(),Expr::Ref{path} if path.len()==1&&path[0]=="card"))) && matches!(&ability.effect,Effect::ModifyStats{target:Target::Name(n),duration,power:Expr::Const{value:p},hp:Expr::Const{value:h}} if n=="chosen" && duration=="persistent" && p.as_i64().is_some_and(|n|(-65535..=65535).contains(&n)) && h.as_i64()==Some(0));
            if !header || !(keyword||aura){return Err("Force presence supports bounded ordinary constant own-player keyword or friendly literal stat aura".into());}
        }
        if contains_force(&ability.effect) {
            let root=depth==0 && ["whenPlayed","whenDefeated","onAttack","event"].contains(&ability.trigger.as_str()) && !ability.requires_confirmation && !ability.coordinate && ability.context_title.is_empty() && ability.costs.is_empty() && ability.target_resolver.is_none() && ability.target_resolvers.is_empty() && ability.condition.is_none() && ability.then.is_none();
            let gain=["whenPlayed","onAttack","whenDefeated"].contains(&ability.trigger.as_str()) && matches!(&ability.effect,Effect::GainForce{target:Target::Name(n)} if n=="ownPlayer") && !ability.optional && ability.if_you_do.is_none();
            let use_force=["whenPlayed","whenDefeated","event"].contains(&ability.trigger.as_str()) && matches!(&ability.effect,Effect::UseForce{target:Target::Name(n)} if n=="ownPlayer") && ability.optional==(ability.trigger!="event") && ability.if_you_do.as_ref().is_some_and(|next| {
                if !next.trigger.is_empty() || next.coordinate || !next.context_title.is_empty() || !next.costs.is_empty() || next.optional || next.requires_confirmation || !next.target_resolvers.is_empty() || next.condition.is_some() || next.then.is_some() || next.if_you_do.is_some() {return false;}
                fn bounded(e:&Expr)->bool {matches!(e,Expr::Const{value} if value.as_i64().is_some_and(|n|(-65535..=65535).contains(&n))) || matches!(e,Expr::Unary{op,value} if op=="-" && matches!(value.as_ref(),Expr::Const{value} if value.as_u64().is_some_and(|n|n<=65535)))}
                match (&next.target_resolver,&next.effect) {
                    (None,Effect::ResourceCard{target:Target::Name(n)})=>ability.trigger=="whenDefeated" && n=="self",
                    (None,Effect::Draw{target:Target::Name(n),amount:Expr::Const{value}})=>ability.trigger=="whenPlayed" && n=="ownPlayer"&&value.as_u64()==Some(2),
                    (None,Effect::Ready{target:Target::Name(n)})=>ability.trigger=="whenPlayed" && n=="self",
                    (None,Effect::DiscardOwnHand{target:Target::Name(n),amount:Expr::Const{value}})=>ability.trigger=="whenDefeated" && n=="enemyPlayer"&&value.as_u64()==Some(1),
                    (Some(r),effect)=> {
                        let domain=(["any","self"].contains(&r.owner.as_str()) && ["unit","base"].contains(&r.card_type.as_str()) && matches!(r.zone.as_deref(),Some("arena"|"anyAttackable"))) || (r.owner=="any" && r.card_type=="any" && r.zone.as_deref()==Some("base") && matches!(effect,Effect::Heal{..}));
                        let selector=domain && r.arena.is_none() && !r.optional && r.mode.is_none() && r.count.is_none() && r.prompt_title.is_none() && r.predicate.is_none();
                        selector && match effect {
                            Effect::ModifyStats{target:Target::Name(n),duration,power,hp}=>r.card_type=="unit"&&n=="chosen"&&duration=="phase"&&bounded(power)&&bounded(hp),
                            Effect::Heal{target:Target::Name(n),amount:Expr::Const{value}}=>n=="chosen"&&value.as_u64().is_some_and(|n|(1..=65535).contains(&n)),
                            Effect::Damage{target:Target::Name(n),amount:Expr::Const{value}}=>r.card_type=="unit"&&n=="chosen"&&value.as_u64().is_some_and(|n|(1..=65535).contains(&n)),
                            _=>false,
                        }
                    },
                    _=>false,
                }
            });
            if !root || !(gain||use_force) {return Err("Force requires standalone ordinary play/death/event use and one bounded independent success continuation".into());}
        }

        if contains_weakness(&ability.effect) {
            fn primitive(e:&Effect)->bool {matches!(e,Effect::GiveWeakness{amount:Expr::Const{value},target:Target::Name(n)} if value.as_u64()==Some(1)&&n=="chosen")}
            let shape=primitive(&ability.effect) || matches!(&ability.effect,Effect::Conditional{condition:Expr::Binary{op,left,right},on_true,on_false} if op==">=" && matches!(left.as_ref(),Expr::Ref{path} if path.iter().map(String::as_str).collect::<Vec<_>>()==["player","resources","length"]) && matches!(right.as_ref(),Expr::Const{value} if value.as_u64().is_some_and(|n|n<=1000)) && primitive(on_true) && on_false.as_deref().is_some_and(|e|matches!(e,Effect::NoAction)));
            fn damaged_predicate(e:&Expr)->bool {matches!(e,Expr::Binary{op,left,right} if op=="&&" && matches!(left.as_ref(),Expr::Query{name,receiver,args} if name=="isUnit"&&args.is_empty()&&matches!(receiver.as_ref(),Expr::Ref{path} if path.len()==1&&path[0]=="card")) && matches!(right.as_ref(),Expr::Binary{op,left,right} if op=="!=="&&matches!(left.as_ref(),Expr::Ref{path} if path.iter().map(String::as_str).collect::<Vec<_>>()==["card","damage"])&&matches!(right.as_ref(),Expr::Const{value} if value.as_u64()==Some(0))))}
            let selector=ability.target_resolver.as_ref().is_some_and(|r| r.owner=="any" && r.card_type=="unit" && matches!(r.zone.as_deref(),Some("arena"|"anyAttackable")) && r.arena.is_none() && !r.optional && r.mode.is_none() && r.count.is_none() && r.prompt_title.is_none() && r.predicate.as_ref().map_or(true,damaged_predicate));
            if depth!=0 || !["whenPlayed","whenDefeated"].contains(&ability.trigger.as_str()) || !ability.optional || ability.requires_confirmation || ability.coordinate || !ability.context_title.is_empty() || !ability.costs.is_empty() || ability.condition.is_some() || ability.then.is_some() || ability.if_you_do.is_some() || !ability.target_resolvers.is_empty() || !shape || !selector {return Err("Weakness requires an optional standalone scalar unit play/death registration with amount one".into());}
        }

        if !ability.target_resolvers.is_empty() {
            if depth!=0 || !["event","whenPlayed","onAttack"].contains(&ability.trigger.as_str()) || ability.target_resolvers.len()!=2 || ability.target_resolver.is_some() || ability.optional || ability.requires_confirmation || ability.coordinate || !ability.context_title.is_empty() || !ability.costs.is_empty() || ability.condition.is_some() || ability.then.is_some() || ability.if_you_do.is_some() || !matches!(ability.effect,Effect::NoAction) {
                return Err("named selectors require two independent standalone event/WhenPlayed/OnAttack stat systems".into());
            }
            let mut names=std::collections::HashSet::new();
            let mut effects=Vec::new();
            for (index,descriptor) in ability.target_resolvers.iter().enumerate() {
                if descriptor.name.is_empty() || descriptor.name=="target" || !descriptor.name.chars().all(|c|c.is_ascii_alphanumeric()||c=='_') || !names.insert(descriptor.name.as_str()) || descriptor.chooser!="self" {return Err("named selectors require distinct ordinary names and own chooser".into());}
                let mut r=descriptor.target_resolver.clone();
                r.prompt_title=None;
                r.validate()?;
                if r.owner!="any" || r.card_type!="unit" || (!r.optional && !(ability.trigger=="onAttack" && index==0)) || r.mode.is_some() || r.count.is_some() || !matches!(r.zone.as_deref(),Some("arena"|"anyAttackable")) || r.arena.as_deref().is_some_and(|a|!["ground","space"].contains(&a)) {return Err("named selectors require optional scalar any-owner arena units".into());}
                if ability.trigger=="onAttack" && r.predicate.is_some() {return Err("named attack selectors require unconditional arena domains".into());}
                if let Some(predicate)=&r.predicate {
                    if !matches!(predicate,Expr::Query{name,receiver,args} if name=="hasSomeTrait" && matches!(receiver.as_ref(),Expr::Ref{path} if path.len()==1&&path[0]=="card") && args.len()==1 && matches!(&args[0],Expr::Const{value} if value.as_str().is_some_and(|v|!v.is_empty()))) {return Err("named selector predicates require one literal unit trait".into());}
                }
                fn literal(e:&Expr,negative:bool)->Option<Expr> {
                    match e {Expr::Const{value} if value.as_i64().is_some_and(|v|(-65535..=65535).contains(&v))=>Some(e.clone()),Expr::Unary{op,value} if negative && op=="-"=>match value.as_ref(){Expr::Const{value}=>value.as_u64().filter(|v|*v<=65535).map(|v|Expr::Const{value:Value::from(-(v as i64))}),_=>None},_=>None}
                }
                let effect=match &descriptor.effect {
                    Effect::ModifyStats{target:Target::Name(n),duration,power,hp} if n=="chosen" && duration=="phase"=>Effect::ModifyStats{target:Target::Name(n.clone()),duration:duration.clone(),power:literal(power,ability.trigger=="onAttack").ok_or("named selectors require literal scalar phase power")?,hp:literal(hp,ability.trigger=="onAttack").ok_or("named selectors require literal scalar phase HP")?},
                    _=>return Err("named selectors require literal scalar phase stats".into()),
                };
                effects.push(Effect::Select{target_resolver:r,effect:Box::new(effect)});
            }
            let effect=Effect::Simultaneous{effects};
            self.validate_group(&effect,1)?;
            self.instructions.push(Instruction::NamedGroup(effect));
            return Ok(());
        }

        if matches!(&ability.effect,Effect::GainKeyword {target:Target::ArenaList(_),..}|Effect::LoseKeyword {target:Target::ArenaList(_),..}) {
            if depth!=0 || !["event","whenPlayed"].contains(&ability.trigger.as_str()) || ability.optional || ability.target_resolver.is_some() || ability.condition.is_some() || ability.then.is_some() || ability.if_you_do.is_some() || ability.coordinate || !ability.context_title.is_empty() {
                return Err("arena-list keywords require a standalone event or WhenPlayed registration".into());
            }
        }
        if ability.target_resolver.as_ref().is_some_and(|r|r.is_upgrade_domain() && (r.is_multiple() || !scalar_upgrade_operation(&ability.effect,r.zone.as_deref()==Some("discard")))) {return Err("upgrade selection supports only scalar defeat or return to hand".into());}
        if depth > MAX_ABILITY_NESTING {
            return Err("ability continuation nesting exceeds capacity".into());
        }
        if depth > 0
            && (ability.coordinate || !ability.context_title.is_empty()
                || !ability.costs.is_empty()
                || ability.optional
                || !ability.trigger.is_empty()
                || ability.condition.is_some()
                || ability.requires_confirmation)
        {
            return Err(
                "nested continuation costs, optional triggers and registrations are unsupported"
                    .into(),
            );
        }
        fn uses_group(effect: &Effect) -> bool {
            match effect { Effect::Simultaneous { .. } | Effect::PhaseModifiers { .. } => true,
                Effect::Select {target_resolver,effect} => target_resolver.is_multiple() || uses_group(effect),
                Effect::Conditional {on_true,on_false,..} => uses_group(on_true) || on_false.as_deref().is_some_and(uses_group),
                Effect::Sequence {effects} => effects.iter().any(uses_group), _ => false }
        }
        let multiple = ability.target_resolver.as_ref().is_some_and(TargetResolver::is_multiple);
        if (multiple || uses_group(&ability.effect)) && (ability.then.is_some() || ability.if_you_do.is_some()) { return Err("event groups and array selections cannot have unverified continuations".into()); }
        if let Some(target) = &ability.target_resolver {
            target.validate()?;
            self.instructions.push(Instruction::Select(target.clone()));
        }
        if multiple {
            self.validate_group(&ability.effect, ability.target_resolver.as_ref().unwrap().max_targets()?)?;
            self.instructions.push(Instruction::Group(ability.effect.clone()));
        } else { self.compile_effect(&ability.effect, depth)?; }
        if let Some(next) = &ability.then {
            self.compile_ability(next, depth + 1)?;
        }
        if let Some(next) = &ability.if_you_do {
            let start = self.instructions.len();
            self.instructions.push(Instruction::IfResult { skip: 0 });
            self.compile_ability(next, depth + 1)?;
            self.instructions[start] = Instruction::IfResult {
                skip: self.instructions.len(),
            };
        }
        Ok(())
    }
    fn scalar_hand_amount(amount:&Expr,target:&Target)->Result<usize,String> {
        if !matches!(target,Target::Name(name) if ["ownPlayer","enemyPlayer"].contains(&name.as_str())) {return Err("hand effects require a scalar player target".into());}
        match amount {Expr::Const {value}=>value.as_u64().filter(|n|(1..=2).contains(n)).map(|n|n as usize).ok_or("hand effect amount must be 1..2".into()),_=>Err("hand effects require literal bounded amounts".into())}
    }
    fn scalar_deck_amount(amount:&Expr,target:&Target)->Result<usize,String> {
        if !matches!(target,Target::Name(name) if ["ownPlayer","enemyPlayer"].contains(&name.as_str())) {return Err("deck discard requires a scalar player target".into());}
        match amount {Expr::Const {value}=>value.as_u64().filter(|n|*n<=5).map(|n|n as usize).ok_or("deck discard amount must be 0..5".into()),_=>Err("deck discard requires a literal bounded amount".into())}
    }
    fn token_unit_amount(token_type:&str,amount:&Expr,target:&Target)->Result<usize,String> {
        if !["battleDroid","cloneTrooper","beast","spy","tieFighter","xwing","mandalorian"].contains(&token_type) {return Err("unsupported created token unit type".into());}
        if !matches!(target,Target::Name(name) if ["ownPlayer","enemyPlayer"].contains(&name.as_str())) {return Err("token creation requires a scalar player target".into());}
        match amount {Expr::Const {value}=>value.as_u64().filter(|n|(1..=5).contains(n)).map(|n|n as usize).ok_or("token creation amount must be 1..5".into()),_=>Err("token creation requires a literal bounded amount".into())}
    }
    fn validate_phase_modifiers(&self, effects: &[Effect]) -> Result<(), String> {
        if effects.is_empty() || effects.len() > 8 { return Err("phase modifier list exceeds bounded capacity".into()); }
        let mut shared_target = None;
        for effect in effects {
            let (target, duration) = match effect {
                Effect::ModifyStats {target, duration, ..} | Effect::GainKeyword {target, duration, ..} | Effect::LoseKeyword {target, duration, ..} => (target, duration),
                _ => return Err("phase modifier lists contain only primitive lasting modifiers".into()),
            };
            if duration != "phase" { return Err("phase modifier list requires phase duration".into()); }
            let encoded = serde_json::to_value(target).map_err(|e| e.to_string())?;
            if shared_target.as_ref().is_some_and(|prior| prior != &encoded) { return Err("phase modifier list must share one target".into()); }
            shared_target = Some(encoded);
            let mut checker = self.clone(); checker.instructions.clear(); checker.compile_effect(effect, 0)?;
        }
        Ok(())
    }
    fn validate_group(&self, effect: &Effect, targets: usize) -> Result<(), String> {
        fn dependent_in_scope(e: &Expr, card_bound: bool) -> bool {
            match e {
                Expr::Ref {path} => matches!(path.first().map(String::as_str), Some("target" | "targets")) || (!card_bound && path.first().is_some_and(|p|p=="card")),
                Expr::Array {items} => items.iter().any(|e|dependent_in_scope(e,card_bound)),
                Expr::Math {args, ..} => args.iter().any(|e|dependent_in_scope(e,card_bound)),
                Expr::Unary {value, ..} => dependent_in_scope(value,card_bound),
                Expr::Binary {left, right, ..} => dependent_in_scope(left,card_bound) || dependent_in_scope(right,card_bound),
                Expr::Conditional {condition, then, r#else} => dependent_in_scope(condition,card_bound) || dependent_in_scope(then,card_bound) || dependent_in_scope(r#else,card_bound),
                Expr::Query {name,receiver,args} => dependent_in_scope(receiver,card_bound) || args.iter().enumerate().any(|(i,e)|dependent_in_scope(e,card_bound || (i==0 && ["hasSomeArenaUnit","arenaUnitCount"].contains(&name.as_str())))),
                Expr::Const { .. } => false,
            }
        }
        fn target_dependent(e: &Expr) -> bool { dependent_in_scope(e,false) }
        fn multiplicity(target: &Target, selected: usize, array: bool) -> Result<usize, String> {
            fn card_expr(e: &Expr, array: bool) -> Result<(), String> {
                match e {
                    Expr::Ref {path} => match path.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
                        ["source"] | ["player" | "opponent", "base"] => Ok(()),
                        ["target"] if !array => Ok(()),
                        _ => Err("group expression targets require scalar card references; array target and player references are unverified".into()),
                    },
                    Expr::Conditional {condition,then,r#else} => { if array && target_dependent(condition) { return Err("array-dependent expression targets are unsupported".into()); } card_expr(then,array)?; card_expr(r#else,array) },
                    _ => Err("unsupported group card expression target".into()),
                }
            }
            match target {
                Target::Name(name) => match name.as_str() {
                    "chosen" => Ok(selected), "bothBases" => Ok(2), "self" | "ownBase" | "enemyBase" => Ok(1),
                    _ => Err("card event groups do not support player targets".into()),
                },
                Target::Expression(e) => { card_expr(e,array)?; Ok(1) },
                Target::ArenaList(_)=>Err("grouped arena lists require separate event-capacity witnesses".into()),
            }
        }
        fn walk(p: &Program, effect: &Effect, targets: usize, array: bool, depth: usize) -> Result<(usize, bool, bool), String> {
            if depth > MAX_ABILITY_NESTING { return Err("event group nesting exceeds capacity".into()); }
            let (records, damage, newly_attached) = match effect {
                Effect::Simultaneous {effects} => {
                    if effects.is_empty() || effects.len() > 8 { return Err("simultaneous group requires one to eight children".into()); }
                    let mut records = 0usize; let mut damage = false; let mut new = false;
                    for child in effects { let (n,d,a) = walk(p, child, targets, array, depth + 1)?; records = records.checked_add(n).ok_or("event group capacity overflow")?; damage |= d; new |= a; }
                    (records, damage, new)
                },
                Effect::Conditional {condition, on_true, on_false} => {
                    condition.validate()?;
                    if array && target_dependent(condition) { return Err("array-dependent group conditional is unsupported".into()); }
                    let a = walk(p,on_true,targets,array,depth+1)?;
                    let b = if let Some(other)=on_false { walk(p,other,targets,array,depth+1)? } else { (0,false,false) };
                    (a.0.max(b.0),a.1||b.1,a.2||b.2)
                },
                Effect::Select {target_resolver, effect} => {
                    if target_resolver.is_upgrade_domain() {return Err("grouped upgrade selection is not modeled".into());}
                    target_resolver.validate()?;
                    if array && target_resolver.predicate.as_ref().is_some_and(|e|dependent_in_scope(e,true)) { return Err("array-dependent nested selection is unsupported".into()); }
                    // Nested selection replaces the outer selected value, not its multiplicity.
                    walk(p,effect,target_resolver.max_targets()?,target_resolver.is_multiple(),depth+1)?
                },
                Effect::PhaseModifiers {effects} => {
                    p.validate_phase_modifiers(effects)?;
                    if array && effects.iter().any(|e| match e { Effect::ModifyStats {power,hp,..} => target_dependent(power)||target_dependent(hp), Effect::GainKeyword {amount,..} => target_dependent(amount), _ => false }) { return Err("array-dependent phase modifier values are unsupported".into()); }
                    let mut records=0usize;
                    for e in effects { let target=match e { Effect::ModifyStats {target,..}|Effect::GainKeyword {target,..}|Effect::LoseKeyword {target,..}=>target,_=>unreachable!() }; records+=multiplicity(target,targets,array)?; }
                    (records,false,true)
                },
                Effect::DiscardOwnHand {amount,target} => (Program::scalar_hand_amount(amount,target)?+1,false,false),
                Effect::DiscardDeck {amount,target} => (Program::scalar_deck_amount(amount,target)?+1,false,false),
                Effect::Draw {amount,target} => {Program::scalar_hand_amount(amount,target)?;(2,false,false)},
                Effect::CreateTokenUnit {token_type,amount,target,..} => (Program::token_unit_amount(token_type,amount,target)?+1,false,true),
                Effect::Sequence { .. } | Effect::ReturnToHand { .. } | Effect::ReadyResources { .. } | Effect::DistributeHealing { .. } => return Err("event group contains an unverified operation".into()),
                Effect::NoAction => (0,false,false),
                primitive => {
                    let mut checker=p.clone(); checker.instructions.clear(); checker.compile_effect(primitive,depth+1)?;
                    let amount = match primitive { Effect::Damage {amount,..} | Effect::Heal {amount,..} | Effect::GiveShield {amount,..} | Effect::GiveExperience {amount,..} | Effect::GainKeyword {amount,..} => Some(amount), _ => None };
                    if array && amount.is_some_and(target_dependent) { return Err("array-dependent group amount is unsupported".into()); }
                    if array && matches!(primitive, Effect::ModifyStats {power,hp,..} if target_dependent(power)||target_dependent(hp)) { return Err("array-dependent phase modifier values are unsupported".into()); }
                    let destination=match primitive { Effect::Damage {target,..}|Effect::Heal {target,..}|Effect::GiveShield {target,..}|Effect::GiveExperience {target,..}|Effect::Ready {target}|Effect::Exhaust {target}|Effect::Defeat {target}|Effect::ModifyStats {target,..}|Effect::GainKeyword {target,..}|Effect::LoseKeyword {target,..} => target, _ => unreachable!() };
                    let expanded=multiplicity(destination,targets,array)?;
                    match primitive {
                        Effect::GiveShield {amount,..} | Effect::GiveExperience {amount,..} => {
                            let Expr::Const {value} = amount else { return Err("group tokens require literal bounded amounts".into()); };
                            let n=value.as_u64().filter(|n| (1..=2).contains(n)).ok_or("group tokens require one or two per target")? as usize;
                            (expanded * n * 2,false,true)
                        },
                        Effect::Damage { .. } => (expanded,true,false),
                        Effect::ModifyStats { .. } | Effect::GainKeyword { .. } | Effect::LoseKeyword { .. } => (expanded,false,true),
                        _ => (expanded,false,false),
                    }
                }
            };
            if records > MAX_GROUP_RECORDS { return Err("event group record budget exceeds capacity".into()); }
            if damage && newly_attached { return Err("mixed damage and newly attached tokens/lasting modifiers require dedicated engine witnesses".into()); }
            fn has_hand_effect(e:&Effect)->bool {match e {Effect::Draw{..}|Effect::DiscardOwnHand{..}|Effect::DiscardDeck{..}=>true,Effect::Simultaneous{effects}|Effect::PhaseModifiers{effects}=>effects.iter().any(has_hand_effect),Effect::Conditional{on_true,on_false,..}=>has_hand_effect(on_true)||on_false.as_deref().is_some_and(has_hand_effect),Effect::Select{effect,..}=>has_hand_effect(effect),_=>false}}
            if damage && has_hand_effect(effect) {return Err("mixed damage and hand effects require dedicated engine witnesses".into());}
            Ok((records,damage,newly_attached))
        }
        fn operation_budget(e: &Effect, depth: usize) -> Result<usize,String> {
            if depth > MAX_ABILITY_NESTING { return Err("event group nesting exceeds capacity".into()); }
            let n=match e {
                Effect::Simultaneous {effects}|Effect::PhaseModifiers {effects} => { let mut sum=0usize;for e in effects {sum+=operation_budget(e,depth+1)?;if sum>MAX_GROUP_OPS {return Err("event group operation budget exceeds capacity".into());}}sum },
                Effect::Conditional {on_true,on_false,..} => 2+operation_budget(on_true,depth+1)?+if let Some(e)=on_false {operation_budget(e,depth+1)?}else{0},
                Effect::Select {effect,..} => 2+operation_budget(effect,depth+1)?,
                Effect::NoAction=>0,_=>1,
            };
            if n>MAX_GROUP_OPS {return Err("event group operation budget exceeds capacity".into());}Ok(n)
        }
        fn contains_select(e: &Effect) -> bool { match e { Effect::Select {..}=>true,Effect::Simultaneous {effects}|Effect::PhaseModifiers {effects}|Effect::Sequence {effects}=>effects.iter().any(contains_select),Effect::Conditional {on_true,on_false,..}=>contains_select(on_true)||on_false.as_deref().is_some_and(contains_select),_=>false } }
        fn primitive_captures_target(e: &Effect) -> bool {
            fn target(t: &Target) -> bool { match t { Target::Name(n)=>n=="chosen",Target::Expression(e)=>target_dependent(e),Target::ArenaList(_)=>true } }
            match e {
                Effect::Damage {target:t,amount}|Effect::Heal {target:t,amount}|Effect::Draw {target:t,amount}|Effect::GiveShield {target:t,amount}|Effect::GiveExperience {target:t,amount}|Effect::ReadyResources {target:t,amount}|Effect::GainKeyword {target:t,amount,..}=>target(t)||target_dependent(amount),
                Effect::ModifyStats {target:t,power,hp,..}=>target(t)||target_dependent(power)||target_dependent(hp),
                Effect::Ready {target:t}|Effect::Exhaust {target:t}|Effect::Defeat {target:t}|Effect::ReturnToHand {target:t}|Effect::LoseKeyword {target:t,..}=>target(t),
                _=>false,
            }
        }
        fn validate_shared_target(e: &Effect, changed: bool) -> Result<(),String> {
            match e {
                // The new selection supplies a fresh target for its child; lexical factory captures are rejected by the compiler.
                Effect::Select {effect,..}=>validate_shared_target(effect,false),
                Effect::Simultaneous {effects}|Effect::PhaseModifiers {effects}=>{let mut changed=changed;for e in effects {validate_shared_target(e,changed)?;changed|=contains_select(e);}Ok(())},
                Effect::Conditional {condition,on_true,on_false}=>{
                    if changed&&target_dependent(condition) {return Err("target-dependent sibling after nested selection requires capture semantics".into());}
                    validate_shared_target(on_true,changed)?;if let Some(e)=on_false {validate_shared_target(e,changed)?;}Ok(())
                },
                primitive=>{
                    if changed {
                        if primitive_captures_target(primitive) {return Err("target-dependent sibling after nested selection requires capture semantics".into());}
                    }Ok(())
                }
            }
        }
        fn unique_draw_players(e:&Effect,seen:&mut Vec<String>)->Result<(),String> {
            match e {
                Effect::Draw {target:Target::Name(player),..}=>{if seen.contains(player) {return Err("multiple grouped draws for one player require separate contingent witnesses".into());}seen.push(player.clone());}
                Effect::Simultaneous {effects}|Effect::PhaseModifiers {effects}=>for e in effects {unique_draw_players(e,seen)?;},
                Effect::Conditional {on_true,on_false,..}=>{unique_draw_players(on_true,seen)?;if let Some(e)=on_false {unique_draw_players(e,seen)?;}},
                Effect::Select {effect,..}=>unique_draw_players(effect,seen)?,_=>{},
            }Ok(())
        }
        unique_draw_players(effect,&mut vec![])?;
        operation_budget(effect,0)?;
        validate_shared_target(effect,false)?;
        let array=self.instructions.iter().rev().find_map(|i|if let Instruction::Select(r)=i {Some(r.is_multiple())}else{None}).unwrap_or(false);
        walk(self,effect,targets,array,0)?;
        #[derive(Clone)]
        enum Domain { Source, Base(Option<bool>), Unit(Option<bool>, bool), Unknown }
        fn source_excluded(e: &Expr) -> bool {
            fn path(e: &Expr, root: &str) -> bool { matches!(e,Expr::Ref {path} if path.len()==1 && path[0]==root) }
            match e {
                Expr::Binary {op,left,right} if op == "!==" => (path(left,"card")&&path(right,"source"))||(path(right,"card")&&path(left,"source")),
                Expr::Binary {op,left,right} if op == "&&" => source_excluded(left)||source_excluded(right),
                _ => false,
            }
        }
        fn selected_domain(r: Option<&TargetResolver>) -> Domain {
            let Some(r)=r else { return Domain::Unknown; };
            let owner=match r.owner.as_str() { "self"=>Some(false),"opponent"=>Some(true),_=>None };
            if r.card_type=="base" || r.zone.as_deref()==Some("base") { Domain::Base(owner) }
            else if ["unit","nonLeaderUnit","leaderUnit"].contains(&r.card_type.as_str()) || r.zone.as_deref()==Some("arena") { Domain::Unit(owner,r.predicate.as_ref().is_some_and(source_excluded)) }
            else { Domain::Unknown }
        }
        fn domains(t: &Target, selected: &Domain) -> Vec<Domain> {
            match t {
                Target::Name(n) => match n.as_str() { "self"=>vec![Domain::Source],"ownBase"=>vec![Domain::Base(Some(false))],"enemyBase"=>vec![Domain::Base(Some(true))],"bothBases"=>vec![Domain::Base(Some(false)),Domain::Base(Some(true))],"chosen"=>vec![selected.clone()],_=>vec![Domain::Unknown] },
                Target::Expression(Expr::Ref {path}) => match path.iter().map(String::as_str).collect::<Vec<_>>().as_slice() { ["source"]=>vec![Domain::Source],["player","base"]=>vec![Domain::Base(Some(false))],["opponent","base"]=>vec![Domain::Base(Some(true))],["target"]=>vec![selected.clone()],_=>vec![Domain::Unknown] },
                Target::Expression(Expr::Conditional {then,r#else,..}) => { let mut result=domains(&Target::Expression(*then.clone()),selected);result.extend(domains(&Target::Expression(*r#else.clone()),selected));result },
                _=>vec![Domain::Unknown],
            }
        }
        fn disjoint(a: &Domain,b: &Domain) -> bool {
            match (a,b) {
                (Domain::Base(_),Domain::Unit(..)) | (Domain::Unit(..),Domain::Base(_)) => true,
                (Domain::Base(Some(a)),Domain::Base(Some(b))) | (Domain::Unit(Some(a),_),Domain::Unit(Some(b),_)) => a!=b,
                (Domain::Source,Domain::Unit(owner,excluded)) | (Domain::Unit(owner,excluded),Domain::Source) => *excluded || *owner==Some(true),
                (Domain::Source,Domain::Base(Some(true))) | (Domain::Base(Some(true)),Domain::Source) => true,
                _=>false,
            }
        }
        fn damage_sets(e: &Effect,selected:&Domain,out:&mut Vec<Vec<Domain>>,defeat:&mut bool) {
            match e {
                Effect::Damage {target,..}=>out.push(domains(target,selected)),
                Effect::Defeat {..}=>*defeat=true,
                Effect::Simultaneous {effects}|Effect::PhaseModifiers {effects}=>for e in effects {damage_sets(e,selected,out,defeat)},
                Effect::Select {target_resolver,effect}=>damage_sets(effect,&selected_domain(Some(target_resolver)),out,defeat),
                Effect::Conditional {on_true,on_false,..}=>{damage_sets(on_true,selected,out,defeat);if let Some(e)=on_false {damage_sets(e,selected,out,defeat)}},
                _=>{},
            }
        }
        let selected=self.instructions.iter().rev().find_map(|i|if let Instruction::Select(r)=i {Some(r)}else{None});
        let mut sets=vec![];let mut defeat=false;damage_sets(effect,&selected_domain(selected),&mut sets,&mut defeat);
        if !sets.is_empty()&&defeat { return Err("mixed damage and explicit defeat groups require dedicated witnesses".into()); }
        for i in 0..sets.len() { for j in i+1..sets.len() {
            if sets[i].iter().any(|a|sets[j].iter().any(|b|!disjoint(a,b))) { return Err("group damage destinations must be provably disjoint until repeated-damage replacement semantics are witnessed".into()); }
        } }
        Ok(())
    }
    fn compile_effect(&mut self, effect: &Effect, depth: usize) -> Result<(), String> {
        if depth > MAX_ABILITY_NESTING {
            return Err("effect nesting exceeds capacity".into());
        }
        match effect {
            Effect::DiscardDeck {amount,target} => {Self::scalar_deck_amount(amount,target)?;self.instructions.push(Instruction::Group(effect.clone()));}
            Effect::DiscardOwnHand {amount,target} => {Self::scalar_hand_amount(amount,target)?;self.instructions.push(Instruction::Group(effect.clone()));}
            Effect::CreateTokenUnit {token_type,amount,target,..} => {Self::token_unit_amount(token_type,amount,target)?;self.instructions.push(Instruction::Group(effect.clone()));}
            Effect::Sequence { effects } => { for effect in effects { self.compile_effect(effect, depth + 1)?; } }
            Effect::Conditional { condition, on_true, on_false } => {
                condition.validate()?;let start=self.instructions.len();self.instructions.push(Instruction::Conditional {condition:condition.clone(),skip:0});
                self.compile_effect(on_true,depth+1)?;let jump=self.instructions.len();self.instructions.push(Instruction::Jump{to:0});
                self.instructions[start]=Instruction::Conditional{condition:condition.clone(),skip:self.instructions.len()};
                if let Some(other)=on_false{self.compile_effect(other,depth+1)?;}else{self.instructions.push(Instruction::Apply(Effect::NoAction));}
                self.instructions[jump]=Instruction::Jump{to:self.instructions.len()};
            }
            Effect::Simultaneous { effects } if self.trigger == "constant" => { for effect in effects { self.compile_effect(effect, depth + 1)?; } }
            Effect::Simultaneous { .. } => { self.validate_group(effect,1)?; self.instructions.push(Instruction::Group(effect.clone())); }
            Effect::PhaseModifiers {effects:_} => { self.validate_group(effect,1)?; self.instructions.push(Instruction::Apply(effect.clone())); }
            Effect::DistributeHealing { amount, max_targets, target_resolver, .. } => {
                amount.validate_number()?;target_resolver.validate()?;
                if *max_targets != 1 { return Err("distribution runtime currently supports exactly one selected target".into()); }
                if !matches!(amount, Expr::Const{value} if value.as_u64().is_some_and(|n|n<=2)){return Err("distribution runtime currently supports up to two healing".into());}
                self.instructions.push(Instruction::Apply(effect.clone()));
            }
            Effect::ReadyResources {amount,target} => {
                amount.validate_number()?;target.validate()?;
                if matches!(target,Target::Name(name) if name=="bothPlayers") {return Err("multi-player resource ready requires verified event batching".into());}
                self.instructions.push(Instruction::Apply(effect.clone()));
            }
            Effect::Damage { amount, target } | Effect::Heal { amount, target } | Effect::Draw { amount, target } | Effect::GiveShield { amount, target } | Effect::GiveExperience { amount, target } => { amount.validate()?; if amount.references_title() { return Err("card title metadata is not an effect amount".into()); } target.validate()?;self.instructions.push(Instruction::Apply(effect.clone())); }
            Effect::Select { target_resolver, effect } => {
                if target_resolver.is_upgrade_domain() && (target_resolver.is_multiple() || !scalar_upgrade_operation(effect,target_resolver.zone.as_deref()==Some("discard"))) {return Err("upgrade selection supports only scalar defeat or return to hand".into());}
                target_resolver.validate()?; self.instructions.push(Instruction::Commit); self.instructions.push(Instruction::Select(target_resolver.clone()));
                if target_resolver.is_multiple() { self.validate_group(effect,target_resolver.max_targets()?)?; self.instructions.push(Instruction::Group(*effect.clone())); }
                else { self.compile_effect(effect,depth+1)?; }
            }
            Effect::UseForce {target}|Effect::GainForce{target} => {if !matches!(target,Target::Name(n) if n=="ownPlayer") {return Err("Force requires default own player target".into());}self.instructions.push(Instruction::Apply(effect.clone()));}
            Effect::GiveWeakness {amount,target} => {if !matches!(amount,Expr::Const{value} if value.as_u64()==Some(1)) || !matches!(target,Target::Name(n) if n=="chosen") {return Err("Weakness supports one selected unit token".into());}self.instructions.push(Instruction::Apply(effect.clone()));}
            Effect::NoAction => self.instructions.push(Instruction::Apply(effect.clone())),
            Effect::Defeat {target:Target::ArenaList(list)} => {
                if depth!=0 {return Err("nested arena-list defeat requires explicit timing witnesses".into());}
                list.validate_scope(true)?;self.instructions.push(Instruction::Apply(effect.clone()));
            }
            Effect::ResourceCard {target} => {if !matches!(target,Target::Name(n) if n=="self") {return Err("resourceCard supports self only".into());} self.instructions.push(Instruction::Apply(effect.clone()));}
            Effect::ReturnToHand { target } => { target.validate()?; self.instructions.push(Instruction::Apply(effect.clone())); }
            Effect::ModifyStats { target, power, hp, duration } => {
                if matches!(target,Target::ArenaList(_)) && depth!=0 {return Err("nested arena-list modifiers require explicit continuation witnesses".into());}
                if duration != "phase" && !(self.trigger=="constant" && duration=="persistent") { return Err("only phase stat modifications execute".into()); }
                if let Target::ArenaList(list)=target {list.validate_phase_stats()?;}else{target.validate()?;}
                if matches!(target,Target::ArenaList(_)) {
                    // Unary plus is emitted by signed source literals. Normalize only this
                    // bounded stat scope; general expression unary-plus remains rejected.
                    fn normalized(e:&Expr)->Expr {match e {Expr::Unary{op,value} if op=="+" && matches!(value.as_ref(),Expr::Const{value} if value.as_i64().is_some_and(|n|(0..=65535).contains(&n)))=>*value.clone(),_=>e.clone()}}
                    let power=normalized(power);let hp=normalized(hp);power.validate_number()?;hp.validate_number()?;
                    self.instructions.push(Instruction::Apply(Effect::ModifyStats{target:target.clone(),power,hp,duration:duration.clone()}));
                }else {
                    if duration=="persistent" {power.live_stat_bounds()?;hp.live_stat_bounds()?;}else{power.validate_number()?;hp.validate_number()?;}
                    self.instructions.push(Instruction::Apply(effect.clone()));
                }
            }
            Effect::GainKeyword { target, keyword, amount, duration } => {
                validate_keyword(keyword)?;
                if duration != "phase" && !(self.trigger == "constant" && duration == "persistent") { return Err("only phase or constant keywords execute".into()); }
                if let Target::ArenaList(list)=target {
                    if depth!=0 || duration!="phase" {return Err("nested or constant arena-list keywords are unsupported".into());}
                    list.validate_scope(true)?;
                }else{target.validate()?;} amount.validate_number()?;
                let bounded_shape = matches!(amount, Expr::Const {value} if value.as_u64().is_some_and(|n| n <= 65535))
                    || (duration == "persistent" && matches!(amount, Expr::Ref {path} if matches!(path.last().map(String::as_str), Some("damage" | "readyResourceCount" | "exhaustedResourceCount"))));
                if !bounded_shape { return Err("keyword amounts require nonnegative literals or verified live damage/resource counts".into()); }
                if keyword == "restore" && !matches!(amount, Expr::Const {value} if value.as_u64().is_some_and(|n| n > 0 && n <= 65535)) { return Err("Restore grants require positive literals until nullable zero-trigger titles are verified".into()); }


                if let Expr::Const { value } = amount { if !value.as_u64().is_some_and(|n| n <= 65535) { return Err("keyword amount must be bounded nonnegative integer".into()); } }
                if !["raid", "restore"].contains(&keyword.as_str()) && !matches!(amount, Expr::Const {value} if value.as_u64() == Some(1)) { return Err("boolean keyword amount must be one".into()); }
                self.instructions.push(Instruction::Apply(effect.clone()));
            }
            Effect::LoseKeyword { target, keyword, duration } => {
                validate_keyword(keyword)?;
                if duration != "phase" && !(self.trigger == "constant" && duration == "persistent") { return Err("only phase or constant keyword losses execute".into()); }
                if let Target::ArenaList(list)=target {
                    if depth!=0 || duration!="phase" {return Err("nested or constant arena-list keyword loss is unsupported".into());}
                    list.validate_scope(true)?;
                }else{target.validate()?;} self.instructions.push(Instruction::Apply(effect.clone()));
            }
            Effect::Ready { target } | Effect::Exhaust { target } | Effect::Defeat { target } => { target.validate()?;self.instructions.push(Instruction::Apply(effect.clone())); }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default)]
pub struct CardPrograms {
    pub leader: Vec<u16>,
    pub unit: Vec<u16>,
    pub card: Vec<u16>,
    pub attach_condition: Option<Expr>,
}

#[derive(Debug, Default)]
pub struct Catalogue {
    pub programs: Vec<Program>,
    pub cards: std::collections::HashMap<String, CardPrograms>,
    pub metadata: std::collections::HashMap<String, Value>,
    pub rejected: std::collections::BTreeMap<String, String>,
}
impl Catalogue {
    /// Converts every compiler entry into executable programs or a named, explicit
    /// rejection. A syntactically compiled card is never assumed executable.
    pub fn load(value: &Value) -> Result<Self, String> {
        if value["schema"] != SCHEMA {
            return Err(format!("unsupported ability IR schema {}", value["schema"]));
        }
        let entries = value["cards"]
            .as_array()
            .ok_or("IR catalogue needs cards")?;
        let mut catalogue = Self::default();
        for entry in entries {
            let code = entry["setCode"]
                .as_str()
                .ok_or("IR card missing setCode")?
                .to_owned();
            if catalogue.cards.contains_key(&code) || catalogue.rejected.contains_key(&code) {
                return Err(format!("duplicate IR card {code}"));
            }
            let result = || -> Result<(CardPrograms, Vec<Program>), String> {
                if entry["status"] != "supported" {
                    return Err(format!(
                        "compiler rejected {}: {}",
                        entry["internalName"], entry["diagnostics"]
                    ));
                }
                fn parent_reference(value:&Value)->bool {
                    (value["kind"]=="ref" && value["path"][1].as_str().is_some_and(|p|p=="parentCard"||p=="parentUnit")) || (value["target"]=="parent") || match value {Value::Array(a)=>a.iter().any(parent_reference),Value::Object(o)=>o.values().any(parent_reference),_=>false}
                }
                if parent_reference(&entry["abilities"]) && entry["baseClass"]!="UpgradeCard" {return Err("parent references require an ordinary attached upgrade".into());}
                let sides: Sides = serde_json::from_value(entry["abilities"].clone())
                    .map_err(|e| format!("invalid ability IR: {e}"))?;
                let exact_type=|expected:&str|entry["card"]["types"].as_array().is_some_and(|types|types.len()==1&&types[0]==expected);
                if sides.leader.iter().chain(&sides.unit).any(|a|!a.target_resolvers.is_empty()) || sides.card.iter().any(|a|!a.target_resolvers.is_empty() && !((a.trigger=="event" && entry["baseClass"]=="EventCard" && exact_type("event")) || (["whenPlayed","onAttack"].contains(&a.trigger.as_str()) && entry["baseClass"]=="NonLeaderUnitCard" && exact_type("unit")))) {return Err("named selectors support ordinary unit WhenPlayed or event card-side sources".into());}
                if sides.leader.iter().chain(&sides.unit).any(|a|contains_weakness(&a.effect)) || sides.card.iter().any(|a|contains_weakness(&a.effect) && (entry["baseClass"]!="NonLeaderUnitCard" || !exact_type("unit"))) {return Err("Weakness source must be an ordinary unit card-side registration".into());}
                let arena_stats=|a:&Ability|matches!(&a.effect,Effect::ModifyStats{target:Target::ArenaList(_),..});
                if sides.leader.iter().chain(&sides.unit).any(arena_stats) || sides.card.iter().any(|a|arena_stats(a) && !((a.trigger=="event"&&entry["baseClass"]=="EventCard"&&exact_type("event")) || (a.trigger=="whenPlayed"&&entry["baseClass"]=="NonLeaderUnitCard"&&exact_type("unit")))) {return Err("arena phase stats require ordinary unit WhenPlayed or event card-side metadata".into());}
                let upgrade_force=|a:&Ability|entry["baseClass"]=="UpgradeCard" && exact_type("upgrade") && a.trigger=="whenPlayed" && a.optional && matches!(&a.effect,Effect::UseForce{target:Target::Name(n)} if n=="ownPlayer") && a.if_you_do.as_ref().is_some_and(|next|next.target_resolver.as_ref().is_some_and(|r|r.owner=="any" && r.card_type=="any" && r.zone.as_deref()==Some("base")) && matches!(&next.effect,Effect::Heal{target:Target::Name(n),amount:Expr::Const{value}} if n=="chosen" && value.as_u64().is_some_and(|n|(1..=65535).contains(&n))));
                if sides.leader.iter().chain(&sides.unit).any(|a|contains_force(&a.effect)) || sides.card.iter().any(|a|contains_force(&a.effect) && !((entry["baseClass"]=="NonLeaderUnitCard" && exact_type("unit") && ["whenPlayed","whenDefeated","onAttack"].contains(&a.trigger.as_str())) || (entry["baseClass"]=="EventCard" && exact_type("event") && a.trigger=="event") || upgrade_force(a))) {return Err("Force registration requires ordinary unit/event or bounded upgrade play-heal metadata".into());}
                if sides.leader.iter().chain(&sides.unit).any(contains_force_presence) || sides.card.iter().any(|a|contains_force_presence(a) && (entry["baseClass"]!="NonLeaderUnitCard" || !exact_type("unit"))) {return Err("Force presence requires ordinary unit card-side metadata".into());}
                if sides.leader.iter().chain(&sides.unit).any(contains_resource) || sides.card.iter().any(|a|contains_resource(a) && !((entry["baseClass"]=="NonLeaderUnitCard" && exact_type("unit") && a.trigger=="whenDefeated") || (entry["baseClass"]=="EventCard" && exact_type("event") && a.trigger=="event"))) {return Err("resourceCard requires ordinary unit death/event metadata".into());}
                let coordinates=sides.card.iter().filter(|a|a.coordinate).count();
                if sides.leader.iter().chain(&sides.unit).any(|a|a.coordinate) || coordinates>1 || (coordinates==1 && (entry["baseClass"]!="NonLeaderUnitCard" || entry["keywordValues"]["coordinate"].as_u64()!=Some(1))) {return Err("Coordinate requires exactly one printed nonleader card-side registration".into());}
                if entry["keywordValues"].get("coordinate").is_some() && coordinates!=1 {return Err("printed Coordinate must have one implemented registration".into());}
                let mut out = CardPrograms::default();
                if !entry["attachCondition"].is_null() {
                    if entry["baseClass"] != "UpgradeCard" {return Err("attachCondition requires an ordinary upgrade".into());}
                    let condition:Expr=serde_json::from_value(entry["attachCondition"].clone()).map_err(|e|e.to_string())?;
                    if condition.live_only() {return Err("attachment conditions cannot capture modifierTarget/resourcePairs".into());}
                    condition.validate()?;out.attach_condition=Some(condition);
                }

                let mut programs = Vec::new();
                for (src, dst) in [
                    (&sides.leader, &mut out.leader),
                    (&sides.unit, &mut out.unit),
                    (&sides.card, &mut out.card),
                ] {
                    for ability in src {
                        let id = catalogue.programs.len() + programs.len();
                        if id >= u16::MAX as usize {
                            return Err("ability program capacity exceeded".into());
                        }
                        dst.push(id as u16);
                        let program=Program::compile(ability)?;
                        if entry["baseClass"]=="UpgradeCard" {
                            fn source_target(target:&Target)->bool {
                                match target {
                                    Target::Name(name)=>name=="self",
                                    Target::Expression(Expr::Ref {path})=>path.iter().map(String::as_str).collect::<Vec<_>>()==["source"],
                                    Target::Expression(Expr::Conditional {then,r#else,..})=>source_target(&Target::Expression(*then.clone()))||source_target(&Target::Expression(*r#else.clone())),
                                    _=>false,
                                }
                            }
                            fn attachment_defeat(effect:&Effect)->bool {
                                match effect {
                                    Effect::Defeat {target}=>source_target(target),
                                    Effect::Simultaneous {effects}|Effect::PhaseModifiers {effects}|Effect::Sequence {effects}=>effects.iter().any(attachment_defeat),
                                    Effect::Select {effect,..}=>attachment_defeat(effect),
                                    Effect::Conditional {on_true,on_false,..}=>attachment_defeat(on_true)||on_false.as_deref().is_some_and(attachment_defeat),
                                    _=>false,
                                }
                            }
                            if program.instructions.iter().any(|i|matches!(i,Instruction::Group(effect) if attachment_defeat(effect))) {return Err("grouped upgrade source defeat is not modeled".into());}
                        }
                        programs.push(program);
                    }
                }
                Ok((out, programs))
            };
            match result() {
                Ok((card, programs)) => {
                    catalogue.programs.extend(programs);
                    catalogue.cards.insert(code.clone(), card);
                    catalogue.metadata.insert(code, entry["card"].clone());
                }
                Err(e) => {
                    catalogue.rejected.insert(
                        code,
                        format!(
                            "{}: {e}",
                            entry["internalName"].as_str().unwrap_or("unnamed card")
                        ),
                    );
                }
            }
        }
        Ok(catalogue)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn rejects_unknown_effects_instead_of_ignoring_them() {
        assert!(
            serde_json::from_value::<Effect>(json!({"kind":"capture","target":"chosen"})).is_err()
        );
    }
    #[test]
    fn rejects_unknown_fields_that_could_hide_additional_rules() {
        assert!(serde_json::from_value::<Effect>(json!({"kind":"damage","amount":{"kind":"const","value":1},"target":"chosen","lastingEffect":true})).is_err());
    }
    #[test]
    fn references_are_explicitly_bounded() {
        assert!(Expr::Ref {
            path: vec!["game".into(), "randomGenerator".into()]
        }
        .validate()
        .is_err());
        assert!(Expr::Ref {
            path: vec!["event".into(), "totalDistributed".into()]
        }
        .validate()
        .is_ok());
    }
    #[test]
    fn conditional_and_if_you_do_compile_real_continuations() {
        let a:Ability=serde_json::from_value(json!({"trigger":"action","title":"heal and pay","effect":{"kind":"heal","amount":{"kind":"const","value":2},"target":"self"},"ifYouDo":{"title":"pay","effect":{"kind":"damage","amount":{"kind":"ref","path":["event","totalDistributed"]},"target":"ownBase"}}})).unwrap();
        let p = Program::compile(&a).unwrap();
        assert!(matches!(
            p.instructions[1],
            Instruction::IfResult { skip: 3 }
        ));
    }
    fn compiled_group(value: Value) -> Result<Program, String> {
        let a: Ability=serde_json::from_value(value).map_err(|e|e.to_string())?;
        Program::compile(&a)
    }
    #[test]
    fn groups_preserve_nested_selection_and_phase_event_identity() {
        let primitive=json!({"kind":"damage","target":"chosen","amount":{"kind":"const","value":1}});
        let tree=json!({"kind":"simultaneous","effects":[{"kind":"damage","target":"self","amount":{"kind":"const","value":1}},{"kind":"select","targetResolver":{"type":"unit","owner":"opponent"},"effect":primitive}]});
        let p=compiled_group(json!({"trigger":"whenPlayed","title":"group","effect":tree})).unwrap();
        assert!(matches!(&p.instructions[0],Instruction::Group(Effect::Simultaneous {effects}) if matches!(effects[1],Effect::Select{..})));
        let phase=json!({"kind":"phaseModifiers","effects":[{"kind":"modifyStats","target":"chosen","duration":"phase","power":{"kind":"const","value":1},"hp":{"kind":"const","value":0}},{"kind":"gainKeyword","target":"chosen","duration":"phase","keyword":"sentinel","amount":{"kind":"const","value":1}}]});
        let p=compiled_group(json!({"trigger":"event","title":"phase","effect":phase})).unwrap();
        assert!(matches!(p.instructions[0],Instruction::Apply(Effect::PhaseModifiers{..})));
    }
    #[test]
    fn bounded_selectors_compile_to_group_even_for_one_selected_card() {
        for mode in [json!({"mode":"upTo","count":{"kind":"const","value":1},"optional":true,"type":"unit"}),json!({"mode":"unlimited","optional":true,"type":"base"})] {
            let p=compiled_group(json!({"trigger":"event","title":"multi","targetResolver":mode,"effect":{"kind":"heal","target":"chosen","amount":{"kind":"const","value":2}}})).unwrap();
            assert!(matches!(p.instructions[0],Instruction::Select(_)));assert!(matches!(p.instructions[1],Instruction::Group(_)));
        }
        for resolver in [json!({"mode":"upTo","count":{"kind":"const","value":4}}),json!({"mode":"upTo","count":{"kind":"ref","path":["player","readyResourceCount"]}}),json!({"mode":"unlimited","optional":true,"type":"unit"})] {
            assert!(compiled_group(json!({"trigger":"event","title":"bad","targetResolver":resolver,"effect":{"kind":"ready","target":"chosen"}})).is_err());
        }
    }
    #[test]
    fn unverified_group_shapes_and_array_captures_reject() {
        let damage=json!({"kind":"damage","target":"chosen","amount":{"kind":"const","value":1}});
        let shield=json!({"kind":"giveShield","target":"chosen","amount":{"kind":"const","value":1}});
        let draw=json!({"kind":"draw","target":"ownPlayer","amount":{"kind":"const","value":1}});
        for children in [vec![damage.clone(),shield],vec![damage.clone(),draw]] {
            assert!(compiled_group(json!({"trigger":"event","title":"bad","effect":{"kind":"simultaneous","effects":children}})).is_err());
        }
        assert!(compiled_group(json!({"trigger":"event","title":"array capture","targetResolver":{"mode":"upTo","count":{"kind":"const","value":2},"optional":true},"effect":{"kind":"damage","target":"chosen","amount":{"kind":"ref","path":["target","damage"]}}})).is_err());
        assert!(compiled_group(json!({"trigger":"event","title":"continuation","effect":{"kind":"simultaneous","effects":[damage]},"then":{"title":"later","effect":{"kind":"noAction"}}})).is_err());
    }
    #[test]
    fn phase_modifier_lists_validate_shared_target_and_duration() {
        for bad in [json!({"kind":"gainKeyword","target":"self","duration":"phase","keyword":"sentinel","amount":{"kind":"const","value":1}}),json!({"kind":"gainKeyword","target":"chosen","duration":"persistent","keyword":"sentinel","amount":{"kind":"const","value":1}})] {
            assert!(compiled_group(json!({"trigger":"event","title":"bad phase","effect":{"kind":"phaseModifiers","effects":[{"kind":"modifyStats","target":"chosen","duration":"phase","power":{"kind":"const","value":1},"hp":{"kind":"const","value":0}},bad]}})).is_err());
        }
    }
    #[test]
    fn token_contingents_count_toward_group_capacity() {
        let shields=vec![json!({"kind":"giveShield","target":"chosen","amount":{"kind":"const","value":2}});8];
        assert!(compiled_group(json!({"trigger":"event","title":"oversized","targetResolver":{"mode":"upTo","count":{"kind":"const","value":3},"optional":true},"effect":{"kind":"simultaneous","effects":shields}})).is_err());
    }

    #[test]
    fn expanded_named_targets_count_toward_physical_record_budget() {
        let eight=vec![json!({"kind":"damage","target":"bothBases","amount":{"kind":"const","value":1}});8];
        let four=vec![json!({"kind":"simultaneous","effects":eight});4];
        let err=compiled_group(json!({"trigger":"event","title":"too many","effect":{"kind":"simultaneous","effects":four}})).unwrap_err();
        assert!(err.contains("record budget"));
        let phase=vec![json!({"kind":"gainKeyword","target":"chosen","duration":"phase","keyword":"sentinel","amount":{"kind":"const","value":1}});8];
        assert!(compiled_group(json!({"trigger":"event","title":"too many phase leaves","targetResolver":{"mode":"upTo","count":{"kind":"const","value":3},"optional":true,"type":"unit"},"effect":{"kind":"simultaneous","effects":[{"kind":"phaseModifiers","effects":phase},{"kind":"phaseModifiers","effects":phase}]}})).unwrap_err().contains("record budget"));
    }
    #[test]
    fn groups_reject_player_targets_and_scalar_target_expressions_under_arrays() {
        for target in [json!("bothPlayers"),json!({"kind":"ref","path":["player"]}),json!({"kind":"ref","path":["target","controller"]})] {
            assert!(compiled_group(json!({"trigger":"event","title":"player target","effect":{"kind":"simultaneous","effects":[{"kind":"heal","target":target,"amount":{"kind":"const","value":1}}]}})).is_err());
        }
        for count in [1,2] { for target in [json!({"kind":"ref","path":["target"]}),json!({"kind":"conditional","condition":{"kind":"const","value":true},"then":{"kind":"ref","path":["target"]},"else":{"kind":"ref","path":["source"]}})] {
            assert!(compiled_group(json!({"trigger":"event","title":"array target","targetResolver":{"mode":"upTo","count":{"kind":"const","value":count},"optional":true,"type":"unit"},"effect":{"kind":"heal","target":target,"amount":{"kind":"const","value":1}}})).is_err());
        } }
    }
    #[test]
    fn damage_groups_require_disjoint_destinations_and_no_unverified_defeat_mix() {
        let damage=json!({"kind":"damage","target":"chosen","amount":{"kind":"const","value":1}});
        assert!(compiled_group(json!({"trigger":"event","title":"repeat","effect":{"kind":"simultaneous","effects":[damage,damage]}})).is_err());
        assert!(compiled_group(json!({"trigger":"event","title":"mixed","effect":{"kind":"simultaneous","effects":[{"kind":"damage","target":"self","amount":{"kind":"const","value":1}},{"kind":"defeat","target":"chosen"}]}})).is_err());
        assert!(compiled_group(json!({"trigger":"event","title":"distinct bases","effect":{"kind":"simultaneous","effects":[{"kind":"damage","target":"ownBase","amount":{"kind":"const","value":1}},{"kind":"damage","target":"enemyBase","amount":{"kind":"const","value":1}}]}})).is_ok());
        let p=compiled_group(json!({"trigger":"onAttack","title":"other unit","effect":{"kind":"simultaneous","effects":[{"kind":"damage","target":"self","amount":{"kind":"const","value":1}},{"kind":"select","targetResolver":{"type":"unit","predicate":{"kind":"binary","op":"!==","left":{"kind":"ref","path":["card"]},"right":{"kind":"ref","path":["source"]}}},"effect":{"kind":"damage","target":"chosen","amount":{"kind":"const","value":1}}}]}}));assert!(p.is_ok());
    }

    #[test]
    fn standalone_phase_lists_reject_noncard_destinations() {
        assert!(compiled_group(json!({"trigger":"event","title":"player phase","effect":{"kind":"phaseModifiers","effects":[{"kind":"gainKeyword","target":"ownPlayer","duration":"phase","keyword":"sentinel","amount":{"kind":"const","value":1}}]}})).is_err());
    }
    #[test]
    fn zero_record_trees_still_require_bounded_group_operations() {
        let leaf=json!({"kind":"conditional","condition":{"kind":"const","value":true},"onTrue":{"kind":"noAction"},"onFalse":{"kind":"noAction"}});
        let mut tree=leaf;for _ in 0..5 {tree=json!({"kind":"simultaneous","effects":vec![tree;8]});}
        let err=compiled_group(json!({"trigger":"event","title":"op overflow","effect":tree})).unwrap_err();assert!(err.contains("operation budget"));
    }
    #[test]
    fn sibling_target_capture_after_select_rejects_but_fresh_selections_remain_legal() {
        let select=json!({"kind":"select","targetResolver":{"type":"unit"},"effect":{"kind":"heal","target":"chosen","amount":{"kind":"const","value":1}}});
        for next in [json!({"kind":"ready","target":"chosen"}),json!({"kind":"heal","target":"ownBase","amount":{"kind":"ref","path":["target","damage"]}}),json!({"kind":"conditional","condition":{"kind":"query","name":"isUnit","receiver":{"kind":"ref","path":["target"]},"args":[]},"onTrue":{"kind":"noAction"}})] {
            assert!(compiled_group(json!({"trigger":"event","title":"shared target","effect":{"kind":"simultaneous","effects":[select,next]}})).is_err());
        }
        assert!(compiled_group(json!({"trigger":"event","title":"fresh target","effect":{"kind":"simultaneous","effects":[select,select]}})).is_ok());
    }

    #[test]
    fn exact_card_title_predicates_support_named_friendly_auras() {
        for (title,keyword) in [("Zuckuss","ambush"),("4-LOM","saboteur")] {
            assert!(compiled_group(json!({"trigger":"constant","title":"named aura","targetResolver":{"owner":"self","type":"unit","zone":"arena","predicate":{"kind":"binary","op":"===","left":{"kind":"ref","path":["card","title"]},"right":{"kind":"const","value":title}}},"effect":{"kind":"simultaneous","effects":[{"kind":"modifyStats","target":"chosen","duration":"persistent","power":{"kind":"const","value":1},"hp":{"kind":"const","value":1}},{"kind":"gainKeyword","target":"chosen","duration":"persistent","keyword":keyword,"amount":{"kind":"const","value":1}}]}})).is_ok());
        }
        assert!(Expr::Ref {path:vec!["card".into(),"title".into()]}.validate().is_ok());
        assert!(Expr::Ref {path:vec!["card".into(),"title".into()]}.validate_number().is_err());
        assert!(Expr::Ref {path:vec!["source".into(),"parentCard".into(),"title".into()]}.validate().is_err());
        assert!(compiled_group(json!({"trigger":"event","title":"text amount","effect":{"kind":"damage","target":"chosen","amount":{"kind":"ref","path":["card","title"]}}})).is_err());
    }

    #[test]
    fn array_group_values_reject_unbound_card_alias_but_keep_local_arena_predicates() {
        let resolver=json!({"mode":"upTo","count":{"kind":"const","value":2},"optional":true,"type":"unit"});
        for amount in [json!({"kind":"ref","path":["card","damage"]}),json!({"kind":"query","name":"getPower","receiver":{"kind":"ref","path":["card"]},"args":[]})] {
            assert!(compiled_group(json!({"trigger":"event","title":"first alias","targetResolver":resolver,"effect":{"kind":"heal","target":"chosen","amount":amount}})).is_err());
        }
        let count=json!({"kind":"query","name":"arenaUnitCount","receiver":{"kind":"ref","path":["player"]},"args":[{"kind":"binary","op":">","left":{"kind":"ref","path":["card","damage"]},"right":{"kind":"const","value":0}}]});
        assert!(compiled_group(json!({"trigger":"event","title":"local predicate","targetResolver":resolver,"effect":{"kind":"heal","target":"chosen","amount":count}})).is_ok());
    }

    #[test]
    fn changed_sibling_card_aliases_reject_without_rejecting_local_query_bindings() {
        let select=json!({"kind":"select","targetResolver":{"type":"unit"},"effect":{"kind":"heal","target":"chosen","amount":{"kind":"const","value":1}}});
        for amount in [json!({"kind":"ref","path":["card","damage"]}),json!({"kind":"query","name":"getPower","receiver":{"kind":"ref","path":["card"]},"args":[]})] {
            let err=compiled_group(json!({"trigger":"event","title":"changed alias","effect":{"kind":"simultaneous","effects":[select,{"kind":"heal","target":"ownBase","amount":amount}]}})).unwrap_err();assert!(err.contains("target-dependent sibling"));
        }
        let amount=json!({"kind":"query","name":"arenaUnitCount","receiver":{"kind":"ref","path":["player"]},"args":[{"kind":"binary","op":">","left":{"kind":"ref","path":["card","damage"]},"right":{"kind":"const","value":0}}]});
        assert!(compiled_group(json!({"trigger":"event","title":"local card binding","effect":{"kind":"simultaneous","effects":[select,{"kind":"heal","target":"ownBase","amount":amount}]}})).is_ok());
    }

}

pub const CORE_KEYWORDS: [&str; 9] = ["sentinel", "overwhelm", "saboteur", "ambush", "grit", "shielded", "raid", "restore", "hidden"];
fn validate_keyword(keyword: &str) -> Result<(), String> { if CORE_KEYWORDS.contains(&keyword) { Ok(()) } else { Err(format!("unsupported keyword {keyword}")) } }

#[cfg(test)]
mod arena_list_phase_tests {
    use super::*;
    use serde_json::json;
    fn ability()->serde_json::Value {json!({"trigger":"event","title":"Phase stats","effect":{"kind":"modifyStats","duration":"phase","target":{"kind":"arenaList","receiver":{"kind":"ref","path":["player"]},"predicate":{"kind":"const","value":true}},"power":{"kind":"const","value":1},"hp":{"kind":"const","value":1}}})}
    fn compile(v:serde_json::Value)->Result<Program,String>{Program::compile(&serde_json::from_value(v).unwrap())}
    #[test] fn accepts_only_witnessed_standalone_shape() {
        assert!(compile(ability()).is_ok());
        let mut v=ability();let mut predicate=json!({"kind":"const","value":true});
        for _ in 0..20 {predicate=json!({"kind":"unary","op":"!","value":predicate});}
        v["effect"]["target"]["predicate"]=predicate;assert!(compile(v).is_err(),"arena-list expressions retain the general depth bound");
        let mut v=ability();v["trigger"]=json!("whenPlayed");assert!(compile(v).is_ok(),"ordinary WhenPlayed list effects are now source-witnessed");
        let mut v=ability();v["then"]=json!({"title":"Continuation","effect":{"kind":"noAction"}});assert!(compile(v).is_err());
        let mut v=ability();v["targetResolver"]=json!({"type":"unit"});assert!(compile(v).is_err());
        let mut v=ability();v["effect"]["target"]["receiver"]=json!({"kind":"ref","path":["game"]});assert!(compile(v).is_err());
        let mut v=ability();v["effect"]["target"]["predicate"]=json!({"kind":"query","name":"hasSomeTrait","receiver":{"kind":"ref","path":["card"]},"args":[{"kind":"const","value":"creature"}]});assert!(compile(v).is_ok(),"one static card trait is now source-witnessed");
        let mut v=ability();v["effect"]["power"]=json!({"kind":"ref","path":["target","damage"]});assert!(compile(v).is_err());
        let mut v=ability();v["effect"]["kind"]=json!("damage");v["effect"].as_object_mut().unwrap().remove("duration");v["effect"].as_object_mut().unwrap().remove("power");v["effect"].as_object_mut().unwrap().remove("hp");v["effect"]["amount"]=json!({"kind":"const","value":1});assert!(compile(v).is_err());
        let mut v=ability();v["effect"]=json!({"kind":"sequence","effects":[v["effect"].clone()]});assert!(compile(v).is_err());
    }
}

#[cfg(test)]
mod arena_list_defeat_tests {
    use super::*;use serde_json::json;
    fn ability()->serde_json::Value {json!({"trigger":"event","title":"Defeat","effect":{"kind":"defeat","target":{"kind":"arenaList","receiver":{"kind":"ref","path":["game"]},"predicate":{"kind":"const","value":true}}}})}
    fn compile(v:serde_json::Value)->Result<Program,String>{Program::compile(&serde_json::from_value(v).unwrap())}
    #[test]fn defeat_list_rejects_unwitnessed_contexts_and_predicates(){
        assert!(compile(ability()).is_ok());
        let mut v=ability();v["trigger"]=json!("onAttack");assert!(compile(v).is_err());
        let mut v=ability();v["then"]=json!({"title":"Next","effect":{"kind":"noAction"}});assert!(compile(v).is_err());
        let mut v=ability();v["effect"]["target"]["predicate"]=json!({"kind":"query","name":"isUpgraded","receiver":{"kind":"ref","path":["card"]},"args":[]});assert!(compile(v.clone()).is_ok());v["effect"]["target"]["predicate"]["receiver"]=json!({"kind":"ref","path":["target"]});assert!(compile(v).is_err());
        let mut v=ability();let mut p=json!({"kind":"const","value":true});for _ in 0..20 {p=json!({"kind":"unary","op":"!","value":p});}v["effect"]["target"]["predicate"]=p;assert!(compile(v).is_err());
        let mut v=ability();v["effect"]=json!({"kind":"simultaneous","effects":[v["effect"].clone()]});assert!(compile(v).is_err());
        let mut v=ability();v["effect"]["target"]["receiver"]=json!({"kind":"ref","path":["source"]});assert!(compile(v).is_err());
    }
}

/// Numeric storage slots remain independent of keyword bit positions.
pub fn numeric_keyword_slot(index: usize) -> Option<usize> { match index { 6 => Some(0), 7 => Some(1), _ => None } }
