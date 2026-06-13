; Stage-1 boot sector (512 bytes).
;   1. BIOS loads us at 0x7C00 in 16-bit real mode, DL = boot drive.
;   2. INT 13h read N sectors of stage-2 kernel to linear 0x10000.
;   3. INT 10h to enter VGA Mode 13h (320x200x256, framebuffer at 0xA0000).
;   4. Enable A20, load GDT, set CR0.PE, far-jump to 32-bit code.
;   5. Set flat data segments + stack, jump to 0x10000 (the C kernel).
;
; Works on v86 AND on real legacy-BIOS PCs.

[BITS 16]
[ORG 0x7C00]

%define KERNEL_SEG    0x1000        ; ES = 0x1000 → linear 0x10000
%define KERNEL_OFF    0x0000
%define KERNEL_SECTS  60            ; 60 * 512 = 30 KiB headroom for the kernel

start:
    cli
    xor   ax, ax
    mov   ds, ax
    mov   es, ax
    mov   ss, ax
    mov   sp, 0x7C00                ; stack just below us
    sti

    ; --- Load kernel via INT 13h CHS read ---
    mov   ah, 0x02                  ; read sectors
    mov   al, KERNEL_SECTS
    mov   ch, 0                     ; cylinder 0
    mov   cl, 2                     ; start sector 2 (1-indexed; sector 1 is us)
    mov   dh, 0                     ; head 0
    ; DL is the boot drive — BIOS set it on entry, preserved through above.
    mov   bx, KERNEL_SEG
    mov   es, bx
    mov   bx, KERNEL_OFF
    int   0x13
    jc    disk_error                ; carry set = error

    ; --- Set VGA Mode 13h (320x200x256, framebuffer at 0xA0000) ---
    mov   ax, 0x0013
    int   0x10

    ; --- Switch to 32-bit protected mode ---
    cli

    ; Enable A20 line (fast A20 via port 0x92)
    in    al, 0x92
    or    al, 0x02
    out   0x92, al

    ; Load GDT
    lgdt  [gdtr]

    ; Set CR0.PE
    mov   eax, cr0
    or    eax, 1
    mov   cr0, eax

    ; Far jump to flush CPU pipeline into 32-bit mode
    jmp   0x08:pm_start

disk_error:
    cli
    hlt
    jmp   disk_error

; ------------------------------------------------------------------
[BITS 32]
pm_start:
    mov   ax, 0x10                  ; data selector
    mov   ds, ax
    mov   es, ax
    mov   fs, ax
    mov   gs, ax
    mov   ss, ax
    mov   esp, 0x300000             ; 3 MiB — well clear of kernel + .bss + fb

    jmp   0x10000                   ; jump to kernel C code

; ------------------------------------------------------------------
align 8
gdt:
    ; Null descriptor (selector 0x00)
    dq 0
    ; Code segment, flat, ring 0 (selector 0x08)
    dw 0xFFFF       ; limit 0-15
    dw 0x0000       ; base  0-15
    db 0x00         ; base 16-23
    db 0x9A         ; access: present, ring 0, code, exec/read
    db 0xCF         ; flags G=1, D=1; limit 16-19 = 0xF
    db 0x00         ; base 24-31
    ; Data segment, flat, ring 0 (selector 0x10)
    dw 0xFFFF
    dw 0x0000
    db 0x00
    db 0x92         ; access: present, ring 0, data, read/write
    db 0xCF
    db 0x00
gdt_end:

gdtr:
    dw gdt_end - gdt - 1
    dd gdt

times 510-($-$$) db 0
dw 0xAA55
