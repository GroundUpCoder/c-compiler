// Minimal UEFI PE application — prints a message and returns.
// Built by TCC x86-64 PE cross-compiler (tcc-x86_64-pe.wasm).
// Entry point: _start(ImageHandle, SystemTable) per UEFI spec.

typedef unsigned long long EFI_STATUS;
typedef void *EFI_HANDLE;
typedef unsigned short CHAR16;

// Simplified EFI_TABLE_HEADER
typedef struct {
  unsigned long long Signature;
  unsigned int Revision;
  unsigned int HeaderSize;
  unsigned int CRC32;
  unsigned int Reserved;
} EFI_TABLE_HEADER;

// OutputString function pointer type
typedef EFI_STATUS (*EFI_TEXT_STRING)(void *This, CHAR16 *String);

// EFI_SIMPLE_TEXT_OUTPUT_PROTOCOL — just enough for OutputString
typedef struct {
  void *Reset;
  EFI_TEXT_STRING OutputString;
  void *TestString;
} EFI_SIMPLE_TEXT_OUTPUT_PROTOCOL;

// EFI_SYSTEM_TABLE
typedef struct {
  EFI_TABLE_HEADER Hdr;
  CHAR16 *FirmwareVendor;
  unsigned int FirmwareRevision;
  void *ConsoleInHandle;
  void *ConIn;
  void *ConsoleOutHandle;
  EFI_SIMPLE_TEXT_OUTPUT_PROTOCOL *ConOut;
  void *StandardErrorHandle;
  void *StdErr;
  void *RuntimeServices;
  void *BootServices;
} EFI_SYSTEM_TABLE;

#define EFI_SUCCESS 0

EFI_STATUS _start(EFI_HANDLE ImageHandle, EFI_SYSTEM_TABLE *SystemTable) {
  CHAR16 msg[] = {'H','E','L','L','O',' ','U','E','F','I','!','\r','\n',0};
  SystemTable->ConOut->OutputString(SystemTable->ConOut, msg);
  // Hang so user can see output
  for (;;) {}
  return EFI_SUCCESS;
}
