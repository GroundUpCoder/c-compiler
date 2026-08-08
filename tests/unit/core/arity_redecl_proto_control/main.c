// BUG: ticket #127 positive control — table row 2: the same call with only the
// prototyped declaration produces the precise wording; the re-declaration
// spellings must match it byte for byte.
extern int f(int x);
int main(void) { return f(1, 2, 3); }
