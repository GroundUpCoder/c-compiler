for i in range(6):
    if i % 2 == 0:
        print(i, "even")
    else:
        print(i, "odd")

total = 0
n = 1
while n <= 10:
    total += n
    n += 1
print("sum 1..10 =", total)
