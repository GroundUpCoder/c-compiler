; Test: label references in data directives
; Golden: nasm -f bin labels.asm -o labels.golden.bin

	ORG 0x100

start:
	DD start           ; absolute address
	DD after           ; forward reference
	DW end_label - start  ; size calculation
	DB 0xCC

after:
	DD after
	DW after - start

end_label:
