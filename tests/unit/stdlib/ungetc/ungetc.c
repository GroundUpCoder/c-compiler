#include <stdio.h>
#include <string.h>

int main() {
  /* Test 1: Basic pushback with fgetc */
  {
    FILE *f = fopen("tests/unit/stdlib/ungetc/ungetc.c", "r");
    int c1 = fgetc(f);
    int c2 = fgetc(f);
    ungetc(c2, f);
    int c3 = fgetc(f);
    printf("test1: c2=%c c3=%c same=%d\n", c2, c3, c2 == c3);
    fclose(f);
  }

  /* Test 2: ungetc(EOF) is a no-op returning EOF */
  {
    FILE *f = fopen("tests/unit/stdlib/ungetc/ungetc.c", "r");
    int r = ungetc(EOF, f);
    printf("test2: r=%d\n", r);
    int c = fgetc(f);
    printf("test2: first_char=%c\n", c);
    fclose(f);
  }

  /* Test 3: Pushback clears EOF flag */
  {
    FILE *f = fopen("tests/unit/stdlib/ungetc/ungetc.c", "r");
    /* Read to EOF */
    while (fgetc(f) != EOF) {}
    printf("test3: eof_before=%d\n", feof(f));
    ungetc('Z', f);
    printf("test3: eof_after=%d\n", feof(f));
    int c = fgetc(f);
    printf("test3: c=%c\n", c);
    fclose(f);
  }

  /* Test 4: Pushback works with fgets */
  {
    FILE *f = fopen("tests/unit/stdlib/ungetc/ungetc.c", "r");
    fgetc(f); /* skip '#' */
    ungetc('X', f);
    char buf[8];
    fgets(buf, 8, f);
    printf("test4: buf=%s\n", buf);
    fclose(f);
  }

  /* Test 5: Pushback works with fread */
  {
    FILE *f = fopen("tests/unit/stdlib/ungetc/ungetc.c", "r");
    fgetc(f); /* skip '#' */
    ungetc('Y', f);
    char buf[4];
    size_t n = fread(buf, 1, 3, f);
    buf[n] = '\0';
    printf("test5: n=%d buf=%s\n", (int)n, buf);
    fclose(f);
  }

  /* Test 6: fseek discards pushback */
  {
    FILE *f = fopen("tests/unit/stdlib/ungetc/ungetc.c", "r");
    fgetc(f); /* skip '#' */
    ungetc('Q', f);
    fseek(f, 0, SEEK_SET);
    int c = fgetc(f);
    printf("test6: c=%c\n", c);
    fclose(f);
  }

  return 0;
}
