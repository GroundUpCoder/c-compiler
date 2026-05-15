def countdown(n):
    while n > 0:
        yield n
        n -= 1

print(list(countdown(5)))

def fibgen():
    a, b = 0, 1
    while True:
        yield a
        a, b = b, a + b

g = fibgen()
result = [next(g) for _ in range(8)]
print(result)
