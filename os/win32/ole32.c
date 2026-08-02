/* ole32.c — the COM-lite slice of the Win32 veneer (ticket #94 / 0453,
 * plan step 7): OleInitialize/OleUninitialize and an IStream over an
 * HGLOBAL.
 *
 * Scope and honesty (objbase.h has the full argument):
 *   - There is no apartment model, so OleInitialize's only observable
 *     contract here is the balanced init count and the S_OK/S_FALSE
 *     return. That is implemented, not stubbed.
 *   - The memory stream is a real stream: Read/Write/Seek/SetSize/Stat
 *     all do the work, and the logical size is tracked independently of
 *     the HGLOBAL's capacity (which is what CreateStreamOnHGlobal's
 *     caller then corrects with SetSize — see the ReactOS shimgvw
 *     loader, which knows the true file size and GDI+ does not).
 *   - GROWTH: this OS's kernel32 has no GlobalReAlloc, and its GlobalAlloc
 *     hands back the pointer AS the handle (#321), so a grow moves the
 *     handle. A stream that OWNS its handle (deleteOnRelease) may
 *     therefore grow by alloc+copy+free; a stream over a caller's handle
 *     may NOT, because the caller still holds the old value. That case
 *     REFUSES loudly (WIN32_UNSUPPORTED + STG_E_MEDIUMFULL) instead of
 *     silently truncating the write.
 *   - CopyTo/Commit/Revert/LockRegion/UnlockRegion/Clone have no meaning
 *     in a single-process, no-transaction world and return E_NOTIMPL
 *     through WIN32_UNSUPPORTED. A caller can never mistake them for
 *     success.
 */

#include <windows.h>
#include <objbase.h>
#include "win32_internal.h"

#include <stdlib.h>
#include <string.h>

/* ============================================================ Ole init */

static int g_oleInit;

HRESULT OleInitialize(LPVOID reserved) {
    if (reserved) return E_INVALIDARG;
    return (g_oleInit++ == 0) ? S_OK : S_FALSE;
}

void OleUninitialize(void) {
    if (g_oleInit > 0) g_oleInit--;
}

/* ============================================================ memstream */

typedef struct MemStream {
    const IStreamVtbl *lpVtbl;
    LONG      ref;
    HGLOBAL   hMem;         /* handle == pointer (kernel32 #321) */
    SIZE_T    cap;          /* GlobalSize(hMem) */
    SIZE_T    size;         /* logical stream length, <= cap */
    SIZE_T    pos;
    BOOL      owns;         /* deleteOnRelease */
} MemStream;

/* IID_IUnknown / IID_ISequentialStream / IID_IStream — the only three a
 * QueryInterface on this object can succeed for. */
static const IID k_iid_unknown =
    { 0x00000000, 0x0000, 0x0000, { 0xC0,0,0,0,0,0,0,0x46 } };
static const IID k_iid_seqstream =
    { 0x0c733a30, 0x2a1c, 0x11ce, { 0xad,0xe5,0x00,0xaa,0x00,0x44,0x77,0x3d } };
static const IID k_iid_stream =
    { 0x0000000c, 0x0000, 0x0000, { 0xC0,0,0,0,0,0,0,0x46 } };

static HRESULT ms_QueryInterface(IStream *self, REFIID riid, void **ppv) {
    if (!ppv) return E_POINTER;
    *ppv = NULL;
    if (!riid) return E_INVALIDARG;
    if (IsEqualGUID(riid, &k_iid_unknown) ||
        IsEqualGUID(riid, &k_iid_seqstream) ||
        IsEqualGUID(riid, &k_iid_stream)) {
        *ppv = self;
        self->lpVtbl->AddRef(self);
        return S_OK;
    }
    return E_NOINTERFACE;
}

static ULONG ms_AddRef(IStream *self) {
    MemStream *s = (MemStream *)self;
    return (ULONG)++s->ref;
}

static ULONG ms_Release(IStream *self) {
    MemStream *s = (MemStream *)self;
    LONG n = --s->ref;
    if (n <= 0) {
        if (s->owns && s->hMem) GlobalFree(s->hMem);
        free(s);
        return 0;
    }
    return (ULONG)n;
}

static HRESULT ms_Read(IStream *self, void *pv, ULONG cb, ULONG *pcbRead) {
    MemStream *s = (MemStream *)self;
    if (!pv) return STG_E_INVALIDPOINTER;
    SIZE_T avail = s->pos < s->size ? s->size - s->pos : 0;
    SIZE_T n = cb < avail ? (SIZE_T)cb : avail;
    if (n) memcpy(pv, (const BYTE *)s->hMem + s->pos, n);
    s->pos += n;
    if (pcbRead) *pcbRead = (ULONG)n;
    /* Windows: a short read is S_OK, not an error — the caller compares
     * the transferred count (which is exactly what shimgvw's loader
     * does). */
    return S_OK;
}

