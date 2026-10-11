'use strict';

/**
 * Generate a SYNTHETIC card-data folder for the forceteki engine, for machines where
 * `npm run get-cards` cannot reach admin.starwarsunlimited.com.
 *
 * Usage (from the repo root):
 *   node bot/tools/synth-cards.js [outDir]        # default: replays/.synth-cards (gitignored)
 *   const env = new Env('replays/.synth-cards')   # bot/env.js
 *
 * What it writes (same layout as forceteki/scripts/fetchdata.js writes into forceteki/test/json):
 *   Card/<internalName>.json, _cardMap.json, _setCodeMap.json, _allNonLeaderCardTitles.json,
 *   _playableCardTitles.json, _leaderNames.json, _mockCardNames.json, card-data-hash.txt
 *
 * Every card uses the real id/internalName of an implementation class in forceteki/build/server/game/cards,
 * so the engine runs the real ability code. Everything else (cost, power, hp, aspects, arena, traits,
 * set numbers) is invented: the cards are picked for having simple, self-contained abilities, and the
 * stats are plausible but NOT the printed ones. All cards live in a fake set 'SYN', so the viewer finds
 * no card art and falls back to stat tiles. Card text is rebuilt from each implementation's ability titles.
 *
 * card-data-hash.txt is copied from the engine build so LocalFolderCardDataGetter's hash check passes.
 */
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const engineRoot = path.join(repoRoot, 'forceteki');
const buildRoot = path.join(engineRoot, 'build', 'server');
const cardSrcRoot = path.join(engineRoot, 'server', 'game', 'cards');
const SET = 'SYN';

// ---------------------------------------------------------------------------------------------------
// Card table. Aspect shorthands: A aggression, C command, U cunning, V vigilance, H heroism, X villainy.
// ---------------------------------------------------------------------------------------------------

// [internalName, deployCost, deployedPower, deployedHp, aspects, traits]
const LEADERS = [
    ['director-krennic#aspiring-to-authority', 5, 3, 7, 'AX', ['imperial', 'official']],
    ['sabine-wren#galvanized-revolutionary', 5, 4, 5, 'AH', ['mandalorian', 'rebel', 'spectre']],
    ['kylo-ren#rash-and-deadly', 6, 7, 6, 'AX', ['force', 'first order', 'sith']],
    ['rey#more-than-a-scavenger', 5, 2, 7, 'AH', ['force', 'resistance']],
    ['chirrut-imwe#one-with-the-force', 5, 3, 5, 'VH', ['force', 'rebel']],
    ['grand-inquisitor#stories-travel-quickly', 5, 4, 5, 'VX', ['force', 'imperial', 'inquisitor']],
    ['darth-vader#dont-fail-me-again', 6, 5, 7, 'CX', ['force', 'imperial', 'sith']],
    ['chewbacca#relentless-rebel', 6, 5, 8, 'CH', ['rebel', 'wookiee']],
    ['jyn-erso#resisting-oppression', 5, 4, 5, 'UH', ['rebel']],
    ['general-grievous#separatist-warlord', 6, 4, 7, 'UX', ['separatist', 'droid', 'official']]
];

// [internalName, hp, aspects, traits]
const BASES = [
    ['jedi-temple', 30, 'V', ['coruscant']],
    ['crystal-caves', 28, 'V', ['ilum']],
    ['fortress-vader', 30, 'C', ['mustafar']],
    ['the-holy-city', 28, 'C', ['jedha']],
    ['nightsister-lair', 30, 'A', ['dathomir']],
    ['strangled-cliffs', 28, 'A', ['malachor']],
    ['shadowed-undercity', 30, 'U', ['coruscant']],
    ['starlight-temple', 28, 'U', ['starlight beacon']],
    ['security-complex', 25, 'V', ['scarif']],
    ['tarkintown', 25, 'U', ['jedha']]
];

