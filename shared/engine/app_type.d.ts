// App: HudApp with the methods engine/app.js's mixin adds to its prototype from the engine and car files, and the
// state those files set on it (each file's *State typedef). An
// interface, not a JSDoc typedef: a typedef of HudApp & typeof import(...) circularly references itself (each file's
// methods are typed with `this` as App), and TypeScript then makes App, and `this` in every method, any.
import HudApp = require("./app");

type Plan = typeof import("./plan");
type Status = typeof import("./status");
type Modes = typeof import("./modes");
type Assets = typeof import("./assets");
type Signals = typeof import("../car/signals");
type Route = typeof import("../car/route");
type Assist = typeof import("../car/assist");
type Values = typeof import("../car/values");
type Lamps = typeof import("../car/lamps");
type Tokens = typeof import("../car/tokens");
type CarState = import("../car/signals").CarState;
type StatusState = import("./status").StatusState;
type AssetsState = import("./assets").AssetsState;
type RouteState = import("../car/route").RouteState;
type ValuesState = import("../car/values").ValuesState;

export interface App extends HudApp, Plan, Status, Modes, Assets, Signals, Route, Assist, Values, Lamps, Tokens,
  CarState, StatusState, AssetsState, RouteState, ValuesState {}
