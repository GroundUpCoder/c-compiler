#include <stdio.h>

// C11 6.7p3: typedef redefinition with compatible type is allowed
typedef int myint;
typedef int myint;  // same type — OK

typedef unsigned long size_t2;
typedef unsigned long size_t2;  // same type — OK

typedef int *intptr;
typedef int *intptr;  // same pointer type — OK

struct S { int x; };
typedef struct S S;
typedef struct S S;  // same struct type — OK

void test_variable_shadows_typedef(void) {
    // 'myint' is a typedef in the global scope.
    // Here, we shadow it with a local variable of type double.
    // C11 6.7p3 only restricts multiple declarations "with the same scope".
    double myint = 3.14;

    printf("%.2f %zu\n", myint, sizeof(myint));
}

void test_shadowing_typedef_struct(void) {
    // 'S' is both a struct tag and a typedef in the global scope.
    // We shadow the typedef (ordinary identifier namespace) with a variable.
    int S = 42;
    S -= 1;

    // Check that we can still use the tag if needed (though not the typedef name)
    struct S b;
    b.x = 100;

    printf("%d %d\n", S, b.x);
}

void test_param_shadows_typedef(float myint) {
    printf("%.1f\n", myint);
}

void test_param_shadows_typedef_struct(float S) {
    printf("%.1f\n", S);
}

void test_local_typedef_shadows_global(void) {
  typedef struct myint { float x; } myint;
  myint a = { .x = 1.5f };

  typedef int S;
  S b = 2;
  printf("%.1f %d\n", a.x, b);
}

typedef double DeepType;
void test_deep_nested_shadowing(void) {
    DeepType a = 1.1;
    printf("%.1f %zu\n", a, sizeof(a));

    typedef int DeepType;
    DeepType val = 1;
    printf("%d %zu\n", val, sizeof(val));
    {
        typedef float DeepType;
        DeepType val = 2.5f;
        {
            char DeepType = 'X';
            printf("%c %zu\n", DeepType, sizeof(DeepType));
        }
        printf("%.1f %zu\n", val, sizeof(DeepType));
    }
    printf("%d %zu\n", val, sizeof(DeepType));
}

int main(void) {
    myint a = 42;
    size_t2 b = 100;
    intptr p = &a;
    S s;
    s.x = 7;
    printf("%d %lu %d %d\n", a, b, *p, s.x);
    test_variable_shadows_typedef();
    test_shadowing_typedef_struct();
    test_param_shadows_typedef(1.1);
    test_param_shadows_typedef_struct(1.2);
    test_local_typedef_shadows_global();
    test_deep_nested_shadowing();
    return 0;
}
