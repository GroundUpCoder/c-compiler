/*
 *  c-compiler puNES frontend glue (GPLv3): a plain-C CRC-32 (IEEE 802.3,
 *  reflected, poly 0xEDB88320) replacing puNES's C++ crc/ helper, which wrapped
 *  Stephan Brumme's Crc32.h. Same emu_crc32 seam + finalized-chaining
 *  convention (crc32_fast: crc = ~previous; run; return ~crc) so ROM-database
 *  hashes match the upstream core.
 */

#include "crc.h"

static uint32_t table[256];
static int table_ready = 0;

static void crc_build_table(void) {
	for (uint32_t i = 0; i < 256; i++) {
		uint32_t c = i;
		for (int k = 0; k < 8; k++) {
			c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
		}
		table[i] = c;
	}
	table_ready = 1;
}

/* Brumme crc32_fast semantics: previous/return are FINALIZED (inverted) CRCs. */
static uint32_t crc32_fast(const void *data, size_t length, uint32_t previous) {
	const unsigned char *p = (const unsigned char *)data;
	uint32_t crc = ~previous;

	if (!table_ready) {
		crc_build_table();
	}
	for (size_t i = 0; i < length; i++) {
		crc = table[(crc ^ p[i]) & 0xFF] ^ (crc >> 8);
	}
	return (~crc);
}

uint32_t emu_crc32(const void *data, size_t length) {
	return (crc32_fast(data, length, 0));
}

uint32_t emu_crc32_continue(const void *data, size_t length, uint32_t previous) {
	return (crc32_fast(data, length, previous));
}

uint32_t emu_crc32_zeroes(size_t length, uint32_t previous) {
	uint32_t crc = previous;

	for (size_t i = 0; i < length; i++) {
		unsigned char z = 0;
		crc = crc32_fast(&z, 1, crc);
	}
	return (crc);
}
