/* objbase.h — the COM-lite surface of the Win32 veneer (ticket #94 /
 * 0453, plan step 7).
 *
 * This is NOT COM. There is no apartment, no registry of classes, no
 * marshalling and no out-of-process anything — this OS is
 * single-threaded by design (WIN32.md friction #1). What ports actually
 * need from <objbase.h> is much narrower, and it is exactly two things:
 *
 *   (a) GUID/IID/CLSID as a VALUE type, because GDI+ identifies image
 *       formats and codecs by GUID (gdiplusflat.h's RawFormat / Clsid);
 *   (b) an IStream over a memory buffer, because the ReactOS shimgvw
 *       loader reads a file into an HGLOBAL and hands the stream to
 *       GdipLoadImageFromStream rather than let GDI+ lock the file.
 *
 * ReactOS shimgvw's own comsup.c is 57 lines, which is the honest scale
 * of the COM layer a viewer needs. The IUnknown/IStream vtables below
 * are real function-pointer tables so a C caller uses the standard
 * `p->lpVtbl->Method(p, ...)` (and the IStream_* convenience macros)
 * exactly as it would on Windows — a future C++ port of the same code
 * compiles against the same layout.
 *
 * Everything outside that narrow surface FAILS LOUD: the stream methods
 * this OS has no meaning for (CopyTo, Commit, Revert, LockRegion,
 * UnlockRegion, Clone) return E_NOTIMPL through WIN32_UNSUPPORTED rather
 * than pretend to succeed, and there is no CoCreateInstance at all.
 */
#pragma once

#include <windows.h>

/* ---------------- GUID ---------------- */

#ifndef GUID_DEFINED
#define GUID_DEFINED
typedef struct _GUID {
    DWORD Data1;
    WORD  Data2;
    WORD  Data3;
    BYTE  Data4[8];
} GUID;
#endif

typedef GUID IID;
typedef GUID CLSID;
typedef GUID *LPGUID;
typedef const GUID *REFGUID;
typedef const IID *REFIID;
typedef const CLSID *REFCLSID;

/* Windows spells these as inline functions taking pointers in C. */
#define IsEqualGUID(a, b) (memcmp((a), (b), sizeof(GUID)) == 0)
#define IsEqualIID(a, b)   IsEqualGUID(a, b)
#define IsEqualCLSID(a, b) IsEqualGUID(a, b)

/* DEFINE_GUID: a plain definition here. Real COM plays #ifdef INITGUID
 * games so the same header can declare or define; this veneer has one
 * translation unit per GUID table, so the simple form is the honest
 * one. */
#define DEFINE_GUID(name, l, w1, w2, b1, b2, b3, b4, b5, b6, b7, b8) \
    const GUID name = { l, w1, w2, { b1, b2, b3, b4, b5, b6, b7, b8 } }

/* windows.h has LARGE_INTEGER and FILETIME; the unsigned twin is only
 * ever needed by the stream API, so it lives here. */
typedef union _ULARGE_INTEGER {
    struct { DWORD LowPart; DWORD HighPart; };
    ULONG64 QuadPart;
} ULARGE_INTEGER, *PULARGE_INTEGER;

#define E_NOINTERFACE   ((HRESULT)0x80004002)
#define E_POINTER       ((HRESULT)0x80004003)
#define E_OUTOFMEMORY   ((HRESULT)0x8007000E)
#define E_INVALIDARG    ((HRESULT)0x80070057)
#define STG_E_INVALIDFUNCTION ((HRESULT)0x80030001)
#define STG_E_INVALIDPOINTER  ((HRESULT)0x80030009)
#define STG_E_MEDIUMFULL      ((HRESULT)0x80030070)

/* ---------------- IUnknown / IStream ---------------- */

typedef struct IUnknown IUnknown;
typedef struct IStream  IStream;

typedef struct IUnknownVtbl {
    HRESULT (*QueryInterface)(IUnknown *self, REFIID riid, void **ppv);
    ULONG   (*AddRef)(IUnknown *self);
    ULONG   (*Release)(IUnknown *self);
} IUnknownVtbl;

struct IUnknown { const IUnknownVtbl *lpVtbl; };

/* STATSTG — only the fields a memory stream can honestly fill are ever
 * written (cbSize, type, grfMode); the rest are zeroed. */
