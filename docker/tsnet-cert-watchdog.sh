#!/bin/sh
# Say something when a tsnet TLS certificate never arrives.
#
# A missing cert is SILENT. Nothing logs it, Caddy keeps serving, and the only
# symptom is the browser aborting the handshake with SSL_ERROR_INTERNAL_ERROR_ALERT
# (TLS alert 80, "no peer certificate available") — which reads like a TLS bug and
# is not one. A self-hoster lost an evening to exactly this: node Connected,
# HTTPS certificates enabled on the tailnet, and nothing anywhere saying that the
# NAME was the problem.
#
# Tailscale issues a cert only for a name the node owns, and the node registers
# using ONLY the first label of the site address. A wrong tailnet therefore looks
# perfectly healthy in the admin console while the cert request is for a name the
# user does not have.
#
#   tsnet-cert-watchdog.sh <node-name> <site-address>
#
# Runs in the background from caddy-entrypoint.sh and exits as soon as the cert
# exists. Its own file so it can be tested without booting Caddy.
set -u
NODE="${1:?usage: tsnet-cert-watchdog.sh <node-name> <site-address>}"
ADDR="${2:?usage: tsnet-cert-watchdog.sh <node-name> <site-address>}"

# Measured on a working install, not guessed: tsnet writes the pair to
# /config/tsnet-caddy-<node>/certs/<full-name>.{crt,key}. These certs do NOT go
# through Caddy's own ACME storage under /data, so looking there finds nothing
# even when everything is fine.
CERT_ROOT="${COBBLR_TSNET_CONFIG_DIR:-/config}"
CERT_DIR="${CERT_ROOT}/tsnet-caddy-${NODE}/certs"
CERT="${CERT_DIR}/${ADDR}.crt"

# Overridable so a test does not wait two minutes, and so a slow tailnet can be
# given longer without editing the image.
TRIES="${COBBLR_TSNET_CERT_TRIES:-24}"
SLEEP="${COBBLR_TSNET_CERT_SLEEP:-5}"

i=0
while [ "$i" -lt "$TRIES" ]; do
  [ -f "$CERT" ] && exit 0
  sleep "$SLEEP"
  i=$((i + 1))
done

# Naming whatever DID get a cert is most of the diagnosis: seeing
# "cobblr-1.…crt" next to a request for "cobblr.…" explains itself.
GOT=$(ls "$CERT_DIR" 2>/dev/null | grep '\.crt$' | tr '\n' ' ')

cat >&2 <<CERTWARN

============================================================================
  NO TLS CERTIFICATE FOR ${ADDR}
----------------------------------------------------------------------------
  Tailscale has not issued one. Until it does, every HTTPS request is refused
  during the handshake, and a browser reports that as "Secure Connection
  Failed" / SSL_ERROR_INTERNAL_ERROR_ALERT. That error means this. It is not a
  broken browser and not a clock problem.

  Certificates this node holds: ${GOT:-none}

  In order of likelihood:

  1. NOT APPROVED YET. If an approval link was printed above, open it. This
     message is expected until you do.

  2. THE NAME IS NOT ONE THIS NODE OWNS. Tailscale only issues a cert for the
     node's own name. This node registered using just the first label
     ('${NODE}') and never checked the rest, so a wrong tailnet looks perfectly
     healthy in the admin console. Open this machine in the Tailscale admin
     console, copy its FULL name, and make COBBLR_SITE_ADDRESS match it
     character for character. The tailnet name is on the DNS page.

     Watch for a duplicate: if a '${NODE}' node already existed, this one
     registered as '${NODE}-1' and the plain name is not yours. The line above
     says which name actually holds a cert.

  3. HTTPS CERTIFICATES ARE OFF for the tailnet. Admin console -> DNS ->
     HTTPS Certificates. MagicDNS has to be on first.

  Correcting only the tailnet half keeps this same node, so the fix is just:
      docker compose up -d caddy
  Changing the FIRST label makes a NEW node and needs a fresh approval link.
============================================================================

CERTWARN

# Keep watching. Without this the warning is the last word in the log and reads
# as still-broken long after it was fixed.
#
# Bounded rather than `while :`, so the process cannot outlive any reason to
# exist and a test can ask for zero rechecks instead of being killed by a
# timeout. The default is days; the container restarts long before it lapses.
RECHECKS="${COBBLR_TSNET_CERT_RECHECKS:-100000}"
j=0
while [ "$j" -lt "$RECHECKS" ]; do
  if [ -f "$CERT" ]; then
    echo "caddy-entrypoint: certificate for ${ADDR} has arrived; HTTPS is up." >&2
    exit 0
  fi
  sleep 15
  j=$((j + 1))
done
