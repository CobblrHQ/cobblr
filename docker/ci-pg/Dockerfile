# The CI job base image, cobblr-ci-pg:22.04: the act runner image plus
# Postgres. It is in no registry; each CI box builds it locally (the A6's
# health tick rebuilds it when missing, and the bake builds it on a box that
# has never had it), and the nightly bake turns it into cobblr-ci-pg-pool:22.04.
# This file is the source of truth for every box.
FROM catthehacker/ubuntu:act-22.04
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends postgresql postgresql-client psmisc tesseract-ocr poppler-utils \
 && rm -rf /var/lib/apt/lists/*
# THE BROWSERS (#6551, 2026-10-14): the walks run here (the ci-e2e label is the pool image baked from this
# one) on Chromium and WebKit, a real phone's engine. Baked for the repository's Playwright, held equal to
# it by scripts/ci/the-runner-image-has-the-repos-playwright.test.ts; a job finds them through
# scripts/ci/playwright-browsers.sh and installs in full, with a warning, when the image is behind.
ARG PLAYWRIGHT_VERSION=1.60.0
RUN PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npx -y "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium chromium-headless-shell webkit \
 && chmod -R a+rX /ms-playwright \
 && echo "${PLAYWRIGHT_VERSION}" > /ms-playwright/.playwright-version \
 && rm -rf /var/lib/apt/lists/* /root/.npm
