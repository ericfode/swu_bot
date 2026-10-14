/*
 * c-clock: a Star Wars Unlimited bot in C over the stdio protocol (spec/stdio-protocol.md).
 *
 * Strategy: "who's the beatdown?". Every action window it compares the two race clocks (rounds each side needs to
 * kill the other base with the units on the board). When it wins the race it values base damage highly and swings
 * face; when it loses the race it values trades and removal and plays control. Attacks are scored with combat math
 * (shields, saboteur, overwhelm, raid, sentinel, counter-damage) on the card data from the engine's JSON. Order per
 * window: lethal, deploy leader, attacks that kill, upgrades on ready units, other good attacks, then the hand cards
 * picked by a knapsack over ready resources (most expensive first), then claim the initiative.
 *
 * stdout carries protocol lines only; set SWU_C_DEBUG=1 to log decisions to stderr.
 */
#include "cards.h"
#include "json.h"

#include <ctype.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAXU 96
#define MAXC 160
#define KEYLEN 256

static int debug;
/* --v2 (c-clock2): lessons from the games against people on Karabast (2026-10-12). A leader that can deploy as a Pilot
   deploys onto a Vehicle, and a unique card is never played while I already control a copy (the uniqueness rule would
   defeat one at once); such copies are resourced first. */
static int v2, pilotFix, uniqueFix; /* --v2 = both fixes; --pilot and --unique turn on one each */
/* --v3 (c-clock3): --v2, and the deck's events get played (2026-10-13). Against people c-clock2 resourced almost every
   event it drew (Hotshot Maneuver: 0 plays in 264 games, Aggressive Negotiations: 1 in 209), because keep_value ranked
   events below every unit and an event that attacks lost to the plain attack it replaces. Now events are kept like small
   units, an event that attacks goes before the plain attack, Hotshot Maneuver picks the unit with the most On Attack
   abilities, and an event whose condition fails (no enemy upgrade to defeat, not more space units) is not played.
   --events turns on only this. */
static int v3, eventsFix;
/* --mull: mulligan a hand with no unit I can play in round 1 (cost 2 or less). Against people on Karabast c-clock2 kept
   such a hand in 8% of its games (it asked only for a unit of cost 3) and won 13% of them, against 32% of the rest;
   it mulliganed 2% of its hands, the people 37%. The mulligan is free: a new six from this deck holds such a unit 91%
   of the time. */
static int mullFix;
/* --epic: a leader deploys once a game (an Epic Action), so once it has deployed it is never clicked to deploy again.
   After its leader unit was defeated, c-clock2 kept clicking Luke Skywalker "to deploy" at the start of every action
   window; the click only offers Luke's action ("If you attacked with a Fighter unit this phase, deal 1 damage to a
   unit"), which does nothing before a Fighter has attacked, so it was cancelled and banned for the round. On Karabast it
   then pinged in 9 of 247 such rounds, against 94% of the rounds before Luke deployed. */
static int epicFix;

/* ---------- observation ---------- */

typedef struct {
    const char *id, *n, *s;
    const Card *c;
    int p, h, d, x, sn;
    int shields, ups, toks; /* Shield tokens, non-token upgrades, other tokens (Experience, Advantage, ...) */
    int space, side, leader;
    const Card *upc[8]; /* non-token upgrades on the unit (pilots included) */
    int nupc;
} Unit;

typedef struct {
    const char *id, *n, *s;
    const Card *c;
    int x;
} Ref;

typedef struct {
    const char *baseId;
    int baseHp, baseD;
    const Card *baseCard;
    const char *leaderId;
    const Card *leaderCard;
    int leaderDep, leaderX;
    int resReady, resTotal, handCount, deck;
    Ref hand[MAXC];
    int nhand;
    Ref res[MAXC];
    int nres;
    int ndiscard;
} Side;

typedef struct {
    int round, initiative; /* initiative: 0 me, 1 opponent, -1 nobody */
    const char *phase;
    Side s[2];
    Unit u[MAXU];
    int nu;
} State;

typedef struct {
    int i;
    const char *kind, *label, *cardUuid;
    const JVal *arg;
    const char *cid, *cn, *cs, *zone;
    int ctl; /* 0 me, 1 opponent, -1 none */
    const JVal *dist;
} Act;

typedef struct {
    const char *title, *ptitle, *sig, *type, *mode;
    int aw, nselected;
    const JVal *selected;
    char low[1024]; /* title + " " + promptTitle, lower case */
    char tl[1024];  /* title only, lower case */
} Prompt;

/* ---------- per-game memory ---------- */

static struct {
    char me[8];
    int asp[ASP_N]; /* my aspect icons (leader + base) */
    int aspReady;
    /* loop guard: an action window that comes back unchanged means the last pick was a no-op */
    unsigned long long lastFp;
    int lastRound;
    char lastKey[KEYLEN];
    char banned[64][KEYLEN];
    int nbanned, bannedRound;
    int deployedOnce; /* --epic: my leader has used its deploy */
    /* what the last action-window click was for */
    char intent[16];
    char attacker[64];
    /* multi-select and stuck-prompt tracking */
    char promptKey[KEYLEN];
    int promptRepeats;
    int displayClicks;
} G;

static void reset_game(void) {
    memset(&G, 0, sizeof G);
    G.lastRound = -1;
    G.bannedRound = -1;
}

/* ---------- small helpers ---------- */

static int imax(int a, int b) { return a > b ? a : b; }
static int imin(int a, int b) { return a < b ? a : b; }

static int has(const char *hay, const char *needle) { return hay && strstr(hay, needle) != NULL; }

static int starts(const char *s, const char *prefix) { return s && !strncmp(s, prefix, strlen(prefix)); }

static void lower_into(char *dst, size_t cap, const char *a, const char *b) {
    snprintf(dst, cap, "%s %s", a ? a : "", b ? b : "");
    for (char *p = dst; *p; p++) {
        *p = (char)tolower((unsigned char)*p);
    }
}

/* first integer after `word` in `s` ("deal 3 damage" with word "deal " -> 3), or def */
static int num_after(const char *s, const char *word, int def) {
    const char *p = strstr(s, word);
    if (!p) {
        return def;
    }
    p += strlen(word);
    while (*p == ' ') {
        p++;
    }
    if (!strncmp(p, "up to ", 6)) {
        p += 6;
    }
    return isdigit((unsigned char)*p) ? atoi(p) : def;
}

static const Card *lookup(const char *set, const char *title) {
    const Card *c = set ? card_by_set(set) : NULL;
    return c ? c : (title ? card_by_title(title) : NULL);
}

/* ---------- parsing the decide message ---------- */

static void parse_ref(const JVal *j, Ref *r) {
    r->id = jstr(jget(j, "id"), "");
    r->n = jstr(jget(j, "n"), "");
    r->s = jstr(jget(j, "s"), NULL);
    r->c = lookup(r->s, r->n);
    r->x = jtrue(jget(j, "x"));
}

static void parse_units(const JVal *arr, State *st, int side, int space, const char *leaderId) {
    for (JVal *j = arr ? arr->child : NULL; j && st->nu < MAXU; j = j->next) {
        Unit *u = &st->u[st->nu++];
        memset(u, 0, sizeof *u);
        u->id = jstr(jget(j, "id"), "");
        u->n = jstr(jget(j, "n"), "");
        u->s = jstr(jget(j, "s"), NULL);
        u->c = lookup(u->s, u->n);
        u->p = jint(jget(j, "p"), 0);
        u->h = jint(jget(j, "h"), 1);
        u->d = jint(jget(j, "d"), 0);
        u->x = jtrue(jget(j, "x"));
        u->sn = jtrue(jget(j, "sn"));
        u->space = space;
        u->side = side;
        u->leader = leaderId && !strcmp(u->id, leaderId);
        for (JVal *up = jget(j, "u") ? jget(j, "u")->child : NULL; up; up = up->next) {
            if (!strcmp(jstr(jget(up, "n"), ""), "Shield")) {
                u->shields++;
            } else if (jtrue(jget(up, "t"))) {
                u->toks++;
            } else {
                u->ups++;
                if (u->nupc < 8) {
                    u->upc[u->nupc++] = lookup(jstr(jget(up, "s"), NULL), jstr(jget(up, "n"), NULL));
                }
            }
        }
    }
}

