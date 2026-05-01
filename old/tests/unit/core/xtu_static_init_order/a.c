/* TU A: references &b_var before TU B defines it */
extern int b_var;
static int *table[] = { &b_var };

int check_table(void) {
    return *table[0];
}
