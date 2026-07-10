/* wine/debug.h — port-corpus compat stub (todos/0060). Wine's debug
 * channels compile away entirely here: winemine and friends TRACE into
 * the void. Grow into fprintf(stderr) plumbing if debugging a port ever
 * demands it. */
#pragma once

#define WINE_DEFAULT_DEBUG_CHANNEL(ch)
#define WINE_DECLARE_DEBUG_CHANNEL(ch)

#define WINE_TRACE(...) do { } while (0)
#define WINE_WARN(...)  do { } while (0)
#define WINE_FIXME(...) do { } while (0)
#define WINE_ERR(...)   do { } while (0)

#define TRACE  WINE_TRACE
#define WARN   WINE_WARN
#define FIXME  WINE_FIXME
/* no plain ERR alias: windows.h's region-complexity ERROR is nearby and
 * ReactOS sources use WINE_ERR under __REACTOS__ anyway */
