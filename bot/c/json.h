/* Small JSON reader: parses one document in place into a tree of nodes taken from an arena. */
#ifndef SWU_JSON_H
#define SWU_JSON_H

#include <stddef.h>

typedef enum { J_NULL, J_FALSE, J_TRUE, J_NUM, J_STR, J_ARR, J_OBJ } JType;

typedef struct JVal JVal;
struct JVal {
    JType t;
    double num;
    char *str;      /* J_STR: decoded, NUL-terminated (points into the parsed text) */
    char *key;      /* member name when the parent is an object */
    JVal *child;    /* first element / member */
    JVal *next;     /* next sibling */
    int n;          /* element / member count */
};

/* Bump allocator. json_parse and cards take nodes from it; arena_reset frees them all at once. */
typedef struct {
    char *buf;
    size_t cap, used;
} Arena;

void arena_init(Arena *a, size_t cap);
void *arena_alloc(Arena *a, size_t n);
void arena_reset(Arena *a);

/* Parses `text` (NUL-terminated, modified in place). Returns NULL on a syntax error. */
JVal *json_parse(char *text, Arena *a);

JVal *jget(const JVal *obj, const char *key);
JVal *jat(const JVal *arr, int i);
double jnum(const JVal *v, double def);
int jint(const JVal *v, int def);
const char *jstr(const JVal *v, const char *def);
int jtrue(const JVal *v); /* true, or a nonzero number */

#endif
