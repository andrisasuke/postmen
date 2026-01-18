#!/bin/bash
# Build and run PostMen with proper icon

set -e

APP_DIR="target/release/bundle/PostMen.app"
CONTENTS="$APP_DIR/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"

# Build release
echo "Building..."
cargo build --release

# Create app bundle structure
mkdir -p "$MACOS" "$RESOURCES"

# Copy binary
cp target/release/postmen "$MACOS/"

# Copy icon
cp assets/icons/AppIcon.icns "$RESOURCES/icon.icns"

# Create Info.plist
cat > "$CONTENTS/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDisplayName</key>
    <string>PostMen</string>
    <key>CFBundleExecutable</key>
    <string>postmen</string>
    <key>CFBundleIdentifier</key>
    <string>com.postmen.app</string>
    <key>CFBundleName</key>
    <string>PostMen</string>
    <key>CFBundleIconFile</key>
    <string>icon.icns</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>10.15</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
PLIST

# Touch to refresh icon cache
touch "$APP_DIR"

echo "Running PostMen..."
open "$APP_DIR"
