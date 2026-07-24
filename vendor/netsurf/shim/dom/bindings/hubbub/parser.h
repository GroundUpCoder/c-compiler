/* Install-tree alias: upstream installs libdom's hubbub-binding headers
 * as <dom/bindings/hubbub/…>; the vendored build has no install step, so
 * this wrapper maps the installed name onto the source tree. */
#include "../../../../libdom/bindings/hubbub/parser.h"
