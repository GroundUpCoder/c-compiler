; Test: memory operands (direct address via label)
; Golden: nasm -f bin mem.asm -o mem.golden.bin

	BITS 16
	ORG 0x7C00

gdtr_ptr:
	DW 0
	DD 0

start:
	LGDT [gdtr_ptr]  ; direct memory reference to label

	; Also test LIDT with same pattern
	LIDT [gdtr_ptr]
