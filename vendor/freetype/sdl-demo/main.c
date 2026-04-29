#include <SDL.h>
#include <ft2build.h>
#include FT_FREETYPE_H

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define WIN_W      800
#define WIN_H      600
#define FONT_SIZE  22
#define PAD        16
#define MAX_TEXT   8192
#define CURSOR_BLINK_MS 530
#define SCROLL_LINES 3

static SDL_Window  *window;
static SDL_Surface *surface;
static FT_Library   ft_lib;
static FT_Face      face;

static char text[MAX_TEXT];
static int  text_len;
static int  cursor_pos;
static int  ctrl_held;
static int  alt_held;
static int  shift_held;
static int  sel_anchor;
static int  mouse_dragging;

static uint32_t pack_rgb(int r, int g, int b) {
    return (uint32_t)r | ((uint32_t)g << 8) | ((uint32_t)b << 16) | 0xFF000000u;
}

static uint32_t bg_color;
static uint32_t fg_color;
static uint32_t cursor_color;
static uint32_t line_num_color;
static uint32_t sel_color;

static int line_height;
static int ascender;
static int scroll_y;
static int last_cursor_pos;
static uint32_t cursor_blink_origin;

static int has_selection(void) {
    return sel_anchor >= 0 && sel_anchor != cursor_pos;
}

static int sel_min(void) {
    return sel_anchor < cursor_pos ? sel_anchor : cursor_pos;
}

static int sel_max(void) {
    return sel_anchor > cursor_pos ? sel_anchor : cursor_pos;
}

static void clear_selection(void) { sel_anchor = -1; }

static void begin_or_keep_selection(void) {
    if (sel_anchor < 0) sel_anchor = cursor_pos;
}

static void delete_selection(void) {
    if (!has_selection()) return;
    int lo = sel_min(), hi = sel_max();
    memmove(&text[lo], &text[hi], text_len - hi);
    text_len -= (hi - lo);
    text[text_len] = '\0';
    cursor_pos = lo;
    sel_anchor = -1;
}

static int char_is_printable(int sym) {
    return sym >= 32 && sym < 127;
}

static void insert_char(char ch) {
    if (has_selection()) delete_selection();
    if (text_len >= MAX_TEXT - 1) return;
    memmove(&text[cursor_pos + 1], &text[cursor_pos], text_len - cursor_pos);
    text[cursor_pos] = ch;
    text_len++;
    cursor_pos++;
    text[text_len] = '\0';
}

static void delete_back(void) {
    if (has_selection()) { delete_selection(); return; }
    if (cursor_pos <= 0) return;
    memmove(&text[cursor_pos - 1], &text[cursor_pos], text_len - cursor_pos);
    cursor_pos--;
    text_len--;
    text[text_len] = '\0';
}

static void delete_forward(void) {
    if (has_selection()) { delete_selection(); return; }
    if (cursor_pos >= text_len) return;
    memmove(&text[cursor_pos], &text[cursor_pos + 1], text_len - cursor_pos - 1);
    text_len--;
    text[text_len] = '\0';
}

static void cursor_home(void) {
    while (cursor_pos > 0 && text[cursor_pos - 1] != '\n')
        cursor_pos--;
}

static void cursor_end(void) {
    while (cursor_pos < text_len && text[cursor_pos] != '\n')
        cursor_pos++;
}

static int is_word_char(char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
           (c >= '0' && c <= '9') || c == '_';
}

static void word_back(void) {
    while (cursor_pos > 0 && !is_word_char(text[cursor_pos - 1]))
        cursor_pos--;
    while (cursor_pos > 0 && is_word_char(text[cursor_pos - 1]))
        cursor_pos--;
}

static void word_forward(void) {
    while (cursor_pos < text_len && !is_word_char(text[cursor_pos]))
        cursor_pos++;
    while (cursor_pos < text_len && is_word_char(text[cursor_pos]))
        cursor_pos++;
}

