struct Inner { int a; int b; };
struct Mid { int pad; struct Inner inner; struct Inner arr[3]; };
struct Big { int head[7]; struct Mid mid; };
struct Big ext_big;
