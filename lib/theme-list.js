// Theme listing for /api/themes. Bundled themes ship with the release and are
// immutable, so they are parsed once per directory; user themes are re-read on
// every call so edits show up immediately.
var fs = require("fs");
var path = require("path");

var bundledCache = new Map();

function readThemeDir(dir) {
  var out = {};
  try {
    var files = fs.readdirSync(dir);
    for (var i = 0; i < files.length; i++) {
      if (!files[i].endsWith(".json")) continue;
      try {
        out[files[i].replace(/\.json$/, "")] = JSON.parse(fs.readFileSync(path.join(dir, files[i]), "utf8"));
      } catch (e) {}
    }
  } catch (e) {}
  return out;
}

function listThemes(bundledDir, userDir) {
  var bundled = bundledCache.get(bundledDir);
  if (!bundled) {
    bundled = readThemeDir(bundledDir);
    bundledCache.set(bundledDir, bundled);
  }
  return { bundled: bundled, custom: readThemeDir(userDir) };
}

module.exports = { listThemes: listThemes, readThemeDir: readThemeDir };
