[BITS 16]
ORG 0x100

.L0: DD 14585

.L1:
	mov si, ss
	jno .L0
	dec sp
.L2:
	mov dx, WORD [di]
	add WORD [bx+di+50], sp
	pop bx
.L3:
	or cx, -29
.L4:
	add WORD [.L0], dx