static void parse_side(const JVal *pj, State *st, int side) {
    Side *sd = &st->s[side];
    memset(sd, 0, sizeof *sd);
    const JVal *base = jget(pj, "base");
    sd->baseId = jstr(jget(base, "id"), "");
    sd->baseHp = jint(jget(base, "hp"), 30);
    sd->baseD = jint(jget(base, "d"), 0);
    sd->baseCard = lookup(jstr(jget(base, "s"), NULL), jstr(jget(base, "n"), NULL));
    const JVal *ld = jget(pj, "leader");
    if (ld && ld->t == J_OBJ) {
        sd->leaderId = jstr(jget(ld, "id"), NULL);
        sd->leaderCard = lookup(jstr(jget(ld, "s"), NULL), jstr(jget(ld, "n"), NULL));
        sd->leaderDep = jtrue(jget(ld, "dep"));
        sd->leaderX = jtrue(jget(ld, "x"));
    }
    const JVal *res = jget(pj, "res");
    sd->resReady = jint(jget(res, "ready"), 0);
    sd->resTotal = jint(jget(res, "total"), 0);
    sd->handCount = jint(jget(pj, "handCount"), 0);
    sd->deck = jint(jget(pj, "deck"), 0);
    sd->ndiscard = jget(pj, "discard") ? jget(pj, "discard")->n : 0;
    for (JVal *h = jget(pj, "hand") ? jget(pj, "hand")->child : NULL; h && sd->nhand < MAXC; h = h->next) {
        parse_ref(h, &sd->hand[sd->nhand++]);
    }
    for (JVal *r = jget(pj, "resources") ? jget(pj, "resources")->child : NULL; r && sd->nres < MAXC; r = r->next) {
        parse_ref(r, &sd->res[sd->nres++]);
    }
    parse_units(jget(pj, "ground"), st, side, 0, sd->leaderId);
    parse_units(jget(pj, "space"), st, side, 1, sd->leaderId);
}

static int seat_side(const char *seat) {
    if (!seat) {
        return -1;
    }
    return !strcmp(seat, G.me) ? 0 : 1;
}

static void parse_state(const JVal *sj, State *st) {
    memset(st, 0, sizeof *st);
    st->round = jint(jget(sj, "round"), 0);
    st->phase = jstr(jget(sj, "phase"), "");
    const char *ini = jstr(jget(sj, "initiative"), NULL);
    st->initiative = seat_side(ini);
    const JVal *players = jget(sj, "players");
    const char *opp = !strcmp(G.me, "p1") ? "p2" : "p1";
    parse_side(jget(players, G.me), st, 0);
    parse_side(jget(players, opp), st, 1);
}

static int parse_actions(const JVal *aj, Act *acts, int cap) {
    int n = 0;
    for (JVal *j = aj ? aj->child : NULL; j && n < cap; j = j->next) {
        Act *a = &acts[n++];
        memset(a, 0, sizeof *a);
        a->i = jint(jget(j, "i"), n - 1);
        a->kind = jstr(jget(j, "kind"), "");
        a->label = jstr(jget(j, "label"), "");
        a->arg = jget(j, "arg");
        a->cardUuid = jstr(jget(j, "cardUuid"), NULL);
        a->ctl = -1;
        const JVal *c = jget(j, "card");
        if (c) {
            a->cid = jstr(jget(c, "id"), NULL);
            a->cn = jstr(jget(c, "n"), NULL);
            a->cs = jstr(jget(c, "s"), NULL);
            a->zone = jstr(jget(c, "zone"), "");
            a->ctl = seat_side(jstr(jget(c, "ctl"), NULL));
        }
        a->dist = jget(j, "distribute");
    }
    return n;
}

/* ---------- card and unit values ---------- */

static Unit *find_unit(State *st, const char *id) {
    for (int i = 0; id && i < st->nu; i++) {
        if (!strcmp(st->u[i].id, id)) {
            return &st->u[i];
        }
    }
    return NULL;
}

static int rem(const Unit *u) { return imax(0, u->h - u->d); }

static unsigned kw_of(const Unit *u) {
    unsigned k = u->c ? u->c->kw : 0;
    if (u->sn) {
        k |= K_SENTINEL;
    }
    return k;
}

static int raid_of(const Unit *u) {
    if (!u->c || !(u->c->kw & K_RAID)) {
        return 0;
    }
    return imax(1, u->c->raid);
}

/* What a unit on the board is worth: threat (power), body (remaining HP), card quality (cost) and keywords. */
static double unit_worth(const Unit *u) {
    double cost = u->c && !(u->c->types & T_LEADER) ? u->c->cost : (u->p + u->h) / 2.0;
    double w = 1.3 * u->p + 0.6 * rem(u) + 0.35 * cost + 1.2 * u->shields + 0.6 * u->ups;
    unsigned k = kw_of(u);
    if (k & K_SENTINEL) w += 1.0;
    if (k & K_OVERWHELM) w += 0.4;
    if (k & K_SABOTEUR) w += 0.4;
    if (k & K_GRIT) w += 0.3;
    w += 0.4 * raid_of(u);
    if (u->c) w += 0.3 * u->c->restore;
    if (u->leader) w += 2.0;
    return w;
}

/* Aspect penalty in resources: 2 per aspect icon my leader and base don't cover. */
static int aspect_penalty(const Card *c) {
    int pen = 0;
    for (int a = 0; a < ASP_N; a++) {
        pen += imax(0, c->aspects[a] - G.asp[a]);
    }
    return 2 * pen;
}

static int eff_cost(const Card *c) { return c ? c->cost + aspect_penalty(c) : 3; }

static int harmful_upgrade(const Card *c) {
    return c->upPower < 0 || c->upHp < 0 || has(c->text, "can't") || has(c->text, "loses") ||
           has(c->text, "lose all") || has(c->text, "Weakness");
}

static int count_units(const State *st, int side) {
    int n = 0;
    for (int i = 0; i < st->nu; i++) {
        n += st->u[i].side == side;
    }
    return n;
}

static int same_card(const Card *a, const Card *b) {
    return a && b && (a == b || (a->internal && b->internal && *a->internal && !strcmp(a->internal, b->internal)));
}

/* A unique card I already control a copy of: one of my units (a deployed leader too) or an upgrade on one (a pilot). */
static int unique_in_play(const State *st, const Card *c) {
    if (!c || !c->unique) {
        return 0;
    }
    for (int i = 0; i < st->nu; i++) {
        const Unit *u = &st->u[i];
        if (u->side != 0) {
            continue;
        }
        if (same_card(u->c, c)) {
            return 1;
        }
        for (int k = 0; k < u->nupc; k++) {
            if (same_card(u->upc[k], c)) {
                return 1;
            }
        }
    }
    return 0;
}

/* Copies of `c` in my hand. */
static int copies_in_hand(const State *st, const Card *c) {
    int k = 0;
    for (int i = 0; c && i < st->s[0].nhand; i++) {
        k += same_card(st->s[0].hand[i].c, c);
    }
    return k;
}

/* Units of `side` in one arena (space = 1). */
static int count_arena(const State *st, int side, int space) {
    int n = 0;
    for (int i = 0; i < st->nu; i++) {
        n += st->u[i].side == side && st->u[i].space == space;
    }
    return n;
}

/* "On Attack" abilities a unit has: in its own text and its upgrades' (a pilot such as Luke adds one). */
static int on_attacks(const Unit *u) {
    int n = 0;
    for (int i = -1; i < u->nupc; i++) {
        const Card *c = i < 0 ? u->c : u->upc[i];
        for (const char *p = c ? c->text : NULL; p && (p = strstr(p, "On Attack")); p += 9) {
            n++;
        }
    }
    return n;
}

/* --events: an event whose condition fails now does nothing, so it is not worth a card. */
static int event_does_nothing(const State *st, const Card *c) {
    const char *t = c->text ? c->text : "";
    if (has(t, "non-leader upgrade")) {
        /* System Shock: needs an upgrade or token on an enemy unit (else it would hit one of mine) */
        for (int i = 0; i < st->nu; i++) {
            const Unit *u = &st->u[i];
            if (u->side == 1 && (u->shields || u->ups || u->toks)) {
                return 0;
            }
        }
        return 1;
    }
    if (has(t, "more space units than")) {
        /* Air Superiority */
        return count_arena(st, 0, 1) <= count_arena(st, 1, 1) || !count_arena(st, 1, 0);
    }
    return 0;
}

