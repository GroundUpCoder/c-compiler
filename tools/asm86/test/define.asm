; Test: %define macro substitution
; Golden: nasm -f bin define.asm -o define.golden.bin

%define KERNEL_SEG    0x1000
%define KERNEL_OFF    0x0000
%define KERNEL_SECTS  60

	BITS 16
	ORG 0x7C00

	mov al, KERNEL_SECTS
	mov bx, KERNEL_SEG
	mov bx, KERNEL_OFF

	; Verify define not substituted inside strings
	DB 'KERNEL_SEG', 0
