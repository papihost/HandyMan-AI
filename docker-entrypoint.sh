#!/bin/sh
# Migrate before serving, and seed only when asked.
#
# `migrate deploy` applies what is pending and does nothing when there is nothing pending,
# so it is safe on every start. Seeding is not: it drops and rebuilds the demo company, so
# it happens only when SEED_DEMO says to, and even then the seed itself refuses on any
# organization not marked DEMO.
set -e

echo "==> Applying migrations"
npx prisma migrate deploy

if [ "$SEED_DEMO" = "1" ]; then
  echo "==> Seeding the demo company (this takes a few minutes)"
  npm run db:seed
fi

exec "$@"
