# Privacy for self-hosters

Aigora stores data on the server you operate. Default state home is `~/.aigora`, configurable with `AIGORA_HOME`; the main store is its `console/` directory. This is not an encrypted vault.

- `daemon.json` and admin overrides store server settings and possibly plaintext API credentials; `routing/clef.json` holds routing credentials/preferences, `transcription.json` speech settings, and local-provider overrides hold endpoint configuration.
- User/account records, PIN hashes, authentication sessions, room membership, invitations, private-channel registry, histories, shared posts/comments/reactions, direct-message JSONL, notes, coaching records and preferences persist in the server store.
- Upload blobs, attachment metadata, generated files, transcripts, video frames, orchestration artifacts, room/channel workspaces, agent transcripts/state and snapshots are stored in their feature-specific directories. Registered project files remain in the project directories you selected. API agent transcripts persist under `console/api-agent-state`.
- Daemon/audit/broker logs and budget counters retain operational metadata. Routing logs normally store length/hash rather than raw task text; `storeText` and `AIGORA_JEV_LOG_TEXT=1` opt into additional text logging.
- Browsers store preferences, cached views, drafts and pending queued messages in local storage/IndexedDB. Clear browser site data and server backups separately when retiring a deployment. Exporting source code does not export the running data store.

Prompts, selected file/context content and tool output go to the selected AI provider; speech endpoints receive audio, including audio extracted from video. Routing services can receive task/decision state, and optional JEV shadow calls add another recipient. A loopback endpoint keeps the initial request on the host, but the endpoint's own telemetry/forwarding policy is your responsibility. No end-to-end encryption prevents the server operator from reading conversations.

Browser CDN/font requests expose connection information to jsDelivr, esm.sh and Google Fonts. Optional web push uses the browser's push service; SMTP notifications use your mail provider. Disable optional integrations you do not intend to use.

Speech recognition, speaker attribution, summaries and video emphasis are fallible. Obtain consent and permission to process recordings, meetings and teaching materials. Do not treat generated transcripts as authoritative records. Choose API/local processing deliberately, apply your retention policy to blobs, frames, transcripts, snapshots and backups, and verify deletion of all copies. Aigora does not promise automatic legal compliance or universal secure erasure.
