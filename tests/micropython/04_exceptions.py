print(int("42"))

try:
    int("not-a-number")
except ValueError as e:
    print("bad:", e)

def boom():
    raise RuntimeError("uh oh")

try:
    boom()
except RuntimeError as e:
    print("caught:", e)

# Exception chaining via re-raise.
try:
    try:
        raise KeyError("inner")
    except KeyError:
        raise ValueError("outer wrapping inner")
except ValueError as e:
    print("caught:", e)

# finally clause executes even on early return.
def with_finally():
    try:
        return 1
    finally:
        print("cleanup")

print("result:", with_finally())

# finally runs even when exception propagates.
def re_raise():
    try:
        raise KeyError("k")
    finally:
        print("cleanup2")

try:
    re_raise()
except KeyError as e:
    print("propagated:", e)
