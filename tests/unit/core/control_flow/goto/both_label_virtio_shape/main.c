// Mirrors virtio.c's BOTH-label pattern: an `error:` label with many
// forward gotos, plus a single backward goto from a tail-position
// fallback section. The transform should inline the backward goto into
// `error:`'s body, demoting the label to FORWARD-only.
//
// Critical: `error:`'s body READS err (set by callers either before
// goto or by the fallback) — it does NOT overwrite it. Inlining must
// preserve this read-write ordering.
#include <stdio.h>

int recv_request(int op) {
  int err = 0;
  if (op == 1) { err = -7;  goto error; }      // forward
  if (op == 2) { err = -9;  goto error; }      // forward
  if (op == 3) goto protocol_error;
  if (op == 4) goto fid_not_found;
  return 100 + op;

 error:
  return -1000 - err;
 protocol_error:
 fid_not_found:
  err = -42;
  goto error;                    // backward — must be inlined as `return -1000 - err;`
}

int main(void) {
  printf("%d\n", recv_request(0));   /* 100 */
  printf("%d\n", recv_request(1));   /* err=-7, goto error, return -1000-(-7)= -993 */
  printf("%d\n", recv_request(2));   /* err=-9 → return -991 */
  printf("%d\n", recv_request(3));   /* goto protocol_error → err=-42 → inlined error body → return -1000-(-42)= -958 */
  printf("%d\n", recv_request(4));   /* same → -958 */
  return 0;
}