/* Value of playing a card from hand now (before its cost). */
static double play_value(const State *st, const Card *c) {
    if (!c) {
        return 2.0;
    }
    if (uniqueFix && unique_in_play(st, c)) {
        return -1.0; /* the uniqueness rule defeats one copy right away: the card and its cost are lost */
    }
    if (c->types & T_UNIT) {
        double v = c->power + 0.6 * c->hp + 0.35 * c->cost;
        if (c->kw & K_SENTINEL) v += 1.0;
        if (c->kw & K_SHIELDED) v += 1.2;
        if (c->kw & K_AMBUSH) v += count_units(st, 1) ? 1.0 : 0.2;
        if (c->kw & K_OVERWHELM) v += 0.4;
        if (c->kw & K_SABOTEUR) v += 0.4;
        v += 0.4 * c->raid + 0.3 * c->restore;
        return v;
    }
    if (c->types & T_UPGRADE) {
        if (harmful_upgrade(c)) {
            return count_units(st, 1) ? 0.9 * c->cost + 0.5 : 0.1;
        }
        return count_units(st, 0) ? 0.9 * (c->upPower + c->upHp) + 0.4 * c->cost + 0.5 : 0.1;
    }
    /* events: priced by cost, held back when they clearly need an enemy unit and there is none */
    const char *t = c->text;
    if (eventsFix && event_does_nothing(st, c)) {
        return 0.1;
    }
    int needsEnemy = (has(t, "enemy unit") || has(t, "a unit") || has(t, "non-leader unit")) &&
                     (has(t, "damage") || has(t, "Defeat") || has(t, "defeat") || has(t, "Capture") || has(t, "Exhaust") || has(t, "Return"));
    if (needsEnemy && !count_units(st, 1)) {
        return 0.2;
    }
    return 0.9 * c->cost + 0.5;
}

/* How much I want to keep a hand card (low = resource it / discard it). */
static double keep_value(const State *st, const Card *c) {
    if (!c) {
        return 1.0;
    }
    int total = st->s[0].resTotal;
    double v = 3.0 - 0.6 * imax(0, eff_cost(c) - (total + 2)) - 0.8 * aspect_penalty(c) / 2.0;
    if (c->types & T_UNIT) {
        v += 1.0 + 0.05 * (c->power + c->hp);
    }
    if (c->types & T_UPGRADE) {
        v -= 0.3;
    }
    if (eventsFix && (c->types & T_EVENT)) {
        v += 1.2; /* kept like a small unit: a cheap event is a card to play, not only a resource */
    }
    if (uniqueFix && c->unique) {
        /* a copy of a unique card I control can't be played: resource it first; a second copy in hand is a spare */
        if (unique_in_play(st, c)) {
            v -= 3.0;
        } else if (copies_in_hand(st, c) > 1) {
            v -= 1.0;
        }
    }
    return v;
}

/* ---------- the race clock ---------- */

typedef struct {
    double faceW;
    int myRem, oppRem, beatdown;
    int myPow, oppPow;
} Plan;

static Plan make_plan(const State *st) {
    Plan pl;
    memset(&pl, 0, sizeof pl);
    pl.myRem = imax(0, st->s[0].baseHp - st->s[0].baseD);
    pl.oppRem = imax(0, st->s[1].baseHp - st->s[1].baseD);
    for (int i = 0; i < st->nu; i++) {
        const Unit *u = &st->u[i];
        int pw = imax(0, u->p + raid_of(u));
        if (u->side == 0) pl.myPow += pw;
        else pl.oppPow += pw;
    }
    double myClock = (double)pl.oppRem / imax(1, pl.myPow);
    double oppClock = (double)pl.myRem / imax(1, pl.oppPow);
    /* ties go to whoever acts first next round */
    pl.beatdown = myClock < oppClock || (myClock == oppClock && st->initiative == 0);
    pl.faceW = pl.beatdown ? 1.15 : 0.7;
    if (pl.oppRem <= 10) {
        pl.faceW *= 1.0 + 0.06 * (10 - pl.oppRem);
    }
    if (!pl.beatdown && pl.myRem <= 8) {
        pl.faceW *= 0.8;
    }
    return pl;
}

/* ---------- combat model ---------- */

/* Value for me of `a` attacking `d` (NULL = the enemy base) with `bonus` extra power. */
static double sim_attack(const State *st, const Plan *pl, const Unit *a, const Unit *d, int bonus) {
    unsigned akw = kw_of(a);
    int P = imax(0, a->p + bonus + raid_of(a));
    double v = 0;
    if (a->c && a->c->restore && st->s[0].baseD > 0) {
        v += 0.5 * imin(a->c->restore, st->s[0].baseD);
    }
    if (!d) {
        v += P * pl->faceW;
        if (P >= pl->oppRem) {
            v += 1000;
        }
        return v;
    }
    int rd = rem(d);
    int sab = (akw & K_SABOTEUR) != 0;
    int shielded = d->shields > 0 && !sab;
    int dmg = shielded ? 0 : P;
    int kill = dmg >= rd;
    double wd = unit_worth(d);
    if (kill) {
        v += wd + 1.0;
        if (akw & K_OVERWHELM) {
            int over = dmg - rd;
            v += over * pl->faceW + (over >= pl->oppRem ? 1000 : 0);
        }
    } else if (rd > 0) {
        v += 0.5 * wd * dmg / rd;
    }
    if (shielded) v += 1.2;
    else if (sab) v += 1.2 * d->shields;
    /* the defender hits back at the same time */
    int back = a->shields > 0 ? 0 : imax(0, d->p);
    int ra = rem(a);
    double wa = unit_worth(a);
    if (a->shields > 0 && d->p > 0) v -= 1.2;
    if (back >= ra) v -= wa + 0.5;
    else if (ra > 0) v -= 0.5 * wa * back / ra;
    return v;
}

static int arena_has_sentinel(const State *st, int side, int space) {
    for (int i = 0; i < st->nu; i++) {
        const Unit *u = &st->u[i];
        if (u->side == side && u->space == space && (kw_of(u) & K_SENTINEL)) {
            return 1;
        }
    }
    return 0;
}

/* Best target for `a` among what the rules (sentinel, arena) allow in the model. *target = NULL means base. */
static double best_attack(const State *st, const Plan *pl, const Unit *a, int bonus, const Unit **target) {
    int sab = (kw_of(a) & K_SABOTEUR) != 0;
    int sentinel = !sab && arena_has_sentinel(st, 1, a->space);
    double best = -1e9;
    *target = NULL;
    if (!sentinel) {
        best = sim_attack(st, pl, a, NULL, bonus);
    }
    for (int i = 0; i < st->nu; i++) {
        const Unit *d = &st->u[i];
        if (d->side != 1 || d->space != a->space || (sentinel && !(kw_of(d) & K_SENTINEL))) {
            continue;
        }
        double v = sim_attack(st, pl, a, d, bonus);
        if (v > best) {
            best = v;
            *target = d;
        }
    }
    return best;
}

/* ---------- action helpers ---------- */

static void act_key(const Act *a, char *out) {
    snprintf(out, KEYLEN, "%s|%s|%s", a->kind, a->label, a->cardUuid ? a->cardUuid : "");
}

static int banned(const Act *a) {
    char k[KEYLEN];
    act_key(a, k);
    for (int i = 0; i < G.nbanned; i++) {
        if (!strcmp(G.banned[i], k)) {
            return 1;
        }
    }
    return 0;
}

static const Act *find_button(const Act *acts, int n, const char *re_any) {
    /* re_any: '|'-separated case-insensitive prefixes */
    char buf[256];
    for (int i = 0; i < n; i++) {
        if (strcmp(acts[i].kind, "button")) {
            continue;
        }
        char lab[256];
        lower_into(lab, sizeof lab, acts[i].label, NULL);
        snprintf(buf, sizeof buf, "%s", re_any);
        for (char *tok = strtok(buf, "|"); tok; tok = strtok(NULL, "|")) {
            if (starts(lab, tok)) {
                return &acts[i];
            }
        }
    }
    return NULL;
}

static unsigned long long fingerprint(const State *st) {
    unsigned long long h = 1469598103934665603ull;
#define MIX(v) (h = (h ^ (unsigned long long)(v)) * 1099511628211ull)
    MIX(st->round);
    MIX(st->initiative + 2);
    for (int s = 0; s < 2; s++) {
        const Side *sd = &st->s[s];
        MIX(sd->baseD); MIX(sd->resReady); MIX(sd->resTotal); MIX(sd->handCount); MIX(sd->deck); MIX(sd->ndiscard);
        MIX(sd->leaderDep); MIX(sd->leaderX);
    }
    for (int i = 0; i < st->nu; i++) {
        const Unit *u = &st->u[i];
        for (const char *p = u->id; *p; p++) MIX(*p);
        MIX(u->d); MIX(u->x); MIX(u->p); MIX(u->h); MIX(u->shields); MIX(u->ups);
    }
#undef MIX
    return h;
}

