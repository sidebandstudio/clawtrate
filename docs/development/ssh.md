# The SSH transport's tests

The SSH transport of "Another computer" (`apps/desktop/src/main/ssh/`, [decisions](../decisions.md#ssh-to-another-computer)) is tested by `pnpm test`, in `apps/desktop/test/ssh/`. To run only its tests:

```bash
pnpm exec vitest run apps/desktop/test/ssh
```

- `config.test.ts`, `output.test.ts`, `look.test.ts`, `forward.test.ts`, `world.test.ts` and `client.test.ts` need no server. `look.test.ts` also runs the LOOK script under every shell it finds (`sh`, `bash`, `zsh`, `dash`, `ksh`, `csh`, `tcsh`, `fish`) in a home of its own whose start-up files print, and names each missing shell as skipped. One of its checks waits 30 seconds for the script to stop itself.
- `sshd.test.ts` starts an `sshd` of its own: as the current user, on a free loopback port, with a host key, authorized keys, a configuration and a home it creates in a temporary folder, and `SetEnv HOME=<that home>`, so sessions read the test home's start-up files and look in its fixed places. It proves that with a plain `ssh` before any LOOK runs, and refuses to go on otherwise. The OpenClaw it finds is a stand-in script in that home, and the gateway's port is a loopback echo server. It stops the `sshd` and every session process by PID, and checks that every `ssh` it started has ended. It takes about 30 seconds.

Nothing of the machine's own SSH setup is read or used. Every `ssh` runs with `-F` on a generated file, the test's key, `IdentitiesOnly`, `IdentityAgent none` and no `SSH_AUTH_SOCK`, and the module itself refuses, under a test run, any path inside the real `~/.ssh` and the real agent. The tests never connect to this machine's SSH port or to any host but their own `sshd`; the "no such name" case is a recorded output, and so is "no answer".

`sshd.test.ts` is skipped, with the reason in its name, where `/usr/sbin/sshd`, `/usr/bin/ssh` or `/usr/bin/ssh-keygen` is missing, where `sshd -t` refuses a test configuration, and on Windows. In CI it runs in the Linux `check` job when the runner's `sshd` accepts the test configuration; the job's log names it as skipped otherwise. One check, "finds nothing in a home without OpenClaw", is skipped where a program exists at one of the script's fixed places outside a home (`/opt/homebrew/bin/openclaw`, `/usr/local/bin/openclaw`), because the script would run it.