/* The stream's addressable ceiling. SIZE_T is 32-bit here, while the
 * IStream API speaks 64-bit offsets — every place the two meet has to
 * REFUSE rather than truncate, or a wrapped length becomes a write
 * outside the HGLOBAL. */
#define MS_MAX ((SIZE_T)-1)

/* Grow to at least `need` bytes. Returns S_OK, or a LOUD refusal when the
 * handle is not ours to move. */
static HRESULT ms_reserve(MemStream *s, SIZE_T need) {
    if (need <= s->cap) return S_OK;
    if (!s->owns) {
        WIN32_UNSUPPORTED("IStream on a caller-owned HGLOBAL cannot grow "
                          "(no GlobalReAlloc; handle would move)");
        return STG_E_MEDIUMFULL;
    }
    SIZE_T cap = s->cap ? s->cap : 256;
    /* Doubling must not wrap: at the top of the range clamp to `need`
     * (which is already a valid SIZE_T) instead of folding back to a
     * small capacity. */
    while (cap < need) {
        if (cap > MS_MAX / 2) { cap = need; break; }
        cap *= 2;
    }
    HGLOBAL h = GlobalAlloc(0, cap);
    if (!h) return E_OUTOFMEMORY;
    if (s->size) memcpy(h, s->hMem, s->size);
    memset((BYTE *)h + s->size, 0, cap - s->size);
    if (s->hMem) GlobalFree(s->hMem);
    s->hMem = h;
    s->cap = cap;
    return S_OK;
}

static HRESULT ms_Write(IStream *self, const void *pv, ULONG cb,
                        ULONG *pcbWritten) {
    MemStream *s = (MemStream *)self;
    if (pcbWritten) *pcbWritten = 0;
    if (!pv) return STG_E_INVALIDPOINTER;
    if (!cb) return S_OK;
    /* pos + cb must not wrap. Without this a stream seeked near the top of
     * the address range reserves a SMALL size and then memcpy/memset past
     * the end of its HGLOBAL. */
    if ((SIZE_T)cb > MS_MAX - s->pos) {
        WIN32_UNSUPPORTED("IStream::Write of %lu bytes at offset %lu would "
                          "overflow the address range",
                          (unsigned long)cb, (unsigned long)s->pos);
        return STG_E_MEDIUMFULL;
    }
    HRESULT hr = ms_reserve(s, s->pos + cb);
    if (FAILED(hr)) return hr;
    /* A seek past the end then a write leaves a zero-filled hole. */
    if (s->pos > s->size)
        memset((BYTE *)s->hMem + s->size, 0, s->pos - s->size);
    memcpy((BYTE *)s->hMem + s->pos, pv, cb);
    s->pos += cb;
    if (s->pos > s->size) s->size = s->pos;
    if (pcbWritten) *pcbWritten = cb;
    return S_OK;
}

static HRESULT ms_Seek(IStream *self, LARGE_INTEGER move, DWORD origin,
                       ULARGE_INTEGER *newPos) {
    MemStream *s = (MemStream *)self;
    long long base;
    switch (origin) {
    case STREAM_SEEK_SET: base = 0; break;
    case STREAM_SEEK_CUR: base = (long long)s->pos; break;
    case STREAM_SEEK_END: base = (long long)s->size; break;
    default: return STG_E_INVALIDFUNCTION;
    }
    long long to = base + move.QuadPart;
    if (to < 0) return STG_E_INVALIDFUNCTION;
    /* Refuse rather than truncate a 64-bit offset into a 32-bit SIZE_T:
     * a silently-wrapped position is a write at the wrong address later. */
    if ((unsigned long long)to > (unsigned long long)MS_MAX) {
        WIN32_UNSUPPORTED("IStream::Seek to offset beyond the address range");
        return STG_E_INVALIDFUNCTION;
    }
    s->pos = (SIZE_T)to;
    if (newPos) newPos->QuadPart = (ULONG64)s->pos;
    return S_OK;
}