/* ---------- action window ---------- */

typedef struct {
    const Act *a;
    const Card *c;
    int cost;
    double v;
} Play;

static const Act *choose_window(State *st, const Act *acts, int n) {
    Plan pl = make_plan(st);
    const Act *pass = find_button(acts, n, "pass");
    const Act *claim = find_button(acts, n, "claim initiative");
    const Side *me = &st->s[0];

    /* loop guard */
    unsigned long long fp = fingerprint(st);
    if (G.bannedRound != st->round) {
        G.nbanned = 0;
        G.bannedRound = st->round;
    }
    if (G.lastRound == st->round && G.lastFp == fp && G.lastKey[0] && G.nbanned < 64) {
        snprintf(G.banned[G.nbanned++], KEYLEN, "%s", G.lastKey);
        if (debug) fprintf(stderr, "[c-clock] no-op, banning %s\n", G.lastKey);
    }

    const Act *atk[MAXU];
    Unit *atkU[MAXU];
    double atkV[MAXU];
    int natk = 0;
    Play plays[MAXC];
    int nplay = 0;
    const Act *leader = NULL, *other = NULL;
    for (int i = 0; i < n; i++) {
        const Act *a = &acts[i];
        if (strcmp(a->kind, "card") || banned(a)) {
            continue;
        }
        if (me->leaderId && a->cid && !strcmp(a->cid, me->leaderId) && !me->leaderDep) {
            leader = a;
            continue;
        }
        Unit *u = find_unit(st, a->cid);
        if (u && u->side == 0 && (!strcmp(a->zone, "groundArena") || !strcmp(a->zone, "spaceArena"))) {
            if (u->x) {
                other = other ? other : a; /* exhausted unit: an action ability, not an attack */
                continue;
            }
            if (natk >= MAXU) {
                continue;
            }
            const Unit *t;
            atk[natk] = a;
            atkU[natk] = u;
            atkV[natk] = best_attack(st, &pl, u, 0, &t);
            natk++;
            continue;
        }
        if ((!strcmp(a->zone, "hand") || !strcmp(a->zone, "resource") || !strcmp(a->zone, "discard")) && nplay < MAXC) {
            const Card *c = lookup(a->cs, a->cn);
            Play *p = &plays[nplay++];
            p->a = a;
            p->c = c;
            p->cost = eff_cost(c) + (!strcmp(a->zone, "resource") ? 2 : 0);
            if (p->cost > me->resReady) {
                p->cost = me->resReady; /* the engine says it is playable, so some discount applies */
            }
            p->v = play_value(st, c) - (!strcmp(a->zone, "resource") ? 1.0 : 0.0);
            continue;
        }
        other = other ? other : a;
    }

    if (debug) {
        for (int k = 0; k < natk; k++) {
            const Unit *t;
            double v = best_attack(st, &pl, atkU[k], 0, &t);
            fprintf(stderr, "[c-clock]     atk %s %d/%d -> %s %s %.2f\n", atkU[k]->n, atkU[k]->p, rem(atkU[k]), t ? t->n : "base",
                    t ? "" : "", v);
        }
        for (int i = 0; i < st->nu; i++) {
            const Unit *u = &st->u[i];
            fprintf(stderr, "[c-clock]     %s %s %s %d/%d%s%s w%.1f\n", u->side ? "opp" : "me ", u->space ? "space " : "ground", u->n, u->p,
                    rem(u), u->x ? " x" : "", u->shields ? " sh" : "", unit_worth(u));
        }
    }

    const Act *pick = NULL;
    const char *why = "";

    /* 1. lethal: enough unblocked power to finish the base this window */
    int face = 0;
    int bestFace = -1;
    for (int k = 0; k < natk; k++) {
        const Unit *u = atkU[k];
        if ((kw_of(u) & K_SABOTEUR) || !arena_has_sentinel(st, 1, u->space)) {
            int pw = imax(0, u->p + raid_of(u));
            face += pw;
            if (bestFace < 0 || pw > imax(0, atkU[bestFace]->p + raid_of(atkU[bestFace]))) {
                bestFace = k;
            }
        }
    }
    if (bestFace >= 0 && face >= pl.oppRem) {
        pick = atk[bestFace];
        why = "lethal";
        snprintf(G.intent, sizeof G.intent, "attack");
        snprintf(G.attacker, sizeof G.attacker, "%s", atkU[bestFace]->id);
    }

    /* 2. deploy the leader as soon as it is allowed: a free unit that arrives ready */
    if (me->leaderDep) {
        G.deployedOnce = 1;
    }
    if (!pick && leader && me->leaderCard && me->resTotal >= me->leaderCard->cost && !me->leaderX &&
        !(epicFix && G.deployedOnce)) {
        pick = leader;
        why = "deploy";
        snprintf(G.intent, sizeof G.intent, "deploy");
    }

    /* 2b. (--events) an event that attacks goes before the plain attack it replaces: Aggressive Negotiations adds +1/+0
       per card left in hand, Hotshot Maneuver first deals 2 damage to an enemy unit per On Attack ability */
    if (!pick && eventsFix && natk) {
        double bestA = -1;
        int onAtk = 0;
        for (int k = 0; k < natk; k++) {
            bestA = atkV[k] > bestA ? atkV[k] : bestA;
            onAtk |= on_attacks(atkU[k]) > 0;
        }
        for (int k = 0; bestA > 0.2 && k < nplay; k++) {
            const Card *c = plays[k].c;
            if (!c || !(c->types & T_EVENT) || plays[k].cost > me->resReady || strcmp(plays[k].a->zone, "hand")) {
                continue;
            }
            const char *t = c->text ? c->text : "";
            int ok = (has(t, "Attack with a unit") && me->nhand - 1 >= 2) ||
                     (has(t, "attack with that unit") && onAtk && count_units(st, 1));
            if (ok) {
                pick = plays[k].a;
                why = "attack event";
                snprintf(G.intent, sizeof G.intent, "play");
                break;
            }
        }
    }

    /* 3. attacks that kill something, best first */
    int bestK = -1;
    for (int k = 0; k < natk; k++) {
        const Unit *t;
        double v = best_attack(st, &pl, atkU[k], 0, &t);
        int kills = t && (t->shields == 0 || (kw_of(atkU[k]) & K_SABOTEUR)) && imax(0, atkU[k]->p + raid_of(atkU[k])) >= rem(t);
        if (kills && v > 1.0 && (bestK < 0 || v > atkV[bestK])) {
            bestK = k;
        }
    }
    if (!pick && bestK >= 0) {
        pick = atk[bestK];
        why = "kill";
    }

    /* knapsack over ready resources: which hand cards to play this round */
    int chosen[MAXC] = { 0 };
    int m = imin(nplay, 16);
    double bestSet = 0;
    unsigned bestMask = 0;
    for (unsigned mask = 1; mask < (1u << m); mask++) {
        int cost = 0;
        double v = 0;
        for (int k = 0; k < m; k++) {
            if (mask & (1u << k)) {
                cost += plays[k].cost;
                v += plays[k].v;
            }
        }
        if (cost <= me->resReady && v > bestSet) {
            bestSet = v;
            bestMask = mask;
        }
    }
    for (int k = 0; k < m; k++) {
        chosen[k] = (bestMask >> k) & 1;
    }

    /* 4. helpful upgrades go on before the attacks */
    if (!pick && natk) {
        for (int k = 0; k < m; k++) {
            if (chosen[k] && plays[k].c && (plays[k].c->types & T_UPGRADE) && !harmful_upgrade(plays[k].c)) {
                pick = plays[k].a;
                why = "upgrade";
                break;
            }
        }
    }

    /* 5. the other attacks worth making */
    if (!pick) {
        int b = -1;
        for (int k = 0; k < natk; k++) {
            if (atkV[k] > 0.2 && (b < 0 || atkV[k] > atkV[b])) {
                b = k;
            }
        }
        if (b >= 0) {
            pick = atk[b];
            why = "attack";
        }
    }
    if (pick && (!strcmp(why, "kill") || !strcmp(why, "attack"))) {
        snprintf(G.intent, sizeof G.intent, "attack");
        Unit *u = find_unit(st, pick->cid);
        snprintf(G.attacker, sizeof G.attacker, "%s", u ? u->id : "");
    }

    /* 6. hand cards from the knapsack, most expensive first */
    if (!pick) {
        int b = -1;
        for (int k = 0; k < m; k++) {
            if (chosen[k] && plays[k].v > 0.3 && (b < 0 || plays[k].cost > plays[b].cost || (plays[k].cost == plays[b].cost && plays[k].v > plays[b].v))) {
                b = k;
            }
        }
        if (b >= 0) {
            pick = plays[b].a;
            why = "play";
            snprintf(G.intent, sizeof G.intent, "play");
        }
    }

    /* 7. leftovers: the leader's action ability, then any other clickable card */
    if (!pick && leader && !me->leaderX) {
        pick = leader;
        why = "leader ability";
        snprintf(G.intent, sizeof G.intent, "ability");
    }
    if (!pick && other) {
        pick = other;
        why = "other";
        snprintf(G.intent, sizeof G.intent, "ability");
    }

    /* 8. nothing useful left: take the initiative for next round */
    if (!pick) {
        pick = claim ? claim : pass ? pass : &acts[0];
        why = claim ? "claim" : "pass";
        G.intent[0] = '\0';
    }

    G.lastFp = fp;
    G.lastRound = st->round;
    if (!strcmp(pick->kind, "button")) {
        G.lastKey[0] = '\0'; /* passing is never a no-op */
    } else {
        act_key(pick, G.lastKey);
    }
    if (debug) {
        fprintf(stderr, "[c-clock] R%d %s (%s) face %.2f me %d/%d opp %d/%d -> %s %s\n", st->round, why,
                pl.beatdown ? "beatdown" : "control", pl.faceW, pl.myRem, pl.myPow, pl.oppRem, pl.oppPow, pick->kind, pick->label);
    }
    return pick;
}

