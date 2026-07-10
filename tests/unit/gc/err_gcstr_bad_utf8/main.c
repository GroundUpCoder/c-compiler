// The literal becomes a wasm import name; import names must be valid UTF-8.
// \xNN byte escapes can produce sequences that aren't.
int main(void) { __externref a = __gcstr("\xff\xfe"); return 0; }