static void kill_to_end(void) {
    if (has_selection()) { delete_selection(); return; }
    int end = cursor_pos;
    while (end < text_len && text[end] != '\n') end++;
    if (end == cursor_pos && end < text_len) end++;
    int count = end - cursor_pos;
    memmove(&text[cursor_pos], &text[end], text_len - end);
    text_len -= count;
    text[text_len] = '\0';
}

static void kill_to_start(void) {
    if (has_selection()) { delete_selection(); return; }
    int start = cursor_pos;
    while (start > 0 && text[start - 1] != '\n') start--;
    int count = cursor_pos - start;
    memmove(&text[start], &text[cursor_pos], text_len - cursor_pos);
    text_len -= count;
    cursor_pos = start;
    text[text_len] = '\0';
}

static void kill_word_back(void) {
    if (has_selection()) { delete_selection(); return; }
    int orig = cursor_pos;
    while (cursor_pos > 0 && !is_word_char(text[cursor_pos - 1]))
        cursor_pos--;
    while (cursor_pos > 0 && is_word_char(text[cursor_pos - 1]))
        cursor_pos--;
    int count = orig - cursor_pos;
    memmove(&text[cursor_pos], &text[orig], text_len - orig);
    text_len -= count;
    text[text_len] = '\0';
}

static void kill_word_forward(void) {
    if (has_selection()) { delete_selection(); return; }
    int end = cursor_pos;
    while (end < text_len && !is_word_char(text[end])) end++;
    while (end < text_len && is_word_char(text[end])) end++;
    int count = end - cursor_pos;
    memmove(&text[cursor_pos], &text[end], text_len - end);
    text_len -= count;
    text[text_len] = '\0';
}

static void transpose_chars(void) {
    if (cursor_pos < 1 || cursor_pos >= text_len) return;
    char tmp = text[cursor_pos - 1];
    text[cursor_pos - 1] = text[cursor_pos];
    text[cursor_pos] = tmp;
    cursor_pos++;
}

static int render_glyph(unsigned char ch, int px, int py) {
    FT_UInt gi = FT_Get_Char_Index(face, ch);
    if (FT_Load_Glyph(face, gi, FT_LOAD_DEFAULT)) return 0;
    if (FT_Render_Glyph(face->glyph, FT_RENDER_MODE_NORMAL)) return 0;

    FT_GlyphSlot slot = face->glyph;
    FT_Bitmap *bmp = &slot->bitmap;
    int x0 = px + slot->bitmap_left;
    int y0 = py - slot->bitmap_top;

    uint32_t *pixels = (uint32_t *)surface->pixels;
    int sw = surface->w;
    int sh = surface->h;

    int fr = (fg_color >>  0) & 0xFF;
    int fg = (fg_color >>  8) & 0xFF;
    int fb = (fg_color >> 16) & 0xFF;

    for (int row = 0; row < (int)bmp->rows; row++) {
        int dy = y0 + row;
        if (dy < 0 || dy >= sh) continue;
        for (int col = 0; col < (int)bmp->width; col++) {
            int dx = x0 + col;
            if (dx < 0 || dx >= sw) continue;
            unsigned char alpha = bmp->buffer[row * bmp->pitch + col];
            if (alpha == 0) continue;
            int idx = dy * sw + dx;
            uint32_t bg = pixels[idx];
            int br = (bg >>  0) & 0xFF;
            int bgr = (bg >>  8) & 0xFF;
            int bb = (bg >> 16) & 0xFF;
            int r = br + (alpha * (fr - br) / 255);
            int g = bgr + (alpha * (fg - bgr) / 255);
            int b = bb + (alpha * (fb - bb) / 255);
            pixels[idx] = pack_rgb(r, g, b);
        }
    }
    return slot->advance.x >> 6;
}

static int glyph_advance(unsigned char ch) {
    FT_UInt gi = FT_Get_Char_Index(face, ch);
    if (FT_Load_Glyph(face, gi, FT_LOAD_DEFAULT)) return FONT_SIZE / 2;
    return face->glyph->advance.x >> 6;
}

