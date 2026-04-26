// Error: _Alignas cannot reduce alignment below natural alignment
_Alignas(1) int x;

int main(void) {
    return 0;
}
