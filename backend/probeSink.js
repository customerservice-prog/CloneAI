/**
 * Fast 404 for common automated scan paths. Keeps them off rate limits and http_request_close logs.
 * Never matches / or /api/* (real API routes).
 */

const RE_STRIP_QUERY = /\?.*$/;

export function isAutomatedProbePath(pathname) {
  const raw = String(pathname || '').replace(RE_STRIP_QUERY, '') || '/';
  const lower = raw.toLowerCase();

  if (lower === '/' || lower.startsWith('/api/')) return false;

  if (lower.includes('.env')) return true;
  if (lower.includes('.git')) return true;
  if (lower.includes('.svn') || lower.includes('.hg')) return true;

  if (lower.includes('/.aws') || /^\/aws\/credentials$/i.test(raw)) return true;
  if (lower.includes('.vscode')) return true;
  if (
    lower.includes('.circleci') ||
    lower.includes('.travis') ||
    lower.includes('.bitbucket')
  ) {
    return true;
  }

  if (lower.startsWith('/wordpress/') || lower.includes('/wp-') || /\/wp-config/i.test(raw)) return true;

  if (/(^|\/)(phpinfo|info\.php|test\.php|phpinfo\.php)$/i.test(lower)) return true;
  if (lower.includes('_profiler')) return true;
  if (lower.includes('/horizon/api/')) return true;
  if (/\/debug\/default\/view$/i.test(lower)) return true;
  if (/\/(?:debug|error)\.log$/i.test(lower)) return true;
  if (lower.includes('/storage/logs/')) return true;
  if (lower.includes('/storage/secrets')) return true;
  if (lower.includes('wc-logs')) return true;
  if (/\/manage\/env$/i.test(lower)) return true;
  if (/\/server-info$/i.test(lower)) return true;

  if (/(^|\/)(docker-compose|serverless)\.ya?ml$/i.test(lower)) return true;
  if (/(^|\/)appsettings\.json$/i.test(lower)) return true;
  if (/(^|\/)swagger\.json$/i.test(lower)) return true;
  if (/\/webhooks\/settings\.json$/i.test(lower)) return true;
  if (/(^|\/)credentials\.(json|txt)$/i.test(lower)) return true;
  if (/(^|\/)secrets?\.(json|ya?ml|yml)$/i.test(lower)) return true;

  if (/(^|\/)config\.(ya?ml|yml|json|js)$/i.test(lower)) return true;
  if (/(^|\/)sftp\.json$/i.test(lower)) return true;
  if (/(^|\/)env\.(json|js)$/i.test(lower)) return true;
  if (/(^|\/)__env\.js$/i.test(lower)) return true;
  if (/(^|\/)application\.(properties|ya?ml|yml)$/i.test(lower)) return true;
  if (/(^|\/)parameters\.ya?ml$/i.test(lower)) return true;
  if (/(^|\/)settings\.py$/i.test(lower)) return true;
  if (/(^|\/)instance\/config\.py$/i.test(lower)) return true;
  if (/(^|\/)admin\/(config|settings)$/i.test(lower)) return true;
  if (
    /(^|\/)config\/(inc|database\.ya?ml|credentials\.ya?ml|secrets\.ya?ml|settings\.json|config\.json|payment\.ya?ml|application\.ya?ml|parameters\.ya?ml|initializers\/stripe\.rb)$/i.test(
      lower
    )
  ) {
    return true;
  }
  if (/(^|\/)app\/config\/(stripe\.ya?ml|parameters\.ya?ml)$/i.test(lower)) return true;
  if (/(^|\/)backend\/config\//i.test(lower)) return true;

  if (lower.includes('stripe') && /\.(env|json|ya?ml|yml|ini|conf|ts|js|txt|key|log|bak|backup|old)$/i.test(raw)) {
    return true;
  }

  if (
    /(^|\/)((asset-manifest|\.vite\/manifest)\.json|@vite\/client|main\.js|vendor\.js|bundle\.js|app\.js|constants\.js|index\.js)$/i.test(
      lower
    )
  ) {
    return true;
  }

  if (/\.(sql|bak|backup|old|save|swp)(?:$|[?#])/i.test(lower)) return true;
  if (/~$/i.test(lower)) return true;

  return false;
}

function pathnameForProbe(req) {
  try {
    const raw = String(req.originalUrl || req.url || req.path || '/');
    const noQuery = raw.replace(RE_STRIP_QUERY, '');
    return noQuery.startsWith('/') ? noQuery : `/${noQuery}`;
  } catch {
    return '/';
  }
}

export function probeSinkMiddleware(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (!isAutomatedProbePath(pathnameForProbe(req))) return next();
  res.sendStatus(404);
}
