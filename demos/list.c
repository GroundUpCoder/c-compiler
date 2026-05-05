#include <stdio.h>
#include <stddef.h>

typedef __struct List {
    __array(__eqref) values;
    size_t size;
} List;

#define LIST_INITIAL_CAPACITY 8

List *List_new() {
    auto list = __new(List);
    list->values = __array_new(__eqref, LIST_INITIAL_CAPACITY);
    list->size = 0;
    return list;
}

size_t List_capacity(List *list) {
    return __array_len(list->values);
}

size_t List_size(List *list) {
    return list->size;
}

int List_is_empty(List *list) {
    return list->size == 0;
}

void List_ensure_capacity(List *list, size_t need) {
    size_t cap = __array_len(list->values);
    if (need <= cap) return;
    size_t new_cap = cap == 0 ? LIST_INITIAL_CAPACITY : cap * 2;
    if (new_cap < need) new_cap = need;
    auto bigger = __array_new(__eqref, new_cap);
    __array_copy(bigger, 0, list->values, 0, list->size);
    list->values = bigger;
}

void List_add(List *list, __eqref value) {
    List_ensure_capacity(list, list->size + 1);
    list->values[list->size++] = value;
}

__eqref List_get(List *list, size_t i) {
    return list->values[i];
}

void List_set(List *list, size_t i, __eqref value) {
    list->values[i] = value;
}

void List_insert(List *list, size_t i, __eqref value) {
    List_ensure_capacity(list, list->size + 1);
    if (i < list->size) {
        __array_copy(list->values, i + 1, list->values, i, list->size - i);
    }
    list->values[i] = value;
    list->size++;
}

__eqref List_remove(List *list, size_t i) {
    __eqref removed = list->values[i];
    if (i + 1 < list->size) {
        __array_copy(list->values, i, list->values, i + 1, list->size - i - 1);
    }
    list->size--;
    list->values[list->size] = 0;
    return removed;
}

__eqref List_pop(List *list) {
    return List_remove(list, list->size - 1);
}

int List_index_of(List *list, __eqref value) {
    for (size_t i = 0; i < list->size; i++) {
        if (list->values[i] == value) return (int)i;
    }
    return -1;
}

int List_contains(List *list, __eqref value) {
    return List_index_of(list, value) >= 0;
}

void List_clear(List *list) {
    for (size_t i = 0; i < list->size; i++) {
        list->values[i] = 0;
    }
    list->size = 0;
}

void List_reverse(List *list) {
    size_t lo = 0;
    size_t hi = list->size;
    while (lo + 1 < hi) {
        hi--;
        __eqref tmp = list->values[lo];
        list->values[lo] = list->values[hi];
        list->values[hi] = tmp;
        lo++;
    }
}


typedef __struct Point { int x; int y; } Point;

void print_point(Point *p) {
    printf("(%d, %d)", p->x, p->y);
}

void print_list(List *list) {
    printf("[");
    for (size_t i = 0; i < List_size(list); i++) {
        if (i > 0) printf(", ");
        print_point(__cast(Point *, List_get(list, i)));
    }
    printf("]  size=%d cap=%d\n",
        (int)List_size(list), (int)List_capacity(list));
}

int main() {
    auto list = List_new();
    printf("empty? %d\n", List_is_empty(list));
    print_list(list);

    auto a = __new(Point, 1, 1);
    auto b = __new(Point, 2, 4);
    auto c = __new(Point, 3, 9);
    List_add(list, a);
    List_add(list, b);
    List_add(list, c);
    printf("after 3 adds: ");
    print_list(list);

    // grow past initial capacity to trigger a resize
    for (int i = 4; i <= 10; i++) {
        List_add(list, __new(Point, i, i * i));
    }
    printf("after grow:   ");
    print_list(list);

    // get / set
    print_point(__cast(Point *, List_get(list, 0)));
    printf(" <- list[0]\n");
    List_set(list, 0, __new(Point, 99, 99));
    printf("after set[0]: ");
    print_list(list);

    // insert in the middle
    List_insert(list, 2, __new(Point, -1, -1));
    printf("after ins[2]: ");
    print_list(list);

    // remove from the middle
    auto removed = __cast(Point *, List_remove(list, 2));
    printf("removed[2] = ");
    print_point(removed);
    printf("\n");
    printf("after rm[2]:  ");
    print_list(list);

    // pop
    auto popped = __cast(Point *, List_pop(list));
    printf("popped = ");
    print_point(popped);
    printf("\n");

    // identity-based search
    printf("contains b?       %d (expect 1)\n", List_contains(list, b));
    printf("index of c:       %d\n", List_index_of(list, c));
    auto stranger = __new(Point, 0, 0);
    printf("contains stranger? %d (expect 0)\n", List_contains(list, stranger));

    // reverse in place
    List_reverse(list);
    printf("reversed:     ");
    print_list(list);

    // clear
    List_clear(list);
    printf("cleared:      ");
    print_list(list);
    printf("empty? %d\n", List_is_empty(list));

    return 0;
}
