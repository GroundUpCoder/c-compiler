// C99 digraph support (§6.4.6)
// <: :> <% %> %: %:%:
#include <stdio.h>

// %: is # and %:%: is ##
%:define HELLO "hello"
%:define PASTE(a, b) a %:%: b

int main(void) <%
    // <: and :> are [ and ]
    int arr<:3:> = <%1, 2, 3%>;
    printf("%d %d %d\n", arr<:0:>, arr<:1:>, arr<:2:>);

    // <% and %> are { and }
    if (arr[0] == 1) <%
        printf("braces work\n");
    %>

    // %: as # in preprocessor
    printf("%s\n", HELLO);

    // %:%: as ## (token paste)
    int xy = 42;
    printf("%d\n", PASTE(x, y));

    return 0;
%>
