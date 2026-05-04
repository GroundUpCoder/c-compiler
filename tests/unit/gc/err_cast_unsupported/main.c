int main(void) {
  __externref e = __cast(__externref, 42);  // prim → externref not supported
  return 0;
}
