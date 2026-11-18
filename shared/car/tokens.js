"use strict";
/**
 * Text tokens: {{token}} -> display text, for text widgets (_resolve, _token).
 *
 * Text tokens: {{speed}} (floored, as BMW's speedometer) {{u:speed}} {{oil}} {{coolant}} {{boost}} {{u:boost}} {{rpm}}
 * {{gear}} (P / R / N, D3 / S3 / M3 by the shifter programme, or just 3 when the selector position is unknown), {{gearnum}} (3, or P / R / N)
 * {{spd:<i>}} (speed scale label i of SPEED_SCALE: 0..200 mph, 0..320 km/h) {{range}} {{u:distLc}} (mi, km) {{ambient}} (outside, signed: +75) {{u:speedLc}} (mph, km/h) {{ampmLc}} (am, pm) {{torque}} {{u:torque}} (lb-ft, Nm) {{torquePct}} {{powerPct}} (% of config.engine's peak) {{boostHi}} {{boostMid}}
 * (gauge labels for 1.4 / 0.7 bar in the display unit) {{stage}} (P R N, D / S / M by the shifter programme) {{gearInD}} (gear number while in D, else -) {{mode}} (COMFORT, SPORT, SPORT PLUS, SPORT INDIVIDUAL, ECO PRO, ...)
 * {{temp:<deg C>}} (that temperature in the display unit, °F rounded to 10, for gauge labels) {{boostTick:0|m1|m2|u1|u2|u3|end}} (Grand National's boost scale labels: 0 .. 1.5 bar in thirds, or 0 .. 20 psi in quarters; the other unit's slots empty) {{setup:engine|chassis|steering|gearbox}} (what that part is set to in the drive mode now)
 * {{consumption}} {{u:cons}}: average consumption for the period picked on the center screen, in the units setting's unit (mpg or
 * l/100km, converted from the car's own; ResetLogic averageConsumption, scale / 10^digit, else bcDataAll's raw * config.consumption.factor 0.1).
 * {{fuelFull}} {{fuelHalf}} (the tank's full and half marks, the Fuel tank setting or the car's model's, in L or US gal) {{u:fuel}} (L / gal)
 * {{time}} {{ampm}} {{u:temp}} (°F / °C) {{gLat}} {{gLong}} (g, 2 decimals) {{signal:<car.data() key>}} (raw, 1 decimal).
 * The car ahead (de.bmw.dass.GapVehicleAhead; "--" without a car measured or data older than 3 s): {{accGap}} the gap in m / ft
 * ({{u:gap}}), from GapVehicleDrivingAhead gapVehicleDrivingAhead while its status says a car is measured (an X3 sends only
 * this one, once a second, 253 with nothing measured; DataFrontVehicle frontVehicleGapX when the car sends that), {{accRel}}
 * its speed against ours in km/h / mph ({{u:rel}}, minus = closing; "--" while we stand still): DataFrontVehicle frontVehicleSpeedX when sent,
 * else the gap's rate of change, smoothed. {{accSet}} the set speed BMW's HUD shows (DisplayDataServer cruiseCtrlSpeedHUD).
 * Grand National: {{mph}} (mph whatever the units, unused by the layout), {{odometer}} (6 digits, km / mi; MileageSupreme), {{range4}} (4 digits), {{range3}} (up to 999, no leading zeros), {{u:distUc}} (MI, KM), {{u:consUc}} (L/100KM, MPG), {{ambientN}} (outside, no + sign),
 * {{lampBrake}} (PARK BRAKE / AUTO HOLD) {{lampTurnL}} {{lampTurnR}} {{lampCruise}} {{lampHeat}} (the lamp's text while lit, else empty; config.lamps).
 * {{hvSoc}} {{eRange}} {{rangeHybrid}} ("420 + 35") {{rangeFuelOnly}} {{noHv}} {{oilOrHvUnit}} {{oilOrHv:<deg C>}} (a plug-in
 * hybrid's battery % and electric range, config.hybrid; "--" without; the oil labels as 100 / 50 / 0 % with a battery).
 * {{doorFL}} {{doorFR}} {{doorRL}} {{doorRR}} {{doorHood}} {{doorTrunk}} (FRONT LEFT ... TRUNK while that one is open, else
 * empty) {{doorAny}} (DOOR while any of the six is open; config.lamps).
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
 * Units follow the unit settings by kind (values.js _us: speed and distance, temperature, pressure, fuel), each "auto" (the car's own), us or metric; without them the "units" setting.
 *
 * Methods of HudApp (engine/app.js adds them to its prototype).
 */