/* ---------- targets outside the action window ---------- */

enum { FX_NEUTRAL, FX_HARM, FX_HELP, FX_ATTACKER, FX_ATTACK_TARGET, FX_EXPLOIT };

typedef struct {
    int fx;
    int amount;      /* damage / heal amount when stated */
    int defeat, exhaust, bounce, capture, shield, ready, buff, sentinel;
} Effect;

static Effect classify(const Prompt *pr) {
    Effect e;
    memset(&e, 0, sizeof e);
    const char *t = pr->tl;
    if (has(t, "for attack") || has(t, "unit to attack")) {
        e.fx = FX_ATTACK_TARGET;
        return e;
    }
    if (has(t, "attack with")) {
        e.fx = FX_ATTACKER;
        e.buff = num_after(t, "gets +", 0);
        return e;
    }
    if (has(t, "exploit")) {
        e.fx = FX_EXPLOIT;
        return e;
    }
    if (pilotFix && has(t, "as a pilot")) {
        /* "Deploy <leader> as a Pilot": the leader goes on one of my Vehicles; best on a big one that can still attack */
        e.fx = FX_HELP;
        e.buff = 4;
        return e;
    }
    if (has(t, "attach ")) {
        /* upgrade: the prompt's source is the upgrade card */
        const Card *c = card_by_title(pr->ptitle ? pr->ptitle : "");
        e.fx = c && harmful_upgrade(c) ? FX_HARM : FX_HELP;
        e.buff = c ? c->upPower + c->upHp : 2;
        return e;
    }
    int heal = has(t, "heal");
    int prevent = has(t, "prevent");
    e.amount = num_after(t, "deal ", 0);
    e.defeat = has(t, "defeat") || has(t, "take control");
    e.capture = has(t, "capture");
    e.exhaust = has(t, "exhaust");
    e.bounce = has(t, "return") && has(t, "hand");
    int harm = e.amount || e.defeat || e.capture || e.exhaust || e.bounce || (has(t, "damage") && !heal && !prevent) ||
               has(t, "/-") || has(t, "\xe2\x80\x93") || has(t, "weakness") || has(t, "can't") || has(t, "loses") || has(t, "lose all");
    e.shield = has(t, "shield");
    e.ready = has(t, "ready a") || has(t, "ready it");
    e.buff = num_after(t, "+", 0);
    e.sentinel = has(t, "gains sentinel") || has(t, "unit sentinel");
    if (heal) {
        e.amount = num_after(t, "heal ", 1);
    }
    int help = heal || prevent || e.shield || e.ready || e.buff || has(t, "experience") || has(t, "advantage") || e.sentinel;
    if (heal && has(t, "enemy")) {
        help = 0; /* "heal ... a damaged enemy unit and give a Weakness token" */
        harm = 1;
    }
    if (has(t, "defeat a friendly upgrade") || has(t, "defeat all shield")) {
        harm = 1;
        help = 0;
    }
    e.fx = harm && !(help && !e.amount && !e.defeat) ? FX_HARM : help ? FX_HELP : FX_NEUTRAL;
    return e;
}

/* Score of picking one card as the target of `e` (higher is better for me). */
static double target_score(State *st, const Plan *pl, const Prompt *pr, const Effect *e, const Act *a) {
    const char *zone = a->zone ? a->zone : "";
    int mine = a->ctl == 0;
    const Card *c = lookup(a->cs, a->cn);
    if (!strcmp(zone, "hand") || !strcmp(zone, "discard") || !strcmp(zone, "resource") || !strcmp(zone, "deck")) {
        double kv = keep_value(st, c) + (c ? 0.3 * c->cost : 0);
        int lose = has(pr->tl, "discard") && !strcmp(zone, "hand");
        lose = lose || !strcmp(zone, "resource") || has(pr->tl, "bottom of");
        if (!mine) {
            return lose ? kv : -kv;
        }
        return lose ? -kv : kv;
    }
    if (!strcmp(zone, "base")) {
        if (e->fx == FX_HARM || e->fx == FX_ATTACK_TARGET) {
            return mine ? -50 : (e->amount ? e->amount : 2) * pl->faceW;
        }
        if (e->fx == FX_HELP) {
            return mine ? 0.5 * imin(e->amount ? e->amount : 2, st->s[0].baseD) + 0.1 : -50;
        }
        return mine ? 0.1 : -0.1;
    }
    Unit *u = find_unit(st, a->cid);
    if (!u) {
        /* an upgrade or token on a unit, or something not on the board */
        double v = c ? 0.5 * c->cost + 0.5 : 0.5;
        if (has(pr->tl, "upgrade") || has(pr->tl, "token")) {
            return mine ? -v : v;
        }
        return mine ? v : -v;
    }
    double w = unit_worth(u);
    switch (e->fx) {
    case FX_ATTACK_TARGET:
        return mine ? -100 : 0; /* handled by choose_attack_target */
    case FX_EXPLOIT:
        return mine ? 2.5 - w : -10; /* each exploited unit pays ~2 resources */
    case FX_ATTACKER: {
        const Unit *t;
        double v = best_attack(st, pl, u, e->buff, &t);
        return mine ? v : -w;
    }
    case FX_HARM: {
        double v;
        if (e->amount) {
            int r = rem(u);
            if (u->shields) v = 1.2 + 0.1 * w;
            else if (e->amount >= r) v = w + 1.0;
            else v = 0.5 * w * e->amount / imax(1, r);
        } else if (e->defeat || e->capture) {
            v = w + 1.0;
        } else if (e->bounce) {
            v = 0.8 * w;
        } else if (e->exhaust) {
            v = u->x ? 0.1 * w : 0.5 * w;
        } else {
            v = 0.4 * w;
        }
        return mine ? -v : v;
    }
    case FX_HELP: {
        double v;
        if (e->amount && !e->buff) {
            v = u->d ? 0.5 * w * imin(e->amount, u->d) / imax(1, u->h) + 0.2 : 0.01;
        } else if (e->shield) {
            v = u->shields ? 0.2 * w : 0.4 * w + 0.5;
        } else if (e->ready) {
            v = u->x ? u->p + 0.5 : 0.05;
        } else {
            v = 0.3 * w + (u->x ? 0 : 1.0) + 0.2 * e->buff;
        }
        return mine ? v : -v;
    }
    default:
        return mine ? 0.1 * w : -0.1 * w;
    }
}

