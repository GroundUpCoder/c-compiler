#include <stdio.h>

#define LOG(msg) printf("%s:%d: %s\n", __FILE__, __LINE__, msg)

int main() {
  printf("File: %s\n", __FILE__);
  printf("Line: %d\n", __LINE__);
  printf("Line: %d\n", __LINE__);
  LOG("hello");
  LOG("world");
  return 0;
}
