# Microsandbox full-stack example

This example combines:

- a TanStack Start frontend on <http://localhost:3000>;
- a Quarkus REST backend on <http://localhost:8080/api/tasks>;
- PostgreSQL on `localhost:5432`;
- a Microsandbox Pibox worker with this directory bind-mounted at `/workspace`.

## Tooling

Install [mise](https://mise.jdx.dev/) and ensure a Docker-compatible daemon is running. Then install the pinned Java, Maven, Node.js, pnpm, Docker CLI, and Docker Compose versions:

```sh
mise trust
mise install
mise run install
```

The frontend uses pnpm exclusively.

## Run the application

```sh
mise run up
```

Open <http://localhost:3000>. Stop the services with:

```sh
mise run down
```

Use `mise run clean` to also delete the PostgreSQL volume.

## Run Pibox

Authenticate Microsandbox to GHCR if the image package is private:

```sh
gh auth refresh --hostname github.com --scopes read:packages
gh auth token | msb registry login ghcr.io --username manuschillerdev --password-stdin
```

From the repository root:

```sh
(cd examples/microsandbox/full-stack && pi -e ../../../src/index.ts --pibox)
```

The Pibox worker sees this example at `/workspace`. Run Docker Compose from a host terminal; the worker edits the bind-mounted source tree and can inspect its configuration.

Remove the worker before exiting Pi:

```text
/pibox-rm <worker-name-shown-at-startup>
```
