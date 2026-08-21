#!/usr/bin/env bash
#
# 给安装版 E-Pi 修复 macOS 通知权限。
#
# 背景: 打包时若未签名(或签名仍是 Electron 原厂身份), macOS 无法把
# 通知归属给 works.earendil.e-pi → 通知被静默拒绝(UNErrorDomain 1)。
# 同时 macOS 26 的通知权限存放在 usernoted 的 plist 中, 其中的 csreq
# 记录了主二进制的 CDHash —— 每次重新打包安装后 CDHash 都会变, 需要同步。
#
# macOS 26 System Policy 保护 group.com.apple.usernoted: 普通进程、Terminal、
# 甚至 root 都可能读不了这个 plist。读写被拒时不当失败——重签已经修好身份,
# 收尾改打开「系统设置 → 通知」让用户点允许。
#
# 用法: bash scripts/fix-notification-permission.sh
# 幂等: 签名正确且 CDHash 一致时不做任何修改。
set -euo pipefail

APP="/Applications/E-Pi.app"
BUNDLE_ID="works.earendil.e-pi"
PLIST="$HOME/Library/Group Containers/group.com.apple.usernoted/Library/Preferences/group.com.apple.usernoted.plist"
AUTH=7          # 7 = 允许(与 dev 构建条目一致)
FLAGS=310386702 # 横幅样式等, 取自 dev 构建条目
SETTINGS_URL="x-apple.systempreferences:com.apple.Notifications-Settings.extension"

if [ ! -d "$APP" ]; then
  echo "❌ $APP 不存在 — 请先安装 E-Pi" >&2
  exit 1
fi

# 1. 签名: 身份必须是 BUNDLE_ID, 否则 ad-hoc 重签
IDENT=$(codesign -dv --verbose=4 "$APP" 2>&1 | awk -F= '/^Identifier=/{print $2}' | tr -d ' ')
if [ "$IDENT" != "$BUNDLE_ID" ]; then
  echo "🔑 签名身份不正确 ($IDENT) → 重新 ad-hoc 签名"
  codesign --force --deep --sign - "$APP"
  codesign --verify --deep "$APP"
else
  echo "🔑 签名身份正确 ($IDENT)"
fi

CDHASH=$(codesign -dv --verbose=4 "$APP" 2>&1 | awk -F= '/^CDHash=/{print $2}' | tr -d ' ')
echo "📦 CDHash: $CDHASH"

open_settings_fallback() {
  echo "⚠️ 无法写入 usernoted 权限库 (系统保护 group.com.apple.usernoted)"
  echo "✅ 签名身份已是 $BUNDLE_ID — 这是通知能挂上 E-Pi 的前提"
  echo "接下来请:"
  echo "  1. 完全退出并重启 E-Pi (运行中的进程仍是启动时的旧签名)"
  echo "  2. 系统设置 → 通知 → E-Pi → 允许通知"
  echo "  3. 把 E-Pi 切到后台再等一个任务完成, 应出现横幅"
  open "$SETTINGS_URL" >/dev/null 2>&1 || true
}

# 2. 同步通知权限条目 (python3 用系统 plistlib, 保持二进制 plist 格式)
CHANGED=$(python3 - "$PLIST" "$BUNDLE_ID" "$APP" "$CDHASH" "$AUTH" "$FLAGS" <<'PYEOF'
import plistlib, sys, uuid

path, bundle_id, app_path, cdhash, auth, flags = sys.argv[1:7]
auth, flags = int(auth), int(flags)
cdhash = bytes.fromhex(cdhash)

def make_req():
    return (b"\xfa\xde\x0c\x00" + (40).to_bytes(4, "big")
            + (1).to_bytes(4, "big") + (8).to_bytes(4, "big")
            + (20).to_bytes(4, "big") + cdhash)

try:
    p = plistlib.load(open(path, "rb"))
except PermissionError:
    print("TCC", file=sys.stderr)
    print("TCC")
    sys.exit(0)

entry = next((a for a in p["apps"] if a.get("bundle-id") == bundle_id), None)
changed = False

if entry is None:
    entry = {"auth": auth, "bundle-id": bundle_id, "content_visibility": 0,
             "flags": flags, "grouping": 0, "path": app_path, "src": []}
    p["apps"].append(entry)
    print("📝 新建权限条目", file=sys.stderr)
    changed = True

if entry.get("auth") != auth or entry.get("flags") != flags or entry.get("path") != app_path:
    entry["auth"], entry["flags"], entry["path"] = auth, flags, app_path
    changed = True

src = entry.setdefault("src", [])
req = make_req()
if not src:
    src.append({"path": app_path, "flags": 0, "req": req, "uuid": str(uuid.uuid4()).upper()})
    changed = True
elif src[0].get("req") != req:
    src[0]["req"] = req
    src[0]["uuid"] = str(uuid.uuid4()).upper()  # 换新 uuid 强制 usernoted 重新识别
    print("🔄 CDHash 已同步", file=sys.stderr)
    changed = True

if changed:
    try:
        plistlib.dump(p, open(path, "wb"))
    except PermissionError:
        print("TCC", file=sys.stderr)
        print("TCC")
        sys.exit(0)
    print("1")
else:
    print("0")
PYEOF
)

if [ "$CHANGED" = "TCC" ]; then
  open_settings_fallback
  exit 0
fi

plutil -lint "$PLIST" >/dev/null || { echo "❌ plist 校验失败" >&2; exit 1; }

# 3. 有变更才重启 usernoted (SIGKILL 跳过退出写回, 避免覆盖; launchd 会自动拉起)
if [ "$CHANGED" = "1" ]; then
  echo "🔁 重启 usernoted 加载新条目..."
  killall -9 usernoted 2>/dev/null || true
  for _ in $(seq 1 10); do
    sleep 1
    pgrep -x usernoted >/dev/null && break
  done
  pgrep -x usernoted >/dev/null && echo "✅ usernoted 已重启 (pid $(pgrep -x usernoted))" || echo "⚠️ usernoted 未运行"
else
  echo "✅ 权限条目已是最新, 无需变更"
fi

echo "--- 当前条目 ---"
plutil -p "$PLIST" | grep -A 4 '"bundle-id" => "'"$BUNDLE_ID"'"' | head -6
echo "🎉 完成。若 E-Pi 正在运行, 重启后生效。"
