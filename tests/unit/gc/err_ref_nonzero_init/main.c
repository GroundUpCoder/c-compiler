__struct A { int x; };
int main(void) {
  __struct A a = 5;  // only literal 0 / NULL allowed for ref init
  return 0;
}
