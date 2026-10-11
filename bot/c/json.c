#include "json.h"

#include <stdlib.h>
#include <string.h>

/* ---------- arena: a chain of blocks, so pointers stay valid as it grows ---------- */

typedef struct Block {
    struct Block *prev;
    size_t cap, used;
    char data[];
} Block;

void arena_init(Arena *a, size_t cap) {
    a->buf = NULL;
    a->cap = cap;
    a->used = 0;
}

void *arena_alloc(Arena *a, size_t n) {
    n = (n + 15) & ~(size_t)15;
    Block *b = (Block *)a->buf;
    if (!b || b->used + n > b->cap) {
        size_t cap = n > a->cap ? n : a->cap;
        Block *nb = malloc(sizeof(Block) + cap);
        if (!nb) {
            abort();
        }
        nb->prev = b;
        nb->cap = cap;
        nb->used = 0;
        a->buf = (char *)nb;
        b = nb;
    }
    void *p = b->data + b->used;
    b->used += n;
    a->used += n;
    return p;
}

void arena_reset(Arena *a) {
    Block *b = (Block *)a->buf;
    /* keep the newest block for reuse, free the rest */
    if (b) {
        Block *p = b->prev;
        while (p) {
            Block *q = p->prev;
            free(p);
            p = q;
        }
        b->prev = NULL;
        b->used = 0;
    }
    a->used = 0;
}

/* ---------- parser ---------- */

typedef struct {
    char *p;
    Arena *a;
    int err;
} P;

static void ws(P *s) {
    while (*s->p == ' ' || *s->p == '\t' || *s->p == '\n' || *s->p == '\r') {
        s->p++;
    }
}

static JVal *node(P *s, JType t) {
    JVal *v = arena_alloc(s->a, sizeof(JVal));
    memset(v, 0, sizeof *v);
    v->t = t;
    return v;
}

static int hex4(const char *h, unsigned *out) {
    unsigned v = 0;
    for (int i = 0; i < 4; i++) {
        char c = h[i];
        v <<= 4;
        if (c >= '0' && c <= '9') v |= (unsigned)(c - '0');
        else if (c >= 'a' && c <= 'f') v |= (unsigned)(c - 'a' + 10);
        else if (c >= 'A' && c <= 'F') v |= (unsigned)(c - 'A' + 10);
        else return 0;
    }
    *out = v;
    return 1;
}

