# luci-app-onu — 超级 ONU 管理套件

基于 [pbs05/openwrt-pon-userspace](https://github.com/pbs05/openwrt-pon-userspace) 的
luci-app-pon（保留完整上游 git 历史）重构的模块化 ONU 管理界面，面向 Airoha AN7581
PON 设备（ZN504XG-D 等），适配北京联通 10G-EPON 业务。

参考设计：[naoki66/OpenWrt_ONU_CONFIG](https://github.com/naoki66/OpenWrt_ONU_CONFIG) 的
luci-app-onu（DESIGN.md 设计原则、Argon 主题适配、模块化信息架构、onu.css）。

## 模块组成

| 包 | 菜单（顶级 ONU） | 功能 |
|---|---|---|
| `luci-app-onu` | PON 状态 / 光链路 / 认证配置 / 硬件身份 / 事件日志 / 网络诊断 | 核心：线路状态、FEC 误码与光功率趋势、OAM/OMCI 配置、板级身份、pond 事件与内核日志、诊断包、补丁信息 |
| `luci-app-onu-internet` | 上网 | PPPoE/DHCP 拨号、VLAN、账号密码、重拨与状态 |
| `luci-app-onu-iptv` | IPTV | IPTV 链路（VLAN/DHCP）、组播 VLAN 状态 |
| `luci-app-onu-voice` | 语音 | 语音数据通路（静态 IP/路由）、IMS 可达性检测、IMS 账号参考（SIP 注册待语音驱动移植） |
| `luci-app-onu-mgmt` | ACS 管理 | TR-069 通道状态、ACS 参数存档、7547/9090 原始抓包（pcap/日志）；当前仅直装，无 Makefile |
| `luci-app-onu-migrate` | 配置迁移 | 向导页：上传原厂光猫备份（ctromfile 等）迁移上网/IPTV/语音配置 |

## 与上游/参考项目的关系

- 上游历史：`git log` 自上游 luci-app-pon 全部提交延续，其后为本仓库提交
- 增强：光链路页、事件日志页、补丁信息、简体中文翻译（核心包，290+ 条）
- 业务模块（internet/iptv/voice）为原创实现，数据源为 UCI network，无外部依赖脚本
- `luci-app-onu/htdocs/.../onu.css` 来自 naoki66/OpenWrt_ONU_CONFIG（Apache-2.0）

## 构建

将本仓库放入 OpenWrt/ImmortalWrt（PonWrt）源码树：

```sh
git clone <this-repo> package/onu-suite   # 或 cp -r 各包到 package/
# 本套件核心包名为 luci-app-onu，与上游 pbs05 feed 的 luci-app-pon 不冲突，可同时安装
./scripts/feeds install -a
make menuconfig  # LuCI → Applications → luci-app-onu 及业务模块
```

## 免编译直装（开发调试）

核心包视图提供 `_zh_inline/`（免 lmo 的中文内联构建）：

```sh
cd luci-app-onu/htdocs/luci-static/resources/view/onu
python _gen_po.py        # 修改翻译后重新生成 po + zh-inline
```

直装脚本：见 `deploy/`（上传视图/菜单/ACL 到设备，清理旧 luci-app-pon，重启 rpcd/uhttpd）。

## 许可

GPL-2.0（继承上游）；onu.css 为 Apache-2.0（naoki66）。
