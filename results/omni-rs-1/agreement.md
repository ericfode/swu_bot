# Matched endgame results

All 66 windows proved by both implementations have the same winner. Of 103 matched windows, JS proved 66 and Rust proved 102. The only Rust unknown was aggro-vs-control-108, window 64, eight windows from the end, after its 6859 ms budget. The winner can differ between adjacent windows because these are positions from imperfect bot play.

JS defaults on deeper prompts and resourcing; Rust branches on all consequential choices. This sample has no disagreements to explain and does not establish that the move models are equivalent.

| Game | Window index | Windows from end | JS winner | Rust winner |
|---|---:|---:|---|---|
| aggro-vs-control-101 | 167 | 3 | p2 | p2 |
| aggro-vs-control-101 | 168 | 2 | p2 | p2 |
| aggro-vs-control-101 | 169 | 1 | p2 | p2 |
| aggro-vs-control-102 | 48 | 6 | p1 | p1 |
| aggro-vs-control-102 | 50 | 4 | p1 | p1 |
| aggro-vs-control-102 | 51 | 3 | p1 | p1 |
| aggro-vs-control-102 | 52 | 2 | p1 | p1 |
| aggro-vs-control-102 | 53 | 1 | p1 | p1 |
| aggro-vs-control-103 | 41 | 4 | p1 | p1 |
| aggro-vs-control-103 | 42 | 3 | p1 | p1 |
| aggro-vs-control-103 | 43 | 2 | p1 | p1 |
| aggro-vs-control-103 | 44 | 1 | p1 | p1 |
| aggro-vs-control-104 | 37 | 7 | p1 | p1 |
| aggro-vs-control-104 | 38 | 6 | p1 | p1 |
| aggro-vs-control-104 | 39 | 5 | p1 | p1 |
| aggro-vs-control-104 | 40 | 4 | p1 | p1 |
| aggro-vs-control-104 | 41 | 3 | p1 | p1 |
| aggro-vs-control-104 | 42 | 2 | p1 | p1 |
| aggro-vs-control-104 | 43 | 1 | p1 | p1 |
| aggro-vs-control-105 | 36 | 3 | p1 | p1 |
| aggro-vs-control-105 | 37 | 2 | p1 | p1 |
| aggro-vs-control-105 | 38 | 1 | p1 | p1 |
| aggro-vs-control-106 | 49 | 3 | p1 | p1 |
| aggro-vs-control-106 | 50 | 2 | p1 | p1 |
| aggro-vs-control-106 | 51 | 1 | p1 | p1 |
| aggro-vs-control-107 | 35 | 10 | p1 | p1 |
| aggro-vs-control-107 | 37 | 8 | p1 | p1 |
| aggro-vs-control-107 | 39 | 6 | p1 | p1 |
| aggro-vs-control-107 | 41 | 4 | p1 | p1 |
| aggro-vs-control-107 | 42 | 3 | p1 | p1 |
| aggro-vs-control-107 | 43 | 2 | p1 | p1 |
| aggro-vs-control-107 | 44 | 1 | p1 | p1 |
| aggro-vs-control-108 | 66 | 6 | p1 | p1 |
| aggro-vs-control-108 | 67 | 5 | p1 | p1 |
| aggro-vs-control-108 | 68 | 4 | p1 | p1 |
| aggro-vs-control-108 | 69 | 3 | p1 | p1 |
| aggro-vs-control-108 | 70 | 2 | p1 | p1 |
| aggro-vs-control-108 | 71 | 1 | p1 | p1 |
| tempo-vs-rush-101 | 103 | 3 | p2 | p2 |
| tempo-vs-rush-101 | 104 | 2 | p2 | p2 |
| tempo-vs-rush-101 | 105 | 1 | p2 | p2 |
| tempo-vs-rush-102 | 78 | 4 | p1 | p1 |
| tempo-vs-rush-102 | 79 | 3 | p1 | p1 |
| tempo-vs-rush-102 | 80 | 2 | p1 | p1 |
| tempo-vs-rush-102 | 81 | 1 | p1 | p1 |
| tempo-vs-rush-103 | 58 | 3 | p1 | p1 |
| tempo-vs-rush-103 | 59 | 2 | p1 | p1 |
| tempo-vs-rush-103 | 60 | 1 | p1 | p1 |
| tempo-vs-rush-104 | 45 | 8 | p1 | p1 |
| tempo-vs-rush-104 | 46 | 7 | p1 | p1 |
| tempo-vs-rush-104 | 47 | 6 | p1 | p1 |
| tempo-vs-rush-104 | 48 | 5 | p1 | p1 |
| tempo-vs-rush-104 | 49 | 4 | p1 | p1 |
| tempo-vs-rush-104 | 50 | 3 | p1 | p1 |
| tempo-vs-rush-104 | 51 | 2 | p1 | p1 |
| tempo-vs-rush-104 | 52 | 1 | p1 | p1 |
| tempo-vs-rush-105 | 57 | 3 | p1 | p1 |
| tempo-vs-rush-105 | 59 | 1 | p1 | p1 |
| tempo-vs-rush-106 | 81 | 1 | p1 | p1 |
| tempo-vs-rush-107 | 45 | 4 | p2 | p2 |
| tempo-vs-rush-107 | 46 | 3 | p1 | p1 |
| tempo-vs-rush-107 | 47 | 2 | p1 | p1 |
| tempo-vs-rush-107 | 48 | 1 | p1 | p1 |
| tempo-vs-rush-108 | 75 | 3 | p2 | p2 |
| tempo-vs-rush-108 | 76 | 2 | p2 | p2 |
| tempo-vs-rush-108 | 77 | 1 | p2 | p2 |

## Greatest proved distance by game

| Game | JS | Rust |
|---|---:|---:|
| aggro-vs-control-101 | 3 | 5 |
| aggro-vs-control-102 | 6 | 8 |
| aggro-vs-control-103 | 4 | 6 |
| aggro-vs-control-104 | 7 | 9 |
| aggro-vs-control-105 | 3 | 5 |
| aggro-vs-control-106 | 3 | 5 |
| aggro-vs-control-107 | 10 | 12 |
| aggro-vs-control-108 | 6 | 7 |
| tempo-vs-rush-101 | 3 | 5 |
| tempo-vs-rush-102 | 4 | 6 |
| tempo-vs-rush-103 | 3 | 5 |
| tempo-vs-rush-104 | 8 | 10 |
| tempo-vs-rush-105 | 3 | 5 |
| tempo-vs-rush-106 | 1 | 3 |
| tempo-vs-rush-107 | 4 | 6 |
| tempo-vs-rush-108 | 3 | 5 |
| Mean | 4.4375 | 6.375 |
| Maximum | 10 | 12 |

Rust reaches the earliest sampled window in 15 of 16 games. These results are right-censored by JS's two-unknown stopping rule, and are a lower bound on Rust's reach within this sample. The distance is measured against the recorded game's end, not the length of the proving line. [All 103 Rust output rows with JS winner, actual per-window budget, depth, nodes, and elapsed time](proof-results.jsonl).
