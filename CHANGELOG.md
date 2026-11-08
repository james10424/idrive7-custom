# Changelog

Newest first. Dates are when the build was pushed.

## Nov 7 2026

- **Custom HUD 0.1.1:** the car ahead shows in every mode while one is measured (cruise + nav: the gap only): its gap (m / ft) and its speed against ours (km/h / mph, minus = closing). An X3 sends only GapVehicleDrivingAhead, so the gap comes from that while it says a car is measured, and the relative speed from how fast the gap changes. The car-ahead log line is written only when the values change (the car repeats the same one every second). With cluster-render from james10424/idrive-apps-lib the HUD gives way to BMW's guidance for the whole route.
- **Custom HUD 0.1.0, Custom Cluster 0.1.0:** forked from bimmer-lab/apps (HUD Widgets 0.5.3, Cluster Themes 0.8.2) under new ids, so they install next to the originals. The HUD makes room for BMW's own content: it reads route guidance and the ACC display and switches between normal, cruise, nav and cruise + nav layouts (Daily has all four), and shows the gap and closing speed to the car ahead in cruise (raw until calibrated on the car). The cluster's Sport theme hides its own speed while the map window is open, so BMW's shows alone. The bench draws BMW's speed, speed-limit sign, ACC block and guidance, with GUIDING and ACC switches.
