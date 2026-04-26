// Rule 3: A forward label closes preceding loop labels' scope
int main() {
  long i = 0;
loop:
  i++;
  if (i < 3) goto loop;
  goto skip;
skip:
  goto loop;
  return 0;
}