static void fill_rect(int rx, int ry, int rw, int rh, uint32_t color) {
    uint32_t *pixels = (uint32_t *)surface->pixels;
    int sw = surface->w;
    int sh = surface->h;
    for (int y = ry; y < ry + rh; y++) {
        if (y < 0 || y >= sh) continue;
        for (int x = rx; x < rx + rw; x++) {
            if (x < 0 || x >= sw) continue;
            pixels[y * sw + x] = color;
        }
    }
}

static void render_small_text(const char *s, int px, int py) {
    uint32_t save_fg = fg_color;
    fg_color = line_num_color;
    for (int i = 0; s[i]; i++)
        px += render_glyph(s[i], px, py);
    fg_color = save_fg;
}

static int measure_visual_line(int start, int max_width) {
    int x = 0;
    int i = start;
    while (i < text_len) {
        if (text[i] == '\n') return i - start + 1;
        int adv = glyph_advance((unsigned char)text[i]);
        if (x + adv > max_width && i > start) break;
        x += adv;
        i++;
    }
    if (i == text_len) return i - start;
    return i - start;
}

static int click_to_pos(int click_x, int click_y) {
    int text_area_x = PAD + 50;
    int text_area_w = WIN_W - text_area_x - PAD;
    int text_offset = 0;
    int y = PAD + ascender - scroll_y;

    while (text_offset < text_len) {
        int line_chars = measure_visual_line(text_offset, text_area_w);
        if (line_chars == 0) line_chars = 1;
        int line_top = y - ascender;

        if (click_y >= line_top && click_y < line_top + line_height) {
            int is_hard_nl = (text_offset + line_chars <= text_len &&
                              line_chars > 0 &&
                              text[text_offset + line_chars - 1] == '\n');
            int draw_count = is_hard_nl ? line_chars - 1 : line_chars;
            int x = text_area_x;
            for (int i = 0; i < draw_count; i++) {
                int adv = glyph_advance((unsigned char)text[text_offset + i]);
                if (click_x < x + adv / 2) return text_offset + i;
                x += adv;
            }
            return text_offset + draw_count;
        }

        text_offset += line_chars;
        y += line_height;
    }
    if (click_y < PAD) return 0;
    return text_len;
}