static char *utf8(char *w, unsigned cp) {
    if (cp < 0x80) {
        *w++ = (char)cp;
    } else if (cp < 0x800) {
        *w++ = (char)(0xC0 | (cp >> 6));
        *w++ = (char)(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
        *w++ = (char)(0xE0 | (cp >> 12));
        *w++ = (char)(0x80 | ((cp >> 6) & 0x3F));
        *w++ = (char)(0x80 | (cp & 0x3F));
    } else {
        *w++ = (char)(0xF0 | (cp >> 18));
        *w++ = (char)(0x80 | ((cp >> 12) & 0x3F));
        *w++ = (char)(0x80 | ((cp >> 6) & 0x3F));
        *w++ = (char)(0x80 | (cp & 0x3F));
    }
    return w;
}

/* Decodes the string at s->p (just after the opening quote) in place; the decoded form is never longer. */
static char *str(P *s) {
    char *start = s->p, *w = s->p;
    for (;;) {
        char c = *s->p;
        if (c == '\0') {
            s->err = 1;
            return NULL;
        }
        s->p++;
        if (c == '"') {
            break;
        }
        if (c != '\\') {
            *w++ = c;
            continue;
        }
        char e = *s->p++;
        switch (e) {
        case '"': *w++ = '"'; break;
        case '\\': *w++ = '\\'; break;
        case '/': *w++ = '/'; break;
        case 'b': *w++ = '\b'; break;
        case 'f': *w++ = '\f'; break;
        case 'n': *w++ = '\n'; break;
        case 'r': *w++ = '\r'; break;
        case 't': *w++ = '\t'; break;
        case 'u': {
            unsigned cp, lo;
            if (!hex4(s->p, &cp)) {
                s->err = 1;
                return NULL;
            }
            s->p += 4;
            if (cp >= 0xD800 && cp < 0xDC00 && s->p[0] == '\\' && s->p[1] == 'u' && hex4(s->p + 2, &lo) && lo >= 0xDC00 && lo < 0xE000) {
                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                s->p += 6;
            }
            w = utf8(w, cp);
            break;
        }
        default:
            s->err = 1;
            return NULL;
        }
    }
    *w = '\0';
    return start;
}

static JVal *value(P *s, int depth);

static JVal *container(P *s, int depth, int obj) {
    JVal *v = node(s, obj ? J_OBJ : J_ARR);
    JVal **tail = &v->child;
    s->p++;
    ws(s);
    if (*s->p == (obj ? '}' : ']')) {
        s->p++;
        return v;
    }
    for (;;) {
        char *key = NULL;
        if (obj) {
            ws(s);
            if (*s->p != '"') {
                s->err = 1;
                return NULL;
            }
            s->p++;
            key = str(s);
            if (!key) {
                return NULL;
            }
            ws(s);
            if (*s->p != ':') {
                s->err = 1;
                return NULL;
            }
            s->p++;
        }
        JVal *c = value(s, depth + 1);
        if (!c) {
            return NULL;
        }
        c->key = key;
        *tail = c;
        tail = &c->next;
        v->n++;
        ws(s);
        if (*s->p == ',') {
            s->p++;
            continue;
        }
        if (*s->p == (obj ? '}' : ']')) {
            s->p++;
            return v;
        }
        s->err = 1;
        return NULL;
    }
}

static JVal *value(P *s, int depth) {
    if (depth > 200) {
        s->err = 1;
        return NULL;
    }
    ws(s);
    char c = *s->p;
    if (c == '{' || c == '[') {
        return container(s, depth, c == '{');
    }
    if (c == '"') {
        s->p++;
        JVal *v = node(s, J_STR);
        v->str = str(s);
        return v->str ? v : NULL;
    }
    if (!strncmp(s->p, "true", 4)) {
        s->p += 4;
        return node(s, J_TRUE);
    }
    if (!strncmp(s->p, "false", 5)) {
        s->p += 5;
        return node(s, J_FALSE);
    }
    if (!strncmp(s->p, "null", 4)) {
        s->p += 4;
        return node(s, J_NULL);
    }
    if (c == '-' || (c >= '0' && c <= '9')) {
        char *end;
        double d = strtod(s->p, &end);
        if (end == s->p) {
            s->err = 1;
            return NULL;
        }
        s->p = end;
        JVal *v = node(s, J_NUM);
        v->num = d;
        return v;
    }
    s->err = 1;
    return NULL;
}

JVal *json_parse(char *text, Arena *a) {
    P s = { text, a, 0 };
    JVal *v = value(&s, 0);
    if (!v || s.err) {
        return NULL;
    }
    ws(&s);
    return *s.p ? NULL : v;
}

/* ---------- access ---------- */

JVal *jget(const JVal *obj, const char *key) {
    if (!obj || obj->t != J_OBJ) {
        return NULL;
    }
    for (JVal *c = obj->child; c; c = c->next) {
        if (!strcmp(c->key, key)) {
            return c;
        }
    }
    return NULL;
}

JVal *jat(const JVal *arr, int i) {
    if (!arr || (arr->t != J_ARR && arr->t != J_OBJ) || i < 0) {
        return NULL;
    }
    JVal *c = arr->child;
    while (c && i--) {
        c = c->next;
    }
    return c;
}

double jnum(const JVal *v, double def) {
    return v && v->t == J_NUM ? v->num : def;
}

int jint(const JVal *v, int def) {
    return v && v->t == J_NUM ? (int)v->num : def;
}

const char *jstr(const JVal *v, const char *def) {
    return v && v->t == J_STR ? v->str : def;
}

int jtrue(const JVal *v) {
    return v && (v->t == J_TRUE || (v->t == J_NUM && v->num != 0));
}
