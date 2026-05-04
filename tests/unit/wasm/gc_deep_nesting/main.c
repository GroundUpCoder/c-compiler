#include <stdio.h>

__struct Pt { int x; int y; };
__struct Row { __array(__struct Pt) cells; };
__struct Grid { __array(__struct Row) rows; };

int main(void) {
  __struct Grid g = __new(__struct Grid);
  g.rows = __new(__array(__struct Row), 2);
  for (int r = 0; r < __array_len(g.rows); r++) {
    g.rows[r] = __new(__struct Row);
    g.rows[r].cells = __new(__array(__struct Pt), 3);
    for (int c = 0; c < __array_len(g.rows[r].cells); c++) {
      g.rows[r].cells[c] = __new(__struct Pt, r, c);
    }
  }
  for (int r = 0; r < __array_len(g.rows); r++) {
    for (int c = 0; c < __array_len(g.rows[r].cells); c++) {
      printf("(%d,%d) ", g.rows[r].cells[c].x, g.rows[r].cells[c].y);
    }
    printf("\n");
  }
  return 0;
}