static HRESULT ms_SetSize(IStream *self, ULARGE_INTEGER size) {
    MemStream *s = (MemStream *)self;
    /* Same rule as Seek: a 64-bit size that does not fit is REFUSED, not
     * silently truncated into an S_OK whose logical size is not the one
     * the caller asked for. */
    if (size.QuadPart > (ULONG64)MS_MAX) {
        WIN32_UNSUPPORTED("IStream::SetSize beyond the address range");
        return STG_E_MEDIUMFULL;
    }
    SIZE_T want = (SIZE_T)size.QuadPart;
    HRESULT hr = ms_reserve(s, want);
    if (FAILED(hr)) return hr;
    if (want > s->size) memset((BYTE *)s->hMem + s->size, 0, want - s->size);
    s->size = want;
    if (s->pos > s->size) s->pos = s->size;
    return S_OK;
}

static HRESULT ms_Stat(IStream *self, STATSTG *stat, DWORD flags) {
    MemStream *s = (MemStream *)self;
    (void)flags;
    if (!stat) return STG_E_INVALIDPOINTER;
    memset(stat, 0, sizeof(*stat));
    stat->type = STGTY_STREAM;
    stat->cbSize.QuadPart = (ULONG64)s->size;
    stat->grfMode = STGM_READWRITE;
    return S_OK;   /* pwcsName stays NULL: a memory stream has no name */
}

static HRESULT ms_CopyTo(IStream *self, IStream *dst, ULARGE_INTEGER cb,
                         ULARGE_INTEGER *read, ULARGE_INTEGER *written) {
    (void)self; (void)dst; (void)cb; (void)read; (void)written;
    WIN32_UNSUPPORTED("IStream::CopyTo");
    return E_NOTIMPL;
}
static HRESULT ms_Commit(IStream *self, DWORD flags) {
    (void)self; (void)flags;
    WIN32_UNSUPPORTED("IStream::Commit");
    return E_NOTIMPL;
}
static HRESULT ms_Revert(IStream *self) {
    (void)self;
    WIN32_UNSUPPORTED("IStream::Revert");
    return E_NOTIMPL;
}
static HRESULT ms_LockRegion(IStream *self, ULARGE_INTEGER off,
                             ULARGE_INTEGER cb, DWORD type) {
    (void)self; (void)off; (void)cb; (void)type;
    WIN32_UNSUPPORTED("IStream::LockRegion");
    return E_NOTIMPL;
}
static HRESULT ms_UnlockRegion(IStream *self, ULARGE_INTEGER off,
                               ULARGE_INTEGER cb, DWORD type) {
    (void)self; (void)off; (void)cb; (void)type;
    WIN32_UNSUPPORTED("IStream::UnlockRegion");
    return E_NOTIMPL;
}
static HRESULT ms_Clone(IStream *self, IStream **out) {
    (void)self;
    if (out) *out = NULL;
    WIN32_UNSUPPORTED("IStream::Clone");
    return E_NOTIMPL;
}

static const IStreamVtbl k_msVtbl = {
    ms_QueryInterface, ms_AddRef, ms_Release,
    ms_Read, ms_Write,
    ms_Seek, ms_SetSize, ms_CopyTo, ms_Commit, ms_Revert,
    ms_LockRegion, ms_UnlockRegion, ms_Stat, ms_Clone,
};

HRESULT CreateStreamOnHGlobal(HGLOBAL hGlobal, BOOL deleteOnRelease,
                              IStream **ppStream) {
    if (!ppStream) return E_POINTER;
    *ppStream = NULL;
    MemStream *s = (MemStream *)calloc(1, sizeof *s);
    if (!s) return E_OUTOFMEMORY;
    if (!hGlobal) {
        /* Windows allocates one for you; ownership is then always ours. */
        hGlobal = GlobalAlloc(GMEM_ZEROINIT, 256);
        if (!hGlobal) { free(s); return E_OUTOFMEMORY; }
        deleteOnRelease = TRUE;
    }
    s->lpVtbl = &k_msVtbl;
    s->ref = 1;
    s->hMem = hGlobal;
    s->cap = GlobalSize(hGlobal);
    /* Windows starts the stream at the handle's full size and expects the
     * caller to SetSize down to the real content length. */
    s->size = s->cap;
    s->pos = 0;
    s->owns = deleteOnRelease ? TRUE : FALSE;
    *ppStream = (IStream *)s;
    return S_OK;
}

HRESULT GetHGlobalFromStream(IStream *pStream, HGLOBAL *phGlobal) {
    if (!pStream || !phGlobal) return E_INVALIDARG;
    /* Only OUR streams are memory streams — there is no other IStream
     * implementation in this OS, and a foreign one would have a
     * different vtable. */
    MemStream *s = (MemStream *)pStream;
    if (s->lpVtbl != &k_msVtbl) return E_INVALIDARG;
    *phGlobal = s->hMem;
    return S_OK;
}