// [internalName, cost, power, hp, arena, aspects, traits, extraKeywordLines?]
// Keyword lines become both card text and `keywords` (e.g. 'Sentinel', 'Raid 2').
const UNITS = [
    // neutral, non-unique: these alone are enough to fill any random deck
    ['patrolling-vwing', 1, 1, 1, 'space', '', ['republic', 'vehicle', 'fighter']],
    ['21b-surgical-droid', 1, 1, 3, 'ground', '', ['droid']],
    ['jedha-agitator', 2, 2, 1, 'ground', '', ['rebel', 'trooper']],
    ['vanguard-infantry', 2, 2, 3, 'ground', '', ['rebel', 'trooper']],
    ['seasoned-shoretrooper', 2, 2, 3, 'ground', '', ['imperial', 'trooper']],
    ['coruscant-dissident', 2, 2, 2, 'ground', '', ['republic']],
    ['warbird-stowaway', 2, 2, 2, 'space', '', ['underworld', 'vehicle', 'transport']],
    ['mining-guild-tie-fighter', 1, 1, 2, 'space', '', ['underworld', 'vehicle', 'fighter']],
    ['star-wing-scout', 2, 2, 2, 'space', '', ['rebel', 'vehicle', 'fighter']],
    ['clan-wren-rescuer', 2, 1, 3, 'ground', '', ['mandalorian']],
    ['rugged-survivors', 3, 3, 3, 'ground', '', ['rebel', 'trooper'], ['Sentinel']],
    ['outer-rim-headhunter', 3, 2, 3, 'space', '', ['underworld', 'vehicle', 'fighter']],
    ['rhokai-gunship', 3, 2, 3, 'space', '', ['underworld', 'vehicle']],
    ['valiant-assault-ship', 3, 3, 3, 'space', '', ['rebel', 'vehicle', 'transport']],
    ['incinerator-trooper', 3, 3, 2, 'ground', '', ['imperial', 'trooper']],
    ['kintan-intimidator', 3, 3, 3, 'ground', '', ['underworld', 'creature']],
    ['freetown-backup', 3, 3, 3, 'ground', '', ['fringe']],
    ['ardent-sympathizer', 3, 3, 3, 'ground', '', ['rebel']],
    ['outland-tie-vanguard', 3, 2, 3, 'space', '', ['imperial', 'vehicle', 'fighter']],
    ['concord-dawn-interceptors', 3, 2, 5, 'space', '', ['mandalorian', 'vehicle', 'fighter'], ['Sentinel']],
    ['disabling-fang-fighter', 3, 3, 2, 'space', '', ['mandalorian', 'vehicle', 'fighter']],
    ['principled-outlaw', 4, 4, 4, 'ground', '', ['fringe']],
    ['criminal-muscle', 4, 3, 5, 'ground', '', ['underworld']],
    ['guerilla-attack-pod', 4, 3, 5, 'ground', '', ['rebel', 'vehicle', 'walker']],
    ['imperial-interceptor', 4, 3, 3, 'space', '', ['imperial', 'vehicle', 'fighter']],
    ['gentle-giant', 4, 3, 7, 'ground', '', ['underworld', 'creature']],
    ['steadfast-battalion', 5, 5, 5, 'ground', '', ['rebel', 'trooper']],
    ['cantina-bouncer', 5, 4, 5, 'ground', '', ['underworld']],
    ['academy-defense-walker', 5, 5, 6, 'ground', '', ['imperial', 'vehicle', 'walker'], ['Sentinel']],
    ['atat-suppressor', 8, 8, 8, 'ground', '', ['imperial', 'vehicle', 'walker']],
    // aspect, non-unique
    ['reckless-gunslinger', 2, 2, 1, 'ground', 'A', ['underworld'], ['Raid 1']],
    ['ruthless-assassin', 3, 4, 2, 'ground', 'A', ['underworld', 'bounty hunter']],
    ['wild-rancor', 7, 8, 7, 'ground', 'A', ['creature']],
    ['distant-patroller', 2, 2, 1, 'space', 'V', ['rebel', 'vehicle', 'fighter']],
    ['cargo-juggernaut', 4, 3, 7, 'ground', 'V', ['underworld', 'vehicle']],
    ['bounty-hunter-crew', 5, 4, 4, 'ground', 'C', ['underworld', 'bounty hunter']],
    ['cartel-spacer', 2, 2, 3, 'space', 'U', ['underworld', 'vehicle', 'fighter']],
    // aspect, unique
    ['leia-organa#defiant-princess', 3, 2, 3, 'ground', 'CH', ['rebel', 'official']],
    ['yoda#old-master', 3, 2, 4, 'ground', 'VH', ['force', 'jedi'], ['Restore 2']],
    ['han-solo#reluctant-hero', 6, 6, 6, 'ground', 'UH', ['underworld', 'rebel']],
    ['chewbacca#pykesbane', 6, 6, 7, 'ground', 'AH', ['underworld', 'wookiee'], ['Overwhelm']],
    ['the-mandalorian#wherever-i-go-he-goes', 4, 4, 4, 'ground', 'UH', ['mandalorian', 'bounty hunter']],
    ['bright-hope#the-last-transport', 3, 2, 4, 'space', 'VH', ['rebel', 'vehicle', 'transport']],
    ['redemption#medical-frigate', 8, 5, 10, 'space', 'VH', ['rebel', 'vehicle', 'capital ship']],
    ['koska-reeves#loyal-nite-owl', 3, 3, 3, 'ground', 'A', ['mandalorian']],
    ['fennec-shand#loyal-sharpshooter', 4, 4, 3, 'ground', 'U', ['underworld', 'bounty hunter']],
    ['lom-pyke#dealer-in-truths', 4, 4, 4, 'ground', 'U', ['underworld']],
    ['count-dooku#darth-tyranus', 6, 5, 6, 'ground', 'CX', ['force', 'separatist', 'sith']],
    ['admiral-motti#brazen-and-scornful', 2, 1, 2, 'ground', 'X', ['imperial', 'official']],
    ['emperor-palpatine#master-of-the-dark-side', 8, 6, 8, 'ground', 'AX', ['force', 'imperial', 'sith']],
    ['devastator#inescapable', 9, 8, 9, 'space', 'VX', ['imperial', 'vehicle', 'capital ship']],
    ['supreme-leader-snoke#shadow-ruler', 7, 4, 7, 'ground', 'X', ['force', 'first order']]
];

