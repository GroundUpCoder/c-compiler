#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include "pixman.h"

/* Tiny pixman smoke test: solid fill, OVER composite of a translucent solid,
 * and a linear gradient, then print an FNV-1a hash of the pixels. */

static uint32_t fnv1a(const uint32_t *px, int n) {
    uint32_t h = 2166136261u;
    for (int i = 0; i < n; i++) {
        uint32_t v = px[i];
        for (int b = 0; b < 4; b++) {
            h ^= (v >> (b * 8)) & 0xff;
            h *= 16777619u;
        }
    }
    return h;
}

int main(void) {
    const int W = 64, H = 64;
    uint32_t *bits = calloc(W * H, 4);
    pixman_image_t *dst = pixman_image_create_bits(PIXMAN_a8r8g8b8, W, H, bits, W * 4);

    /* opaque red background */
    pixman_color_t red = { 0xffff, 0, 0, 0xffff };
    pixman_box32_t whole = { 0, 0, W, H };
    pixman_image_fill_boxes(PIXMAN_OP_SRC, dst, &red, 1, &whole);

    /* 50% blue OVER the top-left quadrant */
    pixman_color_t blue50 = { 0, 0, 0x8000, 0x8000 };
    pixman_image_t *solid = pixman_image_create_solid_fill(&blue50);
    pixman_image_composite32(PIXMAN_OP_OVER, solid, NULL, dst,
                             0, 0, 0, 0, 0, 0, W / 2, H / 2);
    pixman_image_unref(solid);

    /* black->white linear gradient across the bottom half */
    pixman_gradient_stop_t stops[2] = {
        { pixman_int_to_fixed(0), { 0, 0, 0, 0xffff } },
        { pixman_int_to_fixed(1), { 0xffff, 0xffff, 0xffff, 0xffff } },
    };
    pixman_point_fixed_t p1 = { 0, 0 }, p2 = { pixman_int_to_fixed(W), 0 };
    pixman_image_t *grad = pixman_image_create_linear_gradient(&p1, &p2, stops, 2);
    pixman_image_composite32(PIXMAN_OP_SRC, grad, NULL, dst,
                             0, 0, 0, 0, 0, H / 2, W, H / 2);
    pixman_image_unref(grad);

    printf("corner=%08x quad=%08x mid=%08x\n",
           bits[0], bits[(H / 4) * W + W / 4], bits[(3 * H / 4) * W + W / 2]);
    printf("hash=%08x\n", fnv1a(bits, W * H));

    pixman_image_unref(dst);
    free(bits);
    printf("pixman %s ok\n", pixman_version_string());
    return 0;
}
