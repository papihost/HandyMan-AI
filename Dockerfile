# The demo has to be able to run on somebody else's laptop.
#
# One stage, and the dev dependencies stay in the image. That is the wrong default for a
# service and the right one here: this image is expected to run `prisma migrate deploy` and
# `npm run db:seed`, and the seed is TypeScript that builds a year of a company from the
# posting engine itself. Stripping it to a standalone bundle would halve the image and
# remove the thing the image is for.
FROM node:22-bookworm-slim

# Prisma's query engine is linked against OpenSSL, and the slim image does not carry it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a source change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci

# The client is generated from the schema, so the schema has to land before the build.
COPY prisma ./prisma
RUN npx prisma generate

COPY . .

# The build needs no database: every page that reads one is rendered on demand.
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

COPY docker-entrypoint.sh /usr/local/bin/
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "start"]