// [internalName, cost, aspects, traits]
const EVENTS = [
    ['daring-raid', 1, '', ['tactic']],
    ['repair', 1, '', ['supply']],
    ['moment-of-peace', 1, '', ['innate']],
    ['tactical-advantage', 2, '', ['tactic']],
    ['smugglers-aid', 1, '', ['supply']],
    ['keep-fighting', 1, '', ['tactic']],
    ['disarm', 2, '', ['tactic']],
    ['surprise-strike', 2, '', ['tactic']],
    ['mission-briefing', 2, '', ['plan']],
    ['open-fire', 3, 'A', ['tactic']],
    ['make-an-opening', 2, 'A', ['tactic']],
    ['takedown', 4, 'V', ['tactic']],
    ['vanquish', 5, 'V', ['tactic']],
    ['confiscate', 1, 'V', ['tactic']],
    ['covert-strength', 2, 'C', ['innate']],
    ['moment-of-glory', 2, 'C', ['innate']],
    ['recruit', 1, 'C', ['plan']],
    ['waylay', 3, 'U', ['trick']],
    ['shoot-first', 1, 'U', ['trick']],
    ['no-bargain', 3, 'U', ['trick']],
    ['rivals-fall', 7, 'X', ['tactic']],
    ['fell-the-dragon', 5, 'H', ['tactic']],
    ['superlaser-blast', 8, 'VX', ['disaster']]
];

// [internalName, cost, upgradePower, upgradeHp, aspects, traits]
const UPGRADES = [
    ['entrenched', 2, 3, 3, '', ['condition']],
    ['armed-to-the-teeth', 2, 1, 1, '', ['item', 'weapon']],
    ['durasteel-plating', 2, 0, 2, '', ['modification']],
    ['old-access-codes', 1, 0, 0, '', ['item']],
    ['snapshot-reflexes', 2, 1, 1, 'C', ['innate']],
    ['ruthlessness', 2, 2, 0, 'A', ['innate']],
    ['heroic-bravery', 2, 1, 1, 'H', ['innate']],
    ['villainous-ambition', 2, 2, 0, 'X', ['innate']]
];

