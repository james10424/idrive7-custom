'use strict';
/**
 * Bench launcher: runs the BUILT app (dist/<id>, made by kit/tools/build.py, the
 * same build the Store runs on the car) inside the kit's stubbed head unit (kit/tools/hu-stub.js,
 * live mode). No BMW SDK, no SOME/IP:
 *
 *  - The center-screen page is hu-stub's fake RHMI. A setting from the bench panel is sent the way
 *    the car's HMI sends it: an 'action' on the SET_<KEY> component (the drop-down's row, or a
 *    checkbox press), so the kit's own wireSettings() handles it and saves bench/.data/<id>/settings.json.
 *  - The status row (ctx.ui.text('STATUS', ...)) is reported to the page.
 *  - Manual signals go in as RAW SOME/IP values through hu.feed, the scaling car.js undoes on the
 *    car; the FES boost field too. Demo mode is the kit's sim.js (the "demo" setting).
 *  - HUD_CLUSTER_SOCKET points hud.js at the bench's fake cluster-render socket.
 *
 * Run by bench/server.js as a forked child: node bench/run-app.js <stage dir> <data dir>
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const stage = process.argv[2], dataDir = process.argv[3];
if (!stage || !dataDir) { console.error('usage: run-app.js <dist/<id>> <data dir>'); process.exit(2); }

const send = (m) => { if (process.connected) process.send(m); };
const fmt = (a) => a.map((x) => (x && x.stack) ? x.stack : (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
const tag = '[' + path.basename(stage) + '] ';
const log = {
    info: (...a) => console.log(tag + fmt(a)),
    warn: (...a) => console.warn(tag + 'WARN ' + fmt(a)),
    error: (...a) => console.warn(tag + 'ERROR ' + fmt(a)),
    debug: () => {},
};
// As on the car, an uncaught exception ends the app (kit/mgu.js): the bench shows the exit.
process.on('uncaughtException', (e) => { log.error('uncaught (the car would exit the app here): ' + (e && e.stack || e)); process.exit(1); });

try { fs.mkdirSync(dataDir); } catch (e) { /* there */ }
const { headUnit } = require(path.join(__dirname, '..', 'kit', 'tools', 'hu-stub.js'));
const hu = headUnit(stage, { live: true, dataDir, log, image: () => Promise.resolve() });
const { spec, settings, ui } = hu;

// the app's HudApp instance, for the values the page shows (hud.js is loaded by the app's main.js)
let hud = null;
const realLoad = Module._load;
Module._load = function (req) {
    const m = realLoad.apply(this, arguments);
    if (req === './hud' && typeof m === 'function' && !m.__bench) {
        const Wrapped = class extends m { constructor(ctx) { super(ctx); hud = this; } };
        Wrapped.__bench = true;
        return Wrapped;
    }
    return m;
};

// the center screen's status row
let status = '';
const text = ui.text;
ui.text = (n, t, row, cell) => {
    if (n === 'STATUS' && !row) { status = String(t); send({ t: 'status', s: status }); }
    return text(n, t, row, cell);
};

const sendSettings = () => send({ t: 'settings', schema: spec.settings, values: Object.assign({}, settings.values) });
settings.onChange(sendSettings);

/** A setting from the panel, pressed on the fake HMI as the car's HMI would. */
function press(key, value) {
    const s = settings.item(key);
    if (!s) return log.warn('bench: no setting ' + key);
    const comp = ui.comp('SET_' + key.toUpperCase());
    if (s.type === 'bool') {
        if (!!settings.get(key) !== !!value) comp.emit('action', {});      // a checkbox press toggles
        return;
    }
    const rows = s.type === 'choice' ? s.options.map((o) => o[0]) : s.steps;
    const row = rows.indexOf(value);
    if (row < 0) return log.warn('bench: ' + key + ' has no value ' + JSON.stringify(value));
    comp.emit('action', { row });
}

