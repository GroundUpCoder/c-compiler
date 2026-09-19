/* This TU deliberately declares no classes or literals of its own. */
int inspect_literal(id object) {
    if (!__guc_objc_is_immortal(object)) return 1;
    if (__guc_objc_retain(object) != object || __guc_objc_release(object)
        || __guc_objc_retain_count(object) != 0xffffffffU) return 2;
    guc_objc_dispose(object);
    return 0;
}
