// C11 6.7p3: typedef redefinition with incompatible type is an error
typedef int myint;
typedef double myint;  // incompatible — should error

int main(void) { return 0; }
