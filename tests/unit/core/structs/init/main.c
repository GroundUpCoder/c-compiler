#include <stdio.h>

// Basic struct
struct Point { int x; int y; };

// Struct with more members
struct Triple { int a; int b; int c; };

// Global struct initializers
struct Point gp = {10, 20};
struct Point pts[2] = {{100, 200}, {300, 400}};

// Partial initialization - remaining members should be zero
struct Point partial = {42};
struct Triple tripartial = {1, 2};

// Empty init - all zero
struct Point empty = {};

int main() {
  // Local struct initializers
  struct Point lp = {5, 6};
  struct Point lpts[2] = {{11, 22}, {33, 44}};

  // Local partial and empty
  struct Point lpartial = {99};
  struct Point lempty = {};

  // Test global structs
  printf("gp: %d %d\n", gp.x, gp.y);               // 10 20
  printf("pts[0]: %d %d\n", pts[0].x, pts[0].y);   // 100 200
  printf("pts[1]: %d %d\n", pts[1].x, pts[1].y);   // 300 400

  // Test partial/empty globals
  printf("partial: %d %d\n", partial.x, partial.y);       // 42 0
  printf("tripartial: %d %d %d\n", tripartial.a, tripartial.b, tripartial.c);  // 1 2 0
  printf("empty: %d %d\n", empty.x, empty.y);             // 0 0

  // Test local structs
  printf("lp: %d %d\n", lp.x, lp.y);               // 5 6
  printf("lpts[0]: %d %d\n", lpts[0].x, lpts[0].y); // 11 22
  printf("lpts[1]: %d %d\n", lpts[1].x, lpts[1].y); // 33 44

  // Test partial/empty locals
  printf("lpartial: %d %d\n", lpartial.x, lpartial.y);    // 99 0
  printf("lempty: %d %d\n", lempty.x, lempty.y);          // 0 0

  return 0;
}
