#include <stdio.h>

// Dense switch with >= 4 cases to trigger br_table optimization
void test_basic(int x) {
    switch (x) {
        case 1: printf("one\n"); break;
        case 2: printf("two\n"); break;
        case 3: printf("three\n"); break;
        case 4: printf("four\n"); break;
        case 5: printf("five\n"); break;
    }
}

// Dense switch with default
void test_default(int x) {
    switch (x) {
        case 10: printf("ten\n"); break;
        case 11: printf("eleven\n"); break;
        case 12: printf("twelve\n"); break;
        case 13: printf("thirteen\n"); break;
        default: printf("other\n"); break;
    }
}

// Dense switch with gaps (still >= 40% density)
// Range 0..9 = 10 slots, 5 cases = 50% density
void test_gaps(int x) {
    switch (x) {
        case 0: printf("zero\n"); break;
        case 2: printf("two\n"); break;
        case 5: printf("five\n"); break;
        case 7: printf("seven\n"); break;
        case 9: printf("nine\n"); break;
    }
}

// Dense switch with fall-through
void test_fallthrough(int x) {
    switch (x) {
        case 1: printf("1+");
        case 2: printf("2+");
        case 3: printf("3\n"); break;
        case 4: printf("4\n"); break;
    }
}

// Dense switch with negative values
void test_negative(int x) {
    switch (x) {
        case -2: printf("neg2\n"); break;
        case -1: printf("neg1\n"); break;
        case 0:  printf("zero\n"); break;
        case 1:  printf("pos1\n"); break;
    }
}

// Sparse switch: only 2 cases, should use br_if
void test_sparse(int x) {
    switch (x) {
        case 1: printf("one\n"); break;
        case 1000: printf("thousand\n"); break;
    }
}

int main() {
    // Basic dense switch
    test_basic(1);
    test_basic(3);
    test_basic(5);
    test_basic(99);  // no match, no default

    // Default case
    test_default(10);
    test_default(13);
    test_default(99);  // hits default

    // Gaps in range
    test_gaps(0);
    test_gaps(5);
    test_gaps(3);  // gap, no match
    test_gaps(9);

    // Fall-through
    test_fallthrough(1);  // falls through 1->2->3
    test_fallthrough(2);  // falls through 2->3
    test_fallthrough(4);

    // Negative values
    test_negative(-2);
    test_negative(0);
    test_negative(1);

    // Sparse switch (br_if path)
    test_sparse(1);
    test_sparse(1000);
    test_sparse(5);  // no match

    return 0;
}