static void render(void) {
    uint32_t *pixels = (uint32_t *)surface->pixels;
    for (int i = 0; i < surface->w * surface->h; i++)
        pixels[i] = bg_color;

    int text_area_x = PAD + 50;
    int text_area_w = WIN_W - text_area_x - PAD;

    int smin = has_selection() ? sel_min() : -1;
    int smax = has_selection() ? sel_max() : -1;

    int line_no = 1;
    int text_offset = 0;
    int y = PAD + ascender - scroll_y;
    int cursor_x = -1, cursor_y = -1;
    int cursor_found = 0;
    int last_line_end_x = text_area_x;
    int last_line_y = y;

    while (text_offset <= text_len) {
        if (text_offset == text_len) {
            if (cursor_pos == text_len && !cursor_found) {
                if (text_len == 0 || text[text_len - 1] == '\n') {
                    cursor_x = text_area_x;
                    cursor_y = y - ascender;
                } else {
                    cursor_x = last_line_end_x;
                    cursor_y = last_line_y - ascender;
                }
                cursor_found = 1;
            }
            break;
        }

        int line_chars = measure_visual_line(text_offset, text_area_w);
        if (line_chars == 0) line_chars = 1;

        int is_hard_newline = (text_offset + line_chars <= text_len &&
                               line_chars > 0 &&
                               text[text_offset + line_chars - 1] == '\n');
        int is_new_hard_line = (text_offset == 0 ||
                                (text_offset > 0 && text[text_offset - 1] == '\n'));
        int visible = (y + line_height > 0 && y - ascender < WIN_H);

        if (visible && is_new_hard_line) {
            char num_buf[8];
            int n = line_no;
            int len = 0;
            char tmp[8];
            if (n == 0) { tmp[len++] = '0'; }
            else { while (n > 0) { tmp[len++] = '0' + n % 10; n /= 10; } }
            for (int i = 0; i < len; i++) num_buf[i] = tmp[len - 1 - i];
            num_buf[len] = '\0';
            int num_x = PAD + 40 - len * glyph_advance('0');
            render_small_text(num_buf, num_x, y);
        }

        int x = text_area_x;
        int draw_count = is_hard_newline ? line_chars - 1 : line_chars;
        for (int i = 0; i < draw_count; i++) {
            int pos = text_offset + i;
            int adv = glyph_advance((unsigned char)text[pos]);

            if (visible && smin >= 0 && pos >= smin && pos < smax)
                fill_rect(x, y - ascender, adv, line_height, sel_color);

            if (pos == cursor_pos && !cursor_found) {
                cursor_x = x;
                cursor_y = y - ascender;
                cursor_found = 1;
            }

            if (visible)
                x += render_glyph((unsigned char)text[pos], x, y);
            else
                x += adv;
        }

        if (visible && is_hard_newline && smin >= 0) {
            int nl_pos = text_offset + line_chars - 1;
            if (nl_pos >= smin && nl_pos < smax)
                fill_rect(x, y - ascender, glyph_advance(' '), line_height, sel_color);
        }

        if (!cursor_found && cursor_pos == text_offset + draw_count) {
            if (is_hard_newline) {
                cursor_x = x;
                cursor_y = y - ascender;
                cursor_found = 1;
            }
        }
        last_line_end_x = x;
        last_line_y = y;

        if (is_new_hard_line) line_no++;
        text_offset += line_chars;
        y += line_height;
    }

    int cursor_moved = (cursor_pos != last_cursor_pos);
    if (cursor_moved) {
        cursor_blink_origin = SDL_GetTicks();
        last_cursor_pos = cursor_pos;
    }
    int blink = (((SDL_GetTicks() - cursor_blink_origin) / CURSOR_BLINK_MS) % 2 == 0);
    if (cursor_found && blink) {
        fill_rect(cursor_x, cursor_y + 2, 2, line_height - 4, cursor_color);
    }

    if (cursor_found && cursor_moved) {
        if (cursor_y < PAD) {
            scroll_y -= (PAD - cursor_y);
            if (scroll_y < 0) scroll_y = 0;
        } else if (cursor_y + line_height > WIN_H - PAD) {
            scroll_y += (cursor_y + line_height) - (WIN_H - PAD);
        }
    }

    fill_rect(text_area_x - 8, 0, 1, WIN_H, line_num_color);

    SDL_UpdateWindowSurface(window);
}

static void move_up(void) {
    int col = 0;
    int p = cursor_pos;
    while (p > 0 && text[p - 1] != '\n') { p--; col++; }
    if (p > 0) {
        p--;
        int prev_start = p;
        while (prev_start > 0 && text[prev_start - 1] != '\n') prev_start--;
        cursor_pos = prev_start;
        for (int i = 0; i < col && cursor_pos < p; i++) cursor_pos++;
    }
}

static void move_down(void) {
    int col = 0;
    int p = cursor_pos;
    while (p > 0 && text[p - 1] != '\n') { p--; col++; }
    int next = cursor_pos;
    while (next < text_len && text[next] != '\n') next++;
    if (next < text_len) {
        next++;
        cursor_pos = next;
        for (int i = 0; i < col && cursor_pos < text_len && text[cursor_pos] != '\n'; i++)
            cursor_pos++;
    }
}

