# Demonstrating the GitHub Webhook

This short demo shows how a GitHub pull request can start a CodeReviewX review.
It is a documentation-only change, so opening a pull request with this file is
enough to generate a real GitHub webhook event and a small review job.

## Before the demo

- Make sure the Webhook Service is running and reachable by GitHub at a public
  HTTPS URL ending in `/webhooks/github`. A local `localhost` URL is not
  reachable from GitHub; for a local demo, expose the service through a
  temporary HTTPS tunnel.
- In GitHub repository **Settings → Webhooks**, configure that URL with content
  type `application/json`, the same secret used for `GITHUB_WEBHOOK_SECRET`,
  and the **Pull requests** event.
- Keep PostgreSQL, Redis, and the Review Worker running. Configure the
  Review Worker with a GitHub token that can read the repository's pull
  requests. Groq is optional; without `GROQ_API_KEY`, the worker uses its
  built-in heuristic reviewer.

## Demo steps

1. Create a branch and add a small change, for example this file.
2. Push the branch to GitHub.
3. Open a pull request from that branch into the repository's default branch.
   Pushing a branch by itself sends a `push` event, which CodeReviewX records
   but does not turn into a review.
4. In GitHub, open **Settings → Webhooks → Recent Deliveries**. Find the
   `pull_request` delivery and confirm that it received a successful response.
   GitHub may also send a `ping` when the webhook is first configured; a ping
   checks connectivity but does not queue a review.
5. In CodeReviewX, show the queued review, then refresh the dashboard to see
   the worker's result. The service queues reviews for `opened`, `reopened`,
   `synchronize`, and `ready_for_review` pull request actions.

## What happens behind the scenes?

GitHub sends the event to the Webhook Service. The service verifies the
signature using the shared secret, stores the delivery ID to avoid duplicate
processing, creates a review run in PostgreSQL, and queues a job in Redis.
The Review Worker takes that job, retrieves the pull request changes from
GitHub, analyzes them, and saves the summary and findings in PostgreSQL. The
dashboard displays those results through the API Gateway.

If GitHub shows a failed delivery, check that the URL is publicly reachable,
the secret matches, and the Webhook Service is running. If delivery succeeds
but no review appears, check the service and worker logs, Redis connectivity,
database configuration, and the worker's GitHub access.
