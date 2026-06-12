; Test: shift and rotate instructions
; Golden: nasm -f bin shifts.asm -o shifts.golden.bin

	BITS 32

	; Shift by 1
	SHL al, 1
	SHR bl, 1
	SAR cl, 1
	ROL dl, 1
	ROR ah, 1
	RCL bh, 1
	RCR ch, 1

	; Shift by CL
	SHL al, cl
	SHR eax, cl
	SAR bx, cl

	; Shift by immediate
	SHL eax, 4
	SHR bx, 8
	SAR ecx, 12

	; 16-bit mode
	BITS 16
	SHL ax, 1
	SHR bx, cl
	SHL cx, 8