static void handle_events(void) {
    SDL_Event ev;
    while (SDL_PollEvent(&ev)) {
        if (ev.type == SDL_QUIT) exit(0);

        if (ev.type == SDL_MOUSEWHEEL) {
            scroll_y += ev.wheel.y;
            if (scroll_y < 0) scroll_y = 0;
            mouse_dragging = 0;
            continue;
        }

        if (ev.type == SDL_MOUSEBUTTONDOWN && ev.button.button == SDL_BUTTON_LEFT) {
            int pos = click_to_pos(ev.button.x, ev.button.y);
            if (shift_held) {
                begin_or_keep_selection();
                cursor_pos = pos;
            } else {
                cursor_pos = pos;
                sel_anchor = pos;
                mouse_dragging = 1;
            }
            continue;
        }

        if (ev.type == SDL_MOUSEBUTTONUP && ev.button.button == SDL_BUTTON_LEFT) {
            mouse_dragging = 0;
            if (sel_anchor >= 0 && sel_anchor == cursor_pos)
                clear_selection();
            continue;
        }

        if (ev.type == SDL_MOUSEMOTION && mouse_dragging) {
            cursor_pos = click_to_pos(ev.motion.x, ev.motion.y);
            continue;
        }

        int sym = ev.key.keysym.sym;

        if (ev.type == SDL_KEYUP) {
            if (sym == SDLK_LCTRL || sym == SDLK_RCTRL) ctrl_held = 0;
            if (sym == SDLK_LALT || sym == SDLK_RALT) alt_held = 0;
            if (sym == SDLK_LSHIFT || sym == SDLK_RSHIFT) shift_held = 0;
            continue;
        }
        if (ev.type != SDL_KEYDOWN) continue;

        if (sym == SDLK_LCTRL || sym == SDLK_RCTRL) { ctrl_held = 1; continue; }
        if (sym == SDLK_LALT || sym == SDLK_RALT) { alt_held = 1; continue; }
        if (sym == SDLK_LSHIFT || sym == SDLK_RSHIFT) { shift_held = 1; continue; }

        if (alt_held) {
            if (sym == 'b') {
                if (shift_held) begin_or_keep_selection(); else clear_selection();
                word_back();
            } else if (sym == 'f') {
                if (shift_held) begin_or_keep_selection(); else clear_selection();
                word_forward();
            } else if (sym == 'd') {
                kill_word_forward();
            } else if (sym == SDLK_BACKSPACE) {
                kill_word_back();
            }
            continue;
        }

        if (ctrl_held) {
            if (sym == 'a') {
                if (shift_held) begin_or_keep_selection(); else clear_selection();
                cursor_home();
            } else if (sym == 'e') {
                if (shift_held) begin_or_keep_selection(); else clear_selection();
                cursor_end();
            } else if (sym == 'b') {
                if (shift_held) begin_or_keep_selection(); else clear_selection();
                if (cursor_pos > 0) cursor_pos--;
            } else if (sym == 'f') {
                if (shift_held) begin_or_keep_selection(); else clear_selection();
                if (cursor_pos < text_len) cursor_pos++;
            } else if (sym == 'p') {
                if (shift_held) begin_or_keep_selection(); else clear_selection();
                move_up();
            } else if (sym == 'n') {
                if (shift_held) begin_or_keep_selection(); else clear_selection();
                move_down();
            } else if (sym == 'd') {
                delete_forward();
                clear_selection();
            } else if (sym == 'h') {
                delete_back();
                clear_selection();
            } else if (sym == 'k') {
                kill_to_end();
                clear_selection();
            } else if (sym == 'u') {
                kill_to_start();
                clear_selection();
            } else if (sym == 'w') {
                kill_word_back();
                clear_selection();
            } else if (sym == 't') {
                transpose_chars();
                clear_selection();
            }
            continue;
        }

        if (sym == SDLK_RETURN) {
            insert_char('\n');
            clear_selection();
        } else if (sym == SDLK_BACKSPACE) {
            delete_back();
            clear_selection();
        } else if (sym == SDLK_DELETE) {
            delete_forward();
            clear_selection();
        } else if (sym == SDLK_LEFT) {
            if (shift_held) {
                begin_or_keep_selection();
                if (cursor_pos > 0) cursor_pos--;
            } else {
                if (has_selection()) { cursor_pos = sel_min(); clear_selection(); }
                else if (cursor_pos > 0) cursor_pos--;
            }
        } else if (sym == SDLK_RIGHT) {
            if (shift_held) {
                begin_or_keep_selection();
                if (cursor_pos < text_len) cursor_pos++;
            } else {
                if (has_selection()) { cursor_pos = sel_max(); clear_selection(); }
                else if (cursor_pos < text_len) cursor_pos++;
            }
        } else if (sym == SDLK_UP) {
            if (shift_held) { begin_or_keep_selection(); move_up(); }
            else { clear_selection(); move_up(); }
        } else if (sym == SDLK_DOWN) {
            if (shift_held) { begin_or_keep_selection(); move_down(); }
            else { clear_selection(); move_down(); }
        } else if (sym == SDLK_HOME) {
            if (shift_held) begin_or_keep_selection(); else clear_selection();
            cursor_home();
        } else if (sym == SDLK_END) {
            if (shift_held) begin_or_keep_selection(); else clear_selection();
            cursor_end();
        } else if (sym == SDLK_TAB) {
            for (int i = 0; i < 4; i++) insert_char(' ');
            clear_selection();
        } else if (char_is_printable(sym)) {
            insert_char((char)sym);
            clear_selection();
        }
    }
}