/* Which of the offered targets the attacker should hit, by the combat model. */
static const Act *choose_attack_target(State *st, const Prompt *pr, const Act *acts, int n) {
    Plan pl = make_plan(st);
    Unit *a = find_unit(st, G.attacker);
    if (!a || a->side != 0 || (pr->ptitle && *pr->ptitle && strcmp(a->n, pr->ptitle))) {
        /* not the unit we clicked: an ambush or an ability attack, so find the attacker by the prompt's source name */
        for (int i = 0; i < st->nu; i++) {
            if (st->u[i].side == 0 && !strcmp(st->u[i].n, pr->ptitle)) {
                a = &st->u[i];
                break;
            }
        }
    }
    if (a && a->side != 0) {
        a = NULL;
    }
    int bonus = num_after(pr->tl, "gets +", 0);
    const Act *best = NULL;
    double bv = -1e9;
    for (int i = 0; i < n; i++) {
        const Act *x = &acts[i];
        if (strcmp(x->kind, "card")) {
            continue;
        }
        double v;
        if (x->ctl == 0) {
            v = -100;
        } else if (!strcmp(x->zone ? x->zone : "", "base")) {
            v = a ? sim_attack(st, &pl, a, NULL, bonus) : 2 * pl.faceW;
        } else {
            Unit *d = find_unit(st, x->cid);
            v = a && d ? sim_attack(st, &pl, a, d, bonus) : 0;
        }
        if (v > bv) {
            bv = v;
            best = x;
        }
    }
    if (best && bv < -1.0) {
        /* every target loses: back out (the loop guard then skips this attacker for the round) */
        const Act *c = find_button(acts, n, "cancel");
        if (c) return c;
    }
    return best;
}

/* "Select between 1 and 2", "up to 3", "Select 2 cards", "Choose 2 cards" -> min/max picks */
static void pick_limits(const char *t, int *lo, int *hi) {
    const char *b = strstr(t, "between ");
    if (b && sscanf(b, "between %d and %d", lo, hi) == 2) {
        return;
    }
    const char *u = strstr(t, "up to ");
    if (u && isdigit((unsigned char)u[6])) {
        *lo = 0;
        *hi = atoi(u + 6);
        return;
    }
    if (has(t, "any number")) {
        *lo = 0;
        *hi = 99;
        return;
    }
    const char *words[] = { "select ", "choose ", "discard " };
    for (int k = 0; k < 3; k++) {
        const char *s = strstr(t, words[k]);
        if (s && isdigit((unsigned char)s[strlen(words[k])])) {
            *lo = *hi = atoi(s + strlen(words[k]));
            return;
        }
    }
    *lo = 1;
    *hi = 1;
}

static const Act *done_button(const Act *acts, int n) {
    return find_button(acts, n, "done|confirm|submit|ok|resolve");
}

static const Act *decline_button(const Act *acts, int n) {
    return find_button(acts, n, "choose nothing|pass|skip|take nothing|done|no|cancel");
}

static const Act *choose_cards(State *st, const Prompt *pr, const Act *acts, int n) {
    Plan pl = make_plan(st);
    Effect e = classify(pr);
    if (e.fx == FX_ATTACK_TARGET) {
        const Act *t = choose_attack_target(st, pr, acts, n);
        if (t) {
            return t;
        }
    }
    if (eventsFix && has(pr->tl, "abilities on a friendly unit")) {
        /* Hotshot Maneuver: 2 damage to an enemy unit per On Attack ability of my unit, then that unit attacks */
        const Act *pickU = NULL;
        double pv = -1e9;
        for (int i = 0; i < n; i++) {
            Unit *u = strcmp(acts[i].kind, "card") ? NULL : find_unit(st, acts[i].cid);
            if (!u || u->side != 0) {
                continue;
            }
            const Unit *t;
            double v = 3.0 * imin(on_attacks(u), count_units(st, 1)) + (u->x ? 0 : 1.0 + best_attack(st, &pl, u, 0, &t));
            if (v > pv) {
                pv = v;
                pickU = &acts[i];
            }
        }
        if (pickU) {
            Unit *u = find_unit(st, pickU->cid);
            snprintf(G.attacker, sizeof G.attacker, "%s", u ? u->id : "");
            return pickU;
        }
    }
    const Act *best = NULL;
    double bv = -1e9;
    int ncards = 0;
    for (int i = 0; i < n; i++) {
        if (strcmp(acts[i].kind, "card")) {
            continue;
        }
        ncards++;
        double v = target_score(st, &pl, pr, &e, &acts[i]);
        if (v > bv) {
            bv = v;
            best = &acts[i];
        }
    }
    if (e.fx == FX_ATTACKER && best) {
        Unit *u = find_unit(st, best->cid);
        snprintf(G.attacker, sizeof G.attacker, "%s", u ? u->id : "");
    }
    if (pr->mode && !strcmp(pr->mode, "multiple")) {
        int lo, hi;
        pick_limits(pr->tl, &lo, &hi);
        if (e.fx == FX_EXPLOIT) {
            lo = 0;
        }
        int sel = pr->nselected;
        const Act *done = done_button(acts, n);
        if (best && sel < hi && (bv > 0 || sel < lo)) {
            return best;
        }
        if (sel == 0) {
            const Act *no = find_button(acts, n, "choose nothing|pass|skip");
            if (no) return no;
        }
        if (done) return done;
        const Act *no = decline_button(acts, n);
        if (no) return no;
        return best ? best : &acts[0];
    }
    if (best && bv > 0) {
        return best;
    }
    const Act *no = find_button(acts, n, "pass|choose nothing|skip|cancel");
    if (no) {
        return no;
    }
    return best ? best : &acts[0];
}

/* ---------- setup prompts ---------- */

static void learn_aspects(const State *st) {
    if (G.aspReady) {
        return;
    }
    const Card *l = st->s[0].leaderCard, *b = st->s[0].baseCard;
    for (int a = 0; a < ASP_N; a++) {
        G.asp[a] = (l ? l->aspects[a] : 0) + (b ? b->aspects[a] : 0);
    }
    G.aspReady = 1;
}

static const Act *choose_mulligan(const State *st, const Act *acts, int n) {
    int cheapUnits = 0, cheap = 0, roundOne = 0;
    for (int i = 0; i < st->s[0].nhand; i++) {
        const Card *c = st->s[0].hand[i].c;
        int ec = eff_cost(c);
        if (ec <= 3 && c && (c->types & T_UNIT)) cheapUnits++;
        if (ec <= 2 && c && (c->types & T_UNIT)) roundOne++;
        if (ec <= 4) cheap++;
    }
    int keep = (mullFix ? roundOne : cheapUnits) >= 1 && cheap >= 2;
    const Act *b = find_button(acts, n, keep ? "keep" : "mulligan");
    return b ? b : &acts[0];
}

static const Act *choose_resource(State *st, const Prompt *pr, const Act *acts, int n) {
    int lo, hi;
    pick_limits(pr->tl, &lo, &hi);
    const Side *me = &st->s[0];
    int want = hi;
    if (lo == 0) {
        /* regroup: resource while the curve still needs it */
        int big = 0;
        for (int i = 0; i < me->nhand; i++) {
            big |= eff_cost(me->hand[i].c) > me->resTotal;
        }
        want = me->resTotal < 6 || (me->resTotal < 9 && me->handCount >= 3) || (big && me->handCount >= 2) ? hi : 0;
    }
    if (pr->nselected >= want) {
        const Act *b = want == 0 ? find_button(acts, n, "skip|done|confirm") : find_button(acts, n, "confirm|done");
        if (b) return b;
    }
    const Act *best = NULL;
    double bv = 1e9;
    for (int i = 0; i < n; i++) {
        if (strcmp(acts[i].kind, "card")) {
            continue;
        }
        double v = keep_value(st, lookup(acts[i].cs, acts[i].cn));
        if (v < bv) {
            bv = v;
            best = &acts[i];
        }
    }
    if (best) return best;
    const Act *b = find_button(acts, n, "confirm|done|skip");
    return b ? b : &acts[0];
}

/* ---------- distribute damage / healing / tokens ---------- */

typedef struct {
    const char *id;
    int cap, amount;
    int mine, isBase;
    Unit *u;
} DT;

static int dist_room(const DT *t) { return t->cap < 0 ? 1 << 20 : t->cap - t->amount; }

static void give(DT *t, int *left, int want, int *used, int maxT) {
    want = imin(want, imin(*left, dist_room(t)));
    if (want <= 0) return;
    if (t->amount == 0) {
        if (maxT >= 0 && *used >= maxT) return;
        (*used)++;
    }
    t->amount += want;
    *left -= want;
}

