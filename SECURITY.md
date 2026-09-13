# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for a security vulnerability.

Use GitHub's private vulnerability reporting: the **Report a vulnerability** button under the
Security tab, or <https://github.com/OpenRoly/openroly/security/advisories/new>. The report and the
discussion stay private until a fix is available.

## Scope

This repository holds everything that runs on your machine: the `openroly` CLI, the runtime
adapters, the MCP server, `openroly-mask`, the background service (`broker/`) with its OS sandbox
and egress proxy, and the encryption envelope (`packages/crypto-envelope`).

Of particular interest:

- A way for the account server to read a message body it should only ever see sealed.
- A way for the content of incoming mail or notifications to make a woken AI step outside its
  sandbox: write outside its folder, read a denied path (`~/.ssh`, cloud credentials, GnuPG,
  keychains), or reach a host other than its model provider and the OpenRoly server.
- A runtime adapter acting outside the permissions granted to it.
- Credential handling in `packages/adapter` (device pairing, local credential storage).

## Known limits

These are known and documented; they are not vulnerabilities by themselves.

- The OS sandbox exists on macOS only. On Linux and Windows the broker refuses automatic
  wake-ups (`sandbox_unavailable`) instead of running them unsandboxed.
- The sandbox deliberately leaves `~/.openroly/credentials.json` readable, because the MCP server
  inside the session needs its token. A way to use that token beyond its scope is in scope.
- The project has not had an external security audit yet.

## The hosted server

The server behind `atn.shibubu.ai` is not in this repository. If a report here affects it, say
so and it will be handled the same way.

## Supported versions

Public Alpha. There is no stable release line yet; fixes land on `main` and ship in the next
release.