typedef struct tagSTATSTG {
    LPWSTR           pwcsName;
    DWORD            type;
    ULARGE_INTEGER   cbSize;
    FILETIME         mtime;
    FILETIME         ctime;
    FILETIME         atime;
    DWORD            grfMode;
    DWORD            grfLocksSupported;
    CLSID            clsid;
    DWORD            grfStateBits;
    DWORD            reserved;
} STATSTG;

#define STGTY_STORAGE   1
#define STGTY_STREAM    2
#define STGTY_LOCKBYTES 3
#define STGTY_PROPERTY  4

#define STREAM_SEEK_SET 0
#define STREAM_SEEK_CUR 1
#define STREAM_SEEK_END 2

#define STATFLAG_DEFAULT 0
#define STATFLAG_NONAME  1

#define STGM_READ       0x00000000L
#define STGM_WRITE      0x00000001L
#define STGM_READWRITE  0x00000002L

typedef struct IStreamVtbl {
    /* IUnknown */
    HRESULT (*QueryInterface)(IStream *self, REFIID riid, void **ppv);
    ULONG   (*AddRef)(IStream *self);
    ULONG   (*Release)(IStream *self);
    /* ISequentialStream */
    HRESULT (*Read)(IStream *self, void *pv, ULONG cb, ULONG *pcbRead);
    HRESULT (*Write)(IStream *self, const void *pv, ULONG cb, ULONG *pcbWritten);
    /* IStream */
    HRESULT (*Seek)(IStream *self, LARGE_INTEGER move, DWORD origin,
                    ULARGE_INTEGER *newPos);
    HRESULT (*SetSize)(IStream *self, ULARGE_INTEGER size);
    HRESULT (*CopyTo)(IStream *self, IStream *dst, ULARGE_INTEGER cb,
                      ULARGE_INTEGER *read, ULARGE_INTEGER *written);
    HRESULT (*Commit)(IStream *self, DWORD flags);
    HRESULT (*Revert)(IStream *self);
    HRESULT (*LockRegion)(IStream *self, ULARGE_INTEGER off,
                          ULARGE_INTEGER cb, DWORD type);
    HRESULT (*UnlockRegion)(IStream *self, ULARGE_INTEGER off,
                            ULARGE_INTEGER cb, DWORD type);
    HRESULT (*Stat)(IStream *self, STATSTG *stat, DWORD flags);
    HRESULT (*Clone)(IStream *self, IStream **out);
} IStreamVtbl;

struct IStream { const IStreamVtbl *lpVtbl; };

#define IStream_QueryInterface(p, a, b) ((p)->lpVtbl->QueryInterface(p, a, b))
#define IStream_AddRef(p)               ((p)->lpVtbl->AddRef(p))
#define IStream_Release(p)              ((p)->lpVtbl->Release(p))
#define IStream_Read(p, a, b, c)        ((p)->lpVtbl->Read(p, a, b, c))
#define IStream_Write(p, a, b, c)       ((p)->lpVtbl->Write(p, a, b, c))
#define IStream_Seek(p, a, b, c)        ((p)->lpVtbl->Seek(p, a, b, c))
#define IStream_SetSize(p, a)           ((p)->lpVtbl->SetSize(p, a))
#define IStream_Stat(p, a, b)           ((p)->lpVtbl->Stat(p, a, b))

/* ---------------- ole32 entry points ---------------- */

/* OleInitialize/OleUninitialize are REAL for what they can be: this OS
 * has no apartment model to enter, so the only observable contract is
 * the balanced init count and S_OK/S_FALSE — which is what they return.
 * That is a complete implementation of the semantic that exists here,
 * not a stub standing in for absent work. */
HRESULT OleInitialize(LPVOID reserved);
void    OleUninitialize(void);

/* CreateStreamOnHGlobal: the memory stream. `deleteOnRelease` transfers
 * ownership of the HGLOBAL to the stream (GlobalFree at last Release),
 * exactly as on Windows. The stream GROWS on write past the end
 * (GlobalReAlloc semantics), and SetSize both grows and truncates. */
HRESULT CreateStreamOnHGlobal(HGLOBAL hGlobal, BOOL deleteOnRelease,
                              IStream **ppStream);
HRESULT GetHGlobalFromStream(IStream *pStream, HGLOBAL *phGlobal);

/* No require block here on purpose: ole32.c is part of the BASE veneer
 * link set (os/win32/lib.json), so <windows.h> — which this header
 * includes — already requires it (source-lib design §4.1). */