/* Returns 1 and writes a JSON array into out when a legal split was found. */
static int choose_split(State *st, const JVal *dj, char *out, size_t cap) {
    Plan pl = make_plan(st);
    const char *type = jstr(jget(dj, "type"), "");
    int amount = jint(jget(dj, "amount"), 0);
    int less = jtrue(jget(dj, "canDistributeLess"));
    const JVal *mt = jget(dj, "maxTargets");
    int maxT = mt && mt->t == J_NUM ? (int)mt->num : -1;
    DT t[MAXU + 8];
    int nt = 0;
    for (JVal *j = jget(dj, "targets") ? jget(dj, "targets")->child : NULL; j && nt < MAXU + 8; j = j->next) {
        DT *x = &t[nt++];
        memset(x, 0, sizeof *x);
        x->id = jstr(jget(j, "id"), "");
        const JVal *c = jget(j, "cap");
        x->cap = c && c->t == J_NUM ? (int)c->num : -1;
        x->u = find_unit(st, x->id);
        if (x->u) {
            x->mine = x->u->side == 0;
        } else if (!strcmp(x->id, st->s[0].baseId)) {
            x->mine = 1;
            x->isBase = 1;
        } else {
            x->isBase = !strcmp(x->id, st->s[1].baseId);
        }
    }
    int left = amount, used = 0;
    int healing = has(type, "Healing");
    int tokens = has(type, "Token");
    if (healing || tokens) {
        /* mine first: damaged and valuable units, then the base */
        for (int pass = 0; pass < 3 && left > 0; pass++) {
            int b = -1;
            double bv = -1e9;
            for (int k = 0; k < nt; k++) {
                if (!t[k].mine || t[k].amount) continue;
                double v;
                if (t[k].u) v = healing ? (t[k].u->d ? unit_worth(t[k].u) : -1) : unit_worth(t[k].u);
                else v = healing && st->s[0].baseD ? 1.0 : -2;
                if (v > bv) { bv = v; b = k; }
            }
            if (b < 0 || bv < 0) break;
            int need = tokens ? (maxT == 1 ? left : 1) : (t[b].u ? t[b].u->d : st->s[0].baseD);
            give(&t[b], &left, need, &used, maxT);
        }
    } else {
        /* damage: kill the best enemy units it can, then the enemy base, then the biggest enemy unit */
        int order[MAXU + 8];
        int no = 0;
        for (int k = 0; k < nt; k++) if (!t[k].mine && t[k].u) order[no++] = k;
        for (int a = 0; a < no; a++)
            for (int b = a + 1; b < no; b++)
                if (unit_worth(t[order[b]].u) > unit_worth(t[order[a]].u)) { int x = order[a]; order[a] = order[b]; order[b] = x; }
        for (int q = 0; q < no; q++) {
            DT *x = &t[order[q]];
            int need = rem(x->u);
            if (!x->u->shields && need <= left && need <= dist_room(x)) give(x, &left, need, &used, maxT);
        }
        for (int k = 0; k < nt && left > 0; k++) if (!t[k].mine && t[k].isBase) give(&t[k], &left, left, &used, maxT);
        for (int q = 0; q < no && left > 0; q++) give(&t[order[q]], &left, left, &used, maxT);
        /* my own side, when I must: base unless it is in danger, then units without killing them */
        if (left > 0 && !less) {
            int danger = pl.myRem <= left + 3;
            for (int k = 0; k < nt && left > 0 && !danger; k++) if (t[k].mine && t[k].isBase) give(&t[k], &left, left, &used, maxT);
            for (int k = 0; k < nt && left > 0; k++) if (t[k].mine && t[k].u) give(&t[k], &left, rem(t[k].u) - 1, &used, maxT);
            for (int k = 0; k < nt && left > 0; k++) if (t[k].mine && t[k].isBase) give(&t[k], &left, left, &used, maxT);
            for (int k = 0; k < nt && left > 0; k++) if (t[k].mine) give(&t[k], &left, left, &used, maxT);
        }
    }
    if (left > 0 && !less) {
        /* fill whatever capacity is left, enemy side first */
        for (int pass = 0; pass < 2 && left > 0; pass++) {
            int side = (healing || tokens) ? 1 - pass : pass;
            for (int k = 0; k < nt && left > 0; k++) if (t[k].mine == side) give(&t[k], &left, left, &used, maxT);
        }
    }
    int sum = amount - left;
    if ((left > 0 && !less) || (sum == 0 && !jtrue(jget(dj, "canChooseNoTargets")))) {
        return 0;
    }
    size_t w = (size_t)snprintf(out, cap, "[");
    int first = 1;
    for (int k = 0; k < nt && w < cap; k++) {
        if (!t[k].amount) continue;
        w += (size_t)snprintf(out + w, cap - w, "%s{\"id\":\"%s\",\"amount\":%d}", first ? "" : ",", t[k].id, t[k].amount);
        first = 0;
    }
    if (w < cap) snprintf(out + w, cap - w, "]");
    return w < cap;
}

/* ---------- buttons, menus, display prompts ---------- */

static double button_score(const char *label) {
    char l[256];
    lower_into(l, sizeof l, label, NULL);
    if (starts(l, "(no effect)")) return -5;
    if (starts(l, "trigger") || starts(l, "yes") || starts(l, "deploy") || starts(l, "resolve all") || starts(l, "use 1 credit")) return 5;
    if (starts(l, "you") && !starts(l, "your")) return 3;
    if (starts(l, "done") || starts(l, "confirm") || starts(l, "continue") || starts(l, "ok") || starts(l, "resolve")) return 3;
    if (starts(l, "play anyway") || starts(l, "use it anyway")) return -4;
    if (starts(l, "pass") || starts(l, "no") || starts(l, "decline") || starts(l, "skip") || starts(l, "choose nothing") || starts(l, "cancel")) return -3;
    return 0;
}

static const Act *choose_buttons(State *st, const Prompt *pr, const Act *acts, int n) {
    const char *t = pr->low;
    if (has(t, "will have no effect") || has(t, "no effect. are you sure")) {
        const Act *b = find_button(acts, n, "cancel");
        if (b) return b;
    }
    if (has(t, "initiative")) {
        const Act *b = find_button(acts, n, "yourself|you");
        if (b) return b;
    }
    if (has(t, "mulligan")) {
        return choose_mulligan(st, acts, n);
    }
    if (starts(t, "choose an ability")) {
        if (!strcmp(G.intent, "attack")) {
            const Act *b = find_button(acts, n, "attack");
            if (b) return b;
        }
    }
    if (starts(t, "play ") && has(t, ":")) {
        /* leader menu (deploy / ability) or a unit with Piloting */
        const Act *dep = NULL;
        if (pilotFix) {
            /* a Pilot leader on a Vehicle: a bigger leader unit that enemy card abilities can't easily remove, and
               its upgrade text (Luke: "On Attack: deal 3 damage to a unit") on a unit that can attack this round */
            for (int i = 0; i < n && !dep; i++) {
                char l[256];
                lower_into(l, sizeof l, acts[i].label, NULL);
                if (!strcmp(acts[i].kind, "button") && starts(l, "deploy") && has(l, "pilot")) {
                    dep = &acts[i];
                }
            }
        }
        if (!dep) {
            dep = find_button(acts, n, "deploy");
        }
        if (dep && strcmp(G.intent, "ability")) {
            G.deployedOnce = 1;
            return dep;
        }
        if (!dep && !strcmp(G.intent, "deploy")) {
            /* this leader has no deploy now: back out and keep the resources for the hand (its ability comes last) */
            const Act *c = find_button(acts, n, "cancel");
            if (c) return c;
        }
        for (int i = 0; i < n; i++) {
            char l[256];
            lower_into(l, sizeof l, acts[i].label, NULL);
            if (!strcmp(acts[i].kind, "button") && starts(l, "play ") && !has(l, " with ")) return &acts[i];
        }
    }
    if (has(t, "choose a deck")) {
        const Act *b = find_button(acts, n, "opponent");
        if (b) return b;
    }
    if (has(t, "choose a player") || has(t, "choose player")) {
        int bad = has(t, "damage") || has(t, "discard") || has(t, "defeat") || has(t, "exhaust");
        for (int i = 0; i < n; i++) {
            char l[256];
            lower_into(l, sizeof l, acts[i].label, NULL);
            int opp = has(l, "opponent");
            if (opp == bad && strcmp(acts[i].kind, "button") == 0) return &acts[i];
        }
    }
    if (has(t, "both players have triggered")) {
        const Act *b = find_button(acts, n, "you");
        if (b) return b;
    }
    if (has(t, "choose an arena")) {
        int diff[2] = { 0, 0 };
        for (int i = 0; i < st->nu; i++) diff[st->u[i].space] += st->u[i].side ? st->u[i].p : -st->u[i].p;
        const Act *b = find_button(acts, n, diff[1] > diff[0] ? "space" : "ground");
        if (b) return b;
    }
    if (has(t, "pay mode")) {
        const Act *b = find_button(acts, n, "pay|play|trigger");
        if (b) return b;
    }
    const Act *best = &acts[0];
    double bv = -1e9;
    for (int i = 0; i < n; i++) {
        double v = button_score(acts[i].label);
        if (v > bv) {
            bv = v;
            best = &acts[i];
        }
    }
    return best;
}

