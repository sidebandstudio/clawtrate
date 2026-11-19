# Security

Clawtrate connects to OpenClaw gateways whose bots run tools with real access, so a security problem in Clawtrate can put someone's computer or accounts at risk. Please report one privately.

## Reporting a vulnerability

Use GitHub's private reporting: open the repository's **Security** tab and choose **Report a vulnerability**, or go straight to [the form](https://github.com/sidebandstudio/clawtrate/security/advisories/new). Only the maintainers can see the report. Do not open a public issue, pull request or discussion about it.

Say what you found, how to reproduce it, and what someone could do with it. A short proof of concept against a development gateway helps most.

## What it covers

The desktop app, the web preview host, `@clawtrate/core`, `@clawtrate/ui`, the plugins under `plugins/` and the development tools under `tools/`. A problem in OpenClaw itself belongs to the OpenClaw project.

## Versions

Clawtrate has no release yet. Fixes land on `main`.

## Known limits

The computer plugin, `plugins/clawtrate-computer`, has not had a security review of its own. Until it has, install it only on a development gateway, never on a gateway that holds real sign-ins.