// manual signals as raw SOME/IP values (a copy of kit/runtime/car.js SCALE; FES boost from hud.js)
const SCALE = { rpm: [0.25, 0], speed: [0.015625, 0], accel: [0.002, -65], temp: [1, -48], torque: [0.5, -1023.5], boost: [0.01, 0] };
const raw = (k, v) => Math.round((v - SCALE[k][1]) / SCALE[k][0]);
let mode = 'demo', manual = {}, drive = null, nav = null, assist = null;
// the drive mode buttons, sent once a second as the car does on change (wire numbers: 1 Sport, 4 Comfort, 7 Eco Pro)
setInterval(() => { if (drive !== null) hu.feed('de.bmw.infotainment.drivingexcitement.FES', 'statusFESVehicleDynamicSwitchHMI', { actualValueModeDrivingExperience: drive }); }, 1000);
// route guidance (Guidance guidanceState, the enum names oap-sdk reads), sent once a second
setInterval(() => { if (nav !== null) hu.feed('de.bmw.infotainment.navigation.guiding.Guidance', 'guidanceState', nav); }, 1000);
// while GUIDING: a made-up 24 km route, driven in 4 minutes and then again (finalDestinationInfo, travelledDistance)
let routeT0 = 0;
setInterval(() => {
    if (nav !== 'ACTIVE') { routeT0 = 0; return; }
    if (!routeT0) routeT0 = Date.now();
    const total = 24000, done = total * (((Date.now() - routeT0) / 240000) % 1), left = total - done;
    hu.feed('de.bmw.infotainment.navigation.guiding.Guidance', 'finalDestinationInfo', { travelTime: Math.round(left / 13.9 + 120),
        delayTime: 120, delayStatus: 'YELLOW', formattedDistance: { distance: (left / 1000).toFixed(1), unit: 'KM', rawDistance: left },
        distanceFromCurrentToFinalDestination: left, isCheckeredFlag: true });
    hu.feed('de.bmw.infotainment.navigation.guiding.Guidance', 'travelledDistance', { distance: (done / 1000).toFixed(1), unit: 'KM', rawDistance: done });
}, 1000);
// the trip computer (ResetLogic) as the car would send it: 9.8 l/100km since refuelling, scale / 10^digit
setInterval(() => {
    hu.feed('de.bmw.infotainment.resetlogic.ResetLogic', 'averageConsumption', { consumptionCombustionCurrentScale: 98, consumptionCombustionCurrentDigit: 1,
        consumptionElectricCurrentScale: 65535, consumptionElectricCurrentDigit: 0, combustionUnit: 'CONSUMPTION_KM', electricUnit: 'DEFAULT' });
}, 2000);
// now playing (HmiMediaState playerMetadata, as BMW's player fills it: artist then title): manual "music", else a few
// titles in different scripts, a new one every 8 s
const DEMO_SONGS = [['Queen', 'Bohemian Rhapsody'], ['YOASOBI', '夜に駆ける'], ['BTS', '봄날 Spring Day'], ['Кино', 'Группа крови'],
    ['Daft Punk', 'Harder, Better, Faster, Stronger (Alive 2007 version, extended)']];
