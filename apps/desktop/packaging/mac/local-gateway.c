// Reads OpenClaw's settings file for the host (docs/design/setup-effortless.md
// §3, "The settings reader"). It walks from the home folder the host opened,
// checked and passed as descriptor 3, by held descriptors, follows no link,
// checks what it opened, and writes the file's bytes to stdout. It never
// writes, repairs or runs anything.
//
//   ClawtrateLocalGateway read <profile folder> <file>   (fd 3: the home folder)
//
// stdout is "ok\n" followed by the file's bytes, or one line "refused <why>\n".
#define __STDC_WANT_LIB_EXT1__ 1
#include <errno.h>
#include <fcntl.h>
#include <membership.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/acl.h>
#include <sys/stat.h>
#include <unistd.h>

#define SETTINGS_LIMIT (1024 * 1024)

/** One path component: no separator, not "." or "..", and short. */
static int component(const char *name) {
    size_t length = strlen(name);
    return length > 0 && length <= 255 && !strchr(name, '/') && strcmp(name, ".") != 0 &&
           strcmp(name, "..") != 0;
}

/** Why openat failed. A link opened as a folder fails as "not a folder", so it is told apart. */
static const char *openFailure(int parent, const char *name) {
    struct stat st;
    switch (errno) {
    case ENOENT: return "absent";
    case ELOOP: return "link";
    case ENOTDIR:
        return fstatat(parent, name, &st, AT_SYMLINK_NOFOLLOW) == 0 && S_ISLNK(st.st_mode) ? "link"
                                                                                          : "type";
    case EACCES:
    case EPERM: return "denied";
    default: return "failed";
    }
}

/** Whether an ACL entry allows anything to anyone but this account. */
static int aclGrantsOthers(int fd) {
    acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
    if (!acl) return errno == ENOENT ? 0 : 1;
    int grants = 0;
    acl_entry_t entry;
    for (int which = ACL_FIRST_ENTRY; !grants && acl_get_entry(acl, which, &entry) == 0;
         which = ACL_NEXT_ENTRY) {
        acl_tag_t tag;
        if (acl_get_tag_type(entry, &tag) != 0) grants = 1;
        else if (tag == ACL_EXTENDED_ALLOW) {
            guid_t *who = acl_get_qualifier(entry);
            id_t id;
            int type;
            grants = !who || mbr_uuid_to_id(who->g_guid, &id, &type) != 0 || type != ID_TYPE_UID ||
                     id != geteuid();
            if (who) acl_free(who);
        }
    }
    acl_free(acl);
    return grants;
}

/** The folder is this account's and private; the file is this account's, 0600, with one link. */
static const char *checkOpened(int fd, int folder) {
    struct stat st;
    if (fstat(fd, &st) != 0) return "failed";
    if (folder ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode)) return "type";
    if (st.st_uid != geteuid()) return "owner";
    if (folder ? (st.st_mode & 077) != 0 : (st.st_mode & 07777) != 0600) return "mode";
    if (!folder && st.st_nlink != 1) return "links";
    if (aclGrantsOthers(fd)) return "acl";
    if (!folder && st.st_size > SETTINGS_LIMIT) return "large";
    return NULL;
}

/** Reads to the end, refusing more than the limit however large the file was when checked. */
static const char *readBounded(int fd, char *buffer, size_t *length) {
    *length = 0;
    for (;;) {
        ssize_t got = read(fd, buffer + *length, SETTINGS_LIMIT + 1 - *length);
        if (got < 0 && errno == EINTR) continue;
        if (got < 0) return "failed";
        if (got == 0) return NULL;
        *length += (size_t)got;
        if (*length > SETTINGS_LIMIT) return "large";
    }
}

static int refuse(const char *why) {
    return printf("refused %s\n", why) > 0 && fflush(stdout) == 0 ? 0 : 1;
}

/** Refuses a link, a device or a FIFO by its no-follow stat, before anything opens it. */
static const char *preflight(int folder, const char *name) {
    struct stat st;
    if (fstatat(folder, name, &st, AT_SYMLINK_NOFOLLOW) != 0) return openFailure(folder, name);
    if (S_ISLNK(st.st_mode)) return "link";
    return S_ISREG(st.st_mode) ? NULL : "type";
}

/** The file's bytes, or why not; on success the caller owns and wipes the buffer. */
static const char *readSettings(int home, const char *folderName, const char *fileName,
                                char **buffer, size_t *length) {
    *buffer = NULL;
    *length = 0;
    int folder = openat(home, folderName, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    const char *why = folder < 0 ? openFailure(home, folderName) : checkOpened(folder, 1);
    if (!why) why = preflight(folder, fileName);
    // Nonblocking and no controlling terminal; the checks run again on what was opened.
    int file = why ? -1
                   : openat(folder, fileName,
                            O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY | O_CLOEXEC);
    if (!why && file < 0) why = openFailure(folder, fileName);
    if (folder >= 0) close(folder);
    if (!why) why = checkOpened(file, 0);
    if (!why) *buffer = malloc(SETTINGS_LIMIT + 1);
    if (!why) why = *buffer ? readBounded(file, *buffer, length) : "failed";
    if (file >= 0) close(file);
    if (why && *buffer) {
        memset_s(*buffer, SETTINGS_LIMIT + 1, 0, SETTINGS_LIMIT + 1);
        free(*buffer);
        *buffer = NULL;
    }
    return why;
}

int main(int argc, char **argv) {
    if (argc != 4 || strcmp(argv[1], "read") != 0 || !component(argv[2]) || !component(argv[3]))
        return 2;
    char *buffer;
    size_t length;
    const char *why = readSettings(3, argv[2], argv[3], &buffer, &length);
    close(3);
    if (why) return refuse(why);
    int written = fputs("ok\n", stdout) >= 0 && fwrite(buffer, 1, length, stdout) == length &&
                  fflush(stdout) == 0;
    memset_s(buffer, SETTINGS_LIMIT + 1, 0, SETTINGS_LIMIT + 1);
    free(buffer);
    return written ? 0 : 1;
}
