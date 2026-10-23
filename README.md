# Twitter video server

## SEO WordPress handoff

`SEO_BLOG_HANDOFF_ENABLED=true` routes newly published TMA X threads to the Hostinger SEO worker. The watcher writes `SEO_PENDING` into the existing `blogPostId` Sheet column together with `threadPublished`, the first TMA X URL, and the final tweet text. It reads the row back before continuing. Railway still performs its X and drip work, but its WordPress publisher skips the row. The dedicated WordPress test endpoint also refuses an SEO-owned marker.

The SEO worker accepts only `SEO_PENDING` rows, makes a private draft, applies its source, citation, delay, public X, audit, and WordPress readback gates, then writes the numeric WordPress ID back to `blogPostId`. It retries an uncertain Sheet write without repeating WordPress publication. Existing numeric IDs are never replaced. The Sheet must retain its `blogPostId` header, and the Hostinger SEO service account needs Writer access to that Sheet.

The switch defaults off. Turning it off later does **not** transfer marked rows back to Railway; they remain SEO-owned until the SEO worker completes or an operator resolves a failed run. This avoids a duplicate WordPress post during rollback.

Run `node --test test/*.test.cjs` and `node --check index.js` before deploying this service.
