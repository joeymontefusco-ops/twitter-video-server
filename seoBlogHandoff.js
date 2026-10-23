const SEO_BLOG_PENDING = 'SEO_PENDING';

function seoBlogHandoffEnabled(env = process.env) {
  return env.SEO_BLOG_HANDOFF_ENABLED === 'true';
}

// Only the watcher for a newly published X thread can create the marker.
// Existing numeric WordPress IDs and other nonempty ownership values stay intact.
function seoBlogHandoffMarker(row, env = process.env) {
  if (!seoBlogHandoffEnabled(env) || String(row?.blogPostId || '').trim()) return null;
  return SEO_BLOG_PENDING;
}

function railwayMayPublishBlog(row, env = process.env) {
  return !seoBlogHandoffEnabled(env) && !String(row?.blogPostId || '').trim();
}

module.exports = { SEO_BLOG_PENDING, seoBlogHandoffEnabled, seoBlogHandoffMarker, railwayMayPublishBlog };
