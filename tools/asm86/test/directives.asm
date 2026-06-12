; Test: data directives DB/DW/DD/DQ and basic directives
; Golden: nasm -f bin directives.asm -o directives.golden.bin

	BITS 32

	DB 0xAA
	DB 0xBB, 0xCC, 0xDD
	DW 0x1234
	DW 0x5678, 0x9ABC
	DD 0xDEADBEEF
	DD 0xCAFEBABE, 0xFEEDFACE
	DQ 0x0123456789ABCDEF

	DB 'hello', 0
	DB "world", 0

	ALIGN 16
	DB 0xFF