setInterval(() => {
    const song = mode === 'manual' ? (typeof manual.music === 'string' ? ['', manual.music] : null) : DEMO_SONGS[Math.floor(Date.now() / 8000) % DEMO_SONGS.length];
    hu.feed('de.bmw.infotainment.hmi.hmimediastate.HmiMediaState', 'playerMetadata', song ? { uiType: 'TWO_LINES',
        firstLineText: song[0], firstLineType: 'ARTIST', secondLineText: song[1], secondLineType: 'TITLE', threeRowText: '' }
        : { uiType: 'UNDEFINED', firstLineText: '', firstLineType: 'UNDEFINED', secondLineText: '', secondLineType: 'UNDEFINED', threeRowText: '' });
}, 1000);
// BMW's HUD driver assistance block (DisplayDataServer functionalLibraryData, the catalog's enum names): ACC with a car ahead, or all off
setInterval(() => {
    if (assist === null) return;
    const on = assist === 'acc';
    hu.feed('de.bmw.infotainment.displaydataserver.DisplayDataServer', 'functionalLibraryData', {
        ldmSym: on ? 'LDM_SYM_ACC' : 'LDM_SYM_NONE', ldmSymColor: on ? 'LDM_ACTIVE' : 'LDM_OFF',
        activeCruiseControl: { symbolACC: on ? 'LDM_CAR_NORMAL' : 'LDM_CAR_OFF', barsColorACC: on ? 'LDM_ACTIVE' : 'LDM_OFF', accBarsHUD: on ? 3 : 0 },
        trafficJamAssist: { steeringWheel: on ? 'LDM_STW_GREEN' : 'LDM_STW_OFF' }, cruiseCtrlSpeedHUD: on ? 152 : 0,
    });
    // the car ahead (de.bmw.dass.GapVehicleAhead) as an X3 sends it: only GapVehicleDrivingAhead, once a second, 253 and
    // "nothing measured" without a car; with ACC on here a measured car whose gap swings 15..25 m over ~25 s (raw in 0.1 m
    // steps, as the car's reading was 10 times BMW's own at 1:1)
    const t = Date.now() / 4000, gap = on ? Math.round(200 + 50 * Math.sin(t)) : 253;
    hu.feed('de.bmw.dass.GapVehicleAhead', 'GapVehicleDrivingAhead', { qualifierFunctionVehicleDrivingAhead: 'FUNKTION_VERFUEGBAR',
        statusMeasurementVehicleDrivingAhead: on ? 'ELEMENT__GEMESSEN' : 'KEIN_ELEMENT_GEMESSEN', gapVehicleDrivingAhead: gap,
        vehicleTypeVehicleDrivingAhead: on ? 'ZWEISPURIGES_FAHRZEUG' : 'SIGNAL_UNGUELTIG', lampStatusVehicleDrivingAhead: on ? 'LICHT_AUS' : 'SIGNAL_UNGUELTIG' });
    // DataFrontVehicle as the car sends it with no object: 4093 in every field, object id 253 (its speed is not used)
    hu.feed('de.bmw.dass.GapVehicleAhead', 'DataFrontVehicle', { frontVehicleObjectID: 253, frontVehicleSpeedX: 4093, frontVehicleSpeedY: 4093,
        frontVehicleGapX: 4093, frontVehicleGapY: 4093, qualifierEventDataFunctionFrontVehicle: 'EVENT_DATA_AVAILABLE', qualifierExtendedFunctionFrontVehicle: 'NORMAL_OPERATION_MODE' });
}, 1000);
setInterval(() => {
    if (mode !== 'manual') return;
    const v = manual, num = (k, d) => (typeof v[k] === 'number' && isFinite(v[k]) ? v[k] : d);
    const g = Math.round(num('gear', 0));
    hu.feed('de.bmw.infotainment.vehicle.CDS', 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: raw('rpm', num('rpm', 0)) });
    hu.feed('de.bmw.infotainment.vehicle.Vehicle2', 'statusCarSpeed2', { speedVehicleCentreOfGravity: raw('speed', num('speed', 0)) });
    hu.feed('de.bmw.infotainment.vehicle.CDS2', 'statusLongitudinalAccelerationMassCenter', { longitudinalAccelerationCentreOfGravity: raw('accel', num('gLong', 0) * 9.80665) });
    hu.feed('de.bmw.infotainment.vehicle.CDS2', 'statusLateralAccelerationMassCenter', { lateralAccelerationCentreOfGravity: raw('accel', num('gLat', 0) * 9.80665) });
    hu.feed('de.bmw.infotainment.vehicle.CDS', 'statusEngineTemperature', { temperatureEngineDrive: raw('temp', num('coolant', 90)), temperatureEngineOilDrive: raw('temp', num('oil', 100)) });
    hu.feed('de.bmw.infrastructure.VehicleInformation', 'statusGearboxDrive', { statusActualGearDrive: g > 0 ? 'G' + g : 'N_OR_P', statusActualStageDrive: g > 0 ? 'D' : 'P' });
    hu.feed('de.bmw.infotainment.drivingexcitement.FES', 'statusActualValueTorque2', { actualValueTorqueCrankshaft: raw('torque', num('torque', 0)) });
    hu.feed('de.bmw.infotainment.drivingexcitement.FES', 'statusSwitchDriveDynamicSport2', { displayBoostPressure: raw('boost', Math.max(0, num('boost', 0))) });
    hu.feed('de.bmw.infotainment.KombiIF', 'statusRangeTankStatus', { fluidLevelFuelTank: Math.round(num('fuelL', 40)), range: Math.round(num('range', 450)) });
    hu.feed('de.bmw.infrastructure.EnvironmentalInformation', 'ExteriorTemperature', { temperatureExterior: Math.round((num('ambient', 22) + 40) / 0.5) });
    // the car's display units (bar, C), so the tyre values below read as 0.1 bar and C + 40; the shifter programme from `program` (S / M)
    hu.feed('de.bmw.infotainment.vehicle.Vehicle', 'statusNewCurrentUnitsStatusExt', { unitOfMeasurementAirPressure: 1, unitOfMeasurementTemperature: 1 });
    hu.feed('de.bmw.infotainment.misc.MDrive', 'dataDisplayGearbox', { displayProgramGearbox: manual.program === 'S' ? 'S_MINUS_PROGRAMM' : manual.program === 'M' ? 'M_MINUS_PROGRAMM' : 'D_PROGRAMM' });
    // tyres (TPMS, the fields the car answers a read with): pressure in 0.1 bar, temperature raw - 40 C; the rear pair a notch higher
    const tp = Math.round(num('tyreP', 2.3) * 10), tt = Math.round(num('tyreT', 24) + 40);
    hu.feed('de.bmw.infotainment.vehicle.TPMS', 'statusTyrePressure', { actualValuePressureTyreFLH: tp, actualValuePressureTyreFRH: tp, actualValuePressureTyreRLH: tp + 2, actualValuePressureTyreRRH: tp + 2 });
    hu.feed('de.bmw.infotainment.vehicle.TPMS', 'statusTyreTemperature', { actualValueTemperatureTyreFLH: tt, actualValueTemperatureTyreFRH: tt, actualValueTemperatureTyreRLH: tt + 3, actualValueTemperatureTyreRRH: tt + 3 });
}, 50);

