# Optional bundled Android updates

Keep this directory in Git so the Dockerfile can copy it when building directly
from a repository checkout or a remote Git build context.

Release CI runs `node scripts/bundle-app-update.mjs` before building to populate
the directory with a verified Android release. Generated APKs and manifests are
ignored by Git. A source-only build contains no bundled Android update; the
backend remains usable and the App can use its existing GitHub update fallback.
