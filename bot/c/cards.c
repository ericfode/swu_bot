#include "cards.h"
#include "json.h"

#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---------- string -> Card* hash maps (open addressing, never shrink) ---------- */

typedef struct {
    char **keys;
    const Card **vals;
    unsigned cap, n;
} Map;

static Map by_set, by_internal, by_title;

static unsigned hash(const char *s) {
    unsigned h = 2166136261u;
    while (*s) {
        h = (h ^ (unsigned char)*s++) * 16777619u;
    }
    return h;
}

static void map_put(Map *m, const char *key, const Card *c) {
    if (!key || !*key) {
        return;
    }
    if ((m->n + 1) * 2 > m->cap) {
        Map old = *m;
        m->cap = old.cap ? old.cap * 2 : 1024;
        m->keys = calloc(m->cap, sizeof(char *));
        m->vals = calloc(m->cap, sizeof(Card *));
        m->n = 0;
        for (unsigned i = 0; i < old.cap; i++) {
            if (old.keys[i]) {
                map_put(m, old.keys[i], old.vals[i]);
                free(old.keys[i]);
            }
        }
        free(old.keys);
        free(old.vals);
    }
    unsigned i = hash(key) & (m->cap - 1);
    while (m->keys[i]) {
        if (!strcmp(m->keys[i], key)) {
            return; /* first one wins */
        }
        i = (i + 1) & (m->cap - 1);
    }
    m->keys[i] = strdup(key);
    m->vals[i] = c;
    m->n++;
}

static const Card *map_get(const Map *m, const char *key) {
    if (!m->cap || !key) {
        return NULL;
    }
    unsigned i = hash(key) & (m->cap - 1);
    while (m->keys[i]) {
        if (!strcmp(m->keys[i], key)) {
            return m->vals[i];
        }
        i = (i + 1) & (m->cap - 1);
    }
    return NULL;
}

const Card *card_by_set(const char *set) { return map_get(&by_set, set); }
const Card *card_by_internal(const char *name) { return map_get(&by_internal, name); }
const Card *card_by_title(const char *title) { return map_get(&by_title, title); }

/* ---------- loading ---------- */

static char *read_file(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) {
        return NULL;
    }
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *buf = malloc((size_t)n + 1);
    if (buf && fread(buf, 1, (size_t)n, f) != (size_t)n) {
        free(buf);
        buf = NULL;
    }
    fclose(f);
    if (buf) {
        buf[n] = '\0';
    }
    return buf;
}

/* "Raid 2" -> 2 (the number after the keyword at the start of a line of rules text) */
static int keyword_amount(const char *text, const char *kw) {
    size_t k = strlen(kw);
    for (const char *p = text; p && *p; p = strchr(p, '\n') ? strchr(p, '\n') + 1 : NULL) {
        if (!strncmp(p, kw, k) && p[k] == ' ') {
            return atoi(p + k + 1);
        }
    }
    return 0;
}

static const char *ASPECTS[ASP_N] = { "vigilance", "command", "aggression", "cunning", "villainy", "heroism" };
static const struct { const char *name; unsigned bit; } KEYWORDS[] = {
    { "sentinel", K_SENTINEL }, { "raid", K_RAID }, { "overwhelm", K_OVERWHELM }, { "ambush", K_AMBUSH },
    { "restore", K_RESTORE }, { "saboteur", K_SABOTEUR }, { "hidden", K_HIDDEN }, { "shielded", K_SHIELDED },
    { "grit", K_GRIT }, { "piloting", K_PILOTING }, { "smuggle", K_SMUGGLE }, { "bounty", K_BOUNTY },
    { "plot", K_PLOT }, { "support", K_SUPPORT }, { "coordinate", K_COORDINATE }, { "exploit", K_EXPLOIT },
    { "fortify", K_FORTIFY },
};
static const struct { const char *name; int bit; } TYPES[] = {
    { "unit", T_UNIT }, { "event", T_EVENT }, { "upgrade", T_UPGRADE }, { "leader", T_LEADER }, { "base", T_BASE },
    { "token", T_TOKEN },
};

static void add_card(JVal *j) {
    Card *c = calloc(1, sizeof *c);
    c->title = strdup(jstr(jget(j, "title"), ""));
    c->internal = strdup(jstr(jget(j, "internalName"), ""));
    c->text = strdup(jstr(jget(j, "text"), ""));
    c->cost = jint(jget(j, "cost"), 0);
    c->power = jint(jget(j, "power"), 0);
    c->hp = jint(jget(j, "hp"), 0);
    c->upPower = jint(jget(j, "upgradePower"), 0);
    c->upHp = jint(jget(j, "upgradeHp"), 0);
    c->space = !strcmp(jstr(jget(j, "arena"), ""), "space");
    c->unique = jtrue(jget(j, "unique"));
    for (JVal *t = jget(j, "types") ? jget(j, "types")->child : NULL; t; t = t->next) {
        for (size_t k = 0; k < sizeof TYPES / sizeof *TYPES; k++) {
            if (!strcmp(jstr(t, ""), TYPES[k].name)) {
                c->types |= TYPES[k].bit;
            }
        }
    }
    for (JVal *a = jget(j, "aspects") ? jget(j, "aspects")->child : NULL; a; a = a->next) {
        for (int k = 0; k < ASP_N; k++) {
            if (!strcmp(jstr(a, ""), ASPECTS[k])) {
                c->aspects[k]++;
            }
        }
    }
    for (JVal *k = jget(j, "keywords") ? jget(j, "keywords")->child : NULL; k; k = k->next) {
        for (size_t q = 0; q < sizeof KEYWORDS / sizeof *KEYWORDS; q++) {
            if (!strcmp(jstr(k, ""), KEYWORDS[q].name)) {
                c->kw |= KEYWORDS[q].bit;
            }
        }
    }
    if (c->kw & K_RAID) {
        c->raid = keyword_amount(c->text, "Raid");
    }
    if (c->kw & K_RESTORE) {
        c->restore = keyword_amount(c->text, "Restore");
    }
    for (JVal *s = jget(j, "setCodes") ? jget(j, "setCodes")->child : NULL; s; s = s->next) {
        char key[32];
        snprintf(key, sizeof key, "%s_%03d", jstr(jget(s, "set"), "?"), jint(jget(s, "number"), 0));
        map_put(&by_set, key, c);
    }
    map_put(&by_internal, c->internal, c);
    map_put(&by_title, c->title, c);
}

int cards_load(const char *dir) {
    DIR *d = opendir(dir);
    if (!d) {
        return -1;
    }
    Arena a;
    arena_init(&a, 1 << 20);
    int n = 0;
    struct dirent *e;
    char path[4096];
    while ((e = readdir(d))) {
        size_t len = strlen(e->d_name);
        /* skip _cardMap.json and friends */
        if (len < 6 || strcmp(e->d_name + len - 5, ".json") || e->d_name[0] == '_') {
            continue;
        }
        snprintf(path, sizeof path, "%s/%s", dir, e->d_name);
        char *text = read_file(path);
        if (!text) {
            continue;
        }
        JVal *j = json_parse(text, &a);
        if (j && j->t == J_OBJ) {
            add_card(j);
            n++;
        }
        free(text);
        arena_reset(&a);
    }
    closedir(d);
    return n;
}
