__exception Err(int);

int main() {
    __try {
        __throw Err(1);
    }
    return 0;
}
