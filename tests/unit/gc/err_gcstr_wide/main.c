// Wide literals (L/u/U prefixes) are not UTF-8 byte sequences — only narrow
// (or u8) literals can become import names.
int main(void) { __externref a = __gcstr(u"wide"); return 0; }
