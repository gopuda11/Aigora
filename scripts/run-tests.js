#!/usr/bin/env node
"use strict";
// Source checkouts retain the full public regression suite; materialized
// exports run the portable core suite without internal review fixtures.
const fs = require("fs"), path = require("path"), cp = require("child_process");
const root = path.resolve(__dirname,"..");
const dir = fs.existsSync(path.join(root,"test")) ? "test" : "test-public";
const files=fs.readdirSync(path.join(root,dir)).filter(f=>f.endsWith(".test.js")).map(f=>path.join(dir,f));
const args = dir === "test" ? [path.join(__dirname,"check-test-count.js"),...files] : ["--test",...files];
const out=cp.spawnSync(process.execPath,args,{cwd:root,stdio:"inherit"});
if (out.error) { console.error(out.error.message); process.exit(1); }
process.exit(out.status===null?1:out.status);