static void frame_callback(void) {
    handle_events();
    render();
}

int main(int argc, char **argv) {
    const char *font_path = "font.ttf";
    if (argc >= 2) font_path = argv[1];

    if (FT_Init_FreeType(&ft_lib)) {
        printf("FT_Init_FreeType failed\n");
        return 1;
    }
    if (FT_New_Face(ft_lib, font_path, 0, &face)) {
        printf("Cannot load font: %s\n", font_path);
        return 1;
    }
    FT_Set_Pixel_Sizes(face, 0, FONT_SIZE);

    line_height = (face->size->metrics.height >> 6);
    if (line_height < FONT_SIZE) line_height = FONT_SIZE + 4;
    ascender = face->size->metrics.ascender >> 6;

    bg_color       = pack_rgb(30, 30, 46);
    fg_color       = pack_rgb(205, 214, 244);
    cursor_color   = pack_rgb(245, 224, 220);
    line_num_color = pack_rgb(88, 91, 112);
    sel_color      = pack_rgb(69, 71, 99);

    sel_anchor = -1;

    const char *welcome =
        "FreeType + SDL text editor demo\n"
        "\n"
        "Type to edit. Arrow keys to move.\n"
        "Backspace/Delete, Home/End, Tab.\n"
        "Shift+arrows to select. Click to place cursor.\n"
        "Click and drag or shift+click to select with mouse.\n"
        "\n"
        "Lorem ipsum dolor sit amet, consectetur adipiscing\n"
        "elit, sed do eiusmod tempor incididunt ut labore et\n"
        "dolore magna aliqua. Ut enim ad minim veniam, quis\n"
        "nostrud exercitation ullamco laboris nisi ut aliquip\n"
        "ex ea commodo consequat.\n"
        "\n"
        "Duis aute irure dolor in reprehenderit in voluptate\n"
        "velit esse cillum dolore eu fugiat nulla pariatur.\n"
        "Excepteur sint occaecat cupidatat non proident, sunt\n"
        "in culpa qui officia deserunt mollit anim id est\n"
        "laborum.\n"
        "\n"
        "Sed ut perspiciatis unde omnis iste natus error sit\n"
        "voluptatem accusantium doloremque laudantium, totam\n"
        "rem aperiam, eaque ipsa quae ab illo inventore\n"
        "veritatis et quasi architecto beatae vitae dicta\n"
        "sunt explicabo.\n"
        "\n"
        "Nemo enim ipsam voluptatem quia voluptas sit\n"
        "aspernatur aut odit aut fugit, sed quia consequuntur\n"
        "magni dolores eos qui ratione voluptatem sequi\n"
        "nesciunt. Neque porro quisquam est, qui dolorem\n"
        "ipsum quia dolor sit amet.\n";
    text_len = strlen(welcome);
    memcpy(text, welcome, text_len);
    text[text_len] = '\0';
    cursor_pos = text_len;

    SDL_Init(SDL_INIT_VIDEO);
    window = SDL_CreateWindow("FreeType Editor", 0, 0, WIN_W, WIN_H, 0);
    surface = SDL_GetWindowSurface(window);

    printf("FreeType SDL editor ready (%dx%d, font size %d)\n", WIN_W, WIN_H, FONT_SIZE);

    __setAnimationFrameFunc(frame_callback);
    return 0;
}
