; Test: TIMES with label expressions
; Golden: nasm -f bin times.asm -o times.golden.bin

	ORG 0x100

start:
	DB 0xAA, 0xBB, 0xCC
	TIMES 8 DB 0x00
mid:
	TIMES 16-($-$$) DB 0xFF

end:
