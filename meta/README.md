# Meta-analyzer (Strategy Atlas)

Studies every bot in the project and draws one page that shows, at a glance, which bot wins in which game spot and how
each one plays. It reads only recorded results, so it needs no engine or card data.

| file | what |
|---|---|
| `analyze.js` | reads `results/*/index.json` and every replay; writes `meta.json` (`swu-meta/1`) |
| `page.html` | the page template; `build-page.js` inlines `meta.json`, `theory.json` and the shared viewer kit |
| `panel.js` | writes the research dashboard panel `dashboard/panels/meta-analyzer.json` |
| `refresh.sh` | one refresh: analyze, build the page, write the panel (outputs in `/mnt/project-files/meta/`) |
| `shoot.js` | Playwright screenshots for review: desktop light/dark, phone, first screen, readable tiles |
| `quiz.js`, `grade.js` | a quiz with an answer key built from the data, and a grader for reviewer answers |
| `review-prompt.md`, `review-prompts.js` | reviewer instructions for three personas (glance, analyst, phone) |

## The model

- **Spot**: a round start seen from one player (base HP left on both sides, board power, units' HP, hand size,
  resources, initiative). A game enters a spot at the first round start where its test holds (see `SITUATIONS`).
- **Average bot**: a logistic regression of P(win) on those features plus the rating gap, fitted on every round start,
  then evaluated as if the bot were rated 1500. A cell's **edge** is (wins − average-bot wins − field misfit) / (n + 4):
  points of win chance above an average bot in the same spot against the same opponents. The field misfit term removes
  the linear model's error in the tails, so cells compare bots with each other.
- **vsOwn**: the same with the bot's own rating, so a bot's best and worst spot are relative to its own level.
- **Style**: per round, from board changes during the bot's own decisions: base damage, units removed, units added,
  attacks and the share aimed at the base, passes, initiative claims.
- **Ratings**: Bradley-Terry over every finished game (`bot/ratings.js`); a `TIME_FORFEIT` is a loss for the slow bot.
- **Names**: `random-a/b/c` are one bot; `legacy` is the old heuristic; in runs that include `legacy`, the heuristic
  profiles carry the base-danger sign fix and get a `+fix` suffix. So do runs listed in `FIXED_ERA_RUNS` or marked
  `fixedEra: true` in index.json or ladder.json config (fixed-profile runs made without `legacy`).
- **Humans**: real karabast.net games imported by `importer/import.js` into `--human` (default
  `/mnt/project-files/human-games/<source>/index.json` + `games/<id>.jsonl`). Players are anonymous and only play each
  other, so they stay out of the ratings and the baseline fit. Both seats count as one competitor, `humans`, scored
  like an average bot facing an equal opponent (rd 0). The page shows it beside the bots (tiles, grid, face-off),
  never ranked among them.

## Review cycle

Each page version is screenshotted and handed to three fresh reviewers who see only the images: a 45-second glance at
the first screen, a careful analyst on desktop, and a phone reader. They answer a quiz whose key comes from the data,
give their one-line takeaway, and list what confused them. `theory.json` records each version's idea, what changed and
its quiz score; the page shows that log at the bottom.

```bash
P=/mnt/project-files; S=<scratch dir>
meta/refresh.sh $P
node meta/shoot.js $P/meta/atlas.html $S/shots/vN
node meta/quiz.js $P/meta/meta.json $S/shots/vN/quiz.json
node meta/review-prompts.js $S/shots/vN     # then one reviewer agent per prompt-*.txt
node meta/grade.js $S/shots/vN/quiz.json $S/shots/vN/answers-*.json
```
