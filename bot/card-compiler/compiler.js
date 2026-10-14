'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ts = require(require.resolve('typescript', { paths: [path.resolve(__dirname, '../../forceteki')] }));
const SCHEMA = 'swu-card-ir/v1';
const VERSION = 1;
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const constant = (value) => ({ kind: 'const', value });
const reference = (...parts) => ({ kind: 'ref', path: parts });
const BASIC_EFFECTS = new Set(['damage', 'heal', 'draw', 'ready', 'exhaust', 'defeat', 'giveShield', 'giveExperience', 'returnToHand', 'discardSpecificCard', 'resourceCard', 'readyResources', 'noAction']);
const TRIGGERS = { addActionAbility: 'action', addWhenPlayedAbility: 'whenPlayed', addOnAttackAbility: 'onAttack', addWhenDefeatedAbility: 'whenDefeated', setEventAbility: 'event', setEpicActionAbility: 'epicAction', addOnDefenseAbility: 'onDefense', addWhenAttackEndsAbility: 'whenAttackEnds' };
const SIDE_METHODS = { setupCardAbilities: 'card', setupLeaderSideAbilities: 'leader', setupLeaderUnitSideAbilities: 'unit', setupLeaderBackSideAbilities: 'unit' };
const QUERY_NAMES = new Set(['isUnit', 'isBase', 'isLeader', 'isNonLeaderUnit', 'isUpgrade', 'isToken', 'isEvent', 'hasSomeTrait', 'hasEveryTrait', 'hasSomeAspect', 'hasEveryAspect', 'hasSomeKeyword', 'hasEveryKeyword', 'getPower', 'getHp', 'getCost', 'getPrintedCost', 'hasInitiative', 'getAllUnitsInPlay', 'getUnitsInPlay', 'getCardsInZone', 'getOtherUnitsInPlay', 'getNumericKeywordTotal', 'isInPlay', 'isDeployed', 'isUpgraded', 'canBeDamaged', 'canBeExhausted']);
const DISPLAY_FIELDS = new Set(['effect', 'effectArgs', 'activePromptTitle', 'waitingPromptTitle', 'contextTitle', 'effectMessage', 'ongoingEffectDescription']);

