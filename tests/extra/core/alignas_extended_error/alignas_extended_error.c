// C11 6.2.8: extended alignments (> max_align_t) are implementation-defined.
// This compiler rejects them since max_align_t alignment is 8 on wasm32.
_Alignas(16) int x;

int main(void) {
    return 0;
}
