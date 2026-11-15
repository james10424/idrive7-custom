"use strict";
/**
 * Tests pose.js: node shared/widgets/miku_live/pose_test.js [bake config.json [model defaults "Id=v ..." file]]
 * The synthetic rig checks the blends; with a config it also composes every drive corner from it and checks every
 * value is finite.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { rigOf, compose, changes, parseValues, expressionOf } = require("./pose");

const near = (/** @type {number} */ a, /** @type {number} */ b) => assert.ok(Math.abs(a - b) < 1e-6, a + " != " + b);
const D = { lean: 0, turn: 0, y: 0, idleT: 0, idleW: 0, closure: 0 };

const defaults = { ParamAngleX: 0, ParamAngleZ: 0, ParamEyeLOpen: 1, ParamEyeROpen: 1, Blush: 0, Hands: 0, Other: 5 };
const config = {
  params: { ParamEyeLOpen: 0.6, ParamEyeROpen: 0.6 },
  close: {
    expressions: ["Blush.exp3.json", "Hands.exp3.json"],
    // 2 steps each way: -1, -0.5 | 0.5, 1
    lean: { poses: [{ ParamAngleZ: -30 }, { ParamAngleZ: -10 }, { ParamAngleZ: 10 }, { ParamAngleZ: 30 }] },
    turnPoses: [{ ParamAngleX: -30, NotInModel: 4 }, { ParamAngleX: 30 }],
    idle: { period: 2, poses: [{ ParamAngleZ: 0 }, { ParamAngleZ: 4 }] },
  },
};
const exprs = {
  "Blush.exp3.json": { Parameters: [{ Id: "Blush", Value: 1 }] },
  "Hands.exp3.json": { Parameters: [{ Id: "Hands", Value: 1, Blend: "Overwrite" }, { Id: "ParamEyeLOpen", Value: 0.5, Blend: "Multiply" }] },
};
const rig = rigOf(config, exprs, defaults);
assert.deepStrictEqual(rig.keys.sort(), ["Blush", "Hands", "ParamAngleX", "ParamAngleZ", "ParamEyeLOpen", "ParamEyeROpen"]);
assert.strictEqual(rig.lean && rig.lean.steps, 2);
assert.strictEqual(rig.turn && rig.turn.steps, 1);

// rest: the config's params over the defaults; Other isn't driven
let v = compose(rig, D);
near(v.ParamEyeLOpen, 0.6);
near(v.ParamAngleZ, 0);
assert.ok(!("Other" in v) && !("NotInModel" in v));
// the lean between its steps: 0.75 is halfway from step 1 (10) to step 2 (30)
near(compose(rig, Object.assign({}, D, { lean: 0.75 })).ParamAngleZ, 20);
near(compose(rig, Object.assign({}, D, { lean: -0.25 })).ParamAngleZ, -5);
near(compose(rig, Object.assign({}, D, { lean: 1 })).ParamAngleZ, 30);
near(compose(rig, Object.assign({}, D, { lean: -3 })).ParamAngleZ, -30);
// the turn: halfway is halfway to its one step
near(compose(rig, Object.assign({}, D, { turn: 0.5 })).ParamAngleX, 15);
// the idle: a quarter of its 2 s period is halfway from pose 0 to pose 1; weighted by idleW, gone while turned
near(compose(rig, Object.assign({}, D, { idleT: 0.5, idleW: 1 })).ParamAngleZ, 2);
near(compose(rig, Object.assign({}, D, { idleT: 0.5, idleW: 0.5 })).ParamAngleZ, 1);
near(compose(rig, Object.assign({}, D, { idleT: 1.5, idleW: 1 })).ParamAngleZ, 2);   // pose 1 back to pose 0
near(compose(rig, Object.assign({}, D, { idleT: 0.5, idleW: 1, turn: 1 })).ParamAngleZ, 0);
// the expressions: Add, Overwrite, Multiply, by y
v = compose(rig, Object.assign({}, D, { y: 0.5 }));
near(v.Blush, 0.5);
near(v.Hands, 0.5);
near(v.ParamEyeLOpen, 0.6 * 0.75);
near(v.ParamEyeROpen, 0.6);
// the blink shuts both eyes on top
v = compose(rig, Object.assign({}, D, { closure: 1 }));
near(v.ParamEyeLOpen, 0);
near(compose(rig, Object.assign({}, D, { closure: 0.5 })).ParamEyeROpen, 0.3);

