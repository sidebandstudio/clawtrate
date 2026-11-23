// Reads OpenClaw's settings file for the host (docs/design/setup-effortless.md
// §3, "The settings reader"), and proves who holds the far end of one of the
// host's loopback sockets (§3, "The send gate", checks (e) and (f)). It walks
// from the home folder the host opened, checked and passed as descriptor 3,
// by held descriptors, follows no link and checks what it opened. It never
// writes, repairs or runs anything.
//
//   ClawtrateLocalGateway read <profile folder> <file>          (fd 3: the home folder)
//   ClawtrateLocalGateway read-private <profile folder> <file>  (a sandboxed run's home)
//   ClawtrateLocalGateway prove <profile folder> <port> <local port>
//   ClawtrateLocalGateway prove-private <profile folder> <port> <local port>
//
// `read` writes "ok\n" followed by the file's bytes. `prove` writes
// "proved <pid> <start> <arch> <sha256> <lock bytes> <package bytes>\n", then
// the profile's gateway lock and the module's package.json, for the host to
// check. Either may instead write one line "refused <why>\n".
#define __STDC_WANT_LIB_EXT1__ 1
#include <CommonCrypto/CommonDigest.h>
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <mach-o/fat.h>
#include <mach-o/loader.h>
#include <membership.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/acl.h>
#include <sys/proc_info.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define SETTINGS_LIMIT (1024 * 1024)
#define LOCK_LIMIT (16 * 1024)
#define PACKAGE_LIMIT (512 * 1024)
#define MODULE_LIMIT (64 * 1024 * 1024)
#define MAX_HOLDERS 16
// A test build may skew the start the scan records, or the one (f) checks last, to show (f)
// refuses a process whose start changed at either end.
#ifndef PROVE_START_SKEW
#define PROVE_START_SKEW 0
#endif
#ifndef PROVE_LATE_SKEW
#define PROVE_LATE_SKEW 0
#endif

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

/**
 * Whether an ACL entry allows anyone but this account anything, or with
 * `changesOnly`, anything that changes a folder's entries or its access: add
 * a file or folder, delete an entry, rewrite the ACL or take ownership. A
 * deny adds no permission, so a deny entry never counts.
 */
static int aclGrantsOthers(int fd, int changesOnly) {
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
            acl_permset_t perms;
            if (grants && changesOnly) {
                const acl_perm_t changes[] = {ACL_ADD_FILE, ACL_ADD_SUBDIRECTORY, ACL_DELETE_CHILD,
                                              ACL_WRITE_SECURITY, ACL_CHANGE_OWNER};
                grants = 0;
                if (acl_get_permset(entry, &perms) != 0) grants = 1;
                for (size_t i = 0; !grants && i < sizeof changes / sizeof *changes; ++i)
                    grants = acl_get_perm_np(perms, changes[i]) != 0;
            }
        }
    }
    acl_free(acl);
    return grants;
}

/**
 * The folder is this account's and private; the file is this account's, 0600,
 * with one link, and no larger than `limit` (0: any size, for a file not read).
 */
static const char *checkOpened(int fd, int folder, off_t limit) {
    struct stat st;
    if (fstat(fd, &st) != 0) return "failed";
    if (folder ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode)) return "type";
    if (st.st_uid != geteuid()) return "owner";
    if (folder ? (st.st_mode & 077) != 0 : (st.st_mode & 07777) != 0600) return "mode";
    if (!folder && st.st_nlink != 1) return "links";
    if (aclGrantsOthers(fd, 0)) return "acl";
    if (!folder && limit > 0 && st.st_size > limit) return "large";
    return NULL;
}

/**
 * The home folder the host held and passed as fd 3, checked here too: a
 * folder of this account's that no other account can add to, remove from or
 * re-permission, by its mode or its ACL. A sandboxed run's home must be
 * private, as the profile folder is: no group or other bits, and no ACL that
 * allows anyone else anything.
 */
static const char *checkHome(int fd, int private) {
    struct stat st;
    if (fstat(fd, &st) != 0) return "failed";
    if (!S_ISDIR(st.st_mode)) return "type";
    if (st.st_uid != geteuid()) return "owner";
    if ((st.st_mode & (private ? 077 : 022)) != 0) return "mode";
    return aclGrantsOthers(fd, !private) ? "acl" : NULL;
}

