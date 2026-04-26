#include <stdio.h>

int basic(int op) {
    int result = 0;
    switch (op) {
    case 0: {
        result = 10;
        goto done;
    }
    case 1: {
        result = 20;
        goto done;
    }
    case 2: {
        result = 30;
    done:
        result += 100;
        break;
    }
    }
    return result;
}

int with_default(int op) {
    int result = 0;
    switch (op) {
    case 0: {
        result = 1;
        goto adjust;
    }
    case 1: {
        result = 2;
        goto adjust;
    }
    default: {
        result = 99;
    adjust:
        result *= 10;
        break;
    }
    }
    return result;
}

int fallthrough_to_label(int op) {
    int result = 0;
    switch (op) {
    case 0: {
        result = 5;
        goto end;
    }
    case 1: {
        result = 10;
    }
    case 2: {
        result += 20;
    end:
        result += 1000;
        break;
    }
    }
    return result;
}

int multiple_labels(int op) {
    int r = 0;
    switch (op) {
    case 0: {
        r = 1;
        goto L1;
    }
    case 1: {
        r = 2;
        goto L2;
    }
    case 2: {
        r = 3;
    L1:
        r += 10;
    }
    case 3: {
        r += 100;
    L2:
        r += 1000;
        break;
    }
    }
    return r;
}

int label_with_cases_after(int op) {
    int r = 0;
    switch (op) {
    case 0: {
        r = 1;
        goto mid;
    }
    case 1: {
        r = 2;
    mid:
        r += 100;
        break;
    }
    case 2: {
        r = 999;
        break;
    }
    }
    return r;
}

int main(void) {
    printf("basic: %d %d %d\n", basic(0), basic(1), basic(2));
    printf("default: %d %d %d\n", with_default(0), with_default(1), with_default(42));
    printf("fallthrough: %d %d %d\n", fallthrough_to_label(0), fallthrough_to_label(1), fallthrough_to_label(2));
    printf("multi: %d %d %d %d\n", multiple_labels(0), multiple_labels(1), multiple_labels(2), multiple_labels(3));
    printf("after: %d %d %d\n", label_with_cases_after(0), label_with_cases_after(1), label_with_cases_after(2));
    return 0;
}
