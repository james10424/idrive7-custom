"use strict";
/**
 * Sunrise / sunset for the Auto theme, from date and location alone (no car
 * signal needed). NOAA's solar position equations, worked in UTC epoch time, so
 * the head unit's time zone setting doesn't matter, only that its clock is right.
 *
 *   sunTimes(dateMs, lat, lon) -> { sunrise, sunset } (epoch ms) or null (polar day/night)
 *   isNight(nowMs, lat, lon)   -> true between sunset and the next sunrise
 */
const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const UNIX_EPOCH_JD = 2440587.5; // the Julian day of 1970-01-01 0h UTC
const J2000_JD = 2451545; // the Julian day of the J2000 epoch
const JULIAN_CENTURY_DAYS = 36525;
const SUNRISE_ZENITH_DEG = 90.833; // the sun's centre at sunrise / sunset: refraction and the disc's radius
const NOON_UTC_MIN = 720; // 12:00 in minutes after 0h UTC
const MIN_PER_DEG = 4; // the earth turns 1 degree of longitude in 4 minutes

/**
 * @param {number} dateMs any time on the UTC date, epoch ms
 * @param {number} lat degrees
 * @param {number} lon degrees, east positive
 * @returns {{ sunrise: number, sunset: number } | null} epoch ms; null in polar day or night
 */
function sunTimes(dateMs, lat, lon) {
  // Julian day at 0h UTC of this UTC date
  const date = new Date(dateMs);
  const day0 = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  );
  // solar noon is roughly 12:00 local solar time: start near it for the equations
  const julianDay = day0 / DAY_MS + UNIX_EPOCH_JD + 0.5 - lon / 360;
  const T = (julianDay - J2000_JD) / JULIAN_CENTURY_DAYS;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C =
    Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * M * RAD) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 =
    23 +
    (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) / RAD;
  const y = Math.pow(Math.tan((eps / 2) * RAD), 2);
  const eqTime =
    (4 / RAD) *
    (y * Math.sin(2 * L0 * RAD) -
      2 * e * Math.sin(M * RAD) +
      4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) -
      0.5 * y * y * Math.sin(4 * L0 * RAD) -
      1.25 * e * e * Math.sin(2 * M * RAD)); // minutes
  const cosH =
    (Math.cos(SUNRISE_ZENITH_DEG * RAD) - Math.sin(lat * RAD) * Math.sin(decl * RAD)) /
    (Math.cos(lat * RAD) * Math.cos(decl * RAD));
  if (cosH > 1 || cosH < -1) return null;
  const hourAngle = Math.acos(cosH) / RAD; // degrees
  const noonMin = NOON_UTC_MIN - MIN_PER_DEG * lon - eqTime; // minutes after 0h UTC
  return {
    sunrise: day0 + (noonMin - MIN_PER_DEG * hourAngle) * 60000,
    sunset: day0 + (noonMin + MIN_PER_DEG * hourAngle) * 60000,
  };
}

/**
 * @param {number} nowMs epoch ms
 * @param {number} lat degrees
 * @param {number} lon degrees, east positive
 * @returns {boolean} true between sunset and the next sunrise
 */
function isNight(nowMs, lat, lon) {
  // the local solar day can straddle the UTC date line: check yesterday, today and tomorrow
  for (const dayOffset of [-1, 0, 1]) {
    const times = sunTimes(nowMs + dayOffset * DAY_MS, lat, lon);
    if (!times) continue;
    if (nowMs >= times.sunrise && nowMs < times.sunset) return false;
  }
  return true;
}

module.exports = { sunTimes, isNight };