/** Reads to the end, refusing more than `limit` however large the file was when checked. */
static const char *readBounded(int fd, char *buffer, size_t limit, size_t *length) {
    *length = 0;
    for (;;) {
        ssize_t got = read(fd, buffer + *length, limit + 1 - *length);
        if (got < 0 && errno == EINTR) continue;
        if (got < 0) return "failed";
        if (got == 0) return NULL;
        *length += (size_t)got;
        if (*length > limit) return "large";
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

/** A private folder of this account's beneath `parent`, opened without following a link. */
static int openFolder(int parent, const char *name, const char **why) {
    int folder = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    *why = folder < 0 ? openFailure(parent, name) : checkOpened(folder, 1, 0);
    if (*why && folder >= 0) close(folder);
    return *why ? -1 : folder;
}

/**
 * A file of this account's beneath `folder`, by the reader's rules: no link,
 * device or FIFO, nonblocking with no controlling terminal, then checked on
 * what was opened.
 */
static int openFile(int folder, const char *name, off_t limit, const char **why) {
    *why = preflight(folder, name);
    int file = *why ? -1
                    : openat(folder, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY | O_CLOEXEC);
    if (!*why && file < 0) *why = openFailure(folder, name);
    if (!*why) *why = checkOpened(file, 0, limit);
    if (*why && file >= 0) close(file);
    return *why ? -1 : file;
}

/** The file's bytes, or why not; on success the caller owns and wipes the buffer. */
static const char *readSettings(int home, int privateHome, const char *folderName,
                                const char *fileName, char **buffer, size_t *length) {
    *buffer = NULL;
    *length = 0;
    const char *why = checkHome(home, privateHome);
    if (why) return why;
    int folder = openFolder(home, folderName, &why);
    int file = why ? -1 : openFile(folder, fileName, SETTINGS_LIMIT, &why);
    if (folder >= 0) close(folder);
    if (!why) *buffer = malloc(SETTINGS_LIMIT + 1);
    if (!why) why = *buffer ? readBounded(file, *buffer, SETTINGS_LIMIT, length) : "failed";
    if (file >= 0) close(file);
    if (why && *buffer) {
        memset_s(*buffer, SETTINGS_LIMIT + 1, 0, SETTINGS_LIMIT + 1);
        free(*buffer);
        *buffer = NULL;
    }
    return why;
}

/** A port as the host writes it: 1 to 65535 in plain decimal. */
static int portArg(const char *text) {
    if (!*text || strlen(text) > 5 || text[0] == '0') return 0;
    for (const char *c = text; *c; ++c)
        if (*c < '0' || *c > '9') return 0;
    int port = atoi(text);
    return port <= 65535 ? port : 0;
}

/** 127.0.0.1, as IPv4 or as an IPv4-mapped IPv6 address. */
static int loopback(const struct in_sockinfo *ini, int local) {
    const struct in6_addr *six = local ? &ini->insi_laddr.ina_6 : &ini->insi_faddr.ina_6;
    const struct in_addr *four =
        local ? &ini->insi_laddr.ina_46.i46a_addr4 : &ini->insi_faddr.ina_46.i46a_addr4;
    if (ini->insi_vflag & INI_IPV4) return four->s_addr == htonl(INADDR_LOOPBACK);
    return (ini->insi_vflag & INI_IPV6) && IN6_IS_ADDR_V4MAPPED(six) &&
           memcmp(&six->s6_addr[12], "\x7f\0\0\x01", 4) == 0;
}

/**
 * A process's descriptors, possibly none; NULL only when it is gone or can't
 * be read, with errno set. libproc answers 0 bytes both for a failure, which
 * sets errno, and for a process with no descriptors, which leaves it alone:
 * errno is cleared first so a stale one is never taken for a failure.
 */
static struct proc_fdinfo *descriptors(pid_t pid, int *count) {
    *count = 0;
    errno = 0;
    int size = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
    if (size < 0 || (size == 0 && errno != 0)) return NULL;
    size += 32 * (int)sizeof(struct proc_fdinfo);
    struct proc_fdinfo *fds = malloc((size_t)size);
    if (!fds) return NULL;
    errno = 0;
    int got = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, size);
    if (got < 0 || (got == 0 && errno != 0)) {
        free(fds);
        return NULL;
    }
    *count = got / (int)sizeof(struct proc_fdinfo);
    return fds;
}

/**
 * Check (e): every process that holds the server end of the connection
 * 127.0.0.1:<port> <- 127.0.0.1:<local port>, all of them this account's, and
 * at least one. Another account's processes are invisible here (the kernel
 * refuses their descriptors), so a connection held only by one finds none.
 * An accepted connection may not be in its holder's table yet, so a scan that
 * finds nothing is repeated for up to 1.5 s, within the host's 2 s deadline.
 * Each holder's start time is kept with its PID, as the scan saw it.
 */
static int holders(int port, int localPort, pid_t *found, uint64_t *starts, const char **why) {
    uint64_t until = clock_gettime_nsec_np(CLOCK_UPTIME_RAW) + 1500ull * 1000 * 1000;
    while (clock_gettime_nsec_np(CLOCK_UPTIME_RAW) < until) {
        int count = proc_listallpids(NULL, 0);
        pid_t *pids = count > 0 ? calloc((size_t)count + 256, sizeof(pid_t)) : NULL;
        count = pids ? proc_listallpids(pids, (int)((count + 256) * sizeof(pid_t))) : 0;
        int held = 0;
        *why = count > 0 ? NULL : "failed";
        for (int i = 0; !*why && i < count; ++i) {
            struct proc_bsdinfo info;
            if (pids[i] <= 0 ||
                proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &info, sizeof info) != sizeof info)
                continue;
            int n = 0;
            struct proc_fdinfo *fds = descriptors(pids[i], &n);
            // One of this account's processes whose descriptors can't be read: unverified.
            if (!fds && errno != ESRCH && info.pbi_uid == geteuid()) *why = "denied";
            for (int f = 0; fds && !*why && f < n; ++f) {
                struct socket_fdinfo socket;
                if (fds[f].proc_fdtype != PROX_FDTYPE_SOCKET ||
                    proc_pidfdinfo(pids[i], fds[f].proc_fd, PROC_PIDFDSOCKETINFO, &socket,
                                   sizeof socket) != sizeof socket ||
                    socket.psi.soi_kind != SOCKINFO_TCP)
                    continue;
                const struct in_sockinfo *ini = &socket.psi.soi_proto.pri_tcp.tcpsi_ini;
                if (!loopback(ini, 1) || !loopback(ini, 0) ||
                    ntohs((uint16_t)ini->insi_lport) != port ||
                    ntohs((uint16_t)ini->insi_fport) != localPort)
                    continue;
                if (info.pbi_uid != geteuid() || info.pbi_ruid != geteuid()) *why = "account";
                else if (held == MAX_HOLDERS) *why = "holder";
                else if (held == 0 || found[held - 1] != pids[i]) {
                    starts[held] = info.pbi_start_tvsec * 1000000ull + info.pbi_start_tvusec +
                                   PROVE_START_SKEW;
                    found[held++] = pids[i];
                }
            }
            free(fds);
        }
        free(pids);
        if (*why || held > 0) return *why ? 0 : held;
        struct timespec pause = {0, 25 * 1000 * 1000};
        nanosleep(&pause, NULL);
    }
    *why = "holder";
    return 0;
}

