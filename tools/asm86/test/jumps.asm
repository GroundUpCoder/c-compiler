; Test: jump instructions with labels
; Golden: nasm -f bin jumps.asm -o jumps.golden.bin

	BITS 16
	ORG 0x100

start:
	JMP forward
	NOP
forward:
	JMP start       ; backward jump
	JC  end_label   ; conditional short jump forward
	NOP
	NOP
end_label:
	HLT
	JMP start       ; near jump back
