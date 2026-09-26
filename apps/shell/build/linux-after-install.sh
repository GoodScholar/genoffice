#!/bin/sh
# deb/rpm post-install: expose the genoffice command line shipped inside the app.
set -e
launcher="/opt/GenOffice/resources/cli/genoffice"
link="/usr/bin/genoffice"
if [ -x "$launcher" ]; then
  if [ ! -e "$link" ] && [ ! -L "$link" ]; then
    ln -s "$launcher" "$link"
  elif [ -L "$link" ] && [ "$(readlink "$link")" = "$launcher" ]; then
    :
  else
    printf 'genoffice: %s already exists; leaving it unchanged\n' "$link" >&2
  fi
fi
exit 0
