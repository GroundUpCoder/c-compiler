// BUG: a tag-less __catch (catch-all) in an irreducible-lowered function
// ICEd: the dispatch-loop try-lowering did tags.set(cc.tag.name) with a
// null tag (G11, todos/0217). This corpus runs both normally
// (catch_all_multi) and under --force-dispatch-loop
// (catch_all_irreducible): known tag caught by catch-all, specific catch
// winning over catch-all, nested regions in both orders, and propagation
// THROUGH a function whose regions don't handle the tag (the
// catch_all_ref → throw_ref path in the irreducible flavor — tag and
// payload must survive intact).
#include <stdio.h>
__exception Foo(int);
__exception Bar(int, int);

void thrower(int a, int b) { __throw Bar(a, b); }

void unprotected_passthrough(void) {
    __try {
        printf("up try\n");
    } __catch {
        printf("up catchall\n");  /* must NOT fire */
    }
    /* outside any region: must propagate to main with payload intact */
    thrower(3, 4);
}

void known_tag_to_catchall(void) {
    __try {
        __throw Foo(99);
    } __catch {
        printf("ca known\n");
    }
}

void specific_wins(void) {
    __try {
        __throw Foo(5);
    } __catch Foo(x) {
        printf("specific %d\n", x);
    } __catch {
        printf("ca wrong\n");
    }
}

void nested_inner_catchall(void) {
    __try {
        __try {
            __throw Foo(1);
        } __catch {
            printf("inner ca\n");
        }
    } __catch Foo(x) {
        printf("outer foo %d\n", x);
    }
}

void nested_outer_catchall(void) {
    __try {
        __try {
            __throw Bar(8, 9);
        } __catch Foo(x) {
            printf("inner foo %d\n", x);
        }
    } __catch {
        printf("outer ca\n");
    }
}

int main(void) {
    known_tag_to_catchall();
    specific_wins();
    nested_inner_catchall();
    nested_outer_catchall();
    __try {
        unprotected_passthrough();
    } __catch Bar(a, b) {
        printf("main bar %d %d\n", a, b);
    }
    printf("done\n");
    return 0;
}
