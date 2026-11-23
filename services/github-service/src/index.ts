import dotenv from 'dotenv';
import express from 'express';
import path from 'node:path';
import { Octokit } from '@octokit/rest';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const app = express();
const port = Number(process.env.GITHUB_SERVICE_PORT || 8081);
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN || undefined });

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'github-service', tokenConfigured: Boolean(process.env.GITHUB_TOKEN) }));

app.get('/api/repos/:owner/:repo', async (req, res) => {
  try {
    const { data } = await octokit.rest.repos.get({ owner: req.params.owner, repo: req.params.repo });
    res.json({ id: data.id, full_name: data.full_name, private: data.private, default_branch: data.default_branch, html_url: data.html_url });
  } catch (e: any) {
    res.status(e.status || 502).json({ error: 'GitHub repository lookup failed', details: e.message });
  }
});

app.get('/api/repos/:owner/:repo/pulls/:number/files', async (req, res) => {
  const number = Number(req.params.number);
  if (!Number.isInteger(number) || number < 1) return res.status(400).json({ error: 'Invalid pull request number' });
  try {
    const files: any[] = [];
    for await (const response of octokit.paginate.iterator(octokit.rest.pulls.listFiles, {
      owner: req.params.owner, repo: req.params.repo, pull_number: number, per_page: 100
    })) {
      files.push(...response.data.map(f => ({
        filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions,
        changes: f.changes, patch: f.patch ?? null, blob_url: f.blob_url, raw_url: f.raw_url
      })));
      if (files.length >= 1000) break;
    }
    res.json(files);
  } catch (e: any) {
    res.status(e.status || 502).json({ error: 'Could not fetch pull request files', details: e.message });
  }
});

app.get('/api/repos/:owner/:repo/compare', async (req, res) => {
  const base = String(req.query.base || '');
  const head = String(req.query.head || '');
  if (!base || !head) return res.status(400).json({ error: 'Provide base and head query parameters' });
  try {
    const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner: req.params.owner, repo: req.params.repo, basehead: `${base}...${head}`
    });
    res.json({
      status: data.status, ahead_by: data.ahead_by, behind_by: data.behind_by,
      commits: data.commits.map(c => ({ sha: c.sha, message: c.commit.message, author: c.commit.author?.name })),
      files: (data.files || []).map(f => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch ?? null }))
    });
  } catch (e: any) {
    res.status(e.status || 502).json({ error: 'Commit comparison failed', details: e.message });
  }
});

app.listen(port, () => console.log(`github-service listening on ${port}`));
