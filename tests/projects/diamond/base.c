/* Shared leaf lib: reached by bin.json directly, via mid.json's dep, AND
 * via the base-link.json symlink — must be compiled exactly once
 * (docs/archive/0079). A second compile of this file is a duplicate definition
 * of base_value at link. */
int base_value(void) { return 21; }
