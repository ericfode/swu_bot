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
    if (ts.isIdentifier(node) && ctx.constants?.has(node.text)) return literal(readConstant(node.text, ctx), ctx);
    fail(ctx, node, 'nonconstant-value', node.getText(ctx.source));
}
// Titles are display text, never executable rules. Dynamic title fragments are
// rendered as placeholders; their expressions are deliberately never evaluated.
function displayText(node, ctx) {
    node = unwrap(node);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => {
        const text = span.expression.getText(ctx.source);
        const helper = /^TextHelper\.(?:Trait\.)?([A-Za-z]+)$/.exec(text);
        return (helper ? helper[1] : '[value]') + span.literal.text;
    }).join('');
    return 'Resolve ability';
}
function lambda(node, ctx, names = ['context']) {
    node = unwrap(node);
    if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return { node, ctx };
    const scope = new Map(ctx.scope);
    node.parameters.forEach((p, i) => {
        if (!ts.isIdentifier(p.name)) fail(ctx, p, 'destructured-callback-parameter');
        scope.set(p.name.text, reference(names[i] || `arg${i}`));
    });
    const child = { ...ctx, scope, constants: new Map(ctx.constants) };
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
function arenaQuery(node, ctx, name, filterProps = null) {
    if (!filterProps && node.arguments.length > 1) fail(ctx, node, 'arena-query-arity');
    const receiver = expr(node.expression.expression, ctx);
    if (receiver.kind !== 'ref' || receiver.path.length !== 1 || !['player', 'opponent'].includes(receiver.path[0])) fail(ctx, node, 'arena-query-receiver');
    const obj = filterProps ? { props: filterProps, ctx, node } : node.arguments.length ? object(node.arguments[0], ctx) : { props: new Map(), ctx, node };
    for (const value of obj.props.values()) {
        const visit = (child, bound = new Set()) => {
            if (ts.isArrowFunction(child) || ts.isFunctionExpression(child)) {
                const local = new Set(bound);
                for (const parameter of child.parameters) if (ts.isIdentifier(parameter.name)) local.add(parameter.name.text);
                visit(child.body, local);
                return;
            }
            if (ts.isIdentifier(child) && !bound.has(child.text) && obj.ctx.scope.get(child.text)?.path?.[0] === 'card' && !(ts.isPropertyAccessExpression(child.parent) && child.parent.name === child)) fail(obj.ctx, child, 'arena-query-card-capture');
            if (ts.isIdentifier(child) && !bound.has(child.text) && obj.ctx.constants.has(child.text) && !(ts.isPropertyAccessExpression(child.parent) && child.parent.name === child)) {
                visit(readConstant(child.text, obj.ctx), bound);
                return;
            }
            ts.forEachChild(child, (nested) => visit(nested, bound));
        };
        visit(value);
    }
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
    if (obj.props.has('condition')) intersect(expr(obj.props.get('condition'), obj.ctx, ['card']));
    return { kind: 'query', name, receiver, args: [predicate] };
}
function expr(input, context, params = ['context']) {
    let { node, ctx } = lambda(input, context, params);
    node = unwrap(node);
    if (ts.isIdentifier(node) && ctx.constants?.has(node.text)) return expr(readConstant(node.text, ctx), ctx);
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'length' && ts.isCallExpression(node.expression) && ts.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.name.text === 'getArenaUnits') return arenaQuery(node.expression, ctx, 'arenaUnitCount');
    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) return constant(literal(node, ctx));
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || node.kind === ts.SyntaxKind.ThisKeyword) {
        const enumValue = ctx.enums[node.getText(ctx.source)];
        if (enumValue !== undefined) return constant(enumValue);
        let parts = access(node, ctx);
        const binding = ctx.scope.get(parts[0]);
        if (binding) {
            if (binding.kind !== 'ref') fail(ctx, node, 'property-of-nonreference-local');
            parts = [...binding.path, ...parts.slice(1)];
        } else if (parts[0] !== 'this') fail(ctx, node, 'unbound-reference:' + parts[0]);
        parts = normalizeRef(parts);
        const roots = new Set(['source', 'player', 'opponent', 'target', 'targets', 'card', 'event', 'attack']);
        if (!roots.has(parts[0])) fail(ctx, node, 'unimplemented-context-field:' + parts[0]);
        return reference(...parts);
    }
    if (ts.isArrayLiteralExpression(node)) return { kind: 'array', items: node.elements.map((e) => expr(e, ctx)) };
    if (ts.isPrefixUnaryExpression(node)) {
        const op = ts.tokenToString(node.operator);
        if (!['!', '-', '+', '~'].includes(op)) fail(ctx, node, 'unsupported-unary:' + op);
        return { kind: 'unary', op, value: expr(node.operand, ctx) };
    }
    if (ts.isBinaryExpression(node)) {
        const op = node.operatorToken.getText(ctx.source);
        if (!['+', '-', '*', '/', '%', '===', '!==', '==', '!=', '<', '<=', '>', '>=', '&&', '||', '??', '&', '|'].includes(op)) fail(ctx, node, 'side-effecting-expression:' + op);
        return { kind: 'binary', op, left: expr(node.left, ctx), right: expr(node.right, ctx) };
    }
    if (ts.isConditionalExpression(node)) return { kind: 'conditional', condition: expr(node.condition, ctx), then: expr(node.whenTrue, ctx), else: expr(node.whenFalse, ctx) };
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const call = node.expression;
        const name = call.name.text;
        if (name === 'hasSomeArenaUnit') return arenaQuery(node, ctx, name);
        if (['isTraitInPlay', 'isAspectInPlay', 'isKeywordInPlay'].includes(name)) {
            if (node.arguments.length < 1 || node.arguments.length > 2) fail(ctx, node, 'arena-query-alias-arity');
            const field = { isTraitInPlay: 'trait', isAspectInPlay: 'aspect', isKeywordInPlay: 'keyword' }[name];
            const filters = new Map([[field, node.arguments[0]]]);
            if (node.arguments.length === 2) filters.set('otherThan', node.arguments[1]);
            return arenaQuery(node, ctx, 'hasSomeArenaUnit', filters);
        }
        if (call.expression.getText(ctx.source) === 'Math' && ['min', 'max', 'floor', 'ceil', 'abs'].includes(name)) return { kind: 'math', name, args: node.arguments.map((a) => expr(a, ctx)) };
        if (QUERY_NAMES.has(name)) return { kind: 'query', name, receiver: expr(call.expression, ctx), args: node.arguments.map((a) => expr(a, ctx)) };
        if (['some', 'every', 'filter', 'map', 'find', 'includes', 'concat', 'slice'].includes(name)) {
            const receiver = expr(call.expression, ctx);
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
    if (ts.isIdentifier(node) && ctx.constants.has(node.text)) return object(readConstant(node.text, ctx), ctx);
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
    const e = expr(node, ctx);
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
    if (kind === 'forThisPhaseCardEffect') {
        // Lasting stat modifiers have their values captured when the immediate
        // system resolves. A function passed to modifyStats itself is different:
        // the engine keeps reevaluating it as board state changes.
        const allowed = ['target', 'effect', 'title', 'ongoingEffectTargetDescription'];
        for (const [key, value] of obj.props) if (!allowed.includes(key) && !DISPLAY_FIELDS.has(key)) fail(obj.ctx, value, 'unsupported-field:' + key);
        if (!obj.props.has('effect')) fail(ctx, node, 'phase-effect-without-modifier');
        const modifierCall = unwrap(obj.props.get('effect'));
        if (!ts.isCallExpression(modifierCall)) fail(obj.ctx, modifierCall, 'phase-modifier-is-not-helper');
        const modifierPath = access(modifierCall.expression, obj.ctx);
        if (modifierPath.length !== 3 || !['AbilityHelper', 'abilityHelper', 'StaticAbilityHelper'].includes(modifierPath[0]) || modifierPath[1] !== 'ongoingEffects' || modifierPath[2] !== 'modifyStats') fail(obj.ctx, modifierCall, 'phase-modifier:' + modifierPath.join('.'));
        if (modifierCall.arguments.length !== 1) fail(obj.ctx, modifierCall, 'stat-modifier-arity');
        let modifierNode = unwrap(modifierCall.arguments[0]);
        while (ts.isIdentifier(modifierNode) && obj.ctx.constants.has(modifierNode.text)) modifierNode = unwrap(readConstant(modifierNode.text, obj.ctx));
        if (ts.isArrowFunction(modifierNode) || ts.isFunctionExpression(modifierNode)) fail(obj.ctx, modifierNode, 'dynamic-ongoing-stat-modifier');
        const modifier = object(modifierNode, obj.ctx);
        knownProperties(modifier, ['power', 'hp']);
        if (!modifier.props.has('power') || !modifier.props.has('hp')) fail(modifier.ctx, modifier.node, 'incomplete-stat-modifier');
        for (const stat of ['power', 'hp']) {
            let value = unwrap(modifier.props.get(stat));
            while (ts.isIdentifier(value) && modifier.ctx.constants.has(value.text)) value = unwrap(readConstant(value.text, modifier.ctx));
            if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) fail(modifier.ctx, value, 'function-valued-stat-modifier');
        }
        return { kind: 'modifyStats', target: target(obj.props.get('target'), obj.ctx, defaultTarget), duration: 'phase', power: expr(modifier.props.get('power'), modifier.ctx), hp: expr(modifier.props.get('hp'), modifier.ctx) };
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
        return { kind: 'select', targetResolver: targetResolverProperties(obj), effect: effect(obj.props.get('immediateEffect'), obj.ctx, 'chosen') };
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
    let type = typeNames[rawType];
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
    if (props.has('cardCondition')) result.predicate = expr(props.get('cardCondition'), ctx, ['card', 'context']);
    if (props.has('mode')) result.mode = literal(props.get('mode'), ctx);
    if (props.has('numCards')) result.count = expr(props.get('numCards'), ctx);
    if (props.has('canChooseNoCards')) result.optional = !!result.optional || literal(props.get('canChooseNoCards'), ctx);
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
function constantAbility(input, context) {
    const obj = object(input, context);
    knownProperties(obj, ['title', 'condition', 'ongoingEffect', 'matchTarget', 'targetController', 'targetCardTypeFilter', 'targetZoneFilter']);
    const { props, ctx, node } = obj;
    if (!props.has('ongoingEffect')) fail(ctx, node, 'constant-without-effect');
    const raw = unwrap(props.get('ongoingEffect'));
    const modifiers = ts.isArrayLiteralExpression(raw) ? raw.elements : [raw];
    if (modifiers.length !== 1) fail(ctx, raw, 'constant-modifier-count');
    const call = unwrap(modifiers[0]);
    if (!ts.isCallExpression(call)) fail(ctx, call, 'constant-modifier-is-not-helper');
    const parts = access(call.expression, ctx);
    if (parts.length !== 3 || !['AbilityHelper', 'abilityHelper', 'StaticAbilityHelper'].includes(parts[0]) || parts[1] !== 'ongoingEffects' || parts[2] !== 'modifyStats') fail(ctx, call, 'constant-modifier:' + parts.join('.'));
    if (call.arguments.length !== 1) fail(ctx, call, 'stat-modifier-arity');
    let modifierNode = unwrap(call.arguments[0]);
    while (ts.isIdentifier(modifierNode) && ctx.constants.has(modifierNode.text)) modifierNode = unwrap(readConstant(modifierNode.text, ctx));
    if (ts.isArrowFunction(modifierNode) || ts.isFunctionExpression(modifierNode)) fail(ctx, modifierNode, 'dynamic-constant-stat-modifier');
    const modifier = object(modifierNode, ctx);
    knownProperties(modifier, ['power', 'hp']);
    const values = {};
    for (const stat of ['power', 'hp']) {
        if (!modifier.props.has(stat)) fail(ctx, modifier.node, 'incomplete-stat-modifier');
        values[stat] = literal(modifier.props.get(stat), modifier.ctx);
        if (!Number.isSafeInteger(values[stat])) fail(ctx, modifier.props.get(stat), 'noninteger-stat-modifier');
    }
    const result = { trigger: 'constant', title: props.has('title') ? displayText(props.get('title'), ctx) : '', costs: [], effect: { kind: 'modifyStats', target: 'self', duration: 'persistent', power: constant(values.power), hp: constant(values.hp) } };
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
        result.effect.target = 'chosen';
    }
    const check = (value) => {
        if (!value || typeof value !== 'object') return;
        if ((value.kind === 'query' && ['getPower', 'getHp'].includes(value.name)) || (value.kind === 'ref' && value.path.some((p) => ['power', 'hp', 'remainingHp'].includes(p)))) fail(ctx, node, 'constant-stat-dependency');
        Object.values(value).forEach(check);
    };
    check(result.condition); check(result.targetResolver);
    return result;
}
function ability(input, context, trigger = null) {
    const obj = object(input, context);
    const { props, ctx, node } = obj;
    knownProperties(obj, ['title', 'optional', 'cost', 'condition', 'immediateEffect', 'targetResolver', 'ifYouDo', 'ifYouDoCondition', 'then', 'thenCondition', 'limit', 'optionalMakesAbilityNonCancelable']);
    const result = { ...(trigger ? { trigger } : {}), title: props.has('title') ? displayText(props.get('title'), ctx) : '', costs: costs(props.get('cost'), ctx) };
    if (props.has('optional')) result.optional = literal(props.get('optional'), ctx);
    if (props.has('condition')) result.condition = expr(props.get('condition'), ctx);
    if (props.has('optionalMakesAbilityNonCancelable')) result.optionalMakesAbilityNonCancelable = literal(props.get('optionalMakesAbilityNonCancelable'), ctx);
    if (props.has('limit')) fail(ctx, props.get('limit'), 'activation-limit');
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
            if (value.kind === 'ref') dynamicReference = true;
            if (value.kind === 'ref' && ['target', 'targets'].includes(value.path[0])) capturedTarget = true;
            if (value.kind === 'ref' && value.path[0] === 'event') capturedEvent = true;
            Object.values(value).forEach(visit);
        };
        visit(result);
        if (capturedTarget && (selection || multipleEffects)) fail(ctx, factory, 'continuation-factory-target-lifetime', 'Factory target capture requires a separate value slot before subsequent targeting or effects');
        if (capturedEvent && multipleEffects) fail(ctx, factory, 'continuation-factory-event-lifetime', 'Factory event capture requires a separate value slot before subsequent effects');
        if (dynamicReference && multipleEffects) fail(ctx, factory, 'continuation-factory-value-lifetime', 'Factory values require capture slots before a sequence can change their referenced state');
    }
    return result;
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
    const ctx = { source, file, enums, scope: new Map(), constants: new Map(), bindings: [], usedConstants: new Set() };
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
                if (parts.length !== 2 || parts[0] !== member.parameters[0]?.name.getText(source) || (!TRIGGERS[registration] && registration !== 'addConstantAbility')) fail(local, call, 'registrar:' + registration);
                if (call.arguments.length !== 1) fail(local, call, 'registration-arity');
                out.abilities[SIDE_METHODS[name]].push(registration === 'addConstantAbility' ? constantAbility(call.arguments[0], local) : ability(call.arguments[0], local, TRIGGERS[registration]));
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
