// The kit module as the built app sees it (kit/tools/build.py copies kit/runtime/ into the app as kit/): editor
// types only, so shared/ code that requires "../kit/diag" gets its types. Not shipped.
import m = require("../../kit/runtime/diag");
export = m;
