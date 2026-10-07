"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), os = require("os");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "aigora-core-test-"));
process.env.HOME = home; process.env.AIGORA_HOME = path.join(home, ".aigora");
delete process.env.SUDO_USER; delete process.env.SUDO_HOME;
process.on("exit", () => fs.rmSync(home, {recursive:true,force:true}));
const config = require("../lib/config");
let daemon = {};
config.loadConfig = () => daemon;
const credentials = require("../lib/credential-leases");
test("missing API credentials refuse all execution contexts before opening a broker", async () => {
  for (const vendor of ["claude", "codex"]) for (const context of ["room", "private", "host", "titles", "coaching", "scheduled", "loop", "verification", "discovery", "warmup", "worker"]) {
    let opens = 0;
    await assert.rejects(credentials.resolveCredential({context,env:{},credentialBroker:{open(){opens++;}}},vendor), /API key/);
    assert.equal(opens,0);
  }
});
test("explicit API keys keep lease and environment enforcement", async () => {
  daemon = {roomExecution:{apiKeys:{claude:"fixture-key",codex:"fixture-key"},broker:{enabled:false}}};
  for (const vendor of ["claude","codex"]) {
    const lease = await credentials.resolveCredential({env:{},log(){}},vendor);
    assert.equal(lease.source,"api_key");
    const env = credentials.executionEnv(lease,{HOME:"/old-home",AIGORA_CLEF_API_TOKEN:"secret",ANTHROPIC_AUTH_TOKEN:"competing"});
    assert.notEqual(env.HOME,"/old-home");
    assert.equal(env.AIGORA_CLEF_API_TOKEN,undefined);assert.equal(env.ANTHROPIC_AUTH_TOKEN,undefined);
    assert.equal(env[vendor==='claude'?'ANTHROPIC_API_KEY':'OPENAI_API_KEY'],"fixture-key");
    await lease.close();assert.throws(()=>credentials.assertCredentialLease(lease,vendor),/credential_unavailable/);
  }
});
test("default registry and picker offer the two API agents and local models", async () => {
  const registry=require("../lib/providers/registry");
  assert.deepEqual(registry.list().map(p=>p.id),["claude","codex","local"]);
  assert.equal(registry.get("claude").label,"Claude");
  assert.throws(()=>require("../lib/yoke").createAdapter({vendor:"unknown-provider"}),/Unknown/);
  const picker=await import("../lib/public/aigora/ai-picker-model.js");
  assert.deepEqual(picker.AGENTS.map(p=>p.id),["claude","codex","local"]);
});
test("API handles reject authentication slash commands before any provider input",async()=>{
 daemon={roomExecution:{apiKeys:{claude:"fixture-key"},broker:{enabled:false}}};
 const lease=await credentials.resolveCredential({env:{},log(){}},"claude");let pushed=0;
 const handle=credentials.guardHandle({pushMessage(){pushed++;},close(){}},lease,false);
 for(const command of ["/login","/logout","/auth device"])assert.throws(()=>handle.pushMessage(command),/API key/);
 assert.equal(pushed,0);handle.pushMessage("ordinary prompt");assert.equal(pushed,1);await lease.close();
});
