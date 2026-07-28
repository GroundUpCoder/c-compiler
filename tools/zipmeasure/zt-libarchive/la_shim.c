/* 0350 measurement shim: __archive_write_entry_filetype_unsupported lives in
 * archive_write_set_format.c, whose by-code table would pull in EVERY writer.
 * Reproduced verbatim from upstream 3.8.1 so the table TU can stay out.
 * (Real vendoring: patch the table down instead — record in the patch table.) */
#include "archive_platform.h"
#include "archive.h"
#include "archive_entry.h"
#include "archive_write_private.h"
#include "archive_write_set_format_private.h"

void
__archive_write_entry_filetype_unsupported(struct archive *a,
    struct archive_entry *entry, const char *format)
{
	const char *name = NULL;

	switch (archive_entry_filetype(entry)) {
	case AE_IFDIR:
		name = "directories";
		break;
	case AE_IFLNK:
		name = "symbolic links";
		break;
	case AE_IFCHR:
		name = "character devices";
		break;
	case AE_IFBLK:
		name = "block devices";
		break;
	case AE_IFIFO:
		name = "named pipes";
		break;
	case AE_IFSOCK:
		name = "sockets";
		break;
	default:
		break;
	}

	if (name != NULL) {
		archive_set_error(a, ARCHIVE_ERRNO_FILE_FORMAT,
		    "%s: %s format cannot archive %s",
		    archive_entry_pathname(entry), format, name);
	} else {
		archive_set_error(a, ARCHIVE_ERRNO_FILE_FORMAT,
		    "%s: %s format cannot archive files with mode 0%lo",
		    archive_entry_pathname(entry), format,
		    (unsigned long)archive_entry_mode(entry));
	}
}
