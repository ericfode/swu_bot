'use strict';
const same = require('node:util').isDeepStrictEqual;
const { parseKeywords } = require('../../omni/rs/make-pool');
const keys = (v, allowed) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => allowed.includes(k));
const emptyAbilities = { leader: [], unit: [], card: [] };
const noPilot = e => e?.piloting == null && e.card?.pilotText == null && e.card?.pilotBox == null && e.card?.pilotingBox == null && e.attachCondition == null;
const strings = a => Array.isArray(a) && a.every(v => typeof v === 'string');
const ordinary = e => e?.status === 'supported' && same(e.card?.types, ['unit']) && typeof e.card.unique === 'boolean' && noPilot(e) &&
    ['ground', 'space'].includes(e.card.arena) && e.card.deployBox == null && (e.card.epicAction == null || e.card.epicAction === '') && e.card.upgradeHp == null && e.card.upgradePower == null && Number.isInteger(e.card.cost) && e.card.cost >= 0 && Number.isInteger(e.card.hp) && e.card.hp > 0 &&
    Number.isInteger(e.card.power) && e.card.power >= 0 && strings(e.card.traits) && strings(e.card.aspects);
const provenance = e => e.baseClass === 'NonLeaderUnitCard' && typeof e.sourcePath === 'string' && e.sourcePath.length > 0 && /^[a-f0-9]{64}$/.test(e.sourceHash ?? '');
const c = value => ({ kind: 'const', value }), r = (...path) => ({ kind: 'ref', path });
const inventory = threshold => ({ kind: 'binary', op: '>', left: r('card', 'keywords', 'length'), right: c(threshold) });
function classifyKeywordInventory(e) {
    if (!ordinary(e) || !provenance(e) || e.card.cost > 6 || e.card.aspects.length > 2 || !same(e.card.keywords, []) || !same(e.keywordValues, {}) ||
        !keys(e.abilities, ['leader', 'unit', 'card']) || !same(e.abilities.leader, []) || !same(e.abilities.unit, []) || e.abilities.card?.length !== 1)
        return null;
    const a = e.abilities.card[0];
    if (!keys(a, ['trigger', 'title', 'costs', 'optional', 'effect', 'targetResolver']) || typeof a.title !== 'string' || !a.title.length || Buffer.byteLength(a.title, 'utf8') > 1024 || !same(a.costs, []))
        return null;
    if (a.trigger === 'whenPlayed' && a.optional === true && same(a.effect, { kind: 'exhaust', target: 'chosen' }) &&
        same(a.targetResolver, { owner: 'any', type: 'unit', zone: 'anyAttackable', predicate: inventory(0) }))
        return { family: 'keyword-inventory', mode: 'optional-exhaust' };
    const predicate = { kind: 'binary', op: '&&', left: { kind: 'binary', op: '&&', left: { kind: 'binary', op: '!==', left: r('card'), right: r('source') },
            right: { kind: 'query', name: 'isUnit', receiver: r('card'), args: [] } }, right: inventory(1) };
    if (a.trigger === 'constant' && !Object.hasOwn(a, 'optional') && same(a.effect, { kind: 'modifyStats', target: 'chosen', duration: 'persistent', power: c(2), hp: c(2) }) &&
        same(a.targetResolver, { owner: 'self', type: 'unit', zone: 'arena', predicate }))
        return { family: 'keyword-inventory', mode: 'other-friendly-aura', power: 2, hp: 2 };
    return null;
}
function literalUnit(e) {
    if (!ordinary(e) || e.card.unique !== false || e.baseClass != null || e.sourcePath !== null || e.sourceHash !== null || !same(e.abilities, emptyAbilities))
        return false;
    const known = ['sentinel', 'restore', 'raid', 'overwhelm', 'saboteur', 'grit', 'shielded', 'hidden', 'ambush'];
    if (!keys(e.keywordValues, known) || !strings(e.card.keywords) || !same([...e.card.keywords].sort(), Object.keys(e.keywordValues).sort()))
        return false;
    if (Object.entries(e.keywordValues).some(([k, v]) => ['raid', 'restore'].includes(k) ? !Number.isInteger(v) || v < 1 || v > 65535 : v !== 1))
        return false;
    if (!Object.keys(e.keywordValues).length)
        return e.card.text === '';
    return same(parseKeywords(e.card), e.keywordValues);
}
function coordinateUnit(e) {
    return ordinary(e) && provenance(e) && e.card.unique === false && same(e.card.keywords, ['coordinate']) && same(e.keywordValues, { coordinate: 1 }) &&
        same(e.abilities?.leader, []) && same(e.abilities?.unit, []) && e.abilities?.card?.length === 1 &&
        keys(e.abilities.card[0], ['trigger', 'title', 'costs', 'coordinate', 'effect']) && typeof e.abilities.card[0].title === 'string' && same(e.abilities.card[0].costs, []) &&
        e.abilities.card[0].trigger === 'constant' && e.abilities.card[0].coordinate === true && same(e.abilities.card[0].effect, { kind: 'modifyStats', target: 'self', duration: 'persistent', power: c(0), hp: c(3) });
}
const ROLE_SPECS = {
    "dynamic-raid": {
        "baseClass": "NonLeaderUnitCard",
        "types": [
            "unit"
        ],
        "unique": true,
        "arena": "ground",
        "cost": 3,
        "hp": 5,
        "power": 0,
        "upgradeHp": null,
        "upgradePower": null,
        "keywords": [
            "raid",
            "overwhelm"
        ],
        "keywordValues": {},
        "abilities": {
            "leader": [],
            "unit": [],
            "card": [
                {
                    "trigger": "constant",
                    "title": "This unit gains Raid 1 for each exhausted resource you control",
                    "costs": [],
                    "effect": {
                        "kind": "gainKeyword",
                        "target": "self",
                        "duration": "persistent",
                        "keyword": "raid",
                        "amount": {
                            "kind": "ref",
                            "path": [
                                "player",
                                "exhaustedResourceCount"
                            ]
                        }
                    }
                },
                {
                    "trigger": "constant",
                    "title": "While each resource you control is exhausted, this unit gains Overwhelm",
                    "costs": [],
                    "effect": {
                        "kind": "gainKeyword",
                        "target": "self",
                        "duration": "persistent",
                        "keyword": "overwhelm",
                        "amount": {
                            "kind": "const",
                            "value": 1
                        }
                    },
                    "condition": {
                        "kind": "binary",
                        "op": "===",
                        "left": {
                            "kind": "ref",
                            "path": [
                                "player",
                                "readyResourceCount"
                            ]
                        },
                        "right": {
                            "kind": "const",
                            "value": 0
                        }
                    }
                }
            ]
        }
    },
    "force-sentinel": {
        "baseClass": "NonLeaderUnitCard",
        "types": [
            "unit"
        ],
        "unique": false,
        "arena": "ground",
        "cost": 4,
        "hp": 4,
        "power": 5,
        "upgradeHp": null,
        "upgradePower": null,
        "keywords": [
            "sentinel"
        ],
        "keywordValues": {},
        "abilities": {
            "leader": [],
            "unit": [],
            "card": [
                {
                    "trigger": "constant",
                    "title": "While the Force is with you, this unit gains Sentinel.",
                    "costs": [],
                    "effect": {
                        "kind": "gainKeyword",
                        "target": "self",
                        "duration": "persistent",
                        "keyword": "sentinel",
                        "amount": {
                            "kind": "const",
                            "value": 1
                        }
                    },
                    "condition": {
                        "kind": "ref",
                        "path": [
                            "player",
                            "hasTheForce"
                        ]
                    }
                }
            ]
        }
    },
    "restore-upgrade": {
        "baseClass": "UpgradeCard",
        "types": [
            "upgrade"
        ],
        "unique": false,
        "arena": null,
        "cost": 2,
        "hp": 1,
        "power": 1,
        "upgradeHp": 1,
        "upgradePower": 1,
        "keywords": [
            "restore"
        ],
        "keywordValues": {},
        "abilities": {
            "leader": [],
            "unit": [],
            "card": [
                {
                    "trigger": "constant",
                    "title": "Give Restore 2 to the attached unit",
                    "costs": [],
                    "effect": {
                        "kind": "gainKeyword",
                        "target": "parent",
                        "duration": "persistent",
                        "keyword": "restore",
                        "amount": {
                            "kind": "const",
                            "value": 2
                        }
                    }
                }
            ]
        }
    },
    "gain-force": {
        "baseClass": "NonLeaderUnitCard",
        "types": [
            "unit"
        ],
        "unique": false,
        "arena": "ground",
        "cost": 2,
        "hp": 3,
        "power": 2,
        "upgradeHp": null,
        "upgradePower": null,
        "keywords": [],
        "keywordValues": {},
        "abilities": {
            "leader": [],
            "unit": [],
            "card": [
                {
                    "trigger": "whenPlayed",
                    "title": "The Force is with you",
                    "costs": [],
                    "effect": {
                        "kind": "gainForce",
                        "target": "ownPlayer"
                    }
                }
            ]
        }
    },
    "use-ready": {
        "baseClass": "NonLeaderUnitCard",
        "types": [
            "unit"
        ],
        "unique": true,
        "arena": "ground",
        "cost": 3,
        "hp": 4,
        "power": 3,
        "upgradeHp": null,
        "upgradePower": null,
        "keywords": [],
        "keywordValues": {},
        "abilities": {
            "leader": [],
            "unit": [],
            "card": [
                {
                    "trigger": "whenPlayed",
                    "title": "Use the Force to ready this unit",
                    "costs": [],
                    "optional": true,
                    "effect": {
                        "kind": "useForce",
                        "target": "ownPlayer"
                    },
                    "ifYouDo": {
                        "title": "Ready this unit",
                        "costs": [],
                        "effect": {
                            "kind": "ready",
                            "target": "self"
                        }
                    }
                }
            ]
        }
    },
    "drain": {
        "baseClass": "EventCard",
        "types": [
            "event"
        ],
        "unique": false,
        "arena": null,
        "cost": 2,
        "hp": null,
        "power": null,
        "upgradeHp": null,
        "upgradePower": null,
        "keywords": [],
        "keywordValues": {},
        "abilities": {
            "leader": [],
            "unit": [],
            "card": [
                {
                    "trigger": "event",
                    "title": "Deal 2 damage to a unit. The Force is with you.",
                    "costs": [],
                    "effect": {
                        "kind": "simultaneous",
                        "effects": [
                            {
                                "kind": "select",
                                "targetResolver": {
                                    "owner": "any",
                                    "type": "unit",
                                    "zone": "anyAttackable",
                                    "promptTitle": "Select a unit to deal 2 damage to"
                                },
                                "effect": {
                                    "kind": "damage",
                                    "target": "chosen",
                                    "amount": {
                                        "kind": "const",
                                        "value": 2
                                    }
                                }
                            },
                            {
                                "kind": "gainForce",
                                "target": "ownPlayer"
                            }
                        ]
                    }
                }
            ]
        }
    },
    "damage-two": {
        "baseClass": "EventCard",
        "types": [
            "event"
        ],
        "unique": false,
        "arena": null,
        "cost": 1,
        "hp": null,
        "power": null,
        "upgradeHp": null,
        "upgradePower": null,
        "keywords": [],
        "keywordValues": {},
        "abilities": {
            "leader": [],
            "unit": [],
            "card": [
                {
                    "trigger": "event",
                    "title": "Deal 2 damage to a unit or base",
                    "costs": [],
                    "targetResolver": {
                        "owner": "any",
                        "type": "any",
                        "zone": "anyAttackable"
                    },
                    "effect": {
                        "kind": "damage",
                        "target": "chosen",
                        "amount": {
                            "kind": "const",
                            "value": 2
                        }
                    }
                }
            ]
        }
    },
    "gain-pair": {
        "baseClass": "EventCard",
        "types": [
            "event"
        ],
        "unique": false,
        "arena": null,
        "cost": 2,
        "hp": null,
        "power": null,
        "upgradeHp": null,
        "upgradePower": null,
        "keywords": [
            "raid",
            "saboteur"
        ],
        "keywordValues": {},
        "abilities": {
            "leader": [],
            "unit": [],
            "card": [
                {
                    "trigger": "event",
                    "title": "Each friendly Force unit gains Raid 1 and Saboteur for this phase.",
                    "costs": [],
                    "effect": {
                        "kind": "simultaneous",
                        "effects": [
                            {
                                "kind": "gainKeyword",
                                "target": {
                                    "kind": "arenaList",
                                    "receiver": {
                                        "kind": "ref",
                                        "path": [
                                            "player"
                                        ]
                                    },
                                    "predicate": {
                                        "kind": "binary",
                                        "op": "&&",
                                        "left": {
                                            "kind": "const",
                                            "value": true
                                        },
                                        "right": {
                                            "kind": "query",
                                            "name": "hasSomeTrait",
                                            "receiver": {
                                                "kind": "ref",
                                                "path": [
                                                    "card"
                                                ]
                                            },
                                            "args": [
                                                {
                                                    "kind": "const",
                                                    "value": "force"
                                                }
                                            ]
                                        }
                                    }
                                },
                                "duration": "phase",
                                "keyword": "raid",
                                "amount": {
                                    "kind": "const",
                                    "value": 1
                                }
                            },
                            {
                                "kind": "gainKeyword",
                                "target": {
                                    "kind": "arenaList",
                                    "receiver": {
                                        "kind": "ref",
                                        "path": [
                                            "player"
                                        ]
                                    },
                                    "predicate": {
                                        "kind": "binary",
                                        "op": "&&",
                                        "left": {
                                            "kind": "const",
                                            "value": true
                                        },
                                        "right": {
                                            "kind": "query",
                                            "name": "hasSomeTrait",
                                            "receiver": {
                                                "kind": "ref",
                                                "path": [
                                                    "card"
                                                ]
                                            },
                                            "args": [
                                                {
                                                    "kind": "const",
                                                    "value": "force"
                                                }
                                            ]
                                        }
                                    }
                                },
                                "duration": "phase",
                                "keyword": "saboteur",
                                "amount": {
                                    "kind": "const",
                                    "value": 1
                                }
                            }
                        ]
                    }
                }
            ]
        }
    },
    "loss-name": {
        "baseClass": "EventCard",
        "types": [
            "event"
        ],
        "unique": false,
        "arena": null,
        "cost": 2,
        "hp": null,
        "power": null,
        "upgradeHp": null,
        "upgradePower": null,
        "keywords": [
            "sentinel",
            "saboteur"
        ],
        "keywordValues": {},
        "abilities": {
            "leader": [],
            "unit": [],
            "card": [
                {
                    "trigger": "event",
                    "title": "Each unit gains Sentinel and loses Saboteur for this phase.",
                    "costs": [],
                    "effect": {
                        "kind": "phaseModifiers",
                        "effects": [
                            {
                                "kind": "gainKeyword",
                                "target": {
                                    "kind": "arenaList",
                                    "receiver": {
                                        "kind": "ref",
                                        "path": [
                                            "game"
                                        ]
                                    },
                                    "predicate": {
                                        "kind": "const",
                                        "value": true
                                    }
                                },
                                "duration": "phase",
                                "keyword": "sentinel",
                                "amount": {
                                    "kind": "const",
                                    "value": 1
                                }
                            },
                            {
                                "kind": "loseKeyword",
                                "target": {
                                    "kind": "arenaList",
                                    "receiver": {
                                        "kind": "ref",
                                        "path": [
                                            "game"
                                        ]
                                    },
                                    "predicate": {
                                        "kind": "const",
                                        "value": true
                                    }
                                },
                                "duration": "phase",
                                "keyword": "saboteur"
                            }
                        ]
                    }
                }
            ]
        }
    }
};
Object.assign(ROLE_SPECS, {
    "saboteur-upgrade": {
        "baseClass": "UpgradeCard",
        "types": [
            "upgrade"
        ],
        "unique": false,
        "arena": null,
        "cost": 1,
        "hp": 1,
        "power": 1,
        "upgradeHp": 1,
        "upgradePower": 1,
        "keywords": [
            "saboteur"
        ],
        "keywordValues": {},
        "abilities": {
            "leader": [],
            "unit": [],
            "card": [
                {
                    "trigger": "constant",
                    "title": "Give Saboteur to the attached unit",
                    "costs": [],
                    "effect": {
                        "kind": "gainKeyword",
                        "target": "parent",
                        "duration": "persistent",
                        "keyword": "saboteur",
                        "amount": {
                            "kind": "const",
                            "value": 1
                        }
                    }
                }
            ]
        }
    },
    "raid-all": {
        "baseClass": "EventCard",
        "types": [
            "event"
        ],
        "unique": false,
        "arena": null,
        "cost": 3,
        "hp": null,
        "power": null,
        "upgradeHp": null,
        "upgradePower": null,
        "keywords": [
            "raid"
        ],
        "keywordValues": {},
        "abilities": {
            "leader": [],
            "unit": [],
            "card": [
                {
                    "trigger": "event",
                    "title": "Each friendly unit gains Raid 2 this phase",
                    "costs": [],
                    "effect": {
                        "kind": "gainKeyword",
                        "target": {
                            "kind": "arenaList",
                            "receiver": {
                                "kind": "ref",
                                "path": [
                                    "player"
                                ]
                            },
                            "predicate": {
                                "kind": "const",
                                "value": true
                            }
                        },
                        "duration": "phase",
                        "keyword": "raid",
                        "amount": {
                            "kind": "const",
                            "value": 2
                        }
                    }
                }
            ]
        }
    }
});
ROLE_SPECS['damage-four'] = {
    "baseClass": "EventCard",
    "types": [
        "event"
    ],
    "unique": false,
    "arena": null,
    "cost": 3,
    "hp": null,
    "power": null,
    "upgradeHp": null,
    "upgradePower": null,
    "keywords": [],
    "keywordValues": {},
    "abilities": {
        "leader": [],
        "unit": [],
        "card": [
            {
                "trigger": "event",
                "title": "Deal 4 damage to a unit.",
                "costs": [],
                "targetResolver": {
                    "owner": "any",
                    "type": "unit",
                    "zone": "anyAttackable"
                },
                "effect": {
                    "kind": "damage",
                    "target": "chosen",
                    "amount": {
                        "kind": "const",
                        "value": 4
                    }
                }
            }
        ]
    }
};
function roleDonor(e, role) {
    const spec = ROLE_SPECS[role];
    if (!spec || e?.status !== 'supported' || !noPilot(e) || e.baseClass !== spec.baseClass || !same(e.card?.types, spec.types) || typeof e.sourcePath !== 'string' || !e.sourcePath.length || !/^[a-f0-9]{64}$/.test(e.sourceHash ?? '') || !strings(e.card.traits) || !strings(e.card.aspects))
        return false;
    return same({ baseClass: e.baseClass, types: e.card.types, unique: e.card.unique, arena: e.card.arena ?? null, cost: e.card.cost, hp: e.card.hp, power: e.card.power,
        upgradeHp: e.card.upgradeHp, upgradePower: e.card.upgradePower, keywords: e.card.keywords, keywordValues: e.keywordValues, abilities: e.abilities }, spec);
}
function planKeywordInventoryProbes(entry, options = {}) {
    const shape = classifyKeywordInventory(entry);
    if (!shape)
        return null;
    const defs = [...(Array.isArray(options.catalogue) ? options.catalogue : options.catalogue?.cards ?? [])].sort((a, b) => a.setCode.localeCompare(b.setCode));
    const result = { schema: 'swu-card-probes/v1', cardId: entry.setCode, sourceHash: entry.sourceHash, cases: [], obligations: [], uncovered: [] };
    const obligation = (name, reason) => { const id = entry.setCode + ':keyword-inventory:' + name; result.obligations.push({ id, path: 'abilities.card', dimension: name }); if (reason)
        result.uncovered.push({ id, path: 'abilities.card', reason }); return id; };
    const donors = defs.filter(literalUnit), zero = donors.find(e => !Object.keys(e.keywordValues).length && e.card.arena === 'ground'), one = donors.find(e => Object.keys(e.keywordValues).length === 1 && e.card.arena === 'ground' && !e.keywordValues.ambush && !e.keywordValues.shielded), two = donors.find(e => Object.keys(e.keywordValues).length === 2 && e.card.arena === 'ground' && !e.keywordValues.ambush && !e.keywordValues.shielded), space = donors.find(e => Object.keys(e.keywordValues).length === 2 && e.card.arena === 'space' && !e.keywordValues.ambush && !e.keywordValues.shielded), alternate = donors.find(e => Object.keys(e.keywordValues).length === 1 && e.card.arena === 'space' && !e.keywordValues.ambush && !e.keywordValues.shielded), coord = defs.find(coordinateUnit);
    const target = (e, owner, exhausted = false) => ({ code: e.setCode, owner, arena: e.card.arena, exhausted, damage: 0 });
    const add = (name, seat, targets, extra = {}) => {
        const id = obligation(name + '-seat-' + seat), probe = { ...shape, cardId: entry.setCode, sourceSeat: seat, resourceCount: 35, targets, ...extra };
        result.cases.push({ id: 'auto/' + entry.setCode + '/keyword-inventory-' + name + '-seat-' + seat, name: 'keyword-inventory-' + name + '-seat-' + seat, kind: 'probe', focusCardIds: [entry.setCode],
            setupCardIds: [...new Set([...targets.map(t => t.code), ...(extra.macro?.startsWith('shielded') ? defs.filter(require('./arena-damage-probes').nativeShield).map(e => e.setCode) : []), ...(extra.macro?.startsWith('force-') || extra.macro === 'mention' ? defs.filter(require('./force-probes').nativeForce).map(e => e.setCode) : [])])].sort(), behaviorIds: ['keyword-inventory', shape.mode], assertionStages: ['construction', 'normal-play', 'source-effects', 'terminal'], coverageObligationIds: [id],
            source: { module: '../pipeline/probe-fixture.js', scenario: 'keyword-inventory-' + name + '-seat-' + seat }, probe });
    };
    if (!zero || !one || !two || !space || !alternate || !coord) {
        obligation('actual-donors', 'No complete bounded literal/Coordinate donors for this construction');
        return result;
    }
    for (const seat of [1, 2]) {
        if (shape.mode === 'other-friendly-aura')
            add('mixed-inventory', seat, ['self', 'opponent'].flatMap(owner => [zero, one, two, space].map(e => target(e, owner, true))));
        else {
            for (const owner of ['self', 'opponent']) {
                add('ready-' + owner, seat, [target(one, owner)], { selectedIndex: 0 });
                add('exhausted-with-alternative-' + owner, seat, [target(one, owner, true), target(alternate, 'opponent')], { selectedIndex: 0, ineffectiveSelected: true });
                add('coordinate-' + owner, seat, [target(coord, owner)], { selectedIndex: 0, inactiveCoordinate: true });
                add('no-keywords-' + owner, seat, [target(zero, owner)], { noSelector: true });
                add('decline-' + owner, seat, [target(one, owner)], { decline: true });
            }
            add('true-empty', seat, [], { noSelector: true });
            add('all-ineffective', seat, [target(one, 'opponent', true)], { noSelector: true });
        }
    }
    if (shape.mode === 'optional-exhaust') {
        const dynamic = defs.find(e => roleDonor(e, 'dynamic-raid'));
        if (dynamic)
            for (const seat of [1, 2])
                add('numeric-zero-exhaust', seat, [{ code: dynamic.setCode, owner: 'opponent', zone: 'hand' }], { macro: 'numeric-zero', hostIndex: 0, hostFirst: true, waitBeforeSource: true });
    }
    if (shape.mode === 'other-friendly-aura') {
        const roles = Object.fromEntries(Object.keys(ROLE_SPECS).map(role => [role, defs.find(e => roleDonor(e, role))]));
        const shielded = donors.find(e => same(e.keywordValues, { shielded: 1 }) && e.card.arena === 'ground');
        const forceQuiet = donors.find(e => !Object.keys(e.keywordValues).length && e.card.arena === 'ground' && e.card.traits.includes('force'));
        const leader = defs.find(require('./parent-upgrade-probes').leaderHost);
        const beast = defs.find(require('./weakness-continuation-probes').nativeBeast);
        const pair = donors.find(e => same(e.keywordValues, { sentinel: 1, saboteur: 1 }) && e.card.arena === 'ground');
        if (!defs.some(require('./arena-damage-probes').nativeShield))
            obligation('missing-reviewed-shield', 'Reviewed native Shield dependency absent; Shield creation/consumption construction unavailable');
        if (!defs.some(require('./force-probes').nativeForce))
            obligation('missing-reviewed-force', 'Reviewed native Force dependency absent; actual Force lifecycle construction unavailable');
        if (!(entry.card.hp > 4 && entry.card.hp <= 8))
            obligation('source-departure-damage-budget', 'No bounded two-Damage4 normal source-departure construction for this printed HP');
        const hand = e => ({ code: e.setCode, owner: 'self', zone: 'hand' });
        const macro = (mode, seat, host, extras, extra = {}) => add(mode, seat, [{ ...host, ...(extra.hostDamage == null ? {} : { damage: extra.hostDamage }) }, ...extras.map(hand)], { macro: mode, hostIndex: 0, ...extra });
        for (const seat of [1, 2]) {
            if (entry.card.hp > 4 && entry.card.hp <= 8 && pair && roles['damage-two'] && roles['damage-four']) {
                for (const lethal of [false, true])
                    macro('source-departure-' + (lethal ? 'lethal' : 'survive'), seat, { ...target(pair, 'self', true), damage: pair.card.hp - 1 }, [...(lethal ? [roles['damage-two']] : []), roles['damage-four'], roles['damage-four']], { lethal, sourceDamageFromIndex: lethal ? 2 : 1 });
            }
            if (pair) {
                macro('later-entrant', seat, hand(pair), [], { hostLast: true });
                if (entry.card.unique) {
                    for (const keep of ['old', 'new'])
                        add('unique-keep-' + keep, seat, [target(pair, 'self', true), hand(entry)], { macro: 'unique-source', hostIndex: 0, oldIndex: 1, keep });
                }
            }
            if (two && roles['restore-upgrade'] && roles['saboteur-upgrade'])
                add('source-two-keywords', seat, [target(two, 'self', true), hand(roles['restore-upgrade']), hand(roles['saboteur-upgrade'])], { macro: 'source-two-keywords', hostIndex: 0, upgradeSource: true });
            if (leader && roles['raid-all'])
                add('deployed-leader-gain', seat, [{ code: leader.setCode, owner: 'self', leader: true, arena: 'ground', exhausted: true }, hand(roles['raid-all'])], { macro: 'deployed-leader-gain', hostIndex: 0, leaderCode: leader.setCode });
            if (beast && roles['restore-upgrade'] && roles['raid-all'])
                add('token-gain', seat, [{ code: beast.setCode, owner: 'self', token: 'beast', arena: 'ground', exhausted: true }, hand(roles['restore-upgrade']), hand(roles['raid-all'])], { macro: 'token-gain', hostIndex: 0 });
            if (shielded && roles['damage-two'] && defs.some(require('./arena-damage-probes').nativeShield)) {
                macro('shielded', seat, hand(shielded), [], { hostFirst: true });
                macro('shielded-consumed', seat, hand(shielded), [roles['damage-two']], { hostFirst: true });
            }
            if (roles['dynamic-raid'])
                macro('numeric-zero', seat, hand(roles['dynamic-raid']), [], { hostFirst: true, waitPhase: true });
            if (defs.some(require('./force-probes').nativeForce) && roles['force-sentinel'] && roles['restore-upgrade'] && roles['gain-force'] && roles['use-ready'] && roles.drain && roles['damage-two']) {
                const host = roles['force-sentinel'], devotion = roles['restore-upgrade'], gain = roles['gain-force'], use = roles['use-ready'];
                macro('mention', seat, hand(host), [devotion], { hostFirst: true });
                macro('force-gain', seat, hand(host), [devotion, gain], { hostFirst: true });
                macro('force-drain-lethal', seat, target(host, 'self', true), [devotion, roles.drain], { hostDamage: host.card.hp - 1 });
                macro('force-use-loss', seat, target(host, 'self', true), [gain, devotion, roles['damage-two'], use], { hostDamage: host.card.hp - 1, gainFirst: true });
                macro('force-gain-use-regain', seat, hand(host), [devotion, gain, use, gain], { hostFirst: true });
            }
            if (pair && roles['loss-name'] && roles['damage-two']) {
                for (const lethal of [false, true])
                    macro('loss-name-' + (lethal ? 'lethal' : 'survive'), seat, { ...target(pair, 'self', true), damage: pair.card.hp - 1 }, [...(lethal ? [roles['damage-two']] : []), roles['loss-name']], { lethal });
            }
            if (forceQuiet && roles['gain-pair'] && roles['damage-two']) {
                for (const lethal of [false, true])
                    macro('gain-stack-expire-' + (lethal ? 'lethal' : 'survive'), seat, { ...target(forceQuiet, 'self', true), damage: forceQuiet.card.hp - 1 }, [roles['gain-pair'], roles['gain-pair'], ...(lethal ? [roles['damage-two']] : [])], { lethal, waitPhase: true });
            }
        }
    }
    const gaps = ['full-source-review', 'controller-transfer', 'keyword-replacement-blanking', 'cost-bearing-keyword-instances', 'hidden-history-expiry', 'competing-death-triggers', 'capacity-overflow'];
    if (shape.mode === 'optional-exhaust')
        gaps.push('live-phase-gain-loss-selection', 'token-and-leader-exhaust-selection');
    for (const dimension of gaps)
        obligation(dimension, 'No actual terminal source-card construction for this further interaction; independent primitive/partial diagnostics do not establish whole-card coverage');
    return result;
}
module.exports = { classifyKeywordInventory, planKeywordInventoryProbes, literalUnit, coordinateUnit, roleDonor };
