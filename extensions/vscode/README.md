# Pibox SSH for VS Code

Open a running Pibox workspace in a new VS Code Remote - SSH window. Saved connections contain an SSH config alias and a guest folder path; authentication stays in OpenSSH and Remote - SSH.

## Install

Requires VS Code 1.85 or newer, a local OpenSSH client, and Microsoft's **Remote - SSH** extension (`ms-vscode-remote.remote-ssh`).

From this directory:

```sh
npm test
npm run package
code --install-extension pibox-ssh-0.1.0.vsix
```

Packaging downloads the pinned VSCE packaging tool through npm. The extension itself has no npm runtime dependencies. It is not published to the Marketplace.

## Prepare the guest

The guest must already run an SSH server and support VS Code Server. This standalone extension does not create workers, provision keys, start servers, or publish ports. For automatic setup on smolVM, use Pibox's [`/pibox-vscode` command](../../README.md#vs-code-over-ssh) instead; it does not require this extension. The manual setup below uses Pibox's Debian image.

1. Start your Pibox worker. In the guest, install `openssh-server` (for Debian, `apt-get update && apt-get install -y openssh-server`).
2. Create a non-root development account with a home directory. Give it access to the workspace and put your host's **public** SSH key in its `~/.ssh/authorized_keys`. The account must own that file and directory; use permissions `600` and `700`, respectively. Never copy your private key into the guest.
3. Configure `sshd` for public-key authentication, disable password and keyboard-interactive authentication, and disallow root login. Enable TCP forwarding: Remote - SSH needs it. Ensure the account is permitted by your SSH/PAM configuration.
4. Generate guest host keys with `ssh-keygen -A`, create `/run/sshd`, validate the server configuration with `/usr/sbin/sshd -t`, and start `/usr/sbin/sshd`. Guests do not necessarily run systemd. The server must listen on guest `0.0.0.0`, not just localhost.
5. For **smolVM with virtio-net**, use `/pibox-net` in the controller, select the SSH listener (normally port 22), and publish it in **raw TCP** mode. Note the displayed host loopback port. Do not use HTTP mode for SSH.

Microsandbox TCP publishing is not currently supported by Pibox. With that provider, you must supply an independently reachable SSH endpoint before using this extension.

## Configure your host

Add an alias to your local SSH configuration (normally `~/.ssh/config`), substituting the published port and guest account:

```sshconfig
Host pibox-dev
    HostName 127.0.0.1
    Port 49152
    User developer
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
    ForwardAgent no
```

If Remote - SSH uses a custom config file, add the alias there instead. Keep normal host-key checking enabled. Before accepting a new host key, compare the fingerprint with the guest's output from:

```sh
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Test from the host first:

```sh
ssh pibox-dev
```

The guest account needs a writable home for VS Code Server and access to the target folder. A root-owned `/workspace` may require deliberate permission changes appropriate to your project, especially with host bind mounts.

## Connect

Run **Pibox: Connect to Workspace via SSH** from the Command Palette. On first use, enter:

- SSH alias: `pibox-dev`
- Guest folder: `/workspace` (or your configured Pibox workdir)
- Connection name: any descriptive label

The folder opens in a new remote window. Remote - SSH handles authentication, server installation, terminals, remote extensions, and reconnects. Run **Pibox: Add SSH Connection** to save additional profiles without connecting.

Edit or remove profiles in User Settings JSON:

```json
{
  "pibox.ssh.connections": [
    { "name": "Pibox development", "host": "pibox-dev", "path": "/workspace" }
  ]
}
```

Profiles are application-scoped, not repository settings. Hosts must be SSH config aliases, not `user@host`, URLs, or `host:port`. Use SSH config for ports, usernames, keys, and proxy options.

## Lifecycle and troubleshooting

- Keep the Pibox controller and worker running. Graceful controller exit stops its workers; closing a VS Code remote window does not stop the worker.
- Republishing SSH may allocate a different host port. Update your SSH config before reconnecting.
- Recreating a guest may change its host key. Verify the new fingerprint before deliberately replacing the old known-host entry. Do not disable host-key verification.
- Connection refused: check the worker, guest SSH server, and raw TCP publication. Try `ssh -v pibox-dev` locally.
- Authentication or server installation failure: inspect **Remote - SSH** in VS Code's Output panel. Check guest account permissions and VS Code Server requirements.
- A published SSH endpoint grants access to the guest, including anything the account can read. Prefer a dedicated unprivileged account and keep private keys and agent forwarding outside the guest.

## Development

Open this directory in VS Code and use **Run Extension** in Run and Debug. Tests cover connection validation, remote URI components, profile persistence, cancellation, and command routing with a mocked VS Code API. Live Remote - SSH connections require a running, configured guest and are not exercised by these tests.
