// Regression: GOTO_NORMALIZER's hoist transform splits a compound that
// contains both an SDecl and a labeled tail (the label is the target of
// a forward goto from an earlier sibling branch). The hoisted tail lands
// in an outer compound, but the SDecl stays in the original now-tiny
// compound. Without the fix, codegen frees the SDecl's wasm-local at
// the (tiny, immediately-popped) compound's scope end — even though the
// hoisted tail still uses the variable. A later sibling allocation
// reuses the slot, corrupting the earlier variable's value.
//
// Pattern modeled after QuickJS's js_parse_postfix_expr:
//   - outer if-block declares `int opcode` and `int drop_count`
//   - a label sits below them, targeted by a goto from a sibling branch
//   - GOTO_NORMALIZER hoists the labeled tail up
//   - later code allocates new ints in a sibling scope → without the fix,
//     they reuse opcode/drop_count's slots and the reads after return
//     stale (squatter) values.
#include <stdio.h>

extern int side_effect(int x);
int side_effect(int x) { return x; }

int outer(int token) {
    int result = 0;
    if (token == 1) {
        side_effect(99);
        goto check_label;
    } else if (token == 2) {
        int opcode = 10;
        int drop_count = 1;
check_label:
        {
            int squatter = 50;
            int squatter2 = 60;
            result = squatter + squatter2;
        }
        result += opcode * 1000;
        result += drop_count * 10000;
    }
    return result;
}

int main(void) {
    printf("%d\n", outer(2));
    return 0;
}
