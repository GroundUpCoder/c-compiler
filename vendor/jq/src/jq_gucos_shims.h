#ifndef JQ_GUCOS_SHIMS_H
#define JQ_GUCOS_SHIMS_H
/* Historical gap-filler header for the gucOS wasm build. The libc now
   provides everything jq's date builtins need — timegm()/gmtime_r()
   (todos/0325 Group B / todos/0382 gap 5) and strptime() (ticket #113) —
   so the companion jq_gucos_shims.c TU is gone and <time.h> declares all
   three. The include stays so builtin.c needs no further patching. */
#include <time.h>
#endif /* JQ_GUCOS_SHIMS_H */
