/**
 * MoodSentinel — src/utils/helpers.js
 * Utility functions used across the app.
 */

/**
 * Safely parse a float value, returning 0 for invalid inputs.
 */
export function safeFloat(val) {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

/**
 * Check if a URL is a valid Facebook post URL.
 */
export function isPostUrl(url) {
  if (!url || !url.includes('facebook.com')) return false;

  const excluded = [
    '/share/', 'facebook.com/?', 'facebook.com/home',
    'facebook.com/login', 'facebook.com/checkpoint',
    'facebook.com/feed', 'facebook.com/groups/?',
  ];

  if (excluded.some(e => url.includes(e))) return false;
  if (url === 'https://www.facebook.com/' || url === 'https://m.facebook.com/') return false;

  return (
    url.includes('/posts/') ||
    url.includes('story_fbid') ||
    url.includes('/permalink/') ||
    url.includes('photo.php') ||
    url.includes('/photo/') ||
    url.includes('/video/') ||
    url.includes('story.php') ||
    url.includes('/reel/')
  );
}

/**
 * Shorten a Facebook URL for display.
 */
export function shortUrl(url) {
  return (url || '')
    .replace('https://www.facebook.com', 'fb.com')
    .replace('https://m.facebook.com', 'fb.com');
}

/**
 * Format milliseconds into a readable string.
 */
export function formatMs(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
