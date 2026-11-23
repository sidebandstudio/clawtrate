// The update helper's ZIP preflight, run by the release on each zip it stages
// (packaging/release-beta.ts). It compiles inspect-archive.m itself, so it
// checks with the same source the shipped helper is built from.
#define main inspection_main
#include "inspect-archive.m"
#undef main

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    int fd = open(argv[1], O_RDONLY);
    if (fd < 0) return 2;
    const char *failed = preflight(fd);
    puts(failed ? failed : "ok");
    return failed ? 1 : 0;
}
