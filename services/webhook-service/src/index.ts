import dotenv from 'dotenv';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { Queue } from 'bullmq';
import { Pool } from 'pg';
import IORedis from 'ioredis';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const app = express();
const port = Number(process.env.WEBHOOK_SERVICE_PORT || 8082);
const databaseUrl = process.env.DATABASE_URL;
const databaseHost = databaseUrl ? new URL(databaseUrl).hostname : '';
const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseHost.endsWith('.supabase.co') || databaseHost.endsWith('.supabase.com')
    ? { rejectUnauthorized: false }
    : undefined
});
const redis = new IORedis(process.env.REDIS_URL || 'redis://redis:6379', { maxRetriesPerRequest: null });
const queue = new Queue('code-review', { connection: redis });
const secret = process.env.GITHUB_WEBHOOK_SECRET || '';

function verifySignature(raw: Buffer, signature: string | undefined): boolean {
  if (!secret || !signature?.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'webhook-service', secretConfigured: Boolean(secret) }));

app.post('/webhooks/github', express.raw({ type: 'application/json', limit: '5mb' }), async (req, res) => {
  const raw = req.body as Buffer;
  const signature = req.header('x-hub-signature-256');
  if (!Buffer.isBuffer(raw) || !verifySignature(raw, signature)) return res.status(401).json({ error: 'Invalid webhook signature' });

  let payload: any;
  try { payload = JSON.parse(raw.toString('utf8')); }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const event = req.header('x-github-event') || 'unknown';
  const delivery = req.header('x-github-delivery') || crypto.createHash('sha256').update(raw).digest('hex');
  const action = payload.action || null;
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const fullName = payload.repository?.full_name || null;

  try {
    const saved = await pool.query(
      'INSERT INTO webhook_events(delivery_id,event_type,action,repository_full_name) VALUES($1,$2,$3,$4) ON CONFLICT(delivery_id) DO NOTHING RETURNING delivery_id',
      [delivery, event, action, fullName]
    );
    if (!saved.rowCount) return res.status(200).json({ accepted: true, duplicate: true });

    if (event === 'pull_request' && ['opened', 'reopened', 'synchronize', 'ready_for_review'].includes(action) && owner && repo) {
      const prNumber = Number(payload.pull_request?.number || payload.number);
      if (Number.isInteger(prNumber) && prNumber > 0) {
        const run = await pool.query(
          'INSERT INTO review_runs(repository_owner,repository_name,pull_number,event_type,status) VALUES($1,$2,$3,$4,$5) RETURNING id',
          [owner, repo, prNumber, `webhook:${action}`, 'queued']
        );
        await queue.add('review-pr', { owner, repo, pull_number: prNumber, reviewRunId: run.rows[0].id }, {
          jobId: `github-${delivery}`, attempts: 3, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: 500, removeOnFail: 1000
        });
      }
    }
    res.status(202).json({ accepted: true, event, action, repository: fullName });
  } catch (e) {
    res.status(500).json({ error: 'Could not process webhook' });
  }
});

app.listen(port, () => console.log(`webhook-service listening on ${port}`));
