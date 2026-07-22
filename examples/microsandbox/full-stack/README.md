# Microsandbox full-stack example

This example runs a Docker Compose development stack entirely inside Microsandbox:

- a TanStack Start frontend on <http://localhost:3000>;
- a Quarkus REST backend on <http://localhost:8080/api/tasks>;
- PostgreSQL on `localhost:5432`.

The example directory is bind-mounted at `/workspace`. Pibox provides repository-scoped pnpm caching and user-scoped Maven and mise caching. The Pibox base image includes mise, Docker Engine, its matching CLI, and Docker Compose. Pibox starts Docker and runs `mise install` before connecting the worker.

## Start Pibox

Authenticate Microsandbox to GHCR if the Pibox base image package is private:

```sh
gh auth refresh --hostname github.com --scopes read:packages
gh auth token | msb registry login ghcr.io --username manuschillerdev --password-stdin
```

From the repository root:

```sh
(cd examples/microsandbox/full-stack && pi -e ../../../src/index.ts --pibox)
```

Pibox forwards ports `3000`, `8080`, and `5432` to the host.

## Start the application

Install project dependencies and start Compose from the connected worker:

```text
!mise run install
!mise run up
```

Open <http://localhost:3000>.

Follow service logs with:

```text
!mise run logs
```

## Cleanup

Stop the stack and remove its PostgreSQL volume:

```text
!mise run clean
```

Then remove the worker:

```text
/pibox-rm <worker-name-shown-at-startup>
```