// token internal names required by CardDataGetter.getTokenCardsDataSync, with invented stats
const TOKENS = [
    { name: 'battle-droid', title: 'Battle Droid', types: ['token', 'unit'], power: 1, hp: 1, arena: 'ground', traits: ['separatist', 'droid', 'trooper'] },
    { name: 'clone-trooper', title: 'Clone Trooper', types: ['token', 'unit'], power: 2, hp: 2, arena: 'ground', traits: ['republic', 'clone', 'trooper'] },
    { name: 'tie-fighter', title: 'TIE Fighter', types: ['token', 'unit'], power: 1, hp: 1, arena: 'space', traits: ['imperial', 'vehicle', 'fighter'] },
    { name: 'xwing', title: 'X-Wing', types: ['token', 'unit'], power: 2, hp: 2, arena: 'space', traits: ['rebel', 'vehicle', 'fighter'] },
    { name: 'spy', title: 'Spy', types: ['token', 'unit'], power: 0, hp: 2, arena: 'ground', traits: ['official'] },
    { name: 'mandalorian', title: 'Mandalorian', types: ['token', 'unit'], power: 2, hp: 2, arena: 'ground', traits: ['mandalorian'] },
    { name: 'beast', title: 'Beast', types: ['token', 'unit'], power: 3, hp: 3, arena: 'ground', traits: ['creature'] },
    { name: 'experience', title: 'Experience', types: ['token', 'upgrade'], upgradePower: 1, upgradeHp: 1, traits: ['learned'] },
    { name: 'shield', title: 'Shield', types: ['token', 'upgrade'], upgradePower: 0, upgradeHp: 0, traits: ['armor'] },
    { name: 'advantage', title: 'Advantage', types: ['token', 'upgrade'], upgradePower: 1, upgradeHp: 0, traits: ['innate'] },
    { name: 'weakness', title: 'Weakness', types: ['token', 'upgrade'], upgradePower: -1, upgradeHp: -1, traits: ['condition'] },
    { name: 'the-force', title: 'The Force', types: ['token'], traits: [] },
    { name: 'credit', title: 'Credit', types: ['token'], traits: ['supply'] }
];

const ASPECT = { A: 'aggression', C: 'command', U: 'cunning', V: 'vigilance', H: 'heroism', X: 'villainy' };

// ---------------------------------------------------------------------------------------------------

function aspects(code) {
    return [...code].map((ch) => ASPECT[ch]);
}

function titleCase(slug) {
    return slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function titleOf(internalName) {
    const [title, subtitle] = internalName.split('#');
    return { title: titleCase(title), subtitle: subtitle ? titleCase(subtitle) : '' };
}

/** internalName -> TS source text, for every card implementation file (skips common/ like the engine loader does). */
function indexSources() {
    const out = new Map();
    const walk = (dir) => {
        for (const f of fs.readdirSync(dir)) {
            const p = path.join(dir, f);
            if (fs.statSync(p).isDirectory()) {
                if (f !== 'common') {
                    walk(p);
                }
            } else if (f.endsWith('.ts') && f !== 'Index.ts') {
                const src = fs.readFileSync(p, 'utf8');
                const m = src.match(/internalName:\s*'([^']+)'/);
                if (m) {
                    out.set(m[1], src);
                }
            }
        }
    };
    walk(cardSrcRoot);
    return out;
}

/** internalName -> id, read from the built engine's card classes (the same map the engine uses). */
function implementationIds() {
    process.env.NODE_ENV ??= 'test';
    const { cards } = require(path.join(buildRoot, 'game/cards/Index.js'));
    const out = new Map();
    for (const cls of cards.values()) {
        const impl = cls.prototype.getImplementationId();
        out.set(impl.internalName, impl.id);
    }
    return out;
}

