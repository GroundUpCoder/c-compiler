print(int("42"))

# Inline raise + catch.
try:
    raise RuntimeError("uh oh")
except RuntimeError as e:
    print("caught:", e)

# Re-raise via nested try.
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
