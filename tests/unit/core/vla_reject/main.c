/* VLAs are not supported (__STDC_NO_VLA__ is defined) — but they used
 * to compile silently with sizeof == 0 and multi-dim row stride 0.
 * They must be rejected with a proper diagnostic instead. */
int main(void) {
  int n = 4;
  int vla[n];
  int m[n][n];
  (void)vla;
  (void)m;
  return 0;
}
