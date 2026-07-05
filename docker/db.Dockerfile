# Custom Postgres image = stock postgres:17-alpine + the pgvector extension.
#
# Why build our own: pgvector publishes only Debian-based images
# (pgvector/pgvector:pg17) — there is no official Alpine tag. Swapping the
# base OS (musl → glibc) under an EXISTING data dir risks index-collation
# drift, so we stay on the exact same postgres:17-alpine base our prod data
# dir was created under and just add the extension. Same major (17), same
# libc, same collation → truly drop-in for the bind-mounted volume.
#
# pgvector is compiled from a pinned source tag; the build toolchain is
# installed as a virtual package and removed in the same layer so the runtime
# image stays lean. clang/llvm MUST match the LLVM that postgres itself was
# built against, or the JIT bitcode pgvector emits won't load — postgres:17-alpine
# (Alpine 3.24) is built `--with-llvm` against LLVM 21, so we use clang21 +
# llvm21-dev. If the base image's LLVM major moves, bump these in lockstep
# (check `pg_config --configure | tr ' ' '\n' | grep LLVM_CONFIG`).
FROM postgres:17-alpine

ARG PGVECTOR_VERSION=v0.8.0

RUN set -eux; \
    apk add --no-cache --virtual .build-deps \
        build-base \
        clang21 \
        llvm21-dev \
        git; \
    git clone --branch "${PGVECTOR_VERSION}" --depth 1 \
        https://github.com/pgvector/pgvector.git /tmp/pgvector; \
    cd /tmp/pgvector; \
    make OPTFLAGS=""; \
    make install; \
    cd /; \
    rm -rf /tmp/pgvector; \
    apk del .build-deps

# Sanity: the control file must be present for `CREATE EXTENSION vector`.
RUN test -f "$(pg_config --sharedir)/extension/vector.control"
