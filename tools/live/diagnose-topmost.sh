#!/usr/bin/env bash
set -euo pipefail

step() {
  printf '\n%s\n' "$1"
  read -r -p '[完成后按 Enter] ' answer
}

capture() {
  local variable="$1" question="$2" answer
  printf '\n%s\n' "$question"
  read -r -p '> ' answer
  printf -v "$variable" '%s' "$answer"
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
binary="$repo_root/app/src-tauri/target/release/guit"
if [[ ! -x "$binary" ]]; then
  printf '未找到构建产物：%s\n' "$binary" >&2
  exit 1
fi
gtk_config="$(pkg-config --cflags --libs gtk+-3.0 x11)"
read -r -a gtk_flags <<< "$gtk_config"
probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/guit-topmost.XXXXXX")"
library="$probe_dir/probe.so"
trap 'rm -f -- "$library"' EXIT
cc -shared -fPIC -Wall -Wextra -Werror "$script_dir/topmost-probe.c" "${gtk_flags[@]}" -ldl -o "$library"
printf '本次程序：%s\n诊断日志：%s\n' "$binary" "$probe_dir/trace.log"
sha256sum "$binary" > "$probe_dir/binary.sha256"
step '请关闭此前打开的 guit。本次将启动上面这个构建产物。'
LD_PRELOAD="$library${LD_PRELOAD:+:$LD_PRELOAD}" "$binary" > "$probe_dir/trace.log" 2>&1 &
app_pid=$!
step '等待 guit 打开，开启置顶，再切换到一个普通窗口。'
capture covered '普通窗口是否盖住 guit？请输入 yes 或 no。若程序未打开，请输入未打开。'
capture error_message 'guit 显示了什么错误？没有错误请输入 none。'
step '请关闭本次打开的 guit，结束诊断。'
if wait "$app_pid"; then app_status=0; else app_status=$?; fi
{
  cat "$probe_dir/binary.sha256"
  sed -n '/^\[guit-topmost\]/p' "$probe_dir/trace.log"
  printf 'COVERED=%s\nERROR=%s\nEXIT=%s\n' "$covered" "$error_message" "$app_status"
} | tee "$probe_dir/report.txt"
printf '\n请将上述输出发回；报告保存在 %s\n' "$probe_dir/report.txt"
