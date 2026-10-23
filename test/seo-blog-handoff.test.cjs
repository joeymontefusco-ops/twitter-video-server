const test = require('node:test');
const assert = require('node:assert/strict');
const { SEO_BLOG_PENDING, seoBlogHandoffMarker, railwayMayPublishBlog } = require('../seoBlogHandoff');

test('cutover marks only new unowned threads and blocks Railway WordPress writes', () => {
  const enabled = { SEO_BLOG_HANDOFF_ENABLED: 'true' };
  const disabled = { SEO_BLOG_HANDOFF_ENABLED: 'false' };
  assert.equal(seoBlogHandoffMarker({ blogPostId: '' }, enabled), SEO_BLOG_PENDING);
  assert.equal(railwayMayPublishBlog({ blogPostId: '' }, enabled), false);
  assert.equal(seoBlogHandoffMarker({ blogPostId: '25180' }, enabled), null);
  assert.equal(seoBlogHandoffMarker({ blogPostId: SEO_BLOG_PENDING }, enabled), null);
  assert.equal(railwayMayPublishBlog({ blogPostId: SEO_BLOG_PENDING }, disabled), false,
    'switch rollback cannot make Railway take an SEO-owned row');
  assert.equal(railwayMayPublishBlog({ blogPostId: '25180' }, disabled), false);
  assert.equal(railwayMayPublishBlog({ blogPostId: '' }, disabled), true,
    'legacy behavior stays available before cutover');
});
