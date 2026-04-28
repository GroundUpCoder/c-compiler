#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <termios.h>
#include <sys/ioctl.h>
#include <sys/select.h>
#include <unistd.h>

#define MAX_SNAKE 1000
#define INITIAL_LEN 5

static struct termios orig_termios;
static int rows, cols;
static int snake_x[MAX_SNAKE], snake_y[MAX_SNAKE];
static int snake_len;
static int dir_x, dir_y;
static int food_x, food_y;
static int score;
static int game_over;
static unsigned int rng_state;

static unsigned int xorshift(void) {
    rng_state ^= rng_state << 13;
    rng_state ^= rng_state >> 17;
    rng_state ^= rng_state << 5;
    return rng_state;
}

static void get_terminal_size(void) {
    struct winsize ws;
    if (ioctl(STDOUT_FILENO, TIOCGWINSZ, (void *)&ws) == 0) {
        rows = ws.ws_row;
        cols = ws.ws_col;
    } else {
        rows = 24;
        cols = 80;
    }
}

static void enable_raw_mode(void) {
    tcgetattr(STDIN_FILENO, &orig_termios);
    struct termios raw = orig_termios;
    cfmakeraw(&raw);
    tcsetattr(STDIN_FILENO, TCSANOW, &raw);
}

static void disable_raw_mode(void) {
    tcsetattr(STDIN_FILENO, TCSANOW, &orig_termios);
}

static void write_str(const char *s) {
    write(STDOUT_FILENO, s, strlen(s));
}

static void move_cursor(int r, int c) {
    char buf[32];
    int n = 0;
    buf[n++] = '\033';
    buf[n++] = '[';
    int tmp = r;
    if (tmp >= 100) { buf[n++] = '0' + tmp / 100; tmp %= 100; buf[n++] = '0' + tmp / 10; tmp %= 10; }
    else if (tmp >= 10) { buf[n++] = '0' + tmp / 10; tmp %= 10; }
    buf[n++] = '0' + tmp;
    buf[n++] = ';';
    tmp = c;
    if (tmp >= 100) { buf[n++] = '0' + tmp / 100; tmp %= 100; buf[n++] = '0' + tmp / 10; tmp %= 10; }
    else if (tmp >= 10) { buf[n++] = '0' + tmp / 10; tmp %= 10; }
    buf[n++] = '0' + tmp;
    buf[n++] = 'H';
    buf[n] = 0;
    write_str(buf);
}

static void hide_cursor(void) { write_str("\033[?25l"); }
static void show_cursor(void) { write_str("\033[?25h"); }
static void clear_screen(void) { write_str("\033[2J"); }

static void place_food(void) {
    int attempts = 0;
    for (;;) {
        food_x = 2 + (int)(xorshift() % (unsigned)(cols - 2));
        food_y = 2 + (int)(xorshift() % (unsigned)(rows - 3));
        int on_snake = 0;
        for (int i = 0; i < snake_len; i++) {
            if (snake_x[i] == food_x && snake_y[i] == food_y) { on_snake = 1; break; }
        }
        if (!on_snake) break;
        if (++attempts > 10000) break;
    }
}

static void draw_border(void) {
    write_str("\033[36m");
    for (int c = 1; c <= cols; c++) {
        move_cursor(1, c); write_str("-");
        move_cursor(rows - 1, c); write_str("-");
    }
    for (int r = 1; r <= rows - 1; r++) {
        move_cursor(r, 1); write_str("|");
        move_cursor(r, cols); write_str("|");
    }
    write_str("\033[0m");
}

static void draw_score(void) {
    move_cursor(rows, 1);
    write_str("\033[33m");
    char buf[64];
    int n = 0;
    n += sprintf(buf + n, " Score: %d ", score);
    n += sprintf(buf + n, " | Arrow keys to move | q to quit ");
    write(STDOUT_FILENO, buf, n);
    write_str("\033[0m");
}

static void draw_food(void) {
    move_cursor(food_y, food_x);
    write_str("\033[31m*\033[0m");
}

static void draw_snake(void) {
    move_cursor(snake_y[0], snake_x[0]);
    write_str("\033[32m@\033[0m");
    for (int i = 1; i < snake_len; i++) {
        move_cursor(snake_y[i], snake_x[i]);
        write_str("\033[32mo\033[0m");
    }
}

static void init_game(void) {
    score = 0;
    game_over = 0;
    snake_len = INITIAL_LEN;
    dir_x = 1;
    dir_y = 0;
    int start_x = cols / 2;
    int start_y = rows / 2;
    for (int i = 0; i < snake_len; i++) {
        snake_x[i] = start_x - i;
        snake_y[i] = start_y;
    }
    place_food();
    clear_screen();
    draw_border();
    draw_food();
    draw_snake();
    draw_score();
}

