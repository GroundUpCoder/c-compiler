/*
 * curl/curl.h — gucOS libcurl veneer (todos/0173), easy interface subset.
 *
 * App-facing header for programs built for gucOS against os/curl/libcurl.c,
 * which maps the easy interface onto the kernel HTTP transport (todos/0172,
 * the __http_* host imports). The SAME consumer source builds natively with
 * clang -lcurl against the real libcurl headers — so every name, enum value
 * and callback signature here matches upstream curl's ABI values. Only a
 * subset exists; unknown/unsupported options return CURLE_UNKNOWN_OPTION
 * (loud-failure, the kernel32 stub precedent).
 *
 * Documented divergences from real libcurl (see libcurl.c):
 *   - Redirects are followed silently by the transport (fetch
 *     redirect:'follow'); FOLLOWLOCATION/MAXREDIRS are accepted no-ops.
 *     CURLINFO_EFFECTIVE_URL returns the POST-REDIRECT final url (#359);
 *     intermediate hops are unknowable (fetch follows opaquely).
 *   - Header callback lines are synthesized from the transport's flattened
 *     header blob: casing and order are whatever fetch yields, and a
 *     synthetic "HTTP/1.1 NNN \r\n" status line is prepended.
 *   - CONNECTTIMEOUT(_MS) rides the kernel HEADERS deadline; TIMEOUT(_MS)
 *     is enforced on the veneer's wall clock through __wait's timeout at
 *     every park (todos/0417 — the old SIGALRM apparatus is gone).
 *   - TLS is the platform's: SSL_VERIFYPEER/VERIFYHOST accepted, ignored.
 *   - ACCEPT_ENCODING accepted, ignored (fetch decompresses transparently).
 */
#ifndef GUCOS_CURL_CURL_H
#define GUCOS_CURL_CURL_H

#include <stddef.h>

typedef void CURL;
typedef long long curl_off_t;

#define CURL_ERROR_SIZE 256

/* Subset of upstream CURLcode, upstream values. */
typedef enum {
  CURLE_OK = 0,
  CURLE_UNSUPPORTED_PROTOCOL = 1,
  CURLE_FAILED_INIT = 2,
  CURLE_URL_MALFORMAT = 3,
  CURLE_COULDNT_RESOLVE_HOST = 6,
  CURLE_COULDNT_CONNECT = 7,
  CURLE_REMOTE_ACCESS_DENIED = 9,   /* a bridge policy refusal (EACCES; #392) */
  CURLE_HTTP_RETURNED_ERROR = 22,
  CURLE_ABORTED_BY_CALLBACK = 42,
  CURLE_WRITE_ERROR = 23,
  CURLE_READ_ERROR = 26,
  CURLE_OUT_OF_MEMORY = 27,
  CURLE_OPERATION_TIMEDOUT = 28,
  CURLE_UNKNOWN_OPTION = 48,
  CURLE_RECV_ERROR = 56,
  CURL_LAST
} CURLcode;

/* Upstream numbering: 0+ long, 10000+ object pointer, 20000+ function
   pointer, 30000+ curl_off_t. setopt classifies its vararg by this. */