class Unsupported extends Error {
    constructor(ctx, node, pattern, message = pattern) {
        super(message);
        const location = ctx.source.getLineAndCharacterOfPosition(node.getStart(ctx.source));
        this.diagnostic = { code: 'UNSUPPORTED_SOURCE', pattern, message, file: ctx.file, line: location.line + 1, column: location.character + 1 };
    }
}
function fail(ctx, node, pattern, message) { throw new Unsupported(ctx, node, pattern, message); }
function unwrap(node) {
    if (!node) throw new Error('Missing AST node in card definition');
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
    return node;
}
function access(node, ctx) {
    node = unwrap(node);
    if (node.questionDotToken) fail(ctx, node, 'optional-reference');
    if (ts.isIdentifier(node)) return [node.text];
    if (node.kind === ts.SyntaxKind.ThisKeyword) return ['this'];
    if (ts.isPropertyAccessExpression(node)) return [...access(node.expression, ctx), node.name.text];
    if (ts.isElementAccessExpression(node)) {
        const parent = access(node.expression, ctx);
        const index = literal(node.argumentExpression, ctx);
        if (!['number', 'string'].includes(typeof index)) fail(ctx, node, 'dynamic-property-index');
        return [...parent, index];
    }
    fail(ctx, node, 'non-path-reference', node.getText(ctx.source));
}
function readConstant(name, ctx) {
    const node = ctx.constants.get(name);
    ctx.usedConstants?.add(node);
    return node;
}
function bindConstant(ctx, name, node) {
    ctx.constants.set(name, node);
    ctx.constantScopes?.set(node, new Map(ctx.scope));
    ctx.constantEnvs?.set(node, new Map(ctx.constants));
    ctx.constantStages?.set(node, ctx.callbackStage || null);
    ctx.bindings?.push({ name, node });
}
function literal(node, ctx) {
    node = unwrap(node);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isArrayLiteralExpression(node)) return node.elements.map((element) => literal(element, ctx));
    if (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken].includes(node.operator)) {
        const value = literal(node.operand, ctx);
        if (typeof value === 'number') return node.operator === ts.SyntaxKind.MinusToken ? -value : value;
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isPropertyAccessExpression(node)) {
        const name = node.getText(ctx.source);
        if (Object.hasOwn(ctx.enums, name)) return ctx.enums[name];
    }
    if (ts.isIdentifier(node) && ctx.constants?.has(node.text)) { const initializer=readConstant(node.text,ctx); return literal(initializer,constantContext(initializer,ctx)); }
    fail(ctx, node, 'nonconstant-value', node.getText(ctx.source));
}
function titleHelper(node, ctx) {
    node=unwrap(node);
    const text=node.getText(ctx.source);
    if(ts.isPropertyAccessExpression(node)&&text.startsWith('TextHelper.')) {
        const trait=/^TextHelper\.Trait\.([A-Za-z]+)$/.exec(text);
        if(trait) {
            const value=ctx.enums['Trait.'+trait[1]];
            if(typeof value!=='string')fail(ctx,node,'unsupported-title-helper');
            // Pinned Helpers.titleCase: capitalize each space-separated enum word.
            return value.split(' ').map(word=>word.charAt(0).toUpperCase()+word.slice(1)).join(' ');
        }
        const name=node.name.text;
        if(!/^TextHelper\.[A-Za-z]+$/.test(text)||!['Vigilance','Command','Aggression','Cunning','Villainy','Heroism','Keyword','Keywords','Ambush','Grit','Overwhelm','Saboteur','Sentinel','Shielded','Bounty','Smuggle','Coordinate','Piloting','Hidden','Plot','Support','Fortify'].includes(name))fail(ctx,node,'unsupported-title-helper');
        return name;
    }
    if(ts.isCallExpression(node)&&node.expression.getText(ctx.source).startsWith('TextHelper.')) {
        if(node.expression.getText(ctx.source)==='TextHelper.resource') {
            if(node.arguments.length!==1)fail(ctx,node,'unsupported-title-helper');
            const amount=literal(node.arguments[0],ctx);
            if(!Number.isSafeInteger(amount)||amount<0)fail(ctx,node,'title-helper-amount');
            // Env defaults NODE_ENV to test: preserve the real headless labels.
            return `${amount} resource${amount!==1?'s':''}`;
        }
        if(node.expression.getText(ctx.source)==='TextHelper.keyword') {
            if(node.arguments.length!==1)fail(ctx,node,'unsupported-title-helper');
            const input=unwrap(node.arguments[0]);
            let keyword, amount;
            if(ts.isObjectLiteralExpression(input)) {
                const obj=object(input,ctx);
                for(const key of obj.props.keys())if(!['keyword','amount'].includes(key))fail(ctx,input,'unsupported-title-helper');
                if(!obj.props.has('keyword'))fail(ctx,input,'unsupported-title-helper');
                keyword=literal(obj.props.get('keyword'),obj.ctx);
                if(obj.props.has('amount')) {
                    amount=literal(obj.props.get('amount'),obj.ctx);
                    if(!Number.isSafeInteger(amount)||amount<0)fail(ctx,input,'title-helper-amount');
                }
            } else keyword=literal(input,ctx);
            const keywords=Object.entries(ctx.enums).filter(([key])=>key.startsWith('KeywordName.')).map(([,value])=>value);
            if(typeof keyword!=='string'||!keywords.includes(keyword))fail(ctx,input,'unsupported-title-helper');
            return keyword.charAt(0).toUpperCase()+keyword.slice(1)+(amount===undefined?'':` ${amount}`);
        }
        if(node.expression.getText(ctx.source)==='TextHelper.aspectList') {
            if(node.arguments.length<1||node.arguments.length>2)fail(ctx,node,'unsupported-title-helper');
            const values=literal(node.arguments[0],ctx), conjunction=node.arguments.length===2?literal(node.arguments[1],ctx):null;
            if(!Array.isArray(values)||values.length>8||values.some(v=>!['vigilance','command','aggression','cunning','villainy','heroism'].includes(v))||![null,'and','or'].includes(conjunction))fail(ctx,node,'unsupported-title-helper');
            const labels=values.map(v=>v.charAt(0).toUpperCase()+v.slice(1));
            if(!conjunction)return labels.join(', ');
            return labels.map((v,i)=>labels.length>1&&i===labels.length-1?conjunction+' '+v:v).join(labels.length>2?', ':' ');
        }
        const numeric=/^TextHelper\.(Raid|Restore|Exploit)$/.exec(node.expression.getText(ctx.source));
        if(!numeric||node.arguments.length!==1)fail(ctx,node,'unsupported-title-helper');
        const amount=literal(node.arguments[0],ctx);
        if(!Number.isSafeInteger(amount)||amount<0)fail(ctx,node,'title-helper-amount');
        return numeric[1]+' '+amount;
    }
    return null;
}
// Titles are display text, never executable rules. Dynamic title fragments are
// rendered as placeholders; their expressions are deliberately never evaluated.
function displayText(node, ctx) {
    node = unwrap(node);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => {
        const helper=titleHelper(span.expression,ctx);
        return (helper ?? '[value]')+span.literal.text;
    }).join('');
    return 'Resolve ability';
}
// Unlike cosmetic effect text, contextTitle is part of the legal action protocol.
// Its expressions remain pure IR and are evaluated in the current ability context.
function contextTitle(input, context) {
    const {node,ctx}=lambda(input,context);
    const part=(n)=>{
        n=unwrap(n);
        if(ts.isPropertyAccessExpression(n)&&n.questionDotToken) {
            // Only nullable attached-card title access is supported here.
            const receiver=expr(n.expression,ctx);
            if(n.name.text!=='title'||receiver.kind!=='ref'||receiver.path.join('.')!=='source.parentUnit')fail(ctx,n,'unsupported-context-title-optional');
            return reference(...receiver.path,'title');
        }
        if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.QuestionQuestionToken)return {kind:'binary',op:'??',left:part(n.left),right:part(n.right)};
        const helper=titleHelper(n,ctx);
        if(helper!==null)return constant(helper);
        return expr(n,ctx);
    };
    const fragments=ts.isTemplateExpression(node)?[constant(node.head.text),...node.templateSpans.flatMap(span=>[part(span.expression),constant(span.literal.text)])]:[part(node)];
    let literalBytes=0; const count=(v)=>{if(!v||typeof v!=='object')return;if(v.kind==='const'&&typeof v.value==='string')literalBytes+=Buffer.byteLength(v.value);Object.values(v).forEach(count);};count(fragments);
    if(fragments.length>32||literalBytes>1024)fail(ctx,node,'context-title-bound');
    return fragments;
}
function lambda(node, ctx, names = ['context']) {
    node = unwrap(node);
    if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return { node, ctx };
    const scope = new Map(ctx.scope);
    const constants = new Map(ctx.constants);
    node.parameters.forEach((p, i) => {
        if (!ts.isIdentifier(p.name)) fail(ctx, p, 'destructured-callback-parameter');
        scope.set(p.name.text, reference(names[i] || `arg${i}`));
        constants.delete(p.name.text);
    });
    // A nested callback can bind a new candidate to the same IR root. An
    // outer candidate's active-attack guard must not guard that new candidate.
    const attackDefenders = new Set(ctx.attackDefenders || []);
    node.parameters.forEach((_,i)=>attackDefenders.delete(names[i] || `arg${i}`));
    const child = { ...ctx, scope, constants, attackDefenders, callbackStage: ctx.syncArenaPredicate ? ctx.callbackStage : node, syncArenaPredicate: false };
    if (!ts.isBlock(node.body)) return { node: unwrap(node.body), ctx: child };
    let returned = null;
    for (const statement of node.body.statements) {
        if (returned) fail(child, statement, 'statement-after-callback-return');
        if (ts.isVariableStatement(statement)) {
            if (!(statement.declarationList.flags & ts.NodeFlags.Const)) fail(child, statement, 'mutable-callback-local');
            for (const d of statement.declarationList.declarations) {
                if (!ts.isIdentifier(d.name) || !d.initializer) fail(child, d, 'complex-callback-binding');
                bindConstant(child, d.name.text, d.initializer);
            }
        } else if (ts.isReturnStatement(statement) && statement.expression && !returned) returned = statement.expression;
        else fail(child, statement, 'callback-statement:' + ts.SyntaxKind[statement.kind]);
    }
    if (!returned) fail(child, node, 'callback-without-return');
    return { node: unwrap(returned), ctx: child };
}
function normalizeRef(parts) {
    if (parts[0] === 'context') parts = parts.slice(1);
    if (parts[0] === 'player' && parts[1] === 'opponent') parts = ['opponent', ...parts.slice(2)];
    if (parts[0] === 'events' && parts[1] === 0) parts = ['event', ...parts.slice(2)];
    if (parts[0] === 'this') parts = ['source', ...parts.slice(1)];
    return parts;
}
// Readonly is about assignment, not evaluation time. An arena query initializer
// holds a snapshot; replacing it with a live query in a later callback is wrong.
function capturesArenaSnapshot(node, ctx, seen = new Set(), controllerOnly = false) {
    node = unwrap(node);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return false;
    if (controllerOnly && ts.isPropertyAccessExpression(node) && node.name.text === 'controller') return true;
    if (!controllerOnly && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['getArenaUnits','hasSomeArenaUnit','isTraitInPlay','isAspectInPlay','isKeywordInPlay'].includes(node.expression.name.text)) return true;
    if (ts.isIdentifier(node) && ctx.constants.has(node.text) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
        const initializer = ctx.constants.get(node.text);
        if (seen.has(initializer)) return false; // Normal alias resolution diagnoses cycles.
        const next = new Set(seen); next.add(initializer);
        return capturesArenaSnapshot(initializer, { ...ctx, constants: ctx.constantEnvs?.get(initializer) || ctx.constants }, next, controllerOnly);
    }
    let captured = false;
    ts.forEachChild(node, child => { if (capturesArenaSnapshot(child, ctx, seen, controllerOnly)) captured = true; });
    return captured;
}
function constantContext(node, ctx) {
    const trail = new Set(ctx.constantTrail || []);
    if (trail.has(node)) fail(ctx, node, 'cyclic-readonly-binding');
    trail.add(node);
    const lexicalConstants = ctx.constantEnvs?.get(node) || ctx.constants;
    if (capturesArenaSnapshot(node, { ...ctx, constants: lexicalConstants }) && (!ctx.callbackStage || ctx.constantStages?.get(node) !== ctx.callbackStage)) fail(ctx, node, 'arena-query-snapshot-capture');
    if (ctx.arenaReceiver && capturesArenaSnapshot(node, { ...ctx, constants: lexicalConstants }, new Set(), true) && (!ctx.callbackStage || ctx.constantStages?.get(node) !== ctx.callbackStage)) fail(ctx, node, 'arena-controller-snapshot-capture');
    return { ...ctx, scope: ctx.constantScopes?.get(node) || ctx.scope, constants: ctx.constantEnvs?.get(node) || ctx.constants, constantTrail: trail };
}
const isArenaList = (value) => ['arenaList', 'arenaFilter'].includes(value.kind);
function arenaCapture(node, ctx, bound = new Set(), seen = new Set()) {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        const local = new Set(bound);
        for (const parameter of node.parameters) if (ts.isIdentifier(parameter.name)) local.add(parameter.name.text);
        arenaCapture(node.body, ctx, local, seen);
        return;
    }
    if (ts.isIdentifier(node) && !bound.has(node.text) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
        if (ctx.scope.get(node.text)?.path?.[0] === 'card') fail(ctx, node, 'arena-query-card-capture');
        if (ctx.constants.has(node.text)) {
            const initializer = readConstant(node.text, ctx);
            if (seen.has(initializer)) fail(ctx, node, 'cyclic-readonly-binding');
            const next = new Set(seen); next.add(initializer);
            arenaCapture(initializer, { ...ctx, scope: ctx.constantScopes?.get(initializer) || ctx.scope, constants: ctx.constantEnvs?.get(initializer) || ctx.constants }, bound, next);
            return;
        }
    }
    ts.forEachChild(node, (child) => arenaCapture(child, ctx, bound, seen));
}
// List predicates use one candidate register. Nested list algebra, arbitrary
// collections and array-selected outer targets need additional typed registers.
function arenaPredicate(value, ctx, node, depth = 0) {
    if (depth > 24) fail(ctx, node, 'arena-predicate-bound');
    if (value.kind === 'ref') {
        const [root, ...parts] = value.path;
        const cardFields = ['power','hp','damage','remainingHp','cost','printedCost','exhausted','unique','zoneName','controller','title'];
        const validCard = ['card','source','target'].includes(root) && (parts.length === 0 || (parts.length === 1 && cardFields.includes(parts[0])));
        const validPlayer = ['player','opponent'].includes(root) && (parts.length === 0 || ['base.damage','hand.length','resources.length','readyResourceCount','exhaustedResourceCount'].includes(parts.join('.')));
        if (!validCard && !validPlayer) fail(ctx, node, 'arena-predicate-reference');
        return;
    }
    if (!['const','binary','unary','conditional','query','math','array'].includes(value.kind)) fail(ctx, node, 'arena-predicate-expression');
    if (value.kind === 'query' && !['isUnit','isBase','isLeader','isNonLeaderUnit','isUpgrade','isToken','isEvent','hasSomeTrait','hasEveryTrait','hasSomeAspect','hasEveryAspect','hasSomeKeyword','hasEveryKeyword','getPower','getHp','getCost','getPrintedCost','hasInitiative','getNumericKeywordTotal','isInPlay','isDeployed','isUpgraded','canBeDamaged','canBeExhausted','hasCost'].includes(value.name)) fail(ctx, node, 'arena-predicate-query');
    for (const child of Object.values(value)) {
        if (Array.isArray(child)) { for (const item of child) if (item && typeof item === 'object') arenaPredicate(item, ctx, node, depth + 1); }
        else if (child && typeof child === 'object') arenaPredicate(child, ctx, node, depth + 1);
    }
}
function arenaListNode(node, ctx, depth = 0) {
    node = unwrap(node);
    if (depth > 24) fail(ctx, node, 'arena-list-bound');
    if (ts.isIdentifier(node) && ctx.constants.has(node.text)) {
        const initializer = readConstant(node.text, ctx);
        return arenaListNode(initializer, constantContext(initializer, ctx), depth + 1);
    }
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
    const name = node.expression.name.text;
    if (name === 'getArenaUnits') {
        if (node.questionDotToken || node.expression.questionDotToken) fail(ctx, node, 'optional-arena-list');
        const query = arenaQuery(node, ctx, 'arenaList');
        arenaPredicate(query.args[0], ctx, node);
        return { kind: 'arenaList', receiver: query.receiver, predicate: query.args[0] };
    }
    if (name === 'filter') {
        const receiver = arenaListNode(node.expression.expression, ctx, depth + 1);
        if (!receiver) return null;
        if (node.questionDotToken || node.expression.questionDotToken) fail(ctx, node, 'optional-arena-list');
        if (node.arguments.length !== 1) fail(ctx, node, 'arena-filter-arity');
        const callback = unwrap(node.arguments[0]);
        if ((!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) || callback.parameters.length !== 1) fail(ctx, callback, 'arena-predicate-shape');
        arenaCapture(callback, ctx);
        const predicate = expr(callback, { ...ctx, allowArenaList: false, syncArenaPredicate: true }, ['card']);
        arenaPredicate(predicate, ctx, callback);
        return { kind: 'arenaFilter', receiver, predicate };
    }
    return null;
}
function arenaQuery(node, ctx, name, filterProps = null) {
    if (!ctx.callbackStage) fail(ctx, node, 'arena-query-evaluation-stage');
    if (!filterProps && node.arguments.length > 1) fail(ctx, node, 'arena-query-arity');
    let receiver = expr(node.expression.expression, { ...ctx, arenaReceiver: true });
    if (name === 'arenaList' && receiver.kind === 'ref') {
        if (receiver.path.join('.') === 'source.controller') receiver = reference('player');
        if (receiver.path.join('.') === 'source.controller.opponent') receiver = reference('opponent');
    }
    const playerReceiver = receiver.kind === 'ref' && ((receiver.path.length === 1 && ['player', 'opponent'].includes(receiver.path[0])) || (ctx.liveStats && receiver.path.join('.') === 'modifierTarget.controller'));
    const gameReceiver = name === 'arenaList' && receiver.kind === 'ref' && receiver.path.join('.') === 'game';
    if (!playerReceiver && !gameReceiver) fail(ctx, node, 'arena-query-receiver');
    const obj = filterProps ? { props: filterProps, ctx, node } : node.arguments.length ? object(node.arguments[0], ctx) : { props: new Map(), ctx, node };
    for (const value of obj.props.values()) arenaCapture(value, obj.ctx);
    // Player.getArenaUnits fixes controller and unit type; zone filter fields
    // intersect, while trait/aspect/keyword arrays each use OR semantics.
    for (const [key, value] of obj.props) if (!['arena', 'trait', 'aspect', 'keyword', 'otherThan', 'condition'].includes(key)) fail(obj.ctx, value, 'arena-query-filter:' + key);
    let predicate = constant(true);
    const intersect = (term) => { predicate = { kind: 'binary', op: '&&', left: predicate, right: term }; };
    if (obj.props.has('arena')) {
        const arena = expr(obj.props.get('arena'), obj.ctx);
        intersect({ kind: 'binary', op: '||', left: { kind: 'unary', op: '!', value: arena }, right: { kind: 'binary', op: '||', left: { kind: 'binary', op: '===', left: arena, right: constant('anyArena') }, right: { kind: 'binary', op: '===', left: reference('card', 'zoneName'), right: arena } } });
    }
    for (const [field, query] of [['trait', 'hasSomeTrait'], ['aspect', 'hasSomeAspect'], ['keyword', 'hasSomeKeyword']]) if (obj.props.has(field)) {
        const value = literal(obj.props.get(field), obj.ctx);
        if (typeof value !== 'string' && !(Array.isArray(value) && value.every((v) => typeof v === 'string'))) fail(ctx, obj.props.get(field), 'arena-query-nonconstant-filter');
        if (value !== '') intersect({ kind: 'query', name: query, receiver: reference('card'), args: [Array.isArray(value) ? { kind: 'array', items: value.map(constant) } : constant(value)] });
    }
    if (obj.props.has('otherThan')) {
        const excluded = expr(obj.props.get('otherThan'), obj.ctx);
        const containsCard = (value) => value && typeof value === 'object' && ((value.kind === 'ref' && value.path[0] === 'card') || Object.values(value).some(containsCard));
        if (containsCard(excluded)) fail(ctx, obj.props.get('otherThan'), 'arena-query-card-capture');
        intersect({ kind: 'binary', op: '||', left: { kind: 'unary', op: '!', value: excluded }, right: { kind: 'binary', op: '!==', left: reference('card'), right: excluded } });
    }
    if (obj.props.has('condition')) {
        if (name === 'arenaList') {
            const callback = unwrap(obj.props.get('condition'));
            if ((!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) || callback.parameters.length !== 1) fail(ctx, callback, 'arena-predicate-shape');
        }
        intersect(expr(obj.props.get('condition'), { ...obj.ctx, syncArenaPredicate: true }, ['card']));
    }
    return { kind: 'query', name, receiver, args: [predicate] };
}
function expr(input, context, params = ['context']) {
    let { node, ctx } = lambda(input, context, params);
    node = unwrap(node);
    if (ts.isIdentifier(node) && ctx.constants?.has(node.text)) { const initializer = readConstant(node.text, ctx); return expr(initializer, constantContext(initializer, ctx)); }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'length') {
        // Preserve the established direct Player count representation byte-for-byte.
        if (ts.isCallExpression(node.expression) && ts.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.name.text === 'getArenaUnits') {
            const receiver = expr(node.expression.expression.expression, { ...ctx, arenaReceiver: true });
            if (receiver.kind === 'ref' && ['player', 'opponent', 'modifierTarget.controller'].includes(receiver.path.join('.'))) return arenaQuery(node.expression, ctx, 'arenaUnitCount');
        }
        const receiver = arenaListNode(node.expression, ctx);
        if (receiver) return { kind: 'arenaLength', receiver };
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'some') {
        const receiver = arenaListNode(node.expression.expression, ctx);
        if (receiver) {
            if (node.questionDotToken || node.expression.questionDotToken) fail(ctx, node, 'optional-arena-list');
            if (node.arguments.length !== 1) fail(ctx, node, 'arena-some-arity');
            const callback = unwrap(node.arguments[0]);
            if ((!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) || callback.parameters.length !== 1) fail(ctx, callback, 'arena-predicate-shape');
            arenaCapture(callback, ctx);
            const predicate = expr(callback, { ...ctx, allowArenaList: false, syncArenaPredicate: true }, ['card']);
            arenaPredicate(predicate, ctx, callback);
            return { kind: 'arenaSome', receiver, predicate };
        }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['getArenaUnits', 'filter'].includes(node.expression.name.text)) {
        const list = arenaListNode(node, ctx);
        if (list) {
            if (!ctx.allowArenaList) fail(ctx, node, 'arena-list-scalar');
            return list;
        }
    }
    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) return constant(literal(node, ctx));
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || node.kind === ts.SyntaxKind.ThisKeyword) {
        const enumValue = ctx.enums[node.getText(ctx.source)];
        if (enumValue !== undefined) return constant(enumValue);
        let parts = access(node, ctx);
        let resolvedAlias = false;
        if (ctx.constants.has(parts[0])) {
            const initializer = readConstant(parts[0], ctx);
            const value = expr(initializer, constantContext(initializer, ctx));
            if (value.kind !== 'ref') fail(ctx, node, 'property-of-nonreference-local');
            parts = [...value.path, ...parts.slice(1)];
            resolvedAlias = true;
        }
        const binding = resolvedAlias ? null : ctx.scope.get(parts[0]);
        if (binding) {
            if (binding.kind !== 'ref') fail(ctx, node, 'property-of-nonreference-local');
            parts = [...binding.path, ...parts.slice(1)];
        } else if (!resolvedAlias && parts[0] !== 'this') fail(ctx, node, 'unbound-reference:' + parts[0]);
        parts = normalizeRef(parts);
        if (ctx.namedTargets && parts[0]==='targets') {
            const name=parts[1],slot=ctx.namedTargets.get(name);
            if (!slot) fail(ctx,node,'unknown-named-target:'+name);
            if (parts.length>2 && (slot.array || parts.length!==3 || !['power','hp','damage','remainingHp','cost','printedCost','exhausted','unique','zoneName','controller','title'].includes(parts[2]))) fail(ctx,node,'unsupported-named-target-property');
            parts=['namedTargets',...parts.slice(1)];
        } else if(ctx.namedTargets && parts[0]==='target') {
            const slot=ctx.namedTargets.get('target');
            if(!slot) fail(ctx,node,'unnamed-target-in-named-scope');
            if(parts.length>1 && (slot.array || parts.length!==2 || !['power','hp','damage','remainingHp','cost','printedCost','exhausted','unique','zoneName','controller','title'].includes(parts[1]))) fail(ctx,node,'unsupported-named-target-property');
            parts=['namedTargets','target',...parts.slice(1)];
        }
        if (parts.includes('activeAttack') && !(parts.join('.')==='card.activeAttack.attacker' && ctx.attackDefenders?.has('card'))) fail(ctx,node,'unsupported-attack-reference');
        if (ctx.liveStats && parts.length===3 && parts[0]==='card' && parts[1]==='zone' && parts[2]==='name') parts=['card','zoneName'];
        const roots = new Set(['source', 'player', 'opponent', 'target', 'targets', 'card', 'event', 'attack']);
        if (ctx.arenaReceiver) roots.add('game');
        if (ctx.attachPredicate) roots.add('attachTarget');
        if (ctx.liveStats) roots.add('modifierTarget');
        if (ctx.namedTargets) roots.add('namedTargets');
        if (!roots.has(parts[0])) fail(ctx, node, 'unimplemented-context-field:' + parts[0]);
        return reference(...parts);
    }
    if (ts.isArrayLiteralExpression(node)) return { kind: 'array', items: node.elements.map((e) => expr(e, { ...ctx, allowArenaList: false })) };
    if (ts.isPrefixUnaryExpression(node)) {
        const op = ts.tokenToString(node.operator);
        if (!['!', '-', '+', '~'].includes(op)) fail(ctx, node, 'unsupported-unary:' + op);
        return { kind: 'unary', op, value: expr(node.operand, { ...ctx, allowArenaList: false }) };
    }
    if (ts.isBinaryExpression(node)) {
        const op = node.operatorToken.getText(ctx.source);
        if (!['+', '-', '*', '/', '%', '===', '!==', '==', '!=', '<', '<=', '>', '>=', '&&', '||', '??', '&', '|'].includes(op)) fail(ctx, node, 'side-effecting-expression:' + op);
        ctx = { ...ctx, allowArenaList: false };
        const left = expr(node.left,ctx);
        let rightContext=ctx;
        if(op==='&&') {
            const attackDefenders=new Set(ctx.attackDefenders || []);
            const guards=v=> {
                if(v.kind==='query'&&v.name==='isDefending'&&v.receiver.kind==='ref'&&v.receiver.path.length===1) attackDefenders.add(v.receiver.path[0]);
                if(v.kind==='binary'&&v.op==='&&') {guards(v.left);guards(v.right);}
            };
            guards(left);rightContext={...ctx,attackDefenders};
        }
        return { kind:'binary',op,left,right:expr(node.right,rightContext) };
    }
    if (ts.isConditionalExpression(node)) return { kind: 'conditional', condition: expr(node.condition, { ...ctx, allowArenaList: false }), then: expr(node.whenTrue, { ...ctx, allowArenaList: false }), else: expr(node.whenFalse, { ...ctx, allowArenaList: false }) };
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const call = node.expression;
        const name = call.name.text;
        if (name === 'hasCost') {
            if(node.questionDotToken || call.questionDotToken)fail(ctx,node,'optional-cost-query');
            if(node.arguments.length)fail(ctx,node,'cost-query-arity');
            const receiver=expr(call.expression,ctx);
            const roots=['source','card','target'];
            if(ctx.attachPredicate)roots.push('attachTarget');
            if(receiver.kind!=='ref'||receiver.path.length!==1||!roots.includes(receiver.path[0]))fail(ctx,node,'cost-query-receiver');
            return {kind:'query',name,receiver,args:[]};
        }
        if (['isAttacking','isDefending'].includes(name)) {
            if(node.questionDotToken || call.questionDotToken) fail(ctx,node,'optional-attack-query');
            if(node.arguments.length) fail(ctx,node,'attack-query-arity');
            const receiver=expr(call.expression,ctx);
            if(receiver.kind!=='ref'||receiver.path.length!==1||!['source','card','target'].includes(receiver.path[0])) fail(ctx,node,'attack-query-receiver');
            return {kind:'query',name,receiver,args:[]};
        }
        if (name === 'hasSomeArenaUnit') return arenaQuery(node, ctx, name);
        if (ctx.liveStats && name === 'isTokenUnit') {
            if (node.arguments.length) fail(ctx,node,'live-stat-token-query-arity');
            return {kind:'query',name,receiver:expr(call.expression,ctx),args:[]};
        }
        if (['isTraitInPlay', 'isAspectInPlay', 'isKeywordInPlay'].includes(name)) {
            if (node.arguments.length < 1 || node.arguments.length > 2) fail(ctx, node, 'arena-query-alias-arity');
            const field = { isTraitInPlay: 'trait', isAspectInPlay: 'aspect', isKeywordInPlay: 'keyword' }[name];
            const filters = new Map([[field, node.arguments[0]]]);
            if (node.arguments.length === 2) filters.set('otherThan', node.arguments[1]);
            return arenaQuery(node, ctx, 'hasSomeArenaUnit', filters);
        }
        if (ctx.liveStats && call.expression.getText(ctx.source) === 'Math' && name === 'floor') {
            if (node.arguments.length !== 1) fail(ctx,node,'live-stat-resource-pairs-shape');
            const divided = unwrap(node.arguments[0]);
            if (!ts.isBinaryExpression(divided) || divided.operatorToken.kind !== ts.SyntaxKind.SlashToken || literal(divided.right,ctx) !== 2) fail(ctx,node,'live-stat-resource-pairs-shape');
            const count = expr(divided.left,ctx);
            if (count.kind !== 'ref' || !['modifierTarget.controller.resources.length','player.resources.length','opponent.resources.length'].includes(count.path.join('.'))) fail(ctx,node,'live-stat-resource-pairs-shape');
            return {kind:'query',name:'resourcePairs',receiver:reference(...count.path.slice(0,-2)),args:[]};
        }
        if (call.expression.getText(ctx.source) === 'Math' && ['min', 'max', 'floor', 'ceil', 'abs'].includes(name)) return { kind: 'math', name, args: node.arguments.map((a) => expr(a, ctx)) };
        if (QUERY_NAMES.has(name)) return { kind: 'query', name, receiver: expr(call.expression, ctx), args: node.arguments.map((a) => expr(a, ctx)) };
        if (['some', 'every', 'filter', 'map', 'find', 'includes', 'concat', 'slice'].includes(name)) {
            const receiver = expr(call.expression, ctx);
            if (isArenaList(receiver)) fail(ctx, node, 'unsupported-arena-collection:' + name);
            const args = node.arguments.map((a) => expr(a, ctx, ['card', 'index']));
            return { kind: 'collection', name, receiver, args, limit: 256 };
        }
        fail(ctx, node, 'unsupported-query:' + name);
    }
    fail(ctx, node, 'expression:' + ts.SyntaxKind[node.kind], node.getText(ctx.source));
}
function object(input, context) {
    let { node, ctx } = lambda(input, context);
    node = unwrap(node);
    if (ts.isIdentifier(node) && ctx.constants.has(node.text)) { const initializer=readConstant(node.text,ctx); return object(initializer,constantContext(initializer,ctx)); }
    if (!ts.isObjectLiteralExpression(node)) fail(ctx, node, 'expected-declarative-object');
    const props = new Map();
    for (const p of node.properties) {
        if (ts.isPropertyAssignment(p)) {
            const name = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
            if (name === null) fail(ctx, p, 'computed-object-key');
            if (props.has(name)) fail(ctx, p, 'duplicate-object-key:' + name);
            props.set(name, p.initializer);
        } else if (ts.isShorthandPropertyAssignment(p) && ctx.constants.has(p.name.text)) props.set(p.name.text, readConstant(p.name.text, ctx));
        else fail(ctx, p, 'object-property:' + ts.SyntaxKind[p.kind]);
    }
    return { props, ctx, node };
}
function knownProperties(obj, names) {
    for (const [key, node] of obj.props) if (!names.includes(key) && !DISPLAY_FIELDS.has(key)) fail(obj.ctx, node, 'unsupported-field:' + key);
}
function target(node, ctx, fallback = 'self') {
    if (!node) return fallback;
    const e = expr(node, { ...ctx, allowArenaList: true });
    const stringify = (v) => v.kind === 'ref' ? v.path.join('.') : null;
    const mappings = { source: 'self', target: 'chosen', 'player.base': 'ownBase', 'opponent.base': 'enemyBase', player: 'ownPlayer', opponent: 'enemyPlayer' };
    if (mappings[stringify(e)]) return mappings[stringify(e)];
    if (e.kind === 'array') {
        const paths = e.items.map(stringify);
        if (paths.length === 2 && paths.includes('player.base') && paths.includes('opponent.base')) return 'bothBases';
        if (paths.length === 2 && paths.includes('player') && paths.includes('opponent')) return 'bothPlayers';
    }
    return e;
}
// This grammar is mirrored by raw-IR admission. modifierTarget is the
// affected card, card is an arena-query candidate, and source/target keep their
// existing meanings. Live values cannot depend on effective stats or keywords.
function liveStatBounds(value, ctx, node, depth = 0) {
    if (depth > 24) fail(ctx,node,'live-stat-expression-bound');
    const rejected = () => fail(ctx,node,'unsupported-live-stat-expression');
    if (value.kind === 'const') {
        if (!Number.isSafeInteger(value.value) || Math.abs(value.value) > 1000) rejected();
        return [value.value,value.value];
    }
    if (value.kind === 'ref') {
        const p=value.path.join('.');
        if (p === 'modifierTarget.damage') return [0,65535];
        if (['modifierTarget.controller.resources.length','player.resources.length','opponent.resources.length','player.hand.length','opponent.hand.length'].includes(p)) return [0,64];
        rejected();
    }
    if (value.kind === 'unary' && value.op === '-') {
        const [lo,hi]=liveStatBounds(value.value,ctx,node,depth+1);return [-hi,-lo];
    }
    if (value.kind === 'binary' && ['+','-','*'].includes(value.op)) {
        const [a,b]=liveStatBounds(value.left,ctx,node,depth+1),[c,d]=liveStatBounds(value.right,ctx,node,depth+1);
        const values=value.op==='+'?[a+c,b+d]:value.op==='-'?[a-d,b-c]:[a*c,a*d,b*c,b*d];
        const bounds=[Math.min(...values),Math.max(...values)];
        if (bounds.some(n=>!Number.isSafeInteger(n)||Math.abs(n)>1000000)) fail(ctx,node,'live-stat-value-bound');
        return bounds;
    }
    if (value.kind === 'query' && ['arenaUnitCount','resourcePairs'].includes(value.name)) {
        const path=value.receiver.kind==='ref'?value.receiver.path.join('.'):'';
        if (!['player','opponent','modifierTarget.controller'].includes(path)) rejected();
        if (value.name==='resourcePairs') {if(value.args.length) rejected();return [0,32];}
        if (value.args.length!==1) rejected();
        const check=(v, exclusion=false, nesting=0)=> {
            if(!v||typeof v!=='object'||nesting>24) fail(ctx,node,'live-stat-expression-bound');
            if(v.kind==='const') {
                if (!['boolean','string','number'].includes(typeof v.value) || (typeof v.value==='number' && (!Number.isSafeInteger(v.value)||Math.abs(v.value)>1000))) rejected();
                return;
            }
            if(v.kind==='ref') {
                const path=v.path.join('.');
                if (['modifierTarget','source'].includes(path) && exclusion) return;
                if (['card','card.damage','card.exhausted','card.unique','card.zoneName','card.zone.name'].includes(path)) return;
                if(v.path.some(p=>['power','hp','remainingHp'].includes(p))) fail(ctx,node,'constant-stat-dependency');
                fail(ctx,node,'live-stat-arena-capture');
            }
            if(v.kind==='query') {
                if(['getPower','getHp','hasSomeKeyword','hasEveryKeyword','getNumericKeywordTotal'].includes(v.name)) fail(ctx,node,'constant-stat-dependency');
                if (!['isUnit','isTokenUnit','hasSomeTrait','hasSomeAspect'].includes(v.name) || v.receiver.kind!=='ref' || v.receiver.path.join('.')!=='card') rejected();
                const arity=['isUnit','isTokenUnit'].includes(v.name)?0:1;
                if(v.args.length!==arity || v.args.some(a=>a.kind!=='const'&&!(a.kind==='array'&&a.items.every(x=>x.kind==='const')))) rejected();
                if(arity && v.args.some(a=>a.kind==='const'?typeof a.value!=='string':a.items.some(x=>typeof x.value!=='string'))) rejected();
                return;
            }
            if(v.kind==='binary') {
                if(!['&&','||','===','!==','>','>=','<','<='].includes(v.op)) rejected();
                check(v.left,v.op==='!==',nesting+1);check(v.right,v.op==='!==',nesting+1);return;
            }
            if(v.kind==='unary'&&v.op==='!') {check(v.value,v.value.kind==='ref',nesting+1);return;}
            rejected();
        };
        check(value.args[0]);
        return [0,255];
    }
    rejected();
}
const MODIFIER_KEYWORDS = new Set(['sentinel','saboteur','overwhelm','grit','raid','restore','ambush','shielded','hidden']);
function modifierEffects(input, ctx, duration, targetValue) {
    let raw = unwrap(input);
    while (ts.isIdentifier(raw) && ctx.constants.has(raw.text)) raw = unwrap(readConstant(raw.text, ctx));
    const nodes = ts.isArrayLiteralExpression(raw) ? raw.elements : [raw];
    if (!nodes.length || nodes.length > 8) fail(ctx, raw, 'modifier-list-bound');
    const effects = nodes.flatMap((input) => {
        const call = unwrap(input);
        if (!ts.isCallExpression(call)) fail(ctx, call, 'modifier-is-not-helper');
        const parts = access(call.expression, ctx), kind = parts[2];
        if (parts.length !== 3 || !['AbilityHelper','abilityHelper','StaticAbilityHelper'].includes(parts[0]) || parts[1] !== 'ongoingEffects' || !['modifyStats','gainKeyword','loseKeyword'].includes(kind)) fail(ctx, call, 'unsupported-modifier:' + parts.join('.'));
        if (call.arguments.length !== 1) fail(ctx, call, 'modifier-arity');
        let value = unwrap(call.arguments[0]);
        while (ts.isIdentifier(value) && ctx.constants.has(value.text)) value = unwrap(readConstant(value.text, ctx));
        const dynamic = ts.isArrowFunction(value) || ts.isFunctionExpression(value);
        if (kind === 'modifyStats') {
            if (dynamic && duration === 'phase') fail(ctx,value,'dynamic-ongoing-stat-modifier');
            const lowered = dynamic ? lambda(value,{...ctx,liveStats:true},['modifierTarget','context']) : {node:value,ctx};
            const obj = object(lowered.node,lowered.ctx);
            // Every modifier field is semantic; descriptive-property exemptions
            // used by ordinary ability objects do not apply to live stat objects.
            for (const [key,v] of obj.props) if (!['power','hp'].includes(key)) fail(obj.ctx,v,'unsupported-stat-modifier-field:'+key);
            const out={kind,target:targetValue,duration};
            for (const stat of ['power','hp']) {
                if (!obj.props.has(stat)) fail(ctx,value,'incomplete-stat-modifier');
                let v=unwrap(obj.props.get(stat));
                while(ts.isIdentifier(v)&&obj.ctx.constants.has(v.text))v=unwrap(readConstant(v.text,obj.ctx));
                if(ts.isArrowFunction(v)||ts.isFunctionExpression(v))fail(ctx,v,'function-valued-stat-modifier');
                if(dynamic) {out[stat]=expr(v,obj.ctx);liveStatBounds(out[stat],obj.ctx,v);}
                else if(duration === 'persistent') { const n=literal(v,obj.ctx); if(!Number.isSafeInteger(n))fail(ctx,v,'noninteger-stat-modifier'); out[stat]=constant(n); }
                else out[stat]=expr(v,obj.ctx);
            }
            return [out];
        }
        if (kind === 'loseKeyword') {
            const names=literal(value,ctx), list=Array.isArray(names)?names:[names];
            if(!list.length||list.length>8||list.some(k=>!MODIFIER_KEYWORDS.has(k)))fail(ctx,value,'unsupported-modifier-keyword');
            return list.map(keyword=>({kind,target:targetValue,duration,keyword}));
        }
        if(dynamic&&duration==='phase')fail(ctx,value,'dynamic-ongoing-keyword-modifier');
        const lowered=dynamic?lambda(value,ctx,['card','context']):{node:value,ctx};
        let keyword,amount=constant(1);
        if(ts.isObjectLiteralExpression(lowered.node)) {
            const obj=object(lowered.node,lowered.ctx);knownProperties(obj,['keyword','amount']);
            if(!obj.props.has('keyword'))fail(ctx,value,'missing-modifier-keyword');
            keyword=literal(obj.props.get('keyword'),obj.ctx);
            if(obj.props.has('amount'))amount=expr(obj.props.get('amount'),obj.ctx);
            if(['raid','restore'].includes(keyword)!==obj.props.has('amount'))fail(ctx,value,'invalid-keyword-amount');
        } else {keyword=literal(lowered.node,lowered.ctx);if(['raid','restore'].includes(keyword))fail(ctx,value,'missing-numeric-keyword-amount');}
        if(!MODIFIER_KEYWORDS.has(keyword))fail(ctx,value,'unsupported-modifier-keyword');
        return [{kind,target:targetValue,duration,keyword,amount}];
    });
    if(effects.length>8)fail(ctx,raw,'modifier-list-bound');
    if(duration==='phase'&&ts.isArrayLiteralExpression(raw))return {kind:'phaseModifiers',effects};
    return effects.length===1?effects[0]:{kind:'simultaneous',effects};
}
function effect(input, context, defaultTarget = 'self') {
    let { node, ctx } = lambda(input, context);
    node = unwrap(node);
    if (ts.isIdentifier(node) && ctx.constants.has(node.text)) return effect(readConstant(node.text, ctx), ctx, defaultTarget);
    if (!ts.isCallExpression(node)) fail(ctx, node, 'effect-is-not-helper-call');
    const parts = access(node.expression, ctx);
    if (parts.length !== 3 || !['AbilityHelper', 'abilityHelper', 'StaticAbilityHelper'].includes(parts[0]) || parts[1] !== 'immediateEffects') fail(ctx, node, 'unsupported-effect-call:' + parts.join('.'));
    const kind = parts[2];
    if (node.arguments.length > 1) fail(ctx, node, 'effect-helper-arity');
    if (['simultaneous', 'sequential'].includes(kind)) {
        if (node.arguments.length !== 1 || !ts.isArrayLiteralExpression(unwrap(node.arguments[0]))) fail(ctx, node, 'invalid-effect-sequence');
        return { kind: kind === 'sequential' ? 'sequence' : 'simultaneous', effects: unwrap(node.arguments[0]).elements.map((e) => effect(e, ctx, defaultTarget)) };
    }
    const obj = node.arguments[0] ? object(node.arguments[0], ctx) : { props: new Map(), ctx, node };
    if (kind === 'discardCardsFromOwnHand') {
        // The wrapper changes who chooses, not who is targeted. Its inherited
        // PlayerTargetSystem default is the opponent, despite the helper name.
        for (const [key, value] of obj.props) if (!['amount', 'target', 'cardTypeFilter'].includes(key)) fail(obj.ctx, value, 'unsupported-hand-discard-field:' + key);
        if (obj.props.has('cardTypeFilter') && literal(obj.props.get('cardTypeFilter'), obj.ctx) !== 'any') fail(obj.ctx, obj.props.get('cardTypeFilter'), 'hand-discard-type-filter');
        const amount = obj.props.has('amount') ? literal(obj.props.get('amount'), obj.ctx) : 1;
        if (!Number.isSafeInteger(amount) || amount < 1 || amount > 2) fail(obj.ctx, obj.props.get('amount') || node, 'hand-discard-amount-bound');
        const playerTarget = target(obj.props.get('target'), obj.ctx, 'enemyPlayer');
        if (!['ownPlayer', 'enemyPlayer'].includes(playerTarget)) fail(obj.ctx, obj.props.get('target') || node, 'hand-discard-player-target');
        return { kind:'discardOwnHand', amount:constant(amount), target:playerTarget };
    }
    if (kind === 'discardFromDeck') {
        for (const [key, value] of obj.props) if (!['amount', 'target'].includes(key)) fail(obj.ctx, value, 'unsupported-deck-discard-field:' + key);
        // DiscardFromDeckSystem supplies no amount default; the inherited
        // PlayerTargetSystem default targets the opponent.
        if (!obj.props.has('amount')) fail(ctx, node, 'deck-discard-missing-amount');
        const amount = literal(obj.props.get('amount'), obj.ctx);
        if (!Number.isSafeInteger(amount) || amount < 0 || amount > 5) fail(obj.ctx, obj.props.get('amount'), 'deck-discard-amount-bound');
        const playerTarget = target(obj.props.get('target'), obj.ctx, 'enemyPlayer');
        if (!['ownPlayer', 'enemyPlayer'].includes(playerTarget)) fail(obj.ctx, obj.props.get('target') || node, 'deck-discard-player-target');
        return { kind:'discardDeck', amount:constant(amount), target:playerTarget };
    }
    const tokenTypes = { createBattleDroid:'battleDroid', createCloneTrooper:'cloneTrooper', createXWing:'xwing', createTieFighter:'tieFighter', createSpy:'spy', createBeast:'beast', createMandalorian:'mandalorian' };
    if (Object.hasOwn(tokenTypes, kind)) {
        // Token factory wrappers append their fixed type; caller-supplied type,
        // entry effects and event captures require their own execution contract.
        for (const [key, value] of obj.props) if (!['amount', 'target', 'entersReady'].includes(key)) fail(obj.ctx, value, 'unsupported-token-field:' + key);
        const amount = obj.props.has('amount') ? literal(obj.props.get('amount'), obj.ctx) : 1;
        if (!Number.isSafeInteger(amount) || amount < 1 || amount > 5) fail(obj.ctx, obj.props.get('amount') || node, 'token-amount-bound');
        const entersReady = obj.props.has('entersReady') ? literal(obj.props.get('entersReady'), obj.ctx) : false;
        if (typeof entersReady !== 'boolean') fail(obj.ctx, obj.props.get('entersReady') || node, 'token-readiness-boolean');
        const tokenTarget = target(obj.props.get('target'), obj.ctx, 'ownPlayer');
        if (!['ownPlayer', 'enemyPlayer'].includes(tokenTarget)) fail(obj.ctx, obj.props.get('target') || node, 'token-player-target');
        return { kind:'createTokenUnit', tokenType:tokenTypes[kind], amount:constant(amount), target:tokenTarget, entersReady };
    }
    if (kind === 'forThisPhaseCardEffect') {
        // Lasting stat modifiers have their values captured when the immediate
        // system resolves. A function passed to modifyStats itself is different:
        // the engine keeps reevaluating it as board state changes.
        const allowed = ['target', 'effect', 'title', 'ongoingEffectTargetDescription'];
        for (const [key, value] of obj.props) if (!allowed.includes(key) && !DISPLAY_FIELDS.has(key)) fail(obj.ctx, value, 'unsupported-field:' + key);
        if (!obj.props.has('effect')) fail(ctx, node, 'phase-effect-without-modifier');
        return modifierEffects(obj.props.get('effect'), obj.ctx, 'phase', target(obj.props.get('target'), obj.ctx, defaultTarget));
    }
    if (kind === 'conditional') {
        knownProperties(obj, ['condition', 'onTrue', 'onFalse']);
        if (!obj.props.has('condition')) fail(ctx, node, 'conditional-without-condition');
        return { kind, condition: expr(obj.props.get('condition'), obj.ctx), onTrue: obj.props.has('onTrue') ? effect(obj.props.get('onTrue'), obj.ctx, defaultTarget) : { kind: 'noAction' }, onFalse: obj.props.has('onFalse') ? effect(obj.props.get('onFalse'), obj.ctx, defaultTarget) : { kind: 'noAction' } };
    }
    if (kind === 'distributeHealingAmong' || kind === 'distributeDamageAmong') {
        knownProperties(obj, ['amountToDistribute', 'controller', 'cardTypeFilter', 'zoneFilter', 'maxTargets', 'canChooseNoTargets', 'canDistributeLess', 'cardCondition']);
        const spec = targetResolverProperties(obj);
        return { kind: kind === 'distributeHealingAmong' ? 'distributeHealing' : 'distributeDamage', amount: expr(obj.props.get('amountToDistribute'), obj.ctx), ...(obj.props.has('maxTargets') ? { maxTargets: literal(obj.props.get('maxTargets'), obj.ctx) } : {}), canChooseNoTargets: obj.props.has('canChooseNoTargets') ? literal(obj.props.get('canChooseNoTargets'), obj.ctx) : false, canDistributeLess: obj.props.has('canDistributeLess') ? literal(obj.props.get('canDistributeLess'), obj.ctx) : kind === 'distributeHealingAmong', targetResolver: spec };
    }
    if (kind === 'selectCard') {
        knownProperties(obj, ['cardTypeFilter', 'controller', 'zoneFilter', 'cardCondition', 'optional', 'mode', 'numCards', 'canChooseNoCards', 'immediateEffect', 'choosingPlayer']);
        const spec = targetResolverProperties(obj);
        if (obj.props.has('activePromptTitle')) {
            const node = unwrap(obj.props.get('activePromptTitle'));
            if (!(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) && node.templateSpans.every(span => titleHelper(span.expression, obj.ctx) !== null))) fail(obj.ctx, node, 'inline-prompt-title');
            const title = displayText(node, obj.ctx);
            if (!title.length || title.length > 1024) fail(obj.ctx, node, 'inline-prompt-title');
            spec.promptTitle = title;
        }
        return { kind: 'select', targetResolver: spec, effect: effect(obj.props.get('immediateEffect'), obj.ctx, 'chosen') };
    }
    if (kind === 'useTheForce' || kind === 'theForceIsWithYou') {
        if (defaultTarget !== 'self') fail(ctx, node, 'force-inherited-target');
        knownProperties(obj, []);
        return { kind: kind === 'useTheForce' ? 'useForce' : 'gainForce', target: 'ownPlayer' };
    }
    if (kind === 'resourceCard') {
        knownProperties(obj, ['target']);
        return { kind, target: target(obj.props.get('target'), obj.ctx, defaultTarget) };
    }
    if (kind === 'giveWeakness') {
        knownProperties(obj, ['amount', 'target']);
        return { kind, target: target(obj.props.get('target'), obj.ctx, defaultTarget), amount: obj.props.has('amount') ? expr(obj.props.get('amount'), obj.ctx) : constant(1) };
    }
    if (!BASIC_EFFECTS.has(kind)) fail(ctx, node, 'immediateEffect:' + kind);
    knownProperties(obj, ['amount', 'target', 'isCost', 'type', 'damageType', 'isIndirect', 'cannotBePrevented']);
    if (obj.props.has('isCost') && literal(obj.props.get('isCost'), obj.ctx)) fail(ctx, node, 'effect-is-cost');
    if (obj.props.has('type') && literal(obj.props.get('type'), obj.ctx) !== 'ability') fail(ctx, node, 'non-ability-damage');
    if (obj.props.has('damageType') || obj.props.has('isIndirect') || obj.props.has('cannotBePrevented')) fail(ctx, node, 'modified-damage-semantics');
    const result = { kind, target: target(obj.props.get('target'), obj.ctx, kind === 'draw' || kind === 'readyResources' ? 'ownPlayer' : defaultTarget) };
    if (obj.props.has('amount')) result.amount = expr(obj.props.get('amount'), obj.ctx);
    else if (['draw', 'giveShield', 'giveExperience', 'readyResources'].includes(kind)) result.amount = constant(1);
    else if (['damage', 'heal'].includes(kind)) fail(ctx, node, 'missing-effect-amount:' + kind);
    return result;
}
function targetResolverProperties(obj) {
    const { props, ctx, node } = obj;
    const rawType = props.has('cardTypeFilter') ? literal(props.get('cardTypeFilter'), ctx) : 'any';
    const typeNames = { unit: 'unit', 'nonLeaderUnit': 'nonLeaderUnit', 'non-leader unit': 'nonLeaderUnit', basicUnit: 'basicUnit', base: 'base', any: 'any', upgrade: 'upgrade', event: 'event', leaderUnit: 'leaderUnit', tokenUnit: 'tokenUnit', token: 'token', basicUpgrade: 'basicUpgrade', tokenUpgrade: 'tokenUpgrade', nonTokenUnit: 'nonTokenUnit', nonUnit: 'nonUnit' };
    let type = Array.isArray(rawType) ? null : typeNames[rawType];
    // Engine arrays are unions. Only this exact union can use the runtime's
    // attackable inventory; discard/hand inventories may contain other types.
    if (Array.isArray(rawType) && rawType.length === 2 && rawType.includes('unit') && rawType.includes('base')) {
        const zone = props.has('zoneFilter') ? literal(props.get('zoneFilter'), ctx) : 'anyAttackable';
        if (['anyAttackable', 'anyArena', 'groundArena', 'spaceArena', 'base'].includes(zone)) type = 'any';
    }
    if (!type) fail(ctx, props.get('cardTypeFilter') || node, 'cardTypeFilter:' + rawType);
    const ownerRaw = props.has('controller') ? literal(props.get('controller'), ctx) : 'any';
    const owner = { self: 'self', opponent: 'opponent', any: 'any' }[ownerRaw];
    if (!owner) fail(ctx, props.get('controller') || node, 'target-controller:' + ownerRaw);
    const zoneRaw = props.has('zoneFilter') ? literal(props.get('zoneFilter'), ctx) : 'anyAttackable';
    const zones = { anyAttackable: 'anyAttackable', anyArena: 'arena', groundArena: 'arena', spaceArena: 'arena', base: 'base', hand: 'hand', discard: 'discard', resource: 'resource', deck: 'deck', any: 'any' };
    if (!zones[zoneRaw]) fail(ctx, props.get('zoneFilter') || node, 'target-zone:' + zoneRaw);
    const result = { owner, type, zone: zones[zoneRaw] };
    if (zoneRaw === 'groundArena' || zoneRaw === 'spaceArena') result.arena = zoneRaw === 'groundArena' ? 'ground' : 'space';
    if (props.has('optional')) result.optional = literal(props.get('optional'), ctx);
    if (props.has('cardCondition')) {
        const capturedTarget=(n,bound=new Set(),seen=new Set())=>{
            if(ts.isArrowFunction(n)||ts.isFunctionExpression(n)) {const local=new Set(bound);for(const p of n.parameters)if(ts.isIdentifier(p.name))local.add(p.name.text);return capturedTarget(n.body,local,seen);}
            if(ts.isPropertyAccessExpression(n)||ts.isElementAccessExpression(n)) {
                let root=n;while(ts.isPropertyAccessExpression(root)||ts.isElementAccessExpression(root))root=root.expression;
                if(ts.isIdentifier(root)&&!bound.has(root.text)&&ctx.scope.has(root.text)) {
                    const binding=ctx.scope.get(root.text);
                    if(binding.kind==='ref') {const parts=normalizeRef([...binding.path,...access(n,ctx).slice(1)]);if(['target','targets'].includes(parts[0]) && !ctx.namedTargets)fail(ctx,n,'target-resolver-outer-target-capture');}
                }
            }
            if(ts.isIdentifier(n)&&!bound.has(n.text)&&ctx.constants.has(n.text)&&!(ts.isPropertyAccessExpression(n.parent)&&n.parent.name===n)) {
                if(seen.has(n.text))fail(ctx,n,'cyclic-target-resolver-binding');const next=new Set(seen);next.add(n.text);capturedTarget(readConstant(n.text,ctx),bound,next);
            }
            ts.forEachChild(n,child=>capturedTarget(child,bound,seen));
        };
        capturedTarget(props.get('cardCondition'));
        result.predicate = expr(props.get('cardCondition'), ctx, ['card', 'context']);
    }
    if (props.has('mode')) result.mode = literal(props.get('mode'), ctx);
    // A selected player needs a typed player target register. Falling back to
    // ownPlayer loses the user's choice (e.g. a ready-resources continuation).
    if (result.mode === 'player') fail(ctx, props.get('mode'), 'unsupported-player-target-resolver');
    if (props.has('numCards')) result.count = expr(props.get('numCards'), ctx);
    if (props.has('canChooseNoCards')) result.optional = !!result.optional || literal(props.get('canChooseNoCards'), ctx);
    else if (['upTo','upToVariable'].includes(result.mode)) result.optional = true;
    if (props.has('choosingPlayer') && literal(props.get('choosingPlayer'), ctx) !== 'self') fail(ctx, node, 'opponent-choice-resolver');
    return result;
}
function costs(input, ctx) {
    if (!input) return [];
    const nodes = ts.isArrayLiteralExpression(unwrap(input)) ? unwrap(input).elements : [input];
    return nodes.map((n) => {
        n = unwrap(n);
        if (!ts.isCallExpression(n)) fail(ctx, n, 'cost-is-not-helper');
        const parts = access(n.expression, ctx);
        if (parts[1] !== 'costs') fail(ctx, n, 'invalid-cost-helper');
        const kind = parts.at(-1);
        if (kind === 'exhaustSelf' && !n.arguments.length) return { kind };
        if (kind === 'abilityActivationResourceCost' && n.arguments.length === 1) return { kind: 'resources', amount: expr(n.arguments[0], ctx) };
        fail(ctx, n, 'cost:' + kind);
    });
}
function constantAbility(input, context, validatedObject = null) {
    const obj = validatedObject || object(input, context);
    knownProperties(obj, ['title', 'condition', 'ongoingEffect', 'matchTarget', 'targetController', 'targetCardTypeFilter', 'targetZoneFilter']);
    const { props, ctx, node } = obj;
    if (!props.has('ongoingEffect')) fail(ctx, node, 'constant-without-effect');
    const result = { trigger:'constant', title:props.has('title')?displayText(props.get('title'),ctx):'', costs:[], effect:modifierEffects(props.get('ongoingEffect'),ctx,'persistent','self') };
    if (props.has('condition')) result.condition = expr(props.get('condition'), ctx);
    // OngoingCardEffect defaults to source-only when no targeting filters exist.
    // Any targeting field switches to friendly arena units, including matchTarget.
    if (['matchTarget', 'targetController', 'targetCardTypeFilter', 'targetZoneFilter'].some((key) => props.has(key))) {
        const resolverProps = new Map();
        resolverProps.set('controller', props.get('targetController') || ts.factory.createStringLiteral('self'));
        resolverProps.set('cardTypeFilter', props.get('targetCardTypeFilter') || ts.factory.createStringLiteral('unit'));
        resolverProps.set('zoneFilter', props.get('targetZoneFilter') || ts.factory.createStringLiteral('anyArena'));
        if (props.has('matchTarget')) resolverProps.set('cardCondition', props.get('matchTarget'));
        result.targetResolver = targetResolverProperties({ props: resolverProps, ctx, node });
        if (result.targetResolver.zone !== 'arena') fail(ctx, node, 'constant-target-zone');
        const assignTarget = (e) => { if(e.effects)e.effects.forEach(assignTarget);else e.target='chosen'; }; assignTarget(result.effect);
    }
    const keywordModifier = (e) => e.effects ? e.effects.some(keywordModifier) : ['gainKeyword','loseKeyword'].includes(e.kind);
    const modifiesKeywords = keywordModifier(result.effect);
    const check = (value) => {
        if (!value || typeof value !== 'object') return;
        if ((value.kind === 'query' && (['getPower','getHp'].includes(value.name) || (modifiesKeywords && ['hasSomeKeyword','hasEveryKeyword','getNumericKeywordTotal'].includes(value.name)))) || (value.kind === 'ref' && value.path.some((p) => ['power', 'hp', 'remainingHp'].includes(p)))) fail(ctx, node, 'constant-stat-dependency');
        Object.values(value).forEach(check);
    };
    check(result.condition); check(result.targetResolver); check(result.effect);
    return result;
}
function attachedKeywordAbility(input, context) {
    const obj = object(input, context);
    // Unlike general ability objects, every extra field here changes keyword
    // semantics (notably Bounty's nested ability) and must be rejected.
    for (const [key, value] of obj.props) if (!['keyword', 'amount', 'gainCondition'].includes(key)) fail(obj.ctx, value, 'unsupported-attached-keyword-field:' + key);
    if (!obj.props.has('keyword')) fail(obj.ctx, obj.node, 'missing-modifier-keyword');
    const keywordProps = ts.factory.createObjectLiteralExpression([...obj.props].filter(([key]) => key !== 'gainCondition').map(([key, value]) => ts.factory.createPropertyAssignment(key, value)));
    const helper = ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier('AbilityHelper'), 'ongoingEffects'), 'gainKeyword'), undefined, [keywordProps]);
    // Synthetic helper nodes retain the real source span for fail-closed diagnostics.
    ts.setTextRange(keywordProps, obj.node);
    ts.setTextRange(helper, obj.node);
    const props = new Map([['ongoingEffect', helper]]);
    if (obj.props.has('gainCondition')) props.set('condition', obj.props.get('gainCondition'));
    const result = constantAbility(input, obj.ctx, { ...obj, props });
    result.effect.target = 'parent';
    const keyword = result.effect.keyword;
    const amount = result.effect.amount;
    if (amount.kind !== 'const' || !Number.isSafeInteger(amount.value) || amount.value < 0 || amount.value > 5) fail(obj.ctx, obj.node, 'attached-keyword-amount-bound');
    result.title = `Give ${keyword[0].toUpperCase() + keyword.slice(1)}${['raid', 'restore'].includes(keyword) ? ' ' + amount.value : ''} to the attached unit`;
    return result;
}
function attachPredicate(input, ctx) {
    const value = expr(input, { ...ctx, attachPredicate:true });
    const visit = (v) => {
        if (!v || typeof v !== 'object') return;
        if (v.kind === 'ref' && v.path[0] === 'attachTarget') v.path = ['card', ...v.path.slice(1)];
        Object.values(v).forEach(visit);
    };
    visit(value);
    return value;
}
function namedResolvers(input, context) {
    if(context.namedTargets?.size) fail(context,input,'nested-named-resolver-scope');
    const obj=object(input,context);
    if(!obj.props.size||obj.props.size>4) fail(obj.ctx,obj.node,'named-target-slot-bound');
    const descriptors=[];const slots=new Map();const dependents=new Set();
    for(const [name,value] of obj.props) {
        if(!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(name)||['__proto__','prototype','constructor'].includes(name)) fail(obj.ctx,value,'invalid-named-target-name');
        const resolver=object(value,obj.ctx);
        const allowed=['cardTypeFilter','controller','zoneFilter','cardCondition','optional','mode','numCards','canChooseNoCards','immediateEffect','choosingPlayer','dependsOn','activePromptTitle'];
        for(const [key,v]of resolver.props)if(!allowed.includes(key))fail(resolver.ctx,v,'unsupported-named-resolver-field:'+key);
        const mode=resolver.props.has('mode')?literal(resolver.props.get('mode'),resolver.ctx):'single';
        if(!['single','exactly'].includes(mode))fail(resolver.ctx,value,'named-target-mode');
        if(mode==='exactly'&&(!resolver.props.has('numCards')||literal(resolver.props.get('numCards'),resolver.ctx)!==1))fail(resolver.ctx,value,'named-target-exactly-one');
        if(mode==='single'&&resolver.props.has('numCards'))fail(resolver.ctx,value,'named-target-single-count');
        for(const key of ['optional','canChooseNoCards'])if(resolver.props.has(key)&&typeof literal(resolver.props.get(key),resolver.ctx)!=='boolean')fail(resolver.ctx,value,'named-target-optionality');
        const chooser=resolver.props.has('choosingPlayer')?literal(resolver.props.get('choosingPlayer'),resolver.ctx):'self';
        if(!['self','opponent'].includes(chooser))fail(resolver.ctx,value,'named-target-chooser');
        let dependsOn;
        if(resolver.props.has('dependsOn')) {
            dependsOn=literal(resolver.props.get('dependsOn'),resolver.ctx);
            if(!slots.has(dependsOn))fail(resolver.ctx,value,'named-target-backward-dependency');
            if(dependents.has(dependsOn))fail(resolver.ctx,value,'named-target-multiple-dependents');
            dependents.add(dependsOn);
        }
        const scope=new Map(slots);scope.set(name,{array:mode==='exactly'});
        const ctx={...resolver.ctx,namedTargets:scope};
        const props=new Map(resolver.props);props.delete('choosingPlayer');props.delete('dependsOn');
        const spec=targetResolverProperties({...resolver,props,ctx});
        if(!['any','unit','nonLeaderUnit','leaderUnit','tokenUnit','nonTokenUnit','basicUnit','base'].includes(spec.type)||!['arena','anyAttackable','base'].includes(spec.zone))fail(ctx,value,'named-target-card-domain');
        if(resolver.props.has('activePromptTitle'))spec.promptTitle=displayText(resolver.props.get('activePromptTitle'),ctx);
        const entry={name,targetResolver:spec,chooser,...(dependsOn?{dependsOn}:{})};
        if(resolver.props.has('immediateEffect'))entry.effect=effect(resolver.props.get('immediateEffect'),ctx,'chosen');
        const ancestorNames=new Set();let ancestor=dependsOn;
        while(ancestor){ancestorNames.add(ancestor);ancestor=descriptors.find(d=>d.name===ancestor)?.dependsOn;}
        const check=(v)=>{
            if(!v||typeof v!=='object')return;
            if(v.kind==='ref'&&v.path[0]==='namedTargets'&&v.path[1]!==name&&!ancestorNames.has(v.path[1]))fail(ctx,value,'named-target-undeclared-dependency');
            if(v.kind==='ref'&&['event','targets','target'].includes(v.path[0]))fail(ctx,value,'named-target-unsupported-capture');
            Object.values(v).forEach(check);
        };
        check(entry);
        const checkEffect=e=>{
            if(!e)return;
            if(e.kind==='simultaneous'||e.kind==='phaseModifiers') {if(!e.effects.length||e.effects.length>8)fail(ctx,value,'named-effect-bound');e.effects.forEach(checkEffect);return;}
            if(!['damage','ready','exhaust','defeat','giveShield','giveExperience','modifyStats','gainKeyword','loseKeyword'].includes(e.kind))fail(ctx,value,'unsupported-named-effect:'+e.kind);
        };
        checkEffect(entry.effect);
        descriptors.push(entry);slots.set(name,{array:mode==='exactly'});
    }
    return {entries:descriptors,ctx:{...obj.ctx,namedTargets:slots}};
}
function ability(input, context, trigger = null, validatedObject = null) {
    const obj = validatedObject || object(input, context);
    const {props,node}=obj;let ctx=obj.ctx;
    if(ctx.namedTargets?.size && (props.has('targetResolver')||props.has('targetResolvers')||props.has('cost'))) fail(ctx,node,'named-continuation-targeting-or-cost');
    knownProperties(obj, ['title', 'optional', 'cost', 'condition', 'immediateEffect', 'targetResolver', 'targetResolvers', 'ifYouDo', 'ifYouDoCondition', 'then', 'thenCondition', 'limit', 'optionalMakesAbilityNonCancelable']);
    const result = { ...(trigger ? { trigger } : {}), title: props.has('title') ? displayText(props.get('title'), ctx) : '', costs: costs(props.get('cost'), ctx) };
    if(props.has('contextTitle'))result.contextTitle=contextTitle(props.get('contextTitle'),ctx);
    if (props.has('optional')) result.optional = literal(props.get('optional'), ctx);
    if (props.has('condition')) result.condition = expr(props.get('condition'), ctx);
    if (props.has('optionalMakesAbilityNonCancelable')) result.optionalMakesAbilityNonCancelable = literal(props.get('optionalMakesAbilityNonCancelable'), ctx);
    if (props.has('limit')) fail(ctx, props.get('limit'), 'activation-limit');
    if(props.has('targetResolvers')) {
        if(props.has('targetResolver')||props.has('immediateEffect'))fail(ctx,node,'multiple-target-system-properties');
        if(props.has('cost')||props.has('limit'))fail(ctx,node,'named-target-cost-or-limit');
        const named=namedResolvers(props.get('targetResolvers'),ctx);
        result.targetResolvers=named.entries;ctx=named.ctx;
        // Sentinel for absence of a direct parent system. An absent child
        // system remains absent because it controls dependency feasibility.
        result.effect={kind:'noAction'};
        if(!named.entries.some(e=>e.effect)&&!props.has('then')&&!props.has('ifYouDo'))fail(ctx,node,'named-ability-without-effect');
    }
    if (props.has('targetResolver')) {
        if (props.has('immediateEffect')) fail(ctx, node, 'both-targeted-and-direct-effects');
        const resolver = object(props.get('targetResolver'), ctx);
        knownProperties(resolver, ['cardTypeFilter', 'controller', 'zoneFilter', 'cardCondition', 'optional', 'mode', 'numCards', 'canChooseNoCards', 'immediateEffect', 'choosingPlayer']);
        result.targetResolver = targetResolverProperties(resolver);
        if (resolver.props.has('immediateEffect')) result.effect = effect(resolver.props.get('immediateEffect'), resolver.ctx, 'chosen');
    }
    if (props.has('immediateEffect')) {
        if (result.effect) fail(ctx, node, 'both-targeted-and-direct-effects');
        result.effect = effect(props.get('immediateEffect'), ctx, result.targetResolver ? 'chosen' : 'self');
    }
    if (!result.effect) fail(ctx, node, 'ability-without-effect');
    for (const branch of ['then', 'ifYouDo']) if (props.has(branch)) result[branch] = ability(props.get(branch), ctx);
    for (const condition of ['thenCondition', 'ifYouDoCondition']) if (props.has(condition)) result[condition] = expr(props.get(condition), ctx);
    // A factory closes over the previous effect context. Flattening a captured
    // target into the current-target register would change its value after a new
    // resolver runs (Dooku's readied-unit cost must not become the base's cost).
    // The current IR has no capture slots; reject ambiguous lifetimes explicitly.
    const factory = unwrap(input);
    if (ts.isArrowFunction(factory) || ts.isFunctionExpression(factory)) {
        let selection = false, multipleEffects = false, capturedTarget = false, capturedEvent = false, dynamicReference = false;
        const visit = (value) => {
            if (!value || typeof value !== 'object') return;
            if (value.targetResolver) selection = true;
            if (value.then || value.ifYouDo || (value.effects && value.effects.length > 1)) multipleEffects = true;
            if (value.kind === 'ref' && !(value.path[0]==='namedTargets'&&value.path.length===2)) dynamicReference = true;
            if (value.kind === 'ref' && ['target', 'targets'].includes(value.path[0])) capturedTarget = true;
            if (value.kind === 'ref' && value.path[0] === 'event') capturedEvent = true;
            Object.values(value).forEach(visit);
        };
        visit(result);
        if (capturedTarget && (selection || multipleEffects)) fail(ctx, factory, 'continuation-factory-target-lifetime', 'Factory target capture requires a separate value slot before subsequent targeting or effects');
        if (capturedEvent && multipleEffects) fail(ctx, factory, 'continuation-factory-event-lifetime', 'Factory event capture requires a separate value slot before subsequent effects');
        if (dynamicReference && multipleEffects) fail(ctx, factory, 'continuation-factory-value-lifetime', 'Factory values require capture slots before a sequence can change their referenced state');
    }
    let createsTokens = false, discardsHand = false, discardsDeck = false, capturesTokenEvent = false;
    const tokenCapture = (value) => {
        if (!value || typeof value !== 'object') return;
        if (value.kind === 'createTokenUnit') createsTokens = true;
        if (value.kind === 'discardOwnHand') discardsHand = true;
        if (value.kind === 'discardDeck') discardsDeck = true;
        if (value.kind === 'ref' && value.path[0] === 'event') capturesTokenEvent = true;
        Object.values(value).forEach(tokenCapture);
    };
    tokenCapture(result);
    if(ctx.namedTargets) {
        const check=v=> {
            if(!v||typeof v!=='object')return;
            if(v.kind==='ref'&&v.path[0]==='event')fail(ctx,node,'named-event-payload-capture');
            Object.values(v).forEach(check);
        };
        check(result);
    }
    if (createsTokens && capturesTokenEvent) fail(ctx, node, 'token-event-result-capture');
    if (discardsDeck && capturesTokenEvent) fail(ctx, node, 'deck-discard-event-result-capture');
    if (discardsHand && capturesTokenEvent) fail(ctx, node, 'hand-discard-event-result-capture');
    return result;
}
// Standard hooks are one registration with alternative event names. Expand only
// static self hooks; event watchers and shared activation state need separate IR.
function standardTriggeredAbilities(input, context, validatedObject = null) {
    const obj = validatedObject || object(input, context);
    if (!obj.props.has('when')) fail(obj.ctx, obj.node, 'trigger-alias-without-when');
    const whenProperty = obj.node.properties.find(p => ts.isPropertyAssignment(p) && (p.name.text === 'when'));
    if (!whenProperty) fail(obj.ctx, obj.node, 'trigger-alias-static-when');
    const whenNode = unwrap(obj.props.get('when'));
    if (!ts.isObjectLiteralExpression(whenNode)) fail(obj.ctx, whenNode, 'trigger-alias-static-when');
    const when = object(whenNode, obj.ctx);
    if (!when.props.size || when.props.size > 3) fail(when.ctx, when.node, 'trigger-alias-hook-count');
    for (const [hook, value] of when.props) {
        if (!['whenPlayed', 'onAttack', 'whenDefeated'].includes(hook)) fail(when.ctx, value, 'trigger-alias-hook:' + hook);
        if (unwrap(value).kind !== ts.SyntaxKind.TrueKeyword) fail(when.ctx, value, 'trigger-alias-true-only');
    }
    if (obj.props.has('cost')) fail(obj.ctx, obj.props.get('cost'), 'trigger-alias-cost');
    const props = new Map(obj.props);
    props.delete('when');
    return [...when.props.keys()].map((trigger) => ability(input, obj.ctx, trigger, { ...obj, props }));
}
// Coordinate grants this definition while its printed keyword is active.
// Runtime retains the marker separately from condition: attack registration
// is captured before resolution, whereas constant gates remain live.
function coordinateAbility(input, context) {
    const obj = object(input, context);
    if (!obj.props.has('type')) fail(obj.ctx, obj.node, 'coordinate-without-type');
    const type = literal(obj.props.get('type'), obj.ctx);
    const props = new Map(obj.props);
    props.delete('type');
    let result;
    if (type === 'constant') result = constantAbility(input, obj.ctx, { ...obj, props });
    else if (type === 'triggered') {
        if (!props.has('when')) fail(obj.ctx, obj.node, 'coordinate-without-when');
        const when = object(props.get('when'), obj.ctx);
        if (when.props.size !== 1 || !when.props.has('onAttack')) fail(obj.ctx, obj.node, 'coordinate-trigger');
        [result] = standardTriggeredAbilities(input, obj.ctx, { ...obj, props });
    } else fail(obj.ctx, obj.props.get('type'), 'coordinate-type:' + type);
    return { ...result, coordinate: true };
}
function loadEnums(sourceRoot) {
    const out = {};
    const root = path.join(sourceRoot, 'game/core');
    if (!fs.existsSync(root)) return out;
    for (const relative of fs.readdirSync(root, { recursive: true }).filter((f) => f.endsWith('.ts')).sort()) {
        const file = path.join(root, relative);
        const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
        function walk(n) {
            if (ts.isEnumDeclaration(n)) for (const member of n.members) {
                if (member.initializer && (ts.isStringLiteral(member.initializer) || ts.isNumericLiteral(member.initializer))) out[n.name.text + '.' + member.name.getText(sf)] = ts.isStringLiteral(member.initializer) ? member.initializer.text : Number(member.initializer.text);
            }
            ts.forEachChild(n, walk);
        }
        walk(sf);
    }
    return out;
}
function compileSource(text, file, enums = {}) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const ctx = { source, file, enums, scope: new Map(), constants: new Map(), constantScopes: new Map(), constantEnvs: new Map(), constantStages: new Map(), bindings: [], usedConstants: new Set() };
    const diagnostics = [];
    const out = { sourcePath: file, sourceHash: hash(text), abilities: { leader: [], unit: [], card: [] }, diagnostics };
    if (source.parseDiagnostics.length) {
        for (const diagnostic of source.parseDiagnostics) {
            const location = source.getLineAndCharacterOfPosition(diagnostic.start || 0);
            diagnostics.push({ code: 'INVALID_TYPESCRIPT', pattern: 'typescript-parse-error', file, line: location.line + 1, column: location.character + 1, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') });
        }
    }
    for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEmptyStatement(statement)) continue;
        diagnostics.push({ code: 'UNSUPPORTED_SOURCE', pattern: 'module-statement:' + ts.SyntaxKind[statement.kind], file, line: source.getLineAndCharacterOfPosition(statement.getStart()).line + 1, column: 1, message: 'Module-level executable behavior requires conversion' });
    }
    const classes = source.statements.filter(ts.isClassDeclaration);
    if (classes.length !== 1) return { ...out, status: 'unsupported', diagnostics: [{ code: 'UNSUPPORTED_SOURCE', pattern: 'expected-one-card-class', file, line: 1, column: 1, message: `Found ${classes.length} classes` }] };
    const cls = classes[0];
    out.className = cls.name?.text;
    out.baseClass = cls.heritageClauses?.flatMap((c) => c.types.map((t) => t.expression.getText(source)))[0] || null;
    for (const member of cls.members) {
        if (ts.isMethodDeclaration(member) && member.name.getText(source) === 'getImplementationId') {
            const returned = member.body?.statements.find(ts.isReturnStatement)?.expression;
            try {
                const id = object(returned, ctx);
                out.id = literal(id.props.get('id'), ctx);
                out.internalName = literal(id.props.get('internalName'), ctx);
            } catch (e) { if (e instanceof Unsupported) diagnostics.push(e.diagnostic); else throw e; }
        }
    }
    if (!out.id || !out.internalName) diagnostics.push({ code: 'UNSUPPORTED_SOURCE', pattern: 'missing-implementation-identity', file, line: 1, column: 1, message: 'Card does not expose a constant implementation identity' });
    const supportedBases = new Set(['NonLeaderUnitCard', 'LeaderUnitCard', 'BaseCard', 'EventCard', 'UpgradeCard', 'TokenUpgradeCard', 'TokenUnitCard']);
    if (!supportedBases.has(out.baseClass)) diagnostics.push({ code: 'UNSUPPORTED_SOURCE', pattern: 'custom-inheritance:' + out.baseClass, file, line: 1, column: 1, message: 'Inherited custom behavior requires conversion' });
    for (const member of cls.members) {
        const name = member.name?.getText(source);
        if (name === 'getImplementationId') continue;
        if (ts.isPropertyDeclaration(member)) {
            if (name === 'overrideNotImplemented') diagnostics.push({ code: 'ENGINE_UNIMPLEMENTED', pattern: 'engine-override-not-implemented', file, line: source.getLineAndCharacterOfPosition(member.getStart()).line + 1, column: 1, message: 'Engine marks this definition unimplemented' });
            else diagnostics.push({ code: 'UNSUPPORTED_SOURCE', pattern: 'class-state:' + name, file, line: source.getLineAndCharacterOfPosition(member.getStart()).line + 1, column: 1, message: 'Class-local persistent state requires conversion' });
            continue;
        }
        if (!ts.isMethodDeclaration(member)) {
            diagnostics.push({ code: 'UNSUPPORTED_SOURCE', pattern: 'class-member:' + ts.SyntaxKind[member.kind], file, line: source.getLineAndCharacterOfPosition(member.getStart()).line + 1, column: 1, message: 'Additional class behavior requires conversion' });
            continue;
        }
        if (!(name in SIDE_METHODS)) {
            diagnostics.push({ code: 'UNSUPPORTED_SOURCE', pattern: 'method:' + name, file, line: source.getLineAndCharacterOfPosition(member.getStart()).line + 1, column: 1, message: 'Additional class method requires conversion' });
            continue;
        }
        const local = { ...ctx, constants: new Map() };
        for (const statement of member.body?.statements ?? []) {
            try {
                if (ts.isVariableStatement(statement)) {
                    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) fail(local, statement, 'mutable-setup-binding');
                    for (const d of statement.declarationList.declarations) {
                        if (!ts.isIdentifier(d.name) || !d.initializer) fail(local, d, 'complex-setup-binding');
                        bindConstant(local, d.name.text, d.initializer);
                    }
                    continue;
                }
                if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) fail(local, statement, 'setup-statement:' + ts.SyntaxKind[statement.kind]);
                const call = statement.expression;
                const parts = access(call.expression, local);
                const registration = parts.at(-1);
                if (parts.length !== 2 || parts[0] !== member.parameters[0]?.name.getText(source) || (!TRIGGERS[registration] && registration !== 'addConstantAbility' && registration !== 'addTriggeredAbility' && registration !== 'addCoordinateAbility' && registration !== 'addGainKeywordTargetingAttached' && registration !== 'setAttachCondition')) fail(local, call, 'registrar:' + registration);
                if (call.arguments.length !== 1) fail(local, call, 'registration-arity');
                if (['addGainKeywordTargetingAttached', 'setAttachCondition'].includes(registration)) {
                    if (!['UpgradeCard', 'TokenUpgradeCard'].includes(out.baseClass) || name !== 'setupCardAbilities') fail(local, call, 'attached-source-side');
                    if (registration === 'setAttachCondition') {
                        if (out.attachCondition) fail(local, call, 'duplicate-attach-condition');
                        out.attachCondition = attachPredicate(call.arguments[0], local);
                    } else out.abilities.card.push(attachedKeywordAbility(call.arguments[0], local));
                }
                else if (registration === 'addCoordinateAbility') {
                    if (out.baseClass !== 'NonLeaderUnitCard' || name !== 'setupCardAbilities') fail(local, call, 'coordinate-source-side');
                    if (out.abilities.card.some(a => a.coordinate)) fail(local, call, 'coordinate-multiple-definitions');
                    out.abilities.card.push(coordinateAbility(call.arguments[0], local));
                }
                else if (registration === 'addTriggeredAbility') out.abilities[SIDE_METHODS[name]].push(...standardTriggeredAbilities(call.arguments[0], local));
                else out.abilities[SIDE_METHODS[name]].push(registration === 'addConstantAbility' ? constantAbility(call.arguments[0], local) : ability(call.arguments[0], local, TRIGGERS[registration]));
            } catch (e) { if (e instanceof Unsupported) diagnostics.push(e.diagnostic); else throw e; }
        }
    }
    for (const binding of ctx.bindings) if (!ctx.usedConstants.has(binding.node)) {
        const location = source.getLineAndCharacterOfPosition(binding.node.getStart(source));
        diagnostics.push({ code: 'UNSUPPORTED_SOURCE', pattern: 'unused-source-binding', file, line: location.line + 1, column: location.character + 1, message: `Unused binding ${binding.name} may contain unconverted behavior` });
    }
    out.status = diagnostics.length ? 'unsupported' : 'supported';
    return out;
}
module.exports = { SCHEMA, VERSION, ts, hash, compileSource, loadEnums, expr, ability, effect, Unsupported };
