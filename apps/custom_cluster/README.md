# Custom Cluster

Redraws the whole instrument cluster: a 1987 Buick Regal dash, switching to a Sport view round BMW's map while you navigate. Open **Custom Cluster** from the apps menu on the center screen to change it.

## Themes

### Sport

The look of BMW's newer Live Cockpit Sport view.

- **Left:** speed as a blue bracket on BMW's 0 to 200 mph scale (0 to 320 km/h), with the digital speed and a fuel bar inside it.
- **Right:** revs as a red bracket on the M40i's 0 to 7000 rpm scale, with yellow and red marks around your redline, with the gear and an oil temperature bar inside it.
- **Middle:** BMW's map while navigating (or with "Leave room for the map" on), else black.
- **Bottom:** boost and coolant in the blue and red strip, plus the clock, range and outside temperature.
- **While navigating:** the strip becomes the route's progress, filling from the right, with the distance left and the time left at its ends.

<p align="center"><img src="../../docs/images/cluster-sport.png" width="900" alt="Sport theme"></p>

### Regal (1987)

The look of a 1987 Buick Regal's dash: chrome frames, white numbers, pink needles and an orange VFD.

- **Left pod:** a 12 V voltmeter (8 to 16 V), with the BRAKE lamp and the left turn arrow under it.
- **Right pod:** coolant temperature, with the right turn arrow and CRUISE (lit while ACC is on).
- **Middle, top:** a needle over a straight row of mph numbers, 5 to 85, with 55 in amber at the centre. The orange windows show the speed (mph or km/h by the units setting), the odometer and P R N D with the gear number on the left, and the clock and range on the right.
- **Middle, bottom:** the fuel needle and an LED rev bar that turns yellow from your shift point.
- **Bottom:** the song title. There is no map window.

More themes are on the way.

## Navigation and Off

- **While navigating:** while BMW's route guidance is on, the cluster switches to this theme (Sport by default, with the map window open), and back to your theme when the route ends.
- **Off (BMW's own cluster):** pick it as the theme and the app draws nothing, so BMW's cluster comes back.
- **With Custom HUD:** the cluster theme and the HUD cannot show at the same time, because cluster-render has one screen slot for both. While a cluster theme shows, the HUD stays off.

## Settings

- **Theme:** Regal or Sport (or Off).
- **While navigating:** Sport with the map, Regal, Off, or no change.
- **Leave room for the map:** keeps Sport's map window open even when not navigating. Regal has no map window.
- **Units:** mph, °F, psi or km/h, °C, bar.
- **Clock:** 12-hour or 24-hour.
- **Redline:** where the red marks start on the rev scales (they always cover at least the last 500 rpm, and the yellow marks sit in the 700 rpm before them).
- **Shift point before redline:** how far below the redline the shift lights peak (300 rpm by default).
- **Cold-engine rev guard:** until the oil reaches 80°C, the shift point starts at 4500 rpm and climbs as the oil warms up.
- **Show boost.**
- **Demo data:** fake driving data for trying it out parked.
- **Calibration grid:** a theme that draws lines every 50 px with labels, for checking on a photo where things land on the real screen. It also carries a few test marks used to measure cluster-render's limits on the car.

**Shift grades:** every upshift is graded on its peak rpm. EARLY means more than 250 rpm under the shift point, LATE more than 200 over it, COLD REV the same while the cold guard is on, LIMITER within 60 rpm of the redline, and anything in between is SPOT ON.

## Requirements

[cluster-render](https://github.com/robertnisipeanu/idrive-apps), installed from the `robertnisipeanu/idrive-apps` Store source.

## On the car

Tested on a 2020 M340i. The car draws at most 8 layers per connection, and every theme fits in that. Still to be checked:

- whether Sport and Regal draw complete (if not, the first row of the app's page says how many parts are drawn and why the rest are not);
- whether BMW's warning lights still show over the dash (start the car with a seat belt off and look);
- the switch to Sport when route guidance starts, and the map window's position;
- how the colours and edges look on the real screen.

Version history is in the repo's [CHANGELOG.md](../../CHANGELOG.md).