const PREFIX = {
    addWhenPlayedAbility: 'When Played: ',
    addOnAttackAbility: 'On Attack: ',
    addWhenDefeatedAbility: 'When Defeated: ',
    addActionAbility: 'Action: ',
    setEpicActionAbility: 'Epic Action: ',
    addConstantAbility: '',
    setEventAbility: '',
    addConstantAbilityTargetingAttached: '',
    addTriggeredAbility: '',
    addGainOnAttackAbilityTargetingAttached: 'Attached unit gains: "On Attack - ',
    addGainWhenDefeatedAbilityTargetingAttached: 'Attached unit gains: "When Defeated - ',
    addGainTriggeredAbilityTargetingAttached: 'Attached unit gains: "',
    addGainConstantAbilityTargetingAttached: 'Attached unit gains: "'
};

function cleanTitle(raw) {
    return raw
        .replace(/\\'/g, '\'')
        .replace(/\$\{TextHelper\.resource\((\d+)\)\}/g, '[$1]')
        .replace(/\$\{TextHelper\.(?:Trait\.)?(\w+)\}/g, '$1')
        .replace(/\$\{[^}]*\}/g, '...');
}

/**
 * Rebuild readable card text from the implementation's ability titles. Prefixes such as 'When Played:' are only
 * emitted when the matching registrar call exists, so the engine's text-vs-ability validation always passes.
 */
