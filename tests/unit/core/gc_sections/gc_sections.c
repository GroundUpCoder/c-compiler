// If --gc-sections fails to strip the unreachable chain,
// the wasm module will fail to instantiate because
// 'nonexistent_import' doesn't exist in the host.
__import void nonexistent_import(void);

void unreachable_b(void);

void unreachable_a(void) {
  nonexistent_import();
  unreachable_b();
}

void unreachable_b(void) {
  unreachable_a();
}

int used_func(void) {
  return 42;
}

int main(void) {
  return used_func() - 42;
}