typedef enum {
  CURLOPT_TIMEOUT = 13,
  CURLOPT_VERBOSE = 41,
  CURLOPT_NOPROGRESS = 43,
  CURLOPT_NOBODY = 44,
  CURLOPT_POST = 47,
  CURLOPT_FOLLOWLOCATION = 52,
  CURLOPT_POSTFIELDSIZE = 60,
  CURLOPT_SSL_VERIFYPEER = 64,
  CURLOPT_MAXREDIRS = 68,
  CURLOPT_CONNECTTIMEOUT = 78,
  CURLOPT_HTTPGET = 80,
  CURLOPT_SSL_VERIFYHOST = 81,
  CURLOPT_NOSIGNAL = 99,
  CURLOPT_TIMEOUT_MS = 155,
  CURLOPT_CONNECTTIMEOUT_MS = 156,

  CURLOPT_WRITEDATA = 10001,
  CURLOPT_URL = 10002,
  CURLOPT_PROGRESSDATA = 10057,   /* upstream: XFERINFODATA aliases this */
  CURLOPT_READDATA = 10009,
  CURLOPT_ERRORBUFFER = 10010,
  CURLOPT_POSTFIELDS = 10015,
  CURLOPT_USERAGENT = 10018,
  CURLOPT_HTTPHEADER = 10023,
  CURLOPT_HEADERDATA = 10029,
  CURLOPT_CUSTOMREQUEST = 10036,
  CURLOPT_ACCEPT_ENCODING = 10102,

  CURLOPT_WRITEFUNCTION = 20011,
  CURLOPT_READFUNCTION = 20012,
  CURLOPT_HEADERFUNCTION = 20079,
  CURLOPT_XFERINFOFUNCTION = 20219,  /* called at every transfer wait
                                        boundary when NOPROGRESS is 0;
                                        non-zero return aborts the transfer
                                        (CURLE_ABORTED_BY_CALLBACK) */
  CURLOPT_LASTENTRY
} CURLoption;

/* Historical aliases (upstream keeps these too). */
#define CURLOPT_FILE        CURLOPT_WRITEDATA
#define CURLOPT_INFILE      CURLOPT_READDATA
#define CURLOPT_WRITEHEADER CURLOPT_HEADERDATA
#define CURLOPT_ENCODING    CURLOPT_ACCEPT_ENCODING
#define CURLOPT_XFERINFODATA CURLOPT_PROGRESSDATA

/* Upstream type nibbles: 0x100000 string, 0x200000 long, 0x300000 double,
   0x600000 curl_off_t. */
typedef enum {
  CURLINFO_EFFECTIVE_URL = 0x100001,
  CURLINFO_RESPONSE_CODE = 0x200002,
  CURLINFO_CONTENT_TYPE = 0x100012,
  CURLINFO_SIZE_DOWNLOAD_T = 0x600008,
  CURLINFO_CONTENT_LENGTH_DOWNLOAD_T = 0x60000F,
  CURLINFO_LASTONE
} CURLINFO;

#define CURL_GLOBAL_SSL       (1 << 0)
#define CURL_GLOBAL_WIN32     (1 << 1)
#define CURL_GLOBAL_ALL       (CURL_GLOBAL_SSL | CURL_GLOBAL_WIN32)
#define CURL_GLOBAL_NOTHING   0
#define CURL_GLOBAL_DEFAULT   CURL_GLOBAL_ALL

struct curl_slist {
  char *data;
  struct curl_slist *next;
};

typedef size_t (*curl_write_callback)(char *ptr, size_t size, size_t nmemb, void *userdata);
typedef size_t (*curl_read_callback)(char *buffer, size_t size, size_t nitems, void *userdata);
typedef int (*curl_xferinfo_callback)(void *clientp, curl_off_t dltotal, curl_off_t dlnow,
                                      curl_off_t ultotal, curl_off_t ulnow);

CURLcode curl_global_init(long flags);
void curl_global_cleanup(void);

CURL *curl_easy_init(void);
CURLcode curl_easy_setopt(CURL *handle, CURLoption option, ...);
CURLcode curl_easy_perform(CURL *handle);
CURLcode curl_easy_getinfo(CURL *handle, CURLINFO info, ...);
void curl_easy_reset(CURL *handle);
void curl_easy_cleanup(CURL *handle);
const char *curl_easy_strerror(CURLcode code);

struct curl_slist *curl_slist_append(struct curl_slist *list, const char *data);
void curl_slist_free_all(struct curl_slist *list);

char *curl_easy_escape(CURL *handle, const char *string, int length);
char *curl_easy_unescape(CURL *handle, const char *input, int length, int *outlength);
void curl_free(void *ptr);

const char *curl_version(void);

#endif /* GUCOS_CURL_CURL_H */
