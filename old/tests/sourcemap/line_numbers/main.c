int add(int a, int b) { return a + b; }

int sub(int a, int b) {
    return a - b;
}

int use_stack(int x) {
    int arr[4] = {1, 2, 3, 4};
    return arr[x] + add(x, 1);
}

int main(void) {
    int a = add(3, 4);
    int b = sub(10, a);
    int c = use_stack(b);
    return c - c;
}
