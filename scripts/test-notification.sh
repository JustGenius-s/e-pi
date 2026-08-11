#!/usr/bin/env bash
#
# 发送一条测试通知, 验证 E-Pi 的通知权限是否生效。
# 通知会以当前 App (E-Pi) 的身份发送; 能看到横幅/声音即说明权限正常。
#
# 用法: bash scripts/test-notification.sh [标题] [内容]
set -euo pipefail

TITLE="${1:-E-Pi 通知测试}"
MSG="${2:-通知权限已修复 ✅ 这是一条测试通知}"

osascript -e "display notification \"$MSG\" with title \"$TITLE\" subtitle \"$(date '+%H:%M:%S')\" sound name \"Glass\""

echo "✅ 测试通知已发送: $TITLE — $MSG"
echo "请查看屏幕右上角是否出现通知横幅 (或通知中心)。"
