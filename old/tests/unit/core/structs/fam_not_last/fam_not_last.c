// FAM must be the last member of a struct
struct bad {
    int data[];
    int x;
};

int main(void) { return 0; }
