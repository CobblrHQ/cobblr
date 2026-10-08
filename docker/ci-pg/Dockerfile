# The CI job base image, cobblr-ci-pg:22.04: the act runner image plus
# Postgres. It is in no registry; each CI box builds it locally (the A6's
# health tick rebuilds it when missing, and the bake builds it on a box that
# has never had it), and the nightly bake turns it into cobblr-ci-pg-pool:22.04.
# This file is the source of truth for every box.
FROM catthehacker/ubuntu:act-22.04
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends postgresql postgresql-client psmisc tesseract-ocr poppler-utils \
 && rm -rf /var/lib/apt/lists/*