function abilityText(src, section = null) {
    let body = src;
    if (section) {
        const start = body.indexOf(section);
        if (start < 0) {
            return '';
        }
        body = body.slice(start + section.length);
        const next = body.search(/protected override setupLeader\w*SideAbilities/);
        if (next >= 0) {
            body = body.slice(0, next);
        }
    }
    const lines = [];
    const re = /registrar\.(\w+)\(\{[\s\S]*?title:\s*(?:'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g;
    let m;
    while ((m = re.exec(body)) !== null) {
        const prefix = PREFIX[m[1]] ?? '';
        const title = cleanTitle(m[2] ?? m[3]);
        lines.push(prefix + title + (prefix.includes('"') ? '"' : ''));
    }
    if (!lines.length) {
        // ability props built by a helper method (e.g. Krennic): fall back to the first title in the file, unprefixed
        const t = src.match(/title:\s*(?:'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/);
        if (t) {
            lines.push(cleanTitle(t[1] ?? t[2]));
        }
    }
    return lines.join('\n');
}

function keywordData(lines = []) {
    return { keywords: lines.map((l) => l.split(' ')[0].toLowerCase()), text: lines.join('\n') };
}

function joinText(...parts) {
    return parts.filter((p) => p).join('\n');
}

function build(outDir) {
    const sources = indexSources();
    const ids = implementationIds();
    const cards = [];
    let number = 0;

    const base = (internalName, extra) => {
        const id = ids.get(internalName);
        if (!id) {
            throw new Error(`No implementation class found for '${internalName}'`);
        }
        const { title, subtitle } = titleOf(internalName);
        const setId = { set: SET, number: ++number };
        return {
            title, subtitle, cost: null, hp: null, power: null, text: '', deployBox: null, epicAction: '', unique: false,
            rules: null, upgradePower: null, upgradeHp: null, id, aspects: [], traits: [], keywords: [], types: [],
            setId, setCodes: [setId], internalName, arena: null, ...extra
        };
    };

    for (const [name, cost, power, hp, asp, traits] of LEADERS) {
        const src = sources.get(name) ?? '';
        cards.push(base(name, {
            cost, power, hp, aspects: aspects(asp), traits, types: ['leader'], unique: true, arena: 'ground',
            text: abilityText(src, 'setupLeaderSideAbilities'),
            deployBox: abilityText(src, 'setupLeaderUnitSideAbilities')
        }));
    }
    for (const [name, hp, asp, traits] of BASES) {
        const src = sources.get(name) ?? '';
        // the LOF Force bases share their ability through a common/ superclass, so their own file has no titles
        const text = src.includes('LofCommonForceBase') ? 'When a friendly Force unit attacks: The Force is with you' : abilityText(src);
        cards.push(base(name, { hp, aspects: aspects(asp), traits, types: ['base'], text }));
    }
    for (const [name, cost, power, hp, arena, asp, traits, kw] of UNITS) {
        const k = keywordData(kw);
        cards.push(base(name, {
            cost, power, hp, arena, aspects: aspects(asp), traits, types: ['unit'], unique: name.includes('#'),
            keywords: k.keywords, text: joinText(k.text, abilityText(sources.get(name) ?? ''))
        }));
    }
    for (const [name, cost, asp, traits] of EVENTS) {
        cards.push(base(name, { cost, aspects: aspects(asp), traits, types: ['event'], text: abilityText(sources.get(name) ?? '') }));
    }
    for (const [name, cost, upgradePower, upgradeHp, asp, traits] of UPGRADES) {
        cards.push(base(name, {
            cost, upgradePower, upgradeHp, power: upgradePower, hp: upgradeHp, aspects: aspects(asp), traits,
            types: ['upgrade'], unique: name.includes('#'), text: abilityText(sources.get(name) ?? '')
        }));
    }
    for (const t of TOKENS) {
        const id = ids.get(t.name);
        if (!id) {
            throw new Error(`No implementation class found for token '${t.name}'`);
        }
        const isUpgrade = t.types[1] === 'upgrade';
        cards.push({
            title: t.title, subtitle: '', cost: 0, hp: isUpgrade ? t.upgradeHp : t.hp ?? null, power: isUpgrade ? t.upgradePower : t.power ?? null,
            text: '', deployBox: null, epicAction: '', unique: false, rules: null,
            upgradePower: isUpgrade ? t.upgradePower : null, upgradeHp: isUpgrade ? t.upgradeHp : null,
            id, aspects: [], traits: t.traits, keywords: [], types: t.types, setId: { set: SET }, internalName: t.name, arena: t.arena ?? null
        });
    }

    // index files, built the same way as fetchdata.js buildCardLists()
    const cardMap = [];
    const setCodeMap = {};
    const nonLeaderTitles = new Set();
    const playableTitles = new Set();
    const leaderNames = [];
    for (const c of cards) {
        cardMap.push({ id: c.id, internalName: c.internalName, title: c.title, subtitle: c.subtitle, cost: c.cost });
        const isToken = c.types.includes('token');
        const code = isToken ? null : `${c.setId.set}_${String(c.setId.number).padStart(3, '0')}`;
        if (code) {
            setCodeMap[code] = c.id;
        }
        if (c.types.includes('leader')) {
            leaderNames.push({ name: c.title, id: code, subtitle: c.subtitle });
        } else {
            nonLeaderTitles.add(c.title);
            if (!isToken && !c.types.includes('base')) {
                playableTitles.add(c.title);
            }
        }
    }

    fs.mkdirSync(path.join(outDir, 'Card'), { recursive: true });
    for (const c of cards) {
        fs.writeFileSync(path.join(outDir, 'Card', `${c.internalName}.json`), JSON.stringify(c, null, 2));
    }
    const write = (file, data) => fs.writeFileSync(path.join(outDir, file), JSON.stringify(data, null, 2));
    write('_cardMap.json', cardMap);
    write('_setCodeMap.json', setCodeMap);
    write('_allNonLeaderCardTitles.json', [...nonLeaderTitles].sort());
    write('_playableCardTitles.json', [...playableTitles].sort());
    write('_leaderNames.json', leaderNames);
    write('_mockCardNames.json', []);
    fs.copyFileSync(path.join(buildRoot, 'card-data-hash.txt'), path.join(outDir, 'card-data-hash.txt'));

    return {
        leaders: LEADERS.length, bases: BASES.length, units: UNITS.length, events: EVENTS.length,
        upgrades: UPGRADES.length, tokens: TOKENS.length, total: cards.length
    };
}

if (require.main === module) {
    const outDir = path.resolve(process.argv[2] ?? path.join(repoRoot, 'replays', '.synth-cards'));
    const counts = build(outDir);
    console.log(`synthetic card data written to ${outDir}`);
    console.log(JSON.stringify(counts));
}

module.exports = { build };
