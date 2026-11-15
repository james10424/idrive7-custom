#!/usr/bin/env bash
# Heated steering wheel signals: are they on this car? (run on the Mac, car on)
# ClimateMaster statusSteeringWheelHeating is in the car's catalog and subscribes, but nothing on the G20 sends it
# (Custom Cluster 0.1.60, Nov 14 2026). These are the other fields that carry the wheel heat.
#
#   tools/wheel_heat_check.sh root@$CAR_IP
#
# Step 1 looks the candidates up in the car's own catalog (/etc/oap/someip/someip-interfaces.json): interface,
# service id, field, getter / notifier, members.
# Step 2 runs the firmware's generator on a test manifest of just those entries (tools/someip_manifest_check.js),
# so we know which can go in app.json without failing the install.
# Writes only to /tmp/wheel_heat_check on the car and removes it after. Installs nothing.
set -euo pipefail

CAR="${1:?usage: $(basename "$0") root@\$CAR_IP}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="/tmp/wheel_heat_check"
LOCAL="$(mktemp -d)"
trap 'rm -rf "$LOCAL"' EXIT

cat > "$LOCAL/manifest.json" <<'EOF'
{
  "proxies": {
    "de.bmw.body.steeringwheelcomfort.SteeringWheelClimate": {
      "instances": "1",
      "attributes": {
        "heatingState": "rs"
      }
    },
    "de.bmw.infotainment.climate.Climate": {
      "instances": "1",
      "attributes": {
        "statusSeatAutoClimateDR": "rs",
        "statusAURAPerso": "s",
        "statusAURAPerso2": "s"
      }
    }
  },
  "services": {}
}
EOF

cat > "$LOCAL/lookup.js" <<'EOF'
'use strict';
const db = JSON.parse(require('fs').readFileSync('/etc/oap/someip/someip-interfaces.json', 'utf8'));
const want = {
    'de.bmw.body.steeringwheelcomfort.SteeringWheelClimate': ['heatingState'],
    'de.bmw.infotainment.climate.Climate': ['statusSeatAutoClimateDR', 'statusAURAPerso', 'statusAURAPerso2'],
};
Object.keys(want).forEach((name) => {
    const i = db.interfaces && db.interfaces[name];
    if (!i) { console.log('MISSING interface ' + name); return; }
    console.log('interface ' + name + ' serviceId ' + i.serviceId + ' version ' + JSON.stringify(i.version));
    want[name].forEach((f) => {
        const x = i.fields && i.fields[f];
        if (!x) { console.log('  MISSING ' + f); return; }
        console.log('  ' + f + ' ' + x.dataRef + (x.getter ? ' getter' : ' NO getter') + (x.notifier ? ' notifier' : ' NO notifier'));
        const t = db.datatypes && db.datatypes[x.dataRef];
        if (t && t.members) console.log('    members: ' + t.members.map((m) => m.name).join(' '));
    });
});
EOF

ssh "$CAR" "rm -rf $TMP && mkdir -p $TMP"
scp -q "$LOCAL/manifest.json" "$LOCAL/lookup.js" "$ROOT/tools/someip_manifest_check.js" "$ROOT/kit/tools/oapgen/gen.js" "$CAR:$TMP/"

echo "== step 1: car catalog"
ssh "$CAR" "cd $TMP && node lookup.js" || true

echo
echo "== step 2: firmware generator"
ssh "$CAR" "cd $TMP && node someip_manifest_check.js manifest.json" || true

ssh "$CAR" "rm -rf $TMP"
