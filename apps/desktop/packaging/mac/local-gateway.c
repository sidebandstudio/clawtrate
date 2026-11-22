// Reads OpenClaw's settings file for the host (docs/design/setup-effortless.md
// §3, "The settings reader"). It walks from the home folder by held
// descriptors, follows no link, checks what it opened, and writes the file's
// bytes to stdout. It never writes, repairs or runs anything.
//
//   ClawtrateLocalGateway read <home> <profile folder> <file>
//
// stdout is one line, "ok" followed by the file's bytes, or "refused <why>".
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
    printf("refused %s\n", why);
    return 0;
}

static int readSettings(const char *home, const char *folderName, const char *fileName) {
    if (home[0] != '/' || !component(folderName) || !component(fileName)) return 2;
    // The home folder is the account's, from the system; nothing below it is followed.
    int root = open(home, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (root < 0) return refuse("failed");
    int folder = openat(root, folderName, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    const char *why = folder < 0 ? openFailure(root, folderName) : checkOpened(folder, 1);
    close(root);
    if (why) {
        if (folder >= 0) close(folder);
        return refuse(why);
    }
    // Nonblocking: a FIFO opens at once and fails the regular-file check.
    int file = openat(folder, fileName, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (file < 0) why = openFailure(folder, fileName);
    close(folder);
    if (file < 0) return refuse(why);
    why = checkOpened(file, 0);
    char *buffer = why ? NULL : malloc(SETTINGS_LIMIT + 1);
    size_t length = 0;
    if (!why) why = buffer ? readBounded(file, buffer, &length) : "failed";
    close(file);
    if (why) {
        free(buffer);
        return refuse(why);
    }
    fputs("ok\n", stdout);
    fwrite(buffer, 1, length, stdout);
    memset_s(buffer, length, 0, length);
    free(buffer);
    return fflush(stdout) == 0 ? 0 : 1;
}

int main(int argc, char **argv) {
    if (argc == 5 && strcmp(argv[1], "read") == 0) return readSettings(argv[2], argv[3], argv[4]);
    return 2;
}
