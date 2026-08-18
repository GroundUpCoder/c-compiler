#ifndef GUCEDIT_H
#define GUCEDIT_H

#include <stdint.h>
#include <stddef.h>
#ifdef GUCEDIT_STANDALONE
#define WM_USER 0x0400u
#else
#include <windows.h>
#endif

#define GUCEDIT_ABI_VERSION 1u
#define GUCEDIT_ERROR_STALE_GENERATION 0x20000001u
#define GEM_SETSTYLES  (WM_USER + 0x180u)
#define GEM_CLEARSTYLES (WM_USER + 0x181u)
#define GEM_GETTEXTGEN (WM_USER + 0x182u)

#define GUES_BG_VALID  0x00000001u
#define GUES_UNDERLINE 0x00000002u
#define GUES_BOX       0x00000004u
#define GUES_VALID_MASK 0x00000007u
#define GUCEDIT_MAX_STYLES 1048576u

typedef struct GUCEDIT_STYLE_V1 {
    uint32_t start;
    uint32_t end;
    uint32_t foreground;
    uint32_t background;
    uint32_t flags;
} GUCEDIT_STYLE_V1;

typedef struct GUCEDIT_BATCH_V1 {
    uint32_t size;
    uint32_t version;
    uint32_t text_generation;
    uint32_t count;
    GUCEDIT_STYLE_V1 styles[];
} GUCEDIT_BATCH_V1;

_Static_assert(sizeof(GUCEDIT_STYLE_V1) == 20, "gucedit style ABI");
_Static_assert(sizeof(GUCEDIT_BATCH_V1) == 16, "gucedit batch ABI");

#ifdef GUCEDIT_TEST
void gucedit_test_fail_alloc_after(int calls);
#endif

enum { GUCEDIT_CHECK_OK, GUCEDIT_CHECK_INVALID, GUCEDIT_CHECK_STALE };
int gucedit_check_batch(const GUCEDIT_BATCH_V1 *b, const char *text,
                        uint32_t text_len, uint32_t generation);
typedef void *(*GUCEDIT_ALLOC_FN)(size_t);
int gucedit_replace_batch(GUCEDIT_BATCH_V1 **slot,
                          const GUCEDIT_BATCH_V1 *batch,
                          GUCEDIT_ALLOC_FN alloc_fn);

#endif
