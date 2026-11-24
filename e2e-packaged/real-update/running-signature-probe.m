// Diagnostic for the real-update check (docs/development/releases.md). It makes the
// update helper's first-stage Security calls (inspect-archive.m, inspect()) against a
// running process named by pid, instead of its parent, and prints each call's status,
// so a run on a disposable Mac shows which call a real signed Clawtrate fails, if any.
// It never reads an archive and never runs candidate code.
#import <Foundation/Foundation.h>
#import <Security/Security.h>

static void report(const char *call, OSStatus status) {
    CFStringRef text = SecCopyErrorMessageString(status, NULL);
    printf("%s: %d%s%s\n", call, (int)status, text ? " " : "",
           text ? [(__bridge NSString *)text UTF8String] : "");
    if (text) CFRelease(text);
}

int main(int argc, char **argv) {
    if (argc != 3) {
        fprintf(stderr, "usage: running-signature-probe <pid> <bundle identifier>\n");
        return 2;
    }
    @autoreleasepool {
        pid_t pid = atoi(argv[1]);
        NSString *identifier = @(argv[2]);
        SecCSFlags flags = kSecCSStrictValidate | kSecCSCheckAllArchitectures |
                           kSecCSCheckNestedCode | kSecCSNoNetworkAccess;
        NSString *policy = [NSString stringWithFormat:
            @"anchor apple generic and identifier \"%@\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
             " and certificate 1[field.1.2.840.113635.100.6.2.6] exists", identifier];
        SecCodeRef host = NULL;
        SecStaticCodeRef running = NULL;
        SecRequirementRef developer = NULL, designated = NULL;
        CFDictionaryRef information = NULL;
        OSStatus status = SecCodeCopyGuestWithAttributes(
            NULL, (__bridge CFDictionaryRef)@{(__bridge NSString *)kSecGuestAttributePid: @(pid)}, 0, &host);
        report("SecCodeCopyGuestWithAttributes", status);
        if (status) return 1;
        status = SecCodeCopyStaticCode(host, 0, &running);
        report("SecCodeCopyStaticCode", status);
        if (status) return 1;
        CFURLRef path = NULL;
        if (!SecCodeCopyPath(running, 0, &path)) {
            printf("static code path: %s\n", [(__bridge NSURL *)path fileSystemRepresentation]);
            CFRelease(path);
        }
        status = SecCodeCopySigningInformation(running, kSecCSDefaultFlags, &information);
        report("SecCodeCopySigningInformation", status);
        if (information) {
            NSDictionary *info = (__bridge NSDictionary *)information;
            printf("identifier: %s\nflags: 0x%x\nteam: %s\n",
                   [[info[(__bridge NSString *)kSecCodeInfoIdentifier] description] UTF8String],
                   [info[(__bridge NSString *)kSecCodeInfoFlags] unsignedIntValue],
                   [[info[(__bridge NSString *)kSecCodeInfoTeamIdentifier] description] UTF8String]);
        }
        CFDictionaryRef dynamic = NULL;
        if (!SecCodeCopySigningInformation((SecStaticCodeRef)host, kSecCSDynamicInformation, &dynamic)) {
            printf("dynamic status: 0x%x\n",
                   [((__bridge NSDictionary *)dynamic)[(__bridge NSString *)kSecCodeInfoStatus] unsignedIntValue]);
            CFRelease(dynamic);
        }
        report("SecRequirementCreateWithString", SecRequirementCreateWithString((__bridge CFStringRef)policy, 0, &developer));
        report("SecCodeCheckValidity(host, developer)", SecCodeCheckValidity(host, kSecCSNoNetworkAccess, developer));
        report("SecCodeCheckValidity(host, none)", SecCodeCheckValidity(host, kSecCSNoNetworkAccess, NULL));
        report("SecStaticCodeCheckValidity(running, strict, developer)", SecStaticCodeCheckValidity(running, flags, developer));
        report("SecCodeCopyDesignatedRequirement", SecCodeCopyDesignatedRequirement(running, 0, &designated));
        if (information) CFRelease(information);
        if (designated) CFRelease(designated);
        if (developer) CFRelease(developer);
        CFRelease(running);
        CFRelease(host);
    }
    return 0;
}