// what the app actually sees, so the page shows demo values too
setInterval(() => {
    if (!hud) return;
    const d = hud.car.data(), out = {};
    ['rpm', 'speed', 'oil', 'coolant', 'gear', 'gLong', 'gLat', 'torque'].forEach((n) => { out[n] = d[n] === undefined ? null : d[n]; });
    out.boost = hud._boost();
    out.fuelL = hud.fuelL; out.range = hud.rangeKm; out.ambient = hud.ambient;
    send({ t: 'values', mode, values: out });
}, 250);

process.on('message', (m) => {
    if (!m) return;
    if (m.t === 'signals') {
        mode = m.mode === 'manual' ? 'manual' : 'demo';
        manual = m.values || {};
        // demo drive = the kit's sim; manual = live data (auto: the sim gives way once data arrives)
        const want = mode === 'manual' ? 'off' : 'on';
        if (settings.get('demo') !== want) press('demo', want);
    } else if (m.t === 'set') press(m.key, m.value);
    else if (m.t === 'drive') drive = m.value;
    else if (m.t === 'nav') nav = m.value;
    else if (m.t === 'assist') assist = m.value;
});
process.on('disconnect', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

hu.start();
sendSettings();
log.info('bench: app loaded from ' + path.relative(process.cwd(), stage) + ', data in ' + dataDir);