static double display_value(const State *st, const char *label) {
    const char *name = strchr(label, ':') && strchr(label, ':')[1] ? strchr(label, ':') + 1 : label;
    const Card *c = card_by_internal(name);
    if (!c) {
        c = card_by_internal(label);
    }
    return c ? play_value(st, c) + 0.3 * c->cost : 1.0;
}

static const Act *choose_display(State *st, const Prompt *pr, const Act *acts, int n) {
    const Act *best = NULL;
    double bv = -1e9;
    for (int i = 0; i < n; i++) {
        if (strcmp(acts[i].kind, "displayCard") && strcmp(acts[i].kind, "perCardButton")) {
            continue;
        }
        double v = display_value(st, acts[i].label);
        if (has(pr->tl, "bottom") && !strcmp(acts[i].kind, "perCardButton")) {
            v = -v;
        }
        if (v > bv) {
            bv = v;
            best = &acts[i];
        }
    }
    int lo, hi;
    pick_limits(pr->tl, &lo, &hi);
    if (has(pr->tl, "view cards") || !best || G.displayClicks >= hi) {
        const Act *b = done_button(acts, n);
        if (!b) b = decline_button(acts, n);
        if (b) return b;
    }
    G.displayClicks++;
    return best ? best : &acts[0];
}

static const Act *choose_option(const Prompt *pr, const Act *acts, int n) {
    (void)pr;
    const Act *best = NULL;
    int bestN = -1;
    for (int i = 0; i < n; i++) {
        if (strcmp(acts[i].kind, "option")) continue;
        if (acts[i].label[0] == '#') {
            int v = atoi(acts[i].label + 1);
            if (v > bestN) { bestN = v; best = &acts[i]; }
        } else if (!best) {
            best = &acts[i];
        }
    }
    return best ? best : &acts[0];
}

/* ---------- one decision ---------- */

static const Act *decide(State *st, Prompt *pr, const Act *acts, int n, char *split, size_t splitCap, int *hasSplit) {
    *hasSplit = 0;
    learn_aspects(st);

    /* the same prompt over and over: stop doing whatever keeps it alive */
    char pk[KEYLEN];
    snprintf(pk, sizeof pk, "%s|%s|%s", pr->sig, pr->title ? pr->title : "", pr->ptitle ? pr->ptitle : "");
    if (!strcmp(pk, G.promptKey)) {
        G.promptRepeats++;
    } else {
        snprintf(G.promptKey, sizeof G.promptKey, "%s", pk);
        G.promptRepeats = 0;
        /* a new prompt: forget clicks made in the last display prompt */
        G.displayClicks = 0;
    }
    if (G.promptRepeats > 25 && !pr->aw) {
        const Act *b = find_button(acts, n, "done|confirm|pass|choose nothing|skip|cancel|take nothing");
        return b ? b : &acts[G.promptRepeats % n];
    }

    if (pr->aw) {
        G.displayClicks = 0;
        return choose_window(st, acts, n);
    }
    for (int i = 0; i < n; i++) {
        if (!strcmp(acts[i].kind, "distribute")) {
            *hasSplit = choose_split(st, acts[i].dist, split, splitCap);
            return &acts[i];
        }
    }
    if (pr->type && !strcmp(pr->type, "resource")) {
        return choose_resource(st, pr, acts, n);
    }
    int cards = 0, display = 0, options = 0;
    for (int i = 0; i < n; i++) {
        cards += !strcmp(acts[i].kind, "card");
        display += !strcmp(acts[i].kind, "displayCard") || !strcmp(acts[i].kind, "perCardButton");
        options += !strcmp(acts[i].kind, "option");
    }
    if (cards) {
        return choose_cards(st, pr, acts, n);
    }
    if (display) {
        return choose_display(st, pr, acts, n);
    }
    if (options) {
        return choose_option(pr, acts, n);
    }
    return choose_buttons(st, pr, acts, n);
}

/* ---------- protocol ---------- */

static void reply(const char *line) {
    fputs(line, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

int main(int argc, char **argv) {
    debug = getenv("SWU_C_DEBUG") && *getenv("SWU_C_DEBUG") && strcmp(getenv("SWU_C_DEBUG"), "0");
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--v2")) {
            v2 = pilotFix = uniqueFix = 1;
        } else if (!strcmp(argv[i], "--v3")) {
            v2 = v3 = pilotFix = uniqueFix = eventsFix = 1;
        } else if (!strcmp(argv[i], "--mull")) {
            mullFix = 1;
        } else if (!strcmp(argv[i], "--epic")) {
            epicFix = 1;
        } else if (!strcmp(argv[i], "--events")) {
            eventsFix = 1;
        } else if (!strcmp(argv[i], "--pilot")) {
            pilotFix = 1;
        } else if (!strcmp(argv[i], "--unique")) {
            uniqueFix = 1;
        }
    }
    const char *root = getenv("SWU_CARD_JSON");
    char dir[4096];
    snprintf(dir, sizeof dir, "%s/Card", root && *root ? root : "forceteki/test/json");
    int ncards = cards_load(dir);
    if (debug) {
        fprintf(stderr, "[c-clock] %d cards from %s\n", ncards, dir);
    }
    if (ncards <= 0) {
        fprintf(stderr, "[c-clock] no card data in %s: playing on board stats only\n", dir);
    }
    reset_game();

    Arena arena;
    arena_init(&arena, 1 << 20);
    static State st;
    static Act acts[4096];
    static Prompt pr;
    char *line = NULL;
    size_t cap = 0;
    ssize_t len;
    char out[8192], split[4096];
    while ((len = getline(&line, &cap, stdin)) > 0) {
        arena_reset(&arena);
        JVal *m = json_parse(line, &arena);
        if (!m) {
            reply("{\"t\":\"error\",\"error\":\"c-clock: could not parse a message\"}");
            continue;
        }
        const char *t = jstr(jget(m, "t"), "");
        if (!strcmp(t, "hello")) {
            reset_game();
            snprintf(G.me, sizeof G.me, "%s", jstr(jget(m, "you"), "p1"));
            reply(v3 ? "{\"t\":\"ready\",\"v\":1,\"name\":\"c-clock3\"}" : v2 ? "{\"t\":\"ready\",\"v\":1,\"name\":\"c-clock2\"}" : "{\"t\":\"ready\",\"v\":1,\"name\":\"c-clock\"}");
            continue;
        }
        if (strcmp(t, "decide")) {
            snprintf(out, sizeof out, "{\"t\":\"error\",\"error\":\"c-clock: unknown message %.40s\"}", t);
            reply(out);
            continue;
        }
        snprintf(G.me, sizeof G.me, "%s", jstr(jget(m, "you"), G.me));
        parse_state(jget(m, "state"), &st);
        const JVal *pj = jget(m, "prompt");
        memset(&pr, 0, sizeof pr);
        pr.title = jstr(jget(pj, "title"), "");
        pr.ptitle = jstr(jget(pj, "promptTitle"), "");
        pr.sig = jstr(jget(pj, "signature"), "");
        pr.type = jstr(jget(pj, "type"), NULL);
        pr.mode = jstr(jget(pj, "selectCardMode"), NULL);
        pr.aw = jtrue(jget(pj, "actionWindow"));
        pr.selected = jget(pj, "selected");
        pr.nselected = pr.selected ? pr.selected->n : 0;
        lower_into(pr.low, sizeof pr.low, pr.title, pr.ptitle);
        lower_into(pr.tl, sizeof pr.tl, pr.title, NULL);
        int n = parse_actions(jget(m, "actions"), acts, 4096);
        if (n == 0) {
            reply("{\"t\":\"error\",\"error\":\"c-clock: no actions\"}");
            continue;
        }
        int hasSplit = 0;
        const Act *a = decide(&st, &pr, acts, n, split, sizeof split, &hasSplit);
        if (debug && !pr.aw) {
            fprintf(stderr, "[c-clock]   %s | %s -> %s %s\n", pr.sig, pr.title, a->kind, a->label);
        }
        if (hasSplit) {
            snprintf(out, sizeof out, "{\"t\":\"act\",\"i\":%d,\"distribution\":%s}", a->i, split);
        } else {
            snprintf(out, sizeof out, "{\"t\":\"act\",\"i\":%d}", a->i);
        }
        reply(out);
    }
    free(line);
    return 0;
}
