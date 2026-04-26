#include <stdlib.h>
#include <stdio.h>
#include <string.h>

// Basic FAM with char
struct buffer {
    int len;
    char data[];
};

// FAM with int elements
struct int_array {
    int count;
    int padding;
    int values[];
};

// FAM with pointer elements
struct ptr_array {
    int count;
    const char *items[];
};

// Nested struct containing a pointer to FAM struct
struct container {
    const char *name;
    struct buffer *buf;
};

// FAM with struct elements
struct point {
    int x, y;
};
struct point_array {
    int count;
    struct point pts[];
};

// Test sizeof: FAM should not be counted
void test_sizeof(void) {
    printf("sizeof(struct buffer) = %d\n", (int)sizeof(struct buffer));
    printf("sizeof(struct int_array) = %d\n", (int)sizeof(struct int_array));
    printf("sizeof(struct ptr_array) = %d\n", (int)sizeof(struct ptr_array));
    printf("sizeof(struct point_array) = %d\n", (int)sizeof(struct point_array));
}

// Test basic char FAM
void test_char_fam(void) {
    struct buffer *buf = (struct buffer *)malloc(sizeof(struct buffer) + 6);
    buf->len = 5;
    buf->data[0] = 'H';
    buf->data[1] = 'e';
    buf->data[2] = 'l';
    buf->data[3] = 'l';
    buf->data[4] = 'o';
    buf->data[5] = '\0';

    printf("char fam: len=%d data=%s\n", buf->len, buf->data);
    free(buf);
}

// Test int FAM with alignment
void test_int_fam(void) {
    int n = 5;
    struct int_array *arr = (struct int_array *)malloc(
        sizeof(struct int_array) + n * sizeof(int));
    arr->count = n;
    arr->padding = 99;

    for (int i = 0; i < n; i++) {
        arr->values[i] = (i + 1) * 10;
    }

    printf("int fam: count=%d padding=%d values=", arr->count, arr->padding);
    for (int i = 0; i < arr->count; i++) {
        if (i > 0) printf(",");
        printf("%d", arr->values[i]);
    }
    printf("\n");
    free(arr);
}

// Test pointer FAM
void test_ptr_fam(void) {
    int n = 3;
    struct ptr_array *arr = (struct ptr_array *)malloc(
        sizeof(struct ptr_array) + n * sizeof(const char *));
    arr->count = n;
    arr->items[0] = "foo";
    arr->items[1] = "bar";
    arr->items[2] = "baz";

    printf("ptr fam: count=%d items=", arr->count);
    for (int i = 0; i < arr->count; i++) {
        if (i > 0) printf(",");
        printf("%s", arr->items[i]);
    }
    printf("\n");
    free(arr);
}

// Test FAM struct passed through a nested struct
void test_nested(void) {
    struct buffer *buf = (struct buffer *)malloc(sizeof(struct buffer) + 4);
    buf->len = 3;
    buf->data[0] = 'A';
    buf->data[1] = 'B';
    buf->data[2] = 'C';
    buf->data[3] = '\0';

    struct container c;
    c.name = "test";
    c.buf = buf;

    printf("nested: name=%s buf_len=%d buf_data=%s\n",
           c.name, c.buf->len, c.buf->data);
    free(buf);
}

// Test FAM with struct elements
void test_struct_element_fam(void) {
    int n = 3;
    struct point_array *arr = (struct point_array *)malloc(
        sizeof(struct point_array) + n * sizeof(struct point));
    arr->count = n;
    for (int i = 0; i < n; i++) {
        arr->pts[i].x = i * 10;
        arr->pts[i].y = i * 10 + 1;
    }

    printf("struct fam: count=%d", arr->count);
    for (int i = 0; i < arr->count; i++) {
        printf(" (%d,%d)", arr->pts[i].x, arr->pts[i].y);
    }
    printf("\n");
    free(arr);
}

// Test address arithmetic: &buf->data[i] should work
void test_address_arithmetic(void) {
    struct buffer *buf = (struct buffer *)malloc(sizeof(struct buffer) + 10);
    buf->len = 5;
    for (int i = 0; i < 5; i++) {
        buf->data[i] = 'a' + i;
    }

    // Access via pointer to element
    char *p = &buf->data[2];
    printf("addr arith: data[2]=%c *p=%c p[1]=%c\n", buf->data[2], *p, p[1]);

    // Use memset on FAM
    memset(buf->data, 'X', 5);
    buf->data[5] = '\0';
    printf("after memset: data=%s\n", buf->data);

    free(buf);
}

// Test realloc pattern: grow FAM
void test_realloc_growth(void) {
    int initial_cap = 4;
    struct int_array *arr = (struct int_array *)malloc(
        sizeof(struct int_array) + initial_cap * sizeof(int));
    arr->count = 0;
    arr->padding = initial_cap;  // use padding field as capacity

    // Fill initial
    for (int i = 0; i < initial_cap; i++) {
        arr->values[arr->count++] = i * 100;
    }

    // Grow
    int new_cap = 8;
    arr = (struct int_array *)realloc(arr,
        sizeof(struct int_array) + new_cap * sizeof(int));
    arr->padding = new_cap;

    // Add more
    for (int i = initial_cap; i < new_cap; i++) {
        arr->values[arr->count++] = i * 100;
    }

    printf("realloc: count=%d values=", arr->count);
    for (int i = 0; i < arr->count; i++) {
        if (i > 0) printf(",");
        printf("%d", arr->values[i]);
    }
    printf("\n");
    free(arr);
}

// Test typedef with FAM
typedef struct {
    int n;
    double vals[];
} DoubleArray;

void test_typedef_fam(void) {
    int n = 3;
    DoubleArray *da = (DoubleArray *)malloc(
        sizeof(DoubleArray) + n * sizeof(double));
    da->n = n;
    da->vals[0] = 1.5;
    da->vals[1] = 2.5;
    da->vals[2] = 3.5;

    double sum = 0;
    for (int i = 0; i < da->n; i++) {
        sum += da->vals[i];
    }
    printf("typedef fam: n=%d sum=%.1f\n", da->n, sum);
    free(da);
}

int main(void) {
    test_sizeof();
    test_char_fam();
    test_int_fam();
    test_ptr_fam();
    test_nested();
    test_struct_element_fam();
    test_address_arithmetic();
    test_realloc_growth();
    test_typedef_fam();
    return 0;
}
