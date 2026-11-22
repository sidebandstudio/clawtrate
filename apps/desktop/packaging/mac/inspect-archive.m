// Independent inspection only. This process never starts candidate code.
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <mach/machine.h>
#import <sys/stat.h>
#import <fcntl.h>
#import <unistd.h>
#import <signal.h>

// The macOS SDK ships the libarchive.2 stub without its C headers.
struct archive;
struct archive_entry;
extern struct archive *archive_read_new(void);
extern int archive_read_free(struct archive *);
extern int archive_read_support_format_zip_seekable(struct archive *);
extern int archive_read_open_fd(struct archive *, int, size_t);
extern int archive_read_next_header(struct archive *, struct archive_entry **);
extern ssize_t archive_read_data(struct archive *, void *, size_t);
extern const char *archive_entry_pathname_utf8(struct archive_entry *);
extern const char *archive_entry_symlink_utf8(struct archive_entry *);
extern const char *archive_entry_hardlink(struct archive_entry *);
extern mode_t archive_entry_mode(struct archive_entry *);
extern int64_t archive_entry_size(struct archive_entry *);
extern int archive_entry_is_encrypted(struct archive_entry *);

static NSArray<NSString *> *parts(NSString *name) {
    if (!name || !name.length || name.length > 1024 ||
        [name rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location != NSNotFound ||
        [name containsString:@"\\"] || [name containsString:@":"]) return nil;
    NSArray *result = [name componentsSeparatedByString:@"/"];
    if (result.count > 48 || [result containsObject:@""] ||
        [result containsObject:@"."] || [result containsObject:@".."]) return nil;
    return result;
}

// Descend by directory descriptor. Never write through an archive link or overwrite an entry.
static int directoryAt(int parent, const char *name, unsigned *entries) {
    const int flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW;
    int fd = openat(parent, name, flags);
    if (fd >= 0 || errno != ENOENT || !*entries) return fd;
    if (mkdirat(parent, name, 0700) != 0) return -1;
    --*entries;
    return openat(parent, name, flags);
}

static int parentFor(int root, NSArray<NSString *> *names, unsigned *entries) {
    int dir = dup(root);
    for (NSUInteger i = 0; dir >= 0 && i + 1 < names.count; ++i) {
        const char *name = names[i].fileSystemRepresentation;
        int next = directoryAt(dir, name, entries);
        close(dir);
        dir = next;
    }
    return dir;
}

static BOOL extractEntry(struct archive *zip, struct archive_entry *entry, int root,
                         NSMutableSet *seen, int64_t *remaining, unsigned *entries) {
    const char *raw = archive_entry_pathname_utf8(entry);
    NSString *path = raw ? [NSString stringWithUTF8String:raw] : nil;
    if ([path hasSuffix:@"/"]) path = [path substringToIndex:path.length - 1];
    NSArray<NSString *> *names = parts(path);
    if (![names.firstObject isEqual:@"Clawtrate.app"] || archive_entry_hardlink(entry) ||
        archive_entry_is_encrypted(entry)) return NO;
    for (NSUInteger i = 1; i < names.count; ++i) {
        if (![names[i].lowercaseString hasSuffix:@".app"]) continue;
        NSArray *helpers = @[@"Clawtrate Helper.app", @"Clawtrate Helper (GPU).app",
                             @"Clawtrate Helper (Plugin).app", @"Clawtrate Helper (Renderer).app"];
        if (i != 3 || ![names[1] isEqual:@"Contents"] || ![names[2] isEqual:@"Frameworks"] ||
            ![helpers containsObject:names[i]]) return NO;
    }
    NSString *key = path.precomposedStringWithCanonicalMapping.lowercaseString;
    if ([seen containsObject:key]) return NO;
    [seen addObject:key];
    mode_t mode = archive_entry_mode(entry);
    int64_t size = archive_entry_size(entry);
    if (size < 0 || size > *remaining || (names.count == 1 && !S_ISDIR(mode))) return NO;
    if ([names.lastObject isEqual:@"Info.plist"] && (!S_ISREG(mode) || size > 1024 * 1024)) return NO;
    int dir = parentFor(root, names, entries);
    if (dir < 0) return NO;
    const char *leaf = names.lastObject.fileSystemRepresentation;
    BOOL ok = NO;
    if (S_ISDIR(mode)) {
        int child = size == 0 ? directoryAt(dir, leaf, entries) : -1;
        ok = child >= 0 && close(child) == 0;
    } else if (S_ISLNK(mode)) {
        const char *target = archive_entry_symlink_utf8(entry);
        // Framework symlinks point down or across within the bundle. Disallow upward hops,
        // including through another link, so the signature reader also stays inside the app.
        ok = *entries && target && parts([NSString stringWithUTF8String:target]) &&
            symlinkat(target, dir, leaf) == 0;
        if (ok) --*entries;
    } else if (S_ISREG(mode) && *entries) {
        int file = openat(dir, leaf, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
                          (mode & 0111) ? 0700 : 0600);
        if (file >= 0) {
            --*entries;
            char buf[65536];
            ssize_t count;
            int64_t total = 0;
            while ((count = archive_read_data(zip, buf, sizeof(buf))) > 0) {
                total += count;
                if (total > size || write(file, buf, count) != count) break;
            }
            ok = close(file) == 0 && count == 0 && total == size;
            *remaining -= size;
        }
    }
    close(dir);
    return ok;
}

static uint32_t le16(const unsigned char *p) { return p[0] | p[1] << 8; }
static uint32_t le32(const unsigned char *p) { return le16(p) | le16(p + 2) << 16; }
static BOOL readAt(int fd, unsigned char *buf, size_t size, off_t at) {
    return pread(fd, buf, size, at) == (ssize_t)size;
}

// libarchive's seekable reader indexes the whole central directory on its first header and
// decodes methods packaging never writes. Before it opens the archive, walk that directory
// with fixed buffers and accept only the shape a release ZIP has.
static BOOL preflight(int fd) {
    unsigned char end[22], record[46], local[30];
    struct stat info;
    if (fstat(fd, &info) != 0) return NO;
    const off_t endAt = info.st_size - 22; // pread refuses it below zero.
    // A 32-bit end record at EOF with no comment, on one disk.
    if (!readAt(fd, end, 22, endAt) || le32(end) != 0x06054b50 || le16(end + 20)) return NO;
    if (le16(end + 4) || le16(end + 6) || le16(end + 8) != le16(end + 10)) return NO;
    // libarchive reads a ZIP64 locator just before the end record in preference to it.
    if (endAt >= 20 && (!readAt(fd, local, 4, endAt - 20) || le32(local) == 0x07064b50)) return NO;
    const uint32_t count = le16(end + 10), size = le32(end + 12), start = le32(end + 16);
    if (size > 8 * 1024 * 1024 || (off_t)start + size != endAt) return NO;
    off_t at = start;
    uint32_t walked = 0;
    for (; at < endAt; ++walked) {
        if (walked == 32768 || !readAt(fd, record, 46, at) || le32(record) != 0x02014b50) return NO;
        // ZIP64 sizes come from an extra field. An offset of 0xffffffff fails the bound below.
        if (le32(record + 20) == 0xffffffff || le32(record + 24) == 0xffffffff) return NO;
        const uint32_t method = le16(record + 10), offset = le32(record + 42);
        if (method != 0 && method != 8) return NO;
        if ((off_t)offset + 30 > start || !readAt(fd, local, 30, offset) || le32(local) != 0x04034b50)
            return NO;
        // libarchive decodes with the local header's method.
        if (le16(local + 8) != 0 && le16(local + 8) != 8) return NO;
        at += 46 + le16(record + 28) + le16(record + 30) + le16(record + 32);
    }
    return at == endAt && walked == count;
}

static BOOL unpackWithBudget(int archiveFD, int scratchFD, unsigned entries) {
    struct archive *zip = archive_read_new();
    if (!zip) return NO;
    BOOL ok = NO;
    if (archive_read_support_format_zip_seekable(zip) == 0 &&
        archive_read_open_fd(zip, archiveFD, 65536) == 0) {
        NSMutableSet *seen = [NSMutableSet set];
        int64_t remaining = 2LL * 1024 * 1024 * 1024;
        struct archive_entry *entry;
        int status;
        while ((status = archive_read_next_header(zip, &entry)) == 0) {
            @autoreleasepool {
                if (seen.count >= 32768 || !extractEntry(zip, entry, scratchFD, seen, &remaining, &entries))
                    break;
            }
        }
        ok = status == 1 && seen.count > 0; // ARCHIVE_EOF
    }
    archive_read_free(zip);
    return ok;
}

static BOOL unpack(int archiveFD, int scratchFD) {
    return unpackWithBudget(archiveFD, scratchFD, 32768);
}

static const char *bundleFacts(NSURL *url, NSString *identifier, NSString *version, NSString *arch) {
    NSBundle *bundle = [NSBundle bundleWithURL:url];
    if (!bundle || ![[bundle objectForInfoDictionaryKey:@"CFBundleExecutable"] isEqual:@"Clawtrate"])
        return "mac-archive";
    if (![bundle.bundleIdentifier isEqual:identifier]) return "mac-bundle-identifier";
    if (![[bundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"] isEqual:version])
        return "installer-version";
    NSNumber *cpu = [arch isEqual:@"arm64"] ? @(CPU_TYPE_ARM64) : @(CPU_TYPE_X86_64);
    if (![bundle.executableArchitectures isEqual:@[cpu]]) return "mac-architecture";
    return NULL;
}

static const char *signatureKind(OSStatus status, NSDictionary *information) {
    if (status == errSecCSUnsigned) return "build-not-signed";
    if (status != errSecSuccess || !information) return "inspection-failed";
    NSNumber *flags = information[(__bridge NSString *)kSecCodeInfoFlags];
    NSString *identifier = information[(__bridge NSString *)kSecCodeInfoIdentifier];
    if ((flags.unsignedIntValue & kSecCodeSignatureAdhoc) || !identifier)
        return "build-not-signed";
    return NULL;
}

static const char *inspect(NSString *scratch, NSString *identifier, NSString *version, NSString *arch) {
    SecCSFlags flags = kSecCSStrictValidate | kSecCSCheckAllArchitectures |
                       kSecCSCheckNestedCode | kSecCSNoNetworkAccess;
    NSDictionary *attrs = @{(__bridge NSString *)kSecGuestAttributePid: @(getppid())};
    SecCodeRef host = NULL;
    SecStaticCodeRef running = NULL, candidate = NULL;
    SecRequirementRef developer = NULL, designated = NULL;
    NSString *policy = [NSString stringWithFormat:
        @"anchor apple generic and identifier \"%@\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
         " and certificate 1[field.1.2.840.113635.100.6.2.6] exists", identifier];
    CFDictionaryRef information = NULL;
    OSStatus status = SecCodeCopyGuestWithAttributes(NULL, (__bridge CFDictionaryRef)attrs, 0, &host);
    if (!status) status = SecCodeCopyStaticCode(host, 0, &running);
    if (!status) status = SecCodeCopySigningInformation(running, kSecCSDefaultFlags, &information);
    const char *result = signatureKind(status, (__bridge NSDictionary *)information);
    if (result) goto done;
    result = "running-signature-untrusted";
    if (SecRequirementCreateWithString((__bridge CFStringRef)policy, 0, &developer) ||
        SecCodeCheckValidity(host, kSecCSNoNetworkAccess, developer) ||
        SecStaticCodeCheckValidity(running, flags, developer) ||
        SecCodeCopyDesignatedRequirement(running, 0, &designated)) goto done;
    if (!scratch) { result = "ok"; goto done; }
    result = "mac-archive";
    {
        int root = open(scratch.fileSystemRepresentation, O_NOFOLLOW | O_DIRECTORY | O_RDONLY);
        if (root < 0) goto done;
        BOOL ok = unpack(3, root);
        close(root);
        if (!ok) goto done;
    }
    {
        NSURL *url = [NSURL fileURLWithPath:[scratch stringByAppendingPathComponent:@"Clawtrate.app"]];
        result = bundleFacts(url, identifier, version, arch);
        if (result) goto done;
        result = "mac-designated-requirement";
        if (SecStaticCodeCreateWithPath((__bridge CFURLRef)url, 0, &candidate) ||
            SecStaticCodeCheckValidity(candidate, flags, designated)) goto done;
        result = "ok";
    }
done:
    if (information) CFRelease(information);
    if (candidate) CFRelease(candidate);
    if (designated) CFRelease(designated);
    if (developer) CFRelease(developer);
    if (running) CFRelease(running);
    if (host) CFRelease(host);
    return result;
}

int main(int argc, char **argv) {
    signal(SIGALRM, SIG_DFL);
    alarm(120);
    BOOL classify = argc == 3 && strcmp(argv[1], "--running-signature") == 0;
    if (!classify && argc != 5) return 1;
    // No RLIMIT_DATA: macOS rejects every finite value with EINVAL. Before anything else
    // reads the archive, preflight() checks it with fixed buffers: one 32-bit end record
    // at EOF, with no comment and no ZIP64 locator, on one disk; a central directory of
    // at most 8 MiB that ends at that record and walks to its count, at most 32,768
    // records; each local header before the directory; Store or Deflate only, in both
    // headers. That bounds libarchive's index. Its early per-entry reads have fixed caps:
    // a symlink target of 64 KiB compressed, inflated into one 256 KiB buffer (no LZMA),
    // and __MACOSX metadata of 10 MiB. The reader then bounds entries seen and paths
    // created (32,768 each), regular-file bytes (2 GiB in all, streamed through a 64 KiB
    // buffer, so a large valid Deflate stream costs time, not memory), Info.plist
    // (1 MiB), names (1,024 characters, 48 parts) and time (the 120 s alarm). A helper
    // that dies prints nothing, which the app reads as inspection-failed.
    @autoreleasepool {
        if (classify) puts(inspect(nil, @(argv[2]), nil, nil));
        else if (!preflight(3)) puts("mac-archive");
        else puts(inspect(@(argv[1]), @(argv[2]), @(argv[3]), @(argv[4])));
    }
    return 0;
}
