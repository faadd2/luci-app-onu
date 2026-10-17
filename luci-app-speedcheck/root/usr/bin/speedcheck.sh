#!/bin/sh
# speedcheck.sh —— 真实带宽测试（网卡计数器 + 多连接 CDN 下载）
#
# 原理: speedtest.net 国内节点普遍失真(实测 20Mbps vs 真实 590Mbps),
#       本脚本直接统计 WAN 口网卡在测试窗口内的真实收发字节数,
#       下载源为清华 TUNA 镜像(CDN), 上传为 Cloudflare 官方测速端点。
#
# 用法:
#   ./speedcheck.sh [DUR] [CONN] [URL]     前台 CLI 模式(终端直跑)
#   ./speedcheck.sh start <dur> <conn> [url]   后台模式: 结果写入 $LOG
#   ./speedcheck.sh upload-start <MB>          后台上传测试: 结果写入 $LOG
#
# 后台模式为 LuCI「真实带宽测试」页契约: 立即返回,
# LuCI 每 2 秒轮询 $LOG, 以 "平均下行/平均上行 : N Mbps" 判定完成,
# 以 "错误" 关键字判定失败。
#
# 兼容: OpenWrt / ImmortalWrt, busybox ash, 上传需 curl(包依赖已声明)

DUR=${1:-20}
CONN=${2:-4}
URL_DEFAULT="https://mirrors.tuna.tsinghua.edu.cn/ubuntu-releases/24.04/ubuntu-24.04.3-live-server-amd64.iso"
URL=$URL_DEFAULT
LOG=/tmp/speedcheck.log
LOCK=/tmp/speedcheck.lock
UP_URL="https://speed.cloudflare.com/__up"

# 探测 WAN 口(默认路由出口, 可被环境变量 IF 覆盖)
detect_wan() {
	if [ -z "$IF" ]; then
		IF=$(ip -4 route show default | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')
	fi
	if [ -z "$IF" ]; then
		echo "错误: 未找到默认路由, 请用 IF=<接口名> 手动指定, 可用接口:" >&2
		ip -br link >&2
		exit 1
	fi
	if [ ! -f "/sys/class/net/$IF/statistics/rx_bytes" ]; then
		echo "错误: 接口 $IF 不存在或无统计文件" >&2
		exit 1
	fi
}

# ---------- 下载测试主体(前台跑, 输出到 stdout) ----------
run_download() {
	local dur=$1 conn=$2 url=$3
	detect_wan
	echo "==============================================="
	echo " 真实带宽测试 (下载)"
	echo "==============================================="
	echo " WAN 接口 : $IF"
	echo " 窗口时长 : ${dur} 秒"
	echo " 连接数   : ${conn}"
	echo " 下载源   : TUNA 清华镜像 (CDN)"
	echo " 注意     : 测试期间请勿进行其他大流量操作"
	echo "-----------------------------------------------"

	local i=1
	while [ "$i" -le "$conn" ]; do
		wget -q -O /dev/null "$url" &
		i=$((i + 1))
	done

	local r1 r2
	r1=$(cat "/sys/class/net/$IF/statistics/rx_bytes")
	sleep "$dur"
	r2=$(cat "/sys/class/net/$IF/statistics/rx_bytes")

	killall wget 2>/dev/null
	wait 2>/dev/null

	local rx mbps mib
	rx=$((r2 - r1))
	if [ "$rx" -lt 0 ]; then
		echo "错误: 计数器异常(R2<R1), 接口选错了?"
		return 1
	fi
	mbps=$((rx * 8 / dur / 1000000))
	mib=$((rx / 1048576))

	echo "-----------------------------------------------"
	echo " 下载总量 : ${mib} MiB"
	echo " 平均下行 : ${mbps} Mbps"
	echo "==============================================="
}

# ---------- 上传测试主体(前台跑, 输出到 stdout; 需 curl) ----------
run_upload() {
	local size_mb=$1
	detect_wan
	if ! command -v curl >/dev/null 2>&1; then
		echo "错误: 未安装 curl, 无法测上传 (apk add curl)"
		return 1
	fi
	local f=/tmp/speedcheck-upload.bin
	echo "==============================================="
	echo " 真实带宽测试 (上传)"
	echo "==============================================="
	echo " WAN 接口 : $IF"
	echo " 数据量   : ${size_mb} MB"
	echo " 目标     : Cloudflare 官方测速端点"
	echo "-----------------------------------------------"
	echo " 正在生成测试数据文件..."
	dd if=/dev/urandom of="$f" bs=1M count="$size_mb" 2>/dev/null

	local s1 s2 secs tx mbps mib
	s1=$(date +%s)
	t1=$(cat "/sys/class/net/$IF/statistics/tx_bytes")
	curl -o /dev/null -s -X POST --data-binary @"$f" "$UP_URL"
	t2=$(cat "/sys/class/net/$IF/statistics/tx_bytes")
	s2=$(date +%s)
	rm -f "$f"

	tx=$((t2 - t1))
	secs=$((s2 - s1))
	[ "$secs" -le 0 ] && secs=1
	if [ "$tx" -le 0 ]; then
		echo "错误: 上传计数无增长, 检查网络或端点可达性"
		return 1
	fi
	mbps=$((tx * 8 / secs / 1000000))
	mib=$((tx / 1048576))

	echo "-----------------------------------------------"
	echo " 实际上传 : ${mib} MiB"
	echo " 平均上行 : ${mbps} Mbps"
	echo "==============================================="
}

# ---------- 后台模式封装: 立即返回, setsid 脱离会话防 SIGHUP, 子进程持锁写 $LOG ----------
# 注意: busybox ash 在脚本退出时会向未 setsid 的后台作业发 SIGHUP,
#       必须整体 setsid; 且函数不能跨进程, 后台体走 $0 自重启入口。
daemonize() {
	setsid /bin/sh "$0" "$@" </dev/null >/dev/null 2>&1 &
	exit 0
}

case "$1" in
	start)
		daemonize __download "${2:-20}" "${3:-4}" "${4:-$URL_DEFAULT}"
		;;
	upload-start)
		daemonize __upload "${2:-50}"
		;;
	__download)
		# busybox flock 只支持 FD 持有式: 9 号 fd 保持到进程退出
		exec 9>>"$LOCK"
		flock -n 9 2>/dev/null || exit 0
		: >"$LOG"
		run_download "$2" "$3" "$4" >>"$LOG" 2>&1
		;;
	__upload)
		exec 9>>"$LOCK"
		flock -n 9 2>/dev/null || exit 0
		: >"$LOG"
		run_upload "$2" >>"$LOG" 2>&1
		;;
	*)
		# CLI 前台模式: speedcheck.sh [dur] [conn] [url]
		case "$1" in
			*[!0-9]*|'') DUR=20 ;;
			*) DUR=$1 ;;
		esac
		[ -n "$2" ] && CONN=$2
		[ -n "$3" ] && URL=$3
		run_download "$DUR" "$CONN" "$URL"
		;;
esac
