class Counter:
    def __init__(self, start=0):
        self.n = start
    def inc(self, by=1):
        self.n += by
        return self.n
    def __repr__(self):
        return "Counter(" + str(self.n) + ")"

c = Counter()
print(c.inc())
print(c.inc(5))
print(c.inc(10))
print(c)

class TimesTwo(Counter):
    def inc(self, by=1):
        return super().inc(by * 2)

t = TimesTwo(2)
print(t.inc(5))
print(t.inc(3))
print(t)
