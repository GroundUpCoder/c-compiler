def fact(n):
    return 1 if n <= 1 else n * fact(n - 1)

print("fact:", [fact(i) for i in range(7)])

def fib(n):
    return n if n < 2 else fib(n - 1) + fib(n - 2)

print("fib:", [fib(i) for i in range(10)])

# Mutual recursion.
def is_even(n):
    return True if n == 0 else is_odd(n - 1)

def is_odd(n):
    return False if n == 0 else is_even(n - 1)

print("even(8) =", is_even(8))
print("odd(7) =", is_odd(7))
