#!/usr/bin/env bash
# Why HEAT STR stays off: pulls Custom Cluster's log lines about the heated steering wheel (run on the Mac, car on).
#
#   tools/wheel_heat_log.sh root@$CAR_IP
#
# Press the wheel heat button on and off a couple of times first, then run this. Prints the installed version, any
# "steering wheel heating raw" line (the car sent the field), and any ClimateMaster subscribe error. Reads only.
set -euo pipefail

CAR="${1:?usage: $(basename "$0") root@\$CAR_IP}"

ssh "$CAR" '
  APP=$(grep -l "\"name\": \"custom_cluster\"" /var/opt/public/oap/oap_*/source/package.json 2>/dev/null | head -1 | sed "s#/source/package.json##")
  [ -n "$APP" ] || { echo "custom_cluster not installed"; exit 1; }
  echo "--- app: $APP"
  grep "\"version\"" "$APP/source/package.json"
  echo "--- manifest entry"
  grep -o -i "climatemaster[^}]*}" "$APP/source/manifest.json" || echo "ClimateMaster not in the manifest"
  echo "--- generated SOME/IP config"
  ls "$APP"/someipInterfaces 2>/dev/null | grep -i climate || echo "none for climate"
  echo "--- log files"
  LOGS=$(ls -t "$APP"/data/*.log* 2>/dev/null)
  echo "$LOGS"
  echo "--- heated wheel lines"
  grep -h -i -E "wheel heat|steering wheel heating|climate|SteeringWheelClimate" $LOGS 2>/dev/null | tail -40 || true
  echo "--- signal warnings"
  grep -h -E "signals de\.|subscribe de\." $LOGS 2>/dev/null | tail -20 || true
  echo "--- last start"
  grep -h -E "app started|layout \"Grand National\"" $LOGS 2>/dev/null | tail -4 || true
'
