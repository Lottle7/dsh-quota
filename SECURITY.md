# Security policy

## Reporting a vulnerability

Please do not open a public issue for credential exposure, SSRF, trust-boundary bypasses or sensitive-data leaks. Use GitHub's private vulnerability reporting for this repository. If private reporting is unavailable, contact the repository owner privately before disclosure.

Include the affected version, reproduction steps, impact and any known workaround. Never include a real API key or Session cookie.

## Security boundary

- Provider credentials are resolved and used only by the Host half.
- Browser routes return normalized, recursively sanitized snapshots.
- Non-loopback browser authorities must be explicitly trusted.
- Browser-local usage and price overrides contain no provider credentials.
- Arbitrary quota endpoint URLs are intentionally unsupported.

Supported releases receive security fixes on the latest minor line while the project remains pre-1.0.
