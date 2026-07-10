// __gcstr requires a string literal — the import name is baked at compile
// time, so a runtime pointer can't work (use __jss for that).
const char *p = "hi";
int main(void) { __externref a = __gcstr(p); return 0; }
