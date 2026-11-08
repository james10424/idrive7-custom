<h1 align="center">idrive7-custom</h1>

<p align="center">Apps for BMW iDrive 7 head units (MGU), installed through the community MGU Store. A reworked fork of [bimmer-lab/apps](https://github.com/bimmer-lab/apps) whose apps install next to the originals: they have their own ids (`custom_hud`, `custom_cluster`).</p>

## Custom Cluster

Redraws the whole instrument cluster as a 1987 Buick Regal dash, and switches to a Sport view round BMW's map while route guidance is on. [Read more](apps/custom_cluster/README.md)

<p align="center"><img src="docs/images/cluster-sport.png" width="900" alt="Sport theme"></p>

## Custom HUD

Puts your own readouts on the windshield HUD: speed, gear, a shift bar, boost, oil and coolant, or your own Live2D character standing in the corner of the HUD. Three layouts, each in Classic, M and Night colours. It makes room for BMW's own HUD content: the layout moves aside while route guidance or the ACC display is up, and shows the gap to the car ahead in cruise. [Read more](apps/custom_hud/README.md)

<p align="center"><img src="docs/images/hud-daily.png" width="520" alt="Daily layout on the HUD"></p>

<table align="center">
  <tr>
    <th align="center">Daily</th>
    <th align="center">Sport</th>
  </tr>
  <tr>
    <td><img src="docs/images/hud-daily.png" width="300" alt="Daily layout"></td>
    <td><img src="docs/images/hud-sport.png" width="300" alt="Sport layout"></td>
  </tr>
</table>

## Install

1. Install **cluster-render** first. Both apps draw through it. It comes from the `robertnisipeanu/idrive-apps` Store source. To run both apps at once you need 0.4.5 or later, which for now is only in the `james10424/idrive-apps-lib` source (see [Both apps at once](#both-apps-at-once)).
2. In the Store, go to **Settings, Add source**, enter **`james10424/idrive7-custom`**, and install the apps you want.
3. Open the app from the apps menu on the center screen to pick a theme or layout.

The Store builds each app on the car from this repo. No BMW code is in it. Both apps are tested on a 2020 X3 M40i; each app's page says what has been checked on the car and what is still open. Version history is in [CHANGELOG.md](CHANGELOG.md).

## Both apps at once

By default cluster-render gives the HUD and the cluster panel the same scene id (0x01000400), so only one can show at a time: whichever asks first keeps it, and the other waits ("waiting: the cluster layout has the scene the HUD shares" on Custom HUD's page). One setting gives the HUD its own scene id so Custom HUD and Custom Cluster show together (verified on a 2020 M340i, Nov 8 2026). It needs cluster-render 0.4.5 or later.

1. Over SSH as root, add the line to cluster-render's local conf (updates keep this file) and restart it:

   ```bash
   ssh root@<car> 'echo "hud_scene_id = 0x010004f0" >> /var/opt/cluster-render/cluster-render.local.conf && systemctl restart cluster-render'
   ```

2. Check it took:

   ```bash
   ssh root@<car> 'grep "its own scene id" /var/opt/cluster-render/log/cluster-render.log | tail -1'
   ```

   It should print `target hud: its own scene id 0x10004f0, ...`.

The HUD then shares its scene id with cluster-render's `map` target instead (the Waze map on the cluster), so those two take turns. To undo, delete the line and restart cluster-render.

## Credits

- [bimmer-lab/apps](https://github.com/bimmer-lab/apps) (MIT): the original HUD Widgets and Cluster Themes this repo starts from.
- [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps): the MGU App Kit (MIT) these apps are built on, and the Redline app the shift scoring comes from.
- [robertnisipeanu/idrive-apps](https://github.com/robertnisipeanu/idrive-apps): cluster-render, which draws on the HUD and the cluster.
- Barlow and Michroma typefaces (SIL Open Font License).

## Licence

MIT. Third-party parts are listed in each app's `NOTICE`. To work on the apps, see [docs/DEVELOPING.md](docs/DEVELOPING.md).
