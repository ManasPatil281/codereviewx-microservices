# CodeReviewX

CodeReviewX is a GitHub pull request review backend built as a set of small Node.js and TypeScript services. It accepts manual review requests or GitHub webhook events, puts review work on a Redis queue, analyzes pull request diffs with Groq (or a built-in heuristic reviewer), and stores review summaries and findings in PostgreSQL.

The repository includes a Docker Compose setup for running the services locally and Kubernetes manifests for local or cloud-cluster deployment. The Kubernetes manifests are examples and need environment-specific images, secrets, networking, and storage before production use.

## How a review moves through the system

```mermaid
flowchart LR
    User[User or dashboard] -->|REST request| Gateway[API Gateway]
    GitHub[GitHub webhook] -->|signed event| Webhook[Webhook Service]
    Gateway -->|fetch PR files| GitService[GitHub Service]
    Gateway -->|manual job| Queue[(Redis / BullMQ)]
    Webhook -->|verified event and job| Queue
    Queue --> Worker[Review Worker]
    Worker -->|fetch diff when needed| GitHubAPI[GitHub API]
    Worker -->|optional AI analysis| Model[Groq API]
    Gateway --> Database[(PostgreSQL)]
    Webhook --> Database
    Worker --> Database
    User -->|read results| Gateway
```

1. A user can request a review through the API, or GitHub can send a pull request event to the webhook endpoint.
2. The webhook service checks GitHub's HMAC signature, records the delivery ID to prevent duplicate processing, and queues supported pull request actions.
3. The review worker consumes jobs asynchronously. It fetches the changed files if they were not already supplied, then asks Groq for findings or uses the heuristic fallback when no Groq key is configured.
4. The worker stores the status, summary, and findings in PostgreSQL. The API Gateway serves those results to the dashboard and API clients.

## Services and infrastructure

| Component | Responsibility |
| --- | --- |
| `api-gateway` | Serves the dashboard and REST API; reads and writes application data and queues manual review jobs. |
| `github-service` | Calls the GitHub API to look up repositories, pull request files, and commit comparisons. |
| `webhook-service` | Validates GitHub webhook signatures, deduplicates deliveries, records events, and queues supported pull request reviews. |
| `review-worker` | Processes queued reviews, calls the configured review engine, and saves results. Each worker handles up to three jobs concurrently. |
| Redis with BullMQ | Holds pending jobs and retry state so webhook requests can return without waiting for an AI review to finish. |
| PostgreSQL | Stores registered repositories, review runs, findings, and accepted webhook deliveries. |
| Groq API (optional) | Provides AI-assisted diff analysis. Without `GROQ_API_KEY`, the worker runs a simple deterministic heuristic review. |

The webhook service automatically reviews pull request `opened`, `reopened`, `synchronize`, and `ready_for_review` actions. Push events are accepted and recorded but do not currently trigger a review.

## Cloud computing concepts in this project

| Cloud concept | How CodeReviewX demonstrates it |
| --- | --- |
| Microservices | The gateway, GitHub adapter, webhook handler, and worker are separate deployable services with focused responsibilities. |
| Containers | Each service has a Dockerfile. A container image packages its runtime and application so it can run consistently across a laptop and a cluster. |
| Managed services | PostgreSQL can be hosted by Supabase or another managed database provider; Redis can likewise be replaced by a managed Redis-compatible service. The app connects over configured URLs. |
| Asynchronous messaging | Redis/BullMQ separates request intake from the slower review task. This smooths bursts and lets workers retry failed jobs. |
| Horizontal scaling | Kubernetes Deployments can run multiple replicas. The worker HPA example scales worker replicas from CPU utilization; it needs cluster metrics and appropriate resource requests. |
| Service discovery | Inside Compose and Kubernetes, services call one another by service DNS names such as `github-service` and `redis`, rather than fixed machine IPs. |
| Persistent state | Database records are the durable source for review history. Redis persistence is enabled in Compose; the local Kubernetes setup uses persistent volume claims. |
| Configuration and secrets | Runtime settings are supplied through environment variables, ConfigMaps, and Kubernetes Secrets. Credentials should be stored in a cloud secret manager or equivalent in production. |
| Ingress and traffic routing | The Kubernetes Ingress example routes external HTTP traffic to the gateway. A real deployment needs a configured ingress controller, DNS, and TLS. |
| Resilience and observability | Health endpoints, queue retries, delivery deduplication, and Kubernetes readiness/replica status support operations. Production deployments should add centralized logs, metrics, alerts, and tracing. |
| Shared responsibility | Kubernetes and cloud providers supply infrastructure primitives, but the application owner still configures access control, network policy, backups, encryption, scaling, and recovery. |

