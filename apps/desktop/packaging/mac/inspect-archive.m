// Independent inspection only. This process never starts candidate code.
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <mach/machine.h>
#import <sys/stat.h>
#import <sys/resource.h>
#import <fcntl.h>
#import <unistd.h>

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
static int parentFor(int root, NSArray<NSString *> *names) {
    int dir = dup(root);
    for (NSUInteger i = 0; dir >= 0 && i + 1 < names.count; ++i) {
        const char *name = names[i].fileSystemRepresentation;
        int next = -1;
        if (mkdirat(dir, name, 0700) == 0 || errno == EEXIST)
            next = openat(dir, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        close(dir);
        dir = next;
    }
    return dir;
}

static BOOL extractEntry(struct archive *zip, struct archive_entry *entry, int root,
                         NSMutableSet *seen, int64_t *remaining) {
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
    int dir = parentFor(root, names);
    if (dir < 0) return NO;
    const char *leaf = names.lastObject.fileSystemRepresentation;
    BOOL ok = NO;
    if (S_ISDIR(mode)) {
        struct stat st;
        ok = size == 0 && (mkdirat(dir, leaf, 0700) == 0 || errno == EEXIST) &&
            fstatat(dir, leaf, &st, AT_SYMLINK_NOFOLLOW) == 0 && S_ISDIR(st.st_mode);
    } else if (S_ISLNK(mode)) {
        const char *target = archive_entry_symlink_utf8(entry);
        // Framework symlinks point down or across within the bundle. Disallow upward hops,
        // including through another link, so the signature reader also stays inside the app.
        ok = target && parts([NSString stringWithUTF8String:target]) &&
            symlinkat(target, dir, leaf) == 0;
    } else if (S_ISREG(mode)) {
        int file = openat(dir, leaf, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
                          (mode & 0111) ? 0700 : 0600);
        if (file >= 0) {
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

static BOOL unpack(int archiveFD, int scratchFD) {
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
                if (seen.count >= 32768 || !extractEntry(zip, entry, scratchFD, seen, &remaining))
                    break;
            }
        }
        ok = status == 1 && seen.count > 0; // ARCHIVE_EOF
    }
    archive_read_free(zip);
    return ok;
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
    const char *result = "running-signature-untrusted";
    if (SecCodeCopyGuestWithAttributes(NULL, (__bridge CFDictionaryRef)attrs, 0, &host) ||
        SecCodeCopyStaticCode(host, 0, &running) ||
        SecRequirementCreateWithString((__bridge CFStringRef)policy, 0, &developer) ||
        SecCodeCheckValidity(host, kSecCSNoNetworkAccess, developer) ||
        SecStaticCodeCheckValidity(running, flags, developer) ||
        SecCodeCopyDesignatedRequirement(running, 0, &designated)) goto done;
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
    if (candidate) CFRelease(candidate);
    if (designated) CFRelease(designated);
    if (developer) CFRelease(developer);
    if (running) CFRelease(running);
    if (host) CFRelease(host);
    return result;
}

int main(int argc, char **argv) {
    if (argc != 5) return 1;
    struct rlimit memory = { 768 * 1024 * 1024, 768 * 1024 * 1024 };
    // Bound allocator growth in the ZIP reader before it sees any archive metadata.
    if (setrlimit(RLIMIT_DATA, &memory) != 0) return 1;
    @autoreleasepool {
        puts(inspect(@(argv[1]), @(argv[2]), @(argv[3]), @(argv[4])));
    }
    return 0;
}