static int poll_key(int *out_dx, int *out_dy) {
    char buf[8];
    long n = read(STDIN_FILENO, buf, sizeof(buf));
    if (n <= 0) return 0;
    for (long i = 0; i < n; i++) {
        if (buf[i] == 'q' || buf[i] == 'Q') { game_over = 1; return 1; }
        if (buf[i] == '\033' && i + 2 < n && buf[i+1] == '[') {
            char arrow = buf[i+2];
            i += 2;
            if (arrow == 'A' && dir_y != 1) { *out_dx = 0; *out_dy = -1; return 1; }
            if (arrow == 'B' && dir_y != -1) { *out_dx = 0; *out_dy = 1; return 1; }
            if (arrow == 'C' && dir_x != -1) { *out_dx = 1; *out_dy = 0; return 1; }
            if (arrow == 'D' && dir_x != 1) { *out_dx = -1; *out_dy = 0; return 1; }
        }
        if (buf[i] == 'w' || buf[i] == 'k') { if (dir_y != 1) { *out_dx = 0; *out_dy = -1; return 1; } }
        if (buf[i] == 's' || buf[i] == 'j') { if (dir_y != -1) { *out_dx = 0; *out_dy = 1; return 1; } }
        if (buf[i] == 'd' || buf[i] == 'l') { if (dir_x != -1) { *out_dx = 1; *out_dy = 0; return 1; } }
        if (buf[i] == 'a' || buf[i] == 'h') { if (dir_x != 1) { *out_dx = -1; *out_dy = 0; return 1; } }
    }
    return 0;
}

static void step(void) {
    int new_x = snake_x[0] + dir_x;
    int new_y = snake_y[0] + dir_y;

    if (new_x <= 1 || new_x >= cols || new_y <= 1 || new_y >= rows - 1) {
        game_over = 1;
        return;
    }

    for (int i = 0; i < snake_len; i++) {
        if (snake_x[i] == new_x && snake_y[i] == new_y) {
            game_over = 1;
            return;
        }
    }

    int ate = (new_x == food_x && new_y == food_y);

    if (!ate) {
        move_cursor(snake_y[snake_len - 1], snake_x[snake_len - 1]);
        write_str(" ");
    }

    if (!ate) {
        for (int i = snake_len - 1; i > 0; i--) {
            snake_x[i] = snake_x[i-1];
            snake_y[i] = snake_y[i-1];
        }
    } else {
        if (snake_len < MAX_SNAKE) {
            for (int i = snake_len; i > 0; i--) {
                snake_x[i] = snake_x[i-1];
                snake_y[i] = snake_y[i-1];
            }
            snake_len++;
        } else {
            for (int i = snake_len - 1; i > 0; i--) {
                snake_x[i] = snake_x[i-1];
                snake_y[i] = snake_y[i-1];
            }
        }
        score += 10;
        place_food();
        draw_food();
        draw_score();
    }

    snake_x[0] = new_x;
    snake_y[0] = new_y;

    draw_snake();
}

int main(void) {
    rng_state = 42;

    get_terminal_size();
    if (rows < 10 || cols < 20) {
        printf("Terminal too small (need at least 20x10, got %dx%d)\n", cols, rows);
        return 1;
    }

    enable_raw_mode();
    hide_cursor();
    init_game();

    while (!game_over) {
        fd_set rfds;
        struct timeval tv;
        FD_ZERO(&rfds);
        FD_SET(STDIN_FILENO, &rfds);
        tv.tv_sec = 0;
        tv.tv_usec = 100000;

        int ret = select(STDIN_FILENO + 1, &rfds, NULL, NULL, &tv);
        if (ret > 0 && FD_ISSET(STDIN_FILENO, &rfds)) {
            int new_dx = dir_x, new_dy = dir_y;
            poll_key(&new_dx, &new_dy);
            dir_x = new_dx;
            dir_y = new_dy;
        }
        step();
    }

    move_cursor(rows / 2, cols / 2 - 5);
    write_str("\033[1;31m GAME OVER \033[0m");
    move_cursor(rows / 2 + 1, cols / 2 - 7);
    char score_buf[32];
    sprintf(score_buf, " Final Score: %d ", score);
    write_str("\033[1;33m");
    write_str(score_buf);
    write_str("\033[0m");

    move_cursor(rows / 2 + 3, cols / 2 - 10);
    write_str("Press q to exit...");

    char c;
    do {
        read(STDIN_FILENO, &c, 1);
    } while (c != 'q' && c != 'Q');

    show_cursor();
    clear_screen();
    move_cursor(1, 1);
    disable_raw_mode();
    return 0;
}