This project illustrates cloud patterns; it is not a complete production platform. The general Kubernetes manifests use placeholder image names, and the ingress example does not configure TLS. The local Kubernetes bundle is intended for Docker Desktop Kubernetes and includes in-cluster PostgreSQL and Redis for development.

## How Docker is used

Docker packages each CodeReviewX service with its runtime and dependencies so the
same service can run consistently on a developer machine or in Kubernetes.

- Each service has its own `Dockerfile`. The image build uses a Node.js 22 Alpine
  build stage to compile TypeScript, then copies the compiled `dist` output and
  production dependencies into a smaller runtime image.
- `docker-compose.yml` runs the four application services together with Redis:
  `api-gateway`, `github-service`, `webhook-service`, `review-worker`, and `redis`.
  PostgreSQL remains external in Compose, so `DATABASE_URL` can point to a local
  or managed PostgreSQL instance.
- Compose creates a private network and provides service-name DNS. For example,
  the gateway reaches the GitHub Service at
  `http://github-service:8081`, while the queue clients reach Redis at
  `redis://redis:6379`.
- The gateway, GitHub Service, and Webhook Service publish ports `8080`, `8081`,
  and `8082` to the host. The worker does not need a public port because it only
  consumes jobs from Redis.
- Redis uses the `redisdata` named volume with append-only persistence, so
  container restarts do not immediately discard queued data.
- Environment variables are loaded from `.env`. Credentials should remain local
  or be provided through a deployment secret mechanism; do not commit `.env`.

Use Docker Compose when you want a repeatable multi-service environment without
managing Kubernetes resources:

```powershell
docker compose up --build
```

If your Docker installation provides Compose as a standalone command, use:

```powershell
docker-compose up --build
```

## How Kubernetes is used

Kubernetes runs the container images as independently managed workloads and
provides service discovery, configuration, health management, storage, and
scaling.

- Each application service runs in a Kubernetes `Deployment`. Deployments keep
  the requested number of pods running and support rolling updates and restarts.
- Kubernetes `Service` resources provide stable DNS names and route traffic to
  matching pods. The gateway is the user-facing service; the other services are
  reached inside the cluster.
- `ConfigMap` resources provide non-sensitive settings such as the Redis URL,
  GitHub Service URL, and Groq model. `codereviewx-secrets` provides sensitive
  values such as `DATABASE_URL`, GitHub credentials, the webhook secret, and the
  optional Groq key.
- The local bundle also deploys PostgreSQL and Redis with persistent volume
  claims. This gives the development cluster in-cluster infrastructure instead
  of relying on external services.
- Readiness and liveness checks allow Kubernetes to remove unhealthy pods from
  service traffic and restart containers that stop responding.
- The review worker has a Horizontal Pod Autoscaler example. With Metrics
  Server installed, Kubernetes can scale workers from 1 to 6 replicas based on
  CPU utilization while Redis distributes review jobs among them.
- The dashboard's read-only Kubernetes service account and RBAC permissions let
  the gateway report deployment, pod, and HPA status through
  `/api/cluster/scaling`.
- The ingress manifest is an example of routing external HTTP traffic to the
  gateway. A real cluster still needs an ingress controller, DNS, TLS, network
  policies, and production-grade secret and backup management.

There are two Kubernetes usage paths in this repository:

1. **Local Kubernetes:** `k8s/local` is designed for Docker Desktop Kubernetes.
   It uses locally built images tagged with `:local`, creates the `codereviewx`
   namespace, and runs PostgreSQL and Redis in the cluster.
2. **Cloud Kubernetes:** the top-level `k8s` manifests are deployment examples
   for a managed or self-managed cluster. Build and push images to a registry,
   replace placeholder image names, configure external or managed PostgreSQL
   and Redis, create the required Secret, and configure ingress and TLS.

## Start the application

Choose one of the following options:

