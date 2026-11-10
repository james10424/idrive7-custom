"use strict";
/**
 * Text tokens: {{token}} -> display text, for text widgets (_resolve, _token).
 *
 * Text tokens: {{speed}} (floored, as BMW's speedometer) {{u:speed}} {{oil}} {{coolant}} {{boost}} {{u:boost}} {{rpm}}
 * {{gear}} (P / R / N, D3 / S3 / M3 by the shifter programme, or just 3 when the selector position is unknown), {{gearnum}} (3, or P / R / N)
 * {{spd:<i>}} (speed scale label i of SPEED_SCALE: 0..200 mph, 0..320 km/h) {{range}} {{u:distLc}} (mi, km) {{ambient}} (outside, signed: +75) {{u:speedLc}} (mph, km/h) {{ampmLc}} (am, pm) {{torque}} {{u:torque}} (lb-ft, Nm) {{torquePct}} {{powerPct}} (% of config.engine's peak) {{boostHi}} {{boostMid}}
 * (gauge labels for 1.4 / 0.7 bar in the display unit) {{stage}} (P R N, D / S / M by the shifter programme) {{gearInD}} (gear number while in D) {{mode}} (COMFORT, SPORT, SPORT PLUS, SPORT INDIVIDUAL, ECO PRO, ...)
 * {{temp:<deg C>}} (that temperature in the display unit, °F rounded to 10, for gauge labels) {{setup:engine|chassis|steering|gearbox}} (what that part is set to in the drive mode now)
 * {{consumption}} {{u:cons}}: average consumption for the period picked on the center screen, in the units setting's unit (mpg or
 * l/100km, converted from the car's own; ResetLogic averageConsumption, scale / 10^digit, else bcDataAll's raw * config.consumption.factor 0.1).
 * {{fuelFull}} {{fuelHalf}} (the tank's full and half marks, config.tankLitres, in L or US gal) {{u:fuel}} (L / gal)
 * {{time}} {{ampm}} {{u:temp}} (°F / °C) {{gLat}} {{gLong}} (g, 2 decimals) {{signal:<car.data() key>}} (raw, 1 decimal).
 * The car ahead (de.bmw.dass.GapVehicleAhead; "--" without a car measured or data older than 3 s): {{accGap}} the gap in m / ft
 * ({{u:gap}}), from GapVehicleDrivingAhead gapVehicleDrivingAhead while its status says a car is measured (an X3 sends only
 * this one, once a second, 253 with nothing measured; DataFrontVehicle frontVehicleGapX when the car sends that), {{accRel}}
 * its speed against ours in km/h / mph ({{u:rel}}, minus = closing; "--" while we stand still): DataFrontVehicle frontVehicleSpeedX when sent,
 * else the gap's rate of change, smoothed. {{accSet}} the set speed BMW's HUD shows (DisplayDataServer cruiseCtrlSpeedHUD).
 * Regal: {{mph}} (mph whatever the units, unused by the layout), {{odometer}} (6 digits, km / mi; MileageSupreme), {{range4}} (4 digits), {{range3}} (up to 999, no leading zeros), {{u:distUc}} (MI, KM), {{u:consUc}} (L/100KM, MPG), {{ambientN}} (outside, no + sign),
 * {{lampBrake}} (PARK BRAKE / AUTO HOLD) {{lampTurnL}} {{lampTurnR}} {{lampCruise}} (the lamp's text while lit, else empty; config.lamps).
 * The route while guiding (Guidance finalDestinationInfo / travelledDistance, apps with "navLayout"; "--" else): {{navLeft}} the
 * distance left as BMW formats it, {{u:navLeft}} its unit (km, mi, m, ft), {{navTime}} the time left h:mm.
 * {{musicTitle}}: the song title BMW's player shows (app.json config.music; HmiMediaState playerMetadata, the line typed TITLE),
 * empty when nothing plays. A text widget with "font": "@sys" draws in the car's own font (any script, sysfont.js), "size" px.
 * The catalog gives no units: app.json config.acc { gap (raw -> m), rel (raw -> km/h), set } is raw * factor + offset
 * (factor 1, offset 0 until calibrated on the car). A text widget's "needs": "<token>" draws nothing while that token is "--".
 * Pedals and 12 V (app.json config.pedals, the interfaces also in its "signals"): {{throttle}} %: with config.pedal.source "obd"
 * OBD PID 0x49 from the engine unit (config.dme.pedal, every 250 ms while shown; config.pedal.obdRange [at rest, flat out] maps
 * it to 0..100), else powertrain.AcceleratorPedal actualValueAngleAcceleratorPedal * config.pedal.factor (0.025) while its
 * qualifier says valid (on an X3 that value jumped about during a slow press, Nov 7 2026: its high byte looks like the
 * message's alive counter, so the message seems misdecoded), {{volt12}} the
 * 12 V system in V (OBD PID 0x42 from the engine unit, config.dme.volt, asked every 2 s while a shown widget uses it);
 * {{batt12}} the 12 V battery's charge, % (vehicle.CDS statusBattery2 conditionBatteryChargingCondition * config.battery.factor, 1
 * by default, 255 = none; logged raw on change to check the scaling).
 * segbar signals "throttle10" (0..10) and "brake10": while the brake lights are on (body.Light controlFunctionBrakeLight, all
 * the car gives of the brake), how hard the car slows on a log scale, 10 * ln(1 + a / 0.05 g) / ln(1 + 1 g / 0.05 g) (0.1 g
 * about 4, 0.3 g 6, 0.6 g 8, 1 g 10), at least 1; 10 without a deceleration reading.
 * Redline (shift_score.js): {{rpm10}} (rpm to 10) {{shiftAt}} {{lastShift}} {{lastGears}} (4 > 5)
 * {{verdict}} {{shiftPrompt}} (SHIFT at the shift point) {{coldNote}} (only while the oil is cold).
 * Units follow the "units" setting: us = mph, °F, psi; metric = km/h, °C, bar.
 *
 * Methods of HudApp (engine/app.js adds them to its prototype).
 */
