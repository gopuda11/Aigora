#!/bin/bash
# Install Aigora MCP Bridge Native Messaging Host
# Usage: ./install.sh [extension-id]
#        ./install.sh --uninstall

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/aigora-mcp-host.js"
HOST_NAME="com.aigora.mcp_bridge"
MODE="install"
if [ "$1" = "--uninstall" ]; then
  MODE="uninstall"
  EXT_ID=""
else
  EXT_ID="${1:-}"
  # A Chrome extension ID is exactly 32 characters a-p. Anything else (including the old
  # __EXTENSION_ID__ placeholder) is rejected before any file is written.
  if ! printf '%s' "$EXT_ID" | grep -Eq '^[a-p]{32}$'; then
    echo "Error: invalid extension ID '$EXT_ID' (expected 32 characters a-p)" >&2
    echo "Usage: ./install.sh <extension-id> | --uninstall" >&2
    exit 2
  fi
fi

# Determine target directory
case "$(uname -s)" in
  Darwin)
    TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    ;;
  Linux)
    TARGET_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    ;;
  *)
    echo "Unsupported OS: $(uname -s)"
    echo "For Windows, manually add the registry key."
    exit 1
    ;;
esac

if [ "$MODE" = "uninstall" ]; then
  # Only the manifest file this script writes; nothing else is touched.
  rm -f "$TARGET_DIR/$HOST_NAME.json"
  echo "Removed $TARGET_DIR/$HOST_NAME.json"
  exit 0
fi

if [ ! -f "$HOST_SCRIPT" ]; then
  echo "Error: aigora-mcp-host.js not found in $SCRIPT_DIR"
  exit 1
fi

chmod +x "$HOST_SCRIPT"

mkdir -p "$TARGET_DIR"

# Write the manifest with resolved paths.
# Serialised with JSON.stringify (values passed via the environment, never spliced into code),
# so no path or ID can break the JSON.
for NAME in "$HOST_NAME"; do
  MANIFEST_NAME="$NAME" MANIFEST_PATH="$HOST_SCRIPT" MANIFEST_EXT="$EXT_ID" node -e '
    var e = process.env;
    process.stdout.write(JSON.stringify({
      name: e.MANIFEST_NAME,
      description: "Aigora MCP Bridge - Manages local MCP server processes",
      path: e.MANIFEST_PATH,
      type: "stdio",
      allowed_origins: ["chrome-extension://" + e.MANIFEST_EXT + "/"]
    }, null, 2) + "\n");
  ' > "$TARGET_DIR/$NAME.json.tmp.$$" \
    && mv "$TARGET_DIR/$NAME.json.tmp.$$" "$TARGET_DIR/$NAME.json" \
    || { rm -f "$TARGET_DIR/$NAME.json.tmp.$$"; echo "Error: could not write $TARGET_DIR/$NAME.json" >&2; exit 1; }
done

echo "Installed native messaging host manifest to:"
echo "  $TARGET_DIR/$HOST_NAME.json"
echo ""
echo "Host script: $HOST_SCRIPT"
echo "Extension ID: $EXT_ID"
echo ""
echo "Done."
