import dotenv from 'dotenv';
import express from 'express';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import { Pool } from 'pg';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const app = express();
app.use(express.json({ limit: '1mb' }));
const databaseUrl = process.env.DATABASE_URL;
const databaseHost = databaseUrl ? new URL(databaseUrl).hostname : '';
const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseHost.endsWith('.supabase.co') || databaseHost.endsWith('.supabase.com')
    ? { rejectUnauthorized: false }
    : undefined
});
const port = Number(process.env.API_GATEWAY_PORT || 8080);
const githubService = process.env.GITHUB_SERVICE_URL || 'http://github-service:8081';
const kubeNamespace = process.env.POD_NAMESPACE || 'default';

app.use(express.static(path.join(__dirname, '../public')));

app.get('/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok', service: 'api-gateway' }); }
  catch (e) {
    console.error('Database health check failed:', e);
    res.status(503).json({ status: 'unhealthy' });
  }
});

app.get('/api/repos', async (_req, res) => {
  try {
    const result = await pool.query('SELECT id, owner, name, full_name, created_at FROM repositories ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: 'Could not list repositories' }); }
});

app.post('/api/repos', async (req, res) => {
  const { owner, name } = req.body ?? {};
  if (typeof owner !== 'string' || typeof name !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    return res.status(400).json({ error: 'owner and name are required and must be valid GitHub identifiers' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO repositories(owner,name) VALUES($1,$2) ON CONFLICT(owner,name) DO UPDATE SET name=EXCLUDED.name RETURNING id,owner,name,full_name,created_at',
      [owner, name]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error('Could not register repository:', e);
    res.status(500).json({ error: 'Could not register repository' });
  }
});

app.get('/api/reviews', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
  try {
    const result = await pool.query(
      'SELECT id, repository_owner, repository_name, pull_number, commit_sha, event_type, status, summary, error, created_at, completed_at FROM review_runs ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    res.json(result.rows);
  } catch { res.status(500).json({ error: 'Could not list reviews' }); }
});

app.get('/api/reviews/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid review id' });
  try {
    const run = await pool.query('SELECT * FROM review_runs WHERE id=$1', [id]);
    if (!run.rowCount) return res.status(404).json({ error: 'Review not found' });
    const findings = await pool.query('SELECT * FROM findings WHERE review_run_id=$1 ORDER BY CASE severity WHEN \'critical\' THEN 1 WHEN \'high\' THEN 2 WHEN \'medium\' THEN 3 ELSE 4 END, id', [id]);
    res.json({ ...run.rows[0], findings: findings.rows });
  } catch (e) {
    console.error(`Could not fetch review ${id}:`, e);
    res.status(500).json({ error: 'Could not fetch review' });
  }
});

app.get('/api/reviews/:id/diff', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid review id' });
  try {
    const result = await pool.query('SELECT repository_owner, repository_name, pull_number FROM review_runs WHERE id=$1', [id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Review not found' });
    const review = result.rows[0];
    if (!review.pull_number) return res.status(400).json({ error: 'This review has no pull request diff' });
    const response = await fetch(`${githubService}/api/repos/${encodeURIComponent(review.repository_owner)}/${encodeURIComponent(review.repository_name)}/pulls/${review.pull_number}/files`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(response.status).json({ error: payload.error || 'GitHub service could not fetch this diff' });
    res.json({ files: payload });
  } catch (error) {
    console.error(`Could not fetch diff for review ${id}:`, error);
    res.status(502).json({ error: 'Could not fetch this pull request diff' });
  }
});

app.get('/api/cluster/scaling', async (_req, res) => {
  const tokenPath = '/var/run/secrets/kubernetes.io/serviceaccount/token';
  const caPath = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
  try {
    const [token, ca] = await Promise.all([readFile(tokenPath, 'utf8'), readFile(caPath)]);
    const headers = { Authorization: `Bearer ${token.trim()}`, Accept: 'application/json' };
    const request = (resource: string) => new Promise<any>((resolve, reject) => {
      const coreApi = resource.startsWith('core/');
      const apiPath = resource.replace(/^core\//, '');
      const requestOptions = { hostname: 'kubernetes.default.svc', path: `${coreApi ? '/api/' : '/apis/'}${apiPath}`, method: 'GET', headers, ca };
      const kubeRequest = https.request(requestOptions, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => {
          if ((response.statusCode || 500) >= 400) return reject(new Error(`Kubernetes API returned ${response.statusCode}`));
          try { resolve(JSON.parse(body)); } catch { reject(new Error('Kubernetes API returned invalid JSON')); }
        });
      });
      kubeRequest.on('error', reject);
      kubeRequest.end();
    });
    const [deployments, pods, hpas] = await Promise.all([
      request(`apps/v1/namespaces/${kubeNamespace}/deployments`),
      request(`core/v1/namespaces/${kubeNamespace}/pods`),
      request(`autoscaling/v2/namespaces/${kubeNamespace}/horizontalpodautoscalers`)
    ]);
    const hpaByTarget = new Map((hpas.items || []).map((hpa: any) => [hpa.spec?.scaleTargetRef?.name, hpa]));
    const services = (deployments.items || []).map((deployment: any) => {
      const name = deployment.metadata?.name || 'unknown';
      const hpa: any = hpaByTarget.get(name);
      const selectedPods = (pods.items || []).filter((pod: any) => pod.metadata?.ownerReferences?.some((owner: any) => owner.kind === 'ReplicaSet') && pod.metadata?.labels?.app === deployment.spec?.selector?.matchLabels?.app);
      const readyPods = selectedPods.filter((pod: any) => pod.status?.phase === 'Running' && (pod.status?.containerStatuses || []).every((container: any) => container.ready)).length;
      return {
        name,
        replicas: deployment.status?.replicas || 0,
        ready: deployment.status?.readyReplicas || 0,
        desired: deployment.spec?.replicas || 0,
        pods: selectedPods.map((pod: any) => ({ name: pod.metadata?.name, phase: pod.status?.phase || 'Pending', ready: (pod.status?.containerStatuses || []).length > 0 && (pod.status?.containerStatuses || []).every((container: any) => container.ready) })),
        hpa: hpa ? { current: hpa.status?.currentReplicas || 0, desired: hpa.status?.desiredReplicas || 0, min: hpa.spec?.minReplicas || 1, max: hpa.spec?.maxReplicas || 1, cpuTarget: hpa.spec?.metrics?.find((metric: any) => metric.resource?.name === 'cpu')?.resource?.target?.averageUtilization ?? null, currentCpu: hpa.status?.currentMetrics?.find((metric: any) => metric.resource?.name === 'cpu')?.resource?.current?.averageUtilization ?? null } : null,
        runningPods: readyPods
      };
    });
    res.json({ namespace: kubeNamespace, services, sampled_at: new Date().toISOString() });
  } catch (error: any) {
    const unavailable = error?.code === 'ENOENT' || error?.code === 'EACCES';
    res.status(unavailable ? 503 : 502).json({ error: unavailable ? 'Live Kubernetes metrics are unavailable outside a cluster or without dashboard access.' : error.message || 'Could not read Kubernetes scaling status' });
  }
});

app.post('/api/reviews/run', async (req, res) => {
  const { owner, repo, pull_number } = req.body ?? {};
  if (typeof owner !== 'string' || typeof repo !== 'string' || !Number.isInteger(pull_number) || pull_number < 1) {
    return res.status(400).json({ error: 'Expected owner, repo, and positive integer pull_number' });
  }
  try {
    const r = await fetch(`${githubService}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pull_number}/files`);
    if (!r.ok) {
      const body = await r.text();
      return res.status(r.status).json({ error: 'GitHub service could not fetch PR files', details: body.slice(0, 500) });
    }
    const files = await r.json();
    const inserted = await pool.query(
      'INSERT INTO review_runs(repository_owner,repository_name,pull_number,event_type,status) VALUES($1,$2,$3,$4,$5) RETURNING id,status',
      [owner, repo, pull_number, 'manual', 'queued']
    );
    // Use the same Redis queue as webhook events.
    const { Queue } = await import('bullmq');
    const redisUrl = new URL(process.env.REDIS_URL || 'redis://redis:6379');
    const queue = new Queue('code-review', {
      connection: {
        host: redisUrl.hostname,
        port: Number(redisUrl.port || 6379),
        ...(redisUrl.username ? { username: decodeURIComponent(redisUrl.username) } : {}),
        ...(redisUrl.password ? { password: decodeURIComponent(redisUrl.password) } : {}),
        ...(redisUrl.pathname.length > 1 ? { db: Number(redisUrl.pathname.slice(1)) } : {}),
        ...(redisUrl.protocol === 'rediss:' ? { tls: {} } : {})
      }
    });
    await queue.add('review-pr', { owner, repo, pull_number, reviewRunId: inserted.rows[0].id, files }, { jobId: `manual-${inserted.rows[0].id}` });
    await queue.close();
    res.status(202).json({ review_run_id: inserted.rows[0].id, status: 'queued' });
  } catch (e) {
    res.status(500).json({ error: 'Could not queue review' });
  }
});

app.listen(port, () => console.log(`api-gateway listening on ${port}`));
