#!/usr/bin/env bash
# The engine is there (it answers --version) and every read fails, as a
# timeout or a crash on a loaded box does.
[ "$1" = "--version" ] && exec tesseract --version
cat >/dev/null; echo "tesseract: killed" >&2; exit 1
