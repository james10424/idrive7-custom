<h1 align="center">idrive7-custom</h1>

<p align="center">Apps for BMW iDrive 7 head units (MGU), installed through the community MGU Store. A reworked fork of [bimmer-lab/apps](https://github.com/bimmer-lab/apps) whose apps install next to the originals: they have their own ids (`custom_hud`, `custom_cluster`).</p>

<p align="center"><img src="docs/images/cluster-gt3.gif" width="900" alt="GT3 race dash on the instrument cluster"></p>

## Custom Cluster

Redraws the whole instrument cluster in a theme of your choice: a GT3 race dash, an M-style cluster, or a Sport view. Pick the theme on the center screen, or let it follow the SPORT / COMFORT / ECO PRO buttons. [Read more](apps/custom_cluster/README.md)

<p align="center"><img src="docs/images/cluster-gt3-shift.png" width="900" alt="GT3 theme at the shift point"></p>
<p align="center"><img src="docs/images/cluster-m.png" width="900" alt="M theme"></p>
<p align="center"><img src="docs/images/cluster-sport.png" width="900" alt="Sport theme"></p>

## Custom HUD

Puts your own readouts on the windshield HUD: speed, gear, shift lights, boost, oil and coolant. Three layouts, each in Classic, M and Night colours. It makes room for BMW's own HUD content: the layout moves aside while route guidance or the ACC display is up, and shows the gap to the car ahead in cruise. [Read more](apps/custom_hud/README.md)

<p align="center"><img src="docs/images/hud-redline.gif" width="520" alt="Redline layout on the HUD"></p>

<table align="center">
  <tr>
    <th align="center">Daily</th>
    <th align="center">Sport</th>
    <th align="center">Redline</th>
  </tr>
  <tr>
    <td><img src="docs/images/hud-daily.png" width="300" alt="Daily layout"></td>
    <td><img src="docs/images/hud-sport.png" width="300" alt="Sport layout"></td>
    <td><img src="docs/images/hud-redline.png" width="300" alt="Redline layout at the shift point"></td>
  </tr>
</table>

## Install

1. Install **cluster-render** first. Both apps draw through it. It comes from the `robertnisipeanu/idrive-apps` Store source.
2. In the Store, go to **Settings, Add source**, enter **`james10424/idrive7-custom`**, and install the apps you want.
3. Open the app from the apps menu on the center screen to pick a theme or layout.

The Store builds each app on the car from this repo. No BMW code is in it. Both apps are tested on a 2020 X3 M40i; each app's page says what has been checked on the car and what is still open. Version history is in [CHANGELOG.md](CHANGELOG.md).

## Credits

- [bimmer-lab/apps](https://github.com/bimmer-lab/apps) (MIT): the original HUD Widgets and Cluster Themes this repo starts from.
- [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps): the MGU App Kit (MIT) these apps are built on, and the Redline app the shift scoring comes from.
- [robertnisipeanu/idrive-apps](https://github.com/robertnisipeanu/idrive-apps): cluster-render, which draws on the HUD and the cluster.
- Barlow, Michroma and Orbitron typefaces (SIL Open Font License).

## Licence

MIT. Third-party parts are listed in each app's `NOTICE`. To work on the apps, see [docs/DEVELOPING.md](docs/DEVELOPING.md).
