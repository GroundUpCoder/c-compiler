#include <stdio.h>

__struct Node { int value; __struct Node *next; };

__struct Node *cons(int v, __struct Node *tail) {
    auto n = __new(__struct Node, v, 0);
    n->next = tail;
    return n;
}

void print_list(__struct Node *head) {
    for (auto cur = head; cur; cur = cur->next)
        printf("%d ", cur->value);
    printf("\n");
}

__struct Node *reverse(__struct Node *head) {
    __struct Node *prev = 0;
    for (auto cur = head; cur;) {
        auto next = cur->next;
        cur->next = prev;
        prev = cur;
        cur = next;
    }
    return prev;
}

int length(__struct Node *head) {
    auto n = 0;
    for (auto cur = head; cur; cur = cur->next)
        n++;
    return n;
}

__struct Node *map(__struct Node *head, int (*f)(int)) {
    if (!head) return 0;
    return cons(f(head->value), map(head->next, f));
}

int double_it(int x) { return x * 2; }

int main() {
    auto list = cons(1, cons(2, cons(3, cons(4, cons(5, 0)))));

    printf("list:     ");
    print_list(list);

    printf("reversed: ");
    print_list(reverse(list));

    // rebuild since reverse is in-place
    list = cons(1, cons(2, cons(3, cons(4, cons(5, 0)))));

    printf("doubled:  ");
    print_list(map(list, double_it));

    printf("length:   %d\n", length(list));

    return 0;
}