const { ROUTE_UNIT } = require("./consts");
const { SPEED_SCALE } = require("./scales");
const { isNum, pad2 } = require("../engine/util");

module.exports = /** @satisfies {ThisType<import("../engine/app").App>} */ ({
  /** Local time: config.utcOffsetMinutes when set, else the car's time zone once the cluster's clock has been seen, else
   *  the unit's own (UTC on the car).
   * @returns {{ getHours: () => number, getMinutes: () => number }}
   */
  _now() {
    const cfg = this.config.utcOffsetMinutes;
    const off = isNum(cfg) ? cfg : this.carOffsetMin;
    if (!isNum(off)) return new Date();
    const d = new Date(Date.now() + off * 60000);
    return {
      getHours: () => d.getUTCHours(),
      getMinutes: () => d.getUTCMinutes(),
    };
  },

  /**
   * A text template with its {{tokens}} filled in.
   * @param {*} template
   * @returns {string}
   */
  _resolve(template) {
    return String(template).replace(/\{\{([a-zA-Z0-9:]+)\}\}/g, (_, t) =>
      this._token(t),
    );
  },

  /**
   * {{tok}} as display text (the tokens are in the header).
   * @param {string} tok
   * @returns {string}
   */
  _token(tok) {
    const us = this.setting("units") === "us";
    /** @type {(v: *, n: number) => string} */
    const fix = (v, n) => (isNum(v) ? v.toFixed(n) : "--");
    if (tok.indexOf("tyreP:") === 0) {
      const v = this._tyre("p", tok.slice(6));
      return isNum(v) ? (us ? fix(v * 14.5038, 0) : fix(v, 1)) : "--";
    }
    if (tok.indexOf("tyreT:") === 0) {
      const v = this._tyre("t", tok.slice(6));
      return isNum(v) ? String(Math.round(us ? (v * 9) / 5 + 32 : v)) : "--";
    }
    switch (tok) {
      case "u:pressure":
        return us ? "psi" : "bar";
      case "throttle": {
        const v = this._throttle();
        return isNum(v) ? String(Math.round(v)) : "--";
      }
      case "musicTitle":
        return this.musicTitle || "";
      // the Regal theme's lamps: their text while lit, else nothing
      case "lampBrake": {
        const l = this._brakeLamp();
        return l === "park" ? "PARK BRAKE" : l === "hold" ? "AUTO HOLD" : "";
      }
      case "lampTurnL":
        return this._turnLit("L") ? "LT. TURN" : "";
      case "lampTurnR":
        return this._turnLit("R") ? "RT. TURN" : "";
      case "lampCruise":
        return this._cruiseLit() ? "CRUISE" : "";
      case "odometer": {
        // 6 digits, km or mi by the units setting
        const v = this._odometer();
        return isNum(v)
          ? ("000000" + Math.floor(us ? v * 0.621371 : v)).slice(-6)
          : "------";
      }
      case "range3": {
        const v = this._raw("range");
        return isNum(v)
          ? String(
              Math.min(999, Math.max(0, Math.round(us ? v * 0.621371 : v))),
            )
          : "---";
      } // up to 3 digits, no leading zeros, 999 past it (Regal's pod)
      case "range4": {
        const v = this._raw("range");
        return isNum(v)
          ? ("0000" + Math.round(us ? v * 0.621371 : v)).slice(-4)
          : "----";
      }
      case "u:distUc":
        return us ? "MI" : "KM";
      // the route (while guiding; "--" else): distance left as BMW formats it, its unit, time left h:mm
      case "navLeft": {
        const r = this.route;
        return this.navActive && r && r.leftText ? r.leftText : "--";
      }
      case "u:navLeft": {
        const r = this.route;
        return this.navActive && r ? ROUTE_UNIT[r.leftUnit] || "" : "";
      }
      case "navTime": {
        const r = this.route;
        if (!this.navActive || !r || !isNum(r.timeLeft)) return "--";
        const m = Math.round(r.timeLeft / 60);
        return Math.floor(m / 60) + ":" + ("0" + (m % 60)).slice(-2);
      }
      case "consumption": {
        const v = this._consumption();
        return isNum(v) ? v.toFixed(1) : "--";
      }
      case "u:cons":
        return this._consUnit();
      case "u:consUc":
        return this._consUnit().toUpperCase();
      case "ambientN": {
        const v = this._raw("ambient");
        return isNum(v) ? String(Math.round(us ? (v * 9) / 5 + 32 : v)) : "--";
      } // no + sign (the seven-segment font has none)
      case "volt12": {
        const v = this._volt12();
        return isNum(v) ? v.toFixed(1) : "--";
      }
      case "batt12": {
        const v = this._batt12();
        return isNum(v) ? String(Math.round(v)) : "--";
      }
      case "accGap": {
        const v = this._acc("gap");
        return isNum(v) ? String(Math.round(us ? v * 3.28084 : v)) : "--";
      }
      case "u:gap":
        return us ? "FT" : "M";
      case "accRel": {
        const v = this._acc("rel");
        return isNum(v) ? String(Math.round(us ? v * 0.621371 : v)) : "--";
      } // the HUD fonts have no '+'
      case "u:rel":
        return us ? "MPH" : "KM/H";
      case "accSet": {
        const v = this._acc("set");
        return isNum(v) ? String(Math.round(v)) : "--";
      }
      // speed digits floor as BMW's own do (rounding read 1 higher from x.5 up): whole km/h or mph passed
      case "speed": {
        const v = this._raw("speed");
        return isNum(v)
          ? String(Math.floor(Math.max(0, us ? v * 0.621371 : v)))
          : "--";
      }
      case "u:speed":
        return us ? "MPH" : "KM/H";
      case "mph": {
        const v = this._raw("speed");
        return isNum(v) ? String(Math.floor(Math.max(0, v) * 0.621371)) : "--";
      } // mph whatever the units (Regal), floored as above
      case "oil":
      case "coolant": {
        const v = this._raw(tok);
        return fix(isNum(v) ? (us ? (v * 9) / 5 + 32 : v) : v, 0);
      }
      case "boost": {
        const v = this._raw("boost");
        return us ? fix(isNum(v) ? v * 14.5038 : v, 1) : fix(v, 2);
      }
      case "u:boost":
        return us ? "PSI" : "BAR";
      case "u:temp":
        return us ? "°F" : "°C";
      // the fuel gauge's marks: the tank (config.tankLitres) full and half, in litres or US gallons, whole numbers
      case "fuelFull":
      case "fuelHalf": {
        const t = (this.config.tankLitres || 65) * (us ? 1 / 3.78541 : 1);
        return String(Math.round(tok === "fuelFull" ? t : t / 2));
      }
      case "u:fuel":
        return us ? "gal" : "L";
      case "u:speedLc":
        return us ? "mph" : "km/h";
      case "u:distLc":
        return us ? "mi" : "km";
      case "range": {
        const v = this._raw("range");
        return fix(isNum(v) ? (us ? v * 0.621371 : v) : v, 0);
      }
      case "ambient": {
        const v = this._raw("ambient");
        if (!isNum(v)) return "--";
        const n = Math.round(us ? (v * 9) / 5 + 32 : v);
        return (n > 0 ? "+" : "") + n;
      }
      case "u:torque":
        return us ? "lb-ft" : "Nm";
      case "torque": {
        const v = this._raw("torque");
        return fix(isNum(v) ? (us ? v * 0.737562 : v) : v, 0);
      }
      case "torquePct":
      case "powerPct": {
        const v = this._raw(tok);
        return isNum(v) ? String(Math.min(100, Math.round(v))) : "--";
      }
      case "boostHi":
        return us ? "20" : "1.4";
      case "boostMid":
        return us ? "10" : "0.7";
      case "ampmLc":
        return this._token("ampm").toLowerCase();
      case "gLat":
      case "gLong": {
        const v = this._raw(tok);
        return isNum(v) ? Math.abs(v).toFixed(2) : "--";
      }
      case "rpm":
      case "rpm10":
        return isNum(this.rpmShown)
          ? String(this.rpmShown)
          : tok === "rpm"
            ? "--"
            : "----";
      case "shiftAt":
        return String(this._shift().rpm);
      case "lastShift":
        return this.score.last ? String(this.score.last.rpm) : "--";
      case "lastGears": {
        const l = this.score.last;
        return l && l.from !== "?" ? l.from + " > " + l.to : "";
      }
      case "verdict":
        return this.score.last ? this.score.last.verdict : "";
      case "shiftPrompt":
        return this._shift().now ? "SHIFT" : "";
      case "coldNote": {
        const sp = this._shift();
        if (!sp.oilCold) return "";
        return sp.cold ? "COLD · LIMIT " + sp.rpm : "OIL COLD · GO EASY";
      }
      case "gearnum": {
        const d = this.car.data();
        if (d.stage === "P" || d.stage === "R" || d.stage === "N")
          return d.stage;
        return isNum(d.gear) && d.gear > 0
          ? String(d.gear)
          : d.gear === 0
            ? "N"
            : "-";
      }
      case "stage": {
        // the selector letter alone: P R N, or D / S / M by the shifter programme
        const d = this.car.data();
        return d.stage === "D" || (!d.stage && isNum(d.gear) && d.gear > 0)
          ? this._program(d)
          : d.stage || "-";
      }
      case "gearInD": {
        // the gear number while driving, else nothing (the M "2D")
        const d = this.car.data();
        return (d.stage === "D" || (!d.stage && isNum(d.gear))) &&
          isNum(d.gear) &&
          d.gear > 0
          ? String(d.gear)
          : "";
      }
      case "mode": {
        if (!this.driveMode) return "";
        const base =
          this.driveMode === "sport"
            ? "SPORT"
            : this.driveMode === "eco"
              ? "ECO PRO"
              : "COMFORT";
        return (
          base +
          (this.driveVariant === "plus"
            ? " PLUS"
            : this.driveVariant === "individual"
              ? " INDIVIDUAL"
              : "")
        );
      }
      case "gear": {
        const d = this.car.data();
        if (d.stage === "P" || d.stage === "R" || d.stage === "N")
          return d.stage;
        const g = isNum(d.gear) && d.gear > 0 ? String(d.gear) : "";
        return d.stage === "D" ? this._program(d) + g : g;
      }
      case "time":
      case "ampm": {
        const now = this._now();
        const h = now.getHours(),
          m = now.getMinutes();
        if (tok === "ampm")
          return this.setting("clock") === "12h" ? (h < 12 ? "AM" : "PM") : "";
        if (this.setting("clock") === "24h") return pad2(h) + ":" + pad2(m);
        return (h % 12 || 12) + ":" + pad2(m);
      }
      default:
        if (tok.indexOf("spd:") === 0) {
          const v = SPEED_SCALE[us ? "us" : "metric"][Number(tok.slice(4))];
          return v === undefined ? "" : String(v);
        } // speed scale labels
        if (tok.indexOf("temp:") === 0) {
          const c = Number(tok.slice(5));
          return isNum(c)
            ? String(
                us ? Math.round(((c * 9) / 5 + 32) / 10) * 10 : Math.round(c),
              )
            : "--";
        } // gauge labels: °F to the 10
        if (tok.indexOf("setup:") === 0) {
          const s = this._setup();
          return s ? s[tok.slice(6)] || "" : "--";
        }
        if (tok.indexOf("signal:") === 0) {
          const v = this._raw(tok.slice(7));
          return isNum(v) ? (Math.round(v * 10) / 10).toString() : "--";
        }
        return "{{" + tok + "}}";
    }
  },
});
