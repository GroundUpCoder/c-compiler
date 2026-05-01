/* Test: bitfields in nested structs and arrays
 * Tests that bitfield access works correctly through nested
 * struct access, pointer indirection, and array indexing.
 */
#include <stdio.h>
#include <string.h>

struct Inner {
    unsigned int x : 4;
    unsigned int y : 4;
};

struct Outer {
    struct Inner a;
    struct Inner b;
    int tag;
};

struct WithArray {
    unsigned int flags : 8;
    int data;
};

int main() {
    /* Nested struct with bitfields */
    struct Outer o;
    o.a.x = 1;
    o.a.y = 2;
    o.b.x = 3;
    o.b.y = 4;
    o.tag = 99;
    printf("nested: %d %d %d %d %d\n", o.a.x, o.a.y, o.b.x, o.b.y, o.tag);

    /* Modify inner, check outer unchanged */
    o.a.x = 15;
    printf("mod a.x: %d %d %d %d %d\n", o.a.x, o.a.y, o.b.x, o.b.y, o.tag);

    /* Array of structs with bitfields */
    struct Inner arr[4];
    int i;
    for (i = 0; i < 4; i++) {
        arr[i].x = i;
        arr[i].y = 15 - i;
    }
    for (i = 0; i < 4; i++) {
        printf("arr[%d]: x=%d y=%d\n", i, arr[i].x, arr[i].y);
    }

    /* Pointer to struct with bitfields */
    struct Inner *p = &arr[2];
    printf("ptr: x=%d y=%d\n", p->x, p->y);
    p->x = 10;
    printf("ptr mod: x=%d y=%d\n", p->x, p->y);
    printf("arr[2] after ptr mod: x=%d y=%d\n", arr[2].x, arr[2].y);

    /* Array of outer structs */
    struct Outer oarr[2];
    oarr[0].a.x = 1; oarr[0].a.y = 2; oarr[0].b.x = 3; oarr[0].b.y = 4; oarr[0].tag = 10;
    oarr[1].a.x = 5; oarr[1].a.y = 6; oarr[1].b.x = 7; oarr[1].b.y = 8; oarr[1].tag = 20;
    printf("oarr[0]: %d %d %d %d %d\n", oarr[0].a.x, oarr[0].a.y, oarr[0].b.x, oarr[0].b.y, oarr[0].tag);
    printf("oarr[1]: %d %d %d %d %d\n", oarr[1].a.x, oarr[1].a.y, oarr[1].b.x, oarr[1].b.y, oarr[1].tag);

    /* Struct copy with bitfields */
    struct Inner copy;
    copy = arr[1];
    printf("copy: x=%d y=%d\n", copy.x, copy.y);

    /* memcpy of struct with bitfields */
    struct Inner dst;
    memcpy(&dst, &arr[3], sizeof(struct Inner));
    printf("memcpy: x=%d y=%d\n", dst.x, dst.y);

    /* Function-like access pattern: compute index, access bitfield */
    int idx = 1;
    struct WithArray wa[3];
    wa[0].flags = 0x11; wa[0].data = 100;
    wa[1].flags = 0x22; wa[1].data = 200;
    wa[2].flags = 0x33; wa[2].data = 300;
    printf("wa[%d]: flags=0x%02x data=%d\n", idx, wa[idx].flags, wa[idx].data);

    /* Stride correctness: sizeof must account for padding */
    printf("sizeof(Inner)=%d\n", (int)sizeof(struct Inner));
    printf("sizeof(Outer)=%d\n", (int)sizeof(struct Outer));
    printf("sizeof(WithArray)=%d\n", (int)sizeof(struct WithArray));

    return 0;
}
