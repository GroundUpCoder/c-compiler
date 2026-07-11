/*
 *  c-compiler puNES frontend glue (GPLv3): a no-op stub for the PIC16C5x
 *  microcontroller emulation (upstream is C++). Only mapper 355 (a bootleg
 *  cart with an on-cart PIC) uses it; stubbing it keeps that mapper linking
 *  while leaving the exotic PIC behaviour inert. The mapper still boots — it
 *  just doesn't reproduce the copy-protection MCU.
 */

#include "pic16c5x.h"

void pic16c5x_init(BYTE *rom, pic16c5x_rd_funct rd, pic16c5x_wr_funct wr) {
	(void)rom; (void)rd; (void)wr;
}
void pic16c5x_quit(void) {}
void pic16c5x_reset(BYTE type) { (void)type; }
void pic16c5x_run(void) {}
BYTE pic16c5x_save_mapper(BYTE mode, BYTE slot, FILE *fp) {
	(void)mode; (void)slot; (void)fp;
	return (0);
}
