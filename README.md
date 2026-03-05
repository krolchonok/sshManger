# SSHHelper

Terminal UI SSH manager on Node.js.

## Features

- Reads hosts from `~/.ssh/config`
- Shows host table in TUI (`alias | url/hostname | port`)
- Supports `Include` directives and wildcard host patterns
- Connects to selected host in the same terminal (`ssh <host>`)
- Creates and manages background SSH tunnels:
  - Local forward (`-L`)
  - Remote forward (`-R`)
  - Dynamic SOCKS (`-D`)
- Persists tunnel records and PIDs in `~/.sshhelper/state.json`
- Can stop previously started tunnels after app restart
- Prepared for localization (English and Russian dictionaries included)

## Install

```bash
npm install
```

## Global CLI Install

```bash
# local source (from this folder)
npm i -g .

# from npm registry (after publish)
npm i -g @ushastoe/sshhelper
```

Command name: `sshhelper`

## Run

```bash
npm start
```

## Build Binaries

```bash
# Windows .exe
npm run build:win

# Linux executable
npm run build:linux

# Both
npm run build:all
```

Build artifacts are written to `dist/`.

## Publish to npm

```bash
# 1) login once
npm login

# 2) check package contents/version
npm pack --dry-run

# 3) publish
npm publish
```

Package name is configured as `@ushastoe/sshhelper` (scoped public package).

## Keybindings

- `Tab`: switch focus (hosts/tunnels)
- `Enter` or `c`: connect selected host
- `a`: add tunnel
- `s`: start selected tunnel
- `x`: stop selected tunnel
- `d` or `Delete`: delete selected tunnel record
- `e`: run command on selected remote host (via SSH) and view its output
- `i`: run `ssh-copy-id` for selected remote host
- `o`: export SSHHelper config (tunnels + locale) to JSON file
- `p`: import SSHHelper config from JSON file
- `r`: reload hosts and tunnel statuses
- `l`: switch UI language
- `q` or `Ctrl+C`: quit

## Notes

- SSH options like `ProxyJump`, `Host *`, identities, and include-based defaults are resolved by your local `ssh` client.
- Password mode uses `SSH_ASKPASS` and does not store passwords in state.
- Tunnel logs are written to `~/.sshhelper/logs`.
- In step-by-step input dialogs: `Enter` = `Next`, `Cancel` closes the current dialog, and buttons are clickable with mouse.