/**
 * The process the scan saw, by its PID and its start time to the microsecond:
 * a PID another process took since is refused. Its kernel facts go to `info`.
 */
static const char *sameProcess(pid_t pid, uint64_t start, struct proc_bsdinfo *info) {
    return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, sizeof *info) == sizeof *info &&
                   info->pbi_start_tvsec * 1000000ull + info->pbi_start_tvusec == start
               ? NULL
               : "holder";
}

/** Whether the process holds a descriptor on exactly this file, by device and inode. */
static int holdsFile(pid_t pid, const struct stat *file) {
    int count = 0, holds = 0;
    struct proc_fdinfo *fds = descriptors(pid, &count);
    for (int f = 0; fds && !holds && f < count; ++f) {
        struct vnode_fdinfo vnode;
        holds = fds[f].proc_fdtype == PROX_FDTYPE_VNODE &&
                proc_pidfdinfo(pid, fds[f].proc_fd, PROC_PIDFDVNODEINFO, &vnode, sizeof vnode) ==
                    sizeof vnode &&
                vnode.pvi.vi_stat.vst_dev == (uint32_t)file->st_dev &&
                vnode.pvi.vi_stat.vst_ino == file->st_ino;
    }
    free(fds);
    return holds;
}

/** The program the kernel says the process runs is a Mach-O file named `node`. */
static int runsNode(pid_t pid) {
    char path[PROC_PIDPATHINFO_MAXSIZE];
    if (proc_pidpath(pid, path, sizeof path) <= 0) return 0;
    const char *name = strrchr(path, '/');
    if (!name || strcmp(name, "/node") != 0) return 0;
    int fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY | O_CLOEXEC);
    struct stat st;
    uint32_t magic = 0;
    int node = fd >= 0 && fstat(fd, &st) == 0 && S_ISREG(st.st_mode) &&
               read(fd, &magic, sizeof magic) == sizeof magic &&
               (magic == MH_MAGIC_64 || magic == FAT_CIGAM || magic == FAT_CIGAM_64);
    if (fd >= 0) close(fd);
    return node;
}

