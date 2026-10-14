# c-clock

A Star Wars Unlimited bot in C (C11 plus POSIX `getline`, libc only). The engine stays in JS: `bot/players/external.js`
runs forceteki and talks to this process over the stdio JSON Lines protocol in `spec/stdio-protocol.md`.

    make -C bot/c                                   # builds bot/c/swu-c
    node bot/tournament.js --bots c-clock,node-random --games 2 --out replays/c-check   # protocol check
    node bot/ladder.js --bots c-clock,rush --games 10
    SWU_C_DEBUG=1 node bot/tournament.js --bots c-clock,rush --games 1 --out replays/c   # decisions on stderr

Registered as `c-clock` (`"lang": "c"`) in `bot/external-bots.json`. Card data is read at start from
`$SWU_CARD_JSON/Card/*.json` (default `forceteki/test/json`, about 2,500 files in ~0.1 s). Without it the bot still
plays on the board stats the protocol sends.

## Strategy: who is the beatdown?

Each action window it works out both race clocks: how many rounds each side needs to destroy the other base with the
power it has on the board. If its clock is faster it plays **beatdown** (base damage is worth 1.15 per point); if
slower it plays **control** (0.7 per point, so trades and removal win). Base damage gets worth more as the enemy base
gets low.

Order of play in a window:

1. **Lethal**: if the unblocked power on board is enough to finish the base, attack face.
2. **Deploy the leader** once there are enough resources (a free unit that arrives ready).
3. **Attacks that kill** an enemy unit and come out ahead, best first.
4. **Helpful upgrades** onto its units before they attack.
5. **Other attacks** worth making (face or a good trade).
6. **Hand cards** chosen by a knapsack over ready resources (most value for the resources), most expensive first.
7. The leader's action ability, then any other clickable card.
8. **Claim the initiative** (or pass).

Attacks use combat math on the card data: raid, shields (and saboteur popping them), sentinel, overwhelm, restore,
and the defender's counter-damage. A unit is worth `1.3 power + 0.6 HP left + 0.35 cost` plus keyword and token
bonuses; a kill earns that worth, a lost attacker costs it, and chip damage earns half of it pro rata.

Outside the action window: keeps a hand with a cheap unit; resources the card least likely to be cast soon (expensive,
off-aspect) until about 6 to 9 resources; reads each target prompt's text to tell harmful effects (damage, defeat,
exhaust, capture, -N/-N) from helpful ones (heal, shield, +N/+N, experience, ready) and picks the best enemy or own
unit; splits distributed damage to kill the most valuable units first, healing onto its most valuable damaged units.
A pick that leaves the window unchanged (a play that got cancelled) is banned for the rest of the round.

## c-clock2 (`--v2`)

`bot/c/swu-c --v2`, registered as `c-clock2`, adds two fixes found in the games against people on Karabast
(analysis/karabast/README.md): a leader that can deploy as a Pilot does so, onto its best Vehicle (Luke Skywalker, Hero
of Yavin, was always deployed as a plain 5/6 ground unit), and a unique card is never played while it already controls a
copy (a unit or an upgrade such as a pilot); such copies, then spare copies in hand, are resourced first. `--pilot` and
`--unique` turn on one fix each. Without a flag the bot plays exactly as before, so c-clock stays the reference of the
standard test.

## c-clock3 (`--v3`)

`bot/c/swu-c --v3`, registered as `c-clock3`, is c-clock2 plus one more fix from the Karabast games: it plays its events.
c-clock2 resourced almost every event it drew (Hotshot Maneuver: 0 plays in 264 games, Aggressive Negotiations: 1 in
209), because the resource choice ranked events below every unit and an event that attacks lost to the plain attack it
replaces. Now an event is kept like a small unit; an event that attacks ("Attack with a unit", Hotshot Maneuver's
"Then, attack with that unit") is played before the plain attack when a ready unit would attack anyway; Hotshot
Maneuver picks the unit with the most On Attack abilities; and an event whose condition fails now (System Shock with no
upgrade or token on an enemy unit, Air Superiority without more space units) is not played. `--events` turns on only
this fix.

## c-clock2m (`--v2 --mull`)

`--mull` mulligans a hand with no unit it can play in round 1 (cost 2 or less after the aspect penalty); before, a unit of
cost 3 was enough to keep. Against people on Karabast c-clock2 kept such a hand in 8% of its games and won 13% of them,
against 32% of the rest, while it mulliganed 2% of its hands and the people 37%. The mulligan costs nothing, and a new
six from the Luke deck holds such a unit 91% of the time. `c-clock2m` is c-clock2 with this fix: +2.5 points on the Luke
deck test [+0.8, +4.2] (8 games changed, all to wins), +0.8 on the standard test [−0.7, +2.2] (52.0% against c-clock2's
51.2%).

## c-clock2me (`--v2 --mull --epic`)

`--epic`: a leader deploys once a game (an Epic Action), so once it has deployed the bot never clicks it "to deploy"
again. After Luke's leader unit was defeated, c-clock2 kept clicking Luke to deploy at the start of every action window.
The click only offers Luke's action ("If you attacked with a Fighter unit this phase, deal 1 damage to a unit"), which
does nothing before a Fighter has attacked, so it was cancelled and banned for the round. On Karabast it then pinged in
9 of 247 such rounds, against 94% of the rounds before Luke deployed. Now the action comes after the attacks, as before
the deploy. Bot games rarely get there: the Luke deck test changed no game, and the standard test gives +0.3 over
c-clock2m [−0.5, +1.1] (52.4%).

## Files

- `bot.c`: protocol loop, observation parsing, the strategy.
- `cards.c`: card data loader and lookups by set code, internal name and title.
- `json.c`: a small in-place JSON parser with an arena allocator.
