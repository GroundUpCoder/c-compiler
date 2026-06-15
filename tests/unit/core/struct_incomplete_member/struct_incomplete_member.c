// Regression: a struct/union member of *incomplete* type must be rejected
// (C11 6.7.2.1p3 — a member shall have complete object type). The compiler
// used to silently accept it and size the member as 0, so the enclosing
// aggregate came out too small. A separate translation unit that DID see the
// full definition would then write the whole object and scribble past the
// under-allocated storage — corrupting whatever lived after it.
//
// This is exactly how the libgit2 SHA1 hash context (`git_hash_ctx`, holding a
// 2400-byte SHA1DC `SHA1_CTX`) was sized at 120 bytes in the one TU where its
// backend struct was only forward-declared, corrupting the caller's stack and
// crashing git_index_open() with a bogus "double free".
//
// `struct inner` is never completed, so the union member `big` is incomplete.
struct inner;

typedef struct {
	union {
		struct inner big;   // incomplete type — must be a compile error
		char small[16];
	} u;
	int tag;
} outer;

int main(void) {
	outer o;
	return sizeof(o);
}
