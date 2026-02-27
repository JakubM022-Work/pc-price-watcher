const fs = require("fs");

function readState(statePath) {
  if (!fs.existsSync(statePath)) return {};
  const raw = fs.readFileSync(statePath, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function writeState(statePath, stateObj) {
  fs.writeFileSync(statePath, JSON.stringify(stateObj, null, 2), "utf8");
}

module.exports = { readState, writeState };