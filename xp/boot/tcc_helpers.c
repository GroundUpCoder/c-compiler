/* Minimal subset of TCC's runtime helpers (libtcc1).
   We can't link libtcc1.c directly because its long-double helpers don't
   cross-compile (constants can't be represented).  These are the ones our
   code actually calls — float-int conversion + 64-bit shifts. */

typedef struct { int low; int high; } DWstruct;
typedef union { DWstruct s; long long ll; } DWunion;

long long __ashldi3(long long a, int b) {
    DWunion u; u.ll = a;
    if (b >= 32) { u.s.high = (unsigned)u.s.low << (b - 32); u.s.low = 0; }
    else if (b != 0) {
        u.s.high = ((unsigned)u.s.high << b) | ((unsigned)u.s.low >> (32 - b));
        u.s.low  = (unsigned)u.s.low  << b;
    }
    return u.ll;
}

long long __ashrdi3(long long a, int b) {
    DWunion u; u.ll = a;
    if (b >= 32) { u.s.low = u.s.high >> (b - 32); u.s.high = u.s.high >> 31; }
    else if (b != 0) {
        u.s.low  = ((unsigned)u.s.low >> b) | (u.s.high << (32 - b));
        u.s.high = u.s.high >> b;
    }
    return u.ll;
}

unsigned long long __lshrdi3(unsigned long long a, int b) {
    DWunion u; u.ll = a;
    if (b >= 32) { u.s.low = (unsigned)u.s.high >> (b - 32); u.s.high = 0; }
    else if (b != 0) {
        u.s.low  = ((unsigned)u.s.low >> b) | (u.s.high << (32 - b));
        u.s.high = (unsigned)u.s.high >> b;
    }
    return u.ll;
}


#define EXCESS  126
#define HIDDEN  (1 << 23)
#define EXP(fp)   (((fp) >> 23) & 0xFF)
#define MANT(fp)  (((fp) & 0x7FFFFF) | HIDDEN)

union float_long { float f; unsigned int l; };

unsigned long long __fixunssfdi(float a1) {
    union float_long fl1;
    int exp;
    unsigned long l;
    fl1.f = a1;
    if (fl1.l == 0) return 0;
    exp = EXP(fl1.l) - EXCESS - 24;
    l = MANT(fl1.l);
    if (exp >= 41) return (unsigned long long)-1;
    else if (exp >= 0)  return (unsigned long long)l << exp;
    else if (exp >= -23) return l >> -exp;
    else return 0;
}

long long __fixsfdi(float a1) {
    long long ret; int s;
    ret = __fixunssfdi((s = a1 >= 0) ? a1 : -a1);
    return s ? ret : -ret;
}
