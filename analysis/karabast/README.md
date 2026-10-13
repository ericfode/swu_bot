# Learning from our bot's games against people on Karabast

The live bot plays quick matches on karabast.net (`bot/karabast/queue.js`; the runs live on the Karabast Sprite under
`~/karabast/runs/<run>/`, frames already scrubbed). These scripts turn those runs into replays, count what went wrong in
the lost games, ask bots again at the same decisions, and test a fix on the deck the live bot plays.

```bash
node analysis/karabast/games.js --runs <folder of q-* runs> --out <dir>          # replays + index.json
node analysis/karabast/losses.js --games <dir> [--json facts.json]               # loss summary
node analysis/karabast/redecide.js --bots c-clock,c-clock2 --out d.jsonl <run>/frames/*.jsonl
node analysis/karabast/deck-test.js --deck luke-skywalker_jtl_data-vault --bots c-clock,c-clock2 --out t.jsonl
node analysis/karabast/deck-test.js --summary t-*.jsonl                          # join shards (--shard i/n)
bash analysis/karabast/fetch.sh <dir>                                            # every run from the Sprite -> <dir>/runs
node analysis/karabast/review.js --games <dir> [--since <ISO>] [--json r.json]   # strategy review: each bot's record and play facts
```

The strategy review runs every 4 hours (fetch, games.js, review.js); its outputs and the replays are kept in
`/mnt/project-files/karabast-bot-games/`. Opponents get stronger or weaker with the time of day, so review.js also splits
each bot's record by 6-hour UTC block: compare bots within a block.

Opponents' names are never read: they live in a separate file on the Sprite (bot/karabast/README.md, "Watch a game").

## What 159 games said (2026-10-11 19:15 to 2026-10-12 05:52 UTC)

c-clock with `luke-skywalker_jtl_data-vault` won 55 and lost 104. 144 games reached round 2 (40 won, 104 lost); 103 of
the losses ended with our base destroyed, mostly in rounds 5 and 6. The same bot and deck win about 75% against c-clock
on the 27 real decks, so people beat it much more than bots do.

- **The leader was never deployed as a Pilot.** Luke Skywalker (Hero of Yavin) can deploy as a 5/6 ground unit with no
  keywords, or as a Pilot on a Vehicle: +4/+5, a leader unit that enemy card abilities can't defeat the upgrade of, and
  "On Attack: deal 3 damage to a unit" on a Fighter. c-clock always took the first "Deploy" button: 120 of 120 deploys as
  the plain unit. 57 of those were defeated again, 37 in the round they came down.
- **Unique cards played while a copy was in play.** 33 times in 29 games the uniqueness rule defeated one copy at once:
  a card and about 3 resources lost each time (Red Five 7, R2-D2 6, Blue Leader 6, Black One 5, ...). The deck runs 3
  copies of 7 unique units, and c-clock's play and resource choices ignored uniqueness.
- **People remove, heal and hit harder.** In lost games the opponent made 4.8 removal plays per game (2.9 in won games),
  healed 3.4 damage from their base (1.2), and attacked our base more often and harder: 8.9 base attacks per game of 3.6
  damage each, against our 6.7 of 2.8 (counted until the next action, since an attack with an On Attack prompt resolves
  over two steps; the first count, 2.9 against 2.1, read only the attack's own step). At the start of
  round 5 of a lost game our base had taken 15.8 damage and theirs 8.7, with about the same power on both boards.

## The fix: c-clock2

`bot/c/swu-c --v2` (registered as `c-clock2`): a leader with a Pilot deploy takes it, onto its best Vehicle; a unique
card is not played while I control a copy (a unit, or an upgrade such as a pilot), and such copies, then spare copies in
hand, are resourced first. `--pilot` and `--unique` turn on one fix each.

| test | c-clock | c-clock2 |
|---|---|---|
| standard test (`npm run realdeck:test -- --bot c-clock2`, 702 games, 27 decks) | ref | 51.2% [47.5, 55.0] |
| Luke deck vs c-clock on the 27 decks (`deck-test.js`, 324 games each, paired) | 74.4% | 85.0% (+10.6 points [+6.4, +14.9]) |
| same, Pilot fix only / unique fix only | | +7.8 [+4.1, +11.5] / +2.8 [+0.2, +5.5] |

`redecide.js` on the 159 recorded games: c-clock2 takes the Pilot deploy at all 104 deploy menus that offered it and
resources unique copies instead of other cards.