// the turn's hold loops: offsets on top of the turn, each way its own, scaled by how far she's turned
const held = rigOf(
  Object.assign({}, config, { close: Object.assign({}, config.close, { turnHold: {
    left: { period: 2, poses: [{ ParamAngleZ: 0 }, { ParamAngleZ: 4 }] },
    right: { period: 1, poses: [{ ParamAngleZ: 0 }, { ParamAngleZ: -2 }] },
  } }) }),
  exprs,
  defaults,
);
near(compose(held, Object.assign({}, D, { turn: -1, holdT: 0 })).ParamAngleZ, 0); // starts at the loop's start
near(compose(held, Object.assign({}, D, { turn: -1, holdT: 0.5 })).ParamAngleZ, 2); // a quarter in: halfway to 4
near(compose(held, Object.assign({}, D, { turn: -0.5, holdT: 0.5 })).ParamAngleZ, 1); // half turned: half of it
near(compose(held, Object.assign({}, D, { turn: 1, holdT: 0.5 })).ParamAngleZ, -2); // the right's own loop
near(compose(held, Object.assign({}, D, { turn: 0, holdT: 0.5 })).ParamAngleZ, 0); // not turned: none

// extra offsets on top, only for parameters the rig sets
v = compose(rig, Object.assign({}, D, { lean: 0.75, extra: { ParamAngleZ: 1.5, Other: 9 } }));
near(v.ParamAngleZ, 21.5);
assert.ok(!("Other" in v));

// changes: everything first, then only what moved
/** @type {Record<string, number>} */
const sent = {};
assert.strictEqual(changes({ A: 1, B: 2 }, sent, 0.01), "A=1 B=2");
assert.strictEqual(changes({ A: 1.005, B: 2.5 }, sent, 0.01), "B=2.5");
assert.strictEqual(changes({ A: 1.005, B: 2.5 }, sent, 0.01), "");
assert.deepStrictEqual(parseValues("A=1 B=-0.5,C=x D=2"), { A: 1, B: -0.5, D: 2 });
assert.deepStrictEqual(expressionOf({ Parameters: [{ Id: "X", Value: 2, Blend: "Bogus" }] }), [{ id: "X", value: 2, blend: "Add" }]);

// a real bake config (and the model's defaults, else 0 for every parameter it names)
const file = process.argv[2];
if (file) {
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  const dir = path.dirname(file);
  /** @type {Record<string, *>} */
  const files = {};
  ((cfg.close && cfg.close.expressions) || []).forEach((/** @type {string} */ f) => {
    const p = path.join(dir, f);
    // a bundled pose file has them written in (live_pose.js); a bake config, next to it
    files[f] = cfg.expressions && cfg.expressions[f] ? cfg.expressions[f] : fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  });
  /** @type {Record<string, number>} */
  let defs = {};
  if (process.argv[3]) defs = parseValues(fs.readFileSync(process.argv[3], "utf8"));
  else {
    const all = JSON.stringify(cfg).match(/"([A-Za-z_][\w]*)":\s*-?\d/g) || [];
    all.forEach((m) => {
      defs[m.slice(1, m.indexOf('"', 1))] = 0;
    });
  }
  const real = rigOf(cfg, files, defs);
  let n = 0;
  [-1, -0.37, 0, 0.6, 1].forEach((lean) =>
    [-1, -0.2, 0, 1].forEach((turn) =>
      [0, 0.5, 1].forEach((y) =>
        [0, 1.3, 4.4].forEach((idleT) => {
          const out = compose(real, { lean, turn, y, idleT, idleW: y, closure: y === 0.5 ? 0 : 0.4 });
          Object.keys(out).forEach((k) => assert.ok(isFinite(out[k]), k + " not finite"));
          n++;
        }),
      ),
    ),
  );
  console.log(
    "real config: " + real.keys.length + " parameters; lean " + (real.lean ? real.lean.steps : 0) + " steps each way, turn " +
      (real.turn ? real.turn.steps : 0) + ", idle " + (real.idle ? real.idle.poses.length + " poses over " + real.idle.period + " s" : "none") +
      ", " + real.expressions.length + " expressions; " + n + " drive corners finite",
  );
}
console.log("pose_test: ok");
