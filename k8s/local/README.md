# Local Kubernetes deployment

This bundle targets Docker Desktop Kubernetes. It builds service images locally and deploys PostgreSQL and Redis in the `codereviewx` namespace. It does not use the placeholder images in `../`.

## 1. Select the cluster

Enable Kubernetes in Docker Desktop, then verify that `kubectl config get-contexts` lists `docker-desktop` and select it:

```powershell
kubectl config use-context docker-desktop
kubectl get nodes
```

## 2. Build the service images

Run these from the repository root. Docker Desktop Kubernetes uses the local Docker Desktop image store.

```powershell
docker build -t codereviewx-api-gateway:local ./services/api-gateway
docker build -t codereviewx-github-service:local ./services/github-service
docker build -t codereviewx-webhook-service:local ./services/webhook-service
docker build -t codereviewx-review-worker:local ./services/review-worker
```

## 3. Create local credentials

Copy `secrets.env.example` to `secrets.env` and set a local PostgreSQL password plus your GitHub and Groq credentials. Keep `DATABASE_URL` pointed at the in-cluster `postgres` service. The example values are placeholders and are ignored by Git when stored in `secrets.env`.

```powershell
Copy-Item k8s/local/secrets.env.example k8s/local/secrets.env
kubectl apply -f k8s/local/00-namespace.yaml
kubectl create secret generic codereviewx-secrets --namespace codereviewx --from-env-file=k8s/local/secrets.env --dry-run=client -o yaml | kubectl apply -f -
```

To refresh credentials after changing `secrets.env`, rerun the `kubectl create secret ... | kubectl apply -f -` command above, then restart the worker so it loads the updated environment:

```powershell
kubectl rollout restart deployment/review-worker --namespace codereviewx
kubectl rollout status deployment/review-worker --namespace codereviewx
```

## 4. Deploy and initialize the database

```powershell
kubectl apply -k k8s/local
kubectl rollout status statefulset/postgres --namespace codereviewx --timeout=180s
Get-Content db/init.sql | kubectl exec -i --namespace codereviewx postgres-0 -- psql -U postgres -d codereviewx
kubectl rollout status deployment/api-gateway --namespace codereviewx
kubectl rollout status deployment/review-worker --namespace codereviewx
```

The SQL initialization is safe to rerun. PostgreSQL and Redis use persistent volume claims; deleting the namespace also removes those local claims and their data.

The dashboard includes a **Cluster scaling** panel with live deployment replica counts, pod readiness, and HPA CPU targets. It reads the Kubernetes API through a read-only service account scoped to this namespace. The local review worker HPA targets 70% CPU and scales from 1 to 6 replicas; the cluster needs Metrics Server data for CPU-based scaling to take effect.

## 5. Call the API

In one PowerShell window:

```powershell
kubectl port-forward --namespace codereviewx service/api-gateway 8080:8080
```

In another window:

```powershell
Invoke-RestMethod http://localhost:8080/health
Invoke-RestMethod -Method Post http://localhost:8080/api/repos -ContentType 'application/json' -Body '{"owner":"octocat","name":"Hello-World"}'
```

To inspect workloads and logs:

```powershell
kubectl get pods,services,pvc --namespace codereviewx
kubectl logs deployment/review-worker --namespace codereviewx -f
```

To watch autoscaling directly while generating review load:

```powershell
kubectl get hpa,deployments,pods --namespace codereviewx --watch
```

The browser panel shows the same replica and pod state when opened through the API Gateway port-forward. Outside Kubernetes it explains that live cluster data is unavailable.