/** The SHA-256 of the open file, as lowercase hex. */
static const char *hashFile(int fd, char hex[65]) {
    CC_SHA256_CTX context;
    CC_SHA256_Init(&context);
    char chunk[65536];
    size_t total = 0;
    for (;;) {
        ssize_t got = read(fd, chunk, sizeof chunk);
        if (got < 0 && errno == EINTR) continue;
        if (got < 0) return "failed";
        if (got == 0) break;
        total += (size_t)got;
        if (total > MODULE_LIMIT) return "large";
        CC_SHA256_Update(&context, chunk, (CC_LONG)got);
    }
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256_Final(digest, &context);
    for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; ++i) snprintf(hex + 2 * i, 3, "%02x", digest[i]);
    return NULL;
}

/**
 * OpenClaw's native module, as the process maps it: a region backed by
 * `<root>/node_modules/@openclaw/fs-safe-darwin-<arch>/fs-safe-native.node`,
 * opened here without following a link and matched to that region by device
 * and inode, then hashed. `root` is the package that depends on it.
 */
static const char *mappedModule(pid_t pid, char root[PATH_MAX], const char **arch, char hex[65]) {
    static const char marker[] = "/node_modules/@openclaw/fs-safe-darwin-";
    struct proc_regionwithpathinfo region;
    uint64_t address = 0;
    for (int i = 0; i < 1 << 20; ++i) {
        if (proc_pidinfo(pid, PROC_PIDREGIONPATHINFO, address, &region, sizeof region) !=
            sizeof region)
            break;
        const char *path = region.prp_vip.vip_path;
        const char *at = strstr(path, marker);
        const char *rest = at ? at + sizeof marker - 1 : NULL;
        *arch = !rest                                               ? NULL
                : strcmp(rest, "arm64/fs-safe-native.node") == 0 ? "arm64"
                : strcmp(rest, "x64/fs-safe-native.node") == 0   ? "x64"
                                                                    : NULL;
        if (*arch && (size_t)(at - path) < PATH_MAX - 16) {
            int fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY | O_CLOEXEC);
            struct stat st;
            const char *why =
                fd < 0 || fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) ||
                        (uint32_t)st.st_dev != region.prp_vip.vip_vi.vi_stat.vst_dev ||
                        st.st_ino != region.prp_vip.vip_vi.vi_stat.vst_ino
                    ? "module"
                    : hashFile(fd, hex);
            if (fd >= 0) close(fd);
            memcpy(root, path, (size_t)(at - path));
            root[at - path] = '\0';
            return why;
        }
        uint64_t next = region.prp_prinfo.pri_address + region.prp_prinfo.pri_size;
        if (next <= address) break;
        address = next;
    }
    return "module";
}

/** A small file's bytes, read without following its last link; the caller frees them. */
static const char *readSmall(const char *path, size_t limit, char **buffer, size_t *length) {
    int fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY | O_CLOEXEC);
    struct stat st;
    const char *why = fd < 0 || fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) ? "module" : NULL;
    *buffer = why ? NULL : malloc(limit + 1);
    if (!why) why = *buffer ? readBounded(fd, *buffer, limit, length) : "failed";
    if (fd >= 0) close(fd);
    return why;
}

/** A missing step as the profile's own word for it; any other refusal as it is. */
static const char *missing(const char *why, const char *as) {
    return why && strcmp(why, "absent") == 0 ? as : why;
}

/**
 * The profile's gateway lock, read and identified, and the state database,
 * identified. A profile whose gateway isn't running has no lock, and may have
 * no database yet.
 */
static const char *profileFiles(int home, const char *folderName, struct stat *lock,
                                struct stat *database, char *lockBytes, size_t *lockLength) {
    char ownLock[32];
    snprintf(ownLock, sizeof ownLock, "openclaw-%u", (unsigned)geteuid());
    const char *names[] = {"tmp", ownLock};
    const char *why = NULL;
    int folder = openFolder(home, folderName, &why);
    int state = why ? -1 : openFolder(folder, "state", &why);
    if (folder >= 0) why = missing(why, "state");
    int base = folder, lockFile = -1, file = -1;
    for (size_t i = 0; !why && i < 2; ++i) {
        int next = openFolder(base, names[i], &why);
        if (base != folder) close(base);
        base = why ? -1 : next;
        why = missing(why, "lock");
    }
    if (!why) {
        lockFile = openFile(base, "gateway.state.lock", LOCK_LIMIT, &why);
        why = missing(why, "lock");
    }
    if (!why && fstat(lockFile, lock) != 0) why = "failed";
    if (!why) why = readBounded(lockFile, lockBytes, LOCK_LIMIT, lockLength);
    if (!why) {
        file = openFile(state, "openclaw.sqlite", 0, &why);
        why = missing(why, "state");
    }
    if (!why && fstat(file, database) != 0) why = "failed";
    if (lockFile >= 0) close(lockFile);
    if (file >= 0) close(file);
    if (base >= 0 && base != folder) close(base);
    if (state >= 0) close(state);
    if (folder >= 0) close(folder);
    return why;
}

