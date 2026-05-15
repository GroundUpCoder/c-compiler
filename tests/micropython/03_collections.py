xs = [3, 1, 4, 1, 5, 9, 2, 6]
xs.sort()
print(xs)
print("len:", len(xs))
print("sum:", sum(xs))

squares = [i * i for i in range(1, 6)]
print(squares)

d = {"a": 1, "b": 2, "c": 3}
for k in sorted(d):
    print(k, "->", d[k])

t = (10, 20, 30)
a, b, c = t
print(a, b, c)