const {
  FT_PER_M,
  L_PER_US_GAL,
  LBFT_PER_NM,
  MI_PER_KM,
  PSI_PER_BAR,
  ROUTE_UNIT,
} = require("./consts");
const { SPEED_SCALE } = require("./scales");
const { isNum, pad2 } = require("../engine/util");

const ODOMETER_DIGITS = 6; // {{odometer}}
const RANGE3_MAX = 999; // {{range3}}: up to 3 digits
const RANGE4_DIGITS = 4; // {{range4}}
const GAUGE_F_STEP = 10; // {{temp:<deg C>}}: °F labels round to this
const BOOST_TICK_BAR = 0.5; // {{boostTick:m<k>}}: bar per slot
const BOOST_TICK_PSI = 5; // {{boostTick:u<k>}}: psi per slot
/** @type {Record<string, string>} the oil gauge's labels (oilOrHv:<°C>) as the battery's: top, middle, bottom */
const OIL_TO_HV = { 150: "100", 110: "50", 50: "0" };

module.exports = /** @satisfies {ThisType<import("../engine/app").App>} */ ({
  /** Local time: config.utcOffsetMinutes when set, else the car's time zone once the cluster's clock has been seen, else
   *  the unit's own (UTC on the car).
   * @returns {{ getHours: () => number, getMinutes: () => number }}
   */
  _now() {
    const cfg = this.config.utcOffsetMinutes;
    const off = isNum(cfg) ? cfg : this.carOffsetMin;
    if (!isNum(off)) return new Date();
    const local = new Date(Date.now() + off * 60000);
    return {
      getHours: () => local.getUTCHours(),
      getMinutes: () => local.getUTCMinutes(),
    };
  },

  /**
   * A text template with its {{tokens}} filled in.
   * @param {unknown} template its text (anything else as String() writes it)
   * @returns {string}
   */
  _resolve(template) {
    return String(template).replace(/\{\{([a-zA-Z0-9:]+)\}\}/g, (_, name) =>
      this._token(name),
    );
  },

  /**
   * A plug-in hybrid's electric range in km, null without one: KombiIF sends it in the car's distance unit (the
   * speedometer's), else (the units not heard yet) taken as the units setting's.
   * @returns {?number}
   */
  _eRangeKm() {
    if (!isNum(this.eRangeRaw)) return null;
    const dist = this.carUnits && this.carUnits.dist;
    const miles = dist ? dist === "MEILEN" : this._us("speed");
    return miles ? this.eRangeRaw / MI_PER_KM : this.eRangeRaw;
  },

  /**
   * {{tok}} as display text (the tokens are in the header).
   * @param {string} tok
   * @returns {string}
   */
  _token(tok) {
    const usSpeed = this._us("speed"), usTemp = this._us("temp"), usPress = this._us("press"), usFuel = this._us("fuel");
    /** @type {(value: *, digits: number) => string} */
    const fix = (value, digits) =>
      isNum(value) ? value.toFixed(digits) : "--";
    if (tok.indexOf("tyreP:") === 0) {
      const bar = this._tyre("p", tok.slice(6));
      return isNum(bar)
        ? usPress
          ? fix(bar * PSI_PER_BAR, 0)
          : fix(bar, 1)
        : "--";
    }
    if (tok.indexOf("tyreT:") === 0) {
      const celsius = this._tyre("t", tok.slice(6));
      return isNum(celsius)
        ? String(Math.round(usTemp ? (celsius * 9) / 5 + 32 : celsius))
        : "--";
    }
    switch (tok) {
      case "u:pressure":
        return usPress ? "psi" : "bar";
      case "throttle": {
        const throttle = this._throttle();
        return isNum(throttle) ? String(Math.round(throttle)) : "--";
      }
      case "musicTitle":
        return this.musicTitle || "";
      // the Grand National theme's lamps: their text while lit, else nothing
      case "lampBrake": {
        const lamp = this._brakeLamp();
        return lamp === "park"
          ? "PARK BRAKE"
          : lamp === "hold"
            ? "AUTO HOLD"
            : "";
      }
      case "lampTurnL":
        return this._turnLit("L") ? "LT. TURN" : "";
      case "lampTurnR":
        return this._turnLit("R") ? "RT. TURN" : "";
      case "lampCruise":
        return this._cruiseLit() ? "CRUISE" : "";
      case "lampHeat":
        return this._heatLit() ? "HEAT STR" : "";
      // the door lamps: their name while open, else nothing; doorAny "DOOR" while any of the six is
      case "doorFL":
        return this._doorOpen("fl") ? "FRONT LEFT" : "";
      case "doorFR":
        return this._doorOpen("fr") ? "FRONT RIGHT" : "";
      case "doorRL":
        return this._doorOpen("rl") ? "REAR LEFT" : "";
      case "doorRR":
        return this._doorOpen("rr") ? "REAR RIGHT" : "";
      case "doorHood":
        return this._doorOpen("hood") ? "HOOD" : "";
      case "doorTrunk":
        return this._doorOpen("trunk") ? "TRUNK" : "";
      case "doorAny":
        return this._doorOpen("any") ? "DOOR" : "";
      case "odometer": {
        // 6 digits, km or mi by the units setting
        const km = this._odometer();
        return isNum(km)
          ? (
              "000000" + Math.floor(usSpeed ? km * MI_PER_KM : km)
            ).slice(-ODOMETER_DIGITS)
          : "------";
      }
      case "range3": {
        const range = this._raw("range");
        return isNum(range)
          ? String(
              Math.min(
                RANGE3_MAX,
                Math.max(0, Math.round(usSpeed ? range * MI_PER_KM : range)),
              ),
            )
          : "---";
      } // up to 3 digits, no leading zeros, 999 past it (Grand National's pod)
      case "range4": {
        const range = this._raw("range");
        return isNum(range)
          ? (
              "0000" + Math.round(usSpeed ? range * MI_PER_KM : range)
            ).slice(-RANGE4_DIGITS)
          : "----";
      }
      case "u:distUc":
        return usSpeed ? "MI" : "KM";
      // the route (while guiding; "--" else): distance left as BMW formats it, its unit, time left h:mm
      case "navLeft": {
        const route = this.route;
        return this.navActive && route && route.leftText
          ? route.leftText
          : "--";
      }
      case "u:navLeft": {
        const route = this.route;
        return this.navActive && route ? ROUTE_UNIT[route.leftUnit] || "" : "";
      }
      case "navTime": {
        const route = this.route;
        if (!this.navActive || !route || !isNum(route.timeLeft)) return "--";
        const minutes = Math.round(route.timeLeft / 60);
        return (
          Math.floor(minutes / 60) + ":" + ("0" + (minutes % 60)).slice(-2)
        );
      }
      case "consumption": {
        const cons = this._consumption();
        return isNum(cons) ? cons.toFixed(1) : "--";
      }
      case "u:cons":
        return this._consUnit();
      case "u:consUc":
        return this._consUnit().toUpperCase();
      case "ambientN": {
        const ambient = this._raw("ambient");
        return isNum(ambient)
          ? String(Math.round(usTemp ? (ambient * 9) / 5 + 32 : ambient))
          : "--";
      } // no + sign (the seven-segment font has none)
      case "volt12": {
        const volts = this._volt12();
        return isNum(volts) ? volts.toFixed(1) : "--";
      }
      case "batt12": {
        const charge = this._batt12();
        return isNum(charge) ? String(Math.round(charge)) : "--";
      }
      case "accGap": {
        const gap = this._acc("gap");
        return isNum(gap)
          ? String(Math.round(usSpeed ? gap * FT_PER_M : gap))
          : "--";
      }
      case "u:gap":
        return usSpeed ? "FT" : "M";
      case "accRel": {
        const rel = this._acc("rel");
        return isNum(rel)
          ? String(Math.round(usSpeed ? rel * MI_PER_KM : rel))
          : "--";
      } // the HUD fonts have no '+'
      case "u:rel":
        return usSpeed ? "MPH" : "KM/H";
      case "accSet": {
        const setSpeed = this._acc("set");
        return isNum(setSpeed) ? String(Math.round(setSpeed)) : "--";
      }
      // speed digits floor as BMW's own do (rounding read 1 higher from x.5 up): whole km/h or mph passed
      case "speed": {
        const speed = this._raw("speed");
        return isNum(speed)
          ? String(Math.floor(Math.max(0, usSpeed ? speed * MI_PER_KM : speed)))
          : "--";
      }
      case "u:speed":
        return usSpeed ? "MPH" : "KM/H";
      case "mph": {
        const speed = this._raw("speed");
        return isNum(speed)
          ? String(Math.floor(Math.max(0, speed) * MI_PER_KM))
          : "--";
      } // mph whatever the units (Grand National), floored as above
      case "oil":
      case "coolant": {
        const temp = this._raw(tok);
        return fix(
          isNum(temp) ? (usTemp ? (temp * 9) / 5 + 32 : temp) : temp,
          0,
        );
      }
      case "boost": {
        const boost = this._raw("boost");
        return usPress
          ? fix(isNum(boost) ? boost * PSI_PER_BAR : boost, 1)
          : fix(boost, 2);
      }
      case "u:boost":
        return usPress ? "PSI" : "BAR";
      case "u:temp":
        return usTemp ? "°F" : "°C";
      // a plug-in hybrid (config.hybrid): its battery %, its electric range, the range as "fuel + electric", and the
      // oil gauge's labels as the battery's while the car sends a battery (Sport)
      case "hvSoc":
        return isNum(this.hvSoc) ? String(Math.round(this.hvSoc)) : "--";
      case "eRange": {
        const eKm = this._eRangeKm();
        return isNum(eKm) ? String(Math.round(usSpeed ? eKm * MI_PER_KM : eKm)) : "--";
      }
      // "fuel + electric": KombiIF's range is the combined one on a plug-in hybrid (a US car showed 330 mi, BMW's app
      // 309 combustion + 21 electric = 330 combined, Nov 18 2026), so the fuel part is it less the electric range
      case "rangeHybrid": {
        const eKm = this._eRangeKm();
        if (!isNum(eKm)) return "--";
        const total = this._raw("range");
        const fuel = isNum(total) ? Math.max(0, total - eKm) : null;
        const fuelText = isNum(fuel) ? String(Math.round(usSpeed ? fuel * MI_PER_KM : fuel)) : "--";
        return fuelText + " + " + this._token("eRange");
      }
      case "rangeFuelOnly":
        return isNum(this.eRangeRaw) ? "--" : "1";
      case "noHv":
        return isNum(this.hvSoc) ? "--" : "1";
      // not a "u:" token: those are painted once (text/index.js STATIC_TOKEN), and this one follows the car
      case "oilOrHvUnit":
        return isNum(this.hvSoc) ? "%" : usTemp ? "°F" : "°C";
      // the fuel gauge's marks: the tank (values.js _tankL: the Fuel tank setting, the car's model) full and half, in litres or US gallons, whole numbers
      case "fuelFull":
      case "fuelHalf": {
        const tank =
          this._tankL() *
          (usFuel ? 1 / L_PER_US_GAL : 1);
        return String(Math.round(tok === "fuelFull" ? tank : tank / 2));
      }
      case "u:fuel":
        return usFuel ? "gal" : "L";
      case "u:speedLc":
        return usSpeed ? "mph" : "km/h";
      case "u:distLc":
        return usSpeed ? "mi" : "km";
      case "range": {
        const range = this._raw("range");
        return fix(
          isNum(range) ? (usSpeed ? range * MI_PER_KM : range) : range,
          0,
        );
      }
      case "ambient": {
        const ambient = this._raw("ambient");
        if (!isNum(ambient)) return "--";
        const rounded = Math.round(usTemp ? (ambient * 9) / 5 + 32 : ambient);
        return (rounded > 0 ? "+" : "") + rounded;
      }
      case "u:torque":
        return usSpeed ? "lb-ft" : "Nm";
      case "torque": {
        const torque = this._raw("torque");
        return fix(
          isNum(torque) ? (usSpeed ? torque * LBFT_PER_NM : torque) : torque,
          0,
        );
      }
      case "torquePct":
      case "powerPct": {
        const pct = this._raw(tok);
        return isNum(pct) ? String(Math.min(100, Math.round(pct))) : "--";
      }
      case "boostHi":
        return usPress ? "20" : "1.4";
      case "boostMid":
        return usPress ? "10" : "0.7";
      case "ampmLc":
        return this._token("ampm").toLowerCase();
      case "gLat":
      case "gLong": {
        const accel = this._raw(tok);
        return isNum(accel) ? Math.abs(accel).toFixed(2) : "--";
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
        const last = this.score.last;
        return last && last.from !== "?" ? last.from + " > " + last.to : "";
      }
      case "verdict":
        return this.score.last ? this.score.last.verdict : "";
      case "shiftPrompt":
        return this._shift().now ? "SHIFT" : "";
      case "coldNote": {
        const shift = this._shift();
        if (!shift.oilCold) return "";
        return shift.cold ? "COLD · LIMIT " + shift.rpm : "OIL COLD · GO EASY";
      }
      case "gearnum": {
        const data = this.car.data();
        if (data.stage === "P" || data.stage === "R" || data.stage === "N")
          return data.stage;
        return isNum(data.gear) && data.gear > 0
          ? String(data.gear)
          : data.gear === 0
            ? "N"
            : "-";
      }
      case "stage": {
        // the selector letter alone: P R N, or D / S / M by the shifter programme
        const data = this.car.data();
        return data.stage === "D" ||
          (!data.stage && isNum(data.gear) && data.gear > 0)
          ? this._program(data)
          : data.stage || "-";
      }
      case "gearInD": {
        // the gear number while driving, else a dash (Grand National's GEAR readout)
        const data = this.car.data();
        return (data.stage === "D" || (!data.stage && isNum(data.gear))) &&
          isNum(data.gear) &&
          data.gear > 0
          ? String(data.gear)
          : "-";
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
        const data = this.car.data();
        if (data.stage === "P" || data.stage === "R" || data.stage === "N")
          return data.stage;
        const gear = isNum(data.gear) && data.gear > 0 ? String(data.gear) : "";
        return data.stage === "D" ? this._program(data) + gear : gear;
      }
      case "time":
      case "ampm": {
        const now = this._now();
        const hour = now.getHours(),
          minute = now.getMinutes();
        if (tok === "ampm")
          return this.setting("clock") === "12h"
            ? hour < 12
              ? "AM"
              : "PM"
            : "";
        if (this.setting("clock") === "24h")
          return pad2(hour) + ":" + pad2(minute);
        return (hour % 12 || 12) + ":" + pad2(minute);
      }
      default:
        if (tok.indexOf("spd:") === 0) {
          const label =
            SPEED_SCALE[usSpeed ? "us" : "metric"][Number(tok.slice(4))];
          return label === undefined ? "" : String(label);
        } // speed scale labels
        if (tok.indexOf("oilOrHv:") === 0) {
          // the oil gauge's labels (oilOrHv:150 / 110 / 50), or the battery's (100 / 50 / 0) while the car sends one
          const celsius = tok.slice(8);
          if (isNum(this.hvSoc)) return OIL_TO_HV[celsius] || "";
          return this._token("temp:" + celsius);
        }
        if (tok.indexOf("temp:") === 0) {
          const celsius = Number(tok.slice(5));
          return isNum(celsius)
            ? String(
                usTemp
                  ? Math.round(((celsius * 9) / 5 + 32) / GAUGE_F_STEP) * GAUGE_F_STEP
                  : Math.round(celsius),
              )
            : "--";
        } // gauge labels: °F to the 10
        if (tok.indexOf("boostTick:") === 0) {
          // Grand National's boost scale: 0 .. 1.5 bar in thirds, or 0 .. 20 psi in quarters; a slot of the other unit is empty
          const slot = tok.slice(10);
          if (slot === "0") return "0";
          if (slot === "end") return usPress ? "20" : "1.5";
          const k = Number(slot.slice(1));
          if (slot[0] === "m") return usPress ? "" : (k * BOOST_TICK_BAR).toFixed(1);
          if (slot[0] === "u") return usPress ? String(k * BOOST_TICK_PSI) : "";
          return "";
        }
        if (tok.indexOf("setup:") === 0) {
          const setup = this._setup();
          return setup ? setup[tok.slice(6)] || "" : "--";
        }
        if (tok.indexOf("signal:") === 0) {
          const value = this._raw(tok.slice(7));
          return isNum(value) ? (Math.round(value * 10) / 10).toString() : "--";
        }
        return "{{" + tok + "}}";
    }
  },
});
