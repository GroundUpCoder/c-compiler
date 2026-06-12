[BITS 16]
ORG 0x100

	; 16-bit addressing modes: all 8 rm field values
	mov al, [bx+si]         ; rm=0
	mov al, [bx+di]         ; rm=1
	mov al, [bp+si]         ; rm=2
	mov al, [bp+di]         ; rm=3
	mov al, [si]            ; rm=4
	mov al, [di]            ; rm=5
	mov al, [bp]            ; rm=6 (mod=1, disp8=0)
	mov al, [bx]            ; rm=7
	mov al, [0x1234]        ; rm=6 (direct address, mod=0)

	; 16-bit with displacement
	mov al, [bx+si+0x10]    ; mod=1 (disp8)
	mov al, [bx+si+0x1000]  ; mod=2 (disp16)
	mov al, [bx+0x10]       ; mod=1, rm=7
	mov al, [bx+0x1000]     ; mod=2, rm=7
	mov al, [bp+0x10]       ; mod=1, rm=6
	mov al, [bp+0x1000]     ; mod=2, rm=6
	mov al, [si+0x10]       ; mod=1, rm=4
	mov al, [si+0x1000]     ; mod=2, rm=4
