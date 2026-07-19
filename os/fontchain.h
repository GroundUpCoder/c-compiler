/* fontchain.h — the font fallback chain's CONFIG loader, one mechanism in
 * one place (gucOS Unicode Phase D, W7; the openwith.h/cfgstore.h
 * precedent). Consumed by BOTH glyph caches — gdi32's font_glyph and
 * term's cp_glyph — so the chrome, the win32 apps and the terminal agree
 * on coverage.
 *
 * The chain: face 0 is always the baked/user mono face (/etc/fonts/
 * mono.ttf > /usr/share/fonts/mono.ttf — the pre-existing override pair);
 * faces 1..n come from the overlay list loaded here. A code point probes
 * the chain in order (FT_Get_Char_Index until nonzero) and renders from
 * the first face that has it, else the synthesized tofu box. With no
 * config present the chain is just [face 0] and behavior is identical to
 * the single-face world (no regression; CJK is honest tofu until a font
 * package is installed).
 *
 * Store: /etc/fonts/fallback > /usr/share/fonts/fallback — one ABSOLUTE
 * face path per line, '#' comments. Both layers CONCATENATE (/etc lines
 * first = higher probe precedence, the cfgstore layering rule adapted to
 * a list file: an /etc file extends rather than shadows the baked list),
 * duplicates dropped. gucman font packages append/remove their /opt face
 * lines in the /etc layer on install/remove.
 *
 * Faces are opened LAZILY by the consumers (only when a code point misses
 * face 0), so processes that never draw exotic text never pay the load.
 * The list is read ONCE per process at first glyph-cache init: a package
 * install reaches newly started apps, not already-running ones (matches
 * the openwith/sounds config-read-at-use discipline at process grain). */
#ifndef FONTCHAIN_H
#define FONTCHAIN_H

#include <stdio.h>
#include <string.h>

#define FC_MAX_FALLBACKS 8
#define FC_PATH_MAX      256
#define FC_ETC_LIST      "/etc/fonts/fallback"
#define FC_BAKED_LIST    "/usr/share/fonts/fallback"

/* Load the fallback face path list (face 0 NOT included) into
 * paths[0..max-1]; returns the count. Missing layers are the normal
 * case; malformed (overlong / relative) lines are skipped. */
static int fc_load(char paths[][FC_PATH_MAX], int max) {
    static const char *layers[2] = { FC_ETC_LIST, FC_BAKED_LIST };
    int n = 0;
    for (int li = 0; li < 2 && n < max; li++) {
        FILE *f = fopen(layers[li], "r");
        if (!f) continue;
        char line[FC_PATH_MAX + 64];
        while (n < max && fgets(line, sizeof line, f)) {
            char *s = line;
            while (*s == ' ' || *s == '\t') s++;
            size_t len = strlen(s);
            while (len && (s[len - 1] == '\n' || s[len - 1] == '\r' ||
                           s[len - 1] == ' ' || s[len - 1] == '\t'))
                s[--len] = 0;
            if (!len || *s == '#' || *s != '/' || len >= FC_PATH_MAX)
                continue;                     /* comment / blank / not absolute */
            int dup = 0;
            for (int i = 0; i < n && !dup; i++)
                dup = strcmp(paths[i], s) == 0;
            if (!dup) snprintf(paths[n++], FC_PATH_MAX, "%s", s);
        }
        fclose(f);
    }
    return n;
}

#endif /* FONTCHAIN_H */
