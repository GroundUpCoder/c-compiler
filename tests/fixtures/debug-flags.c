static void depth3(void) { __builtin_trap(); }
static void depth2(void) { depth3(); }
static void depth1(void) { depth2(); }
int main(void) { depth1(); return 0; }
