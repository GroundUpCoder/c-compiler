#include <stdio.h>

__struct Point { int x; int y; };
__struct Animal { int id; };
__struct Dog {
  __extends(__struct Animal);
  int id;
  int paws;
};

__struct Point make_point(int a, int b) {
  return __new(__struct Point, a, b);
}

int main(void) {
  // Inferred GC struct ref
  auto p = __new(__struct Point, 7, 11);
  printf("%d %d\n", p.x, p.y);

  // Inferred from function return
  auto p2 = make_point(3, 4);
  printf("%d %d\n", p2.x, p2.y);

  // Inferred GC array ref
  auto arr = __new_array(int, 10, 20, 30, 40, 50);
  for (int i = 0; i < __array_len(arr); i++) printf("%d ", arr[i]);
  printf("\n");

  // Default-init array
  auto buf = __new(__array(int), 4);
  for (int i = 0; i < __array_len(buf); i++) printf("%d ", buf[i]);
  printf("\n");

  // Field access on inferred type
  auto e = arr[2];
  printf("%d\n", e);

  // Struct of GC type via auto + field access
  auto fst = arr[0];
  printf("%d\n", fst);

  // GC ref with inheritance
  auto d = __new(__struct Dog, 99, 4);
  printf("%d %d\n", d.id, d.paws);

  // Cast result via __ref_cast
  __struct Animal a = d;
  auto downcast = __ref_cast(__struct Dog, a);
  printf("%d %d\n", downcast.id, downcast.paws);

  // anyref / extern bridge with auto
  auto ext = __ref_as_extern(p);
  printf("ext null: %d\n", __ref_is_null(ext));
  auto any = __ref_as_any(ext);
  printf("any is Point: %d\n", __ref_test(__struct Point, any));

  return 0;
}
