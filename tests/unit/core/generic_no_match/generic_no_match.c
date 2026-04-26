int main(void) {
    int x = 0;
    int y = _Generic(x, double: 1, float: 2);
    return y;
}
