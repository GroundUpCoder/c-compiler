[BITS 32]
ORG 0x200

	; 32-bit: base-only
	mov al, [eax]           ; rm=0 (eax)
	mov al, [ecx]           ; rm=1
	mov al, [edx]           ; rm=2
	mov al, [ebx]           ; rm=3
	mov al, [esp]           ; rm=4 (SIB: no index, base=esp)
	mov al, [ebp]           ; rm=5 (mod=1, disp8=0)
	mov al, [esi]           ; rm=6
	mov al, [edi]           ; rm=7

	; 32-bit: base+disp
	mov al, [eax+0x10]       ; mod=1
	mov al, [eax+0x1000]     ; mod=2
	mov al, [ebp+0x10]       ; mod=1
	mov al, [esp+0x10]       ; mod=1, SIB

	; 32-bit: index*scale (no base)
	mov al, [eax*2]          ; rm=4, SIB: base=5(disp32)
	mov al, [eax*4]
	mov al, [eax*8]
	mov al, [ecx*2]

	; 32-bit: base+index*scale
	mov al, [eax+ecx*2]      ; rm=4, SIB
	mov al, [ebx+esi*4]      ; rm=4, SIB
	mov al, [ebp+edi*8]      ; rm=4, SIB
	mov al, [esp+eax*2]      ; rm=4, SIB (ESP base)

	; 32-bit: base+index*scale+disp
	mov al, [eax+ecx*2+0x10]
	mov al, [ebx+esi*4+0x1000]

	; 32-bit: index*scale+disp (no base)
	mov al, [eax*2+0x10]
	mov al, [ecx*4+0x1000]

	; 32-bit: direct address
	mov al, [0x12345678]