/**
 * Checks (e) and (f) for the connection the host opened from <local port> to
 * <port>. Of the connection's holders, all this account's, the first that
 * passes (f) is written out with the facts the host checks: its start time,
 * the module's architecture and hash, the lock and the package.json. (f) runs
 * in this order: the same process the scan saw, then the profile's gateway
 * lock and state database held open, which opens nothing; only then the
 * program it runs and its mapped module, which are opened and read; last,
 * the same process again. So a process that isn't this profile's gateway has
 * nothing of its opened here, and a PID taken over midway is refused.
 */
static int prove(int home, int privateHome, const char *folderName, int port, int localPort) {
    static char lockBytes[LOCK_LIMIT + 1];
    size_t lockLength = 0;
    struct stat lock, database;
    const char *why = checkHome(home, privateHome);
    if (!why) why = profileFiles(home, folderName, &lock, &database, lockBytes, &lockLength);
    pid_t found[MAX_HOLDERS];
    uint64_t starts[MAX_HOLDERS];
    int count = why ? 0 : holders(port, localPort, found, starts, &why);
    if (!why) why = "lock";
    for (int i = 0; i < count; ++i) {
        char root[PATH_MAX], hex[65], packagePath[PATH_MAX + 16];
        struct proc_bsdinfo info;
        const char *arch = NULL, *because = sameProcess(found[i], starts[i], &info);
        if (!because) because = holdsFile(found[i], &lock) ? NULL : "lock";
        if (!because) because = holdsFile(found[i], &database) ? NULL : "state";
        if (!because) because = runsNode(found[i]) ? NULL : "node";
        if (!because) because = mappedModule(found[i], root, &arch, hex);
        char *package = NULL;
        size_t packageLength = 0;
        snprintf(packagePath, sizeof packagePath, "%s/package.json", because ? "" : root);
        if (!because) because = readSmall(packagePath, PACKAGE_LIMIT, &package, &packageLength);
        // And still that process, so every fact above is about the one the scan saw.
        if (!because) because = sameProcess(found[i], starts[i] + PROVE_LATE_SKEW, &info);
        if (!because) {
            int written =
                printf("proved %d %llu %s %s %zu %zu\n", found[i],
                       (unsigned long long)info.pbi_start_tvsec, arch, hex, lockLength,
                       packageLength) > 0 &&
                fwrite(lockBytes, 1, lockLength, stdout) == lockLength &&
                fwrite(package, 1, packageLength, stdout) == packageLength && fflush(stdout) == 0;
            free(package);
            return written ? 0 : 1;
        }
        free(package);
        if (i == 0) why = because;
    }
    return refuse(why);
}

int main(int argc, char **argv) {
    const char *command = argc > 1 ? argv[1] : "";
    int privateHome = strcmp(command, "read-private") == 0 || strcmp(command, "prove-private") == 0;
    if ((strcmp(command, "prove") == 0 || strcmp(command, "prove-private") == 0) && argc == 5) {
        int port = portArg(argv[3]), localPort = portArg(argv[4]);
        if (!component(argv[2]) || !port || !localPort || port == localPort) return 2;
        int status = prove(3, privateHome, argv[2], port, localPort);
        close(3);
        return status;
    }
    if (argc != 4 || (strcmp(command, "read") != 0 && strcmp(command, "read-private") != 0) ||
        !component(argv[2]) || !component(argv[3]))
        return 2;
    char *buffer;
    size_t length;
    const char *why = readSettings(3, privateHome, argv[2], argv[3], &buffer, &length);
    close(3);
    if (why) return refuse(why);
    int written = fputs("ok\n", stdout) >= 0 && fwrite(buffer, 1, length, stdout) == length &&
                  fflush(stdout) == 0;
    memset_s(buffer, SETTINGS_LIMIT + 1, 0, SETTINGS_LIMIT + 1);
    free(buffer);
    return written ? 0 : 1;
}