1. [Run locally](#run-locally)
2. [Run with Docker Compose](#run-with-docker-compose)
3. [Run on Kubernetes](#run-on-local-kubernetes)

## Run locally

### Requirements

- Node.js 22 or later and npm
- PostgreSQL 14 or later
- Redis 7 or later
- A GitHub token with the minimum read permissions needed for the repositories you review
- Optional: a Groq API key for AI-assisted analysis

### Setup

1. Copy `.env.example` to `.env` and set your credentials and local service URLs:

   ```powershell
   Copy-Item .env.example .env
   ```

   For a host-local setup, use `redis://localhost:6379` for `REDIS_URL` and
   `http://localhost:8081` for `GITHUB_SERVICE_URL`. Set `DATABASE_URL` to your
   local PostgreSQL database, for example:

   ```text
   DATABASE_URL=postgresql://postgres:your-password@localhost:5432/codereviewx
   ```

2. Create the `codereviewx` database, then initialize its schema:

   ```powershell
   createdb -U postgres codereviewx
   Get-Content db/init.sql | psql -U postgres -d codereviewx
   ```

3. Install dependencies for each service:

   ```powershell
   npm install --prefix services/api-gateway
   npm install --prefix services/github-service
   npm install --prefix services/webhook-service
   npm install --prefix services/review-worker
   ```

4. Start Redis and PostgreSQL, then start each service in a separate terminal from
   the repository root:

   ```powershell
   npm run dev --prefix services/github-service
   npm run dev --prefix services/api-gateway
   npm run dev --prefix services/webhook-service
   npm run dev --prefix services/review-worker
   ```

5. Open the dashboard at [http://localhost:8080](http://localhost:8080). The
   service health endpoints are available at ports `8080`, `8081`, and `8082`.

The local processes load configuration from the root `.env` file even when
started with `npm --prefix`. Leave
`GROQ_API_KEY` empty to use the built-in heuristic reviewer.

## Run with Docker Compose

### Requirements

- Docker Desktop or Docker Engine with Docker Compose
- A PostgreSQL database. For a quick cloud-backed setup, use a Supabase PostgreSQL connection string; for a fully local setup, use the local Kubernetes bundle described below or provide a local PostgreSQL service.
- A GitHub token with the minimum read permissions needed for the repositories you review
- Optional: a Groq API key for AI-assisted analysis

### Setup

1. Copy `.env.example` to `.env` and fill in the values. Never commit `.env` or real credentials.
2. Run `db/init.sql` once against the database configured by `DATABASE_URL`.
3. Build and start the services:

   ```bash
   docker compose up --build
   ```

   If `docker compose` is unavailable, use `docker-compose up --build` instead.

4. Open the dashboard at [http://localhost:8080](http://localhost:8080).

The API Gateway health check is at `http://localhost:8080/health`; the GitHub Service and Webhook Service health checks are at ports `8081` and `8082`. Compose starts Redis, but does not start PostgreSQL.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. URL-encode special characters in the password. |
| `REDIS_URL` | Redis connection URL. In Compose, use `redis://redis:6379`. |
| `GITHUB_TOKEN` | GitHub token used for repository and pull request API calls. |
| `GITHUB_WEBHOOK_SECRET` | Secret shared with the GitHub webhook configuration. |
| `GROQ_API_KEY` | Optional Groq credential. Leave empty to use the heuristic reviewer. |
| `GROQ_MODEL` | Model name used for Groq analysis. Defaults to `openai/gpt-oss-120b`. |
| `GITHUB_SERVICE_URL` | Internal GitHub Service URL. Compose default: `http://github-service:8081`. |
| `API_GATEWAY_PORT` / `GITHUB_SERVICE_PORT` / `WEBHOOK_SERVICE_PORT` | HTTP listen ports; defaults are `8080`, `8081`, and `8082`. |

## Run on local Kubernetes

The `k8s/local` bundle targets Docker Desktop Kubernetes and runs PostgreSQL and Redis in the `codereviewx` namespace. Follow [the local Kubernetes guide](k8s/local/README.md) to select the cluster, build images, create a local Secret, deploy the services, initialize PostgreSQL, and access the gateway with port-forwarding.

This deployment is useful for learning Kubernetes concepts such as Deployments, Services, ConfigMaps, Secrets, persistent volume claims, RBAC, and Horizontal Pod Autoscalers. CPU-based autoscaling requires Metrics Server data. Deleting the namespace also deletes its local persistent volumes and stored data.

## Deploy to a cloud Kubernetes cluster

The top-level `k8s/` manifests provide a starting point for a managed or self-managed Kubernetes cluster. Before applying them:

1. Build and push each service image to a registry accessible by the cluster, then replace `YOUR_REGISTRY` in the manifests.
2. Create the `codereviewx-secrets` Secret with `DATABASE_URL`, `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, and `GROQ_API_KEY` as needed.
3. Apply the ConfigMap and service manifests. Configure a managed PostgreSQL database and Redis endpoint, or deploy and operate those stateful services yourself.
4. Configure an ingress controller, DNS, TLS, network controls, resource limits, monitoring, backup, and recovery policies for your environment.
5. For the gateway's `/api/cluster/scaling` endpoint, retain and scope the Kubernetes service account and read-only RBAC permissions. The endpoint reports workload scaling data; it is unavailable when running outside a cluster.

Example Secret creation (use a secure shell/session and avoid saving real values in source control):

```bash
kubectl create secret generic codereviewx-secrets \
  --from-literal=GITHUB_TOKEN='YOUR_TOKEN' \
  --from-literal=GITHUB_WEBHOOK_SECRET='YOUR_WEBHOOK_SECRET' \
  --from-literal=DATABASE_URL='YOUR_DATABASE_URL' \
  --from-literal=GROQ_API_KEY='YOUR_GROQ_API_KEY'

kubectl apply -f k8s/
```

The sample manifests are not a turnkey production deployment. In particular, configure TLS for ingress, use a proper cloud secret manager, and review identity, RBAC, network access, and stateful service backups for your cluster.

## API overview

### API Gateway (`http://localhost:8080`)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Checks gateway and database connectivity. |
| `GET` | `/api/repos` | Lists registered repositories. |
| `POST` | `/api/repos` | Registers a repository. JSON body: `{"owner":"octocat","name":"Hello-World"}`. |
| `GET` | `/api/reviews` | Lists recent review runs. Optional `limit` is capped at 200. |
| `GET` | `/api/reviews/:id` | Returns a review run and its findings. |
| `GET` | `/api/reviews/:id/diff` | Fetches the pull request files associated with a review. |
| `POST` | `/api/reviews/run` | Queues a manual review. JSON body: `{"owner":"octocat","repo":"Hello-World","pull_number":1}`. Returns HTTP `202` with the review run ID. |
| `GET` | `/api/cluster/scaling` | Reads Kubernetes deployment, pod, and HPA status when running in a configured cluster. |

### GitHub Service (`http://localhost:8081`)

- `GET /health`
- `GET /api/repos/:owner/:repo`
- `GET /api/repos/:owner/:repo/pulls/:number/files`
- `GET /api/repos/:owner/:repo/compare?base=BRANCH&head=BRANCH`

### Webhook Service (`http://localhost:8082`)

- `POST /webhooks/github`

In the repository's GitHub settings, set the webhook URL to `https://YOUR_PUBLIC_HOST/webhooks/github`, select `application/json`, use the same secret as `GITHUB_WEBHOOK_SECRET`, and subscribe to Pull requests (and optionally Pushes). Expose the service through HTTPS and suitable network controls.

## Data model

- `repositories`: registered repositories.
- `review_runs`: manual and webhook-triggered review jobs, their status, and summary.
- `findings`: review findings linked to a review run.
- `webhook_events`: accepted delivery IDs used for deduplication and audit history.

Initialize the schema with [`db/init.sql`](db/init.sql). The SQL uses `IF NOT EXISTS` so it can be rerun.

## Example API calls

```bash
curl -X POST http://localhost:8080/api/repos \
  -H 'Content-Type: application/json' \
  -d '{"owner":"octocat","name":"Hello-World"}'

curl -X POST http://localhost:8080/api/reviews/run \
  -H 'Content-Type: application/json' \
  -d '{"owner":"octocat","repo":"Hello-World","pull_number":1}'

curl http://localhost:8080/api/reviews
```

## Security and production notes

- Keep GitHub, database, webhook, and AI credentials out of source control and frontend code. Rotate any credential that was committed or shared.
- The webhook endpoint verifies GitHub's `X-Hub-Signature-256` signature using a timing-safe comparison and deduplicates deliveries.
- Pull request diffs are sent to Groq when AI review is enabled. Check your organization's data handling requirements before enabling an external model provider.
- The API Gateway endpoints do not implement user authentication or tenant isolation in this MVP. Add these before exposing it to untrusted users.
- Review limits, retries, rate limits, dead-letter handling, database backups, and operational alerts before production use.
