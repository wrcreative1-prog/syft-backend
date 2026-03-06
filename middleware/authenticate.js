const jwt = require('jsonwebtoken');

/**
 * Middleware: verifies the Bearer JWT in the Authorization header.
 * Attaches the decoded payload to req.user on success.
 * Returns 401 if the token is missing or invalid.
 */
function authenticate(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing auth token.' });
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

/**
 * Middleware: same as authenticate but also requires role === 'business' or 'admin'.
 */
function requireBusiness(req, res, next) {
  authenticate(req, res, () => {
    if (req.user.role !== 'business' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Business account required.' });
    }
    next();
  });
}

module.exports = { authenticate, requireBusiness };
