# Cobblr's Postgres image: Postgres 18 + pgvector, and it UPGRADES ITS OWN
# DATA DIRECTORY (see docker/db-auto-upgrade.sh).
#
# Why we build our own at all: pgvector publishes only Debian-based images
# (pgvector/pgvector:pg18) — there is no official Alpine tag. Swapping the base
# OS (musl → glibc) under an EXISTING data dir risks index-collation drift, so
# we stay on the Alpine base our data dirs were created under and add the
# extension ourselves. Same libc, same collation → truly drop-in.
#
# Why it carries TWO majors: a major Postgres bump was the one update an
# instance could not take by itself — the server refuses to start on an older
# data dir. Shipping the previous major's binaries lets the entrypoint run
# pg_upgrade on boot, so a self-hosted instance's `docker compose pull` is all
# it ever needs. Alpine 3.24 packages postgresql17 at 17.10, the exact version
# our clusters were created by.
#
# pgvector is compiled from a pinned source tag FOR BOTH MAJORS — pg_upgrade
# needs every extension present on both sides of the upgrade, or it aborts.
# clang/llvm MUST match the LLVM postgres itself was built against, or the JIT
# bitcode pgvector emits won't load. postgres:18-alpine3.24 is built
# `--with-llvm` against LLVM 21, so we use clang21 + llvm21-dev. If the base
# image's LLVM major moves, bump these in lockstep (check
# `pg_config --configure | tr ' ' '\n' | grep LLVM_CONFIG`).
#
# The base tag is PINNED to a specific Alpine. An unpinned `18-alpine` can move
# to a new Alpine with a different LLVM major and break the pgvector build
# silently — the exact failure this comment block warns about.
FROM postgres:18-alpine3.24

ARG PGVECTOR_VERSION=v0.8.6

# ── pgvector for the CURRENT major (the image's own /usr/local tree) ──
RUN set -eux; \
    apk add --no-cache --virtual .build-deps \
        build-base \
        clang21 \
        llvm21-dev \
        git; \
    git clone --branch "${PGVECTOR_VERSION}" --depth 1 \
        https://github.com/pgvector/pgvector.git /tmp/pgvector; \
    make -C /tmp/pgvector OPTFLAGS="" install; \
    rm -rf /tmp/pgvector; \
    apk del .build-deps

# Sanity: the control file must be present for `CREATE EXTENSION vector`.
RUN test -f "$(pg_config --sharedir)/extension/vector.control"

# ── the PREVIOUS major's server + pgvector, so pg_upgrade can read an old
#    cluster. Adds ~90MB; the alternative is an instance that cannot update. ──
RUN set -eux; \
    apk add --no-cache postgresql17 postgresql17-client; \
    apk add --no-cache --virtual .build-deps17 \
        build-base \
        clang21 \
        llvm21-dev \
        git \
        postgresql17-dev; \
    git clone --branch "${PGVECTOR_VERSION}" --depth 1 \
        https://github.com/pgvector/pgvector.git /tmp/pgvector17; \
    make -C /tmp/pgvector17 OPTFLAGS="" PG_CONFIG=/usr/libexec/postgresql17/pg_config install; \
    rm -rf /tmp/pgvector17; \
    apk del .build-deps17

RUN test -f "$(/usr/libexec/postgresql17/pg_config --sharedir)/extension/vector.control"

COPY docker/db-auto-upgrade.sh /usr/local/bin/db-auto-upgrade.sh
RUN chmod +x /usr/local/bin/db-auto-upgrade.sh

ENTRYPOINT ["/usr/local/bin/db-auto-upgrade.sh"]
CMD ["postgres"]
