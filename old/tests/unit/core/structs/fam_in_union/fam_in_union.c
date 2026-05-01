// FAM is not allowed in a union
union bad {
    int x;
    char data[];
};

int main(void) { return 0; }
