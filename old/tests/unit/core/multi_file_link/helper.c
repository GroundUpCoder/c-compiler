static int internal_counter = 0;

int shared_global = 42;

int add(int a, int b) {
  return a + b;
}

int get_counter() {
  return internal_counter;
}

void bump_counter() {
  internal_counter++;
}
