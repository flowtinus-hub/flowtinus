# Flowtinus

Visual data flows: `flowtinus.core` (engine), `flowtinus.server` (api and supervisor), `flowtinus.editor` (web editor).

Engine benchmarks (`flowtinus.perf`): the report is at https://flowtinus-hub.github.io/flowtinus/.

## Requirements

- [Bun](https://bun.sh) 1.4.4+
- [Node.js](https://nodejs.org) 26+ (the git hooks: lint-staged, oxlint, prettier)
- Docker (for Postgres)

## Run locally

```sh
bun install
docker compose up -d                                  # Postgres on :5432
cp flowtinus.server/.env.example flowtinus.server/.env
bun run dev                                           # api :5190, supervisor, editor :5180
```

Open http://localhost:5180. On start the server applies the migrations and, in `DEV`, seeds a `dev` workspace and user.

## Run the server in Docker

```sh
docker compose --profile server up -d                 # Postgres, api :5190 and supervisor
docker compose --profile server up -d --build         # after code changes: rebuilds the image
bun run editor                                        # the editor, :5180
```

## Supervisors in Kubernetes (optional)

Each Deployment is a pool of supervisors with its own workers, tags and color; every pod shows on the Workers page,
and they share the queue. Locally: Docker Desktop → Kubernetes → Create cluster.

### Build the image

```sh
docker compose up -d                                    # Postgres, reached at host.docker.internal
docker compose build server                             # again after a server change
docker tag flowtinus-server:latest flowtinus-server:dev # a fixed tag, so the cluster doesn't pull
```

### Create the deployment

```sh
kubectl create deployment supervisor-pink --image=flowtinus-server:dev -- bun flowtinus.server/supervisor/main.ts
```

### Set the environment (configs)

`FIRE_AND_FORGET_PER_WORKER` is how many runs one Flow Invoker may fire and forget, per worker (default 4).

```sh
kubectl set env deployment/supervisor-pink DATABASE_URL=postgres://flowtinus:flowtinus@host.docker.internal:5432/flowtinus \
  ENVIRONMENT=DEV LOG_FORMAT=json WORKERS=6 WORKER_TAGS=default WORKER_COLOR=pink FIRE_AND_FORGET_PER_WORKER=4
```

Changing a setting later restarts the pods one by one:

```sh
kubectl set env deployment/supervisor-pink WORKER_TAGS=default,heavy
kubectl set env deployment/supervisor-pink WORKERS=8 FIRE_AND_FORGET_PER_WORKER=10
```

### Graceful stop

On SIGTERM a supervisor waits for its runs (up to 11 minutes); Kubernetes kills it after 30 s unless you raise that.

```sh
kubectl patch deployment/supervisor-pink -p '{"spec":{"template":{"spec":{"terminationGracePeriodSeconds":660}}}}'
```

### Scale up/down

Fewer pods stop gracefully. An HPA works too.

```sh
kubectl scale deployment/supervisor-pink --replicas=3
```

### Update the image

```sh
kubectl rollout restart deployment/supervisor-pink
```

### Inspect and remove

```sh
kubectl get pods -l app=supervisor-pink
kubectl logs -f deployment/supervisor-pink
kubectl delete deployment/supervisor-pink
```

### Logs and metrics

An otel-collector on each node sends the pods' logs and metrics (namespace `default`) to the openobserve of Compose's
`--profile observability` ([observability/k8s/otel-collector.yaml](observability/k8s/otel-collector.yaml)). There the
service is the Deployment and the instance its pod; the metrics are `k8s_pod_*` and `k8s_container_*`.

```sh
kubectl create namespace observability
kubectl -n observability create secret generic openobserve --from-literal=OPENOBSERVE_URL=http://host.docker.internal:5080/api/default \
  --from-literal=OPENOBSERVE_USER=root@flowtinus.local --from-literal=OPENOBSERVE_PASSWORD='Flowtinus#2026'
kubectl apply -f observability/k8s/otel-collector.yaml
```

## Reset the database

```sh
docker compose exec postgres psql -U flowtinus -d postgres -c "DROP DATABASE flowtinus WITH (FORCE)" -c "CREATE DATABASE flowtinus"
```

## Tests

```sh
bun run typecheck
bun run test
```
