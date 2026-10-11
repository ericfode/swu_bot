/* Card data from the engine's card JSON (forceteki/test/json/Card/<name>.json), looked up by set code, internal name or title. */
#ifndef SWU_CARDS_H
#define SWU_CARDS_H

enum { ASP_VIGILANCE, ASP_COMMAND, ASP_AGGRESSION, ASP_CUNNING, ASP_VILLAINY, ASP_HEROISM, ASP_N };

enum {
    T_UNIT = 1, T_EVENT = 2, T_UPGRADE = 4, T_LEADER = 8, T_BASE = 16, T_TOKEN = 32
};

enum {
    K_SENTINEL = 1 << 0, K_RAID = 1 << 1, K_OVERWHELM = 1 << 2, K_AMBUSH = 1 << 3, K_RESTORE = 1 << 4,
    K_SABOTEUR = 1 << 5, K_HIDDEN = 1 << 6, K_SHIELDED = 1 << 7, K_GRIT = 1 << 8, K_PILOTING = 1 << 9,
    K_SMUGGLE = 1 << 10, K_BOUNTY = 1 << 11, K_PLOT = 1 << 12, K_SUPPORT = 1 << 13, K_COORDINATE = 1 << 14,
    K_EXPLOIT = 1 << 15, K_FORTIFY = 1 << 16
};

typedef struct Card {
    char *title, *internal, *text;
    int cost, power, hp;
    int upPower, upHp;   /* upgrade modifiers, 0 when absent */
    int types;           /* T_* */
    unsigned kw;         /* K_* (printed keywords) */
    int raid, restore;   /* amounts parsed from the text */
    int space;           /* 1 = space arena unit */
    int aspects[ASP_N];  /* aspect icon counts */
    int unique;
} Card;

/* Loads every card file in `dir` (the Card folder). Returns the number of cards, or -1 if the folder can't be read. */
int cards_load(const char *dir);
const Card *card_by_set(const char *set);       /* "SOR_095" */
const Card *card_by_internal(const char *name); /* "luke-skywalker#faithful-friend" */
const Card *card_by_title(const char *title);   /* first card with that title */

#endif
